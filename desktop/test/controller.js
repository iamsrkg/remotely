/* global Protocol */
// Browser port of mobile/src/lib/connection.ts, used by the E2E harness.
(async () => {
  const q = new URLSearchParams(location.search);
  const id = q.get('id');
  const key = await Protocol.hmacKey(q.get('secret'));
  const sid = Protocol.randomHex(8);
  const clipToken = 'remotely-e2e-' + Protocol.randomHex(4);
  const report = { signaling: false, answerVerified: false, forgedRejected: null, hello: null, videoFrames: 0 };
  const hold = Number(q.get('hold') || 0);
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    if (!hold) return window.harness.done(report);
    // Stay connected while another phone connects, then prove this session still works.
    setTimeout(() => {
      dc.onmessage = (e) => {
        if (JSON.parse(e.data).t === 'pong') {
          report.stillConnectedAfterHold = true;
          window.harness.done(report);
        }
      };
      dc.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
    }, hold);
  };

  const ws = new WebSocket(`ws://127.0.0.1:${q.get('port')}`);
  const signal = async (body) => ws.send(JSON.stringify({ type: 'signal', ...(await Protocol.seal(key, { ...body, sid })) }));

  const pc = new RTCPeerConnection();
  pc.addTransceiver('video', { direction: 'recvonly' });
  const dc = pc.createDataChannel('input', { ordered: true });
  pc.onicecandidate = (e) => e.candidate && signal({ kind: 'ice', candidate: e.candidate.toJSON() });
  pc.ontrack = (e) => {
    const v = document.getElementById('v');
    v.srcObject = e.streams[0] || new MediaStream([e.track]);
    const count = () => {
      report.videoFrames++;
      report.videoSize = `${v.videoWidth}x${v.videoHeight}`;
      if (report.videoFrames < 5) v.requestVideoFrameCallback(count);
    };
    v.requestVideoFrameCallback(count);
  };

  dc.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'hello') {
      report.hello = { name: m.name, platform: m.platform, screens: m.screens.length, screen: m.screen };
      dc.send(JSON.stringify({ t: 'move', x: 0.25, y: 0.25 }));
      dc.send(JSON.stringify({ t: 'quality', q: 'thumb' }));
      dc.send(JSON.stringify({ t: 'quality', q: 'full' }));
      dc.send(JSON.stringify({ t: 'clip-set', s: clipToken }));
      setTimeout(() => dc.send(JSON.stringify({ t: 'clip-get' })), 100);
      dc.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
    } else if (m.t === 'cursor') {
      report.cursorUpdates = (report.cursorUpdates || 0) + 1;
    } else if (m.t === 'clip') {
      report.clipboardRoundTrip = m.s === clipToken;
    } else if (m.t === 'pong') {
      report.latencyMs = Date.now() - m.ts;
      setTimeout(async () => (report.cursorAtCheck = await window.harness.cursor()), 150);
      // Give input + video a moment, then report.
      const wait = () => (report.videoFrames >= 3 && report.cursorAtCheck && report.cursorUpdates && report.clipboardRoundTrip !== undefined ? setTimeout(done, 100) : setTimeout(wait, 200));
      wait();
    }
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'welcome') {
      report.signaling = msg.agentOnline;
      // A forged offer (wrong key) must be ignored by the agent.
      const badKey = await Protocol.hmacKey('wrong-secret');
      ws.send(JSON.stringify({ type: 'signal', ...(await Protocol.seal(badKey, { kind: 'offer', sid: 'evil', sdp: 'x' })) }));
      await pc.setLocalDescription(await pc.createOffer());
      signal({ kind: 'offer', sdp: pc.localDescription.sdp, device: 'E2E harness' });
    } else if (msg.type === 'signal') {
      const body = await Protocol.unseal(key, msg.payload, msg.mac);
      if (!body || body.sid !== sid) return;
      if (body.kind === 'answer') {
        report.answerVerified = true;
        await pc.setRemoteDescription({ type: 'answer', sdp: body.sdp });
      } else if (body.kind === 'ice') {
        pc.addIceCandidate(body.candidate).catch(() => {});
      }
    }
  };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'controller', target: id }));
})().catch((e) => {
  console.error(e);
  window.harness.done({ error: String(e) });
});
