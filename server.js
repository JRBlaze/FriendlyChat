// Friendly Chat - Local Server
// Kick OAuth token exchange and refresh are forwarded to the Cloudflare Worker
// whose URL is stored in config.json as kick.proxy_url.

const http = require('http');
const fs   = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(body));
      } catch(e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function start(CFG) {
  const PORT      = CFG.port || 8080;
  const PROXY_URL = (CFG.kick?.proxy_url || '').replace(/\/$/, '');
  const HAS_KICK  = !!PROXY_URL;

  // Fetch and cache the Kick public client_id from the Cloudflare Worker
  let kickClientId = '';
  if (PROXY_URL) {
    fetch(`${PROXY_URL}/kick-config`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.client_id) kickClientId = d.client_id; })
      .catch(e => console.warn('  [proxy] Could not reach Kick proxy:', e.message));
  }

  const staticCache = new Map();

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;

    res.setHeader('Access-Control-Allow-Origin',  `http://localhost:${PORT}`);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if(req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── /config — public credentials only ───────────────────────────────────
    if(pathname === '/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        twitch:   { client_id: CFG.twitch?.client_id || '' },
        kick:     { client_id: kickClientId },
        has_kick: HAS_KICK,
      }));
      return;
    }

    // ── /kick-token — forward PKCE code exchange to the Cloudflare Worker ───
    if(pathname === '/kick-token' && req.method === 'POST') {
      if(!HAS_KICK) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'kick.proxy_url not set in config.json' }));
        return;
      }
      try {
        const { code, code_verifier } = await readBody(req);
        const proxyRes = await fetch(`${PROXY_URL}/kick-token`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            code,
            code_verifier,
            redirect_uri: `http://localhost:${PORT}/friendly-chat.html`,
          }),
        });
        const data = await proxyRes.json();
        res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── /kick-refresh — forward token refresh to the Cloudflare Worker ───────
    if(pathname === '/kick-refresh' && req.method === 'POST') {
      if(!HAS_KICK) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'kick.proxy_url not set in config.json' }));
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
        res.writeHead(proxyRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    // ── /kick-send — uses user's own access token, no secret needed ──────────
    if(pathname === '/kick-send' && req.method === 'POST') {
      try {
        const { token, text, broadcasterId } = await readBody(req);
        if(!broadcasterId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No broadcaster ID — leave and rejoin the channel' }));
          return;
        }
        const sendRes = await fetch('https://api.kick.com/public/v1/chat', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ type: 'user', content: text, broadcaster_user_id: broadcasterId }),
        });
        const sendData = await sendRes.json();
        if(!sendRes.ok) {
          res.writeHead(sendRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: sendData.message || 'send failed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ is_sent: sendData.data?.is_sent ?? true }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── /kick-mod — uses user's own access token, no secret needed ───────────
    if(pathname === '/kick-mod' && req.method === 'POST') {
      try {
        const { token, broadcasterId, action, username, duration, messageId } = await readBody(req);

        if(action === 'delete') {
          const deleteRes = await fetch(`https://api.kick.com/public/v1/chat/${messageId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const deleteData = await deleteRes.json().catch(() => ({}));
          if(!deleteRes.ok) {
            res.writeHead(deleteRes.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: deleteData.message || 'delete action failed' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
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
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Could not resolve user ID for moderation target' }));
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
          res.writeHead(modRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: data.message || 'mod action failed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── Static file serving ──────────────────────────────────────────────────
    let filePath = pathname === '/' ? '/friendly-chat.html' : pathname;
    filePath = path.join(__dirname, filePath);

    const cached = staticCache.get(filePath);
    if(cached) {
      res.writeHead(200, { 'Content-Type': cached.mime });
      res.end(cached.data);
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if(err) { res.writeHead(404); res.end('Not found'); return; }
      const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
      staticCache.set(filePath, { mime, data });
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });

  server.listen(PORT, () => {
    console.log(`\n  Friendly Chat running on http://localhost:${PORT}\n`);
    if(!HAS_KICK) console.log('  ⚠  kick.proxy_url not set in config.json — Kick OAuth will not work\n');
  });

  return server;
}

module.exports = { start };
