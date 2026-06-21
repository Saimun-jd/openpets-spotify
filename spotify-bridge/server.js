/**
 * spotify-bridge/server.js
 *
 * A local OAuth bridge for the OpenPets Spotify Buddy plugin.
 * Handles the Spotify Authorization Code Flow, stores tokens in a local
 * JSON file, auto-refreshes before expiry, and exposes endpoints:
 *
 *   GET /now-playing   — current track + audio features
 *   GET /lyrics        — synced + plain lyrics (cached per track)
 *   GET /pause         — pause playback
 *   GET /play          — resume playback
 *   GET /next          — skip to next track
 *   GET /previous      — skip to previous track
 *   GET /status        — health check
 *   GET /login         — kick off OAuth
 *   GET /callback      — OAuth callback
 *   GET /logout        — revoke local tokens
 *
 * The OpenPets plugin polls/calls these endpoints — it never touches OAuth directly.
 *
 * Setup:
 *   1. Create a Spotify app at https://developer.spotify.com/dashboard
 *   2. Add http://127.0.0.1:8765/callback as a Redirect URI
 *   3. Copy Client ID + Client Secret into .env (see .env.example)
 *   4. node server.js
 *   5. Browser opens automatically to http://127.0.0.1:8765/login
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? process.env.SPOTIFY_BRIDGE_PORT ?? 8765);
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET ?? "";
const BASE_URL = process.env.RENDER_EXTERNAL_URL
  ? process.env.RENDER_EXTERNAL_URL
  : process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = `${BASE_URL}/callback`;
const SCOPES =
  "user-read-currently-playing user-read-playback-state user-read-recently-played user-modify-playback-state";
const TOKEN_FILE = path.join(__dirname, ".tokens.json");

// Timeout for all outbound HTTP requests (ms)
const HTTP_TIMEOUT_MS = 6000;

// Lyrics in-memory cache — avoids re-fetching lrclib on every /lyrics call
// for the same track. Cleared when the track changes.
let lyricsCache = {
  trackId: null,
  lyrics: null, // { plain, synced } | null
};

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "[spotify-bridge] ERROR: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set.\n" +
      "Copy .env.example to .env and fill in your Spotify app credentials."
  );
  process.exit(1);
}

// ─── Token storage ────────────────────────────────────────────────────────────

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    }
  } catch {}
  return null;
}

function saveTokens(t) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), "utf8");
}

let tokens = loadTokens();
let pendingState = null;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`GET ${url} timed out after ${HTTP_TIMEOUT_MS}ms`));
    });
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body, "utf8");
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": data.length,
          ...headers,
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: responseBody }));
      }
    );
    req.on("error", reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`POST ${url} timed out after ${HTTP_TIMEOUT_MS}ms`));
    });
    req.write(data);
    req.end();
  });
}

/**
 * For Spotify playback control endpoints that need PUT or POST with no body.
 */
function spotifyControl(url, method, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method,
        headers: { "Content-Length": 0, ...headers },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: responseBody }));
      }
    );
    req.on("error", reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`${method} ${url} timed out after ${HTTP_TIMEOUT_MS}ms`));
    });
    req.end();
  });
}

// ─── Token management ─────────────────────────────────────────────────────────

async function refreshAccessToken() {
  if (!tokens?.refresh_token)
    throw new Error("No refresh token stored. Visit /login first.");

  const res = await httpsPost(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }).toString(),
    {
      Authorization:
        "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
    }
  );

  if (res.status !== 200)
    throw new Error(`Token refresh failed: ${res.status} ${res.body}`);

  const data = JSON.parse(res.body);
  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000 - 30_000,
  };
  saveTokens(tokens);
  console.log("[spotify-bridge] Access token refreshed.");
}

async function getValidAccessToken() {
  if (!tokens) {
    const loginUrl =
      BASE_URL.includes("railway") || BASE_URL.includes("render")
        ? `${BASE_URL}/login`
        : `http://127.0.0.1:${PORT}/login`;
    throw new Error("Not authorised. Visit " + loginUrl);
  }
  if (Date.now() >= tokens.expires_at) await refreshAccessToken();
  return tokens.access_token;
}

// ─── Spotify data fetchers ────────────────────────────────────────────────────

async function fetchAudioFeatures(trackId, accessToken) {
  try {
    const res = await httpsGet(
      `https://api.spotify.com/v1/audio-features/${trackId}`,
      { Authorization: `Bearer ${accessToken}` }
    );
    if (res.status !== 200) return null;
    return JSON.parse(res.body);
  } catch (e) {
    console.warn("[spotify-bridge] fetchAudioFeatures failed:", e.message);
    return null;
  }
}

async function buildNowPlaying() {
  const accessToken = await getValidAccessToken();

  const res = await httpsGet(
    "https://api.spotify.com/v1/me/player/currently-playing?additional_types=track",
    { Authorization: `Bearer ${accessToken}` }
  );

  if (res.status === 204 || !res.body) return { playing: false };

  if (res.status === 401) {
    await refreshAccessToken();
    return buildNowPlaying();
  }

  if (res.status !== 200)
    throw new Error(`Spotify API returned ${res.status}`);

  const data = JSON.parse(res.body);

  if (data.currently_playing_type !== "track" || !data.item)
    return { playing: false };

  const track = data.item;
  const trackId = track.id;
  const title = track.name;
  const artist = track.artists?.map((a) => a.name).join(", ") ?? "Unknown";
  const album = track.album?.name ?? "";
  const progressMs = data.progress_ms ?? 0;
  const durationMs = track.duration_ms ?? 0;
  const isPlaying = data.is_playing === true;

  // Audio features fetched in parallel — non-blocking, failure is graceful
  const features = trackId ? await fetchAudioFeatures(trackId, accessToken) : null;

  return {
    playing: isPlaying,
    trackId,
    title,
    artist,
    album,
    progressMs,
    durationMs,
    features: features
      ? {
          tempo: features.tempo,
          energy: features.energy,
          valence: features.valence,
          danceability: features.danceability,
          acousticness: features.acousticness,
          instrumentalness: features.instrumentalness,
        }
      : null,
  };
}

// ─── Lyrics ───────────────────────────────────────────────────────────────────

function cleanTrackName(name) {
  if (!name) return name;
  return name
    .replace(
      /\s*(?:-\s*)?(?:Remaster(?:ed)?|Live|From.*?Session|Edit|Version|Mix|Acoustic|Instrumental|Radio Edit)(?:\s*\d{4})?\s*$/i,
      ""
    )
    .replace(
      /\s*\([^)]*(?:Remaster|Live|Edit|Version|Mix|Acoustic|Instrumental)[^)]*\)/gi,
      ""
    )
    .replace(
      /\s*\[[^\]]*(?:Remaster|Live|Edit|Version|Mix|Acoustic|Instrumental)[^\]]*\]/gi,
      ""
    )
    .trim();
}

/**
 * Single lrclib lookup — returns parsed response or null.
 * Has its own try/catch so a timeout on one attempt doesn't abort the others.
 */
async function tryLrclibSearch(artist, title, album, durationSec) {
  try {
    const params = new URLSearchParams();
    if (artist) params.set("artist_name", artist);
    if (title) params.set("track_name", title);
    if (album) params.set("album_name", album);
    if (durationSec != null) params.set("duration", durationSec);

    const url = `https://lrclib.net/api/get?${params.toString()}`;
    console.log(`[lrclib] GET ${url}`);
    const res = await httpsGet(url);
    if (res.status !== 200) return null;
    const body = JSON.parse(res.body);
    // Only return if it actually has lyric content
    return body?.syncedLyrics || body?.plainLyrics ? body : null;
  } catch (e) {
    console.warn("[lrclib] attempt failed:", e.message);
    return null;
  }
}

/**
 * Run all four lrclib search strategies in PARALLEL with Promise.any().
 * The first one that resolves with content wins immediately — no waiting
 * for slower fallbacks. This replaces the old sequential waterfall that
 * could chain 4 × 6s timeouts = 24s total.
 */
async function fetchLyricsFromLrclib(artist, title, album, durationMs) {
  const cleanedArtist = artist?.trim() ?? "";
  const cleanedTitle = cleanTrackName(title) ?? "";
  const cleanedAlbum = album?.trim() ?? "";
  const durationSec = durationMs ? Math.round(durationMs / 1000) : null;

  console.log(
    `[lrclib] Searching: "${cleanedArtist}" - "${cleanedTitle}" (album: "${cleanedAlbum || "—"}", dur: ${durationSec ?? "—"}s)`
  );

  // All four strategies fire at the same time
  const searches = [
    tryLrclibSearch(cleanedArtist, cleanedTitle, cleanedAlbum, durationSec),
    tryLrclibSearch(cleanedArtist, cleanedTitle, null, durationSec),
    tryLrclibSearch(cleanedArtist, cleanedTitle, cleanedAlbum, null),
    tryLrclibSearch(cleanedArtist, cleanedTitle, null, null),
  ];

  let data = null;
  try {
    // Promise.any resolves as soon as ONE non-null result arrives
    data = await Promise.any(
      searches.map((p) =>
        p.then((r) => {
          if (!r) throw new Error("no result");
          return r;
        })
      )
    );
    console.log("[lrclib] Found lyrics via parallel search.");
  } catch {
    // All four failed (AggregateError from Promise.any)
    console.log("[lrclib] No lyrics found after all parallel attempts.");
    return null;
  }

  // Parse synced lyrics LRC → [{ timestamp, text }]
  const syncedLines = [];
  if (data.syncedLyrics) {
    for (const line of data.syncedLyrics.split(/\r?\n/)) {
      const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\]/);
      if (!match) continue;
      const totalMs =
        parseInt(match[1], 10) * 60_000 +
        parseInt(match[2], 10) * 1_000 +
        parseInt(match[3].padEnd(3, "0"), 10);
      const text = line.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, "").trim();
      if (text) syncedLines.push({ timestamp: totalMs, text });
    }
  }

  return {
    plain: data.plainLyrics || null,
    synced: syncedLines.length > 0 ? syncedLines : null,
  };
}

/**
 * Fetch lyrics for the current track, using the in-memory cache so that
 * repeated /lyrics calls during the same song don't hammer lrclib.
 *
 * @param {string} trackId
 * @param {string} artist
 * @param {string} title
 * @param {string} album
 * @param {number} durationMs
 */
async function getLyrics(trackId, artist, title, album, durationMs) {
  // Cache hit — same track, return immediately
  if (lyricsCache.trackId === trackId) {
    console.log("[lyrics-cache] Hit for trackId:", trackId);
    return lyricsCache.lyrics;
  }

  // Cache miss — fetch from lrclib
  console.log("[lyrics-cache] Miss — fetching from lrclib for trackId:", trackId);
  const lyrics = await fetchLyricsFromLrclib(artist, title, album, durationMs);

  // Store result (even null — so we don't keep retrying a song with no lyrics)
  lyricsCache = { trackId, lyrics };
  return lyrics;
}

// ─── Playback control helpers ─────────────────────────────────────────────────

async function pausePlayback() {
  const accessToken = await getValidAccessToken();
  const res = await spotifyControl(
    "https://api.spotify.com/v1/me/player/pause",
    "PUT",
    { Authorization: `Bearer ${accessToken}` }
  );
  // 204 = paused, 403 = already paused — both are fine
  if (res.status !== 204 && res.status !== 403)
    throw new Error(`Failed to pause: ${res.status} ${res.body}`);
}

async function resumePlayback() {
  const accessToken = await getValidAccessToken();
  const res = await spotifyControl(
    "https://api.spotify.com/v1/me/player/play",
    "PUT",
    { Authorization: `Bearer ${accessToken}` }
  );
  // 204 = resumed, 403 = already playing — both are fine
  if (res.status !== 204 && res.status !== 403)
    throw new Error(`Failed to resume: ${res.status} ${res.body}`);
}

async function skipToNext() {
  const accessToken = await getValidAccessToken();
  const res = await spotifyControl(
    "https://api.spotify.com/v1/me/player/next",
    "POST",
    { Authorization: `Bearer ${accessToken}` }
  );
  if (res.status !== 204) throw new Error(`Failed to skip: ${res.status}`);
}

async function skipToPrevious() {
  const accessToken = await getValidAccessToken();
  const res = await spotifyControl(
    "https://api.spotify.com/v1/me/player/previous",
    "POST",
    { Authorization: `Bearer ${accessToken}` }
  );
  if (res.status !== 204) throw new Error(`Failed to go back: ${res.status}`);
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // ── GET /now-playing ──────────────────────────────────────────────────────
  if (url.pathname === "/now-playing" && req.method === "GET") {
    try {
      const data = await buildNowPlaying();
      sendJson(res, 200, data);
    } catch (err) {
      console.error("[spotify-bridge] /now-playing error:", err.message);
      sendJson(res, 503, { error: err.message });
    }
    return;
  }

  // ── GET /lyrics ───────────────────────────────────────────────────────────
  //
  // FIX: /lyrics no longer re-calls buildNowPlaying() internally.
  // Instead the plugin passes track info via query params so the bridge
  // can go straight to lrclib. Falls back to a lightweight Spotify check
  // if params are missing (e.g. direct browser visit).
  //
  // Query params (all optional, sent by the plugin):
  //   ?trackId=...&artist=...&title=...&album=...&durationMs=...
  //
  if (url.pathname === "/lyrics" && req.method === "GET") {
    try {
      let trackId   = url.searchParams.get("trackId") || null;
      let artist    = url.searchParams.get("artist")  || null;
      let title     = url.searchParams.get("title")   || null;
      let album     = url.searchParams.get("album")   || null;
      let durationMs = url.searchParams.get("durationMs")
        ? Number(url.searchParams.get("durationMs"))
        : null;

      // If called without params (e.g. direct browser test), do a quick
      // now-playing lookup to get the track details.
      if (!trackId || !artist || !title) {
        const nowPlaying = await buildNowPlaying();
        if (!nowPlaying.playing) {
          sendJson(res, 200, { lyrics: null, reason: "No track playing" });
          return;
        }
        trackId    = nowPlaying.trackId;
        artist     = nowPlaying.artist;
        title      = nowPlaying.title;
        album      = nowPlaying.album;
        durationMs = nowPlaying.durationMs;
      }

      const lyrics = await getLyrics(trackId, artist, title, album, durationMs);
      sendJson(res, 200, { lyrics });
    } catch (err) {
      console.error("[spotify-bridge] /lyrics error:", err.message);
      sendJson(res, 503, { error: err.message });
    }
    return;
  }

  // ── GET /pause ────────────────────────────────────────────────────────────
  if (url.pathname === "/pause" && (req.method === "GET" || req.method === "POST")) {
    try {
      await pausePlayback();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error("[spotify-bridge] /pause error:", err.message);
      sendJson(res, 503, { error: err.message });
    }
    return;
  }

  // ── GET /play ─────────────────────────────────────────────────────────────
  if (url.pathname === "/play" && (req.method === "GET" || req.method === "POST")) {
    try {
      await resumePlayback();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error("[spotify-bridge] /play error:", err.message);
      sendJson(res, 503, { error: err.message });
    }
    return;
  }

  // ── GET /next ─────────────────────────────────────────────────────────────
  if (url.pathname === "/next" && (req.method === "GET" || req.method === "POST")) {
    try {
      await skipToNext();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error("[spotify-bridge] /next error:", err.message);
      sendJson(res, 503, { error: err.message });
    }
    return;
  }

  // ── GET /previous ─────────────────────────────────────────────────────────
  if (url.pathname === "/previous" && (req.method === "GET" || req.method === "POST")) {
    try {
      await skipToPrevious();
      sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error("[spotify-bridge] /previous error:", err.message);
      sendJson(res, 503, { error: err.message });
    }
    return;
  }

  // ── GET /status ───────────────────────────────────────────────────────────
  if (url.pathname === "/status" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      authorised: !!tokens,
      tokenExpiresAt: tokens?.expires_at ?? null,
      lyricsCacheTrackId: lyricsCache.trackId,
    });
    return;
  }

  // ── GET /login ────────────────────────────────────────────────────────────
  if (url.pathname === "/login" && req.method === "GET") {
    pendingState = crypto.randomBytes(16).toString("hex");
    const authUrl =
      "https://accounts.spotify.com/authorize?" +
      new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        state: pendingState,
        scope: SCOPES,
      }).toString();
    console.log(
      `[spotify-bridge] Redirecting to Spotify. redirect_uri: ${REDIRECT_URI}`
    );
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ── GET /callback ─────────────────────────────────────────────────────────
  if (url.pathname === "/callback" && req.method === "GET") {
    const code  = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      sendHtml(res, 400, `<h2>Spotify auth error: ${error}</h2>`);
      return;
    }

    if (!code || state !== pendingState) {
      sendHtml(res, 400, "<h2>Invalid state or missing code. Try /login again.</h2>");
      return;
    }

    pendingState = null;

    try {
      const tokenRes = await httpsPost(
        "https://accounts.spotify.com/api/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
        }).toString(),
        {
          Authorization:
            "Basic " +
            Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
        }
      );

      if (tokenRes.status !== 200)
        throw new Error(`Token exchange failed: ${tokenRes.status}`);

      const data = JSON.parse(tokenRes.body);
      tokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000 - 30_000,
      };
      saveTokens(tokens);
      console.log("[spotify-bridge] Authorised successfully.");

      sendHtml(
        res,
        200,
        `<h2>&#x2713; Spotify connected!</h2>
         <p>You can close this tab.</p>
         <p>The bridge is running on ${BASE_URL}.</p>
         <p>The OpenPets Spotify Buddy plugin will now work.</p>`
      );
    } catch (err) {
      console.error("[spotify-bridge] Callback error:", err.message);
      sendHtml(res, 500, `<h2>Error: ${err.message}</h2>`);
    }
    return;
  }

  // ── GET /logout ───────────────────────────────────────────────────────────
  if (url.pathname === "/logout" && req.method === "GET") {
    tokens = null;
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    sendHtml(res, 200, "<h2>Logged out. Visit /login to re-authorise.</h2>");
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  sendJson(res, 404, { error: "Not found" });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[spotify-bridge] ERROR: Port ${PORT} is already in use.\n` +
        `Stop the existing process or set SPOTIFY_BRIDGE_PORT to a free port.`
    );
    process.exit(1);
  }
  console.error("[spotify-bridge] Server error:", err);
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  const isCloud = BASE_URL.includes("railway") || BASE_URL.includes("render");
  console.log(`[spotify-bridge] Listening on ${BASE_URL}`);

  if (!tokens) {
    console.log(
      `[spotify-bridge] Not authorised. Visit ${BASE_URL}/login to connect Spotify`
    );
    if (!isCloud) openBrowser(`http://127.0.0.1:${PORT}/login`);
  } else {
    console.log("[spotify-bridge] Tokens loaded from disk. Bridge is ready.");
  }

  // Keep-alive ping for Render.com (prevents spin-down after 15 min idle)
  if (BASE_URL.includes("render")) {
    console.log("[keep-alive] Starting pings every 10 minutes");
    setInterval(() => {
      https
        .get(`${BASE_URL}/status`, (res) => {
          console.log(`[keep-alive] /status → ${res.statusCode}`);
        })
        .on("error", (err) => {
          console.warn("[keep-alive] Ping failed:", err.message);
        });
    }, 10 * 60 * 1000);
  }
});

function openBrowser(url) {
  const { platform } = process;
  const cmd =
    platform === "win32"
      ? `start "" "${url}"`
      : platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  import("node:child_process").then(({ exec }) => {
    exec(cmd, (err) => {
      if (err)
        console.log(
          `[spotify-bridge] Could not auto-open browser. Visit manually: ${url}`
        );
    });
  });
}