# OpenPets Spotify Buddy

Your OpenPets pet reacts to whatever you're listening to on Spotify — announcing track changes and matching its mood to the music's energy.

```
spotify-bridge/          ← local OAuth bridge (runs once, stays running)
openpets.spotify-buddy/  ← OpenPets plugin (loaded by the desktop app)
```

---

## How it works

```
Spotify API
    ↓  OAuth (Authorization Code Flow)
spotify-bridge/server.js   ← Node.js, runs on localhost:8765
    ↓  GET /now-playing  (GET-only, no secrets cross to the plugin)
openpets.spotify-buddy/index.js  ← sandboxed OpenPets plugin
    ↓  pet.speak() / pet.react()
Your desktop pet
```

The bridge handles all OAuth and token refresh. The plugin never sees your access token — it only receives a sanitised JSON payload from your tunnel endpoint.

---

## Mood → Reaction mapping

| Music vibe | Audio features | Pet reaction |
|---|---|---|
| Hype / party | High energy + positive + fast BPM | `celebrating` (jumping) |
| Intense / heavy | High energy + dark/angry | `running` |
| Happy + light | Positive valence + low energy | `waving` |
| Sad / reflective | Quiet + dark + acoustic | `thinking` (review) |
| Ambient / lo-fi | Quiet + mostly instrumental | `waiting` |
| Neutral / driving | Everything else | `working` |
| Paused | Nothing playing | `idle` (if enabled) |

---

## Setup

### 1. Create a Spotify app

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Click **Create app**
3. Set **Redirect URI** to: `http://localhost:8765/callback`
4. Copy your **Client ID** and **Client Secret**

### 2. Configure and start the bridge

```bash
cd spotify-bridge
cp .env.example .env
# Edit .env and paste your Client ID + Client Secret
node start.js
```

The bridge starts on `http://localhost:8765`. You still need a public tunnel in front of it for OpenPets to reach `/now-playing`.

### 3. Authorise with Spotify

Open **http://localhost:8765/login** in your browser. You'll be redirected to Spotify, grant permission, then redirected back. The bridge saves tokens to `.tokens.json` and auto-refreshes them — you only do this once.

### 4. Load the plugin in OpenPets

**Option A — Dev load (recommended for local use):**

```bash
# From the openpets repo root:
OPENPETS_DEV_PLUGIN_PATHS=/absolute/path/to/openpets.spotify-buddy pnpm dev:desktop
```

**Option B — Via env variable (persistent):**

Add to your shell profile:
```bash
export OPENPETS_DEV_PLUGIN_PATHS=/absolute/path/to/openpets.spotify-buddy
```

Then launch OpenPets normally. Open **Tray → Plugins**, find "Spotify Buddy", and enable it. Approve the permissions it requests (network, schedule, storage, pet:speak, pet:reaction, status, commands).

If you change your ngrok URL, update both `bridgeUrl` and `network.hosts` in `openpets.plugin.json` to the new hostname before reloading the plugin.

---

## Configuration (in OpenPets Plugins UI)

| Field | Default | Description |
|---|---|---|
| Bridge URL | `https://6b36-103-132-185-215.ngrok-free.app` | Public tunnel URL OpenPets can reach |
| Poll interval | 15s | How often to check Spotify (min 10s) |
| Announce track changes | ✓ | Pet speaks the song + artist on track change |
| React to music mood | ✓ | Pet changes reaction based on audio features |
| React when playback stops | ✗ | Pet reacts idle when music pauses |
| Track announcement message | `Now playing: {title} by {artist}` | Template; use `{title}` and `{artist}` |

---

## Pet commands (right-click the pet)

| Command | What it does |
|---|---|
| **Check Spotify now** | Immediately polls and updates pet state |
| **What's playing?** | Pet speaks the current track aloud |
| **Reset Spotify state** | Clears stored track state; next poll treats everything as new |

---

## Bridge endpoints

| Endpoint | Description |
|---|---|
| `GET /now-playing` | Current Spotify state (used by plugin) |
| `GET /status` | Bridge health + auth state |
| `GET /login` | Start OAuth flow |
| `GET /logout` | Revoke stored tokens |
| `GET /callback` | OAuth redirect (handled automatically) |

---

## Running tests

```bash
cd openpets.spotify-buddy
node test.js
```

---

## Troubleshooting

**Pet says "I cannot reach the Spotify bridge"**
→ Make sure `node start.js` is running in `spotify-bridge/` and the port matches your config.

**Bridge says "Not authorised"**
→ Visit `http://localhost:8765/login` in your browser.

**Token expired after an hour**
→ This shouldn't happen — the bridge auto-refreshes 30 seconds before expiry. If it does, visit `/login` again.

**Plugin shows "bridge unreachable" status but bridge is running**
→ Check that the tunnel hostname in your plugin config matches `network.hosts` in `openpets.plugin.json` exactly. OpenPets only allows exact public hosts through the plugin SDK.

**No mood reactions / always "working"**
→ The Spotify Audio Features API requires Spotify Premium or may be unavailable for some tracks. The plugin falls back to `working` gracefully when features are missing.

---

## Security notes

- The bridge binds to `127.0.0.1` only — it is never reachable from the network without a tunnel.
- `.tokens.json` stores your Spotify refresh token locally. Do not commit it to version control (it is gitignored by default if you copy `.gitignore`).
- The plugin sandbox only ever receives sanitised track metadata — no credentials, no tokens.
