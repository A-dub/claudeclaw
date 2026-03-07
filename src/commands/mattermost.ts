import { ensureProjectClaudeMd, runUserMessage } from "../runner";
import { getSettings, loadSettings, updateSettings } from "../config";
import { resetSession } from "../sessions";
import { transcribeAudioToText } from "../whisper";
import { mkdir } from "node:fs/promises";
import { extname, join, basename } from "node:path";

// --- Mattermost API helpers ---

let mmDebug = false;
let running = true;
let ws: WebSocket | null = null;
let botUserId: string | null = null;
let botUsername: string | null = null;
let seqNum = 1;

function debugLog(message: string): void {
  if (!mmDebug) return;
  console.log(`[Mattermost][debug] ${message}`);
}

async function mmApi<T>(
  serverUrl: string,
  token: string,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${serverUrl}/api/v4${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const retryMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
    debugLog(`Rate limited, retrying in ${retryMs}ms`);
    await Bun.sleep(retryMs);
    return mmApi(serverUrl, token, method, endpoint, body);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mattermost API ${method} ${endpoint}: ${res.status} ${text}`);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// --- Message sending ---

async function sendMessage(
  serverUrl: string,
  token: string,
  channelId: string,
  text: string,
  rootId?: string,
): Promise<{ id: string }> {
  // Mattermost renders markdown natively — tables, code blocks, bold, italic, etc.
  // Just send raw markdown and it works perfectly.
  const MAX_LEN = 16383; // Mattermost max post size

  if (text.length <= MAX_LEN) {
    return mmApi<{ id: string }>(serverUrl, token, "POST", "/posts", {
      channel_id: channelId,
      message: text,
      root_id: rootId || "",
    });
  }

  // Split long messages
  let lastPost: { id: string } | null = null;
  for (let i = 0; i < text.length; i += MAX_LEN) {
    const chunk = text.slice(i, i + MAX_LEN);
    lastPost = await mmApi<{ id: string }>(serverUrl, token, "POST", "/posts", {
      channel_id: channelId,
      message: chunk,
      root_id: rootId || "",
    });
  }
  return lastPost!;
}

/** Upload a file and send it as a post. */
async function sendFileMessage(
  serverUrl: string,
  token: string,
  channelId: string,
  filePath: string,
  description?: string,
  rootId?: string,
): Promise<void> {
  const file = Bun.file(filePath);
  const filename = basename(filePath);

  // Step 1: Upload file
  const formData = new FormData();
  formData.append("files", file, filename);
  formData.append("channel_id", channelId);

  const uploadRes = await fetch(`${serverUrl}/api/v4/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!uploadRes.ok) {
    throw new Error(`Mattermost file upload failed: ${uploadRes.status}`);
  }

  const { file_infos } = (await uploadRes.json()) as {
    file_infos: { id: string }[];
  };

  if (!file_infos?.length) throw new Error("No file info returned from upload");

  // Step 2: Create post with file
  await mmApi(serverUrl, token, "POST", "/posts", {
    channel_id: channelId,
    message: description || "",
    file_ids: file_infos.map((f) => f.id),
    root_id: rootId || "",
  });
}

/** Send a reaction to a post. */
async function sendReaction(
  serverUrl: string,
  token: string,
  postId: string,
  emojiName: string,
): Promise<void> {
  if (!botUserId) return;
  await mmApi(serverUrl, token, "POST", "/reactions", {
    user_id: botUserId,
    post_id: postId,
    emoji_name: emojiName,
  }).catch((err) => debugLog(`Failed to send reaction: ${err}`));
}

/** Edit an existing post. */
async function editMessage(
  serverUrl: string,
  token: string,
  postId: string,
  newText: string,
): Promise<void> {
  await mmApi(serverUrl, token, "PUT", `/posts/${postId}`, {
    id: postId,
    message: newText,
  });
}

/** Delete a post. */
async function deleteMessage(
  serverUrl: string,
  token: string,
  postId: string,
): Promise<void> {
  await mmApi(serverUrl, token, "DELETE", `/posts/${postId}`);
}

/** Pin a post. */
async function pinMessage(
  serverUrl: string,
  token: string,
  postId: string,
): Promise<void> {
  await mmApi(serverUrl, token, "POST", `/posts/${postId}/pin`);
}

/** Unpin a post. */
async function unpinMessage(
  serverUrl: string,
  token: string,
  postId: string,
): Promise<void> {
  await mmApi(serverUrl, token, "POST", `/posts/${postId}/unpin`);
}

/** Send a message with rich attachments (Mattermost's embed-like feature). */
async function sendAttachmentMessage(
  serverUrl: string,
  token: string,
  channelId: string,
  text: string,
  attachments: any[],
  rootId?: string,
): Promise<{ id: string }> {
  return mmApi<{ id: string }>(serverUrl, token, "POST", "/posts", {
    channel_id: channelId,
    message: text,
    root_id: rootId || "",
    props: { attachments },
  });
}

/** Set the bot's custom status. */
async function setBotStatus(
  serverUrl: string,
  token: string,
  emoji: string,
  text: string,
): Promise<void> {
  await mmApi(serverUrl, token, "PUT", "/users/me/status/custom", {
    emoji,
    text,
  });
}

/** Send typing indicator. */
async function sendTyping(
  serverUrl: string,
  token: string,
  channelId: string,
): Promise<void> {
  // Use WebSocket for typing (more efficient)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      action: "user_typing",
      seq: seqNum++,
      data: { channel_id: channelId },
    }));
  } else {
    // Fallback to REST
    await mmApi(serverUrl, token, "POST", `/users/me/typing`, {
      channel_id: channelId,
    }).catch(() => {});
  }
}

// --- Emoji conversion ---

/** Convert unicode emoji to Mattermost emoji name. Common mappings. */
function emojiToName(emoji: string): string {
  const map: Record<string, string> = {
    "👍": "thumbsup", "👎": "thumbsdown", "❤️": "heart", "😂": "joy",
    "😊": "blush", "🎉": "tada", "🔥": "fire", "✅": "white_check_mark",
    "❌": "x", "👀": "eyes", "🤔": "thinking", "💯": "100",
    "🙏": "pray", "😍": "heart_eyes", "🚀": "rocket", "⭐": "star",
    "📝": "memo", "🔄": "arrows_counterclockwise", "🪶": "feather",
    "👂": "ear", "🔇": "mute", "⚡": "zap", "💡": "bulb",
  };
  return map[emoji] || emoji.replace(/:/g, "");
}

// --- Directive extraction ---

/** Strip Discord-specific JSON directives. */
function stripJsonDirective(text: string, tag: string): string {
  const prefix = `[${tag}:`;
  let result = "";
  let i = 0;

  while (i < text.length) {
    if (text.slice(i, i + prefix.length).toLowerCase() === prefix.toLowerCase()) {
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

interface MattermostDirectives {
  content: string;
  reactionEmoji: string | null;
  files: { path: string; description?: string }[];
  attachments: any[];
  pin: boolean;
  editPostId: string | null;
}

/** Extract JSON value from a bracket-depth directive like [attach:{...}] */
function extractJsonDirective(text: string, tag: string): { value: any; rest: string } | null {
  const prefix = `[${tag}:`;
  const idx = text.toLowerCase().indexOf(prefix.toLowerCase());
  if (idx === -1) return null;

  let j = idx + prefix.length;
  // Find the start of JSON
  while (j < text.length && text[j] === " ") j++;
  const jsonStart = j;

  let depth = 0;
  let inString = false;
  let escaped = false;

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
        const jsonStr = text.slice(jsonStart, j + 1);
        // Check if next non-space char is ']'
        let k = j + 1;
        while (k < text.length && text[k] === " ") k++;
        const end = (k < text.length && text[k] === "]") ? k + 1 : j + 1;
        try {
          const value = JSON.parse(jsonStr);
          const rest = text.slice(0, idx) + text.slice(end);
          return { value, rest };
        } catch {
          return null;
        }
      }
    }
    j++;
  }
  return null;
}

function extractDirectives(text: string): MattermostDirectives {
  let reactionEmoji: string | null = null;
  const files: { path: string; description?: string }[] = [];
  const attachments: any[] = [];
  let pin = false;
  let editPostId: string | null = null;

  // Extract [embed:{...}] — convert Discord-style embeds to Mattermost attachments
  let embedResult: ReturnType<typeof extractJsonDirective>;
  while ((embedResult = extractJsonDirective(text, "embed")) !== null) {
    const embed = embedResult.value;
    // Convert Discord embed format → Mattermost attachment format
    const colorMap: Record<number, string> = {
      5763719: "#57F287", 15548997: "#ED4245", 5793522: "#5865F2",
      16776960: "#FFFF00", 15105570: "#E67E22",
    };
    const color = embed.color
      ? (colorMap[embed.color] || `#${embed.color.toString(16).padStart(6, "0")}`)
      : "#5865F2";
    const att: any = { color };
    if (embed.title) att.title = embed.title;
    if (embed.description) att.text = embed.description;
    if (embed.url) att.title_link = embed.url;
    if (embed.footer?.text) att.footer = embed.footer.text;
    if (embed.author?.name) att.author_name = embed.author.name;
    if (embed.image?.url) att.image_url = embed.image.url;
    if (embed.thumbnail?.url) att.thumb_url = embed.thumbnail.url;
    if (embed.fields?.length) {
      att.fields = embed.fields.map((f: any) => ({
        title: f.name || "", value: f.value || "", short: f.inline ?? false,
      }));
    }
    attachments.push(att);
    text = embedResult.rest;
  }

  // Strip remaining Discord-specific directives
  text = stripJsonDirective(text, "components");
  text = stripJsonDirective(text, "poll");

  // Extract [attach:{...}] — native Mattermost rich attachments (can be multiple)
  let attachResult: ReturnType<typeof extractJsonDirective>;
  while ((attachResult = extractJsonDirective(text, "attach")) !== null) {
    attachments.push(attachResult.value);
    text = attachResult.rest;
  }

  // Extract [react:emoji]
  text = text.replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
    const candidate = String(raw).trim();
    if (!reactionEmoji && candidate) reactionEmoji = candidate;
    return "";
  });

  // Extract [file:/path "description"]
  text = text.replace(/\[file:([^\]\r\n]+)\]/gi, (_match, raw) => {
    const trimmed = String(raw).trim();
    const descMatch = trimmed.match(/^(.+?)\s+"([^"]+)"$/);
    const filePath = descMatch ? descMatch[1].trim() : trimmed;
    const description = descMatch ? descMatch[2] : undefined;
    files.push({ path: filePath, description });
    return "";
  });

  // Extract [pin]
  text = text.replace(/\[pin\]/gi, () => { pin = true; return ""; });

  // Extract [edit:postId]
  text = text.replace(/\[edit:([^\]\r\n]+)\]/gi, (_match, raw) => {
    editPostId = String(raw).trim();
    return "";
  });

  // Strip [flags:...]
  text = text.replace(/\[flags:[^\]\r\n]+\]/gi, "");

  // Clean whitespace
  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { content: text, reactionEmoji, files, attachments, pin, editPostId };
}

// --- Attachment handling ---

async function downloadAttachment(
  serverUrl: string,
  token: string,
  fileId: string,
  filename: string,
  type: "image" | "voice" | "file",
): Promise<string | null> {
  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "mattermost");
  await mkdir(dir, { recursive: true });

  const response = await fetch(`${serverUrl}/api/v4/files/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Mattermost file download failed: ${response.status}`);

  const ext = extname(filename) || (type === "voice" ? ".ogg" : type === "image" ? ".jpg" : "");
  const localFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
  const localPath = join(dir, localFilename);

  const bytes = new Uint8Array(await response.arrayBuffer());
  await Bun.write(localPath, bytes);
  debugLog(`Attachment downloaded: ${localPath} (${bytes.length} bytes)`);
  return localPath;
}

// --- Trigger logic ---

function shouldRespond(
  channelId: string,
  post: any,
): string | null {
  const config = getSettings().mattermost;

  // Always respond in configured channels
  if (config.alwaysRespondChannelIds.includes(channelId)) return "always_respond_channel";

  // Check for @mention in message
  if (botUsername && typeof post.message === "string") {
    if (post.message.includes(`@${botUsername}`)) return "mention";
  }

  return null;
}

// --- Bot commands ---

async function handleBotCommand(
  serverUrl: string,
  token: string,
  channelId: string,
  postId: string,
  message: string,
  userId: string,
): Promise<boolean> {
  const config = getSettings().mattermost;
  const cmd = message.trim().toLowerCase().split(/\s+/)[0];

  switch (cmd) {
    case "!reset": {
      await resetSession();
      await sendReaction(serverUrl, token, postId, "arrows_counterclockwise");
      await sendMessage(serverUrl, token, channelId, "Session reset.", postId);
      console.log(`[Mattermost] Session reset by ${userId}`);
      return true;
    }

    case "!listen": {
      if (!config.alwaysRespondChannelIds.includes(channelId)) {
        config.alwaysRespondChannelIds.push(channelId);
        await updateSettings((raw) => {
          if (!raw.mattermost) raw.mattermost = {};
          raw.mattermost.alwaysRespondChannelIds = config.alwaysRespondChannelIds;
        });
        await sendReaction(serverUrl, token, postId, "ear");
        await sendMessage(serverUrl, token, channelId, "Now listening in this channel — no @mention needed.", postId);
        console.log(`[Mattermost] Now always-responding in channel ${channelId}`);
      } else {
        await sendMessage(serverUrl, token, channelId, "Already listening in this channel.", postId);
      }
      return true;
    }

    case "!unlisten": {
      const idx = config.alwaysRespondChannelIds.indexOf(channelId);
      if (idx !== -1) {
        config.alwaysRespondChannelIds.splice(idx, 1);
        await updateSettings((raw) => {
          if (!raw.mattermost) raw.mattermost = {};
          raw.mattermost.alwaysRespondChannelIds = config.alwaysRespondChannelIds;
        });
        await sendReaction(serverUrl, token, postId, "mute");
        await sendMessage(serverUrl, token, channelId, "Stopped listening — @mention me to talk.", postId);
        console.log(`[Mattermost] Stopped always-responding in channel ${channelId}`);
      } else {
        await sendMessage(serverUrl, token, channelId, "Not listening in this channel anyway.", postId);
      }
      return true;
    }

    case "!help": {
      const helpText = [
        "**Commands:**",
        "- `!reset` — Reset the conversation session",
        "- `!listen` — Respond to all messages in this channel (no @mention needed)",
        "- `!unlisten` — Only respond when @mentioned",
        "- `!help` — Show this help message",
      ].join("\n");
      await sendMessage(serverUrl, token, channelId, helpText, postId);
      return true;
    }

    default:
      return false;
  }
}

// --- Message handler ---

async function handlePost(
  serverUrl: string,
  token: string,
  post: any,
): Promise<void> {
  const config = getSettings().mattermost;
  const userId = post.user_id;
  const channelId = post.channel_id;
  const postId = post.id;
  const message = post.message || "";

  // Ignore own messages
  if (userId === botUserId) return;

  // Authorization check
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    debugLog(`Skip message from unauthorized user: ${userId}`);
    return;
  }

  // Handle bot commands before trigger check
  if (message.startsWith("!")) {
    const handled = await handleBotCommand(serverUrl, token, channelId, postId, message, userId);
    if (handled) return;
  }

  // Check trigger
  const triggerReason = shouldRespond(channelId, post);
  if (!triggerReason) {
    debugLog(`Skip message in channel=${channelId} from=${userId} reason=no_trigger`);
    return;
  }

  if (!message.trim() && (!post.file_ids || post.file_ids.length === 0)) return;

  // Get username for logging
  let label = userId;
  try {
    const user = await mmApi<{ username: string }>(serverUrl, token, "GET", `/users/${userId}`);
    label = user.username;
  } catch { /* use userId as fallback */ }

  const hasFiles = post.file_ids && post.file_ids.length > 0;
  const fileSuffix = hasFiles ? ` [${post.file_ids.length} file(s)]` : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Mattermost ${label}${fileSuffix}: "${message.slice(0, 60)}${message.length > 60 ? "..." : ""}"`,
  );

  // Typing indicator
  const typingInterval = setInterval(
    () => sendTyping(serverUrl, token, channelId),
    3000,
  );

  try {
    await sendTyping(serverUrl, token, channelId);

    let imagePath: string | null = null;
    let voicePath: string | null = null;
    let voiceTranscript: string | null = null;

    // Handle file attachments
    if (hasFiles) {
      for (const fileId of post.file_ids) {
        try {
          const fileInfo = await mmApi<{
            id: string;
            name: string;
            mime_type: string;
            extension: string;
          }>(serverUrl, token, "GET", `/files/${fileId}/info`);

          const mime = fileInfo.mime_type || "";
          const isImage = mime.startsWith("image/");
          const isAudio = mime.startsWith("audio/");

          if (isImage && !imagePath) {
            imagePath = await downloadAttachment(serverUrl, token, fileId, fileInfo.name, "image");
          } else if (isAudio && !voicePath) {
            voicePath = await downloadAttachment(serverUrl, token, fileId, fileInfo.name, "voice");
          }
        } catch (err) {
          console.error(`[Mattermost] Failed to download file ${fileId}: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Transcribe voice
      if (voicePath) {
        try {
          voiceTranscript = await transcribeAudioToText(voicePath, {
            debug: mmDebug,
            log: (msg) => debugLog(msg),
          });
        } catch (err) {
          console.error(`[Mattermost] Failed to transcribe voice: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Clean content — strip @mention
    let cleanContent = message;
    if (botUsername) {
      cleanContent = cleanContent.replace(new RegExp(`@${botUsername}\\b`, "gi"), "").trim();
    }

    // Build prompt
    const promptParts = [`[Mattermost from ${label}]`];
    if (cleanContent.trim()) promptParts.push(`Message: ${cleanContent}`);
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    }
    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
      promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
    } else if (voicePath) {
      promptParts.push("The user attached voice audio, but it could not be transcribed. Respond and ask them to resend a clearer clip.");
    }

    const prefixedPrompt = promptParts.join("\n");
    const result = await runUserMessage("mattermost", prefixedPrompt);

    if (result.exitCode !== 0) {
      await sendMessage(serverUrl, token, channelId,
        `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`, postId);
    } else {
      const directives = extractDirectives(result.stdout || "");

      // Send reaction
      if (directives.reactionEmoji) {
        await sendReaction(serverUrl, token, postId, emojiToName(directives.reactionEmoji));
      }

      // Edit existing post instead of sending new
      if (directives.editPostId && directives.content.trim()) {
        await editMessage(serverUrl, token, directives.editPostId, directives.content);
      } else if (directives.attachments.length > 0) {
        // Send rich attachment message
        const sentPost = await sendAttachmentMessage(
          serverUrl, token, channelId,
          directives.content, directives.attachments, postId,
        );
        if (directives.pin) await pinMessage(serverUrl, token, sentPost.id);
      } else if (directives.content.trim()) {
        // Send text response (as thread reply)
        const sentPost = await sendMessage(serverUrl, token, channelId, directives.content, postId);
        if (directives.pin) await pinMessage(serverUrl, token, sentPost.id);
      } else if (!directives.files.length && !directives.reactionEmoji) {
        await sendMessage(serverUrl, token, channelId, "(empty response)", postId);
      }

      // Send file attachments
      for (const file of directives.files) {
        try {
          await sendFileMessage(serverUrl, token, channelId, file.path, file.description, postId);
        } catch (err) {
          console.error(`[Mattermost] Failed to send file ${file.path}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Mattermost] Error for ${label}: ${errMsg}`);
    await sendMessage(serverUrl, token, channelId, `Error: ${errMsg}`, postId);
  } finally {
    clearInterval(typingInterval);
  }
}

// --- WebSocket connection ---

function connectWebSocket(serverUrl: string, token: string): void {
  const wsUrl = serverUrl.replace(/^http/, "ws") + "/api/v4/websocket";
  debugLog(`Connecting to WebSocket: ${wsUrl}`);

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    debugLog("WebSocket connected");
    // Authenticate
    ws!.send(JSON.stringify({
      seq: seqNum++,
      action: "authentication_challenge",
      data: { token },
    }));
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(String(event.data));

      if (data.event === "posted") {
        const post = JSON.parse(data.data.post);
        handlePost(serverUrl, token, post).catch((err) =>
          console.error(`[Mattermost] POST unhandled: ${err}`),
        );
      }

      if (data.event === "hello") {
        debugLog("WebSocket authenticated");
      }
    } catch (err) {
      debugLog(`WebSocket message parse error: ${err}`);
    }
  };

  ws.onclose = (event) => {
    debugLog(`WebSocket closed: code=${event.code} reason=${event.reason}`);
    ws = null;

    if (running) {
      // Reconnect after delay
      const delay = event.code === 1000 ? 1000 : 5000;
      debugLog(`Reconnecting in ${delay}ms...`);
      setTimeout(() => {
        if (running) connectWebSocket(serverUrl, token);
      }, delay);
    }
  };

  ws.onerror = (event) => {
    console.error(`[Mattermost] WebSocket error: ${event}`);
  };
}

// --- Exports ---

export {
  sendMessage as mattermostSendMessage,
  editMessage as mattermostEditMessage,
  sendAttachmentMessage as mattermostSendAttachment,
  pinMessage as mattermostPinMessage,
  sendReaction as mattermostSendReaction,
};

export function stopMattermost(): void {
  running = false;
  if (ws) {
    ws.close(1000, "shutdown");
    ws = null;
  }
}

export function startMattermost(debug = false): void {
  mmDebug = debug;
  const config = getSettings().mattermost;
  running = true;

  console.log("Mattermost bot started (WebSocket)");
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
  console.log(`  Always-respond channels: ${config.alwaysRespondChannelIds.length}`);
  if (mmDebug) console.log("  Debug: enabled");

  (async () => {
    await ensureProjectClaudeMd();

    // Get bot's own user info
    const me = await mmApi<{ id: string; username: string }>(
      config.serverUrl, config.token, "GET", "/users/me",
    );
    botUserId = me.id;
    botUsername = me.username;
    console.log(`[Mattermost] Logged in as @${botUsername} (${botUserId})`);

    // Connect WebSocket for real-time events
    connectWebSocket(config.serverUrl, config.token);
  })().catch((err) => {
    console.error(`[Mattermost] Fatal: ${err}`);
  });
}

/** Standalone entry point */
export async function mattermost() {
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().mattermost;

  if (!config.token) {
    console.error("Mattermost token not configured. Set mattermost.token in .claude/claudeclaw/settings.json");
    process.exit(1);
  }
  if (!config.serverUrl) {
    console.error("Mattermost serverUrl not configured.");
    process.exit(1);
  }

  console.log("Mattermost bot started (WebSocket, standalone)");
  startMattermost();
  await new Promise(() => {});
}
