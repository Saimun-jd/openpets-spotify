import { createOpenPetsClient, allowedReactions } from "@open-pets/client";
import https from "https";
import http from "http";

const POLL_INTERVAL_MS = 15000;
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8765";
const NGROK_BRIDGE_URL = "https://6b36-103-132-185-215.ngrok-free.app";
const BRIDGE_URL = process.env.SPOTIFY_BRIDGE_URL || NGROK_BRIDGE_URL;

let lastTrackId = null;
let lastPlaying = false;

function safeText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  if (/^https?:\/\//i.test(text)) return fallback;
  if (/\b(const|let|var|function|class|import|export)\b/.test(text)) return fallback;
  if (/\b(token|secret|password|api[_-]?key)\b/i.test(text)) return fallback;
  return text.slice(0, 140);
}

function buildAnnouncement(title, artist) {
  const cleanTitle = safeText(title, "Unknown track");
  const cleanArtist = safeText(artist, "Unknown artist");
  return safeText(`Now playing: ${cleanTitle} by ${cleanArtist}`);
}

function featuresToReaction(features) {
  if (!features) return "working";
  const energy = Number(features.energy ?? 0);
  const valence = Number(features.valence ?? 0);
  const tempo = Number(features.tempo ?? 0);

  if (energy >= 0.8 && valence >= 0.65 && tempo >= 140) return "celebrating";
  if (energy >= 0.75 && valence <= 0.35 && tempo >= 140) return "running";
  if (valence >= 0.7 && energy <= 0.55) return "waving";
  if (energy <= 0.35 && valence <= 0.4) return "thinking";
  return "working";
}

function requestBridge(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BRIDGE_URL}${path}`);
    const client = url.protocol === "https:" ? https : http;

    const req = client.request(
      url,
      {
        method,
        headers: { "ngrok-skip-browser-warning": "true" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        });
      }
    );

    req.on("error", (e) => reject(new Error(`Failed to fetch: ${e.message}`)));
    req.end();
  });
}

function fetchNowPlaying() {
  return requestBridge("/now-playing");
}

function skipNext() {
  return requestBridge("/next");
}

function skipPrevious() {
  return requestBridge("/previous");
}

async function handlePoll(client) {
  try {
    const nowPlaying = await fetchNowPlaying();
    if (!nowPlaying) {
      console.log("[spotify-openpets] No response from bridge");
      return;
    }

    if (!nowPlaying.playing) {
      if (lastPlaying) {
        console.log("[spotify-openpets] Music stopped");
        await client.react("idle");
      }
      lastPlaying = false;
      lastTrackId = null;
      return;
    }

    const trackChanged = Boolean(nowPlaying.trackId && nowPlaying.trackId !== lastTrackId);
    lastPlaying = true;
    lastTrackId = nowPlaying.trackId;

    if (trackChanged) {
      const announcement = buildAnnouncement(nowPlaying.title, nowPlaying.artist);
      const reaction = featuresToReaction(nowPlaying.features);

      console.log(`[spotify-openpets] New track: ${announcement}`);
      await client.say(announcement);
      if (allowedReactions.includes(reaction)) {
        await client.react(reaction);
      } else {
        await client.react("working");
      }
    } else {
      console.log(`[spotify-openpets] Still playing: ${safeText(nowPlaying.title, "Unknown track")}`);
    }
  } catch (e) {
    console.error(`[spotify-openpets] Poll failed: ${e.message}`);
  }
}

async function main() {
  try {
    const client = createOpenPetsClient({ responseTimeoutMs: 10000 });

    const status = await client.status();
    if (!status.ok || !status.appRunning) {
      console.error("[spotify-openpets] OpenPets app is not running!");
      process.exit(1);
    }

    console.log(`[spotify-openpets] Connected to OpenPets, polling every ${POLL_INTERVAL_MS / 1000}s`);
    console.log("[spotify-openpets] Commands available: next, prev, stop");

    // Set up stdin for user commands
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", async (data) => {
      const cmd = data.toString().trim().toLowerCase();
      if (cmd === "next" || cmd === "n") {
        try {
          await skipNext();
          console.log("[spotify-openpets] Skipped to next track");
        } catch (e) {
          console.error("[spotify-openpets] Skip failed:", e.message);
        }
      } else if (cmd === "prev" || cmd === "p") {
        try {
          await skipPrevious();
          console.log("[spotify-openpets] Skipped to previous track");
        } catch (e) {
          console.error("[spotify-openpets] Skip failed:", e.message);
        }
      } else if (cmd === "stop" || cmd === "exit") {
        process.exit(0);
      }
    });

    await handlePoll(client);
    setInterval(() => handlePoll(client), POLL_INTERVAL_MS);
  } catch (e) {
    console.error(`[spotify-openpets] Failed to start: ${e.message}`);
    process.exit(1);
  }
}

main();
