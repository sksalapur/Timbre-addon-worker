// @ts-ignore
import { createBitChordAuth } from "./bitchord-addon-auth.mjs";

export interface Env {
  LASTWAVE_URL?: string;
  LASTWAVE_SECRET?: string;
  UPSTREAM_BRIDGE_URL?: string;
  UPSTREAM_QOBUZ_URL?: string;
  RESOLVER_PRIORITY?: string;
  BITCHORD_AUTH_MODE?: string;
  BITCHORD_HOSTS?: string;
}

const DEFAULT_LASTWAVE_URL = "https://lastwaveaddons.clashprojects.qd.je/a/4577b43d1be84f289dc05c9f794a8e992f0a58b99b2db3a49096a77ea22c911e";
const DEFAULT_LASTWAVE_SECRET = "36d96a751b12ee481c281a8a8e64c482d0c1634a22061ab72f40175017818b85";
const DEFAULT_BRIDGE_URL = "https://lossless-bridge.fly.dev/sksalapur";
const DEFAULT_HOSTS = ["timbre-lossless-worker.sksalapur.workers.dev"];

const bitchordAuth = createBitChordAuth({
  hosts: DEFAULT_HOSTS
});

// In-memory Edge Caching
interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}
const searchCache = new Map<string, CacheEntry<any>>();
const SEARCH_CACHE_TTL = 30 * 60 * 1000; // 30 mins

const streamCache = new Map<string, CacheEntry<any>>();
const STREAM_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Title cleaning helper to match BitChord clean query logic
function cleanQuery(query: string): string {
  let cleaned = query
    .replace(/[\(\[\{](?:official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|audio|visualizer|mv|remaster(?:ed)?(?:\s*\d{4})?|video|live)[^\)\]\}]*[\)\]\}]/gi, "")
    .replace(/\b(?:official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|visualizer|mv)\b/gi, "")
    .replace(/[\s\-_|:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || query;
}

// Score tracks so 24-bit 192k / 96k Hi-Res masters rank above 16-bit 44.1k
function qualityScore(track: any): number {
  let bitDepth = Number(track.bitDepth) || 0;
  let sampleRate = Number(track.sampleRate) || 0;
  if (!bitDepth) {
    const q = ((track.quality || "") + " " + (track.audioQuality || "")).toUpperCase();
    if (q.includes("HI_RES") || q.includes("HI-RES") || q.includes("HIRES")) {
      bitDepth = 24;
      sampleRate = sampleRate || 96000;
    } else {
      bitDepth = 16;
      sampleRate = sampleRate || 44100;
    }
  }
  if (!sampleRate) {
    sampleRate = bitDepth > 16 ? 96000 : 44100;
  }
  return bitDepth * 1_000_000 + sampleRate;
}

// HMAC-SHA256 signer using standard WebCrypto API native to Cloudflare Workers
async function getSignedLastWaveHeaders(targetUrl: string, method: string, secretKey: string): Promise<Record<string, string>> {
  const parsed = new URL(targetUrl);
  const path = parsed.pathname;
  const match = path.match(/\/a\/([^/]+)/);
  const token = match ? match[1] : "";
  const ts = Math.floor(Date.now() / 1000).toString();
  const message = `${ts}\n${method.toUpperCase()}\n${path}\n${token}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const hashArray = Array.from(new Uint8Array(sigBuffer));
  const signature = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  return {
    "X-LW-TS": ts,
    "X-LW-Sign": signature,
    "User-Agent": "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 LastWave/1.0",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9"
  };
}

function getManifest(isAuthMode: boolean = false) {
  const base = {
    id: isAuthMode ? "lossless-edge-auth" : "lossless-edge",
    name: isAuthMode ? "Lossless Edge (Auth)" : "Lossless Edge",
    version: "2.1.0",
    description: "High-Performance Parallel Lossless FLAC & DASH Audio Source for BitChord",
    resources: ["search", "stream"],
    allowDownloads: 1,
    checkValidLossless: 0,
    settings: [
      {
        key: "quality",
        type: "select",
        label: "Audio Quality",
        default: "hires",
        options: [
          { value: "hires", label: "Hi-Res Lossless (Up to 24-bit/192kHz FLAC)" },
          { value: "lossless", label: "Lossless (16-bit/44.1kHz FLAC)" },
          { value: "high", label: "High Quality (320 kbps AAC)" }
        ]
      }
    ]
  };

  if (isAuthMode) {
    return { ...base, bitchordAuth: true };
  }
  return base;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = url.origin;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const lastwaveUrl = (env.LASTWAVE_URL || DEFAULT_LASTWAVE_URL).replace(/\/+$/, "");
    const lastwaveSecret = env.LASTWAVE_SECRET || DEFAULT_LASTWAVE_SECRET;
    const bridgeUrl = (env.UPSTREAM_BRIDGE_URL || DEFAULT_BRIDGE_URL).replace(/\/+$/, "");
    const qobuzUrl = (env.UPSTREAM_QOBUZ_URL || "").replace(/\/+$/, "");

    // Dual-Mode Routing:
    // 1. Rooted mode (default): /manifest.json, /search, /stream/:id
    // 2. Auth mode (OnePlus 13 / unrooted): /auth, /auth/manifest.json, /auth/search, /auth/stream/:id
    let normalizedSubPath = path;
    const tokenMatch = path.match(/^\/u\/[a-zA-Z0-9_-]+(\/.*)?$/);
    if (tokenMatch) {
      normalizedSubPath = tokenMatch[1] || "";
    } else if (path.startsWith("/sksalapur")) {
      normalizedSubPath = path.slice("/sksalapur".length) || "";
    }

    let isAuthMode = false;
    if (normalizedSubPath.startsWith("/auth")) {
      isAuthMode = true;
      normalizedSubPath = normalizedSubPath.slice("/auth".length) || "";
    }

    if (normalizedSubPath === "" || normalizedSubPath === "/") {
      normalizedSubPath = "/manifest.json";
    }

    // 1. Manifest Endpoint
    if (normalizedSubPath === "/manifest.json") {
      return new Response(JSON.stringify(getManifest(isAuthMode)), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 2. Health Endpoint
    if (normalizedSubPath === "/health") {
      return new Response(JSON.stringify({ status: "ok", name: "Lossless Edge", version: "2.1.0", authMode: isAuthMode, engine: "parallel" }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 2.5 BitChord Addon Auth Verification: ONLY enforced when isAuthMode is true
    if (isAuthMode) {
      const denied = await bitchordAuth.guard(request);
      if (denied) {
        const resHeaders = new Headers(denied.headers);
        for (const [k, v] of Object.entries(corsHeaders)) {
          resHeaders.set(k, v);
        }
        return new Response(denied.body, { status: denied.status, headers: resHeaders });
      }
    }

    // 3. Parallel Search Endpoint
    if (normalizedSubPath.startsWith("/search")) {
      const rawQuery = url.searchParams.get("q") || "";
      if (!rawQuery.trim()) {
        return new Response(JSON.stringify({ tracks: [] }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const cacheKey = rawQuery.trim().toLowerCase();
      const cached = searchCache.get(cacheKey);
      if (cached && (Date.now() - cached.cachedAt < SEARCH_CACHE_TTL)) {
        return new Response(JSON.stringify({ tracks: cached.data }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const cleaned = cleanQuery(rawQuery);

      // Provider 1: LastWave Native Edge Search
      const searchLastWave = async (term: string): Promise<any[]> => {
        try {
          const targetUrl = `${lastwaveUrl}/search?q=${encodeURIComponent(term)}&quality=27`;
          const headers = await getSignedLastWaveHeaders(targetUrl, "GET", lastwaveSecret);
          const resp = await fetch(targetUrl, { 
            headers,
            signal: AbortSignal.timeout(6000)
          });
          if (!resp.ok) return [];
          const data = await resp.json<any>();
          const rawTracks = data?.tracks || [];
          return rawTracks.map((t: any) => ({
            id: String(t.id),
            title: t.title || "",
            artist: t.artist || t.performerName || "",
            album: t.album || t.albumTitle || "",
            duration: t.duration || 0,
            artworkURL: t.artworkURL || t.cover || "",
            format: "flac",
            audioQuality: "LOSSLESS",
            quality: t.quality || "Hi-Res Lossless",
            bitDepth: t.bitDepth || 24,
            sampleRate: t.sampleRate || 192000,
            _source: "lastwave"
          }));
        } catch (err) {
          return [];
        }
      };

      // Provider 2: Parallel Bridge Resolver (Fly.io)
      const searchBridge = async (term: string): Promise<any[]> => {
        if (!bridgeUrl) return [];
        try {
          const targetUrl = `${bridgeUrl}/search?q=${encodeURIComponent(term)}`;
          const resp = await fetch(targetUrl, {
            headers: { "User-Agent": "Mozilla/5.0 LosslessEdge/2.0" },
            signal: AbortSignal.timeout(6000)
          });
          if (!resp.ok) return [];
          const data = await resp.json<any>();
          const tracks = Array.isArray(data?.tracks) ? data.tracks : [];
          return tracks.map((t: any) => ({ ...t, _source: "bridge" }));
        } catch (err) {
          return [];
        }
      };

      // Provider 3: Optional Direct Qobuz Scraper (if configured and active)
      const searchQobuz = async (term: string): Promise<any[]> => {
        if (!qobuzUrl) return [];
        try {
          const targetUrl = `${qobuzUrl}/api/get-music?q=${encodeURIComponent(term)}&offset=0`;
          const resp = await fetch(targetUrl, {
            headers: { "User-Agent": "Mozilla/5.0 LosslessEdge/2.0" },
            signal: AbortSignal.timeout(5000)
          });
          if (!resp.ok) return [];
          const data = await resp.json<any>();
          const items = data?.data?.tracks?.items || [];
          return items.map((t: any) => ({
            id: `qobuz_${t.id}`,
            title: t.title || "",
            artist: t.performer?.name || "",
            album: t.album?.title || "",
            duration: t.duration || 0,
            artworkURL: t.album?.image?.large || t.album?.image?.small || "",
            format: "flac",
            audioQuality: "LOSSLESS",
            quality: "Lossless",
            bitDepth: t.maximum_bit_depth || 16,
            sampleRate: t.maximum_sampling_rate ? Math.round(t.maximum_sampling_rate * 1000) : 44100,
            _source: "qobuz"
          }));
        } catch (err) {
          return [];
        }
      };

      // Parallel Execution across all active providers via Promise.allSettled
      const [lwRes, bridgeRes, qobuzRes] = await Promise.allSettled([
        searchLastWave(cleaned),
        searchBridge(cleaned),
        searchQobuz(cleaned)
      ]);

      let allTracks: any[] = [];
      if (lwRes.status === "fulfilled") allTracks.push(...lwRes.value);
      if (bridgeRes.status === "fulfilled") allTracks.push(...bridgeRes.value);
      if (qobuzRes.status === "fulfilled") allTracks.push(...qobuzRes.value);

      // Fallback search with raw query if cleaned returned 0 results
      if (allTracks.length === 0 && cleaned !== rawQuery) {
        const [lwRaw, bridgeRaw] = await Promise.allSettled([
          searchLastWave(rawQuery),
          searchBridge(rawQuery)
        ]);
        if (lwRaw.status === "fulfilled") allTracks.push(...lwRaw.value);
        if (bridgeRaw.status === "fulfilled") allTracks.push(...bridgeRaw.value);
      }

      // De-duplicate tracks by normalized ID and title+artist
      const seenIds = new Set<string>();
      const seenTitles = new Set<string>();
      const deduped: any[] = [];

      for (const t of allTracks) {
        const idKey = String(t.id);
        const titleKey = `${(t.title || "").toLowerCase().trim()}|${(t.artist || "").toLowerCase().trim()}`;
        if (!seenIds.has(idKey) && !seenTitles.has(titleKey)) {
          seenIds.add(idKey);
          seenTitles.add(titleKey);
          deduped.push(t);
        }
      }

      // Quality scoring rank: 24-bit 192kHz/96kHz Hi-Res FLAC ranks first
      deduped.sort((a, b) => qualityScore(b) - qualityScore(a));

      searchCache.set(cacheKey, { data: deduped, cachedAt: Date.now() });
      return new Response(JSON.stringify({ tracks: deduped }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 4. Parallel Stream Resolution Endpoint
    const streamMatch = normalizedSubPath.match(/^\/stream\/(.+)$/);
    if (streamMatch) {
      const trackId = streamMatch[1];
      const cachedStream = streamCache.get(trackId);
      if (cachedStream && (Date.now() - cachedStream.cachedAt < STREAM_CACHE_TTL)) {
        return new Response(JSON.stringify(cachedStream.data), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // Targeted resolution based on track origin
      const isQobuz = trackId.startsWith("qobuz_");

      // Try Primary: LastWave (or Qobuz if prefix matches)
      if (!isQobuz) {
        try {
          const streamUrl = `${lastwaveUrl}/stream/${encodeURIComponent(trackId)}?quality=27`;
          const headers = await getSignedLastWaveHeaders(streamUrl, "GET", lastwaveSecret);
          const resp = await fetch(streamUrl, { 
            headers,
            signal: AbortSignal.timeout(6000)
          });
          if (resp.ok) {
            const data = await resp.json<any>();
            if (data?.url) {
              const responsePayload = {
                url: data.url,
                format: data.format || "dash",
                codec: data.codec || "flac",
                container: data.container || "mp4",
                manifest: data.manifest || "dash",
                encrypted: false,
                quality: data.quality || "Hi-Res Lossless",
                audioQuality: "LOSSLESS",
                bitDepth: data.bitDepth || 24,
                sampleRate: data.sampleRate || 192000,
                bitrate: data.bitrate || 6022495
              };
              streamCache.set(trackId, { data: responsePayload, cachedAt: Date.now() });
              return new Response(JSON.stringify(responsePayload), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }
          }
        } catch (err) {
          // Fall through to bridge
        }
      }

      // Parallel Fallback: Query Parallel-Lossless-Edge (Fly.io)
      if (bridgeUrl) {
        try {
          const bridgeStream = `${bridgeUrl}/stream/${encodeURIComponent(trackId)}`;
          const bResp = await fetch(bridgeStream, { 
            headers: { "User-Agent": "Mozilla/5.0 LosslessEdge/2.0" },
            signal: AbortSignal.timeout(6000)
          });
          if (bResp.ok) {
            const bData = await bResp.json<any>();
            if (bData?.url) {
              streamCache.set(trackId, { data: bData, cachedAt: Date.now() });
              return new Response(JSON.stringify(bData), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
              });
            }
          }
        } catch (bErr) {
          // Fall through to 404
        }
      }

      return new Response(JSON.stringify({ error: "Stream unavailable from lossless provider" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 5. Landing / Information Page
    const personalUrl = `${origin}/sksalapur`;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Lossless Edge</title>
  <style>
    body { background: #0b0f19; color: #e2e8f0; font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 32px; border-radius: 16px; border: 1px solid #334155; max-width: 500px; width: 90%; text-align: center; }
    h1 { color: #38bdf8; margin: 12px 0; }
    .url-box { background: #0f172a; padding: 12px; border-radius: 8px; font-family: monospace; word-break: break-all; color: #a5f3fc; border: 1px solid #1e293b; margin: 16px 0; }
    .badge { display: inline-block; background: #0284c7; color: white; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: bold; letter-spacing: 0.5px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">PARALLEL LOSSLESS ENGINE</div>
    <h1>Lossless Edge</h1>
    <p>High-Performance Multi-Resolver 24-bit 192kHz FLAC streaming for BitChord.</p>
    <div class="url-box">${personalUrl}</div>
    <p style="color: #94a3b8; font-size: 14px;">Add to BitChord &rarr; Settings &rarr; Sources &rarr; Add Custom Addon.</p>
  </div>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders }
    });
  }
};
