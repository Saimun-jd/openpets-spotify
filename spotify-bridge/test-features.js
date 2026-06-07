
import http from "node:http";
import https from "node:https";

const trackId = "7wI0FB99yBoUmzIsTlN2xJ";

// First get current access token from the bridge (from .tokens.json or by hitting /now-playing)
// Let's use /status first
const reqStatus = http.get("http://127.0.0.1:8765/status", (resStatus) => {
  let dataStatus = "";
  resStatus.on("data", (chunk) => (dataStatus += chunk));
  resStatus.on("end", async () => {
    const statusData = JSON.parse(dataStatus);
    console.log("Status data:", statusData);

    // Now load tokens from .tokens.json directly
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const tokensPath = path.join(__dirname, ".tokens.json");
    const tokens = JSON.parse(fs.readFileSync(tokensPath, "utf-8"));
    console.log("Loaded tokens:", { ...tokens, access_token: tokens.access_token.slice(0, 20) + "..." });

    // Now fetch audio features directly!
    const audioFeaturesRes = await new Promise((resolve, reject) => {
      const reqAudio = https.get(
        `https://api.spotify.com/v1/audio-features/${trackId}`,
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ statusCode: res.statusCode, data }));
        }
      );
      reqAudio.on("error", reject);
    });
    console.log("Audio features status:", audioFeaturesRes.statusCode);
    console.log("Audio features response:", audioFeaturesRes.data);
  });
});
reqStatus.on("error", (e) => console.error("Error:", e));
