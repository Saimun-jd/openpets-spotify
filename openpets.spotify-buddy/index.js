const DEFAULT_POLL_INTERVAL_SECONDS = 2;
const MIN_POLL_INTERVAL_SECONDS = 2;
const MAX_ANNOUNCEMENT_LENGTH = 140;
const EMPTY_TRACK_ID = "__no_track__";

const STRIP_PATTERN = /```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b|https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\|api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]+PRIVATE KEY/gi;

const SPEAK_LATENCY_MS = 300;
const SEEK_DRIFT_THRESHOLD_MS = 2500;
const MIN_BUBBLE_MS = 800;
const LYRIC_SCHEDULE_PREFIX = "spotify-lyric-";

let pollRunning = false;
let activeLyricIds = [];
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

async function cancelLyricSchedules(ctx) {
  for (const id of activeLyricIds) {
    try { await ctx.schedule.cancel(id); } catch (_) {}
  }
  activeLyricIds = [];
  scheduleWallBase = null;
  scheduleProgressBase = null;
}

async function scheduleLyrics(ctx, lyrics, progressMs) {
  await cancelLyricSchedules(ctx);

  scheduleWallBase = Date.now();
  scheduleProgressBase = progressMs;

  const newIds = [];

  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i];
    const text = sanitizeLyric(line.text);
    if (!text) continue;

    const delay = line.timestamp - progressMs - SPEAK_LATENCY_MS;
    if (delay < -200) continue;

    // Bubble stays up until the next non-empty line is due
    let durationMs = MIN_BUBBLE_MS;
    for (let j = i + 1; j < lyrics.length; j++) {
      if (sanitizeLyric(lyrics[j].text)) {
        durationMs = Math.max(MIN_BUBBLE_MS, lyrics[j].timestamp - line.timestamp - 50);
        break;
      }
    }

    const scheduleId = `${LYRIC_SCHEDULE_PREFIX}${i}`;
    const capturedIndex = i;
    const capturedText = text;
    const capturedDuration = durationMs;

    await ctx.schedule.once(scheduleId, Math.max(0, delay), async () => {
      try {
        await ctx.storage.set("spotify-lastLyricIndex", capturedIndex);
        await ctx.pet.speak({ text: capturedText, durationMs: capturedDuration });
        await ctx.status.set({ text: `🎵 ${capturedText}`, tone: "info" });
      } catch (e) {
        ctx.log?.warn?.("Lyric speak error", e?.message);
      }
    });

    newIds.push(scheduleId);
  }

  activeLyricIds = newIds;
  ctx.log?.info?.("Lyrics scheduled", { total: lyrics.length, scheduled: newIds.length, fromMs: progressMs });
}

function seekDriftDetected(nowProgressMs) {
  if (scheduleWallBase === null || scheduleProgressBase === null) return true;
  const elapsed = Date.now() - scheduleWallBase;
  const expectedProgress = scheduleProgressBase + elapsed;
  return Math.abs(expectedProgress - nowProgressMs) > SEEK_DRIFT_THRESHOLD_MS;
}

// ─── Bridge fetch helpers ─────────────────────────────────────────────────────

// GET — used for /now-playing and /lyrics (read-only, works with ctx.http)
async function bridgeGet(ctx, bridgeUrl, path) {
  try {
    const url = `${String(bridgeUrl || "").replace(/\/+$/, "")}${path}`;
    ctx.log?.info?.("GET", { url });
    const res = await ctx.http.fetch(url, {
      method: "GET",
      headers: { "ngrok-skip-browser-warning": "true", "user-agent": "OpenPets Spotify Buddy" },
      timeoutMs: 10000,
    });
    ctx.log?.info?.("Response", { status: res.status, ok: res.ok });
    if (!res.ok) return null;
    return res.json || null;
  } catch (e) {
    ctx.log?.warn?.("GET error", e?.message || String(e));
    return null;
  }
}

// POST — used for playback controls (requires ctx.net + network:write permission)
// POST is not available in the plugin SDK (ctx.http is GET-only).
// Bridge must accept GET requests for control endpoints.
async function bridgePost(ctx, bridgeUrl, path) {
  try {
    const url = `${String(bridgeUrl || "").replace(/\/+$/, "")}${path}`;
    ctx.log?.info?.("GET (control)", { url });
    const res = await ctx.http.fetch(url, {
      method: "GET",
      headers: {
        "ngrok-skip-browser-warning": "true",
        "user-agent": "OpenPets Spotify Buddy",
      },
      timeoutMs: 10000,
    });
    ctx.log?.info?.("Response", { status: res.status, ok: res.ok });
    return res.ok || res.status === 204;
  } catch (e) {
    ctx.log?.warn?.("Control GET error", e?.message || String(e));
    return false;
  }
}

// ─── Plugin registration ──────────────────────────────────────────────────────

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {

      // ── Check Spotify Now ──────────────────────────────────────────────────
      await ctx.commands.register(
        { id: "check-spotify-now", title: "Check Spotify Now", description: "Check what's playing on Spotify right now." },
        async () => {
          void checkNow(ctx, true).catch((e) => ctx.log?.warn?.("Manual check failed", e?.message));
          await ctx.status.set({ text: "Spotify: checking now…", tone: "info" });
        }
      );

      // ── What's Playing? ────────────────────────────────────────────────────
      await ctx.commands.register(
        { id: "spotify-whats-playing", title: "What's Playing?", description: "Ask your pet what's currently playing." },
        async () => { await showWhatsPlaying(ctx); }
      );

      // ── Pause / Play toggle ────────────────────────────────────────────────
      await ctx.commands.register(
        { id: "spotify-pause-play", title: "Pause / Play", description: "Toggle Spotify playback." },
        async () => { await togglePausePlay(ctx); }
      );

      // ── Next Track ────────────────────────────────────────────────────────
      await ctx.commands.register(
        { id: "spotify-next-track", title: "Play Next Track", description: "Skip to the next track." },
        async () => { await controlPlayback(ctx, "/next", "Playing next track!"); }
      );

      // ── Previous Track ────────────────────────────────────────────────────
      await ctx.commands.register(
        { id: "spotify-previous-track", title: "Play Previous Track", description: "Go back to the previous track." },
        async () => { await controlPlayback(ctx, "/previous", "Playing previous track!"); }
      );

      // ── Show Lyrics ───────────────────────────────────────────────────────
      await ctx.commands.register(
        { id: "spotify-show-lyrics", title: "Show Lyrics", description: "Recite lyrics from the current song." },
        async () => { await showLyrics(ctx); }
      );

      // ── Reset State ───────────────────────────────────────────────────────
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
    await checkNow(ctx, false);
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
    const config = await ctx.config.get();
    const nowPlaying = await bridgeGet(ctx, config.bridgeUrl, "/now-playing");

    if (!nowPlaying) {
      await ctx.status.set({ text: "Spotify: bridge unreachable", tone: "warning" });
      if (manual) await ctx.pet.speak("Couldn't reach Spotify bridge.");
      return;
    }

    if (!nowPlaying.playing) {
      const lastPlaying = await ctx.storage.get("spotify-lastPlaying");
      await cancelLyricSchedules(ctx);
      await ctx.status.set({ text: "Spotify: nothing playing", tone: "info" });
      if (lastPlaying && config.reactWhenPaused) await ctx.pet.react("idle");
      await ctx.storage.set("spotify-lastPlaying", false);
      await ctx.storage.set("spotify-lastTrackId", EMPTY_TRACK_ID);
      await ctx.storage.set("spotify-lyrics", null);
      await ctx.storage.set("spotify-lastLyricIndex", -1);
      return;
    }

    const lastTrackId = String(await ctx.storage.get("spotify-lastTrackId") || EMPTY_TRACK_ID);
    const currentTrackId = String(nowPlaying.trackId || EMPTY_TRACK_ID);
    const trackChanged = lastTrackId !== currentTrackId;
    const progressMs = nowPlaying.progressMs ?? 0;

    if (trackChanged) {
      await cancelLyricSchedules(ctx);

      const announcement = format(
        config.announceTemplate || "Now playing: {title} by {artist}",
        { title: nowPlaying.title, artist: nowPlaying.artist }
      );
      if (config.announceTrackChanges) await ctx.pet.speak(announcement);
      await ctx.pet.react(config.reactToMood ? featuresToReaction(nowPlaying.features) : "celebrating");

      await ctx.storage.set("spotify-lastTrackId", currentTrackId);
      await ctx.storage.set("spotify-lastLyricIndex", -1);

      const lyricsData = await bridgeGet(ctx, config.bridgeUrl, "/lyrics");
      const syncedLyrics = lyricsData?.lyrics?.synced || null;
      ctx.log?.info?.("Lyrics loaded", { count: syncedLyrics?.length ?? 0 });
      await ctx.storage.set("spotify-lyrics", syncedLyrics);

      if (syncedLyrics?.length) {
        await scheduleLyrics(ctx, syncedLyrics, progressMs);
      }
    } else {
      if (nowPlaying.progressMs !== undefined && seekDriftDetected(progressMs)) {
        const storedLyrics = await ctx.storage.get("spotify-lyrics");
        if (storedLyrics?.length) {
          ctx.log?.info?.("Seek/drift detected — rescheduling lyrics", { progressMs });
          await scheduleLyrics(ctx, storedLyrics, progressMs);
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
        { title: nowPlaying.title, artist: nowPlaying.artist }
      ));
    }
  } finally {
    pollRunning = false;
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function showWhatsPlaying(ctx) {
  const config = await ctx.config.get();
  const nowPlaying = await bridgeGet(ctx, config.bridgeUrl, "/now-playing");
  if (!nowPlaying?.playing) {
    await ctx.pet.speak("Nothing is playing right now.");
    return;
  }
  await ctx.pet.speak(format(
    config.announceTemplate || "Now playing: {title} by {artist}",
    { title: nowPlaying.title, artist: nowPlaying.artist }
  ));
}

// Toggle: check current state from the bridge, then POST /pause or /play
async function togglePausePlay(ctx) {
  const config = await ctx.config.get();
  const nowPlaying = await bridgeGet(ctx, config.bridgeUrl, "/now-playing");

  if (!nowPlaying) {
    await ctx.pet.speak("Can't reach Spotify bridge.");
    return;
  }

  if (nowPlaying.playing) {
    // Currently playing → pause it
    await cancelLyricSchedules(ctx);
    const ok = await bridgePost(ctx, config.bridgeUrl, "/pause");
    if (ok) {
      await ctx.pet.speak("Paused.");
      await ctx.pet.react("idle");
      await ctx.status.set({ text: "Spotify: paused ⏸", tone: "info" });
    } else {
      await ctx.pet.speak("Couldn't pause Spotify.");
    }
  } else {
    // Currently paused → resume it
    const ok = await bridgePost(ctx, config.bridgeUrl, "/play");
    if (ok) {
      await ctx.pet.speak("Resuming playback!");
      await ctx.pet.react("celebrating");
      await ctx.status.set({ text: "Spotify: resuming…", tone: "success" });
      // Give Spotify a moment to resume before re-checking state + re-scheduling lyrics
      await ctx.schedule.once("spotify-resume-check", 1200, async () => {
        await checkNow(ctx, false);
      });
    } else {
      await ctx.pet.speak("Couldn't resume Spotify.");
    }
  }
}

// Skip next / previous — cancel lyric schedules then POST to bridge
async function controlPlayback(ctx, path, message) {
  const config = await ctx.config.get();
  await cancelLyricSchedules(ctx);
  const ok = await bridgePost(ctx, config.bridgeUrl, path);
  if (ok) {
    await ctx.pet.speak(message);
    // Brief delay so Spotify has time to update the current track before we poll
    await ctx.schedule.once("spotify-skip-check", 800, async () => {
      await checkNow(ctx, false);
    });
  } else {
    await ctx.pet.speak("Playback control failed. Check your bridge.");
    ctx.log?.warn?.("bridgePost failed", { path });
  }
}

async function resetSpotifyState(ctx) {
  await cancelLyricSchedules(ctx);
  await ctx.storage.delete("spotify-lastTrackId");
  await ctx.storage.delete("spotify-lastPlaying");
  await ctx.storage.delete("spotify-lyrics");
  await ctx.storage.delete("spotify-lastLyricIndex");
  await ctx.status.set({ text: "Spotify: state cleared", tone: "info" });
  await ctx.pet.speak("Spotify state has been reset.");
  await checkNow(ctx, false);
}

async function showLyrics(ctx) {
  try {
    const config = await ctx.config.get();
    const testData = await bridgeGet(ctx, config.bridgeUrl, "/now-playing");
    if (!testData) {
      await ctx.pet.speak("Can't reach Spotify bridge.");
      return;
    }

    const data = await bridgeGet(ctx, config.bridgeUrl, "/lyrics");
    if (!data) {
      await ctx.pet.speak("Lyrics endpoint not responding.");
      return;
    }

    if (!data.lyrics?.plain && (!data.lyrics?.synced || data.lyrics.synced.length === 0)) {
      await ctx.pet.speak("No lyrics available for this song.");
      return;
    }

    let rawLyrics;
    if (data.lyrics.plain) {
      rawLyrics = data.lyrics.plain;
    } else if (data.lyrics.synced?.length) {
      rawLyrics = data.lyrics.synced.map(l => l.text).join(" ");
    } else {
      await ctx.pet.speak("No lyrics text found.");
      return;
    }

    const cleaned = rawLyrics
      .replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, "")
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) {
      await ctx.pet.speak("Lyrics are empty after cleaning.");
      return;
    }

    const snippet = cleaned.length > 137 ? cleaned.slice(0, 137).trim() + "..." : cleaned;
    const final = snippet.replace(/[`'"<>]/g, "").trim();
    await ctx.pet.speak(final || "Lyrics couldn't be displayed.");
  } catch (error) {
    ctx.log?.error?.("showLyrics error:", error);
    await ctx.pet.speak("Error getting lyrics: " + (error?.message || "unknown"));
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