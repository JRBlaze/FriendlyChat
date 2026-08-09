// Friendly Chat - Local Server
// Kick OAuth token exchange and refresh are forwarded to the Cloudflare Worker
// whose URL is stored in config.json as kick.proxy_url.
//
// The server also proxies the requests the renderer cannot make itself:
//   * Kick send / moderation (needs the user's bearer token off the page)
//   * YouTube channel resolution and live chat polling (cross-origin, no CORS)

const http = require('http');
const fs   = require('fs');
const path = require('path');
const yt   = require('./youtube');

// Single source of truth for the version the app shows in its title bar.
let APP_VERSION = '';
try { APP_VERSION = require('./package.json').version || ''; } catch(_) {}

// Only asset types the renderer actually loads are served. JSON is absent on
// purpose: config.json is exposed through /config with just its public fields,
// and package.json has no business being reachable over HTTP.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
};

// Node entry points live in the same folder as the served assets.
const PRIVATE_FILES = new Set(['main.js', 'server.js', 'preload.js', 'youtube.js', 'config.json', 'package.json', 'package-lock.json']);

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB is far more than any request needs

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if(size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch(e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function start(CFG = {}) {
  const PORT      = CFG.port || 8080;
  const PROXY_URL = (CFG.kick?.proxy_url || '').replace(/\/$/, '');
  const HAS_KICK  = !!PROXY_URL;
  const ROOT      = __dirname;

  // Fetch and cache the Kick public client_id from the Cloudflare Worker
  let kickClientId = '';
  if (PROXY_URL) {
    fetch(`${PROXY_URL}/kick-config`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.client_id) kickClientId = d.client_id; })
      .catch(e => console.warn('  [proxy] Could not reach Kick proxy:', e.message));
  }

  const staticCache = new Map();

  // videoId -> { apiKey, clientVersion, visitorData, continuation, ts }
  // Bootstrapping the live chat page is expensive, so the InnerTube handshake is
  // reused for every poll of the same video.
  const ytSessions = new Map();
  const YT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
  const YT_SESSION_LIMIT  = 12;

  function pruneYouTubeSessions() {
    const now = Date.now();
    for(const [key, value] of ytSessions) {
      if(now - value.ts > YT_SESSION_TTL_MS) ytSessions.delete(key);
    }
    while(ytSessions.size > YT_SESSION_LIMIT) {
      ytSessions.delete(ytSessions.keys().next().value);
    }
  }

  const server = http.createServer(async (req, res) => {
    let requestUrl;
    try {
      requestUrl = new URL(req.url, `http://localhost:${PORT}`);
    } catch(_) {
      res.writeHead(400); res.end('Bad request'); return;
    }
    const pathname = requestUrl.pathname;

    const sendJson = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };

    res.setHeader('Access-Control-Allow-Origin',  `http://localhost:${PORT}`);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if(req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── /config — public credentials only ───────────────────────────────────
    if(pathname === '/config' && req.method === 'GET') {
      if(PROXY_URL && !kickClientId) {
        try {
          const r = await fetch(`${PROXY_URL}/kick-config`);
          if(r.ok) { const d = await r.json(); if(d?.client_id) kickClientId = d.client_id; }
        } catch(e) {}
      }
      sendJson(200, {
        twitch:   { client_id: CFG.twitch?.client_id || '' },
        kick:     { client_id: kickClientId },
        has_kick: HAS_KICK,
        port:     PORT,
        version:  APP_VERSION,
      });
      return;
    }

    // ── /kick-token — forward PKCE code exchange to the Cloudflare Worker ───
    if(pathname === '/kick-token' && req.method === 'POST') {
      if(!HAS_KICK) {
        sendJson(503, { error: 'kick.proxy_url not set in config.json' });
        return;
      }
      try {
        const { code, code_verifier, redirect_uri } = await readBody(req);
        const proxyRes = await fetch(`${PROXY_URL}/kick-token`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            code,
            code_verifier,
            // The renderer knows the exact URI it authorised with; fall back to
            // the canonical one so older callers keep working.
            redirect_uri: redirect_uri || `http://localhost:${PORT}/friendly-chat.html`,
          }),
        });
        const data = await proxyRes.json();
        sendJson(proxyRes.status, data);
      } catch(e) {
        sendJson(500, { error: e.message });
      }
      return;
    }

    // ── /kick-refresh — forward token refresh to the Cloudflare Worker ───────
    if(pathname === '/kick-refresh' && req.method === 'POST') {
      if(!HAS_KICK) {
        sendJson(503, { error: 'kick.proxy_url not set in config.json' });
        return;
      }
      try {
        const { refresh_token } = await readBody(req);
        const proxyRes = await fetch(`${PROXY_URL}/kick-refresh`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ refresh_token }),
        });
        const data = await proxyRes.json();
        sendJson(proxyRes.status, data);
      } catch(e) {
        sendJson(500, { error: e.message });
      }
      return;
    }
    // ── /kick-send — uses user's own access token, no secret needed ──────────
    if(pathname === '/kick-send' && req.method === 'POST') {
      try {
        const { token, text, broadcasterId } = await readBody(req);
        if(!broadcasterId) {
          sendJson(400, { error: 'No broadcaster ID — leave and rejoin the channel' });
          return;
        }
        const sendRes = await fetch('https://api.kick.com/public/v1/chat', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ type: 'user', content: text, broadcaster_user_id: Number(broadcasterId) }),
        });
        const sendData = await sendRes.json().catch(() => ({}));
        if(!sendRes.ok) {
          sendJson(sendRes.status, { error: sendData.message || 'send failed' });
          return;
        }
        sendJson(200, { is_sent: sendData.data?.is_sent ?? true });
      } catch(e) {
        sendJson(500, { error: e.message });
      }
      return;
    }

    // ── /kick-mod — uses user's own access token, no secret needed ───────────
    if(pathname === '/kick-mod' && req.method === 'POST') {
      try {
        const { token, broadcasterId, action, username, duration, messageId } = await readBody(req);

        if(action === 'delete') {
          const deleteRes = await fetch(`https://api.kick.com/public/v1/chat/${encodeURIComponent(messageId)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const deleteData = await deleteRes.json().catch(() => ({}));
          if(!deleteRes.ok) {
            sendJson(deleteRes.status, { error: deleteData.message || 'delete action failed' });
            return;
          }
          sendJson(200, { ok: true });
          return;
        }

        // Resolve user_id from username when needed.
        let targetUserId = null;
        if(username) {
          const channelLookup = await fetch(`https://kick.com/api/v1/channels/${encodeURIComponent(username)}`);
          if(channelLookup.ok) {
            const channelData = await channelLookup.json().catch(() => ({}));
            targetUserId = Number(channelData.user_id) || null;
          }
        }

        // Kick moderation API accepts duration in minutes for timeout.
        const timeoutMinutes = Math.max(1, Math.ceil((Number(duration) || 0) / 60));
        const modBody = { broadcaster_user_id: Number(broadcasterId) };
        if(targetUserId) modBody.user_id = targetUserId;
        if(action === 'timeout') modBody.duration = timeoutMinutes;
        if(!modBody.user_id) {
          sendJson(400, { error: 'Could not resolve user ID for moderation target' });
          return;
        }

        const method = action === 'unban' ? 'DELETE' : 'POST';
        const modRes = await fetch('https://api.kick.com/public/v1/moderation/bans', {
          method,
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(modBody),
        });
        const data = await modRes.json().catch(() => ({}));
        if(!modRes.ok) {
          sendJson(modRes.status, { error: data.message || 'mod action failed' });
          return;
        }
        sendJson(200, { ok: true, action });
      } catch(e) {
        sendJson(500, { error: e.message });
      }
      return;
    }

    // ── /kick-emotes — server-side fallback when the Electron IPC path is
    //     unavailable (for example when the app is opened in a browser). Kick
    //     sits behind Cloudflare so this can legitimately fail; the renderer
    //     then falls back to collecting emotes from live messages.
    if(pathname === '/kick-emotes' && req.method === 'GET') {
      const channel = (requestUrl.searchParams.get('channel') || '').trim();
      if(!channel) { sendJson(400, { error: 'channel is required' }); return; }

      const slug = encodeURIComponent(channel);
      const endpoints = [
        `https://kick.com/emotes/${slug}`,
        `https://kick.com/api/v2/channels/${slug}/emotes`,
      ];
      let lastStatus = 0;
      let lastError = '';

      for(const endpoint of endpoints) {
        try {
          const emoteRes = await fetch(endpoint, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept': 'application/json',
              'Accept-Language': 'en-US,en;q=0.9',
            },
          });
          if(!emoteRes.ok) { lastStatus = emoteRes.status; continue; }
          const data = await emoteRes.json();
          if(data) { sendJson(200, { data }); return; }
        } catch(e) {
          lastError = e.message;
        }
      }

      if(lastStatus) sendJson(lastStatus, { error: `Kick returned HTTP ${lastStatus}` });
      else sendJson(502, { error: lastError || 'Kick emote lookup failed' });
      return;
    }

    // ── /youtube-resolve — channel name / handle / URL → live video id ───────
    if(pathname === '/youtube-resolve' && req.method === 'GET') {
      const query = (requestUrl.searchParams.get('q') || '').trim();
      try {
        const resolved = await yt.resolveLiveVideo(query);
        sendJson(200, resolved);
      } catch(e) {
        sendJson(404, { error: e.message });
      }
      return;
    }

    // ── /youtube-chat — bootstrap + poll YouTube live chat ──────────────────
    if(pathname === '/youtube-chat' && req.method === 'POST') {
      try {
        const { videoId, continuation } = await readBody(req);
        if(!yt.VIDEO_ID_RE.test(String(videoId || ''))) {
          sendJson(400, { error: 'Invalid YouTube video id' });
          return;
        }

        pruneYouTubeSessions();
        let session = ytSessions.get(videoId);
        let bootstrapped = null;

        if(!session || (!continuation && !session.continuation)) {
          bootstrapped = await yt.bootstrapLiveChat(videoId);
          session = {
            apiKey:        bootstrapped.apiKey,
            clientVersion: bootstrapped.clientVersion,
            visitorData:   bootstrapped.visitorData,
            continuation:  bootstrapped.continuation,
            ts:            Date.now(),
          };
          ytSessions.set(videoId, session);
        }

        const cursor = continuation || session.continuation;
        const polled = await yt.pollLiveChat({ ...session, continuation: cursor });

        session.continuation = polled.continuation || '';
        session.ts = Date.now();

        sendJson(200, {
          messages:     polled.messages,
          removals:     polled.removals,
          continuation: polled.continuation,
          pollMs:       polled.pollMs,
          ended:        polled.ended,
          emotes:       { ...(bootstrapped?.emojis || {}), ...(polled.emojis || {}) },
          title:        bootstrapped?.title || undefined,
          bootstrapped: !!bootstrapped,
        });
      } catch(e) {
        sendJson(502, { error: e.message });
      }
      return;
    }

    // ── Static file serving ──────────────────────────────────────────────────
    if(req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(405, { error: 'Method not allowed' });
      return;
    }

    let relative;
    try {
      relative = pathname === '/' ? 'friendly-chat.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch(_) {
      res.writeHead(400); res.end('Bad request'); return;
    }
    const filePath = path.resolve(ROOT, relative);
    // Never serve anything outside the app directory, an unexpected file type,
    // or one of the server-side sources.
    if(!filePath.startsWith(ROOT + path.sep)
       || !MIME[path.extname(filePath).toLowerCase()]
       || PRIVATE_FILES.has(path.basename(filePath))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    const cached = staticCache.get(filePath);
    if(cached) {
      res.writeHead(200, { 'Content-Type': cached.mime, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : cached.data);
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if(err) { res.writeHead(404); res.end('Not found'); return; }
      const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      staticCache.set(filePath, { mime, data });
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });

  server.on('error', (err) => {
    if(err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use — is Friendly Chat already running?\n`);
    } else {
      console.error('  Friendly Chat server error:', err.message);
    }
  });

  // Bind to loopback only: these endpoints forward the signed-in user's tokens,
  // so they must never be reachable from the local network.
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Friendly Chat running on http://localhost:${PORT}\n`);
    if(!HAS_KICK) console.log('  ⚠  kick.proxy_url not set in config.json — Kick OAuth will not work\n');
  });

  return server;
}

module.exports = { start };
