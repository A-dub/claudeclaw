import { ensureProjectClaudeMd, runUserMessage } from "../runner";
import { getSettings, loadSettings, updateSettings } from "../config";
import { resetSession } from "../sessions";
import { transcribeAudioToText } from "../whisper";
import { mkdir } from "node:fs/promises";
import { extname, join, basename } from "node:path";

// --- Matrix API helpers ---

let matrixDebug = false;
let running = true;
let syncToken: string | null = null;
let botUserId: string | null = null;
let botDisplayName: string | null = null;

function debugLog(message: string): void {
  if (!matrixDebug) return;
  console.log(`[Matrix][debug] ${message}`);
}

async function matrixApi<T>(
  baseUrl: string,
  accessToken: string,
  method: string,
  endpoint: string,
  body?: unknown,
  timeout?: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = timeout ? setTimeout(() => controller.abort(), timeout) : null;

  try {
    const res = await fetch(`${baseUrl}/_matrix/client/v3${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (res.status === 429) {
      const data = (await res.json()) as { retry_after_ms?: number };
      const retryMs = data.retry_after_ms ?? 5000;
      debugLog(`Rate limited, retrying in ${retryMs}ms`);
      await Bun.sleep(retryMs);
      return matrixApi(baseUrl, accessToken, method, endpoint, body, timeout);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Matrix API ${method} ${endpoint}: ${res.status} ${text}`);
    }

    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- Message sending ---

async function sendMessage(
  baseUrl: string,
  accessToken: string,
  roomId: string,
  text: string,
): Promise<void> {
  const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

  // Matrix supports markdown-like formatting
  const htmlBody = markdownToMatrixHtml(text);

  await matrixApi(
    baseUrl,
    accessToken,
    "PUT",
    `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    {
      msgtype: "m.text",
      body: text,
      format: "org.matrix.custom.html",
      formatted_body: htmlBody,
    },
  );
}

/** Send a message with a file/image attachment. */
async function sendFileMessage(
  baseUrl: string,
  accessToken: string,
  roomId: string,
  filePath: string,
  description?: string,
): Promise<void> {
  // Upload file to Matrix content repository
  const file = Bun.file(filePath);
  const filename = basename(filePath);
  const mimeType = file.type || "application/octet-stream";

  const uploadRes = await fetch(
    `${baseUrl}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": mimeType,
      },
      body: file,
    },
  );

  if (!uploadRes.ok) {
    throw new Error(`Matrix upload failed: ${uploadRes.status}`);
  }

  const { content_uri } = (await uploadRes.json()) as { content_uri: string };
  const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const isImage = mimeType.startsWith("image/");

  await matrixApi(
    baseUrl,
    accessToken,
    "PUT",
    `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    {
      msgtype: isImage ? "m.image" : "m.file",
      body: description || filename,
      url: content_uri,
      info: {
        mimetype: mimeType,
        size: file.size,
      },
    },
  );
}

/** Send a reaction to a message. */
async function sendReaction(
  baseUrl: string,
  accessToken: string,
  roomId: string,
  eventId: string,
  emoji: string,
): Promise<void> {
  const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await matrixApi(
    baseUrl,
    accessToken,
    "PUT",
    `/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txnId}`,
    {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: eventId,
        key: emoji,
      },
    },
  ).catch((err) => debugLog(`Failed to send reaction: ${err}`));
}

/** Send typing indicator. */
async function sendTyping(
  baseUrl: string,
  accessToken: string,
  roomId: string,
  typing: boolean,
): Promise<void> {
  if (!botUserId) return;
  await matrixApi(
    baseUrl,
    accessToken,
    "PUT",
    `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(botUserId)}`,
    { typing, timeout: typing ? 15000 : undefined },
  ).catch(() => {});
}

/**
 * Convert markdown to Matrix-flavored HTML.
 * Matrix supports a rich subset of HTML: headers, blockquotes, tables,
 * lists, code blocks, bold, italic, strikethrough, links, and more.
 */
function markdownToMatrixHtml(text: string): string {
  if (!text) return "";

  // 1. Extract and protect code blocks (``` ... ```)
  const codeBlocks: { lang: string; code: string }[] = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    codeBlocks.push({ lang, code });
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract and protect inline code (` ... `)
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Escape HTML special characters
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 4. Headers → <h1>-<h6>
  text = text.replace(/^#{6}\s+(.+)$/gm, "<h6>$1</h6>");
  text = text.replace(/^#{5}\s+(.+)$/gm, "<h5>$1</h5>");
  text = text.replace(/^#{4}\s+(.+)$/gm, "<h4>$1</h4>");
  text = text.replace(/^#{3}\s+(.+)$/gm, "<h3>$1</h3>");
  text = text.replace(/^#{2}\s+(.+)$/gm, "<h2>$1</h2>");
  text = text.replace(/^#{1}\s+(.+)$/gm, "<h1>$1</h1>");

  // 5. Blockquotes (multi-line support)
  text = text.replace(/(?:^&gt;\s?(.*)$\n?)+/gm, (match) => {
    const inner = match.replace(/^&gt;\s?/gm, "").trim();
    return `<blockquote>${inner}</blockquote>`;
  });

  // 6. Tables (pipe-separated) → bulleted list (Element X doesn't support <table>, <pre>, or unicode box chars)
  text = text.replace(
    /(?:^\|.+\|[ \t]*$\n?){2,}/gm,
    (block) => {
      const rows = block.trim().split("\n").filter((r) => r.trim());
      if (rows.length < 2) return block;

      const isSeparator = /^\|[\s:|-]+\|$/.test(rows[1].trim());
      if (!isSeparator) return block;

      const parseRow = (row: string) =>
        row.split("|").slice(1, -1).map((cell) => cell.trim());

      const headerCells = parseRow(rows[0]);
      const dataRows = rows.slice(2).map(parseRow);

      // Format as list entries: "• **Header1:** val1 — **Header2:** val2"
      const lines = dataRows.map((row) => {
        const parts = headerCells.map((h, i) => `<strong>${h}:</strong> ${row[i] || ""}`);
        return `• ${parts.join(" — ")}`;
      });

      return lines.join("\n");
    },
  );

  // 7. Horizontal rules
  text = text.replace(/^[-*_]{3,}\s*$/gm, "<hr/>");

  // 8. Links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 9. Images ![alt](url) → link (Matrix HTML doesn't inline images from URLs)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2">$1 (image)</a>');

  // 10. Bold **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // 11. Italic *text* or _text_ (avoid matching inside words)
  text = text.replace(/(?<![a-zA-Z0-9*])\*([^*]+)\*(?![a-zA-Z0-9*])/g, "<em>$1</em>");
  text = text.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, "<em>$1</em>");

  // 12. Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // 13. Unordered lists (consecutive lines starting with - or *)
  text = text.replace(/(?:^[-*]\s+.+$\n?)+/gm, (block) => {
    const items = block.trim().split("\n").map((line) => {
      const content = line.replace(/^[-*]\s+/, "");
      return `<li>${content}</li>`;
    });
    return `<ul>${items.join("")}</ul>`;
  });

  // 14. Ordered lists (consecutive lines starting with N.)
  text = text.replace(/(?:^\d+\.\s+.+$\n?)+/gm, (block) => {
    const items = block.trim().split("\n").map((line) => {
      const content = line.replace(/^\d+\.\s+/, "");
      return `<li>${content}</li>`;
    });
    return `<ol>${items.join("")}</ol>`;
  });

  // 15. Restore inline code
  for (let i = 0; i < inlineCodes.length; i++) {
    const escaped = inlineCodes[i].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    text = text.replace(`\x00IC${i}\x00`, `<code>${escaped}</code>`);
  }

  // 16. Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    const { lang, code } = codeBlocks[i];
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const langAttr = lang ? ` class="language-${lang}"` : "";
    text = text.replace(`\x00CB${i}\x00`, `<pre><code${langAttr}>${escaped}</code></pre>`);
  }

  // 17. Convert remaining newlines to <br/>
  // But not after block elements (headers, lists, tables, blockquotes, hr, pre)
  text = text.replace(/(<\/(?:h[1-6]|table|ul|ol|blockquote|pre|hr\/)>)\n/g, "$1");
  text = text.replace(/\n/g, "<br/>");

  return text;
}

/** Send a read receipt for an event. */
async function sendReadReceipt(
  baseUrl: string,
  accessToken: string,
  roomId: string,
  eventId: string,
): Promise<void> {
  await matrixApi(
    baseUrl,
    accessToken,
    "POST",
    `/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
    {},
  ).catch((err) => debugLog(`Failed to send read receipt: ${err}`));
}

/** Send a message as a reply to a specific event. */
async function sendReplyMessage(
  baseUrl: string,
  accessToken: string,
  roomId: string,
  text: string,
  replyToEventId: string,
): Promise<void> {
  const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const htmlBody = markdownToMatrixHtml(text);

  debugLog(`sendReplyMessage formatted_body: ${htmlBody.slice(0, 500)}`);

  await matrixApi(
    baseUrl,
    accessToken,
    "PUT",
    `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    {
      msgtype: "m.text",
      body: text,
      format: "org.matrix.custom.html",
      formatted_body: htmlBody,
      "m.relates_to": {
        "m.in_reply_to": {
          event_id: replyToEventId,
        },
      },
    },
  );
}

/** Edit a previously sent message. */
async function sendEditMessage(
  baseUrl: string,
  accessToken: string,
  roomId: string,
  originalEventId: string,
  newText: string,
): Promise<void> {
  const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const htmlBody = markdownToMatrixHtml(newText);

  await matrixApi(
    baseUrl,
    accessToken,
    "PUT",
    `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    {
      msgtype: "m.text",
      body: `* ${newText}`,
      format: "org.matrix.custom.html",
      formatted_body: `* ${htmlBody}`,
      "m.new_content": {
        msgtype: "m.text",
        body: newText,
        format: "org.matrix.custom.html",
        formatted_body: htmlBody,
      },
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: originalEventId,
      },
    },
  );
}

// --- Reaction directive extraction ---

/** Strip a bracket-depth JSON directive like [tag:{...}] from text. */
function stripJsonDirective(text: string, tag: string): string {
  const prefix = `[${tag}:`;
  let result = "";
  let i = 0;

  while (i < text.length) {
    if (text.slice(i, i + prefix.length).toLowerCase() === prefix.toLowerCase()) {
      // Found directive — skip by counting bracket depth
      let j = i + prefix.length;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let found = false;

      while (j < text.length) {
        const ch = text[j];
        if (escaped) { escaped = false; j++; continue; }
        if (ch === "\\") { escaped = true; j++; continue; }
        if (ch === '"') { inString = !inString; j++; continue; }
        if (inString) { j++; continue; }
        if (ch === "{" || ch === "[") depth++;
        if (ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) {
            // Skip past closing ]
            let k = j + 1;
            while (k < text.length && text[k] === " ") k++;
            if (k < text.length && text[k] === "]") { i = k + 1; found = true; }
            else { i = j + 1; found = true; }
            break;
          }
        }
        j++;
      }
      if (!found) { result += text[i]; i++; }
    } else {
      result += text[i];
      i++;
    }
  }
  return result;
}

function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;

  // Strip Discord-specific JSON directives (handles nested brackets)
  text = stripJsonDirective(text, "embed");
  text = stripJsonDirective(text, "components");
  text = stripJsonDirective(text, "poll");

  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/\[flags:[^\]\r\n]+\]/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}

/** Extract [file:...] directives. */
function extractFileDirectives(text: string): { cleanedText: string; files: { path: string; description?: string }[] } {
  const files: { path: string; description?: string }[] = [];
  const cleanedText = text.replace(/\[file:([^\]\r\n]+)\]/gi, (_match, raw) => {
    const trimmed = String(raw).trim();
    const descMatch = trimmed.match(/^(.+?)\s+"([^"]+)"$/);
    const filePath = descMatch ? descMatch[1].trim() : trimmed;
    const description = descMatch ? descMatch[2] : undefined;
    files.push({ path: filePath, description });
    return "";
  });
  return { cleanedText, files };
}

// --- Attachment handling ---

async function downloadMatrixAttachment(
  baseUrl: string,
  accessToken: string,
  mxcUrl: string,
  filename: string,
  type: "image" | "voice",
): Promise<string | null> {
  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "matrix");
  await mkdir(dir, { recursive: true });

  // mxc://server/mediaId → /_matrix/media/v3/download/server/mediaId
  const mxcMatch = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!mxcMatch) return null;

  const downloadUrl = `${baseUrl}/_matrix/media/v3/download/${mxcMatch[1]}/${mxcMatch[2]}`;
  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Matrix attachment download failed: ${response.status}`);

  const ext = extname(filename) || (type === "voice" ? ".ogg" : ".jpg");
  const localFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
  const localPath = join(dir, localFilename);

  const bytes = new Uint8Array(await response.arrayBuffer());
  await Bun.write(localPath, bytes);
  debugLog(`Attachment downloaded: ${localPath} (${bytes.length} bytes)`);
  return localPath;
}

// --- Trigger logic ---

function shouldRespond(
  roomId: string,
  content: any,
  senderId: string,
): string | null {
  const config = getSettings().matrix;

  // Always respond in configured rooms
  if (config.alwaysRespondRoomIds.includes(roomId)) return "always_respond_room";

  // Check for mention in body
  if (botUserId && typeof content.body === "string") {
    const displayName = botDisplayName || "cal";
    if (
      content.body.toLowerCase().includes(displayName.toLowerCase()) ||
      content.body.includes(botUserId)
    ) {
      return "mention";
    }
  }

  // Check formatted body for mention pill
  if (botUserId && typeof content.formatted_body === "string") {
    if (content.formatted_body.includes(botUserId)) return "mention_pill";
  }

  return null;
}

// --- Bot commands ---

async function handleBotCommand(
  baseUrl: string,
  accessToken: string,
  roomId: string,
  eventId: string,
  body: string,
  senderId: string,
): Promise<boolean> {
  const config = getSettings().matrix;
  const cmd = body.trim().toLowerCase().split(/\s+/)[0];

  switch (cmd) {
    case "!reset": {
      await resetSession();
      await sendReaction(baseUrl, accessToken, roomId, eventId, "🔄");
      await sendReplyMessage(baseUrl, accessToken, roomId, "Session reset.", eventId);
      console.log(`[Matrix] Session reset by ${senderId}`);
      return true;
    }

    case "!listen": {
      if (!config.alwaysRespondRoomIds.includes(roomId)) {
        config.alwaysRespondRoomIds.push(roomId);
        await updateSettings((raw) => { raw.matrix = { ...config }; });
        await sendReaction(baseUrl, accessToken, roomId, eventId, "👂");
        await sendReplyMessage(baseUrl, accessToken, roomId, "Now listening in this room — no @mention needed.", eventId);
        console.log(`[Matrix] Now always-responding in room ${roomId}`);
      } else {
        await sendReplyMessage(baseUrl, accessToken, roomId, "Already listening in this room.", eventId);
      }
      return true;
    }

    case "!unlisten": {
      const idx = config.alwaysRespondRoomIds.indexOf(roomId);
      if (idx !== -1) {
        config.alwaysRespondRoomIds.splice(idx, 1);
        await updateSettings((raw) => { raw.matrix = { ...config }; });
        await sendReaction(baseUrl, accessToken, roomId, eventId, "🔇");
        await sendReplyMessage(baseUrl, accessToken, roomId, "Stopped listening — @mention me to talk.", eventId);
        console.log(`[Matrix] Stopped always-responding in room ${roomId}`);
      } else {
        await sendReplyMessage(baseUrl, accessToken, roomId, "Not listening in this room anyway.", eventId);
      }
      return true;
    }

    case "!help": {
      const helpText = [
        "**Commands:**",
        "• `!reset` — Reset the conversation session",
        "• `!listen` — Respond to all messages in this room (no @mention needed)",
        "• `!unlisten` — Only respond when @mentioned",
        "• `!help` — Show this help message",
      ].join("\n");
      await sendReplyMessage(baseUrl, accessToken, roomId, helpText, eventId);
      return true;
    }

    default:
      return false;
  }
}

/** Send a welcome message when joining a room. */
async function sendWelcomeMessage(
  baseUrl: string,
  accessToken: string,
  roomId: string,
): Promise<void> {
  const welcomeText = [
    "Hey — I'm Cal. 🪶",
    "",
    "Mention me to chat, or use `!listen` so I respond to everything in this room.",
    "Type `!help` for all commands.",
  ].join("\n");

  await sendMessage(baseUrl, accessToken, roomId, welcomeText);
}

// --- Message handler ---

async function handleRoomMessage(
  baseUrl: string,
  accessToken: string,
  roomId: string,
  event: any,
): Promise<void> {
  const config = getSettings().matrix;
  const senderId = event.sender;
  const content = event.content || {};
  const eventId = event.event_id;

  // Ignore own messages
  if (senderId === botUserId) return;

  // Authorization check
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(senderId)) {
    debugLog(`Skip message from unauthorized user: ${senderId}`);
    return;
  }

  // Send read receipt immediately
  sendReadReceipt(baseUrl, accessToken, roomId, eventId);

  const msgtype = content.msgtype;
  const body = content.body || "";
  const isImage = msgtype === "m.image";
  const isAudio = msgtype === "m.audio" || msgtype === "m.voice";
  const isText = msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote";

  // Handle bot commands before trigger check (commands always work from authorized users)
  if (isText && body.startsWith("!")) {
    const handled = await handleBotCommand(baseUrl, accessToken, roomId, eventId, body, senderId);
    if (handled) return;
  }

  // Check trigger
  const triggerReason = shouldRespond(roomId, content, senderId);
  if (!triggerReason) {
    debugLog(`Skip message in room=${roomId} from=${senderId} reason=no_trigger`);
    return;
  }

  if (!body.trim() && !isImage && !isAudio) return;

  // Extract display name from sender
  const label = senderId.replace(/^@/, "").replace(/:.*$/, "");
  const mediaParts = [isImage ? "image" : "", isAudio ? "voice" : ""].filter(Boolean);
  const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join("+")}]` : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Matrix ${label}${mediaSuffix}: "${body.slice(0, 60)}${body.length > 60 ? "..." : ""}"`,
  );

  // Typing indicator
  const typingInterval = setInterval(
    () => sendTyping(baseUrl, accessToken, roomId, true),
    10000,
  );

  try {
    await sendTyping(baseUrl, accessToken, roomId, true);

    let imagePath: string | null = null;
    let voicePath: string | null = null;
    let voiceTranscript: string | null = null;

    // Handle image attachment
    if (isImage && content.url) {
      try {
        imagePath = await downloadMatrixAttachment(
          baseUrl, accessToken, content.url, content.body || "image.jpg", "image",
        );
      } catch (err) {
        console.error(`[Matrix] Failed to download image: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Handle audio/voice attachment
    if (isAudio && content.url) {
      try {
        voicePath = await downloadMatrixAttachment(
          baseUrl, accessToken, content.url, content.body || "audio.ogg", "voice",
        );
      } catch (err) {
        console.error(`[Matrix] Failed to download voice: ${err instanceof Error ? err.message : err}`);
      }

      if (voicePath) {
        try {
          voiceTranscript = await transcribeAudioToText(voicePath, {
            debug: matrixDebug,
            log: (msg) => debugLog(msg),
          });
        } catch (err) {
          console.error(`[Matrix] Failed to transcribe voice: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Clean content — strip mention pills
    let cleanContent = body;
    if (botUserId) {
      cleanContent = cleanContent.replace(new RegExp(botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "").trim();
    }
    if (botDisplayName) {
      cleanContent = cleanContent.replace(new RegExp(`@?${botDisplayName}\\b`, "gi"), "").trim();
    }

    // Build prompt
    const promptParts = [`[Matrix from ${label}]`];
    if (cleanContent.trim() && isText) promptParts.push(`Message: ${cleanContent}`);
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    } else if (isImage) {
      promptParts.push("The user attached an image, but downloading it failed. Respond and ask them to resend.");
    }
    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
      promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
    } else if (isAudio) {
      promptParts.push(
        "The user attached voice audio, but it could not be transcribed. Respond and ask them to resend a clearer clip.",
      );
    }

    const prefixedPrompt = promptParts.join("\n");
    const result = await runUserMessage("matrix", prefixedPrompt);

    if (result.exitCode !== 0) {
      await sendReplyMessage(baseUrl, accessToken, roomId,
        `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`, eventId);
    } else {
      let responseText = result.stdout || "";

      // Extract reaction directives
      const { cleanedText, reactionEmoji } = extractReactionDirective(responseText);
      responseText = cleanedText;

      // Extract file directives
      const { cleanedText: finalText, files } = extractFileDirectives(responseText);
      responseText = finalText;

      // Send reaction
      if (reactionEmoji) {
        await sendReaction(baseUrl, accessToken, roomId, eventId, reactionEmoji);
      }

      // Send text response as a reply to the original message
      if (responseText.trim()) {
        await sendReplyMessage(baseUrl, accessToken, roomId, responseText, eventId);
      } else if (!files.length && !reactionEmoji) {
        await sendReplyMessage(baseUrl, accessToken, roomId, "(empty response)", eventId);
      }

      // Send file attachments
      for (const file of files) {
        try {
          await sendFileMessage(baseUrl, accessToken, roomId, file.path, file.description);
        } catch (err) {
          console.error(`[Matrix] Failed to send file ${file.path}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Matrix] Error for ${label}: ${errMsg}`);
    await sendMessage(baseUrl, accessToken, roomId, `Error: ${errMsg}`);
  } finally {
    clearInterval(typingInterval);
    await sendTyping(baseUrl, accessToken, roomId, false).catch(() => {});
  }
}

// --- Sync loop ---

async function syncLoop(baseUrl: string, accessToken: string): Promise<void> {
  // Initial sync to get current state (don't process old messages)
  debugLog("Starting initial sync...");
  const initialSync = await matrixApi<any>(
    baseUrl, accessToken, "GET",
    `/sync?timeout=0&filter={"room":{"timeline":{"limit":0}}}`,
    undefined,
    30000,
  );
  syncToken = initialSync.next_batch;
  debugLog(`Initial sync complete, token: ${syncToken}`);

  // Main sync loop
  while (running) {
    try {
      const filter = encodeURIComponent(JSON.stringify({
        room: {
          timeline: { limit: 20 },
          state: { lazy_load_members: true },
        },
      }));

      const syncUrl = `/sync?timeout=30000&since=${syncToken}&filter=${filter}`;
      const syncResponse = await matrixApi<any>(
        baseUrl, accessToken, "GET", syncUrl, undefined, 60000,
      );

      syncToken = syncResponse.next_batch;

      // Process room events
      const joinedRooms = syncResponse.rooms?.join;
      if (joinedRooms) {
        for (const [roomId, roomData] of Object.entries<any>(joinedRooms)) {
          const events = roomData.timeline?.events || [];
          for (const event of events) {
            if (event.type === "m.room.message") {
              // Skip events older than 60s (safety net for initial sync edge cases)
              const age = event.unsigned?.age;
              if (age && age > 60000) continue;

              handleRoomMessage(baseUrl, accessToken, roomId, event).catch((err) =>
                console.error(`[Matrix] MESSAGE unhandled: ${err}`),
              );
            }
          }
        }
      }

      // Handle invites — auto-join rooms from allowed users
      const invitedRooms = syncResponse.rooms?.invite;
      if (invitedRooms) {
        for (const [roomId, roomData] of Object.entries<any>(invitedRooms)) {
          const inviteEvents = roomData.invite_state?.events || [];
          const inviter = inviteEvents.find(
            (e: any) => e.type === "m.room.member" && e.content?.membership === "invite",
          );
          const inviterUserId = inviter?.sender;
          const config = getSettings().matrix;

          if (!config.allowedUserIds.length || (inviterUserId && config.allowedUserIds.includes(inviterUserId))) {
            debugLog(`Auto-joining room ${roomId} (invited by ${inviterUserId})`);
            try {
              await matrixApi(baseUrl, accessToken, "POST", `/rooms/${encodeURIComponent(roomId)}/join`, {});
              console.log(`[Matrix] Joined room ${roomId} (invited by ${inviterUserId})`);
              // Send welcome message after joining
              await sendWelcomeMessage(baseUrl, accessToken, roomId);
            } catch (err) {
              console.error(`[Matrix] Failed to auto-join ${roomId}: ${err}`);
            }
          }
        }
      }
    } catch (err) {
      if (!running) break;
      const errMsg = err instanceof Error ? err.message : String(err);

      // Abort errors are expected during shutdown or long-poll timeout
      if (errMsg.includes("abort") || errMsg.includes("AbortError")) {
        debugLog("Sync aborted, retrying...");
        await Bun.sleep(1000);
        continue;
      }

      console.error(`[Matrix] Sync error: ${errMsg}`);
      await Bun.sleep(5000); // Back off on error
    }
  }
}

// --- Exports ---

export { sendMessage as matrixSendMessage, sendReplyMessage as matrixSendReply, sendEditMessage as matrixEditMessage };

export function stopMatrix(): void {
  running = false;
}

export function startMatrix(debug = false): void {
  matrixDebug = debug;
  const config = getSettings().matrix;
  running = true;

  console.log("Matrix bot started (sync polling)");
  console.log(`  Homeserver: ${config.homeserverUrl}`);
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
  console.log(`  Always-respond rooms: ${config.alwaysRespondRoomIds.length}`);
  if (matrixDebug) console.log("  Debug: enabled");

  (async () => {
    await ensureProjectClaudeMd();

    // Get bot's own user ID
    const whoami = await matrixApi<{ user_id: string }>(
      config.homeserverUrl, config.accessToken, "GET", "/account/whoami",
    );
    botUserId = whoami.user_id;
    console.log(`[Matrix] Logged in as ${botUserId}`);

    // Get display name
    try {
      const profile = await matrixApi<{ displayname?: string }>(
        config.homeserverUrl, config.accessToken, "GET",
        `/profile/${encodeURIComponent(botUserId)}/displayname`,
      );
      botDisplayName = profile.displayname || null;
    } catch {
      botDisplayName = null;
    }

    // Set display name if not set
    if (!botDisplayName) {
      await matrixApi(
        config.homeserverUrl, config.accessToken, "PUT",
        `/profile/${encodeURIComponent(botUserId)}/displayname`,
        { displayname: "Cal" },
      ).catch(() => {});
      botDisplayName = "Cal";
    }

    syncLoop(config.homeserverUrl, config.accessToken);
  })().catch((err) => {
    console.error(`[Matrix] Fatal: ${err}`);
  });
}

/** Standalone entry point */
export async function matrix() {
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().matrix;

  if (!config.accessToken) {
    console.error("Matrix accessToken not configured. Set matrix.accessToken in .claude/claudeclaw/settings.json");
    process.exit(1);
  }
  if (!config.homeserverUrl) {
    console.error("Matrix homeserverUrl not configured.");
    process.exit(1);
  }

  console.log("Matrix bot started (sync polling, standalone)");
  startMatrix();
  await new Promise(() => {});
}
