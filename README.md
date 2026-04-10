# Friendly Chat

A desktop app that merges live chat from Twitch, YouTube, and Kick into one unified window. Built with Electron.

![Platform Support](https://img.shields.io/badge/platform-Windows%20%7C%20Mac%20%7C%20Linux-blue)
![Version](https://img.shields.io/badge/version-1.0.20-green)

---

## What it does

Friendly Chat lets you watch and participate in Twitch, YouTube, and Kick chats all in one place — no switching between browser tabs. Connect your accounts once and you're good to go.

- View all three chats merged into a single feed
- Filter to show only the platforms you want
- Send messages to one, some, or all platforms at once
- Loads recent chat history when you join a channel
- Full emote support including BTTV, 7TV, and native platform emotes
- Tab autocomplete for emotes (`:emote`) and mentions (`@username`)
- Click a username to reply, timeout, ban, or delete messages
- Adjustable font size that saves between sessions

---

## Download

Grab the latest installer for your platform from the [Releases](../../releases) page:

- **Windows** — `Friendly-Chat-Setup-x.x.x.exe`
- **Mac** — `Friendly-Chat-x.x.x-arm64.dmg`
- **Linux** — `Friendly-Chat-x.x.x.AppImage`

No setup required — just install and launch.

### Mac Installation Note

If you see **"Friendly Chat is damaged and can't be opened"** when launching on Mac, this is due to Apple's Gatekeeper blocking unsigned apps. To fix it, open **Terminal** and run:

```
xattr -cr /Applications/Friendly\ Chat.app
```

Then try opening the app again. Alternatively go to **System Settings → Privacy & Security** and click **Open Anyway** if the option appears there.

---

## Getting started

1. Launch Friendly Chat
2. Click **Accounts** and connect Twitch, YouTube, and/or Kick
3. Type a channel name or YouTube video ID and click **Join**
4. Start chatting!

You can watch and read chats without signing in. Signing in is only required to send messages.

---

## Development

To run from source:

```bash
git clone https://github.com/JRBlaze/FriendlyChatElectronApp.git
cd FriendlyChatElectronApp
npm install
npm start
```

To build an installer:

```bash
npm run build        # Windows
npm run build:mac    # Mac
npm run build:linux  # Linux
```

### YouTube OAuth note

Friendly Chat uses OAuth authorization code + PKCE for YouTube so refresh
tokens can be used for silent renewals. Google's OAuth2 token endpoint
requires a `client_secret` during token exchange even for PKCE flows —
however, Google explicitly documents that the `client_secret` issued to
**Desktop app** OAuth clients is *not* confidential and is intended to be
embedded in the distributed app (see
<https://developers.google.com/identity/protocols/oauth2/native-app>).

Each user signs in with their own Google account, so API quota is per-user
and is **not** shared — no central service sees your tokens or your
requests.

**Setup:**

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create an OAuth 2.0 Client ID of type **Desktop app**.
2. Copy both the `client_id` and the `client_secret` into `config.json`:

   ```json
   {
     "youtube": {
       "client_id": "YOUR_CLIENT_ID",
       "client_secret": "YOUR_CLIENT_SECRET"
     }
   }
   ```

3. Enable the **YouTube Data API v3** for the same Google Cloud project.

Once connected, the app proactively refreshes the access token a few minutes
before Google's ~1 hour expiry, so the Connected state — and any joined
live chat — persists indefinitely without the user re-authorizing. Live
chat polling is also rate-limited to a 15-second minimum interval, keeping
the default 10,000-unit daily Data API quota alive for at least 8 hours of
continuous chat reading.

If `client_id` or `client_secret` is missing from `config.json`, token
exchange will fail and the YouTube connect button will remain in the
disconnected state with an inline error explaining what to add.

---

## Built with

- [Electron](https://www.electronjs.org)
- [Twitch IRC](https://dev.twitch.tv/docs/irc/)
- [YouTube Data API v3](https://developers.google.com/youtube/v3)
- [Kick Pusher WebSocket](https://kick.com)
- [BTTV](https://betterttv.com) / [7TV](https://7tv.app) emotes
- [recent-messages.robotty.de](https://recent-messages.robotty.de) for Twitch chat history
