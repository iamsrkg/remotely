import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

export type Device = {
  id: string;
  secret: string;
  name: string;
  /** "ip:port" addresses of the agent's LAN relay */
  lan: string[];
  /** Cloud signaling server, e.g. wss://remotely.example.com */
  server?: string;
  addedAt: number;
};

const KEY = 'remotely.devices.v1';
// Pairing secrets grant full control of a computer, so they live in the OS keychain/keystore,
// not in plain AsyncStorage. Only non-secret metadata is stored in AsyncStorage.
const secretKey = (id: string) => `remotely.secret.${id.replace(/[^0-9a-zA-Z]/g, '')}`;

export async function loadDevices(): Promise<Device[]> {
  let stored: Device[] = [];
  try {
    const raw = await AsyncStorage.getItem(KEY);
    stored = raw ? (JSON.parse(raw) as Device[]) : [];
  } catch {
    return [];
  }
  const out: Device[] = [];
  let migrated = false;
  for (const d of stored) {
    if (d.secret) {
      // Older versions kept the secret in AsyncStorage: move it to secure storage.
      await SecureStore.setItemAsync(secretKey(d.id), d.secret);
      migrated = true;
      out.push(d);
      continue;
    }
    const secret = await SecureStore.getItemAsync(secretKey(d.id)).catch(() => null);
    if (secret) out.push({ ...d, secret });
  }
  if (migrated) await saveDevices(out);
  return out;
}

async function saveDevices(list: Device[]) {
  for (const d of list) await SecureStore.setItemAsync(secretKey(d.id), d.secret);
  await AsyncStorage.setItem(KEY, JSON.stringify(list.map((d) => ({ ...d, secret: '' }))));
}

export async function upsertDevice(d: Device): Promise<Device[]> {
  const list = (await loadDevices()).filter((x) => x.id !== d.id);
  list.unshift(d);
  await saveDevices(list);
  return list;
}

export async function removeDevice(id: string): Promise<Device[]> {
  await SecureStore.deleteItemAsync(secretKey(id)).catch(() => {});
  const list = (await loadDevices()).filter((x) => x.id !== id);
  await saveDevices(list);
  return list;
}

function base64UrlToBytes(s: string): number[] {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const clean = s.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error('bad character');
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

function utf8Decode(bytes: number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    s += String.fromCodePoint(cp);
  }
  return s;
}

/** Parses the pairing code shown by the desktop agent (QR content). */
export function parsePairingCode(code: string): Device {
  let p: any;
  try {
    p = JSON.parse(utf8Decode(base64UrlToBytes(code)));
  } catch {
    throw new Error('This is not a Remotely pairing code.');
  }
  if (p?.v !== 1 || typeof p.id !== 'string' || typeof p.s !== 'string') {
    throw new Error('Unsupported pairing code. Update the apps.');
  }
  return {
    id: p.id,
    secret: p.s,
    name: typeof p.n === 'string' ? p.n : `Computer ${p.id}`,
    lan: Array.isArray(p.lan) ? p.lan.filter((x: unknown) => typeof x === 'string') : [],
    server: typeof p.srv === 'string' && p.srv ? p.srv : undefined,
    addedAt: Date.now(),
  };
}
