const path = require('path');
const http = require('http');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  desktopCapturer,
  ipcMain,
  nativeImage,
  powerSaveBlocker,
  screen,
  session,
  shell,
  systemPreferences,
} = require('electron');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const config = require('./config');
const input = require('./input');
const { attachRelay } = require('./relay');

if (process.env.REMOTELY_DATA_DIR) app.setPath('userData', process.env.REMOTELY_DATA_DIR);
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let tray = null;
let cfg = null;
let quitting = false;
let lanStatus = { ok: false, error: null };
let selectedSource = null;
let awakeId = null;
let activeSessions = 0;

const startHidden =
  process.argv.includes('--hidden') || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);

function startLanRelay() {
  const server = http.createServer((_, res) => res.end('remotely'));
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
  attachRelay(wss);
  server.on('error', (e) => {
    lanStatus = { ok: false, error: e.code === 'EADDRINUSE' ? `Port ${cfg.lanPort} is in use` : e.message };
    win?.webContents.send('state-changed');
  });
  server.listen(cfg.lanPort, '0.0.0.0', () => {
    lanStatus = { ok: true, error: null };
    win?.webContents.send('state-changed');
  });
}

function applyAutostart() {
  // Only register the installed app, never the dev electron binary.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: cfg.autostart, openAsHidden: true, args: ['--hidden'] });
}

function permissions() {
  if (process.platform !== 'darwin') return { screen: 'granted', accessibility: true };
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

async function state() {
  const lan = config.lanAddresses(cfg.lanPort);
  const pairing = { v: 1, id: cfg.id, s: cfg.secret, n: cfg.name, lan, srv: cfg.serverUrl || undefined };
  const code = Buffer.from(JSON.stringify(pairing)).toString('base64url');
  return {
    id: cfg.id,
    secret: cfg.secret,
    name: cfg.name,
    serverUrl: cfg.serverUrl,
    autostart: cfg.autostart,
    lanPort: cfg.lanPort,
    lan,
    lanStatus,
    code,
    qr: await QRCode.toDataURL(code, { margin: 1, width: 280, errorCorrectionLevel: 'M' }),
    platform: process.platform,
    permissions: permissions(),
  };
}

async function listScreens() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const displays = screen.getAllDisplays();
  return sources.map((s, i) => {
    const d = displays.find((x) => String(x.id) === s.display_id) || displays[i] || screen.getPrimaryDisplay();
    return {
      id: s.id,
      displayId: String(d.id),
      name: s.name,
      w: Math.round(d.size.width * d.scaleFactor),
      h: Math.round(d.size.height * d.scaleFactor),
    };
  });
}

function trayIcon() {
  // 16x16 blue dot, drawn in code so no asset file is needed.
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      const a = d < 6.5 ? 255 : d < 7.5 ? Math.round((7.5 - d) * 255) : 0;
      const i = (y * size + x) * 4;
      buf[i] = 255; // B
      buf[i + 1] = activeSessions ? 200 : 140; // G
      buf[i + 2] = activeSessions ? 52 : 79; // R
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateTray() {
  if (!tray) return;
  tray.setImage(trayIcon());
  tray.setToolTip(activeSessions ? `Remotely — ${activeSessions} phone(s) connected` : 'Remotely — ready');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: activeSessions ? `${activeSessions} phone(s) connected` : 'Ready for connections', enabled: false },
      { type: 'separator' },
      { label: 'Show Remotely', click: showWindow },
      {
        label: 'Quit Remotely',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function showWindow() {
  if (!win) return createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 440,
    height: 760,
    minWidth: 380,
    show,
    title: 'Remotely',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep streaming when minimized or hidden in the tray.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.env.REMOTELY_DEBUG) win.webContents.on('console-message', (e) => console.log('[agent]', e.message));
  // Closing the window keeps the agent running in the tray.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  cfg = config.load();
  applyAutostart();

  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const src = sources.find((s) => s.id === selectedSource) || sources[0];
    callback(src ? { video: src } : {});
  });

  ipcMain.handle('state', () => state());
  ipcMain.handle('config:set', async (_e, patch) => {
    if (typeof patch?.serverUrl === 'string') cfg.serverUrl = patch.serverUrl.trim();
    if (typeof patch?.name === 'string' && patch.name.trim()) cfg.name = patch.name.trim().slice(0, 64);
    if (typeof patch?.autostart === 'boolean') {
      cfg.autostart = patch.autostart;
      applyAutostart();
    }
    config.save(cfg);
    return state();
  });
  ipcMain.handle('config:reset', async () => {
    Object.assign(cfg, config.newIdentity());
    config.save(cfg);
    return state();
  });
  ipcMain.handle('screens:list', () => listScreens());
  ipcMain.handle('screens:select', async (_e, sourceId) => {
    const list = await listScreens();
    const s = list.find((x) => x.id === sourceId) || list[0];
    if (!s) return null;
    selectedSource = s.id;
    return s;
  });
  ipcMain.handle('cursor', (_e, displayId) => input.cursor(displayId));
  ipcMain.on('input', (_e, msg) => msg && typeof msg === 'object' && input.enqueue(msg));
  ipcMain.on('input:release', () => input.releaseAll());
  ipcMain.handle('clipboard:read', async () => String((await clipboard.readText()) ?? '').slice(0, 100_000));
  ipcMain.on('clipboard:write', (_e, text) => typeof text === 'string' && clipboard.writeText(text.slice(0, 100_000)));
  ipcMain.on('sessions:active', (_e, n) => {
    activeSessions = Number(n) || 0;
    // Keep the computer awake while a phone is connected.
    if (activeSessions && awakeId === null) awakeId = powerSaveBlocker.start('prevent-display-sleep');
    if (!activeSessions && awakeId !== null) {
      powerSaveBlocker.stop(awakeId);
      awakeId = null;
    }
    updateTray();
  });
  ipcMain.handle('perm:request', (_e, kind) => {
    if (process.platform !== 'darwin') return;
    if (kind === 'accessibility') {
      systemPreferences.isTrustedAccessibilityClient(true);
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    } else if (kind === 'screen') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
  });

  startLanRelay();
  tray = new Tray(trayIcon());
  tray.on('click', showWindow);
  updateTray();
  createWindow(!startHidden);

  app.on('activate', showWindow);
});

app.on('second-instance', showWindow);
app.on('before-quit', () => (quitting = true));
// Stay alive in the tray when the window is closed.
app.on('window-all-closed', () => {});
