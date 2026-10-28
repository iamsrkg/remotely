// Remotely cloud signaling server.
//
// Env:
//   PORT            listen port (default 8080)
//   STUN_URLS       comma-separated STUN urls (default Google STUN)
//   TURN_URLS       comma-separated TURN urls, e.g. turn:turn.example.com:3478,turns:turn.example.com:5349
//   TURN_SECRET     coturn `static-auth-secret` -> short-lived credentials are minted per connection
//   TURN_USERNAME / TURN_CREDENTIAL   static TURN credentials (used if TURN_SECRET is not set)

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { attachRelay } = require('./relay');

const PORT = Number(process.env.PORT) || 8080;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const STUN = list(process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302');
const TURN = list(process.env.TURN_URLS);

function iceServers(id) {
  const out = [];
  if (STUN.length) out.push({ urls: STUN });
  if (TURN.length) {
    if (process.env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:${id}`;
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
      out.push({ urls: TURN, username, credential });
    } else if (process.env.TURN_USERNAME) {
      out.push({ urls: TURN, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL || '' });
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
attachRelay(wss, { iceServers, log: (...a) => console.log(new Date().toISOString(), ...a) });

server.listen(PORT, () => console.log(`Remotely signaling listening on :${PORT}`));
