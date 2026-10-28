const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const DEFAULTS = {
  serverUrl: process.env.REMOTELY_SERVER || '',
  lanPort: 47800,
  autostart: true,
};

const file = () => path.join(app.getPath('userData'), 'config.json');

function newIdentity() {
  return {
    id: String(crypto.randomInt(100_000_000, 999_999_999)),
    secret: crypto.randomBytes(32).toString('base64url'),
  };
}

function load() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {}
  if (!cfg.id || !cfg.secret) Object.assign(cfg, newIdentity());
  cfg = { ...DEFAULTS, name: os.hostname(), ...cfg };
  save(cfg);
  return cfg;
}

function save(cfg) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function lanAddresses(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(`${a.address}:${port}`);
    }
  }
  return out;
}

module.exports = { load, save, newIdentity, lanAddresses };
