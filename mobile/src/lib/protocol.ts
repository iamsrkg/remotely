// Signed signaling envelopes. Must match desktop/src/renderer/protocol.js.
// payload = JSON string, mac = hex(HMAC-SHA256(utf8(secret), utf8(payload))).
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { getRandomBytes } from 'expo-crypto';

const MAX_SKEW_MS = 10 * 60 * 1000;

export type Envelope = { payload: string; mac: string };

export function sign(secret: string, text: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(text)));
}

export function randomHex(n: number): string {
  return bytesToHex(getRandomBytes(n));
}

export function seal(secret: string, body: Record<string, unknown>): Envelope {
  const payload = JSON.stringify({ ...body, ts: Date.now(), nonce: randomHex(12) });
  return { payload, mac: sign(secret, payload) };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const seen = new Map<string, number>();

/** Returns the parsed payload, or null if forged, stale, or replayed. */
export function unseal(secret: string, payload: unknown, mac: unknown): Record<string, any> | null {
  if (typeof payload !== 'string' || typeof mac !== 'string') return null;
  if (!safeEqual(sign(secret, payload), mac.toLowerCase())) return null;
  let body: any;
  try {
    body = JSON.parse(payload);
  } catch {
    return null;
  }
  const now = Date.now();
  if (Math.abs(now - body.ts) > MAX_SKEW_MS || seen.has(body.nonce)) return null;
  seen.set(body.nonce, now);
  for (const [n, t] of seen) if (now - t > MAX_SKEW_MS * 2) seen.delete(n);
  return body;
}
