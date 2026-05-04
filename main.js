// Friendly Chat - Electron Main Process

const { app, BrowserWindow, shell, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');

// Start server immediately — config.json holds all public credentials,
// Kick secret is on the cloud proxy (never on this machine).
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const localServer = require('./server').start(cfg);

// ── Kick emote fetcher via hidden BrowserWindow (bypasses Cloudflare) ─────────
ipcMain.handle('kick-fetch-emotes', async (event, channel) => {
  try { return await fetchKickEmotesViaWindow(channel); } catch(e) { return null; }
});

function fetchKickEmotesViaWindow(channel) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    let resolved = false;
    const done = (val) => {
      if(!resolved) { resolved = true; try { win.destroy(); } catch(e) {} resolve(val); }
    };
    setTimeout(() => done(null), 10000);
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript('document.body.innerText')
        .then(text => { try { done(JSON.parse(text)); } catch(e) { done(null); } })
        .catch(() => done(null));
    });
    win.loadURL(`https://kick.com/api/v2/channels/${channel}/emotes`, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
  });
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

  const loadApp = () => {
    if(mainWindow && !mainWindow.isDestroyed()) {
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if(!mainWindow) createWindow(); });
