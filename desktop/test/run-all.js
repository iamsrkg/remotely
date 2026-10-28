// One-shot E2E: starts the signaling server and an agent with a throwaway identity,
// then runs two simulated phones at the same time (one over LAN, one over the server).
//   node test/run-all.js            # test the dev app
//   node test/run-all.js --packaged # test dist/win-unpacked/Remotely.exe (or the mac .app)
// Note: it moves your mouse to 25%/25% of the main screen and briefly uses the clipboard (restored after).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');
const electron = require('electron'); // path to the electron binary when required from node
const SERVER_PORT = 18099;
const LAN_PORT = 47899;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remotely-e2e-'));
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ serverUrl: `ws://127.0.0.1:${SERVER_PORT}`, lanPort: LAN_PORT, autostart: false }));

const children = [];
const env = (extra) => ({ ...process.env, REMOTELY_DATA_DIR: dataDir, ...extra });
function start(cmd, args, opts, label) {
  const p = spawn(cmd, args, { cwd: root, ...opts });
  let out = '';
  p.stdout?.on('data', (d) => (out += d));
  p.stderr?.on('data', (d) => (out += d));
  p.output = () => out;
  p.label = label;
  children.push(p);
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (port) =>
  new Promise((resolve) => http.get({ host: '127.0.0.1', port, timeout: 1000 }, (r) => resolve(r.statusCode)).on('error', () => resolve(0)));

function agentCommand() {
  if (!process.argv.includes('--packaged')) return [electron, ['.']];
  const win = path.join(root, 'dist/win-unpacked/Remotely.exe');
  const mac = ['dist/mac-arm64', 'dist/mac'].map((d) => path.join(root, d, 'Remotely.app/Contents/MacOS/Remotely')).find(fs.existsSync);
  const bin = process.platform === 'win32' ? win : mac;
  if (!bin || !fs.existsSync(bin)) throw new Error('Packaged app not found. Run npm run dist first.');
  return [bin, []];
}

function phone(label, extra) {
  return new Promise((resolve) => {
    const p = start(electron, ['test/controller-main.js'], { env: env(extra) }, label);
    p.on('exit', (code) => {
      const json = p.output().match(/\{[\s\S]*\}\s*E2E (PASS|FAIL)/);
      resolve({ label, pass: code === 0, report: json ? json[0].replace(/\s*E2E (PASS|FAIL)$/, '') : p.output().slice(-800) });
    });
  });
}

(async () => {
  let ok = false;
  try {
    start(process.execPath, ['../server/index.js'], { env: { ...process.env, PORT: String(SERVER_PORT) } }, 'server');
    const [bin, args] = agentCommand();
    start(bin, args, { env: env({ REMOTELY_DEBUG: '1' }) }, 'agent');

    for (let i = 0; i < 40 && !(await get(LAN_PORT)); i++) await sleep(500);
    if (!(await get(LAN_PORT))) throw new Error('agent LAN relay did not start');
    await sleep(2500); // let the agent register with the server

    const a = phone('phone A (Wi-Fi, stays connected)', { REMOTELY_HOLD_MS: '8000' });
    await sleep(4000);
    const b = phone('phone B (internet relay)', { REMOTELY_PORT: String(SERVER_PORT) });
    const results = await Promise.all([a, b]);

    for (const r of results) {
      console.log(`\n${r.pass ? 'PASS' : 'FAIL'}  ${r.label}`);
      if (!r.pass) console.log(r.report);
    }
    ok = results.every((r) => r.pass);
    const agentErrors = children.find((c) => c.label === 'agent').output().split('\n').filter((l) => /error|uncaught/i.test(l));
    if (agentErrors.length) {
      console.log('\nAgent errors:\n' + agentErrors.join('\n'));
      ok = false;
    }
  } catch (e) {
    console.error('E2E setup failed:', e.message);
  } finally {
    for (const c of children) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F']);
        else c.kill('SIGKILL');
      } catch {}
    }
    console.log(`\n${ok ? 'ALL E2E TESTS PASSED' : 'E2E TESTS FAILED'}`);
    setTimeout(() => process.exit(ok ? 0 : 1), 500);
  }
})();
