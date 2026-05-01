// Friendly Chat - Cloudflare Worker
// Keeps your Kick Client ID and Client Secret out of the desktop app.
//
// Deploy:
//   npm install -g wrangler
//   wrangler login
//   wrangler secret put KICK_CLIENT_ID      (paste your Client ID when prompted)
//   wrangler secret put KICK_CLIENT_SECRET  (paste your Client Secret when prompted)
//   wrangler deploy
//
// Then paste the deployed Worker URL into config.json as kick.proxy_url.

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'friendly-chat-kick-proxy' }, 200, origin);
    }

    // Returns the Kick Client ID (public — safe to expose)
    if (url.pathname === '/kick-config' && request.method === 'GET') {
      return json({ client_id: env.KICK_CLIENT_ID || '' }, 200, origin);
    }

    // Exchanges a PKCE auth code for access + refresh tokens
    if (url.pathname === '/kick-token' && request.method === 'POST') {
      try {
        const { code, code_verifier, redirect_uri } = await request.json();
        const params = new URLSearchParams({
          grant_type:    'authorization_code',
          client_id:     env.KICK_CLIENT_ID,
          client_secret: env.KICK_CLIENT_SECRET,
          redirect_uri,
          code_verifier,
          code,
        });
        const kickRes = await fetch('https://id.kick.com/oauth/token', {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    params.toString(),
        });
        const data = await kickRes.json();
        if (!kickRes.ok) {
          return json({ error: data.error || 'token exchange failed' }, 400, origin);
        }
        return json({
          access_token:  data.access_token,
          refresh_token: data.refresh_token,
          expires_in:    data.expires_in,
        }, 200, origin);
      } catch (e) {
        return json({ error: e.message }, 500, origin);
      }
    }

    // Silently refreshes an expired Kick access token
    if (url.pathname === '/kick-refresh' && request.method === 'POST') {
      try {
        const { refresh_token } = await request.json();
        const params = new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     env.KICK_CLIENT_ID,
          client_secret: env.KICK_CLIENT_SECRET,
          refresh_token,
        });
        const kickRes = await fetch('https://id.kick.com/oauth/token', {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    params.toString(),
        });
        const data = await kickRes.json();
        if (!kickRes.ok) {
          return json({ error: data.error || 'refresh failed' }, 400, origin);
        }
        return json({
          access_token:  data.access_token,
          refresh_token: data.refresh_token,
          expires_in:    data.expires_in,
        }, 200, origin);
      } catch (e) {
        return json({ error: e.message }, 500, origin);
      }
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};

function cors(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}
