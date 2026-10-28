// Keeps one live RemoteSession per computer so several computers can stay
// connected at once and screens can switch between them without reconnecting.
import type { Device } from './devices';
import { RemoteSession } from './connection';

const live = new Map<string, RemoteSession>();

export function getSession(device: Device): RemoteSession {
  const existing = live.get(device.id);
  if (existing && !existing.isClosed && existing.snap.status !== 'failed') return existing;
  existing?.close();
  const s = new RemoteSession(device);
  live.set(device.id, s);
  s.start();
  return s;
}

export function restartSession(device: Device): RemoteSession {
  closeSession(device.id);
  return getSession(device);
}

export function closeSession(id: string) {
  live.get(id)?.close();
  live.delete(id);
}

export function closeAll() {
  for (const id of [...live.keys()]) closeSession(id);
}
