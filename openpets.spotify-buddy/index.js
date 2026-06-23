// Spotify Buddy — OpenPets Plugin (manifestVersion 2, sdkVersion 1.0.0)

const DEFAULT_POLL_INTERVAL_SECONDS = 10;
const MIN_POLL_INTERVAL_SECONDS = 5;
const MAX_ANNOUNCEMENT_LENGTH = 140;
const EMPTY_TRACK_ID = "__no_track__";

const STRIP_PATTERN = /```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b|https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\|api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]+PRIVATE KEY/gi;

const SPEAK_LATENCY_MS = 300;
const SEEK_DRIFT_THRESHOLD_MS = 2500;
const MIN_BUBBLE_MS = 800;
const LYRIC_SCHEDULE_PREFIX = "spotify-lyric-";

let pollRunning = false;
let activeLyrics = [];
let currentLyricIndex = -1;
let scheduleWallBase = null;
let scheduleProgressBase = null;

// ─── Text helpers ─────────────────────────────────────────────────────────────

function sanitizeLyric(text) {
  if (typeof text !== "string" || !text.trim()) return "";
  return text
    .trim()
    .replace(/[\r\n]+/g, " ")
    .replace(STRIP_PATTERN, " ")
    .replace(/\s+/g, " ")
    .slice(0, MAX_ANNOUNCEMENT_LENGTH)
    .trim();
}

function safeText(value, fallback = "") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const msg = value.trim().replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
  const capped = msg.length > MAX_ANNOUNCEMENT_LENGTH ? msg.slice(0, MAX_ANNOUNCEMENT_LENGTH).trim() : msg;
  if (!capped || STRIP_PATTERN.test(capped)) return fallback;
  return capped;
}

function format(template, values) {
  return safeText(String(template).replace(/\{(title|artist)\}/g, (_m, key) => safeText(values[key] || "")));
}

// ─── Lyric scheduling ─────────────────────────────────────────────────────────

const LYRIC_SCHEDULE_ID = "spotify-lyric-next";

async function cancelLyricSchedules(ctx) {
  try { await ctx.schedule.cancel(LYRIC_SCHEDULE_ID); } catch (_) {}
  activeLyrics = [];
  currentLyricIndex = -1;
  scheduleWallBase = null;
  scheduleProgressBase = null;
}

async function scheduleNextLyric(ctx) {
  try { await ctx.schedule.cancel(LYRIC_SCHEDULE_ID); } catch (_) {}

  const activeLyricsRef = activeLyrics;

  while (true) {
    if (activeLyrics !== activeLyricsRef) return;
    if (currentLyricIndex < 0 || currentLyricIndex >= activeLyricsRef.length) {
      return;
    }

    const line = activeLyricsRef[currentLyricIndex];
    const text = sanitizeLyric(line.text);
    if (!text) {
      currentLyricIndex++;
      continue;
    }

    if (scheduleWallBase === null || scheduleProgressBase === null) {
      return;
    }

    const currentProgressMs = scheduleProgressBase + (Date.now() - scheduleWallBase);
    const delay = line.timestamp - currentProgressMs - SPEAK_LATENCY_MS;

    if (delay < -200) {
      currentLyricIndex++;
      continue;
    }

    const safeDelay = Math.max(0, Math.round(delay || 0));
    if (isNaN(safeDelay) || !isFinite(safeDelay)) {
      currentLyricIndex++;
      continue;
    }

    try {
      await ctx.schedule.once(LYRIC_SCHEDULE_ID, safeDelay, async () => {
        if (activeLyrics !== activeLyricsRef) return;

        const capturedIndex = currentLyricIndex;
        const capturedLine = activeLyricsRef[capturedIndex];
        if (!capturedLine) return;

        const textToSpeak = sanitizeLyric(capturedLine.text);
        if (!textToSpeak) return;

        let durationMs = MIN_BUBBLE_MS;
        for (let j = capturedIndex + 1; j < activeLyricsRef.length; j++) {
          if (sanitizeLyric(activeLyricsRef[j].text)) {
            durationMs = Math.max(MIN_BUBBLE_MS, activeLyricsRef[j].timestamp - capturedLine.timestamp - 50);
            break;
          }
        }

        try {
          await ctx.storage.set("spotify-lastLyricIndex", capturedIndex);
          if (activeLyrics !== activeLyricsRef) return;
          const bubble = await ctx.ui.bubble({
            text: textToSpeak,
            durationMs: durationMs,
            actions: [
              { id: "spotify-previous-track", label: "Prev", dismissesBubble: false },
              { id: "spotify-pause-play", label: "Pause", dismissesBubble: false },
              { id: "spotify-next-track", label: "Next", dismissesBubble: false }
            ]
          });
          bubble.onAction(async (actionId) => {
            if (actionId === "spotify-pause-play") await togglePausePlay(ctx);
            else if (actionId === "spotify-next-track") await controlPlayback(ctx, "/me/player/next", "POST", "Playing next track!");
            else if (actionId === "spotify-previous-track") await controlPlayback(ctx, "/me/player/previous", "POST", "Playing previous track!");
          });
          if (activeLyrics !== activeLyricsRef) return;
          await ctx.status.set({ text: `🎵 ${textToSpeak}`, tone: "info" });
        } catch (e) {
          ctx.log?.warn?.("Lyric speak error", e?.message);
        }

        if (activeLyrics !== activeLyricsRef) return;
        currentLyricIndex = capturedIndex + 1;
        await scheduleNextLyric(ctx);
      });
    } catch (e) {
      ctx.log?.warn?.("Schedule once failed", e?.message);
    }

    break;
  }
}

async function scheduleLyrics(ctx, lyrics, progressMs) {
  await cancelLyricSchedules(ctx);

  activeLyrics = lyrics;
  scheduleWallBase = Date.now();
  scheduleProgressBase = progressMs;

  let targetIndex = -1;
  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i];
    const text = sanitizeLyric(line.text);
    if (!text) continue;

    const delay = line.timestamp - progressMs - SPEAK_LATENCY_MS;
    if (delay < -200) continue;

    targetIndex = i;
    break;
  }

  if (targetIndex !== -1) {
    currentLyricIndex = targetIndex;
    ctx.log?.info?.("Lyrics scheduling first tick", { index: targetIndex, text: lyrics[targetIndex].text, fromMs: progressMs });
    await scheduleNextLyric(ctx);
  } else {
    currentLyricIndex = -1;
    ctx.log?.info?.("No upcoming lyrics found to schedule", { total: lyrics.length, fromMs: progressMs });
  }
}

function seekDriftDetected(nowProgressMs) {
  if (scheduleWallBase === null || scheduleProgressBase === null) return true;
  const elapsed = Date.now() - scheduleWallBase;
  const expectedProgress = scheduleProgressBase + elapsed;
  return Math.abs(expectedProgress - nowProgressMs) > SEEK_DRIFT_THRESHOLD_MS;
}

// ─── Native Auth & Fetch ──────────────────────────────────────────────────────

async function getSpotifyClientId(ctx) {
  const config = await ctx.config.get();
  return config.spotifyClientId || "ae6b04810e434d66a9a52145b53c5b7d"; // Using user's provided extended quota Client ID
}

async function loginSpotify(ctx) {
  try {
    const clientId = await getSpotifyClientId(ctx);
    // Using ctx.auth.oauth as per available methods
    const tokens = await ctx.auth.oauth({
      provider: "spotify",
      clientId,
      authUrl: "https://accounts.spotify.com/authorize",
      authorizationUrl: "https://accounts.spotify.com/authorize",
      tokenUrl: "https://accounts.spotify.com/api/token",
      redirectUri: "http://127.0.0.1:48373/callback",
      scopes: ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing"],
      usePkce: true
    });
    
    await ctx.secrets.set("spotify-access-token", tokens.accessToken);
    await ctx.secrets.set("spotify-refresh-token", tokens.refreshToken);
    await ctx.secrets.set("spotify-expires-at", String(Date.now() + (tokens.expiresIn || 3600) * 1000));
    
    await ctx.pet.speak("Successfully connected to Spotify!");
    await ctx.pet.react("celebrating");
    return true;
  } catch (e) {
    ctx.log?.error?.("Spotify login failed", e?.message);
    const msg = String(e?.message || "Unknown error")
      .replace(/Error invoking remote method '[^']+':\s*/, "")
      .slice(0, 100);
    await ctx.pet.speak("Spotify login failed: " + msg);
    return false;
  }
}

async function refreshAccessToken(ctx) {
  const refreshToken = await ctx.secrets.get("spotify-refresh-token");
  const clientId = await getSpotifyClientId(ctx);
  
  if (!refreshToken) return null;
  
  try {
    const res = await ctx.net.fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId
      }).toString()
    });
    
    if (res.ok && res.json) {
      await ctx.secrets.set("spotify-access-token", res.json.access_token);
      if (res.json.refresh_token) {
        await ctx.secrets.set("spotify-refresh-token", res.json.refresh_token);
      }
      await ctx.secrets.set("spotify-expires-at", String(Date.now() + res.json.expires_in * 1000));
      return res.json.access_token;
    }
  } catch (e) {
    ctx.log?.warn?.("Token refresh failed", e?.message);
  }
  return null;
}

async function getValidToken(ctx) {
  let token = await ctx.secrets.get("spotify-access-token");
  let expiresAt = Number(await ctx.secrets.get("spotify-expires-at") || 0);
  
  if (!token || Date.now() > expiresAt - 60000) {
    token = await refreshAccessToken(ctx);
  }
  return token;
}

async function spotifyFetch(ctx, path, method = "GET", body = null) {
  const token = await getValidToken(ctx);
  if (!token) {
    throw new Error("NOT_AUTHENTICATED");
  }
  
  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${token}`
    }
  };
  
  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  
  const url = `https://api.spotify.com/v1${path}`;
  let res = await ctx.net.fetch(url, options);
  
  if (res.status === 401) {
    const newToken = await refreshAccessToken(ctx);
    if (newToken) {
      options.headers["Authorization"] = `Bearer ${newToken}`;
      res = await ctx.net.fetch(url, options);
    } else {
      throw new Error("NOT_AUTHENTICATED");
    }
  }
  
  if (!res.json && res.text) {
    try { res.json = JSON.parse(res.text); } catch (e) {}
  }
  
  return res;
}

async function getLRCLIBLyrics(ctx, trackName, artistName, durationMs) {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 1. Try precise match
      const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(trackName)}&artist_name=${encodeURIComponent(artistName)}&duration=${Math.round(durationMs / 1000)}`;
      let res = await ctx.net.fetch(url, { method: "GET" });
      if (!res.json && res.text) {
        try { res.json = JSON.parse(res.text); } catch (e) {}
      }
      if (res.ok && res.json) return res.json;

      // 2. Fallback to broad search
      const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(trackName + " " + artistName)}`;
      res = await ctx.net.fetch(searchUrl, { method: "GET" });
      if (!res.json && res.text) {
        try { res.json = JSON.parse(res.text); } catch (e) {}
      }
      
      if (res.ok && res.json && res.json.length > 0) {
        // Prefer a result with synced lyrics, otherwise just take the first one
        const best = res.json.find(t => t.syncedLyrics) || res.json[0];
        return best;
      }
      
      // If no exception but we got here, we failed to find anything.
      // Don't retry if it's a clean 404 (not found). Retries are for timeouts.
      if (res.status === 404) return null;
      
    } catch (e) {
      ctx.log?.warn?.(`LRCLIB error (attempt ${attempt + 1})`, e?.message);
      if (attempt === maxRetries) return null;
      // Continue to next iteration to retry immediately (good for cold starts)
    }
  }
  return null;
}

function parseSyncedLyrics(syncedStr) {
  if (!syncedStr) return [];
  const lines = syncedStr.split('\n');
  const lyrics = [];
  const regex = /\[(\d{2}):(\d{2}\.\d{2,3})\](.*)/;
  
  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseFloat(match[2]);
      const text = match[3].trim();
      const timestamp = (minutes * 60 + seconds) * 1000;
      lyrics.push({ timestamp, text });
    }
  }
  return lyrics;
}

// ─── Plugin registration ──────────────────────────────────────────────────────

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {

      await ctx.commands.register(
        { id: "spotify-login", title: "Login to Spotify", description: "Connect your Spotify account." },
        async () => { await loginSpotify(ctx); }
      );

      await ctx.commands.register(
        { id: "check-spotify-now", title: "Check Spotify Now", description: "Check what's playing on Spotify right now." },
        async () => {
          void checkNow(ctx, true).catch((e) => ctx.log?.warn?.("Manual check failed", e?.message));
          await ctx.status.set({ text: "Spotify: checking now…", tone: "info" });
        }
      );

      await ctx.commands.register(
        { id: "spotify-whats-playing", title: "What's Playing?", description: "Ask your pet what's currently playing." },
        async () => { await showWhatsPlaying(ctx); }
      );

      await ctx.commands.register(
        { id: "spotify-pause-play", title: "Pause / Play", description: "Toggle Spotify playback." },
        async () => { await togglePausePlay(ctx); }
      );

      await ctx.commands.register(
        { id: "spotify-next-track", title: "Play Next Track", description: "Skip to the next track." },
        async () => { await controlPlayback(ctx, "/me/player/next", "POST", "Playing next track!"); }
      );

      await ctx.commands.register(
        { id: "spotify-previous-track", title: "Play Previous Track", description: "Go back to the previous track." },
        async () => { await controlPlayback(ctx, "/me/player/previous", "POST", "Playing previous track!"); }
      );

      await ctx.commands.register(
        { id: "spotify-show-lyrics", title: "Show Lyrics", description: "Recite lyrics from the current song." },
        async () => { await showLyrics(ctx); }
      );

      await ctx.commands.register(
        { id: "spotify-reset-state", title: "Reset Spotify State", description: "Clear saved Spotify state." },
        async () => { await resetSpotifyState(ctx); }
      );

      await scheduleNext(ctx);
      void checkNow(ctx, false).catch((e) => ctx.log?.warn?.("Initial check failed", e?.message));
    },

    async stop(ctx) {
      if (ctx) await cancelLyricSchedules(ctx);
    },
  });
}

if (typeof globalThis.OpenPetsPlugin !== "undefined") register(globalThis.OpenPetsPlugin);

// ─── Poll loop ────────────────────────────────────────────────────────────────

async function scheduleNext(ctx) {
  const config = await ctx.config.get();
  const interval = Math.max(MIN_POLL_INTERVAL_SECONDS, Number(config.pollIntervalSeconds || DEFAULT_POLL_INTERVAL_SECONDS));
  const delayMs = interval * 1000;
  await ctx.schedule.cancel("spotify-poll");
  await ctx.schedule.once("spotify-poll", delayMs, async () => {
    try {
      await checkNow(ctx, false);
    } catch (e) {
      ctx.log?.warn?.("Background poll failed (e.g. network lost)", e?.message);
    }
    await scheduleNext(ctx);
  });
}

async function checkNow(ctx, manual) {
  if (pollRunning) {
    if (manual) await ctx.pet.speak("Spotify check already running.");
    return;
  }
  pollRunning = true;
  try {
    let res;
    try {
      res = await spotifyFetch(ctx, "/me/player");
    } catch (e) {
      if (e.message === "NOT_AUTHENTICATED") {
        await ctx.status.set({ text: "Spotify: needs login", tone: "warning" });
        if (manual) await ctx.pet.speak("Please login to Spotify first.");
        return;
      }
      throw e;
    }

    if (res && !res.ok && res.status !== 204) {
      if (manual) {
        await ctx.pet.speak(`Spotify API error: ${res.status} ${res.text?.slice(0, 50)}`);
      }
      return;
    }

    if (!res || res.status === 204 || !res.json || !res.json.item) {
      const lastPlaying = await ctx.storage.get("spotify-lastPlaying");
      await cancelLyricSchedules(ctx);
      await ctx.status.set({ text: "Spotify: nothing playing", tone: "info" });
      const config = await ctx.config.get();
      if (lastPlaying && config.reactWhenPaused) await ctx.pet.react("idle");
      await ctx.storage.set("spotify-lastPlaying", false);
      await ctx.storage.set("spotify-lastTrackId", EMPTY_TRACK_ID);
      await ctx.storage.set("spotify-lyrics", null);
      await ctx.storage.set("spotify-lastLyricIndex", -1);
      return;
    }

    const nowPlaying = {
      playing: res.json.is_playing,
      trackId: res.json.item.id,
      title: res.json.item.name,
      artist: res.json.item.artists.map(a => a.name).join(", "),
      progressMs: res.json.progress_ms,
      durationMs: res.json.item.duration_ms
    };
    
    // Attempt to get audio features for mood if track changed
    const lastTrackId = String(await ctx.storage.get("spotify-lastTrackId") || EMPTY_TRACK_ID);
    const trackChanged = lastTrackId !== nowPlaying.trackId;
    const config = await ctx.config.get();

    if (trackChanged && config.reactToMood) {
      try {
        const featuresRes = await spotifyFetch(ctx, `/audio-features/${nowPlaying.trackId}`);
        if (featuresRes.ok && featuresRes.json) {
          nowPlaying.features = featuresRes.json;
        }
      } catch (e) {}
    }

    if (!nowPlaying.playing) {
      const lastPlaying = await ctx.storage.get("spotify-lastPlaying");
      await cancelLyricSchedules(ctx);
      await ctx.status.set({ text: "Spotify: paused ⏸", tone: "info" });
      if (lastPlaying && config.reactWhenPaused) await ctx.pet.react("idle");
      await ctx.storage.set("spotify-lastPlaying", false);
      return;
    }

    if (trackChanged) {
      await cancelLyricSchedules(ctx);

      const announcement = format(
        config.announceTemplate || "Now playing: {title} by {artist}",
        nowPlaying
      );
      if (config.announceTrackChanges) {
        const bubble = await ctx.ui.bubble({
          text: announcement,
          durationMs: 4000,
          actions: [
            { id: "spotify-previous-track", label: "Prev", dismissesBubble: false },
            { id: "spotify-pause-play", label: "Pause", dismissesBubble: false },
            { id: "spotify-next-track", label: "Next", dismissesBubble: false }
          ]
        });
        bubble.onAction(async (actionId) => {
          if (actionId === "spotify-pause-play") await togglePausePlay(ctx);
          else if (actionId === "spotify-next-track") await controlPlayback(ctx, "/me/player/next", "POST", "Playing next track!");
          else if (actionId === "spotify-previous-track") await controlPlayback(ctx, "/me/player/previous", "POST", "Playing previous track!");
        });
      }
      await ctx.pet.react(config.reactToMood ? featuresToReaction(nowPlaying.features) : "celebrating");

      await ctx.storage.set("spotify-lastTrackId", nowPlaying.trackId);
      await ctx.storage.set("spotify-lastLyricIndex", -1);

      const lrclibData = await getLRCLIBLyrics(ctx, nowPlaying.title, nowPlaying.artist, nowPlaying.durationMs);
      const rawSyncedLyrics = parseSyncedLyrics(lrclibData?.syncedLyrics);
      
      const titleLower = (nowPlaying.title || "").toLowerCase();
      const artistLower = (nowPlaying.artist || "").toLowerCase();
      
      const syncedLyrics = rawSyncedLyrics.filter(l => {
        const text = sanitizeLyric(l.text).toLowerCase();
        if (!text) return false;
        if (titleLower && text === titleLower) return false;
        if (artistLower && text === artistLower) return false;
        if (titleLower && artistLower) {
          if (text === `${titleLower} - ${artistLower}` || text === `${artistLower} - ${titleLower}`) return false;
          if (text === `${titleLower} by ${artistLower}`) return false;
        }
        if (text.includes("lyrics by") || text.includes("lyricist")) return false;
        return true;
      });

      ctx.log?.info?.("Lyrics loaded from LRCLIB", { count: syncedLyrics.length });
      
      // IPC messages have size limits. Only store the snippet we need for showLyrics.
      const plainSnippet = lrclibData?.plainLyrics ? lrclibData.plainLyrics.slice(0, 500) : null;
      
      await ctx.storage.set("spotify-lyrics", syncedLyrics);
      await ctx.storage.set("spotify-lyrics-plain", plainSnippet);

      if (syncedLyrics.length) {
        await scheduleLyrics(ctx, syncedLyrics, nowPlaying.progressMs);
      }
    } else {
      if (nowPlaying.progressMs !== undefined && seekDriftDetected(nowPlaying.progressMs)) {
        const storedLyrics = await ctx.storage.get("spotify-lyrics");
        if (storedLyrics?.length) {
          ctx.log?.info?.("Seek/drift detected — rescheduling lyrics", { progressMs: nowPlaying.progressMs });
          await scheduleLyrics(ctx, storedLyrics, nowPlaying.progressMs);
        }
      }
    }

    await ctx.storage.set("spotify-lastPlaying", true);
    await ctx.status.set({
      text: `Spotify: ${safeText(nowPlaying.title || "Unknown track", "Unknown track")} 🎶`,
      tone: "success",
    });

    if (manual && !trackChanged) {
      await ctx.pet.speak(format(
        config.announceTemplate || "Now playing: {title} by {artist}",
        nowPlaying
      ));
    }
  } finally {
    pollRunning = false;
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function showWhatsPlaying(ctx) {
  const config = await ctx.config.get();
  try {
    const res = await spotifyFetch(ctx, "/me/player");
    if (!res) {
      await ctx.pet.speak("Network error: Spotify didn't respond.");
      return;
    }
    if (res.status === 204) {
      await ctx.pet.speak("Spotify is open, but no active device or playback session was found.");
      return;
    }
    if (!res.ok) {
      await ctx.pet.speak(`Spotify API error: ${res.status} ${res.text?.slice(0, 50)}`);
      return;
    }
    if (!res.json || !res.json.is_playing) {
      await ctx.pet.speak("Nothing is playing right now.");
      return;
    }
    const title = res.json.item.name;
    const artist = res.json.item.artists.map(a => a.name).join(", ");
    await ctx.pet.speak(format(
      config.announceTemplate || "Now playing: {title} by {artist}",
      { title, artist }
    ));
  } catch (e) {
    ctx.log?.error?.("showWhatsPlaying error:", e);
    await ctx.ui.toast({
      text: e.message === "NOT_AUTHENTICATED" ? "Please login to Spotify first." : "Couldn't fetch current track.",
      tone: "error"
    });
  }
}

async function togglePausePlay(ctx) {
  try {
    const res = await spotifyFetch(ctx, "/me/player");
    if (!res || !res.ok) {
      await ctx.pet.speak("Spotify API error checking playback state.");
      return;
    }
    if (res.status === 204 || !res.json) {
      // Session expired or paused for a long time. Find a device to wake up and play!
      const devicesRes = await spotifyFetch(ctx, "/me/player/devices");
      if (devicesRes && devicesRes.json && devicesRes.json.devices && devicesRes.json.devices.length > 0) {
        const device = devicesRes.json.devices.find(d => d.is_active) || devicesRes.json.devices[0];
        const actionRes = await spotifyFetch(ctx, `/me/player/play?device_id=${device.id}`, "PUT");
        if (actionRes.ok || actionRes.status === 204) {
          await ctx.ui.toast({ text: "Waking up Spotify & Resuming!", tone: "success" });
          await ctx.schedule.once("spotify-resume-check-wakeup", 1200, async () => {
            try { await checkNow(ctx, false); } catch (e) {}
          });
          return;
        }
      }
      
      await ctx.pet.speak("Spotify is sleeping deeply! Please open the Spotify app manually first.");
      return;
    }
    
    if (res.json.is_playing) {
      await cancelLyricSchedules(ctx);
      const actionRes = await spotifyFetch(ctx, "/me/player/pause", "PUT");
      if (actionRes.ok || actionRes.status === 204) {
        await ctx.ui.toast({ text: "Spotify Paused", tone: "info" });
        await ctx.pet.react("idle");
        await ctx.status.set({ text: "Spotify: paused ⏸", tone: "info" });
      } else {
        await ctx.ui.toast({ text: "Couldn't pause Spotify.", tone: "error" });
      }
    } else {
      const actionRes = await spotifyFetch(ctx, "/me/player/play", "PUT");
      if (actionRes.ok || actionRes.status === 204) {
        await ctx.ui.toast({ text: "Resuming playback!", tone: "success" });
        await ctx.pet.react("celebrating");
        await ctx.status.set({ text: "Spotify: resuming…", tone: "success" });
        await ctx.schedule.once("spotify-resume-check", 1200, async () => {
          try {
            await checkNow(ctx, false);
          } catch (e) {}
        });
      } else {
        await ctx.ui.toast({ text: "Couldn't resume Spotify.", tone: "error" });
      }
    }
  } catch (e) {
    ctx.log?.error?.("togglePausePlay error:", e);
    await ctx.ui.toast({
      text: e.message === "NOT_AUTHENTICATED" ? "Please login to Spotify first." : "Failed to toggle playback.",
      tone: "error"
    });
  }
}

async function controlPlayback(ctx, path, method, message) {
  try {
    await cancelLyricSchedules(ctx);
    const res = await spotifyFetch(ctx, path, method);
    if (res.ok || res.status === 204) {
      await ctx.ui.toast({ text: message, tone: "info" });
      await ctx.schedule.once("spotify-skip-check", 800, async () => {
        try {
          await checkNow(ctx, false);
        } catch (e) {}
      });
    } else {
      await ctx.ui.toast({ text: "Playback control failed.", tone: "error" });
    }
  } catch (e) {
    ctx.log?.error?.("controlPlayback error:", e);
    await ctx.ui.toast({
      text: e.message === "NOT_AUTHENTICATED" ? "Please login to Spotify first." : "Control failed.",
      tone: "error"
    });
  }
}

async function resetSpotifyState(ctx) {
  await cancelLyricSchedules(ctx);
  await ctx.storage.delete("spotify-lastTrackId");
  await ctx.storage.delete("spotify-lastPlaying");
  await ctx.storage.delete("spotify-lyrics");
  await ctx.storage.delete("spotify-lyrics-plain");
  await ctx.storage.delete("spotify-lastLyricIndex");
  await ctx.status.set({ text: "Spotify: state cleared", tone: "info" });
  await ctx.pet.speak("Spotify state has been reset.");
  await checkNow(ctx, false);
}

async function showLyrics(ctx) {
  try {
    const res = await spotifyFetch(ctx, "/me/player");
    if (!res || !res.ok) {
      await ctx.pet.speak("Spotify API error checking playback state.");
      return;
    }
    if (res.status === 204 || !res.json || !res.json.item) {
      await ctx.pet.speak("No active playback session found to get lyrics for.");
      return;
    }
    
    const plainLyrics = await ctx.storage.get("spotify-lyrics-plain");
    const syncedLyrics = await ctx.storage.get("spotify-lyrics");

    if (!plainLyrics && (!syncedLyrics || syncedLyrics.length === 0)) {
      await ctx.pet.speak("No lyrics available for this song.");
      return;
    }

    let rawLyrics;
    if (plainLyrics) {
      rawLyrics = plainLyrics;
    } else {
      rawLyrics = syncedLyrics.map(l => l.text).join(" ");
    }

    const cleaned = rawLyrics
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) {
      await ctx.pet.speak("Lyrics are empty after cleaning.");
      return;
    }

    const snippet = cleaned.length > 250 ? cleaned.slice(0, 250).trim() + "..." : cleaned;
    const final = snippet.replace(/[`'"<>]/g, "").trim();
    
    await ctx.ui.bubble({
      text: final || "Lyrics couldn't be displayed.",
      durationMs: 12000,
      tone: "success"
    });
    
  } catch (error) {
    ctx.log?.error?.("showLyrics error:", error);
    await ctx.ui.toast({ text: "Error getting lyrics", tone: "error" });
  }
}

// ─── Mood → reaction ──────────────────────────────────────────────────────────

function featuresToReaction(features) {
  if (!features) return "celebrating";
  const energy = Number(features.energy || 0);
  const valence = Number(features.valence || 0);
  const tempo = Number(features.tempo || 0);
  if (energy >= 0.8 && valence >= 0.65 && tempo >= 140) return "celebrating";
  if (energy >= 0.75 && valence <= 0.35 && tempo >= 140) return "running";
  if (valence >= 0.7 && energy <= 0.55) return "waving";
  if (energy <= 0.35 && valence <= 0.4) return "thinking";
  return "working";
}