// E2E harness: acts like the phone. Pairs with a running agent over its LAN relay,
// receives the screen stream, sends a mouse move, and checks the real cursor moved.
//   REMOTELY_DATA_DIR=<agent data dir> npx electron test/controller-main.js
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, clipboard, ipcMain, screen } = require('electron');

const dataDir = process.env.REMOTELY_DATA_DIR;
const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
app.setPath('userData', path.join(dataDir, `controller-${process.pid}`));

app.whenReady().then(async () => {
  const before = screen.getCursorScreenPoint();
  // readText() is async in recent Electron versions.
  const savedClipboard = String((await clipboard.readText()) ?? '');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'controller-preload.js'), contextIsolation: true },
  });
  const finish = (code, report) => {
    try {
      clipboard.writeText(savedClipboard);
    } catch {}
    console.log(JSON.stringify(report, null, 2));
    console.log(code === 0 ? 'E2E PASS' : 'E2E FAIL');
    app.exit(code);
  };
  ipcMain.handle('cursor', () => screen.getCursorScreenPoint());
  ipcMain.on('done', (_e, report) => {
    const after = screen.getCursorScreenPoint();
    report.cursorBefore = before;
    report.cursorAfter = after;
    const d = screen.getPrimaryDisplay().bounds;
    const target = { x: d.x + 0.25 * d.width, y: d.y + 0.25 * d.height };
    const at = report.cursorAtCheck || after;
    report.cursorMovedToTarget = Math.abs(at.x - target.x) < 4 && Math.abs(at.y - target.y) < 4;
    const ok = report.signaling && report.answerVerified && report.videoFrames > 0 && report.hello && report.cursorMovedToTarget && report.clipboardRoundTrip &&
      (!Number(process.env.REMOTELY_HOLD_MS) || report.stillConnectedAfterHold);
    finish(ok ? 0 : 1, report);
  });
  setTimeout(() => finish(1, { error: 'timeout' }), 30000 + Number(process.env.REMOTELY_HOLD_MS || 0));
  win.webContents.on('console-message', (e) => console.log('[page]', e.message));
  win.loadFile(path.join(__dirname, 'controller.html'), {
    query: { id: cfg.id, secret: cfg.secret, port: process.env.REMOTELY_PORT || String(cfg.lanPort), hold: process.env.REMOTELY_HOLD_MS || '0' },
  });
});
