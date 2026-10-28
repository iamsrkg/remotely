/* global Protocol, SignalConn */
const $ = (id) => document.getElementById(id);

const MAX_SESSIONS = 4;
const QUALITY = {
  full: { scaleResolutionDownBy: 1, maxBitrate: 8_000_000, maxFramerate: 30 },
  thumb: { scaleResolutionDownBy: 3, maxBitrate: 600_000, maxFramerate: 10 },
};

let st = null;
let key = null;
let registerKey = null;
let conns = [];
/** sid -> Session; several phones can be connected at once */
const sessions = new Map();

// ---------- UI ----------

function render() {
  if (!st) return;
  $('qr').src = st.qr;
  $('device-id').textContent = st.id.replace(/(\d{3})(?=\d)/g, '$1 ');
  if (document.activeElement !== $('name')) $('name').value = st.name;
  if (document.activeElement !== $('server')) $('server').value = st.serverUrl;
  $('autostart').checked = st.autostart;
  $('lan').textContent = st.lanStatus.ok ? st.lan.join(', ') || 'No network' : st.lanStatus.error || 'Starting…';

  const perms = st.permissions;
  const needs = [];
  if (perms.screen !== 'granted') needs.push(['screen', 'Allow Screen Recording']);
  if (!perms.accessibility) needs.push(['accessibility', 'Allow Accessibility (mouse & keyboard)']);
  $('perms').hidden = needs.length === 0;
  $('perm-buttons').replaceChildren(
    ...needs.map(([k, label]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => window.agent.requestPermission(k);
      return b;
    })
  );
  renderConns();
  renderSessions();
}

function renderConns() {
  $('conns').replaceChildren(
    ...conns.map((c) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot ' + (c.status === 'online' ? 'ok' : c.status.startsWith('error') ? 'bad' : 'warn');
      li.append(dot, `${c.label === 'lan' ? 'Same Wi-Fi' : 'Internet'}: ${c.status}`);
      return li;
    })
  );
  if (st && !st.serverUrl) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Internet: set a signaling server below to connect from anywhere';
    $('conns').append(li);
  }
}

let lastNote = '';
function renderSessions(note) {
  if (note) lastNote = note;
  const list = [...sessions.values()];
  $('session-card').classList.toggle('active', list.some((s) => s.state === 'connected'));
  $('session').textContent = list.length ? `${list.length} phone${list.length > 1 ? 's' : ''} connected` : lastNote || 'Waiting for a phone to connect';
  $('session-list').replaceChildren(
    ...list.map((s) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot ' + (s.state === 'connected' ? 'ok' : 'warn');
      const label = document.createElement('span');
      label.style.flex = '1';
      label.textContent = `${s.device} — ${s.state === 'connected' ? (s.quality === 'full' ? 'controlling' : 'viewing') : s.state}`;
      const b = document.createElement('button');
      b.className = 'danger small';
      b.textContent = 'Disconnect';
      b.onclick = () => endSession(s, 'Disconnected');
      li.append(dot, label, b);
      return li;
    })
  );
  window.agent.setActiveSessions(list.filter((s) => s.state === 'connected').length);
}

// ---------- Signaling ----------

function startSignaling() {
  conns.forEach((c) => c.close());
  conns = [];
  const hello = { type: 'hello', role: 'agent', id: st.id, key: registerKey };
  conns.push(new SignalConn('lan', `ws://127.0.0.1:${st.lanPort}`, hello, onSignal, renderConns));
  if (st.serverUrl) conns.push(new SignalConn('cloud', st.serverUrl, hello, onSignal, renderConns));
}

function allIceServers() {
  const out = [];
  for (const c of conns) out.push(...c.iceServers);
  return out;
}

async function onSignal(conn, msg) {
  if (msg.type === 'peer-left') {
    for (const s of sessions.values()) {
      if (s.conn === conn && s.cid === msg.cid && s.state !== 'connected') endSession(s, 'Phone left');
    }
    return;
  }
  if (msg.type !== 'signal') return;
  const body = await Protocol.unseal(key, msg.payload, msg.mac);
  if (!body) return console.warn('rejected unauthenticated signal');

  const existing = sessions.get(body.sid);
  if (body.kind === 'offer') {
    if (existing) endSession(existing);
    if (sessions.size >= MAX_SESSIONS) {
      // Drop the oldest so a returning phone can always get in.
      endSession(sessions.values().next().value, 'Replaced by a newer connection');
    }
    const s = new Session(conn, msg.from, body.sid, body.device || 'Phone');
    sessions.set(body.sid, s);
    renderSessions();
    s.accept(body.sdp).catch((e) => {
      console.error(e);
      endSession(s, 'Failed: ' + e.message);
    });
  } else if (existing && existing.cid === msg.from) {
    if (body.kind === 'ice') existing.addRemoteCandidate(body.candidate);
    else if (body.kind === 'bye') endSession(existing, `${existing.device} disconnected`);
  }
}

function endSession(s, reason) {
  if (!s || sessions.get(s.sid) !== s) return;
  sessions.delete(s.sid);
  s.close();
  if (!sessions.size) window.agent.releaseInput();
  renderSessions(reason || '');
}

function endAll(reason) {
  for (const s of [...sessions.values()]) endSession(s, reason);
}

// ---------- WebRTC session ----------

class Session {
  constructor(conn, cid, sid, device) {
    this.conn = conn;
    this.cid = cid;
    this.sid = sid;
    this.device = device;
    this.state = 'connecting';
    this.quality = 'full';
    this.pending = [];
    this.remoteSet = false;
    this.pc = new RTCPeerConnection({ iceServers: allIceServers() });
    this.pc.onicecandidate = (e) => e.candidate && this.signal({ kind: 'ice', candidate: e.candidate.toJSON() });
    this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
    this.pc.ondatachannel = (e) => this.onChannel(e.channel);
  }

  async signal(body) {
    const env = await Protocol.seal(key, { ...body, sid: this.sid });
    this.conn.send({ type: 'signal', to: this.cid, ...env });
  }

  async accept(sdp) {
    this.screens = await window.agent.listScreens();
    this.screen = this.screens[0] || null;
    this.stream = await captureScreen(this.screen && this.screen.id);
    const track = this.stream.getVideoTracks()[0];
    this.watchTrack(track);
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    this.remoteSet = true;
    this.sender = this.pc.addTrack(track, this.stream);
    for (const c of this.pending) await this.pc.addIceCandidate(c).catch(() => {});
    this.pending = [];
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.applyQuality();
    await this.signal({ kind: 'answer', sdp: this.pc.localDescription.sdp });
  }

  // Sender parameter changes must not overlap, so they are chained.
  applyQuality() {
    this.qualityQueue = (this.qualityQueue || Promise.resolve()).then(() => this.setQuality());
    return this.qualityQueue;
  }

  async setQuality() {
    try {
      const p = this.sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      Object.assign(p.encodings[0], QUALITY[this.quality]);
      p.degradationPreference = 'maintain-resolution';
      await this.sender.setParameters(p);
    } catch (e) {
      console.warn('setParameters', e.message);
    }
  }

  addRemoteCandidate(c) {
    if (!c) return;
    if (this.remoteSet) this.pc.addIceCandidate(c).catch(() => {});
    else this.pending.push(c);
  }

  onState(s) {
    this.state = s;
    if (s === 'connected' && !this.announced) {
      this.announced = true;
      window.agent.notify(`${this.device} connected`, 'Your screen is being shared with this phone. Disconnect from the Remotely window or tray.');
    }
    if (s === 'failed') return endSession(this, 'Connection failed');
    if (s === 'disconnected') {
      clearTimeout(this.dcTimer);
      this.dcTimer = setTimeout(() => this.pc.connectionState === 'disconnected' && endSession(this, 'Connection lost'), 8000);
    }
    renderSessions();
  }

  onChannel(ch) {
    this.channel = ch;
    ch.onopen = async () => {
      this.send({
        t: 'hello',
        name: st.name,
        platform: st.platform,
        screens: this.screens,
        screen: this.screen,
        cursor: await window.agent.cursor(this.screen && this.screen.displayId),
      });
      this.startCursorSync();
    };
    ch.onmessage = (e) => this.onInput(e.data);
    ch.onclose = () => endSession(this, `${this.device} disconnected`);
  }

  // Report cursor moves made on the computer itself so the phone's trackpad cursor stays in sync.
  startCursorSync() {
    clearInterval(this.cursorTimer);
    this.cursorTimer = setInterval(async () => {
      if (!this.screen) return;
      const c = await window.agent.cursor(this.screen.displayId);
      const last = this.lastCursor;
      if (last && Math.abs(last.x - c.x) < 0.001 && Math.abs(last.y - c.y) < 0.001) return;
      this.lastCursor = c;
      this.send({ t: 'cursor', x: c.x, y: c.y });
    }, 250);
  }

  // A capture track ends when a monitor is unplugged or its resolution changes; re-capture instead of freezing.
  watchTrack(track) {
    track.onended = () => {
      if (sessions.get(this.sid) !== this) return;
      this.recoveries = (this.recoveries || 0) + 1;
      if (this.recoveries > 5) return endSession(this, 'Screen capture stopped');
      setTimeout(async () => {
        const list = await window.agent.listScreens();
        const target = list.find((x) => x.id === (this.screen && this.screen.id)) || list[0];
        if (target) this.switchScreen(target.id, true);
      }, 500);
    };
  }

  send(m) {
    if (this.channel && this.channel.readyState === 'open') this.channel.send(JSON.stringify(m));
  }

  async onInput(data) {
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    switch (m.t) {
      case 'ping':
        return this.send({ t: 'pong', ts: m.ts });
      case 'screen':
        return this.switchScreen(m.id);
      case 'quality':
        if (QUALITY[m.q]) {
          this.quality = m.q;
          await this.applyQuality();
          renderSessions();
        }
        return;
      case 'clip-get':
        return this.send({ t: 'clip', s: await window.agent.clipboardRead() });
      case 'clip-set':
        if (typeof m.s === 'string') window.agent.clipboardWrite(m.s);
        return;
      default:
        // Input is applied to the monitor this phone is looking at.
        window.agent.input({ ...m, d: this.screen && this.screen.displayId });
    }
  }

  async switchScreen(id, recovering) {
    try {
      const s = (await window.agent.listScreens()).find((x) => x.id === id);
      if (!s || sessions.get(this.sid) !== this) return;
      const stream = await captureScreen(s.id);
      const track = stream.getVideoTracks()[0];
      await this.sender.replaceTrack(track);
      const old = this.stream;
      this.stream = stream;
      this.watchTrack(track);
      if (old) old.getTracks().forEach((t) => ((t.onended = null), t.stop()));
      this.screen = s;
      if (!recovering) this.recoveries = 0;
      this.lastCursor = null;
      this.send({ t: 'screen', screen: s, screens: await window.agent.listScreens(), cursor: await window.agent.cursor(s.displayId) });
    } catch (e) {
      console.error('switchScreen', e);
      if (recovering) endSession(this, 'Screen capture stopped');
    }
  }

  close() {
    clearTimeout(this.dcTimer);
    clearInterval(this.cursorTimer);
    this.signal({ kind: 'bye' }).catch(() => {});
    this.stream && this.stream.getTracks().forEach((t) => ((t.onended = null), t.stop()));
    try {
      this.pc.close();
    } catch {}
  }
}

// getDisplayMedia calls are serialized because main picks the source per request.
let captureQueue = Promise.resolve();
function captureScreen(sourceId) {
  const run = async () => {
    await window.agent.selectScreen(sourceId);
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';
    await track.applyConstraints({ width: { max: 1920 }, height: { max: 1200 }, frameRate: { max: 30 } }).catch(() => {});
    return stream;
  };
  const p = captureQueue.then(run, run);
  captureQueue = p.catch(() => {});
  return p;
}

// ---------- Boot ----------

async function refresh(restartSignaling) {
  const prev = st;
  st = await window.agent.state();
  if (!prev || prev.secret !== st.secret) {
    key = await Protocol.hmacKey(st.secret);
    registerKey = await Protocol.sign(key, 'register:' + st.id);
  }
  if (restartSignaling || !prev || prev.secret !== st.secret || prev.serverUrl !== st.serverUrl) {
    endAll();
    startSignaling();
  }
  render();
}

$('save').onclick = async () => {
  const url = $('server').value.trim();
  if (url && !/^wss?:\/\//.test(url)) return alertInline('Server URL must start with wss:// or ws://');
  await window.agent.setConfig({ serverUrl: url, name: $('name').value });
  await refresh();
  alertInline('Saved. Re-scan the QR code on your phones if the server changed.');
};

$('autostart').onchange = async (e) => {
  await window.agent.setConfig({ autostart: e.target.checked });
  await refresh();
};

$('reset').onclick = async () => {
  if (!confirm('Unpair all phones and create a new device ID?')) return;
  await window.agent.resetIdentity();
  await refresh(true);
};

$('copy').onclick = () => {
  const code = st.code;
  window.agent.clipboardWrite(code);
  alertInline('Pairing code copied. It gives full control of this computer, so it will be cleared from the clipboard in 60 seconds.');
  // The code contains the pairing secret; don't leave it in the clipboard.
  setTimeout(async () => {
    if ((await window.agent.clipboardRead()) === code) window.agent.clipboardWrite('');
  }, 60_000);
};

function alertInline(text) {
  $('msg').textContent = text;
  clearTimeout(alertInline.t);
  alertInline.t = setTimeout(() => ($('msg').textContent = ''), 4000);
}

window.agent.onStateChanged(() => refresh());
setInterval(() => refresh(), 15000); // pick up network / permission changes
renderSessions();
refresh();
