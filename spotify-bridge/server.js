/**
 * spotify-bridge/server.js
 *
 * A local OAuth bridge for the OpenPets Spotify Buddy plugin.
 * Handles the Spotify Authorization Code Flow, stores tokens in a local
 * JSON file, auto-refreshes before expiry, and exposes one endpoint:
 *
 *   GET http://127.0.0.1:PORT/now-playing
 *
 * The OpenPets plugin polls this endpoint — it never touches OAuth directly.
 *
 * Setup:
 *   1. Create a Spotify app at https://developer.spotify.com/dashboard
 *   2. Add http://127.0.0.1:8765/callback as a Redirect URI
 *   3. Copy Client ID + Client Secret into .env (see .env.example)
 *   4. node server.js
 *   5. Run node start.js — browser opens automatically to http://127.0.0.1:8765/login
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
  : (process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
    : `http://127.0.0.1:${PORT}`);
const REDIRECT_URI = `${BASE_URL}/callback`;
const SCOPES = "user-read-currently-playing user-read-playback-state user-read-recently-played user-modify-playback-state";
const TOKEN_FILE = path.join(__dirname, ".tokens.json");

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

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), "utf8");
}

let tokens = loadTokens();
let pendingState = null; // CSRF state for OAuth flow

// ─── Spotify API helpers ──────────────────────────────────────────────────────

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

function httpsPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body, "utf8");
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": data.length, ...headers },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: responseBody }));
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Request timed out")); });
    req.write(data);
    req.end();
  });
}

function cleanTrackName(name) {
  if (!name) return name;
  return name
    .replace(/\s*(?:-\s*)?(?:Remaster(?:ed)?|Live|From.*?Session|Edit|Version|Mix|Acoustic|Instrumental|Radio Edit)(?:\s*\d{4})?\s*$/i, "")
    .replace(/\s*\([^)]*(?:Remaster|Live|Edit|Version|Mix|Acoustic|Instrumental)[^)]*\)/gi, "")
    .replace(/\s*\[[^\]]*(?:Remaster|Live|Edit|Version|Mix|Acoustic|Instrumental)[^\]]*\]/gi, "")
    .trim();
}

async function tryLrclibSearch(artist, title, album, durationMs) {
  try {
    const params = new URLSearchParams();
    if (artist) params.set("artist_name", artist);
    if (title) params.set("track_name", title);
    if (album) params.set("album_name", album);
    if (durationMs) params.set("duration", Math.round(durationMs / 1000));
    
    const url = `https://lrclib.net/api/get?${params.toString()}`;
    console.log(`Trying LRCLIB: ${url}`);
    const res = await httpsGet(url);
    if (res.status !== 200) return null;
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

async function fetchLyrics(artist, title, album, durationMs) {
  try {
    // Clean the names first
    const cleanedArtist = artist?.trim();
    const cleanedTitle = cleanTrackName(title);
    const cleanedAlbum = album?.trim();

    console.log(`Searching lyrics for: ${cleanedArtist} - ${cleanedTitle} (${cleanedAlbum || 'no album'})`);

    // Try multiple search strategies in order
    let data = null;
    
    // 1. Try with all cleaned params first
    data = await tryLrclibSearch(cleanedArtist, cleanedTitle, cleanedAlbum, durationMs);
    if (data && (data.syncedLyrics || data.plainLyrics)) {
      console.log("Found lyrics with full params!");
    } else {
      // 2. Try without album
      data = await tryLrclibSearch(cleanedArtist, cleanedTitle, null, durationMs);
      if (data && (data.syncedLyrics || data.plainLyrics)) {
        console.log("Found lyrics without album!");
      } else {
        // 3. Try without duration
        data = await tryLrclibSearch(cleanedArtist, cleanedTitle, cleanedAlbum, null);
        if (data && (data.syncedLyrics || data.plainLyrics)) {
          console.log("Found lyrics without duration!");
        } else {
          // 4. Try without album and duration
          data = await tryLrclibSearch(cleanedArtist, cleanedTitle, null, null);
          if (data && (data.syncedLyrics || data.plainLyrics)) {
            console.log("Found lyrics with just artist and title!");
          }
        }
      }
    }

    if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
      console.log("No lyrics found after all attempts");
      return null;
    }

    // Parse synced lyrics into { timestamp, text } array
    const syncedLines = [];
    if (data.syncedLyrics) {
      const lines = data.syncedLyrics.split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\]/);
        if (match) {
          const minutes = parseInt(match[1], 10);
          const seconds = parseInt(match[2], 10);
          const milliseconds = parseInt(match[3].padEnd(3, "0"), 10);
          const totalMs = minutes * 60 * 1000 + seconds * 1000 + milliseconds;
          const text = line.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, "").trim();
          if (text) {
            syncedLines.push({ timestamp: totalMs, text });
          }
        }
      }
    }

    return {
      plain: data.plainLyrics || null,
      synced: syncedLines.length > 0 ? syncedLines : null
    };
  } catch (e) {
    console.error("Error in fetchLyrics:", e);
    return null;
  }
}

function httpsPut(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "POST", // Spotify uses POST for playback controls!
        headers: { ...headers },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: responseBody }));
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Request timed out")); });
    req.end();
  });
}

async function skipToNext() {
  const accessToken = await getValidAccessToken();
  const res = await httpsPut("https://api.spotify.com/v1/me/player/next", { Authorization: `Bearer ${accessToken}` });
  if (res.status !== 204) throw new Error(`Failed to skip: ${res.status}`);
}

async function skipToPrevious() {
  const accessToken = await getValidAccessToken();
  const res = await httpsPut("https://api.spotify.com/v1/me/player/previous", { Authorization: `Bearer ${accessToken}` });
  if (res.status !== 204) throw new Error(`Failed to go back: ${res.status}`);
}

async function refreshAccessToken() {
  if (!tokens?.refresh_token) throw new Error("No refresh token stored. Visit /login first.");

  const res = await httpsPost(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }).toString(),
    { Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64") }
  );

  if (res.status !== 200) throw new Error(`Token refresh failed: ${res.status} ${res.body}`);

  const data = JSON.parse(res.body);
  tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token, // Spotify may or may not rotate it
    expires_at: Date.now() + data.expires_in * 1000 - 30_000, // 30s safety margin
  };
  saveTokens(tokens);
  console.log("[spotify-bridge] Access token refreshed.");
}

async function getValidAccessToken() {
  if (!tokens) {
    const loginUrl = BASE_URL.includes('railway') || BASE_URL.includes('render') 
      ? `${BASE_URL}/login` 
      : `http://127.0.0.1:${PORT}/login`;
    throw new Error("Not authorised. Visit " + loginUrl);
  }
  if (Date.now() >= tokens.expires_at) await refreshAccessToken();
  return tokens.access_token;
}

// ─── Spotify data fetchers ────────────────────────────────────────────────────

/**
 * Fetch audio features for a track (tempo, energy, valence, danceability).
 * Returns null if the call fails — plugin degrades gracefully.
 */
async function fetchAudioFeatures(trackId, accessToken) {
  try {
    const res = await httpsGet(
      `https://api.spotify.com/v1/audio-features/${trackId}`,
      { Authorization: `Bearer ${accessToken}` }
    );
    if (res.status !== 200) return null;
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

/**
 * Main endpoint data builder.
 * Returns a plain JSON object that is safe to expose over localhost.
 * NO access token, NO secrets ever leave this process.
 */
async function buildNowPlaying() {
  const accessToken = await getValidAccessToken();

  const res = await httpsGet(
    "https://api.spotify.com/v1/me/player/currently-playing?additional_types=track",
    { Authorization: `Bearer ${accessToken}` }
  );

  // 204 = nothing playing, 200 = playing
  if (res.status === 204 || !res.body) {
    return { playing: false };
  }

  if (res.status === 401) {
    await refreshAccessToken();
    return buildNowPlaying(); // retry once after refresh
  }

  if (res.status !== 200) {
    throw new Error(`Spotify API returned ${res.status}`);
  }

  const data = JSON.parse(res.body);

  // Only handle tracks (not podcasts/episodes)
  if (data.currently_playing_type !== "track" || !data.item) {
    return { playing: false };
  }

  const track = data.item;
  const trackId = track.id;
  const title = track.name;
  const artist = track.artists?.map((a) => a.name).join(", ") ?? "Unknown";
  const album = track.album?.name ?? "";
  const progressMs = data.progress_ms ?? 0;
  const durationMs = track.duration_ms ?? 0;
  const isPlaying = data.is_playing === true;

  // Fetch audio features in parallel — non-blocking
  const features = trackId ? await fetchAudioFeatures(trackId, accessToken) : null;

  return {
    playing: isPlaying,
    trackId,
    title,
    artist,
    album,
    progressMs,
    durationMs,
    // Audio features for mood mapping (all 0-1 unless noted)
    features: features
      ? {
          tempo: features.tempo,         // BPM, typically 60-200
          energy: features.energy,       // 0-1, intensity/activity
          valence: features.valence,     // 0-1, musical positiveness
          danceability: features.danceability, // 0-1
          acousticness: features.acousticness, // 0-1
          instrumentalness: features.instrumentalness, // 0-1
        }
      : null,
  };
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*", // localhost only — fine
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

  // ── GET /now-playing ── main plugin endpoint
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

  // ── GET /lyrics ── get lyrics for current track
  if (url.pathname === "/lyrics" && req.method === "GET") {
    try {
      const nowPlaying = await buildNowPlaying();
      if (!nowPlaying.playing) {
        sendJson(res, 200, { lyrics: null, error: "No track playing" });
        return;
      }
      const lyrics = await fetchLyrics(
        nowPlaying.artist,
        nowPlaying.title,
        nowPlaying.album,
        nowPlaying.durationMs
      );
      sendJson(res, 200, { lyrics });
    } catch (err) {
      console.error("[spotify-bridge] /lyrics error:", err.message);
      sendJson(res, 503, { error: err.message });
    }
    return;
  }

  // ── GET /next ── skip to next track (supports both for plugin SDK compatibility)
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

  // ── GET /previous ── skip to previous track
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

  // ── GET /status ── health check
  if (url.pathname === "/status" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      authorised: !!tokens,
      tokenExpiresAt: tokens?.expires_at ?? null,
    });
    return;
  }

  // ── GET /login ── kick off OAuth
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

    console.log(`[spotify-bridge] Redirecting to Spotify. redirect_uri sent: ${REDIRECT_URI}`);
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ── GET /callback ── OAuth callback
  if (url.pathname === "/callback" && req.method === "GET") {
    const code = url.searchParams.get("code");
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
        { Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64") }
      );

      if (tokenRes.status !== 200) throw new Error(`Token exchange failed: ${tokenRes.status}`);

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
         <p>You can close this tab. The bridge is running on http://127.0.0.1:${PORT}.</p>
         <p>The OpenPets Spotify Buddy plugin will now work.</p>`
      );
    } catch (err) {
      console.error("[spotify-bridge] Callback error:", err.message);
      sendHtml(res, 500, `<h2>Error: ${err.message}</h2>`);
    }
    return;
  }

  // ── GET /logout ── revoke local tokens
  if (url.pathname === "/logout" && req.method === "GET") {
    tokens = null;
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    sendHtml(res, 200, "<h2>Logged out. Visit /login to re-authorise.</h2>");
    return;
  }

  // ── 404 fallback
  sendJson(res, 404, { error: "Not found" });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[spotify-bridge] ERROR: Port ${PORT} is already in use.\n` +
      `Stop the existing bridge process or set SPOTIFY_BRIDGE_PORT to a free port.`
    );
    process.exit(1);
  }

  console.error("[spotify-bridge] Server error:", err);
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  const isCloud = BASE_URL.includes('railway') || BASE_URL.includes('render');
  console.log(`[spotify-bridge] Listening on ${BASE_URL}`);
  
  if (!tokens) {
    console.log(`[spotify-bridge] Not authorised. Visit ${BASE_URL}/login to connect Spotify`);
    if (!isCloud) {
      openBrowser(`http://127.0.0.1:${PORT}/login`);
    }
  } else {
    console.log("[spotify-bridge] Tokens loaded from disk. Bridge is ready.");
  }
  
  // Keep-alive ping for Render.com (prevents spin down)
  if (BASE_URL.includes('render')) {
    console.log('[keep-alive] Starting keep-alive pings every 10 minutes');
    setInterval(() => {
      https.get(`${BASE_URL}/status`, (res) => {
        console.log(`[keep-alive] Pinged /status - Status: ${res.statusCode}`);
      }).on('error', (err) => {
        console.log('[keep-alive] Ping failed:', err.message);
      });
    }, 10 * 60 * 1000); // Every 10 minutes (increased frequency)
  }
});

function openBrowser(url) {
  const { platform } = process;
  const cmd =
    platform === "win32" ? `start "" "${url}"` :
    platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;
  import("node:child_process").then(({ exec }) => {
    exec(cmd, (err) => {
      if (err) console.log(`[spotify-bridge] Could not auto-open browser. Please visit manually: ${url}`);
    });
  });
}