// Loads friendly-chat.html into jsdom with every network dependency stubbed,
// so the whole renderer can be driven offline exactly the way a user would.

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const APP_HTML = path.join(__dirname, '..', '..', 'friendly-chat.html');
const APP_URL = 'http://localhost:8080/friendly-chat.html';

// ── Fake WebSocket ───────────────────────────────────────────────────────────
class FakeWebSocket {
  static instances = [];
  static OPEN = 1;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) { this.sent.push(data); }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: 1000 });
  }

  // Test controls
  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen({});
  }

  emit(data) {
    if (this.onmessage) this.onmessage({ data });
  }

  fail() {
    if (this.onerror) this.onerror({});
  }

  static reset() { FakeWebSocket.instances = []; }
  static last() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]; }
  static byUrl(fragment) {
    return FakeWebSocket.instances.filter(ws => ws.url.includes(fragment));
  }
}
FakeWebSocket.prototype.CONNECTING = 0;
FakeWebSocket.prototype.OPEN = 1;
FakeWebSocket.prototype.CLOSING = 2;
FakeWebSocket.prototype.CLOSED = 3;

// ── Fake fetch ───────────────────────────────────────────────────────────────
function makeFetch() {
  const routes = [];
  const calls = [];

  const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    url: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, options });
    for (const route of routes) {
      if (route.match(target, options)) {
        const result = await route.handler(target, options);
        if (result && typeof result.json === 'function') return result;
        return jsonResponse(result === undefined ? {} : result);
      }
    }
    return jsonResponse({ error: 'not stubbed', url: target }, 404);
  };

  fetchImpl.route = (matcher, handler) => {
    const match = typeof matcher === 'function'
      ? matcher
      : (target) => target.includes(matcher);
    routes.unshift({ match, handler });
    return fetchImpl;
  };
  fetchImpl.calls = calls;
  fetchImpl.callsTo = (fragment) => calls.filter(c => c.url.includes(fragment));
  fetchImpl.reset = () => { routes.length = 0; calls.length = 0; };
  fetchImpl.json = jsonResponse;
  return fetchImpl;
}

// ── Fake Notification / AudioContext ─────────────────────────────────────────
function makeNotification(state) {
  class FakeNotification {
    constructor(title, options) {
      this.title = title;
      this.options = options;
      state.notifications.push({ title, options });
    }
    close() {}
    static permission = 'granted';
    static async requestPermission() {
      state.permissionRequests++;
      return FakeNotification.permission;
    }
  }
  return FakeNotification;
}

function makeAudioContext(state) {
  return class FakeAudioContext {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
    resume() { this.state = 'running'; }
    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: { setValueAtTime() {} },
        connect(next) { return next; },
        start() { state.tones++; },
        stop() {},
      };
      return osc;
    }
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect(next) { return next; },
      };
    }
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────
async function launchApp({ storage = {}, electronAPI = null, config = null, routes = [] } = {}) {
  const html = fs.readFileSync(APP_HTML, 'utf8');
  const fetchImpl = makeFetch();
  const state = { notifications: [], permissionRequests: 0, tones: 0 };

  FakeWebSocket.reset();

  // Routes registered before the page runs, for anything the app requests
  // during startup.
  routes.forEach(([matcher, handler]) => fetchImpl.route(matcher, handler));

  fetchImpl.route('/config', () => config || {
    twitch: { client_id: 'test-twitch-client' },
    kick: { client_id: 'test-kick-client' },
    has_kick: true,
    port: 8080,
  });

  const virtualConsole = new VirtualConsole();
  const consoleErrors = [];
  virtualConsole.on('jsdomError', err => consoleErrors.push(err));

  const dom = new JSDOM(html, {
    url: APP_URL,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      Object.entries(storage).forEach(([k, v]) => window.localStorage.setItem(k, v));
      window.fetch = fetchImpl;
      window.WebSocket = FakeWebSocket;
      window.Notification = makeNotification(state);
      window.AudioContext = makeAudioContext(state);
      if (electronAPI) window.electronAPI = electronAPI;
      // jsdom does not expose these web globals; browsers and Electron do.
      if (!window.TextEncoder) window.TextEncoder = TextEncoder;
      if (!window.TextDecoder) window.TextDecoder = TextDecoder;
      if (!window.crypto.subtle) {
        window.crypto.subtle = {
          digest: async () => new Uint8Array(32).buffer,
        };
      }
      window.crypto.getRandomValues = (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 7 + 3) % 256;
        return arr;
      };
      // The app logs generously; keep test output readable.
      window.console.log = () => {};
      window.console.warn = () => {};
    },
  });

  const { window } = dom;
  await new Promise(resolve => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
  });
  // Let loadConfig() and the session restores settle.
  await tick(window, 3);

  const api = () => window.__friendlyChat;

  return {
    dom,
    window,
    document: window.document,
    fetch: fetchImpl,
    ws: FakeWebSocket,
    state,
    consoleErrors,
    api,
    $: (sel) => window.document.querySelector(sel),
    $$: (sel) => [...window.document.querySelectorAll(sel)],
    // Drains the render queue so assertions see the DOM immediately.
    flush: () => api().flushFeed(),
    tick: (n = 1) => tick(window, n),
    click(sel) {
      const el = window.document.querySelector(sel);
      if (!el) throw new Error(`click: no element for ${sel}`);
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      return el;
    },
    type(sel, value) {
      const el = window.document.querySelector(sel);
      if (!el) throw new Error(`type: no element for ${sel}`);
      el.value = value;
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
      return el;
    },
    change(sel, value) {
      const el = window.document.querySelector(sel);
      if (!el) throw new Error(`change: no element for ${sel}`);
      if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
      return el;
    },
    key(sel, key) {
      const el = window.document.querySelector(sel);
      if (!el) throw new Error(`key: no element for ${sel}`);
      el.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      return el;
    },
    close() { dom.window.close(); },
  };
}

function tick(window, times = 1) {
  return new Promise(resolve => {
    let remaining = times;
    const step = () => {
      if (remaining-- <= 0) { resolve(); return; }
      window.setTimeout(step, 0);
    };
    step();
  });
}

module.exports = { launchApp, FakeWebSocket, makeFetch, APP_HTML };
