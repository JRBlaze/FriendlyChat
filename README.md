# Friendly Chat

A desktop app that merges live chat from Twitch, Kick, and YouTube into one unified window. Built with Electron.

![Platform Support](https://img.shields.io/badge/platform-Windows%20%7C%20Mac%20%7C%20Linux-blue)
![Version](https://img.shields.io/badge/version-1.2.1-green)

## What it does

Friendly Chat lets you watch and participate in Twitch, Kick, and YouTube chats in one place.

- View Twitch + Kick + YouTube chats in a single feed
- Filter by platform
- Send messages to one or both platforms at once
- Load recent chat history when you join a channel
- Emote support including BTTV, 7TV, and native platform emotes
- Tab autocomplete for emotes (`:emote`) and mentions (`@username`)
- Click a username to reply, timeout, ban, or delete messages
- Adjustable font size that saves between sessions

## Download

Grab the latest installer for your platform from the [Releases](../../releases) page.

### Mac Installation Note

If you see **"Friendly Chat is damaged and can't be opened"** when launching on Mac, this is due to Apple's Gatekeeper blocking unsigned apps. To fix it, open **Terminal** and run:

```
xattr -cr /Applications/Friendly\ Chat.app
```

Then try opening the app again. Alternatively go to **System Settings → Privacy & Security** and click **Open Anyway** if the option appears there.

## Getting started

1. Launch Friendly Chat
2. Click **Accounts** and connect Twitch, Kick, and/or YouTube
3. Type a channel name and click **Join**
4. Start chatting

You can watch and read chats without signing in. Signing in is only required to send messages.

## Kick OAuth setup (no Railway required)

Friendly Chat now performs Kick token exchange locally, so you do **not** need to deploy a Railway/Render proxy.

1. Create a Kick OAuth application in the Kick developer dashboard.
2. Set the app redirect URL to:
   - `http://localhost:8080/friendly-chat.html`
3. Open `config.json` and add your Kick credentials:

```json
{
  "twitch": { "client_id": "YOUR_TWITCH_CLIENT_ID" },
  "kick": {
    "client_id": "YOUR_KICK_CLIENT_ID",
    "client_secret": "YOUR_KICK_CLIENT_SECRET"
  },
  "port": 8080
}
```

If `kick.client_id` or `kick.client_secret` is missing, Kick sign-in will be disabled until they are provided.

## YouTube OAuth setup (bring your own Google OAuth client)

Friendly Chat supports YouTube live chat by using **your own Google OAuth client ID**.

1. Open Google Cloud Console and create/select a project.
2. Enable **YouTube Data API v3** for that project.
3. Create an OAuth client ID (Desktop app or Web app works for local development).
4. Add this redirect URI to the OAuth client:
   - `http://localhost:8080/friendly-chat.html`
5. Add your client ID to `config.json`:

```json
{
  "twitch": { "client_id": "YOUR_TWITCH_CLIENT_ID" },
  "kick": {
    "client_id": "YOUR_KICK_CLIENT_ID",
    "client_secret": "YOUR_KICK_CLIENT_SECRET"
  },
  "youtube": {
    "client_id": "YOUR_GOOGLE_OAUTH_CLIENT_ID"
  },
  "port": 8080
}
```

If `youtube.client_id` is missing, YouTube sign-in will be disabled until it is provided.

### YouTube quota behavior (10-hour session safety)

The default YouTube Data API allocation is typically **10,000 units/day**. To reduce the chance of quota exhaustion during long sessions, Friendly Chat now enforces a **minimum YouTube poll interval of 20 seconds** when reading live chat. This keeps chat polling around ~1,800 calls over 10 hours, which is designed to stay within typical daily quota limits for most single-session use.

You can still request additional quota from Google if you need higher throughput.

## Development

```bash
git clone https://github.com/JRBlaze/FriendlyChat.git
cd FriendlyChat
npm install
npm start
```

Build installers:

```bash
npm run build
npm run build:mac
npm run build:linux
```

## Built with

- [Electron](https://www.electronjs.org)
- [Twitch IRC](https://dev.twitch.tv/docs/irc/)
- [Kick Pusher WebSocket](https://kick.com)
- [YouTube Data API v3](https://developers.google.com/youtube/v3)
- [BTTV](https://betterttv.com) / [7TV](https://7tv.app) emotes
- [recent-messages.robotty.de](https://recent-messages.robotty.de) for Twitch chat history
