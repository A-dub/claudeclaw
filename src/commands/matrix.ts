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
  const htmlBody = textToHtml(text);

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

/** Convert basic markdown to HTML for Matrix. */
function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br/>");
}

// --- Reaction directive extraction ---

function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/\[embed:[^\]]*\]/gi, "") // Strip Discord-specific directives
    .replace(/\[components:[^\]]*\]/gi, "")
    .replace(/\[poll:[^\]]*\]/gi, "")
    .replace(/\[flags:[^\]]*\]/gi, "")
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

  // Check trigger
  const triggerReason = shouldRespond(roomId, content, senderId);
  if (!triggerReason) {
    debugLog(`Skip message in room=${roomId} from=${senderId} reason=no_trigger`);
    return;
  }

  const msgtype = content.msgtype;
  const body = content.body || "";
  const isImage = msgtype === "m.image";
  const isAudio = msgtype === "m.audio" || msgtype === "m.voice";
  const isText = msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote";

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
      await sendMessage(baseUrl, accessToken, roomId, `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`);
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

      // Send text response
      if (responseText.trim()) {
        await sendMessage(baseUrl, accessToken, roomId, responseText);
      } else if (!files.length && !reactionEmoji) {
        await sendMessage(baseUrl, accessToken, roomId, "(empty response)");
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
            await matrixApi(baseUrl, accessToken, "POST", `/rooms/${encodeURIComponent(roomId)}/join`, {}).catch((err) =>
              console.error(`[Matrix] Failed to auto-join ${roomId}: ${err}`),
            );
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

export { sendMessage as matrixSendMessage };

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
