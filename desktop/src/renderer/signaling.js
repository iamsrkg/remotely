// A self-reconnecting WebSocket to a signaling relay (LAN or cloud).
class SignalConn {
  constructor(label, url, hello, onMessage, onStatus) {
    this.label = label;
    this.url = url;
    this.hello = hello;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.iceServers = [];
    this.status = 'connecting';
    this.delay = 1000;
    this.closed = false;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.setStatus('error: ' + e.message);
      return;
    }
    this.ws = ws;
    this.setStatus('connecting');
    ws.onopen = () => {
      this.delay = 1000;
      ws.send(JSON.stringify(this.hello));
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        this.iceServers = msg.iceServers || [];
        this.setStatus('online');
      } else if (msg.type === 'error') {
        this.setStatus('error: ' + msg.error);
        if (msg.error === 'id-taken') this.closed = true;
      }
      this.onMessage(this, msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (!this.closed) {
        if (!this.status.startsWith('error')) this.setStatus('offline');
        setTimeout(() => this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, 30000);
      }
    };
  }

  setStatus(s) {
    this.status = s;
    this.onStatus(this);
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.closed = true;
    try {
      this.ws && this.ws.close();
    } catch {}
  }
}

window.SignalConn = SignalConn;
