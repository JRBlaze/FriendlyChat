// Friendly Chat - Local Server
// Kick OAuth calls are forwarded to the cloud proxy (which holds the secret).
// No Kick credentials are stored locally.

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
  const PORT       = CFG.port || 8080;
  const PROXY_URL  = (CFG.proxy_url || CFG.kick_proxy_url || '').replace(/\/$/, '');
  const HAS_PROXY  = PROXY_URL && PROXY_URL !== 'YOUR_PROXY_URL_HERE';

  // Pre-fetch Kick client ID from proxy at startup
  let kickClientId = '';
  if(HAS_PROXY) {
    fetch(`${PROXY_URL}/kick-config`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if(d?.client_id) kickClientId = d.client_id; })
      .catch(e => console.warn('Could not reach proxy for Kick config:', e.message));
  }

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
        youtube: {
          client_id: CFG.youtube?.client_id || '',
          has_client_secret: !!CFG.youtube?.client_secret,
        },
        kick:    { client_id: kickClientId },
        has_kick_proxy: HAS_PROXY,
      }));
      return;
    }

    // ── /kick-token — forward to cloud proxy ─────────────────────────────────
    if(pathname === '/kick-token' && req.method === 'POST') {
      if(!HAS_PROXY) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Kick proxy not configured' }));
        return;
      }
      try {
        const body = await readBody(req);
        // Add redirect_uri for the proxy
        body.redirect_uri = `http://localhost:${PORT}/friendly-chat.html`;
        const kickRes = await fetch(`${PROXY_URL}/kick-token`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        const data = await kickRes.json();
        res.writeHead(kickRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── /kick-refresh — forward to cloud proxy ────────────────────────────────
    if(pathname === '/kick-refresh' && req.method === 'POST') {
      if(!HAS_PROXY) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Kick proxy not configured' }));
        return;
      }
      try {
        const body = await readBody(req);
        const kickRes = await fetch(`${PROXY_URL}/kick-refresh`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        const data = await kickRes.json();
        res.writeHead(kickRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── /youtube-token — exchange PKCE auth code for access + refresh tokens
    // Google's Desktop (installed-app) OAuth client type issues a client_secret
    // that is explicitly *not* confidential — it must be shipped with the app
    // alongside the client_id. See:
    //   https://developers.google.com/identity/protocols/oauth2/native-app
    // The user supplies both values in config.json; this handler forwards the
    // PKCE exchange directly to Google so each user gets their own access and
    // refresh tokens tied to their own Google account / API quota.
    if(pathname === '/youtube-token' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { code, code_verifier } = body;
        const youtubeClientId     = CFG.youtube?.client_id     || '';
        const youtubeClientSecret = CFG.youtube?.client_secret || '';
        const redirectUri         = body.redirect_uri || `http://localhost:${PORT}/friendly-chat.html`;

        if(!youtubeClientId || !youtubeClientSecret) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'YouTube OAuth is not configured. Add youtube.client_id and youtube.client_secret to config.json (create a "Desktop app" OAuth client in Google Cloud Console).',
          }));
          return;
        }

        const params = new URLSearchParams({
          grant_type:    'authorization_code',
          client_id:     youtubeClientId,
          client_secret: youtubeClientSecret,
          code_verifier,
          code,
          redirect_uri:  redirectUri,
        });
        const ytRes = await fetch('https://oauth2.googleapis.com/token', {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    params.toString(),
        });
        const data = await ytRes.json().catch(() => ({}));
        if(!ytRes.ok || data.error) {
          res.writeHead(ytRes.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: data.error_description || data.error || 'YouTube token exchange failed',
          }));
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

    // ── /youtube-refresh — swap a refresh_token for a new access_token ──────
    // Called automatically before the access token expires so the connected
    // UI state and any active chat polling survive indefinitely without
    // forcing the user to re-authorize every hour.
    if(pathname === '/youtube-refresh' && req.method === 'POST') {
      try {
        const { refresh_token } = await readBody(req);
        const youtubeClientId     = CFG.youtube?.client_id     || '';
        const youtubeClientSecret = CFG.youtube?.client_secret || '';

        if(!youtubeClientId || !youtubeClientSecret) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'YouTube OAuth is not configured. Add youtube.client_id and youtube.client_secret to config.json.',
          }));
          return;
        }

        const params = new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     youtubeClientId,
          client_secret: youtubeClientSecret,
          refresh_token,
        });
        const ytRes = await fetch('https://oauth2.googleapis.com/token', {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    params.toString(),
        });
        const data = await ytRes.json().catch(() => ({}));
        if(!ytRes.ok || data.error || !data.access_token) {
          res.writeHead(ytRes.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: data.error_description || data.error || 'YouTube token refresh failed',
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token:  data.access_token,
          refresh_token: data.refresh_token || refresh_token,
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
        const { token, broadcasterId, action, username, duration, permanent } = await readBody(req);
        const url  = `https://api.kick.com/public/v1/channels/${broadcasterId}/bans`;
        const body = permanent ? { username } : { username, duration };
        const kickRes = await fetch(url, {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        const data = await kickRes.json().catch(() => ({}));
        if(!kickRes.ok) {
          res.writeHead(kickRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: data.message || 'mod action failed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
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
    if(!HAS_PROXY) console.log('  ⚠  Kick proxy not configured — Kick OAuth will not work\n');
  });

  return server;
}

module.exports = { start };
