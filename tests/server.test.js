const http = require('http');
const path = require('path');
const fx = require('./fixtures/youtube');

const serverModule = require('../server');

// Every test gets its own port so suites never collide.
let nextPort = 18410;

const realFetch = global.fetch;

function stubFetch(handler) {
  global.fetch = async (url, options = {}) => {
    const result = await handler(String(url), options);
    if (result && typeof result.json === 'function') return result;
    return {
      ok: true,
      status: 200,
      url: String(url),
      json: async () => result,
      text: async () => JSON.stringify(result),
    };
  };
}

function textResult(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function jsonResult(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(config, fn) {
  const port = nextPort++;
  const server = serverModule.start({ port, ...config });
  await new Promise(resolve => {
    if (server.listening) resolve();
    else server.once('listening', resolve);
  });
  try {
    return await fn(port, server);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('server: static files and safety', () => {
  it('serves the app at / and by name', async () => {
    stubFetch(async () => ({}));
    await withServer({}, async (port) => {
      const root = await request(port, 'GET', '/');
      assertEqual(root.status, 200);
      assertIncludes(root.text, '<title>Friendly Chat</title>');
      assertIncludes(root.headers['content-type'], 'text/html');

      const named = await request(port, 'GET', '/friendly-chat.html');
      assertEqual(named.status, 200);
    });
  });

  it('404s a missing asset and 403s a type it never serves', async () => {
    stubFetch(async () => ({}));
    await withServer({}, async (port) => {
      assertEqual((await request(port, 'GET', '/nope.png')).status, 404);
      assertEqual((await request(port, 'GET', '/main.js')).status, 403);
      assertEqual((await request(port, 'GET', '/config.json')).status, 403);
    });
  });

  it('refuses to serve files outside the app directory', async () => {
    stubFetch(async () => ({}));
    await withServer({}, async (port) => {
      for (const attempt of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json']) {
        const res = await request(port, 'GET', attempt);
        assert(res.status === 403 || res.status === 404, `traversal attempt ${attempt} returned ${res.status}`);
        assertNotIncludes(res.text, '"electron-builder"');
      }
    });
  });

  it('rejects unexpected methods on the static handler', async () => {
    stubFetch(async () => ({}));
    await withServer({}, async (port) => {
      const res = await request(port, 'DELETE', '/friendly-chat.html');
      assertEqual(res.status, 405);
    });
  });

  it('listens on loopback only so tokens are never exposed to the LAN', async () => {
    stubFetch(async () => ({}));
    await withServer({}, async (port, server) => {
      assertEqual(server.address().address, '127.0.0.1');
    });
  });
});

describe('server: config', () => {
  it('returns the public twitch client id and kick availability', async () => {
    stubFetch(async (url) => {
      if (url.includes('/kick-config')) return jsonResult({ client_id: 'kick-public-id' });
      return jsonResult({});
    });
    await withServer(
      { twitch: { client_id: 'tw-id' }, kick: { proxy_url: 'https://proxy.example/' } },
      async (port) => {
        const res = await request(port, 'GET', '/config');
        assertEqual(res.status, 200);
        assertEqual(res.json.twitch.client_id, 'tw-id');
        assertEqual(res.json.has_kick, true);
        assertEqual(res.json.kick.client_id, 'kick-public-id');
      }
    );
  });

  it('reports kick as unavailable when no proxy is configured', async () => {
    stubFetch(async () => jsonResult({}));
    await withServer({ twitch: { client_id: 'tw-id' } }, async (port) => {
      const res = await request(port, 'GET', '/config');
      assertEqual(res.json.has_kick, false);
      assertEqual(res.json.kick.client_id, '');
    });
  });
});

describe('server: kick endpoints', () => {
  it('forwards the token exchange with the caller redirect uri', async () => {
    let forwarded = null;
    stubFetch(async (url, options) => {
      if (url.includes('/kick-token')) {
        forwarded = JSON.parse(options.body);
        return jsonResult({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
      }
      return jsonResult({});
    });
    await withServer({ kick: { proxy_url: 'https://proxy.example' } }, async (port) => {
      const res = await request(port, 'POST', '/kick-token', {
        code: 'c', code_verifier: 'v', redirect_uri: 'http://localhost:9999/friendly-chat.html',
      });
      assertEqual(res.status, 200);
      assertEqual(res.json.access_token, 'a');
      assertEqual(forwarded.redirect_uri, 'http://localhost:9999/friendly-chat.html');
    });
  });

  it('503s the token exchange when no proxy is configured', async () => {
    stubFetch(async () => jsonResult({}));
    await withServer({}, async (port) => {
      const res = await request(port, 'POST', '/kick-token', { code: 'c' });
      assertEqual(res.status, 503);
    });
  });

  it('refuses to send without a broadcaster id', async () => {
    stubFetch(async () => jsonResult({}));
    await withServer({}, async (port) => {
      const res = await request(port, 'POST', '/kick-send', { token: 't', text: 'hi' });
      assertEqual(res.status, 400);
      assertIncludes(res.json.error, 'broadcaster');
    });
  });

  it('sends a chat message with a numeric broadcaster id', async () => {
    let sent = null;
    stubFetch(async (url, options) => {
      if (url.includes('/public/v1/chat')) {
        sent = JSON.parse(options.body);
        return jsonResult({ data: { is_sent: true } });
      }
      return jsonResult({});
    });
    await withServer({}, async (port) => {
      const res = await request(port, 'POST', '/kick-send', { token: 't', text: 'hello', broadcasterId: '4242' });
      assertEqual(res.status, 200);
      assertEqual(res.json.is_sent, true);
      assertEqual(sent.broadcaster_user_id, 4242);
      assertEqual(sent.content, 'hello');
    });
  });

  it('passes through kick send failures with their status', async () => {
    stubFetch(async (url) => {
      if (url.includes('/public/v1/chat')) return jsonResult({ message: 'rate limited' }, 429);
      return jsonResult({});
    });
    await withServer({}, async (port) => {
      const res = await request(port, 'POST', '/kick-send', { token: 't', text: 'x', broadcasterId: 1 });
      assertEqual(res.status, 429);
      assertEqual(res.json.error, 'rate limited');
    });
  });

  it('resolves a username before banning', async () => {
    let banBody = null;
    stubFetch(async (url, options) => {
      if (url.includes('/api/v1/channels/')) return jsonResult({ user_id: 777 });
      if (url.includes('/moderation/bans')) { banBody = JSON.parse(options.body); return jsonResult({ ok: true }); }
      return jsonResult({});
    });
    await withServer({}, async (port) => {
      const res = await request(port, 'POST', '/kick-mod', {
        token: 't', broadcasterId: 5, action: 'ban', username: 'troll',
      });
      assertEqual(res.status, 200);
      assertEqual(banBody, { broadcaster_user_id: 5, user_id: 777 });
    });
  });

  it('converts timeout seconds into kick minutes', async () => {
    let banBody = null;
    stubFetch(async (url, options) => {
      if (url.includes('/api/v1/channels/')) return jsonResult({ user_id: 777 });
      if (url.includes('/moderation/bans')) { banBody = JSON.parse(options.body); return jsonResult({ ok: true }); }
      return jsonResult({});
    });
    await withServer({}, async (port) => {
      await request(port, 'POST', '/kick-mod', {
        token: 't', broadcasterId: 5, action: 'timeout', username: 'troll', duration: 300,
      });
      assertEqual(banBody.duration, 5);
    });
  });

  it('errors clearly when a moderation target cannot be resolved', async () => {
    stubFetch(async (url) => {
      if (url.includes('/api/v1/channels/')) return jsonResult({}, 404);
      return jsonResult({});
    });
    await withServer({}, async (port) => {
      const res = await request(port, 'POST', '/kick-mod', {
        token: 't', broadcasterId: 5, action: 'ban', username: 'ghost',
      });
      assertEqual(res.status, 400);
      assertIncludes(res.json.error, 'Could not resolve');
    });
  });

  it('rejects malformed JSON bodies without crashing', async () => {
    stubFetch(async () => jsonResult({}));
    await withServer({}, async (port) => {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/kick-send',
          headers: { 'Content-Type': 'application/json' } }, r => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.write('{not json');
        req.end();
      });
      assertEqual(res.status, 500);
      assertIncludes(res.text, 'Invalid JSON');
    });
  });
});

describe('server: youtube endpoints', () => {
  it('resolves a channel name to a live video', async () => {
    stubFetch(async (url) => textResult(fx.channelLivePage('jfKfPfyJRdk', 'Lofi Girl'), 200));
    await withServer({}, async (port) => {
      const res = await request(port, 'GET', '/youtube-resolve?q=%40lofigirl');
      assertEqual(res.status, 200);
      assertEqual(res.json.videoId, 'jfKfPfyJRdk');
    });
  });

  it('404s with a readable message when nothing is live', async () => {
    stubFetch(async () => textResult('<html></html>', 200));
    await withServer({}, async (port) => {
      const res = await request(port, 'GET', '/youtube-resolve?q=offline');
      assertEqual(res.status, 404);
      assertIncludes(res.json.error, 'does not appear to be live');
    });
  });

  it('bootstraps then polls, reusing the handshake across calls', async () => {
    let pageLoads = 0;
    let polls = 0;
    stubFetch(async (url) => {
      if (url.includes('/live_chat?')) { pageLoads++; return textResult(fx.liveChatPage(), 200); }
      if (url.includes('get_live_chat')) { polls++; return jsonResult(fx.chatResponse); }
      return jsonResult({});
    });
    await withServer({}, async (port) => {
      const first = await request(port, 'POST', '/youtube-chat', { videoId: 'dQw4w9WgXcQ' });
      assertEqual(first.status, 200);
      assertEqual(first.json.bootstrapped, true);
      assertEqual(first.json.messages.length, 4);
      assertEqual(first.json.continuation, fx.LIVE_CHAT_CONTINUATION_2);
      assert(first.json.emotes[':_cozy:'], 'custom emoji should be returned on bootstrap');

      const second = await request(port, 'POST', '/youtube-chat', {
        videoId: 'dQw4w9WgXcQ', continuation: first.json.continuation,
      });
      assertEqual(second.status, 200);
      assertEqual(second.json.bootstrapped, false);
      assertEqual(pageLoads, 1);
      assertEqual(polls, 2);
    });
  });

  it('rejects an invalid video id', async () => {
    stubFetch(async () => jsonResult({}));
    await withServer({}, async (port) => {
      const res = await request(port, 'POST', '/youtube-chat', { videoId: '../../etc' });
      assertEqual(res.status, 400);
    });
  });

  it('reports upstream failures as 502 rather than hanging', async () => {
    stubFetch(async () => { throw new Error('network down'); });
    await withServer({}, async (port) => {
      const res = await request(port, 'POST', '/youtube-chat', { videoId: 'dQw4w9WgXcQ' });
      assertEqual(res.status, 502);
      assertIncludes(res.json.error, 'network down');
    });
  });
});

describe('server: kick emote fallback', () => {
  it('proxies the emote endpoint for browser mode', async () => {
    stubFetch(async (url) => {
      if (url.includes('/emotes')) return jsonResult([{ id: 'Global', emotes: [{ id: 1, name: 'kickHi' }] }]);
      return jsonResult({});
    });
    await withServer({}, async (port) => {
      const res = await request(port, 'GET', '/kick-emotes?channel=xqc');
      assertEqual(res.status, 200);
      assertEqual(res.json.data[0].emotes[0].name, 'kickHi');
    });
  });

  it('requires a channel', async () => {
    stubFetch(async () => jsonResult({}));
    await withServer({}, async (port) => {
      const res = await request(port, 'GET', '/kick-emotes');
      assertEqual(res.status, 400);
    });
  });

  it('passes a Cloudflare block through as an error', async () => {
    stubFetch(async () => jsonResult({}, 403));
    await withServer({}, async (port) => {
      const res = await request(port, 'GET', '/kick-emotes?channel=xqc');
      assertEqual(res.status, 403);
    });
  });
});

// Restore the real fetch for any later suite.
process.on('exit', () => { global.fetch = realFetch; });

describe('server: update check', () => {
  const releasePayload = {
    tag_name: 'v9.9.9',
    name: 'v9.9.9',
    html_url: 'https://github.com/JRBlaze/FriendlyChat/releases/tag/v9.9.9',
    body: 'Shiny new things.',
    assets: [
      { name: 'Friendly Chat Setup 9.9.9.exe', size: 123, browser_download_url: 'https://github.com/JRBlaze/FriendlyChat/releases/download/v9.9.9/Setup.exe' },
    ],
  };

  it('reports an available update for the caller platform', async () => {
    stubFetch(async (url) => {
      if (url.includes('releases/latest')) return jsonResult(releasePayload);
      return jsonResult({});
    });
    await withServer({}, async (port) => {
      const res = await request(port, 'GET', '/update-check?current=1.0.0&platform=win32&arch=x64');
      assertEqual(res.status, 200);
      assertEqual(res.json.available, true);
      assertEqual(res.json.latestVersion, '9.9.9');
      assertEqual(res.json.asset.name, 'Friendly Chat Setup 9.9.9.exe');
    });
  });

  it('reports no update when already current', async () => {
    stubFetch(async () => jsonResult(releasePayload));
    await withServer({}, async (port) => {
      const res = await request(port, 'GET', '/update-check?current=9.9.9&platform=win32&arch=x64');
      assertEqual(res.json.available, false);
    });
  });

  it('caches the answer so GitHub is not hammered', async () => {
    let calls = 0;
    stubFetch(async () => { calls++; return jsonResult(releasePayload); });
    await withServer({}, async (port) => {
      await request(port, 'GET', '/update-check?current=1.0.0&platform=win32&arch=x64');
      const second = await request(port, 'GET', '/update-check?current=1.0.0&platform=win32&arch=x64');
      assertEqual(calls, 1);
      assertEqual(second.json.cached, true);

      const forced = await request(port, 'GET', '/update-check?current=1.0.0&platform=win32&arch=x64&force=1');
      assertEqual(calls, 2);
      assertEqual(forced.json.cached, false);
    });
  });

  it('reports a GitHub failure with the releases page as a fallback', async () => {
    stubFetch(async () => jsonResult({}, 403));
    await withServer({}, async (port) => {
      const res = await request(port, 'GET', '/update-check?current=1.0.0&platform=win32&arch=x64');
      assertEqual(res.status, 502);
      assertIncludes(res.json.error, 'rate limit');
      assertIncludes(res.json.releaseUrl, 'github.com/JRBlaze/FriendlyChat/releases');
    });
  });
});
