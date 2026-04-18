// Friendly Chat - Local Server
// Runs inside the Electron app and handles local OAuth/token requests.

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
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

function start(CFG) {
  const PORT = CFG.port || 8080;
  const KICK_CLIENT_ID = CFG.kick?.client_id || '';
  const KICK_CLIENT_SECRET = CFG.kick?.client_secret || '';
  const HAS_KICK_OAUTH_CONFIG = !!(KICK_CLIENT_ID && KICK_CLIENT_SECRET);

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
        twitch:  { client_id: CFG.twitch?.client_id  || '' },
        kick:    { client_id: KICK_CLIENT_ID },
        has_kick_oauth_config: HAS_KICK_OAUTH_CONFIG,
      }));
      return;
    }

    // ── /kick-token — exchanges auth code for access/refresh token ─────────
    if(pathname === '/kick-token' && req.method === 'POST') {
      if(!HAS_KICK_OAUTH_CONFIG) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Kick OAuth not configured in config.json' }));
        return;
      }
      try {
        const { code, code_verifier } = await readBody(req);
        const params = new URLSearchParams({
          grant_type:    'authorization_code',
          client_id:     KICK_CLIENT_ID,
          client_secret: KICK_CLIENT_SECRET,
          redirect_uri:  `http://localhost:${PORT}/friendly-chat.html`,
          code_verifier,
          code,
        });
        const kickRes = await fetch('https://id.kick.com/oauth/token', {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    params.toString(),
        });
        const data = await kickRes.json();
        if(!kickRes.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: data.error || 'token exchange failed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token:  data.access_token,
          refresh_token: data.refresh_token,
          expires_in:    data.expires_in,
        }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── /kick-refresh — refreshes Kick access token ─────────────────────────
    if(pathname === '/kick-refresh' && req.method === 'POST') {
      if(!HAS_KICK_OAUTH_CONFIG) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Kick OAuth not configured in config.json' }));
        return;
      }
      try {
        const { refresh_token } = await readBody(req);
        const params = new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     KICK_CLIENT_ID,
          client_secret: KICK_CLIENT_SECRET,
          refresh_token,
        });
        const kickRes = await fetch('https://id.kick.com/oauth/token', {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    params.toString(),
        });
        const data = await kickRes.json();
        if(!kickRes.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: data.error || 'refresh failed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token:  data.access_token,
          refresh_token: data.refresh_token,
          expires_in:    data.expires_in,
        }));
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
    fs.readFile(filePath, (err, data) => {
      if(err) { res.writeHead(404); res.end('Not found'); return; }
      const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });

  server.listen(PORT, () => {
    console.log(`\n  Friendly Chat running on http://localhost:${PORT}\n`);
    if(!HAS_KICK_OAUTH_CONFIG) {
      console.log('  ⚠  Kick OAuth not configured in config.json — add kick.client_id/client_secret to enable Kick sign in\n');
    }
  });

  return server;
}

module.exports = { start };
