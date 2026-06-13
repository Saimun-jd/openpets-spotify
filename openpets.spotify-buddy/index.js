const DEFAULT_POLL_INTERVAL_SECONDS = 2;
const MIN_POLL_INTERVAL_SECONDS = 1;
const MAX_ANNOUNCEMENT_LENGTH = 140;
const EMPTY_TRACK_ID = "__no_track__";
const UNSAFE_MESSAGE_PATTERN = /```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b|https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\|api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]+PRIVATE KEY/i;
const DEFAULT_LYRIC_ADVANCE_MS = 500;

let pollRunning = false;

// Safe sanitizer for lyrics — skips the unsafe pattern check
function sanitizeLyric(text) {
  if (typeof text !== "string" || !text.trim()) return "";
  return text.trim().replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").slice(0, MAX_ANNOUNCEMENT_LENGTH).trim();
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await ctx.commands.register({ id: "check-spotify-now", title: "Check Spotify Now", description: "Check what's playing on Spotify right now." }, async () => {
        void checkNow(ctx, true).catch((error) => ctx.log?.warn?.("Spotify manual check failed", error?.message || String(error)));
        await ctx.status.set({ text: "Spotify: checking now…", tone: "info" });
      });

      await ctx.commands.register({ id: "spotify-whats-playing", title: "What's Playing?", description: "Ask your pet what's currently playing on Spotify." }, async () => {
        await showWhatsPlaying(ctx);
      });

      await ctx.commands.register({ id: "spotify-reset-state", title: "Reset Spotify State", description: "Clear saved Spotify state for fresh checks." }, async () => {
        await resetSpotifyState(ctx);
      });

      await ctx.commands.register({ id: "spotify-next-track", title: "Play Next Track", description: "Skip to the next track on Spotify." }, async () => {
        await skipNext(ctx);
      });

      await ctx.commands.register({ id: "spotify-previous-track", title: "Play Previous Track", description: "Go back to the previous track on Spotify." }, async () => {
        await skipPrevious(ctx);
      });

      await ctx.commands.register({ id: "spotify-show-lyrics", title: "Show Lyrics", description: "Have your pet recite some lyrics from the current song!" }, async () => {
        await showLyrics(ctx);
      });

      await scheduleNext(ctx);
      void checkNow(ctx, false).catch((error) => ctx.log?.warn?.("Spotify initial check failed", error?.message || String(error)));
    },
  });
}

if (typeof globalThis.OpenPetsPlugin !== "undefined") register(globalThis.OpenPetsPlugin);

async function scheduleNext(ctx) {
  const config = await ctx.config.get();
  const interval = Math.max(MIN_POLL_INTERVAL_SECONDS, Number(config.pollIntervalSeconds || DEFAULT_POLL_INTERVAL_SECONDS));
  const delayMs = interval * 1000;
  await ctx.schedule.cancel("spotify-poll");
  await ctx.schedule.once("spotify-poll", delayMs, async () => {
    await checkNow(ctx, false);
    await scheduleNext(ctx);
  });
  await ctx.status.set({ text: `Spotify: next check ${new Date(Date.now() + delayMs).toLocaleTimeString()}`, tone: "info" });
}

async function checkNow(ctx, manual) {
  if (pollRunning) {
    if (manual) await ctx.pet.speak("Spotify check already running.");
    return;
  }
  pollRunning = true;
  try {
    const config = await ctx.config.get();
    const nowPlaying = await fetchFromBridge(ctx, config.bridgeUrl, "/now-playing");

    if (!nowPlaying) {
      await ctx.status.set({ text: "Spotify: bridge unreachable", tone: "warning" });
      if (manual) await ctx.pet.speak("Couldn't reach Spotify bridge.");
      return;
    }

    if (!nowPlaying.playing) {
      const lastPlaying = await ctx.storage.get("spotify-lastPlaying");
      await ctx.status.set({ text: "Spotify: nothing playing", tone: "neutral" });

      if (lastPlaying && config.reactWhenPaused) {
        await ctx.pet.react("idle");
      }

      await ctx.storage.set("spotify-lastPlaying", false);
      await ctx.storage.set("spotify-lastTrackId", EMPTY_TRACK_ID);
      await ctx.storage.set("spotify-lyrics", null);
      await ctx.storage.set("spotify-lastLyricIndex", -1);
      await ctx.schedule.cancel("spotify-lyric");
      return;
    }

    const lastTrackId = String(await ctx.storage.get("spotify-lastTrackId") || EMPTY_TRACK_ID);
    const currentTrackId = String(nowPlaying.trackId || EMPTY_TRACK_ID);
    const trackChanged = lastTrackId !== currentTrackId;

    if (trackChanged) {
      const announcement = format(config.announceTemplate || "Now playing: {title} by {artist}", {
        title: nowPlaying.title,
        artist: nowPlaying.artist,
      });

      if (config.announceTrackChanges) await ctx.pet.speak(announcement);

      if (config.reactToMood) {
        const reaction = featuresToReaction(nowPlaying.features);
        await ctx.pet.react(reaction);
      } else {
        await ctx.pet.react("celebrating");
      }

      await ctx.storage.set("spotify-lastTrackId", currentTrackId);
      await ctx.storage.set("spotify-lastLyricIndex", -1);
      await ctx.schedule.cancel("spotify-lyric");

      const lyricsData = await fetchFromBridge(ctx, config.bridgeUrl, "/lyrics");
      const syncedLyrics = lyricsData?.lyrics?.synced || null;

      ctx.log?.info?.("Lyrics fetch result", {
        hasPlain: !!lyricsData?.lyrics?.plain,
        hasSynced: !!syncedLyrics,
        syncedCount: syncedLyrics?.length ?? 0,
      });

      await ctx.storage.set("spotify-lyrics", syncedLyrics);

      if (syncedLyrics?.length) {
        await scheduleNextLyric(ctx, config, syncedLyrics, nowPlaying.progressMs ?? 0, -1);
      }
    } else {
      // Re-sync lyric position on each poll in case of drift
      const currentLyrics = await ctx.storage.get("spotify-lyrics");
      const lastShownIndex = Number(await ctx.storage.get("spotify-lastLyricIndex") ?? -1);
      if (currentLyrics?.length && nowPlaying.progressMs !== undefined) {
        const config2 = config; // already have config
        await scheduleNextLyric(ctx, config2, currentLyrics, nowPlaying.progressMs, lastShownIndex);
      }
    }

    await ctx.storage.set("spotify-lastPlaying", true);
    await ctx.status.set({ text: `Spotify: ${safeText(nowPlaying.title || "Unknown track", "Unknown track")} 🎶`, tone: "success" });

    if (manual && !trackChanged) {
      await ctx.pet.speak(format(config.announceTemplate || "Now playing: {title} by {artist}", {
        title: nowPlaying.title,
        artist: nowPlaying.artist,
      }));
    }
  } finally {
    pollRunning = false;
  }
}

async function scheduleNextLyric(ctx, config, lyrics, currentProgressMs, lastShownIndex) {
  await ctx.schedule.cancel("spotify-lyric");

  const lyricAdvanceMs = Number(config.lyricAdvanceMs ?? DEFAULT_LYRIC_ADVANCE_MS);

  // Find the next line after lastShownIndex whose timestamp is still in the future
  let nextIndex = -1;
  for (let i = lastShownIndex + 1; i < lyrics.length; i++) {
    if (lyrics[i].timestamp >= currentProgressMs - lyricAdvanceMs) {
      nextIndex = i;
      break;
    }
  }

  if (nextIndex === -1) {
    ctx.log?.info?.("No more lyric lines to schedule");
    return;
  }

  const nextLine = lyrics[nextIndex];
  const delayMs = Math.max(0, nextLine.timestamp - currentProgressMs - lyricAdvanceMs);

  ctx.log?.info?.("Scheduling lyric line", { nextIndex, text: nextLine.text, delayMs });

  await ctx.schedule.once("spotify-lyric", delayMs, async () => {
    await ctx.storage.set("spotify-lastLyricIndex", nextIndex);
    const cleanLine = sanitizeLyric(nextLine.text);
    ctx.log?.info?.("Showing scheduled lyric", { cleanLine, nextIndex });
    if (cleanLine) {
      await ctx.pet.speak(cleanLine);
      await ctx.status.set({ text: `🎵 ${cleanLine}`, tone: "info" });
    }

    // Schedule the next line
    const storedLyrics = await ctx.storage.get("spotify-lyrics");
    if (storedLyrics?.length) {
      const freshConfig = await ctx.config.get();
      // Use nextLine.timestamp as our current position estimate
      await scheduleNextLyric(ctx, freshConfig, storedLyrics, nextLine.timestamp, nextIndex);
    }
  });
}

async function showWhatsPlaying(ctx) {
  const config = await ctx.config.get();
  const nowPlaying = await fetchFromBridge(ctx, config.bridgeUrl, "/now-playing");

  if (!nowPlaying?.playing) {
    await ctx.pet.speak("Nothing is playing right now.");
    return;
  }

  await ctx.pet.speak(format(config.announceTemplate || "Now playing: {title} by {artist}", {
    title: nowPlaying.title,
    artist: nowPlaying.artist,
  }));
}

async function resetSpotifyState(ctx) {
  await ctx.schedule.cancel("spotify-lyric");
  await ctx.storage.delete("spotify-lastTrackId");
  await ctx.storage.delete("spotify-lastPlaying");
  await ctx.storage.delete("spotify-lyrics");
  await ctx.storage.delete("spotify-lastLyricIndex");
  await ctx.status.set({ text: "Spotify: state cleared", tone: "neutral" });
  await ctx.pet.speak("Spotify state has been reset.");
  await checkNow(ctx, false);
}

async function skipNext(ctx) {
  const config = await ctx.config.get();
  const result = await fetchFromBridge(ctx, config.bridgeUrl, "/next");
  if (result?.ok) {
    await ctx.pet.speak("Playing next track!");
    await checkNow(ctx, false);
  }
}

async function skipPrevious(ctx) {
  const config = await ctx.config.get();
  const result = await fetchFromBridge(ctx, config.bridgeUrl, "/previous");
  if (result?.ok) {
    await ctx.pet.speak("Playing previous track!");
    await checkNow(ctx, false);
  }
}

async function showLyrics(ctx) {
  const config = await ctx.config.get();
  const data = await fetchFromBridge(ctx, config.bridgeUrl, "/lyrics");

  if (!data) {
    await ctx.pet.speak("Couldn't reach Spotify bridge.");
    return;
  }

  if (!data.lyrics?.plain && !data.lyrics?.synced?.length) {
    await ctx.pet.speak("Sorry, I couldn't find lyrics for this song!");
    return;
  }

  // Use sanitizeLyric instead of safeText — no unsafe pattern check on lyrics
  const rawLyrics = data.lyrics.plain
    || data.lyrics.synced.map(l => l.text).join(" ");

  const cleaned = rawLyrics
    .replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const snippet = cleaned.length > 137
    ? cleaned.slice(0, 137).trim() + "..."
    : cleaned;

  const final = sanitizeLyric(snippet);

  if (final) {
    ctx.log?.info?.("showLyrics speaking", { final });
    await ctx.pet.speak(final);
  } else {
    await ctx.pet.speak("Sorry, I couldn't find lyrics for this song!");
  }
}

async function fetchFromBridge(ctx, bridgeUrl, path) {
  try {
    const url = `${String(bridgeUrl || "").replace(/\/+$/, "")}${path}`;
    ctx.log?.info?.("Fetching from bridge", { url });
    const res = await ctx.http.fetch(url, {
      headers: { "ngrok-skip-browser-warning": "true", "user-agent": "OpenPets Spotify Buddy" },
      timeoutMs: 10000,
    });
    ctx.log?.info?.("Bridge response", { status: res.status, ok: res.ok });
    if (!res.ok) {
      ctx.log?.warn?.("Bridge non-OK", res.status);
      return null;
    }
    return res.json || null;
  } catch (error) {
    ctx.log?.warn?.("Bridge fetch error", error?.message || String(error));
    return null;
  }
}

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

function safeText(value, fallback = "") {
  const message = typeof value === "string" && value.trim() ? value.trim().replace(/[\r\n]+/g, " ").replace(/\s+/g, " ") : fallback;
  const capped = message.length > MAX_ANNOUNCEMENT_LENGTH ? message.slice(0, MAX_ANNOUNCEMENT_LENGTH).trim() : message;
  if (!capped || UNSAFE_MESSAGE_PATTERN.test(capped)) return fallback;
  return capped;
}

function format(template, values) {
  return safeText(String(template).replace(/\{(title|artist)\}/g, (_m, key) => safeText(values[key] || "")));
}

function findLastIndex(arr, predicate) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i], i, arr)) {
      return i;
    }
  }
  return -1;
}