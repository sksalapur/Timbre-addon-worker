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
const MONOCHROME_TRACKS_URL = "https://tracks.monochrome.st";
const TIDAL_WEB_TOKEN = "txNoH4kkV41MfH25";
const DEFAULT_HOSTS = ["timbre-lossless-worker.sksalapur.workers.dev"];

const bitchordAuth = createBitChordAuth({
  hosts: DEFAULT_HOSTS
});

interface CacheEntry<T> {
  data: T;
  cachedAt: number;
}

interface TrackMeta {
  title: string;
  artist: string;
  album?: string;
  duration: number;
  isrc?: string;
  monoId?: string;
}

const MAX_CACHE_ENTRIES = 512;
const SEARCH_CACHE_TTL = 30 * 60 * 1000; // 30 mins
const STREAM_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const LASTWAVE_COOLDOWN_MS = 3 * 60 * 1000; // 3 mins backoff when quota/pranks trigger repeatedly

const searchCache = new Map<string, CacheEntry<any[]>>();
const streamCache = new Map<string, CacheEntry<any>>();
const trackMetaCache = new Map<string, TrackMeta>();

let lastwavePrankStreak = 0;
let lastwaveCooldownUntil = 0;

function setBounded<T>(map: Map<string, T>, key: string, value: T, maxSize: number = MAX_CACHE_ENTRIES): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function cleanQuery(query: string): string {
  const cleaned = query
    .replace(/[\(\[\{](?:official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|audio|visualizer|mv|remaster(?:ed)?(?:\s*\d{4})?|video|live)[^\)\]\}]*[\)\]\}]/gi, "")
    .replace(/\b(?:official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|visualizer|mv)\b/gi, "")
    .replace(/[\s\-_|:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || query.trim();
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(?:feat|featuring|ft)\.?\b/gi, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter(w => w.length >= 3);
}

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
  // Prefer direct native FLAC on equal resolution ties
  const directBonus = track._source === "monochrome" ? 1 : 0;
  return (bitDepth * 1_000_000 + sampleRate) * 10 + directBonus;
}

const PRANK_URL_PATTERNS = [
  "pranks-cdn",
  "definatelynagato",
  "gemi2",
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
  "/prank",
  "rickroll"
];

const LOSSY_EXTENSIONS = [".mp3", ".ogg", ".opus", ".webm", ".aac"];

function isSuspectPrankUrl(streamUrl: unknown): boolean {
  if (typeof streamUrl !== "string" || !streamUrl.startsWith("https://")) {
    return true;
  }
  const lower = streamUrl.toLowerCase();
  if (PRANK_URL_PATTERNS.some(pat => lower.includes(pat))) {
    return true;
  }
  try {
    const pathname = new URL(streamUrl).pathname.toLowerCase();
    if (LOSSY_EXTENSIONS.some(ext => pathname.endsWith(ext))) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

function indexOfBytes(haystack: Uint8Array, needle: string): number {
  const len = needle.length;
  outer: for (let i = 0; i <= haystack.length - len; i++) {
    for (let j = 0; j < len; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

async function readHeadBytes(resp: Response, maxBytes: number = 2048): Promise<Uint8Array> {
  if (!resp.body) return new Uint8Array(0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const needed = Math.min(value.byteLength, maxBytes - total);
      chunks.push(value.subarray(0, needed));
      total += needed;
      if (total >= maxBytes) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancel errors on already-closed streams
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

function parseTotalBytes(headers: Headers, status: number): number {
  const cr = headers.get("Content-Range");
  if (cr) {
    const match = cr.match(/\/(\d+)\s*$/);
    if (match) return Number(match[1]) || 0;
  }
  if (status === 200) {
    const cl = headers.get("Content-Length");
    if (cl) return Number(cl) || 0;
  }
  return 0;
}

function passesDurationSizeSanity(totalBytes: number, durationSec: number): boolean {
  if (!totalBytes) return true;
  if (totalBytes < 400_000) return false;
  // Pranks are typically 30-34s lossy snippets (< ~1.5 MB); require >= ~96 kbps when duration is known
  if (durationSec >= 60 && totalBytes < durationSec * 12_000) return false;
  return true;
}

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
  const signature = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    "X-LW-TS": ts,
    "X-LW-Sign": signature,
    "User-Agent": "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 LastWave/1.0",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9"
  };
}

// Verify stream payload against actual upstream content before returning to BitChord so pranks/lossy MP4s never pass.
async function verifyAndNormalizeStream(
  rawStream: any,
  lastwaveUrl: string,
  lastwaveSecret: string,
  durationHintSec: number = 0
): Promise<any | null> {
  const streamUrl = rawStream?.url;
  if (isSuspectPrankUrl(streamUrl)) return null;

  let pathname = "";
  let hostname = "";
  try {
    const parsed = new URL(streamUrl);
    pathname = parsed.pathname.toLowerCase();
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }

  let lwHost = "";
  try {
    lwHost = new URL(lastwaveUrl).hostname.toLowerCase();
  } catch {
    // Ignore malformed optional env URL
  }

  const isDash =
    rawStream?.format === "dash" ||
    rawStream?.manifest === "dash" ||
    pathname.endsWith(".mpd");

  const isLastWaveMedia = Boolean(lwHost && hostname === lwHost);

  if (isDash) {
    // Pranks returned by LastWave often arrive as .m4a/.mp4 or extensionless CDN paths; never label non-MPD as DASH blindly
    if (pathname.endsWith(".m4a") || pathname.endsWith(".mp4")) {
      return null;
    }
    try {
      const headers = isLastWaveMedia
        ? await getSignedLastWaveHeaders(streamUrl, "GET", lastwaveSecret)
        : { "User-Agent": "Mozilla/5.0 LosslessEdge/2.2", "Accept": "*/*" };

      const resp = await fetch(streamUrl, {
        headers,
        signal: AbortSignal.timeout(4500)
      });
      if (!resp.ok || isSuspectPrankUrl(resp.url || streamUrl)) return null;

      const text = await resp.text();
      const lowerText = text.toLowerCase();
      if (!lowerText.includes("<mpd") || PRANK_URL_PATTERNS.some(p => lowerText.includes(p))) {
        return null;
      }

      const bitDepth = Number(rawStream.bitDepth) || 24;
      const sampleRate = Number(rawStream.sampleRate) || 48000;
      const isHiRes = bitDepth > 16 || sampleRate > 48000;
      return {
        url: streamUrl,
        format: "dash",
        codec: rawStream.codec || "flac",
        container: rawStream.container || "mp4",
        manifest: "dash",
        encrypted: false,
        quality: rawStream.quality || (isHiRes ? "Hi-Res Lossless" : "Lossless"),
        audioQuality: "LOSSLESS",
        bitDepth,
        sampleRate,
        bitrate: Number(rawStream.bitrate) || (bitDepth * sampleRate * 2)
      };
    } catch {
      return null;
    }
  }

  // Direct audio file probe via Range request (checks FLAC fLaC / MP4 ALAC/FLAC boxes)
  try {
    const headers: Record<string, string> = isLastWaveMedia
      ? await getSignedLastWaveHeaders(streamUrl, "GET", lastwaveSecret)
      : { "User-Agent": "Mozilla/5.0 LosslessEdge/2.2", "Accept": "*/*" };
    headers["Range"] = "bytes=0-2047";

    const resp = await fetch(streamUrl, {
      headers,
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok || isSuspectPrankUrl(resp.url || streamUrl)) {
      await resp.body?.cancel();
      return null;
    }

    const totalBytes = parseTotalBytes(resp.headers, resp.status);
    const head = await readHeadBytes(resp, 2048);
    if (head.byteLength < 12) return null;

    // 1. Native FLAC signature ("fLaC")
    if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
      if (!passesDurationSizeSanity(totalBytes, durationHintSec)) return null;

      let sampleRate = Number(rawStream.sampleRate) || 44100;
      let bitDepth = Number(rawStream.bitDepth) || 16;
      if (head.byteLength >= 22 && (head[4] & 0x7f) === 0) {
        const parsedRate = (head[18] << 12) | (head[19] << 4) | (head[20] >> 4);
        const parsedDepth = (((head[20] & 0x01) << 4) | (head[21] >> 4)) + 1;
        if (parsedRate >= 8000 && parsedRate <= 384000) sampleRate = parsedRate;
        if (parsedDepth >= 8 && parsedDepth <= 32) bitDepth = parsedDepth;
      }

      const isHiRes = bitDepth > 16 || sampleRate > 48000;
      const computedBitrate =
        durationHintSec > 0 && totalBytes > 0
          ? Math.round((totalBytes * 8) / durationHintSec)
          : Number(rawStream.bitrate) || bitDepth * sampleRate * 2;

      return {
        url: streamUrl,
        format: "flac",
        codec: "flac",
        container: "flac",
        manifest: "none",
        encrypted: false,
        quality: isHiRes ? "Hi-Res Lossless" : "Lossless",
        audioQuality: "LOSSLESS",
        bitDepth,
        sampleRate,
        bitrate: computedBitrate
      };
    }

    // 2. ISO BMFF / MP4 container ("ftyp"): accept ONLY if fLaC or alac codec box is present (reject mp4a/AAC/video)
    if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
      const hasFlacBox = indexOfBytes(head, "fLaC") !== -1 || indexOfBytes(head, "dfLa") !== -1;
      const hasAlacBox = indexOfBytes(head, "alac") !== -1;
      if (!hasFlacBox && !hasAlacBox) return null;
      if (!passesDurationSizeSanity(totalBytes, durationHintSec)) return null;

      const codec = hasFlacBox ? "flac" : "alac";
      const bitDepth = Number(rawStream.bitDepth) || 16;
      const sampleRate = Number(rawStream.sampleRate) || 44100;
      const isHiRes = bitDepth > 16 || sampleRate > 48000;
      const computedBitrate =
        durationHintSec > 0 && totalBytes > 0
          ? Math.round((totalBytes * 8) / durationHintSec)
          : Number(rawStream.bitrate) || bitDepth * sampleRate * 2;

      return {
        url: streamUrl,
        format: "mp4",
        codec,
        container: rawStream.container || "m4a",
        manifest: "none",
        encrypted: false,
        quality: isHiRes ? "Hi-Res Lossless" : "Lossless",
        audioQuality: "LOSSLESS",
        bitDepth,
        sampleRate,
        bitrate: computedBitrate
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function searchMonochrome(term: string, limit: number = 10): Promise<any[]> {
  try {
    const cleaned = normalizeText(term) || term.trim();
    if (!cleaned) return [];

    const targetUrl = `${MONOCHROME_TRACKS_URL}/search/tracks?q=${encodeURIComponent(cleaned)}&limit=${limit}`;
    const resp = await fetch(targetUrl, {
      headers: { "User-Agent": "Mozilla/5.0 LosslessEdge/2.2", "Accept": "application/json" },
      signal: AbortSignal.timeout(5500)
    });
    if (!resp.ok) return [];

    const data = await resp.json<any>();
    const rawTracks: any[] = Array.isArray(data?.tracks) ? data.tracks : [];
    const queryTokens = significantTokens(term);

    const results: any[] = [];
    for (const t of rawTracks) {
      if (t.playable === false) continue;
      const rawId = String(t.trackId || t.id || "");
      if (!rawId) continue;

      const title = String(t.title || "");
      const artist = Array.isArray(t.artistNames)
        ? t.artistNames.join(", ")
        : String(t.artist || "");
      const rawDur = Number(t.duration) || 0;
      const duration = rawDur > 1000 ? Math.round(rawDur / 1000) : Math.round(rawDur);

      // Filter Coda unrelated fuzzy noise when query contains >= 3-char words
      if (queryTokens.length > 0) {
        const hay = normalizeText(`${title} ${artist}`);
        const hasAnyOverlap = queryTokens.some(tok => hay.includes(tok));
        if (!hasAnyOverlap) continue;
      }

      results.push({
        id: `mono_${rawId}`,
        _monoId: rawId,
        title,
        artist,
        album: String(t.albumTitle || ""),
        duration,
        artworkURL: String(t.artwork || t.cover || ""),
        isrc: t.isrc ? String(t.isrc) : "",
        format: "flac",
        audioQuality: "LOSSLESS",
        quality: "Lossless",
        bitDepth: 16,
        sampleRate: 44100,
        _source: "monochrome"
      });
    }
    return results;
  } catch {
    return [];
  }
}

function scoreMonoCandidate(candidate: any, meta: TrackMeta): number {
  if (meta.isrc && candidate.isrc && meta.isrc.toUpperCase() === candidate.isrc.toUpperCase()) {
    return 300;
  }

  let score = 0;
  const cTitle = normalizeText(candidate.title || "");
  const mTitle = normalizeText(meta.title || "");
  const cArtist = normalizeText(candidate.artist || "");
  const mArtist = normalizeText(meta.artist || "");

  if (mTitle && cTitle === mTitle) {
    score += 75;
  } else if (mTitle && (cTitle.includes(mTitle) || mTitle.includes(cTitle))) {
    score += 45;
  } else {
    const mWords = significantTokens(meta.title);
    const hits = mWords.filter(w => cTitle.includes(w)).length;
    if (!mWords.length || hits === 0) return 0;
    score += Math.round((hits / mWords.length) * 40);
  }

  if (mArtist) {
    const artistTokens = significantTokens(meta.artist);
    if (cArtist === mArtist || cArtist.includes(mArtist) || mArtist.includes(cArtist)) {
      score += 50;
    } else if (artistTokens.some(tok => cArtist.includes(tok))) {
      score += 35;
    } else {
      score -= 30;
    }
  }

  if (meta.duration > 0 && candidate.duration > 0) {
    const diff = Math.abs(meta.duration - candidate.duration);
    if (diff <= 5) score += 30;
    else if (diff <= 15) score += 15;
    else if (diff > 30) score -= 60;
  }

  return score;
}

async function fetchTidalTrackMeta(tidalId: string): Promise<TrackMeta | null> {
  if (!/^\d+$/.test(tidalId)) return null;
  try {
    const resp = await fetch(`https://api.tidal.com/v1/tracks/${tidalId}?countryCode=US`, {
      headers: { "x-tidal-token": TIDAL_WEB_TOKEN, "Accept": "application/json" },
      signal: AbortSignal.timeout(4000)
    });
    if (!resp.ok) return null;
    const t = await resp.json<any>();
    const title = String(t?.title || "").trim();
    if (!title) return null;
    const artist = String(
      t?.artist?.name ||
      (Array.isArray(t?.artists) && t.artists[0]?.name) ||
      ""
    ).trim();
    return {
      title,
      artist,
      album: String(t?.album?.title || ""),
      duration: Number(t?.duration) || 0,
      isrc: t?.isrc ? String(t.isrc) : ""
    };
  } catch {
    return null;
  }
}

async function resolveViaMonochromeMeta(
  meta: TrackMeta,
  lastwaveUrl: string,
  lastwaveSecret: string
): Promise<any | null> {
  const queries = [];
  if (meta.artist) queries.push(`${meta.title} ${meta.artist}`);
  if (!queries.includes(meta.title)) queries.push(meta.title);

  const seenIds = new Set<string>();
  const allCandidates: any[] = [];
  for (const q of queries) {
    const hits = await searchMonochrome(q, 8);
    for (const c of hits) {
      if (!seenIds.has(c._monoId)) {
        seenIds.add(c._monoId);
        allCandidates.push(c);
      }
    }
    if (allCandidates.some(c => scoreMonoCandidate(c, meta) >= 120)) break;
  }

  const ranked = allCandidates
    .map(c => ({ candidate: c, score: scoreMonoCandidate(c, meta) }))
    .filter(x => x.score >= 60)
    .sort((a, b) => b.score - a.score);

  for (const { candidate } of ranked.slice(0, 3)) {
    const verified = await verifyAndNormalizeStream(
      { url: `${MONOCHROME_TRACKS_URL}/track/${candidate._monoId}`, format: "flac" },
      lastwaveUrl,
      lastwaveSecret,
      candidate.duration || meta.duration
    );
    if (verified) return verified;
  }
  return null;
}

function getManifest(isAuthMode: boolean = false) {
  const base = {
    id: isAuthMode ? "lossless-edge-auth" : "lossless-edge",
    name: isAuthMode ? "Lossless Edge (Auth)" : "Lossless Edge",
    version: "2.2.0",
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

function findMatchingMono(lwTrack: any, monoTracks: any[]): any | null {
  const lwTitle = normalizeText(lwTrack.title || "");
  const lwArtist = normalizeText(lwTrack.artist || "");
  if (!lwTitle) return null;

  for (const m of monoTracks) {
    const mTitle = normalizeText(m.title || "");
    const mArtist = normalizeText(m.artist || "");
    const titleOk = mTitle === lwTitle || (mTitle.length > 3 && lwTitle.includes(mTitle)) || (lwTitle.length > 3 && mTitle.includes(lwTitle));
    if (!titleOk) continue;
    const artistOk = !lwArtist || !mArtist || mArtist.includes(lwArtist) || lwArtist.includes(mArtist) ||
      significantTokens(lwArtist).some(tok => mArtist.includes(tok));
    if (!artistOk) continue;
    const durDiff = Math.abs((lwTrack.duration || 0) - (m.duration || 0));
    if (!lwTrack.duration || !m.duration || durDiff <= 15) return m;
  }
  return null;
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
      return new Response(JSON.stringify({
        status: "ok",
        name: "Lossless Edge",
        version: "2.2.0",
        authMode: isAuthMode,
        engine: "parallel",
        lastwaveCooldownActive: Date.now() < lastwaveCooldownUntil
      }), {
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

      const lwCoolingDown = Date.now() < lastwaveCooldownUntil;
      const cacheKey = `${rawQuery.trim().toLowerCase()}|lw:${lwCoolingDown ? 0 : 1}`;
      const cached = searchCache.get(cacheKey);
      if (cached && (Date.now() - cached.cachedAt < SEARCH_CACHE_TTL)) {
        return new Response(JSON.stringify({ tracks: cached.data }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const cleaned = cleanQuery(rawQuery);

      const searchLastWave = async (term: string): Promise<any[]> => {
        if (Date.now() < lastwaveCooldownUntil) return [];
        try {
          const targetUrl = `${lastwaveUrl}/search?q=${encodeURIComponent(term)}&quality=27`;
          const headers = await getSignedLastWaveHeaders(targetUrl, "GET", lastwaveSecret);
          const resp = await fetch(targetUrl, {
            headers,
            signal: AbortSignal.timeout(5500)
          });
          if (resp.status === 429) {
            lastwaveCooldownUntil = Date.now() + LASTWAVE_COOLDOWN_MS;
            return [];
          }
          if (!resp.ok) return [];
          const data = await resp.json<any>();
          const rawTracks = Array.isArray(data?.tracks) ? data.tracks : [];
          return rawTracks
            .filter((t: any) => !String(t?.id || "").startsWith("swap_"))
            .map((t: any) => {
            const qStr = `${t.quality || ""} ${t.audioQuality || ""}`.toUpperCase();
            const isHiRes = qStr.includes("HI_RES") || qStr.includes("HI-RES") || qStr.includes("HIRES") || Number(t.bitDepth) > 16;
            const bitDepth = Number(t.bitDepth) || (isHiRes ? 24 : 16);
            const sampleRate = Number(t.sampleRate) || (isHiRes ? 96000 : 44100);
            return {
              id: String(t.id),
              title: t.title || "",
              artist: t.artist || t.performerName || "",
              album: t.album || t.albumTitle || "",
              duration: Number(t.duration) || 0,
              artworkURL: t.artworkURL || t.cover || "",
              format: "flac",
              audioQuality: "LOSSLESS",
              quality: isHiRes ? "Hi-Res Lossless" : "Lossless",
              bitDepth,
              sampleRate,
              _source: "lastwave"
            };
          });
        } catch {
          return [];
        }
      };

      const searchQobuz = async (term: string): Promise<any[]> => {
        if (!qobuzUrl) return [];
        try {
          const targetUrl = `${qobuzUrl}/api/get-music?q=${encodeURIComponent(term)}&offset=0`;
          const resp = await fetch(targetUrl, {
            headers: { "User-Agent": "Mozilla/5.0 LosslessEdge/2.2" },
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
            duration: Number(t.duration) || 0,
            artworkURL: t.album?.image?.large || t.album?.image?.small || "",
            format: "flac",
            audioQuality: "LOSSLESS",
            quality: "Lossless",
            bitDepth: t.maximum_bit_depth || 16,
            sampleRate: t.maximum_sampling_rate ? Math.round(t.maximum_sampling_rate * 1000) : 44100,
            _source: "qobuz"
          }));
        } catch {
          return [];
        }
      };

      // Note: Do NOT search bridgeUrl (Fly.io) here because Fly queries the same LastWave quota.
      const [monoRes, lwRes, qobuzRes] = await Promise.allSettled([
        searchMonochrome(cleaned, 10),
        searchLastWave(cleaned),
        searchQobuz(cleaned)
      ]);

      const monoTracks = monoRes.status === "fulfilled" ? monoRes.value : [];
      const lwTracks = lwRes.status === "fulfilled" ? lwRes.value : [];
      const qobuzTracks = qobuzRes.status === "fulfilled" ? qobuzRes.value : [];

      if (monoTracks.length === 0 && lwTracks.length === 0 && qobuzTracks.length === 0 && cleaned !== rawQuery.trim()) {
        const [monoRaw, lwRaw] = await Promise.allSettled([
          searchMonochrome(rawQuery.trim(), 10),
          searchLastWave(rawQuery.trim())
        ]);
        if (monoRaw.status === "fulfilled") monoTracks.push(...monoRaw.value);
        if (lwRaw.status === "fulfilled") lwTracks.push(...lwRaw.value);
      }

      // Attach Monochrome fallback IDs onto matching LastWave tracks for stateless cross-fallback on isolate cold start
      for (const lw of lwTracks) {
        const match = findMatchingMono(lw, monoTracks);
        const lwBaseId = lw.id;
        setBounded(trackMetaCache, lwBaseId, {
          title: lw.title,
          artist: lw.artist,
          album: lw.album,
          duration: lw.duration,
          isrc: match?.isrc || "",
          monoId: match?._monoId
        });
        if (match?._monoId) {
          lw.id = `${lwBaseId}~m${match._monoId}`;
        }
      }

      for (const m of monoTracks) {
        setBounded(trackMetaCache, m.id, {
          title: m.title,
          artist: m.artist,
          album: m.album,
          duration: m.duration,
          isrc: m.isrc || "",
          monoId: m._monoId
        });
      }

      const rawCombined = [...monoTracks, ...qobuzTracks, ...lwTracks];
      const seenIds = new Set<string>();
      const seenTitles = new Set<string>();
      const deduped: any[] = [];

      // Rank candidates so direct native FLAC / verified Hi-Res order properly
      rawCombined.sort((a, b) => qualityScore(b) - qualityScore(a));

      for (const t of rawCombined) {
        const idKey = String(t.id);
        const titleKey = `${normalizeText(t.title || "")}|${normalizeText(t.artist || "")}`;
        if (!seenIds.has(idKey) && (!titleKey || !seenTitles.has(titleKey))) {
          seenIds.add(idKey);
          if (titleKey) seenTitles.add(titleKey);
          const cleanTrack = { ...t };
          delete cleanTrack._monoId;
          deduped.push(cleanTrack);
        }
      }

      setBounded(searchCache, cacheKey, { data: deduped, cachedAt: Date.now() });
      return new Response(JSON.stringify({ tracks: deduped }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // 4. Parallel Stream Resolution Endpoint
    const streamMatch = normalizedSubPath.match(/^\/stream\/(.+)$/);
    if (streamMatch) {
      let rawTrackId = streamMatch[1];
      try {
        rawTrackId = decodeURIComponent(rawTrackId);
      } catch {
        // Keep raw if malformed percent encoding
      }

      const cachedStream = streamCache.get(rawTrackId);
      if (cachedStream && (Date.now() - cachedStream.cachedAt < STREAM_CACHE_TTL)) {
        if (!isSuspectPrankUrl(cachedStream.data?.url)) {
          return new Response(JSON.stringify(cachedStream.data), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
          });
        }
        streamCache.delete(rawTrackId);
      }

      const qualityParam = (url.searchParams.get("quality") || "").toLowerCase();
      const [baseId, embeddedMonoId] = rawTrackId.split("~m");
      const meta = trackMetaCache.get(rawTrackId) || trackMetaCache.get(baseId);
      const durationHintSec = meta?.duration || 0;

      // Helper: try Monochrome direct FLAC by known snowflake ID
      const tryMonoDirect = async (monoId: string): Promise<any | null> => {
        if (!monoId) return null;
        return verifyAndNormalizeStream(
          { url: `${MONOCHROME_TRACKS_URL}/track/${encodeURIComponent(monoId)}`, format: "flac" },
          lastwaveUrl,
          lastwaveSecret,
          durationHintSec
        );
      };

      // Helper: try LastWave & verify response (tracks consecutive pranks to cool down on quota loss)
      const tryLastWave = async (lwId: string): Promise<any | null> => {
        if (!lwId || lwId.startsWith("mono_") || lwId.startsWith("qobuz_")) return null;
        if (Date.now() < lastwaveCooldownUntil) return null;
        try {
          const streamUrl = `${lastwaveUrl}/stream/${encodeURIComponent(lwId)}?quality=27`;
          const headers = await getSignedLastWaveHeaders(streamUrl, "GET", lastwaveSecret);
          const resp = await fetch(streamUrl, {
            headers,
            signal: AbortSignal.timeout(6000)
          });
          if (resp.status === 429) {
            lastwaveCooldownUntil = Date.now() + LASTWAVE_COOLDOWN_MS;
            return null;
          }
          if (!resp.ok) return null;
          const data = await resp.json<any>();
          if (!data?.url) return null;

          const verified = await verifyAndNormalizeStream(data, lastwaveUrl, lastwaveSecret, durationHintSec);
          if (!verified) {
            lastwavePrankStreak += 1;
            if (lastwavePrankStreak >= 2) {
              lastwaveCooldownUntil = Date.now() + LASTWAVE_COOLDOWN_MS;
            }
            return null;
          }
          lastwavePrankStreak = 0;
          return verified;
        } catch {
          return null;
        }
      };

      // Helper: try Fly.io bridge fallback & verify (must never pass unverified prank URLs)
      const tryBridge = async (idToFetch: string): Promise<any | null> => {
        if (!bridgeUrl || !idToFetch || idToFetch.startsWith("mono_")) return null;
        try {
          const bridgeStream = `${bridgeUrl}/stream/${encodeURIComponent(idToFetch)}`;
          const bResp = await fetch(bridgeStream, {
            headers: { "User-Agent": "Mozilla/5.0 LosslessEdge/2.2" },
            signal: AbortSignal.timeout(6000)
          });
          if (!bResp.ok) return null;
          const bData = await bResp.json<any>();
          if (!bData?.url) return null;
          return await verifyAndNormalizeStream(bData, lastwaveUrl, lastwaveSecret, durationHintSec);
        } catch {
          return null;
        }
      };

      let resolved: any | null = null;

      // Direct Monochrome ID
      if (baseId.startsWith("mono_")) {
        const monoId = baseId.slice("mono_".length);
        resolved = await tryMonoDirect(monoId);
        if (!resolved && meta) {
          resolved = await resolveViaMonochromeMeta(meta, lastwaveUrl, lastwaveSecret);
        }
      } else if (baseId.startsWith("qobuz_")) {
        resolved = await tryBridge(baseId);
        if (!resolved && meta) {
          resolved = await resolveViaMonochromeMeta(meta, lastwaveUrl, lastwaveSecret);
        }
      } else {
        // Tidal / LastWave ID (possibly paired with ~m<monoId>)
        const preferDirect = qualityParam === "lossless";
        if (!preferDirect) {
          resolved = await tryLastWave(baseId);
        }
        if (!resolved && (embeddedMonoId || meta?.monoId)) {
          resolved = await tryMonoDirect(embeddedMonoId || meta?.monoId || "");
        }
        if (!resolved) {
          const resolvedMeta = meta || (await fetchTidalTrackMeta(baseId));
          if (resolvedMeta) {
            setBounded(trackMetaCache, baseId, resolvedMeta);
            resolved = await resolveViaMonochromeMeta(resolvedMeta, lastwaveUrl, lastwaveSecret);
          }
        }
        if (!resolved && preferDirect) {
          resolved = await tryLastWave(baseId);
        }
        if (!resolved) {
          resolved = await tryBridge(baseId);
        }
      }

      if (resolved) {
        setBounded(streamCache, rawTrackId, { data: resolved, cachedAt: Date.now() });
        return new Response(JSON.stringify(resolved), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
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
