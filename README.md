# OpenPets Spotify Buddy 🎶🐱

An OpenPets plugin that lets your desktop pet react to what's playing on Spotify!

## Features

- 📢 Announce track changes
- 😄 Mood-based reactions using Spotify audio features
- ⏭️ Skip to next/previous track
- 🔄 Track playback status
- 📝 Fetch and recite lyrics snippet for current song!

## Prerequisites

1. **OpenPets installed** (from [GitHub Releases](https://github.com/alvinunreal/openpets/releases))
2. **Spotify Developer Account** (free)
3. **Node.js 18+** installed

## Setup Guide

### 1. Create a Spotify Developer App
1. Go to [Spotify for Developers Dashboard](https://developer.spotify.com/dashboard)
2. Click "Create App"
3. Fill out the form:
   - App name: `OpenPets Spotify Buddy`
   - App description: `Let your OpenPet react to Spotify`
   - Redirect URI: `http://127.0.0.1:8765/callback`
4. Click "Save"
5. Go to "Settings" and copy your `Client ID` and `Client Secret`

### 2. Configure the Spotify Bridge
1. Open `spotify-bridge/.env.example`
2. Copy it to `spotify-bridge/.env`
3. Paste your `Client ID` and `Client Secret` into the .env file:
   ```
   SPOTIFY_CLIENT_ID=your-client-id
   SPOTIFY_CLIENT_SECRET=your-client-secret
   SPOTIFY_BRIDGE_PORT=8765
   ```

### 3. Install Dependencies
```bash
npm install
```

### 4. Start the Services
You'll need to keep **both** of these running:
1. **Start the Spotify Bridge**
   ```bash
   cd spotify-bridge
   node start.js
   ```
   If this is your first time, it will open a browser to authenticate your Spotify account!

2. **Start ngrok (for OpenPets plugin HTTPS access)**
   ```bash
   ngrok http 8765
   ```
   Copy the HTTPS URL from the ngrok output, e.g., `https://abc123.ngrok-free.app`

### 5. Configure & Load the Plugin in OpenPets
1. First, edit `openpets.spotify-buddy/openpets.plugin.json`
   - Add your ngrok URL to the `network.hosts` array, e.g.:
     ```json
     "network": { "hosts": ["abc123.ngrok-free.app"] }
     ```
   - Also update the `bridgeUrl.default` value to your full ngrok URL:
     ```json
     "bridgeUrl": {
       "type": "text",
       "label": "Spotify Bridge URL (ngrok HTTPS)",
       "default": "https://abc123.ngrok-free.app",
       "description": "Your ngrok HTTPS URL, e.g. https://abc123.ngrok-free.app"
     }
     ```

2. Open OpenPets from your desktop shortcut
3. Go to the tray menu → **Plugins**
4. Click **Load Local Plugin**
5. Select the `openpets.spotify-buddy` directory
6. Click the plugin to open its settings
7. Verify the **Spotify Bridge URL** is set correctly
8. Enable the plugin!

### 6. Optional: Use the Standalone Client
If the plugin isn't working for you, you can use the standalone Node.js client!
```bash
node spotify-openpets.js
```
You can skip tracks by typing `next` or `prev` in the terminal!

## Troubleshooting

- **"Couldn't reach Spotify Bridge"**: Make sure both the Spotify Bridge and ngrok are running!
- **"Cannot skip tracks"**: Re-authorize Spotify by going to `http://127.0.0.1:8765/logout` then `http://127.0.0.1:8765/login`
- **"Plugin isn't loading"**: Make sure `OPENPETS_DEV_PLUGIN_PATHS` environment variable is set if you're not using "Load Local Plugin"!

## Plugin Manifest

```json
{
  "manifestVersion": 2,
  "id": "openpets.spotify-buddy",
  "name": "Spotify Buddy",
  "description": "Your pet reacts to what's playing on Spotify.",
  "version": "1.3.0",
  "runtime": "javascript",
  "icon": "sparkles",
  "sdkVersion": "1.0.0",
  "entry": "index.js",
  "permissions": ["network", "schedule", "storage", "pet:speak", "pet:reaction", "commands", "status"],
  "network": { "hosts": ["your-ngrok-url.ngrok-free.app"] },
  "configSchema": {
    "bridgeUrl": {
      "type": "text",
      "label": "Spotify Bridge URL",
      "default": "https://your-ngrok-url.ngrok-free.app"
    },
    "pollIntervalSeconds": { "type": "number", "label": "Poll interval (seconds)", "default": 30, "min": 10, "max": 300, "step": 5 },
    "announceTrackChanges": { "type": "boolean", "label": "Announce track changes", "default": true },
    "reactToMood": { "type": "boolean", "label": "React to track mood", "default": true },
    "reactWhenPaused": { "type": "boolean", "label": "React when paused", "default": true },
    "announceTemplate": { "type": "text", "label": "Announcement template", "default": "Now playing: {title} by {artist}", "maxLength": 140 }
  }
}
```

## License

MIT
