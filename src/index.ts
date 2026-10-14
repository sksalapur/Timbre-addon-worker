export interface Env {
  DB?: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  DAILY_LIMIT?: string;
  BOT_USERNAME?: string;
  UPSTREAM_SEARCH_URL?: string;
  UPSTREAM_DOWNLOAD_URL?: string;
  UPSTREAM_BRIDGE_URL?: string;
  SETUP_SECRET?: string;
}

interface UserRecord {
  telegram_id: number;
  username: string;
  first_name: string;
  token: string;
  created_at: number;
}

// Memory fallbacks for local dev without D1
const memUsersByTgId = new Map<number, UserRecord>();
const memUsersByToken = new Map<string, UserRecord>();
const memDailyStreams = new Map<string, number>();

// In-memory Edge Caching for ultra-low latency (<50ms)
interface CachedUser {
  user: UserRecord;
  cachedAt: number;
}
const tokenCache = new Map<string, CachedUser>();
const TOKEN_CACHE_TTL = 15 * 60 * 1000; // 15 mins

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}
const searchCache = new Map<string, CacheEntry<any>>();
const SEARCH_CACHE_TTL = 15 * 60 * 1000; // 15 mins

const streamCache = new Map<string, CacheEntry<any>>();
const STREAM_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Title cleaning helper to match Lossless Bridge clean query logic
function cleanQuery(query: string): string {
  let cleaned = query
    .replace(/[\(\[\{](?:official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|audio|visualizer|mv|remaster(?:ed)?(?:\s*\d{4})?|video|live)[^\)\]\}]*[\)\]\}]/gi, "")
    .replace(/\b(?:official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|visualizer|mv)\b/gi, "")
    .replace(/[\s\-_|:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || query;
}

function getTodayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function getTimeUntilReset(): { hours: number; minutes: number } {
  const now = new Date();
  const hours = 23 - now.getUTCHours();
  const minutes = 59 - now.getUTCMinutes();
  return { hours, minutes };
}

function generateSecureToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

async function getUserByTelegramId(env: Env, telegramId: number): Promise<UserRecord | null> {
  if (env.DB) {
    try {
      const res = await env.DB.prepare("SELECT telegram_id, username, first_name, token, created_at FROM users WHERE telegram_id = ?")
        .bind(telegramId)
        .first<UserRecord>();
      return res || null;
    } catch (e) {
      console.error("D1 getUserByTelegramId error:", e);
    }
  }
  return memUsersByTgId.get(telegramId) || null;
}

async function getUserByToken(env: Env, token: string): Promise<UserRecord | null> {
  const cached = tokenCache.get(token);
  if (cached && (Date.now() - cached.cachedAt < TOKEN_CACHE_TTL)) {
    return cached.user;
  }

  if (env.DB) {
    try {
      const res = await env.DB.prepare("SELECT telegram_id, username, first_name, token, created_at FROM users WHERE token = ?")
        .bind(token)
        .first<UserRecord>();
      if (res) {
        tokenCache.set(token, { user: res, cachedAt: Date.now() });
        return res;
      }
    } catch (e) {
      console.error("D1 getUserByToken error:", e);
    }
  }

  const fallback = memUsersByToken.get(token) || null;
  if (fallback) {
    tokenCache.set(token, { user: fallback, cachedAt: Date.now() });
  }
  return fallback;
}

async function saveUser(env: Env, user: UserRecord): Promise<void> {
  if (env.DB) {
    try {
      await env.DB.prepare(
        "INSERT INTO users (telegram_id, username, first_name, token, created_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, token = excluded.token"
      ).bind(user.telegram_id, user.username, user.first_name, user.token, user.created_at).run();
      return;
    } catch (e) {
      console.error("D1 saveUser error:", e);
    }
  }
  memUsersByTgId.set(user.telegram_id, user);
  memUsersByToken.set(user.token, user);
  tokenCache.set(user.token, { user, cachedAt: Date.now() });
}

async function getStreamCount(env: Env, token: string, date: string): Promise<number> {
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT count FROM stream_logs WHERE token = ? AND date = ?")
        .bind(token, date)
        .first<{ count: number }>();
      return row?.count ?? 0;
    } catch (e) {
      console.error("D1 getStreamCount error:", e);
    }
  }
  return memDailyStreams.get(`${token}:${date}`) ?? 0;
}

async function incrementStreamCount(env: Env, token: string, date: string): Promise<number> {
  if (env.DB) {
    try {
      await env.DB.prepare(
        "INSERT INTO stream_logs (token, date, count) VALUES (?, ?, 1) " +
        "ON CONFLICT(token, date) DO UPDATE SET count = count + 1"
      ).bind(token, date).run();
      const updated = await env.DB.prepare("SELECT count FROM stream_logs WHERE token = ? AND date = ?")
        .bind(token, date)
        .first<{ count: number }>();
      return updated?.count ?? 1;
    } catch (e) {
      console.error("D1 incrementStreamCount error:", e);
    }
  }
  const key = `${token}:${date}`;
  const curr = (memDailyStreams.get(key) ?? 0) + 1;
  memDailyStreams.set(key, curr);
  return curr;
}

// Telegram Bot API helpers
async function sendTelegram(botToken: string, method: string, payload: any): Promise<any> {
  const cleanToken = botToken.trim();
  const url = `https://api.telegram.org/bot${cleanToken}/${method}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await resp.text();
    try {
      return JSON.parse(raw);
    } catch {
      console.error("Non-JSON from Telegram:", raw);
      return { ok: false, description: raw };
    }
  } catch (err) {
    console.error(`Telegram ${method} fetch error:`, err);
    return { ok: false, error: err };
  }
}

function makeStartMessage(addonUrl: string, limit: number): { text: string; reply_markup: any } {
  const text =
`🎵 *Welcome to Timbre Hi-Res Lossless!*

Your private, authenticated FLAC stream URL has been generated:

\`${addonUrl}\`
_(Tap the URL above to copy)_

━━━━━━━━━━━━━━━━━━━━
📱 *How to Add to Timbre:*
1. Open **Timbre** on your device.
2. Go to **Settings** ➔ **Sources** ➔ **Add Source** ➔ **Custom Addon**.
3. Paste your private URL above and tap **Save**.

⚡ *Features & Quota:*
• 🎧 **Studio-Quality 24-bit / 96–192kHz FLAC**
• 📊 Quota: *${limit} streams / day*
• 🔄 Resets daily at *00:00 UTC*
• 🔒 Fully private in-bot dashboard — zero web browser login required!`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "📊 Check Usage / Quota", callback_data: "check_quota" },
        { text: "🔗 My Addon URL", callback_data: "get_url" }
      ],
      [
        { text: "🔄 Reset URL", callback_data: "reset_url" },
        { text: "📖 Community Group", url: "https://t.me/Timbre_Community" }
      ]
    ]
  };

  return { text, reply_markup };
}

function makeQuotaMessage(used: number, limit: number, addonUrl: string): { text: string; reply_markup: any } {
  const remaining = Math.max(0, limit - used);
  const { hours, minutes } = getTimeUntilReset();
  const percentage = Math.min(100, Math.round((used / limit) * 100));

  const totalBars = 10;
  const filledBars = Math.min(totalBars, Math.round((used / limit) * totalBars));
  const emptyBars = totalBars - filledBars;
  const progressBar = "▓".repeat(filledBars) + "░".repeat(emptyBars);

  const text =
`📊 *Timbre Stream Quota Status*

Usage: [${progressBar}] *${percentage}%*

• 🎧 Streams today: *${used} / ${limit}*
• ⏳ Remaining: *${remaining} songs*
• 🔄 Daily reset in: *${hours}h ${minutes}m* (at 00:00 UTC)

━━━━━━━━━━━━━━━━━━━━
🔗 *Your Private Addon URL:*
\`${addonUrl}\`
_(Tap to copy)_`;

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "🔄 Refresh Status", callback_data: "check_quota" },
        { text: "🔄 Regenerate URL", callback_data: "reset_url" }
      ],
      [
        { text: "📖 Community Group", url: "https://t.me/Timbre_Community" }
      ]
    ]
  };

  return { text, reply_markup };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = url.origin;
    const limit = parseInt(env.DAILY_LIMIT || "250", 10);
    const botToken = (env.TELEGRAM_BOT_TOKEN || "").trim();

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Webhook Setup Helper
    if (path === "/setup-webhook") {
      if (!botToken) {
        return new Response(JSON.stringify({ error: "TELEGRAM_BOT_TOKEN is not configured" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
      const webhookUrl = `${origin}/webhook`;
      const tgRes = await sendTelegram(botToken, "setWebhook", { url: webhookUrl });
      return new Response(JSON.stringify({ webhookUrl, telegram: tgRes }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // Telegram Bot Webhook
    if (path === "/webhook" && request.method === "POST") {
      if (!botToken) {
        return new Response("Bot token not set", { status: 500 });
      }

      try {
        const raw = await request.text();
        if (!raw.trim()) return new Response("OK");
        let update: any;
        try {
          update = JSON.parse(raw);
        } catch (e) {
          console.error("JSON parse error:", e, "raw:", raw);
          return new Response("OK");
        }

        if (update.message) {
          const msg = update.message;
          const chatId = msg.chat?.id;
          const text = (msg.text || "").trim();
          const from = msg.from;

          if (!chatId || !from) {
            return new Response("OK");
          }

          if (text === "/start" || text.startsWith("/start ") || text === "/login") {
            let user = await getUserByTelegramId(env, from.id);
            if (!user) {
              const token = generateSecureToken();
              user = {
                telegram_id: from.id,
                username: from.username || "",
                first_name: from.first_name || "",
                token,
                created_at: Date.now()
              };
              await saveUser(env, user);
            }

            const addonUrl = `${origin}/u/${user.token}`;
            const { text: msgText, reply_markup } = makeStartMessage(addonUrl, limit);
            await sendTelegram(botToken, "sendMessage", {
              chat_id: chatId,
              text: msgText,
              parse_mode: "Markdown",
              reply_markup
            });
            return new Response("OK");
          }

          if (text === "/quota" || text === "/status") {
            let user = await getUserByTelegramId(env, from.id);
            if (!user) {
              await sendTelegram(botToken, "sendMessage", {
                chat_id: chatId,
                text: "⚠️ You are not registered yet. Please send /start to get your private Addon URL.",
                parse_mode: "Markdown"
              });
              return new Response("OK");
            }

            const today = getTodayUTC();
            const used = await getStreamCount(env, user.token, today);
            const addonUrl = `${origin}/u/${user.token}`;
            const { text: msgText, reply_markup } = makeQuotaMessage(used, limit, addonUrl);
            await sendTelegram(botToken, "sendMessage", {
              chat_id: chatId,
              text: msgText,
              parse_mode: "Markdown",
              reply_markup
            });
            return new Response("OK");
          }

          if (text === "/reset" || text === "/regenerate") {
            const newToken = generateSecureToken();
            const user: UserRecord = {
              telegram_id: from.id,
              username: from.username || "",
              first_name: from.first_name || "",
              token: newToken,
              created_at: Date.now()
            };
            await saveUser(env, user);

            const newUrl = `${origin}/u/${newToken}`;
            await sendTelegram(botToken, "sendMessage", {
              chat_id: chatId,
              text: 
`🔄 *Your Addon URL Has Been Regenerated!*

Your previous URL is now revoked. Here is your new private URL:

\`${newUrl}\`
_(Tap to copy)_

Please update this URL in **Timbre** ➔ **Settings** ➔ **Sources**.`,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "📊 Check Usage / Quota", callback_data: "check_quota" }]
                ]
              }
            });
            return new Response("OK");
          }

          if (text === "/help") {
            await sendTelegram(botToken, "sendMessage", {
              chat_id: chatId,
              text:
`📖 *Timbre Lossless Bot Commands:*

• /start — Get your private Addon URL and setup instructions
• /quota — View today's stream consumption and remaining songs
• /reset — Revoke your token and generate a new private URL
• /help — Show this help message

For full setup documentation, visit https://sksalapur.github.io/Timbre/`,
              parse_mode: "Markdown"
            });
            return new Response("OK");
          }
        }

        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = cb.message?.chat?.id;
          const messageId = cb.message?.message_id;
          const from = cb.from;
          const data = cb.data;

          if (chatId && from) {
            let user = await getUserByTelegramId(env, from.id);
            if (!user) {
              await sendTelegram(botToken, "answerCallbackQuery", {
                callback_query_id: cb.id,
                text: "Please send /start first!",
                show_alert: true
              });
              return new Response("OK");
            }

            if (data === "check_quota") {
              const today = getTodayUTC();
              const used = await getStreamCount(env, user.token, today);
              const addonUrl = `${origin}/u/${user.token}`;
              const { text: msgText, reply_markup } = makeQuotaMessage(used, limit, addonUrl);
              
              if (messageId) {
                await sendTelegram(botToken, "editMessageText", {
                  chat_id: chatId,
                  message_id: messageId,
                  text: msgText,
                  parse_mode: "Markdown",
                  reply_markup
                });
              }
              await sendTelegram(botToken, "answerCallbackQuery", {
                callback_query_id: cb.id,
                text: `Streams used today: ${used}/${limit}`
              });
              return new Response("OK");
            }

            if (data === "get_url") {
              const addonUrl = `${origin}/u/${user.token}`;
              await sendTelegram(botToken, "answerCallbackQuery", {
                callback_query_id: cb.id
              });
              await sendTelegram(botToken, "sendMessage", {
                chat_id: chatId,
                text: `🔗 *Your Private Addon URL:*\n\n\`${addonUrl}\`\n\n_(Tap to copy)_`,
                parse_mode: "Markdown"
              });
              return new Response("OK");
            }

            if (data === "reset_url") {
              const newToken = generateSecureToken();
              user = {
                ...user,
                token: newToken
              };
              await saveUser(env, user);
              const newUrl = `${origin}/u/${newToken}`;

              await sendTelegram(botToken, "answerCallbackQuery", {
                callback_query_id: cb.id,
                text: "New URL generated!"
              });
              await sendTelegram(botToken, "sendMessage", {
                chat_id: chatId,
                text:
`🔄 *Addon URL Regenerated!*

New Private URL:
\`${newUrl}\`
_(Tap to copy)_

Make sure to replace this in Timbre ➔ Settings ➔ Sources.`,
                parse_mode: "Markdown"
              });
              return new Response("OK");
            }
          }
        }

        return new Response("OK");
      } catch (err: any) {
        console.error("Webhook error:", err);
        return new Response(`Internal error: ${err?.message || err}\nStack: ${err?.stack || ''}`, { status: 500 });
      }
    }

    // Timbre Addon Endpoints
    const userMatch = path.match(/^\/u\/([a-zA-Z0-9_-]+)(\/.*)?$/);
    if (userMatch) {
      const token = userMatch[1];
      const subPath = userMatch[2] || "";

      const user = await getUserByToken(env, token);
      if (!user) {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid or revoked private token" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // Manifest
      if (subPath === "/manifest.json" || subPath === "") {
        const manifest = {
          id: "timbre-lossless",
          name: "Timbre Cloudflare Edge (FLAC)",
          version: "1.8.0",
          description: "Studio Hi-Res Lossless 24-bit FLAC streams for Timbre",
          resources: ["search", "stream"],
          settings: [
            {
              key: "quality",
              default: "LOSSLESS",
              options: [
                { value: "LOSSLESS" },
                { value: "HIGH" },
                { value: "LOW" }
              ]
            }
          ],
          allowDownloads: true,
          checkValidLossless: false
        };
        return new Response(JSON.stringify(manifest), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // Search (with in-memory cache and cleanQuery title normalization)
      if (subPath.startsWith("/search")) {
        const query = url.searchParams.get("q") || "";
        if (!query.trim()) {
          return new Response(JSON.stringify({ tracks: [] }), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const cacheKey = query.trim().toLowerCase();
        const cachedSearch = searchCache.get(cacheKey);
        if (cachedSearch && (Date.now() - cachedSearch.cachedAt < SEARCH_CACHE_TTL)) {
          return new Response(JSON.stringify({ tracks: cachedSearch.data }), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const cleaned = cleanQuery(query);
        const upstreamSearch = env.UPSTREAM_SEARCH_URL || "https://qobuz-dll.foreyou.workers.dev/api/get-music";

        const trySearch = async (searchTerm: string): Promise<any[]> => {
          try {
            const searchReq = await fetch(`${upstreamSearch}?q=${encodeURIComponent(searchTerm)}&offset=0`, {
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
            });
            if (!searchReq.ok) return [];
            const searchData = await searchReq.json<any>();
            const items = searchData?.data?.tracks?.items || [];
            return items.map((item: any) => ({
              id: String(item.id),
              title: item.title || "",
              artist: item.performer?.name || "",
              album: item.album?.title || "",
              duration: item.duration || 0,
              artworkURL: item.album?.image?.large || item.album?.image?.small || "",
              format: "flac",
              audioQuality: "LOSSLESS"
            }));
          } catch (err) {
            console.error(`Search error for '${searchTerm}':`, err);
            return [];
          }
        };

        // 1. Try cleaned query first
        let tracks = await trySearch(cleaned);

        // 2. Fallback to raw query if cleaned had 0 results
        if (tracks.length === 0 && cleaned !== query) {
          tracks = await trySearch(query);
        }

        // 3. Fallback to UPSTREAM_BRIDGE_URL if configured and Vercel/Qobuz failed
        if (tracks.length === 0 && env.UPSTREAM_BRIDGE_URL) {
          try {
            const bridgeUrl = `${env.UPSTREAM_BRIDGE_URL.replace(/\/+$/, "")}/search?q=${encodeURIComponent(cleaned)}`;
            const bReq = await fetch(bridgeUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (bReq.ok) {
              const bData = await bReq.json<any>();
              if (Array.isArray(bData?.tracks)) {
                tracks = bData.tracks;
              }
            }
          } catch (bErr) {
            console.error("Bridge search fallback error:", bErr);
          }
        }

        searchCache.set(cacheKey, { data: tracks, cachedAt: Date.now() });

        return new Response(JSON.stringify({ tracks }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // Stream (with in-memory cache and bridge fallback)
      const streamMatch = subPath.match(/^\/stream\/(.+)$/);
      if (streamMatch) {
        const trackId = streamMatch[1];
        const today = getTodayUTC();

        const currentCount = await getStreamCount(env, token, today);
        if (currentCount >= limit) {
          return new Response(JSON.stringify({
            error: `Daily limit of ${limit} songs reached. Quota resets at 00:00 UTC. Check @${env.BOT_USERNAME || "Timbre_Lossless_Bot"} for status.`
          }), {
            status: 429,
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        const cachedStream = streamCache.get(trackId);
        if (cachedStream && (Date.now() - cachedStream.cachedAt < STREAM_CACHE_TTL)) {
          return new Response(JSON.stringify(cachedStream.data), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }

        await incrementStreamCount(env, token, today);

        const upstreamDownload = env.UPSTREAM_DOWNLOAD_URL || "https://qobuz-dll.foreyou.workers.dev/api/download-music";
        try {
          const dlReq = await fetch(`${upstreamDownload}?track_id=${encodeURIComponent(trackId)}&quality=27`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
          });
          const dlData = await dlReq.json<any>();
          const data = dlData?.data;

          if (data?.url) {
            const responseStream = {
              url: data.url,
              format: "flac",
              quality: "LOSSLESS",
              bitDepth: data.bit_depth || 24,
              sampleRate: data.sampling_rate ? data.sampling_rate * 1000 : 96000,
              codec: "flac"
            };
            streamCache.set(trackId, { data: responseStream, cachedAt: Date.now() });
            return new Response(JSON.stringify(responseStream), {
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
          }
        } catch (err: any) {
          console.error("Primary stream resolution error:", err);
        }

        // Fallback to UPSTREAM_BRIDGE_URL if configured
        if (env.UPSTREAM_BRIDGE_URL) {
          try {
            const bridgeStreamUrl = `${env.UPSTREAM_BRIDGE_URL.replace(/\/+$/, "")}/stream/${encodeURIComponent(trackId)}`;
            const bReq = await fetch(bridgeStreamUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (bReq.ok) {
              const bData = await bReq.json<any>();
              if (bData?.url) {
                streamCache.set(trackId, { data: bData, cachedAt: Date.now() });
                return new Response(JSON.stringify(bData), {
                  headers: { "Content-Type": "application/json", ...corsHeaders }
                });
              }
            }
          } catch (bErr) {
            console.error("Bridge stream fallback error:", bErr);
          }
        }

        return new Response(JSON.stringify({ error: "Stream not available from lossless provider" }), {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // Landing Page
    if (path === "/" || path === "/health") {
      const botName = env.BOT_USERNAME || "Timbre_Lossless_Bot";
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Timbre Lossless FLAC Resolver</title>
  <style>
    body {
      background: #0d1117;
      color: #c9d1d9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 12px;
      padding: 32px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    h1 {
      color: #58a6ff;
      margin-top: 0;
      font-size: 24px;
    }
    p {
      line-height: 1.6;
      color: #8b949e;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      background: rgba(46, 160, 67, 0.2);
      color: #3fb950;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 20px;
    }
    .btn {
      display: inline-block;
      margin-top: 20px;
      padding: 12px 24px;
      border-radius: 8px;
      background: #238636;
      color: #ffffff;
      text-decoration: none;
      font-weight: 600;
      transition: background 0.2s;
    }
    .btn:hover {
      background: #2ea043;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">● Operational</div>
    <h1>Timbre Lossless FLAC Gateway</h1>
    <p>This service provides high-resolution 24-bit FLAC audio streams for Timbre music player users.</p>
    <p>Private authenticated addon endpoints are managed directly within Telegram — zero browser dashboard required.</p>
    <a href="https://t.me/${botName}" class="btn" target="_blank">Open Telegram Bot (@${botName})</a>
  </div>
</body>
</html>`;
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders }
      });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};
