# Friendly Chat

A desktop app that merges live chat from Twitch and Kick into one unified window. Built with Electron.

![Platform Support](https://img.shields.io/badge/platform-Windows%20%7C%20Mac%20%7C%20Linux-blue)
![Version](https://img.shields.io/badge/version-1.1.0-green)

## What it does

Friendly Chat lets you watch and participate in Twitch and Kick chats in one place.

- View Twitch + Kick chats in a single feed
- Filter by platform
- Send messages to one or both platforms at once
- Load recent chat history when you join a channel
- Emote support including BTTV, 7TV, and native platform emotes
- Tab autocomplete for emotes (`:emote`) and mentions (`@username`)
- Click a username to reply, timeout, ban, or delete messages
- Adjustable font size that saves between sessions

## Download

Grab the latest installer for your platform from the [Releases](../../releases) page.

## Getting started

1. Launch Friendly Chat
2. Click **Accounts** and connect Twitch and/or Kick
3. Type a channel name and click **Join**
4. Start chatting

You can watch and read chats without signing in. Signing in is only required to send messages.

## Development

```bash
git clone https://github.com/JRBlaze/FriendlyChatElectronApp.git
cd FriendlyChatElectronApp
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
- [BTTV](https://betterttv.com) / [7TV](https://7tv.app) emotes
- [recent-messages.robotty.de](https://recent-messages.robotty.de) for Twitch chat history
