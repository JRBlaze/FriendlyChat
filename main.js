// Friendly Chat - Electron Main Process

const { app, BrowserWindow, shell, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const yt   = require('./youtube');
const updater = require('./updater');

// Only one copy of the app may own the local server port.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if(!gotSingleInstanceLock) {
  app.quit();
}

// Start server immediately — config.json holds all public credentials,
// Kick secret is on the cloud proxy (never on this machine).
const cfg = readConfig();
const localServer = require('./server').start(cfg);

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch(e) {
    console.error('Could not read config.json:', e.message);
    return { port: 8080 };
  }
}

// Windows shows notifications under this identity; without it the renderer's
// Notification API is silently ignored in packaged builds.
if(process.platform === 'win32') app.setAppUserModelId('com.friendlychat.app');

// ── Kick emote fetcher via hidden BrowserWindow (bypasses Cloudflare) ─────────
ipcMain.handle('kick-fetch-emotes', async (event, channel) => {
  try { return await fetchKickEmotesViaWindow(channel); } catch(e) { return null; }
});

ipcMain.handle('youtube-sign-in', async () => {
  return openYouTubeSignInWindow();
});

// Fallback channel → live video resolver. The local server tries a plain HTTP
// fetch first; when YouTube answers that with a consent wall or bot check, a
// real (hidden) browser window still resolves it because it runs Chromium with
// the app's persistent session.
ipcMain.handle('youtube-resolve-channel', async (event, query) => {
  try { return await resolveYouTubeLiveViaWindow(query); } catch(e) { return null; }
});

// ── Update download and hand-off ─────────────────────────────────────────────
// The installer is downloaded here (the renderer cannot write to disk) and then
// handed to the operating system, which is what makes updating a two-click job
// instead of a trip to the releases page.

ipcMain.handle('update-environment', () => ({
  platform: process.platform,
  arch: process.arch,
  version: app.getVersion(),
}));

ipcMain.handle('update-download', async (event, asset) => {
  const url = asset?.url;
  if(!updater.isAllowedDownloadUrl(url)) {
    return { error: 'Refusing to download from an unexpected host' };
  }

  // Keep the filename ours: never trust a name from the network as a path.
  const safeName = path.basename(String(asset?.name || 'friendly-chat-update')).replace(/[^\w.\-]/g, '_');
  const targetDir = path.join(os.tmpdir(), 'friendly-chat-updates');
  const targetPath = path.join(targetDir, safeName);

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    const res = await fetch(url, {
      headers: { 'User-Agent': `FriendlyChat/${app.getVersion()}`, 'Accept': 'application/octet-stream' },
      redirect: 'follow',
    });
    if(!res.ok || !res.body) throw new Error(`Download failed with HTTP ${res.status}`);

    const total = Number(res.headers.get('content-length')) || Number(asset?.size) || 0;
    let received = 0;
    let lastReported = 0;

    const source = Readable.fromWeb(res.body);
    source.on('data', chunk => {
      received += chunk.length;
      const now = Date.now();
      // Throttle so a fast connection cannot flood the renderer with IPC.
      if(now - lastReported < 120 && received !== total) return;
      lastReported = now;
      if(!event.sender.isDestroyed()) {
        event.sender.send('update-download-progress', { received, total });
      }
    });

    await pipeline(source, fs.createWriteStream(targetPath));

    if(total && received < total) throw new Error('Download ended early');

    return { path: targetPath, size: received };
  } catch(e) {
    try { fs.unlinkSync(targetPath); } catch(_) {}
    return { error: e.message };
  }
});

ipcMain.handle('update-install', async (event, filePath) => {
  const targetDir = path.join(os.tmpdir(), 'friendly-chat-updates');
  const resolved = path.resolve(String(filePath || ''));
  if(!resolved.startsWith(targetDir + path.sep) || !fs.existsSync(resolved)) {
    return { error: 'Update file is missing — download it again' };
  }

  try {
    if(process.platform === 'linux') {
      // An AppImage is the application itself: make it runnable and show the
      // user where it landed rather than replacing the running binary.
      fs.chmodSync(resolved, 0o755);
      shell.showItemInFolder(resolved);
      return { opened: 'folder', path: resolved };
    }

    const failure = await shell.openPath(resolved);
    if(failure) return { error: failure };

    // Windows: the NSIS installer cannot overwrite files that are in use, so
    // the app steps aside once the installer is up.
    if(process.platform === 'win32') {
      setTimeout(() => app.quit(), 2500);
      return { opened: 'installer', quitting: true, path: resolved };
    }
    // macOS: the .dmg is now mounted for the user to drag across.
    return { opened: 'installer', quitting: false, path: resolved };
  } catch(e) {
    return { error: e.message };
  }
});

function openYouTubeSignInWindow() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 1100,
      height: 800,
      minWidth: 520,
      minHeight: 600,
      title: 'YouTube - Sign in',
      autoHideMenuBar: true,
      parent: mainWindow || undefined,
      modal: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      if(isAllowedYouTubeSignInUrl(url)) return { action: 'allow' };
      shell.openExternal(url);
      return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, url) => {
      if(!isAllowedYouTubeSignInUrl(url)) event.preventDefault();
    });

    win.on('closed', () => resolve(true));
    // This BrowserWindow shares the app's persistent default session with the
    // embedded live chat, so signing in here also signs in the chat iframe.
    win.loadURL('https://www.youtube.com/');
  });
}

function isAllowedYouTubeSignInUrl(rawUrl) {
  try {
    const { protocol, hostname } = new URL(rawUrl);
    if(protocol !== 'https:') return false;
    return hostname === 'youtube.com'
      || hostname.endsWith('.youtube.com')
      || hostname === 'google.com'
      || hostname.endsWith('.google.com');
  } catch(_) {
    return false;
  }
}

// Loads a URL in an offscreen window and hands the page back to `extract`.
// Resolves with null on any failure or after `timeoutMs`.
function withHiddenWindow(url, extract, { timeoutMs = 12000, userAgent } = {}) {
  return new Promise((resolve) => {
    let win;
    try {
      win = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
    } catch(e) {
      resolve(null);
      return;
    }

    let settled = false;
    const done = (value) => {
      if(settled) return;
      settled = true;
      clearTimeout(timer);
      try { if(win && !win.isDestroyed()) win.destroy(); } catch(_) {}
      resolve(value);
    };

    const timer = setTimeout(() => done(null), timeoutMs);

    win.webContents.on('did-finish-load', () => {
      Promise.resolve()
        .then(() => extract(win))
        .then(done)
        .catch(() => done(null));
    });
    // ERR_ABORTED (-3) is what a normal server-side redirect looks like here, so
    // only a real failure ends the attempt early.
    win.webContents.on('did-fail-load', (event, errorCode, description, validatedURL, isMainFrame) => {
      if(isMainFrame && errorCode !== -3) done(null);
    });

    // The same redirect makes loadURL's promise reject; the events above and the
    // timeout are the real signals.
    win.loadURL(url, userAgent ? { userAgent } : undefined).catch(() => {});
  });
}

// Kick serves the same emote data from two paths and which one answers varies
// with their Cloudflare rules, so both are tried. The hidden window uses the
// app's own session, so a channel the user subscribes to returns its
// subscriber emotes too.
const KICK_EMOTE_ENDPOINTS = [
  (slug) => `https://kick.com/emotes/${slug}`,
  (slug) => `https://kick.com/api/v2/channels/${slug}/emotes`,
];

function looksLikeKickEmotePayload(value) {
  if(Array.isArray(value)) return value.length > 0;
  return !!(value && typeof value === 'object' && (value.data || value.emotes));
}

async function fetchKickEmotesViaWindow(channel) {
  const safeChannel = encodeURIComponent(String(channel || '').trim());
  if(!safeChannel) return null;

  for(const build of KICK_EMOTE_ENDPOINTS) {
    const payload = await withHiddenWindow(
      build(safeChannel),
      (win) => win.webContents.executeJavaScript('document.body.innerText')
        .then(text => { try { return JSON.parse(text); } catch(e) { return null; } }),
      {
        timeoutMs: 10000,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      }
    );
    if(looksLikeKickEmotePayload(payload)) return payload;
  }
  return null;
}

async function resolveYouTubeLiveViaWindow(query) {
  const direct = yt.parseVideoId(query);
  if(direct) return { videoId: direct, channelName: '', sourceUrl: `https://www.youtube.com/watch?v=${direct}` };

  for(const candidate of yt.channelLiveCandidates(query)) {
    const found = await withHiddenWindow(candidate, (win) =>
      win.webContents.executeJavaScript(`(() => ({
        href: location.href,
        canonical: document.querySelector('link[rel="canonical"]')?.href || '',
        title: document.title || ''
      }))()`)
    );
    if(!found) continue;
    const videoId = yt.parseVideoId(found.href) || yt.parseVideoId(found.canonical);
    if(videoId) {
      return {
        videoId,
        channelName: String(found.title || '').replace(/\s*-\s*YouTube\s*$/i, '').trim(),
        sourceUrl: candidate,
      };
    }
  }
  return null;
}

// ── Window ────────────────────────────────────────────────────────────────────
let mainWindow;

function getLinuxAppIcon() {
  if(process.platform !== 'linux') return undefined;

  // Prefer resource path in packaged builds so the icon can be read by the OS.
  const candidates = [
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(__dirname, 'icon.png'),
  ];

  for(const iconPath of candidates) {
    if(iconPath && fs.existsSync(iconPath)) {
      const image = nativeImage.createFromPath(iconPath);
      if(!image.isEmpty()) return image;
    }
  }

  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 520, minHeight: 600,
    title: 'Friendly Chat',
    icon: getLinuxAppIcon(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    autoHideMenuBar: true,
  });

  let loaded = false;
  const loadApp = () => {
    if(loaded) return;
    if(mainWindow && !mainWindow.isDestroyed()) {
      loaded = true;
      mainWindow.loadURL(`http://localhost:${cfg.port || 8080}/friendly-chat.html`);
    }
  };
  // Prefer loading as soon as the server is listening, with a fallback timeout.
  if(localServer.listening) {
    loadApp();
  } else {
    localServer.once('listening', loadApp);
    setTimeout(loadApp, 1500);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const isOAuth =
      url.includes('id.twitch.tv/oauth2') ||
      url.includes('accounts.google.com/o/oauth2') ||
      url.includes('id.kick.com/oauth');
    if(isOAuth) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 500, height: 700,
          autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('second-instance', () => {
  if(mainWindow) {
    if(mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

if(gotSingleInstanceLock) {
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if(!mainWindow) createWindow(); });
}
