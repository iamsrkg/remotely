// Signed signaling envelopes. Must match mobile/src/lib/protocol.ts.
// payload = JSON string, mac = hex(HMAC-SHA256(utf8(secret), utf8(payload))).

const enc = new TextEncoder();
const MAX_SKEW_MS = 10 * 60 * 1000;

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array((hex.match(/../g) || []).map((h) => parseInt(h, 16)));
const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(key, text) {
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

async function seal(key, body) {
  const payload = JSON.stringify({ ...body, ts: Date.now(), nonce: randomHex(12) });
  return { payload, mac: await sign(key, payload) };
}

const seenNonces = new Map();

/** Returns the parsed payload, or null if forged, stale, or replayed. */
async function unseal(key, payload, mac) {
  if (typeof payload !== 'string' || typeof mac !== 'string') return null;
  const ok = await crypto.subtle.verify('HMAC', key, fromHex(mac), enc.encode(payload));
  if (!ok) return null;
  let body;
  try {
    body = JSON.parse(payload);
  } catch {
    return null;
  }
  const now = Date.now();
  if (Math.abs(now - body.ts) > MAX_SKEW_MS || seenNonces.has(body.nonce)) return null;
  seenNonces.set(body.nonce, now);
  for (const [n, t] of seenNonces) if (now - t > MAX_SKEW_MS * 2) seenNonces.delete(n);
  return body;
}

window.Protocol = { hmacKey, sign, seal, unseal, randomHex };
