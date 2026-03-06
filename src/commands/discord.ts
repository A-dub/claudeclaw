import { ensureProjectClaudeMd, run, runUserMessage } from "../runner";
import { getSettings, loadSettings, updateSettings } from "../config";
import { resetSession } from "../sessions";
import { transcribeAudioToText } from "../whisper";
import { mkdir } from "node:fs/promises";
import { extname, join, basename } from "node:path";
import { existsSync } from "node:fs";

// --- Discord API constants ---

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

// Intents bitfield
const INTENTS =
  (1 << 0) |   // GUILDS
  (1 << 9) |   // GUILD_MESSAGES
  (1 << 10) |  // GUILD_MESSAGE_REACTIONS
  (1 << 12) |  // DIRECT_MESSAGES
  (1 << 15);   // MESSAGE_CONTENT (privileged)

// --- Type interfaces ---

interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  bot?: boolean;
}

interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  url: string;
  proxy_url: string;
  size: number;
  flags?: number;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  attachments: DiscordAttachment[];
  mentions: DiscordUser[];
  referenced_message?: DiscordMessage | null;
  flags?: number;
  type: number;
}

interface DiscordInteraction {
  id: string;
  type: number; // 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT
  data?: {
    name?: string;
    custom_id?: string;
  };
  channel_id?: string;
  guild_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  token: string;
  message?: DiscordMessage;
}

interface DiscordGuild {
  id: string;
  name: string;
  system_channel_id?: string | null;
  joined_at?: string;
}

interface GatewayPayload {
  op: number;
  d: any;
  s: number | null;
  t: string | null;
}

// --- Gateway state ---

let ws: WebSocket | null = null;
let heartbeatIntervalMs = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatJitterTimer: ReturnType<typeof setTimeout> | null = null;
let lastSequence: number | null = null;
let gatewaySessionId: string | null = null;
let resumeGatewayUrl: string | null = null;
let heartbeatAcked = true;
let running = true;
let discordDebug = false;

// Bot identity (populated from READY)
let botUserId: string | null = null;
let botUsername: string | null = null;
let applicationId: string | null = null;

// Track guilds we were already in before this session to avoid duplicate welcome messages
let readyGuildIds: Set<string> | null = null;

// --- Debug ---

function debugLog(message: string): void {
  if (!discordDebug) return;
  console.log(`[Discord][debug] ${message}`);
}

// --- REST API helper ---

async function discordApi<T>(
  token: string,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${DISCORD_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Rate limit handling
  if (res.status === 429) {
    const data = (await res.json()) as { retry_after: number };
    const retryMs = Math.ceil(data.retry_after * 1000);
    debugLog(`Rate limited on ${method} ${endpoint}, retrying in ${retryMs}ms`);
    await Bun.sleep(retryMs);
    return discordApi(token, method, endpoint, body);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API ${method} ${endpoint}: ${res.status} ${res.statusText} ${text}`);
  }

  // 204 No Content (reactions, etc.)
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Send a message with file attachments via multipart/form-data. */
async function discordApiMultipart<T>(
  token: string,
  endpoint: string,
  payload: Record<string, unknown>,
  files: { path: string; name: string; description?: string }[],
): Promise<T> {
  const formData = new FormData();

  // Add file attachments metadata to payload
  const attachments = files.map((f, i) => ({
    id: i,
    filename: f.name,
    description: f.description || "",
  }));
  payload.attachments = attachments;

  formData.append("payload_json", JSON.stringify(payload));

  for (let i = 0; i < files.length; i++) {
    const file = Bun.file(files[i].path);
    formData.append(`files[${i}]`, file, files[i].name);
  }

  const res = await fetch(`${DISCORD_API}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
    body: formData,
  });

  if (res.status === 429) {
    const data = (await res.json()) as { retry_after: number };
    const retryMs = Math.ceil(data.retry_after * 1000);
    debugLog(`Rate limited on multipart POST ${endpoint}, retrying in ${retryMs}ms`);
    await Bun.sleep(retryMs);
    return discordApiMultipart(token, endpoint, payload, files);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API multipart POST ${endpoint}: ${res.status} ${res.statusText} ${text}`);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// --- Message sending ---

async function sendMessage(
  token: string,
  channelId: string,
  text: string,
  components?: unknown[],
): Promise<void> {
  const normalized = text.replace(/\[react:[^\]\r\n]+\]/gi, "").trim();
  if (!normalized) return;
  const MAX_LEN = 2000;
  for (let i = 0; i < normalized.length; i += MAX_LEN) {
    const chunk = normalized.slice(i, i + MAX_LEN);
    const body: Record<string, unknown> = { content: chunk };
    // Attach components only to the last chunk
    if (components && i + MAX_LEN >= normalized.length) {
      body.components = components;
    }
    await discordApi(token, "POST", `/channels/${channelId}/messages`, body);
  }
}

/** Send a rich message with optional embeds, components, polls, flags, and files. */
async function sendRichMessage(
  token: string,
  channelId: string,
  rich: DiscordRichMessage,
): Promise<void> {
  const hasRichContent = rich.embeds.length > 0 || rich.components.length > 0 || rich.poll || rich.flags || rich.files.length > 0;

  // If no rich content, fall back to plain sendMessage
  if (!hasRichContent) {
    await sendMessage(token, channelId, rich.content);
    return;
  }

  const MAX_LEN = 2000;
  const content = rich.content;

  // Build the payload
  const buildPayload = (text?: string, includeRich = false): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    if (text) body.content = text;
    if (includeRich) {
      if (rich.embeds.length > 0) body.embeds = rich.embeds.slice(0, 10);
      if (rich.components.length > 0) body.components = rich.components.slice(0, 5);
      if (rich.poll) body.poll = rich.poll;
      if (rich.flags) body.flags = rich.flags;
    }
    return body;
  };

  // If we have files, use multipart upload
  if (rich.files.length > 0) {
    if (content.length <= MAX_LEN) {
      // Everything in one message
      const payload = buildPayload(content || undefined, true);
      await discordApiMultipart(token, `/channels/${channelId}/messages`, payload, rich.files.slice(0, 10));
    } else {
      // Send text chunks first, then files with rich content in last message
      const chunks: string[] = [];
      for (let i = 0; i < content.length; i += MAX_LEN) {
        chunks.push(content.slice(i, i + MAX_LEN));
      }
      // Send all but last as plain text
      for (let i = 0; i < chunks.length - 1; i++) {
        await discordApi(token, "POST", `/channels/${channelId}/messages`, { content: chunks[i] });
      }
      // Last chunk with files + rich content
      const payload = buildPayload(chunks[chunks.length - 1], true);
      await discordApiMultipart(token, `/channels/${channelId}/messages`, payload, rich.files.slice(0, 10));
    }
    return;
  }

  // No files — JSON-only path
  if (content.length <= MAX_LEN) {
    const body = buildPayload(content || undefined, true);
    await discordApi(token, "POST", `/channels/${channelId}/messages`, body);
    return;
  }

  // Content is long — send text in chunks, attach rich elements to the last chunk
  for (let i = 0; i < content.length; i += MAX_LEN) {
    const chunk = content.slice(i, i + MAX_LEN);
    const isLast = i + MAX_LEN >= content.length;
    const body = buildPayload(chunk, isLast);
    await discordApi(token, "POST", `/channels/${channelId}/messages`, body);
  }
}

async function sendMessageToUser(
  token: string,
  userId: string,
  text: string,
): Promise<void> {
  // Discord requires creating a DM channel before sending
  const channel = await discordApi<{ id: string }>(
    token,
    "POST",
    "/users/@me/channels",
    { recipient_id: userId },
  );
  await sendMessage(token, channel.id, text);
}

async function sendTyping(token: string, channelId: string): Promise<void> {
  await discordApi(token, "POST", `/channels/${channelId}/typing`).catch(() => {});
}

async function sendReaction(
  token: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  const encoded = encodeURIComponent(emoji);
  await fetch(
    `${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
    {
      method: "PUT",
      headers: { Authorization: `Bot ${token}` },
    },
  ).catch(() => {});
}

// --- Reaction directive extraction (same as telegram.ts) ---

function extractReactionDirective(text: string): { cleanedText: string; reactionEmoji: string | null } {
  let reactionEmoji: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionEmoji };
}

// --- Rich message directive extraction ---

interface DiscordFileAttachment {
  path: string;
  name: string;
  description?: string;
}

interface DiscordRichMessage {
  content: string;
  embeds: unknown[];
  components: unknown[];
  poll: unknown | null;
  flags: number;
  reactionEmoji: string | null;
  files: DiscordFileAttachment[];
}

/**
 * Extract a JSON-containing directive like [embed:{...}] by counting bracket depth.
 * Returns all matches as { start, end, json } and handles nested brackets correctly.
 */
function extractJsonDirectives(text: string, tag: string): { remaining: string; jsons: unknown[] } {
  const jsons: unknown[] = [];
  const prefix = `[${tag}:`;
  let result = "";
  let i = 0;

  while (i < text.length) {
    const lower = text.slice(i, i + prefix.length).toLowerCase();
    if (lower === prefix.toLowerCase()) {
      // Found directive start — find the JSON by counting brackets
      const jsonStart = i + prefix.length;
      let depth = 0;
      let inString = false;
      let escaped = false;
      let j = jsonStart;
      let foundJson = false;

      while (j < text.length) {
        const ch = text[j];
        if (escaped) {
          escaped = false;
          j++;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          j++;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          j++;
          continue;
        }
        if (inString) {
          j++;
          continue;
        }
        if (ch === "{" || ch === "[") depth++;
        if (ch === "}" || ch === "]") {
          depth--;
          if (depth === 0) {
            // End of JSON object/array — expect closing ]
            const jsonStr = text.slice(jsonStart, j + 1);
            // Skip optional whitespace then the closing ]
            let k = j + 1;
            while (k < text.length && (text[k] === " " || text[k] === "\t")) k++;
            if (k < text.length && text[k] === "]") {
              try {
                jsons.push(JSON.parse(jsonStr));
                i = k + 1;
                foundJson = true;
              } catch {
                debugLog(`Failed to parse ${tag} JSON: ${jsonStr.slice(0, 100)}`);
                i = k + 1;
                foundJson = true;
              }
            }
            break;
          }
        }
        j++;
      }

      if (!foundJson) {
        // Couldn't parse — keep the text as-is
        result += text[i];
        i++;
      }
    } else {
      result += text[i];
      i++;
    }
  }

  return { remaining: result, jsons };
}

/**
 * Parse rich message directives from response text.
 * Uses bracket-depth parsing for JSON directives to handle nested arrays/objects.
 */
function extractRichMessage(text: string): DiscordRichMessage {
  const embeds: unknown[] = [];
  const components: unknown[] = [];
  const files: DiscordFileAttachment[] = [];
  let poll: unknown | null = null;
  let flags = 0;
  let reactionEmoji: string | null = null;

  // First pass: extract JSON directives using bracket-depth parser
  let remaining = text;

  const embedResult = extractJsonDirectives(remaining, "embed");
  remaining = embedResult.remaining;
  embeds.push(...embedResult.jsons);

  const compResult = extractJsonDirectives(remaining, "components");
  remaining = compResult.remaining;
  for (const c of compResult.jsons) {
    if (Array.isArray(c)) components.push(...c);
    else components.push(c);
  }

  const pollResult = extractJsonDirectives(remaining, "poll");
  remaining = pollResult.remaining;
  if (pollResult.jsons.length > 0) poll = pollResult.jsons[0];

  // Second pass: simple regex directives (no nested brackets)
  let cleaned = remaining
    // React directive
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionEmoji && candidate) reactionEmoji = candidate;
      return "";
    })
    // Flags directive
    .replace(/\[flags:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const flagStr = String(raw).trim().toUpperCase();
      if (flagStr.includes("SUPPRESS_NOTIFICATIONS")) flags |= 1 << 12;
      if (flagStr.includes("SUPPRESS_EMBEDS")) flags |= 1 << 2;
      return "";
    })
    // File directive — [file:/path/to/image.png] or [file:/path/to/file.pdf "description"]
    .replace(/\[file:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const trimmed = String(raw).trim();
      const descMatch = trimmed.match(/^(.+?)\s+"([^"]+)"$/);
      const filePath = descMatch ? descMatch[1].trim() : trimmed;
      const description = descMatch ? descMatch[2] : undefined;
      if (existsSync(filePath)) {
        files.push({ path: filePath, name: basename(filePath), description });
      } else {
        debugLog(`File not found for attachment: ${filePath}`);
      }
      return "";
    });

  // Clean up whitespace
  cleaned = cleaned
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { content: cleaned, embeds, components, poll, flags, reactionEmoji, files };
}

// --- Guild trigger logic ---

function guildTriggerReason(message: DiscordMessage): string | null {
  // Reply to bot
  if (botUserId && message.referenced_message?.author?.id === botUserId) return "reply_to_bot";

  // Mention via mentions array
  if (botUserId && message.mentions.some((m) => m.id === botUserId)) return "mention";

  // Mention in content (fallback)
  if (botUserId && message.content.includes(`<@${botUserId}>`)) return "mention_in_content";

  // Always-respond channels (no mention required)
  const config = getSettings().discord;
  if (config.alwaysRespondChannelIds.includes(message.channel_id)) return "always_respond_channel";

  return null;
}

// --- Attachment handling ---

function isImageAttachment(a: DiscordAttachment): boolean {
  return Boolean(a.content_type?.startsWith("image/"));
}

function isVoiceAttachment(a: DiscordAttachment): boolean {
  // IS_VOICE_MESSAGE flag
  if ((a.flags ?? 0) & (1 << 13)) return true;
  return Boolean(a.content_type?.startsWith("audio/"));
}

async function downloadDiscordAttachment(
  attachment: DiscordAttachment,
  type: "image" | "voice",
): Promise<string | null> {
  const dir = join(process.cwd(), ".claude", "claudeclaw", "inbox", "discord");
  await mkdir(dir, { recursive: true });

  const response = await fetch(attachment.url);
  if (!response.ok) throw new Error(`Discord attachment download failed: ${response.status}`);

  const ext = extname(attachment.filename) || (type === "voice" ? ".ogg" : ".jpg");
  const filename = `${attachment.id}-${Date.now()}${ext}`;
  const localPath = join(dir, filename);

  const bytes = new Uint8Array(await response.arrayBuffer());
  await Bun.write(localPath, bytes);
  debugLog(`Attachment downloaded: ${localPath} (${bytes.length} bytes)`);
  return localPath;
}

// --- Slash command registration ---

async function registerSlashCommands(token: string): Promise<void> {
  if (!applicationId) return;

  const commands = [
    {
      name: "reset",
      description: "Reset the global session for a fresh start",
      type: 1,
    },
    {
      name: "listen",
      description: "Always respond in this channel without @mention",
      type: 1,
    },
    {
      name: "unlisten",
      description: "Stop auto-responding in this channel (require @mention again)",
      type: 1,
    },
    {
      name: "stop",
      description: "Stop the ClaudeClaw daemon gracefully",
      type: 1,
    },
    {
      name: "restart",
      description: "Restart the ClaudeClaw daemon",
      type: 1,
    },
  ];

  await discordApi(
    token,
    "PUT",
    `/applications/${applicationId}/commands`,
    commands,
  );
  debugLog("Slash commands registered");
}

// --- Interaction response helper ---

async function respondToInteraction(
  interaction: DiscordInteraction,
  data: { content: string; flags?: number; components?: unknown[] },
): Promise<void> {
  await fetch(
    `${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
        data,
      }),
    },
  );
}

// --- Message handler ---

async function handleMessageCreate(token: string, message: DiscordMessage): Promise<void> {
  const config = getSettings().discord;

  // Ignore bot messages
  if (message.author.bot) return;

  const userId = message.author.id;
  const channelId = message.channel_id;
  const isDM = !message.guild_id;
  const isGuild = !!message.guild_id;
  const content = message.content;

  // Guild trigger check
  const triggerReason = isGuild ? guildTriggerReason(message) : "direct_message";
  if (isGuild && !triggerReason) {
    debugLog(`Skip guild message channel=${channelId} from=${userId} reason=no_trigger`);
    return;
  }
  debugLog(
    `Handle message channel=${channelId} from=${userId} reason=${triggerReason} text="${content.slice(0, 80)}"`,
  );

  // Authorization check
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) {
    if (isDM) {
      await sendMessage(config.token, channelId, "Unauthorized.");
    } else {
      debugLog(`Skip guild message channel=${channelId} from=${userId} reason=unauthorized_user`);
    }
    return;
  }

  // Detect attachments
  const imageAttachments = message.attachments.filter(isImageAttachment);
  const voiceAttachments = message.attachments.filter(isVoiceAttachment);
  const hasImage = imageAttachments.length > 0;
  const hasVoice = voiceAttachments.length > 0;

  if (!content.trim() && !hasImage && !hasVoice) return;

  // Strip bot mention from content for cleaner prompt
  let cleanContent = content;
  if (botUserId) {
    cleanContent = cleanContent.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
  }

  const label = message.author.username;
  const mediaParts = [hasImage ? "image" : "", hasVoice ? "voice" : ""].filter(Boolean);
  const mediaSuffix = mediaParts.length > 0 ? ` [${mediaParts.join("+")}]` : "";
  console.log(
    `[${new Date().toLocaleTimeString()}] Discord ${label}${mediaSuffix}: "${cleanContent.slice(0, 60)}${cleanContent.length > 60 ? "..." : ""}"`,
  );

  // Typing indicator loop (Discord typing lasts 10s, fire every 8s)
  const typingInterval = setInterval(() => sendTyping(config.token, channelId), 8000);

  try {
    await sendTyping(config.token, channelId);

    let imagePath: string | null = null;
    let voicePath: string | null = null;
    let voiceTranscript: string | null = null;

    if (hasImage) {
      try {
        imagePath = await downloadDiscordAttachment(imageAttachments[0], "image");
      } catch (err) {
        console.error(`[Discord] Failed to download image for ${label}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (hasVoice) {
      try {
        voicePath = await downloadDiscordAttachment(voiceAttachments[0], "voice");
      } catch (err) {
        console.error(`[Discord] Failed to download voice for ${label}: ${err instanceof Error ? err.message : err}`);
      }

      if (voicePath) {
        try {
          debugLog(`Voice file saved: path=${voicePath}`);
          voiceTranscript = await transcribeAudioToText(voicePath, {
            debug: discordDebug,
            log: (msg) => debugLog(msg),
          });
        } catch (err) {
          console.error(`[Discord] Failed to transcribe voice for ${label}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Build prompt (same pattern as Telegram)
    const promptParts = [`[Discord from ${label}]`];
    if (cleanContent.trim()) promptParts.push(`Message: ${cleanContent}`);
    if (imagePath) {
      promptParts.push(`Image path: ${imagePath}`);
      promptParts.push("The user attached an image. Inspect this image file directly before answering.");
    } else if (hasImage) {
      promptParts.push("The user attached an image, but downloading it failed. Respond and ask them to resend.");
    }
    if (voiceTranscript) {
      promptParts.push(`Voice transcript: ${voiceTranscript}`);
      promptParts.push("The user attached voice audio. Use the transcript as their spoken message.");
    } else if (hasVoice) {
      promptParts.push(
        "The user attached voice audio, but it could not be transcribed. Respond and ask them to resend a clearer clip.",
      );
    }

    const prefixedPrompt = promptParts.join("\n");
    const result = await runUserMessage("discord", prefixedPrompt);

    if (result.exitCode !== 0) {
      await sendMessage(config.token, channelId, `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`);
    } else {
      const rich = extractRichMessage(result.stdout || "");
      if (rich.reactionEmoji) {
        await sendReaction(config.token, channelId, message.id, rich.reactionEmoji).catch((err) => {
          console.error(`[Discord] Failed to send reaction for ${label}: ${err instanceof Error ? err.message : err}`);
        });
      }
      if (!rich.content && rich.embeds.length === 0 && !rich.poll) {
        await sendMessage(config.token, channelId, "(empty response)");
      } else {
        await sendRichMessage(config.token, channelId, rich);
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Discord] Error for ${label}: ${errMsg}`);
    await sendMessage(config.token, channelId, `Error: ${errMsg}`);
  } finally {
    clearInterval(typingInterval);
  }
}

// --- Interaction handler (slash commands + secretary buttons) ---

async function handleInteractionCreate(token: string, interaction: DiscordInteraction): Promise<void> {
  const config = getSettings().discord;
  const actorId = interaction.member?.user?.id ?? interaction.user?.id;

  if (config.allowedUserIds.length > 0 && (!actorId || !config.allowedUserIds.includes(actorId))) {
    await respondToInteraction(interaction, { content: "Unauthorized.", flags: 64 });
    return;
  }

  // Slash commands (type 2)
  if (interaction.type === 2 && interaction.data?.name) {
    if (interaction.data.name === "reset") {
      await resetSession();
      await respondToInteraction(interaction, {
        content: "Global session reset. Next message starts fresh.",
      });
      return;
    }

    if (interaction.data.name === "listen") {
      const channelId = interaction.channel_id;
      if (!channelId) {
        await respondToInteraction(interaction, { content: "Could not determine channel.", flags: 64 });
        return;
      }
      const config = getSettings().discord;
      if (config.alwaysRespondChannelIds.includes(channelId)) {
        await respondToInteraction(interaction, { content: "Already listening in this channel." });
        return;
      }
      await updateSettings((raw) => {
        if (!Array.isArray(raw.discord?.alwaysRespondChannelIds)) {
          raw.discord = raw.discord || {};
          raw.discord.alwaysRespondChannelIds = [];
        }
        raw.discord.alwaysRespondChannelIds.push(channelId);
      });
      await respondToInteraction(interaction, {
        content: "Now listening in this channel — no @mention needed.",
      });
      return;
    }

    if (interaction.data.name === "unlisten") {
      const channelId = interaction.channel_id;
      if (!channelId) {
        await respondToInteraction(interaction, { content: "Could not determine channel.", flags: 64 });
        return;
      }
      const config = getSettings().discord;
      if (!config.alwaysRespondChannelIds.includes(channelId)) {
        await respondToInteraction(interaction, { content: "Not listening in this channel." });
        return;
      }
      await updateSettings((raw) => {
        if (Array.isArray(raw.discord?.alwaysRespondChannelIds)) {
          raw.discord.alwaysRespondChannelIds = raw.discord.alwaysRespondChannelIds.filter(
            (id: string) => String(id) !== channelId,
          );
        }
      });
      await respondToInteraction(interaction, {
        content: "Stopped listening. @mention or reply required again.",
      });
      return;
    }

    if (interaction.data.name === "stop") {
      await respondToInteraction(interaction, { content: "Shutting down... goodbye!" });
      console.log(`[Discord] /stop issued by ${actorId}`);
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 500);
      return;
    }

    if (interaction.data.name === "restart") {
      await respondToInteraction(interaction, { content: "Restarting..." });
      console.log(`[Discord] /restart issued by ${actorId}`);
      const entryPoint = join(import.meta.dir, "..", "index.ts");
      const logPath = join(process.cwd(), ".claude", "claudeclaw", "logs", "daemon.log");
      const logFile = Bun.file(logPath);
      const child = Bun.spawn(
        [process.execPath, "run", entryPoint, "start", "--web", "--replace-existing"],
        {
          cwd: process.cwd(),
          stdin: "ignore",
          stdout: logFile,
          stderr: logFile,
        },
      );
      child.unref();
      return;
    }

    // Unknown command
    await respondToInteraction(interaction, { content: "Unknown command." });
    return;
  }

  // Button interactions (type 3) — secretary workflow
  if (interaction.type === 3 && interaction.data?.custom_id) {
    const customId = interaction.data.custom_id;

    // Secretary pattern: "sec_yes_<8hex>" or "sec_no_<8hex>"
    const secMatch = customId.match(/^sec_(yes|no)_([0-9a-f]{8})$/);
    if (secMatch) {
      const action = secMatch[1];
      const pendingId = secMatch[2];
      let responseText = "Server error";

      try {
        const resp = await fetch(`http://127.0.0.1:9999/confirm/${pendingId}/${action}`);
        const result = (await resp.json()) as { ok: boolean };
        responseText =
          action === "yes" && result.ok
            ? "Sent!"
            : result.ok
              ? "Dismissed"
              : "Not found";
      } catch {
        // server not running
      }

      await respondToInteraction(interaction, {
        content: responseText,
        flags: 64, // EPHEMERAL
      });
      return;
    }

    // Default button ack
    await respondToInteraction(interaction, { content: "OK", flags: 64 });
    return;
  }

  // Default ack for any other interaction type
  await respondToInteraction(interaction, { content: "OK", flags: 64 });
}

// --- Guild join handler ---

async function handleGuildCreate(token: string, guild: DiscordGuild): Promise<void> {
  const config = getSettings().discord;

  // Skip guilds we were already in at READY time
  if (readyGuildIds?.has(guild.id)) return;

  const channelId = guild.system_channel_id;
  if (!channelId) return;

  console.log(`[Discord] Joined guild: ${guild.name} (${guild.id})`);

  const eventPrompt =
    `[Discord system event] I was added to a guild.\n` +
    `Guild name: ${guild.name}\n` +
    `Guild id: ${guild.id}\n` +
    "Write a short first message for the server. Confirm I was added and explain how to trigger me (mention or reply).";

  try {
    const result = await run("discord", eventPrompt);
    if (result.exitCode !== 0) {
      await sendMessage(config.token, channelId, "I was added to this server. Mention me to start.");
      return;
    }
    await sendMessage(config.token, channelId, result.stdout || "I was added to this server.");
  } catch {
    await sendMessage(config.token, channelId, "I was added to this server. Mention me to start.");
  }
}

// --- Gateway WebSocket ---

function sendWs(data: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendHeartbeat(): void {
  sendWs({ op: GatewayOp.HEARTBEAT, d: lastSequence });
  heartbeatAcked = false;
}

function startHeartbeat(): void {
  stopHeartbeat();
  // First heartbeat with jitter per Discord spec
  heartbeatJitterTimer = setTimeout(() => {
    heartbeatJitterTimer = null;
    sendHeartbeat();
  }, Math.random() * heartbeatIntervalMs);
  heartbeatTimer = setInterval(() => {
    if (!heartbeatAcked) {
      debugLog("Heartbeat not acked, reconnecting");
      ws?.close(4000, "Heartbeat timeout");
      return;
    }
    sendHeartbeat();
  }, heartbeatIntervalMs);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (heartbeatJitterTimer) clearTimeout(heartbeatJitterTimer);
  heartbeatJitterTimer = null;
}

function resetGatewayState(): void {
  heartbeatIntervalMs = 0;
  heartbeatAcked = true;
  lastSequence = null;
  gatewaySessionId = null;
  resumeGatewayUrl = null;
  readyGuildIds = null;
  botUserId = null;
  botUsername = null;
  applicationId = null;
}

function sendIdentify(token: string): void {
  sendWs({
    op: GatewayOp.IDENTIFY,
    d: {
      token,
      intents: INTENTS,
      properties: {
        os: process.platform,
        browser: "claudeclaw",
        device: "claudeclaw",
      },
    },
  });
}

function sendResume(token: string): void {
  sendWs({
    op: GatewayOp.RESUME,
    d: {
      token,
      session_id: gatewaySessionId,
      seq: lastSequence,
    },
  });
}

// Non-recoverable close codes that should not trigger reconnection
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

function handleDispatch(token: string, eventName: string, data: any): void {
  debugLog(`Dispatch: ${eventName}`);

  switch (eventName) {
    case "READY":
      gatewaySessionId = data.session_id;
      resumeGatewayUrl = data.resume_gateway_url;
      botUserId = data.user.id;
      botUsername = data.user.username;
      applicationId = data.application.id;
      // Track existing guilds so we don't send welcome messages on reconnect
      readyGuildIds = new Set((data.guilds ?? []).map((g: { id: string }) => g.id));
      console.log(`[Discord] Ready as ${data.user.username} (${data.user.id})`);
      registerSlashCommands(token).catch((err) =>
        console.error(`[Discord] Failed to register slash commands: ${err}`),
      );
      break;

    case "RESUMED":
      debugLog("Session resumed successfully");
      break;

    case "MESSAGE_CREATE":
      handleMessageCreate(token, data).catch((err) =>
        console.error(`[Discord] MESSAGE_CREATE unhandled: ${err}`),
      );
      break;

    case "INTERACTION_CREATE":
      handleInteractionCreate(token, data).catch((err) =>
        console.error(`[Discord] INTERACTION_CREATE unhandled: ${err}`),
      );
      break;

    case "GUILD_CREATE":
      handleGuildCreate(token, data).catch((err) =>
        console.error(`[Discord] GUILD_CREATE unhandled: ${err}`),
      );
      break;
  }
}

function handleGatewayPayload(token: string, payload: GatewayPayload): void {
  if (payload.s !== null) lastSequence = payload.s;

  switch (payload.op) {
    case GatewayOp.HELLO:
      heartbeatIntervalMs = payload.d.heartbeat_interval;
      startHeartbeat();
      if (gatewaySessionId && lastSequence !== null) {
        sendResume(token);
      } else {
        sendIdentify(token);
      }
      break;

    case GatewayOp.HEARTBEAT_ACK:
      heartbeatAcked = true;
      break;

    case GatewayOp.HEARTBEAT:
      // Server-requested heartbeat
      sendHeartbeat();
      break;

    case GatewayOp.RECONNECT:
      debugLog("Gateway requested reconnect");
      ws?.close(4000, "Reconnect requested");
      break;

    case GatewayOp.INVALID_SESSION: {
      const resumable = payload.d;
      debugLog(`Invalid session, resumable=${resumable}`);
      if (!resumable) {
        gatewaySessionId = null;
        lastSequence = null;
      }
      setTimeout(() => {
        if (resumable && gatewaySessionId) {
          sendResume(token);
        } else {
          sendIdentify(token);
        }
      }, 1000 + Math.random() * 4000);
      break;
    }

    case GatewayOp.DISPATCH:
      handleDispatch(token, payload.t!, payload.d);
      break;
  }
}

function connectGateway(token: string, url?: string): void {
  const gatewayUrl = url || GATEWAY_URL;
  debugLog(`Connecting to gateway: ${gatewayUrl}`);

  ws = new WebSocket(gatewayUrl);

  ws.onopen = () => {
    debugLog("Gateway WebSocket opened");
  };

  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as GatewayPayload;
      handleGatewayPayload(token, payload);
    } catch (err) {
      console.error(`[Discord] Failed to parse gateway payload: ${err}`);
    }
  };

  ws.onclose = (event) => {
    debugLog(`Gateway closed: code=${event.code} reason=${event.reason}`);
    stopHeartbeat();
    if (!running) return;

    // Fatal close codes — do not reconnect
    if (FATAL_CLOSE_CODES.has(event.code)) {
      console.error(`[Discord] Fatal close code ${event.code}: ${event.reason}. Not reconnecting.`);
      return;
    }

    // Attempt resume if we have session state
    const canResume = gatewaySessionId && lastSequence !== null;
    if (canResume) {
      debugLog("Attempting resume...");
      setTimeout(() => connectGateway(token, resumeGatewayUrl || undefined), 1000 + Math.random() * 2000);
    } else {
      // Full reconnect
      gatewaySessionId = null;
      lastSequence = null;
      resumeGatewayUrl = null;
      setTimeout(() => connectGateway(token), 3000 + Math.random() * 4000);
    }
  };

  ws.onerror = () => {
    // onclose will fire after onerror, reconnection handled there
  };
}

// --- Exports ---

/** Send a message to a specific channel (used by heartbeat forwarding) */
export { sendMessage, sendMessageToUser };

/** Stop gateway connection and clear runtime state (used for token rotation/hot reload). */
export function stopGateway(): void {
  running = false;
  stopHeartbeat();
  if (ws) {
    try {
      ws.close(1000, "Gateway stop requested");
    } catch {
      // best-effort
    }
    ws = null;
  }
  resetGatewayState();
}

process.on("SIGTERM", () => {
  stopGateway();
});
process.on("SIGINT", () => {
  stopGateway();
});
process.on("unhandledRejection", (err) => {
  console.error("[Discord] Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[Discord] Uncaught exception:", err);
  stopGateway();
  process.exit(1);
});

/** Start gateway connection in-process (called by start.ts when token is configured) */
export function startGateway(debug = false): void {
  discordDebug = debug;
  const config = getSettings().discord;
  if (ws) stopGateway();
  running = true;
  console.log("Discord bot started (gateway)");
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
  if (discordDebug) console.log("  Debug: enabled");

  (async () => {
    await ensureProjectClaudeMd();
    connectGateway(config.token);
  })().catch((err) => {
    console.error(`[Discord] Fatal: ${err}`);
  });
}

/** Standalone entry point (bun run src/index.ts discord) */
export async function discord() {
  await loadSettings();
  await ensureProjectClaudeMd();
  const config = getSettings().discord;

  if (!config.token) {
    console.error("Discord token not configured. Set discord.token in .claude/claudeclaw/settings.json");
    process.exit(1);
  }

  console.log("Discord bot started (gateway, standalone)");
  console.log(`  Allowed users: ${config.allowedUserIds.length === 0 ? "all" : config.allowedUserIds.join(", ")}`);
  if (discordDebug) console.log("  Debug: enabled");

  connectGateway(config.token);
  // Keep process alive
  await new Promise(() => {});
}
