# OpenPets Spotify Buddy 🎶🐱

A fully native, standalone OpenPets plugin that lets your desktop pet react to what's playing on Spotify! 

Spotify Buddy connects directly to your Spotify account using OpenPets SDK v3. It requires no external background servers, no Node.js installations, and no complicated local network tunneling. Everything happens right on your desktop securely!

## Features

- 📢 **Live Track Announcements:** Your pet will tell you what's currently playing as tracks change.
- 😄 **Mood-based Reactions:** Your pet reacts dynamically based on the track's tempo, energy, and valence.
- ⏭️ **Playback Control:** Play, pause, skip, and go back tracks using the pet's right-click context menu.
- 📝 **Live Lyrics:** Ask your pet to recite a snippet of the lyrics for the current song in a sleek UI bubble!
- 🔒 **Secure & Native:** Uses PKCE OAuth directly within OpenPets. Your data and tokens never leave your machine.

## Installation

1. **Download the Plugin:** Download the `openpets.spotify-buddy` directory (or extract the `.zip` file).
2. **Install in OpenPets:** 
   - Open your OpenPets desktop app.
   - Go to the tray menu → **Plugins**.
   - Click **Load Local Plugin** and select the `openpets.spotify-buddy` folder.
3. **Enable the Plugin:** Toggle the plugin to `ON`. OpenPets will ask you to approve a few permissions (network, storage, ui, etc.).

## Connect to Spotify

1. Right-click your pet and select **Login to Spotify**.
2. A browser window will open asking you to authorize the app.
3. Once authorized, it will redirect back to OpenPets. Your pet is now connected!
4. Start playing a song on Spotify (on your PC or phone) and click **Check Spotify Now** from the pet's menu.

## Troubleshooting

- **"User is not registered for this application"**: You forgot to add your Spotify email address to the User Management section of your Spotify Developer Dashboard.
- **"Invalid Redirect URI"**: You typed the redirect URI wrong in the Spotify Dashboard. It must be exactly `http://127.0.0.1:48373/callback`.
- **"No active playback session found"**: The plugin can only read what's playing if you have a Spotify app open (somewhere on any device) with an active or recently paused session.

## License
MIT
