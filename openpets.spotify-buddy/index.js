const DEFAULT_POLL_INTERVAL_SECONDS = 30;
const MIN_POLL_INTERVAL_SECONDS = 10;
const MAX_ANNOUNCEMENT_LENGTH = 140;
const EMPTY_TRACK_ID = "__no_track__";
const UNSAFE_MESSAGE_PATTERN = /```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b|https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\|api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]+PRIVATE KEY/i;

let pollRunning = false;

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
      }

      await ctx.storage.set("spotify-lastTrackId", currentTrackId);
    }

    await ctx.storage.set("spotify-lastPlaying", true);
    await ctx.status.set({ text: `Spotify: ${safeText(nowPlaying.title || "Unknown track", "Unknown track")}`, tone: "success" });

    if (manual && !trackChanged) {
      await ctx.pet.speak(format(config.announceTemplate || "Now playing: {title} by {artist}", {
        title: nowPlaying.title,
        artist: nowPlaying.artist,
      }));
    }

    await scheduleNext(ctx);
  } finally {
    pollRunning = false;
  }
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
  await ctx.storage.delete("spotify-lastTrackId");
  await ctx.storage.delete("spotify-lastPlaying");
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

async function fetchFromBridge(ctx, bridgeUrl, path) {
  try {
    const url = `${String(bridgeUrl || "").replace(/\/+$/, "")}${path}`;
    ctx.log?.info?.("Attempting to fetch from bridge", { url });
    const res = await ctx.http.fetch(url, {
      headers: { "ngrok-skip-browser-warning": "true", "user-agent": "OpenPets Spotify Buddy" },
      timeoutMs: 10000,
    });
    ctx.log?.info?.("Bridge response received", { status: res.status, ok: res.ok, hasJson: !!res.json });

    if (!res.ok) {
      ctx.log?.warn?.("Spotify bridge fetch failed", res.status);
      return null;
    }
    return res.json || null;
  } catch (error) {
    ctx.log?.warn?.("Spotify bridge unreachable", error?.message || String(error), { error });
    return null;
  }
}

function featuresToReaction(features) {
  if (!features) return "working";
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
