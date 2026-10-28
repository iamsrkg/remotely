// Controller side: finds the computer (LAN first, then cloud), negotiates WebRTC,
// receives the screen stream, and sends input over a data channel.
import { Platform } from 'react-native';
import { RTCPeerConnection, RTCIceCandidate, MediaStream } from 'react-native-webrtc';
import type { Device } from './devices';
import { randomHex, seal, unseal } from './protocol';

export type ScreenInfo = { id: string; displayId: string; name: string; w: number; h: number };
export type Hello = {
  name: string;
  platform: string;
  screens: ScreenInfo[];
  screen: ScreenInfo;
  cursor: { x: number; y: number };
};

export type InputMsg =
  | { t: 'move'; x: number; y: number }
  | { t: 'down' | 'up'; b: 'left' | 'right' | 'middle' }
  | { t: 'click'; b: 'left' | 'right' | 'middle'; n?: number }
  | { t: 'scroll'; dx: number; dy: number }
  | { t: 'text'; s: string }
  | { t: 'key'; k: string; mods?: string[] }
  | { t: 'screen'; id: string }
  | { t: 'ping'; ts: number }
  | { t: 'quality'; q: 'full' | 'thumb' }
  | { t: 'clip-get' }
  | { t: 'clip-set'; s: string };

export type Status = 'finding' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

export type Events = {
  onStatus: (s: Status, detail?: string) => void;
  onStream: (url: string) => void;
  onHello: (h: Hello) => void;
  onScreen: (screen: ScreenInfo, cursor: { x: number; y: number }) => void;
  onLatency: (ms: number) => void;
  onClipboard?: (text: string) => void;
  /** Cursor moved on the computer itself (normalized to the viewed screen). */
  onCursor?: (c: { x: number; y: number }) => void;
};

/** Latest known state, replayed to whichever screen attaches to the session. */
export type Snapshot = {
  status: Status;
  detail?: string;
  streamUrl: string | null;
  hello: Hello | null;
  screen: ScreenInfo | null;
  cursor: { x: number; y: number };
  latency: number | null;
};

const noop = () => {};
const NO_EVENTS: Events = { onStatus: noop, onStream: noop, onHello: noop, onScreen: noop, onLatency: noop };

type Signal = { ws: WebSocket; via: 'lan' | 'cloud'; iceServers: any[] };

const FIND_TIMEOUT_MS = 8000;

function openSignal(url: string, via: 'lan' | 'cloud', target: string): Promise<Signal> {
  return new Promise((resolve, reject) => {
    let done = false;
    const ws = new WebSocket(url);
    const fail = (why: string) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {}
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail('timeout'), FIND_TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'controller', target }));
    ws.onerror = () => fail('error');
    ws.onclose = () => fail('closed');
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type !== 'welcome' || done) return;
      clearTimeout(timer);
      if (!msg.agentOnline) return fail('offline');
      done = true;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      resolve({ ws, via, iceServers: msg.iceServers || [] });
    };
  });
}

function firstFulfilled<T>(ps: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let failed = 0;
    for (const p of ps) p.then(resolve, () => ++failed === ps.length && reject(new Error('all failed')));
  });
}

/** Resolves with the first relay where the agent is online. LAN gets a short head start. */
async function findAgent(device: Device): Promise<Signal> {
  const attempts: Promise<Signal>[] = device.lan.map((addr) => openSignal(`ws://${addr}`, 'lan', device.id));
  if (device.server) {
    const server = device.server;
    attempts.push(
      new Promise<void>((r) => setTimeout(r, device.lan.length ? 600 : 0)).then(() =>
        openSignal(server, 'cloud', device.id)
      )
    );
  }
  if (!attempts.length) throw new Error('No way to reach this computer. Re-pair it.');
  const winner = await firstFulfilled(attempts).catch(() => {
    throw new Error(
      device.server
        ? 'Computer is offline. Make sure Remotely is running on it.'
        : 'Computer not found on this Wi-Fi. Set a signaling server on the computer to connect over the internet.'
    );
  });
  // Close the losers once they settle.
  for (const a of attempts) a.then((s) => s !== winner && s.ws.close()).catch(() => {});
  return winner;
}

export class RemoteSession {
  private pc: RTCPeerConnection | null = null;
  private dc: any = null;
  private sig: Signal | null = null;
  private sid = randomHex(8);
  private pendingIce: any[] = [];
  private remoteSet = false;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  via: 'lan' | 'cloud' | null = null;
  snap: Snapshot = { status: 'finding', streamUrl: null, hello: null, screen: null, cursor: { x: 0.5, y: 0.5 }, latency: null };
  private listeners = new Set<Events>();

  /** Fans events out to every attached screen and records them in `snap`. */
  private ev: Events = {
    onStatus: (status, detail) => {
      this.snap = { ...this.snap, status, detail };
      this.listeners.forEach((l) => l.onStatus(status, detail));
    },
    onStream: (url) => {
      this.snap = { ...this.snap, streamUrl: url };
      this.listeners.forEach((l) => l.onStream(url));
    },
    onHello: (h) => {
      this.snap = { ...this.snap, hello: h, screen: h.screen, cursor: h.cursor };
      this.listeners.forEach((l) => l.onHello(h));
    },
    onScreen: (screen, cursor) => {
      this.snap = { ...this.snap, screen, cursor };
      this.listeners.forEach((l) => l.onScreen(screen, cursor));
    },
    onLatency: (ms) => {
      this.snap = { ...this.snap, latency: ms };
      this.listeners.forEach((l) => l.onLatency(ms));
    },
    onClipboard: (text) => this.listeners.forEach((l) => l.onClipboard?.(text)),
    onCursor: (cur) => {
      this.snap = { ...this.snap, cursor: cur };
      this.listeners.forEach((l) => l.onCursor?.(cur));
    },
  };

  constructor(readonly device: Device) {}

  /** Attach a screen's handlers; returns a detach function. */
  subscribe(l: Partial<Events>): () => void {
    const full = { ...NO_EVENTS, ...l };
    this.listeners.add(full);
    return () => this.listeners.delete(full);
  }

  get isClosed() {
    return this.closed;
  }

  async start() {
    this.ev.onStatus('finding');
    try {
      this.sig = await findAgent(this.device);
    } catch (e: any) {
      return this.fail(e.message);
    }
    if (this.closed) return this.sig.ws.close();
    this.via = this.sig.via;
    this.ev.onStatus('connecting', this.via === 'lan' ? 'Same Wi-Fi' : 'Internet');
    this.sig.ws.onmessage = (e) => this.onSignal(String(e.data));
    this.sig.ws.onclose = () => {
      if (!this.closed && this.pc?.connectionState !== 'connected') this.fail('Signaling connection lost');
    };

    const pc = new RTCPeerConnection({ iceServers: this.sig.iceServers });
    this.pc = pc;
    pc.addEventListener('icecandidate', (e: any) => {
      if (e.candidate) this.signal({ kind: 'ice', candidate: e.candidate.toJSON?.() ?? e.candidate });
    });
    pc.addEventListener('track', (e: any) => {
      const stream: MediaStream = e.streams?.[0] ?? new MediaStream([e.track]);
      this.ev.onStream(stream.toURL());
    });
    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      if (s === 'connected') this.ev.onStatus('connected', this.via === 'lan' ? 'Same Wi-Fi' : 'Internet');
      else if (s === 'disconnected') this.ev.onStatus('reconnecting');
      else if (s === 'failed') this.fail('Connection failed. A TURN server may be needed on this network.');
    });

    pc.addTransceiver('video', { direction: 'recvonly' });
    const dc = pc.createDataChannel('input', { ordered: true });
    this.dc = dc;
    dc.addEventListener('message', (e: any) => this.onData(e.data));
    dc.addEventListener('open', () => {
      this.pingTimer = setInterval(() => this.send({ t: 'ping', ts: Date.now() }), 2000);
    });
    dc.addEventListener('close', () => !this.closed && this.fail('Computer disconnected'));

    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    this.signal({
      kind: 'offer',
      sdp: pc.localDescription?.sdp,
      device: Platform.OS === 'ios' ? 'iPhone' : 'Android phone',
    });
  }

  private signal(body: Record<string, unknown>) {
    const ws = this.sig?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'signal', ...seal(this.device.secret, { ...body, sid: this.sid }) }));
  }

  private async onSignal(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'agent-offline') {
      if (this.pc?.connectionState !== 'connected') this.fail('Computer went offline');
      return;
    }
    if (msg.type !== 'signal' || !this.pc) return;
    const body = unseal(this.device.secret, msg.payload, msg.mac);
    if (!body || body.sid !== this.sid) return; // forged, replayed, or for another session
    if (body.kind === 'answer') {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: body.sdp });
      this.remoteSet = true;
      for (const c of this.pendingIce) await this.pc.addIceCandidate(c).catch(() => {});
      this.pendingIce = [];
    } else if (body.kind === 'ice' && body.candidate) {
      const c = new RTCIceCandidate(body.candidate);
      if (this.remoteSet) this.pc.addIceCandidate(c).catch(() => {});
      else this.pendingIce.push(c);
    } else if (body.kind === 'bye') {
      this.fail('Disconnected by the computer');
    }
  }

  private onData(raw: string) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === 'hello') this.ev.onHello(m);
    else if (m.t === 'screen') {
      // The monitor list can change (monitor plugged/unplugged).
      if (Array.isArray(m.screens) && this.snap.hello) {
        const hello = { ...this.snap.hello, screens: m.screens, screen: m.screen, cursor: m.cursor ?? this.snap.cursor };
        this.snap = { ...this.snap, hello };
        this.ev.onHello(hello);
      }
      this.ev.onScreen(m.screen, m.cursor);
    } else if (m.t === 'cursor' && typeof m.x === 'number' && typeof m.y === 'number') this.ev.onCursor?.({ x: m.x, y: m.y });
    else if (m.t === 'pong') this.ev.onLatency(Date.now() - m.ts);
    else if (m.t === 'clip' && typeof m.s === 'string') this.ev.onClipboard?.(m.s);
  }

  send(m: InputMsg) {
    if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(m));
  }

  private fail(reason: string) {
    if (this.closed) return;
    this.cleanup();
    this.ev.onStatus('failed', reason);
  }

  close() {
    if (this.closed) return;
    this.signal({ kind: 'bye' });
    this.cleanup();
    this.ev.onStatus('closed');
  }

  private cleanup() {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      this.dc?.close();
    } catch {}
    try {
      this.pc?.close();
    } catch {}
    try {
      this.sig?.ws.close();
    } catch {}
  }
}
