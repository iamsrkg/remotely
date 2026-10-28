// Signaling relay shared by the cloud server and the desktop agent's LAN server.
// The relay is untrusted: it only routes messages. Peers authenticate each other
// with HMACs over every payload using the pairing secret, which the relay never sees.
//
// NOTE: desktop/src/main/relay.js is a copy of this file (see desktop/scripts/copy-relay.js).

const crypto = require('crypto');

const MAX_MSG = 64 * 1024;
const PING_MS = 25_000;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * @param {import('ws').WebSocketServer} wss
 * @param {{ iceServers?: (id: string) => object[], log?: (...a: any[]) => void }} [opts]
 */
function attachRelay(wss, opts = {}) {
  const log = opts.log || (() => {});
  const iceServers = opts.iceServers || (() => []);
  /** agentId -> ws */
  const agents = new Map();
  /** agentId -> sha256(registerKey); first registration wins (TOFU) */
  const owners = new Map();
  /** cid -> ws (controllers) */
  const controllers = new Map();

  const send = (ws, msg) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  wss.on('connection', (ws) => {
    ws.cid = crypto.randomBytes(8).toString('hex');
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    ws.on('message', (raw) => {
      if (raw.length > MAX_MSG) return ws.close(1009, 'too big');
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'hello') {
        if (ws.role) return;
        if (msg.role === 'agent' && typeof msg.id === 'string' && typeof msg.key === 'string') {
          const keyHash = sha256(msg.key);
          const owner = owners.get(msg.id);
          if (owner && owner !== keyHash) {
            send(ws, { type: 'error', error: 'id-taken' });
            return ws.close(4001, 'id-taken');
          }
          owners.set(msg.id, keyHash);
          const prev = agents.get(msg.id);
          if (prev && prev !== ws) prev.close(4002, 'replaced');
          ws.role = 'agent';
          ws.agentId = msg.id;
          agents.set(msg.id, ws);
          log('agent online', msg.id);
          send(ws, { type: 'welcome', cid: ws.cid, iceServers: iceServers(msg.id) });
        } else if (msg.role === 'controller' && typeof msg.target === 'string') {
          ws.role = 'controller';
          ws.target = msg.target;
          controllers.set(ws.cid, ws);
          send(ws, {
            type: 'welcome',
            cid: ws.cid,
            iceServers: iceServers(msg.target),
            agentOnline: agents.has(msg.target),
          });
        }
        return;
      }

      if (msg.type === 'signal' && typeof msg.payload === 'string' && typeof msg.mac === 'string') {
        if (ws.role === 'controller') {
          const agent = agents.get(ws.target);
          if (!agent) return send(ws, { type: 'agent-offline' });
          send(agent, { type: 'signal', from: ws.cid, payload: msg.payload, mac: msg.mac });
        } else if (ws.role === 'agent' && typeof msg.to === 'string') {
          const c = controllers.get(msg.to);
          if (c && c.target === ws.agentId) {
            send(c, { type: 'signal', payload: msg.payload, mac: msg.mac });
          }
        }
      }
    });

    ws.on('close', () => {
      if (ws.role === 'agent' && agents.get(ws.agentId) === ws) {
        agents.delete(ws.agentId);
        log('agent offline', ws.agentId);
        for (const c of controllers.values()) if (c.target === ws.agentId) send(c, { type: 'agent-offline' });
      } else if (ws.role === 'controller') {
        controllers.delete(ws.cid);
        send(agents.get(ws.target), { type: 'peer-left', cid: ws.cid });
      }
    });
  });

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_MS);
  wss.on('close', () => clearInterval(timer));
}

module.exports = { attachRelay };
