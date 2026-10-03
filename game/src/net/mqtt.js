// Minimal MQTT 3.1.1 client over WebSocket (subprotocol "mqtt"), zero dependencies.
// Runs in browsers / the Android WebView and in Node 22+ (global WebSocket).
//
// Scope: CONNECT (clean session, optional last will), QoS 0 PUBLISH with optional retain (an empty
// retained payload clears the topic), QoS 0 SUBSCRIBE / UNSUBSCRIBE, PINGREQ keepalive, DISCONNECT.
// Incoming QoS 1/2 publishes are acknowledged, though a QoS 0 subscription never receives them.
// Mobile networks often drop TCP silently, so a PINGREQ that goes unanswered for `ackTimeout` ms
// counts as a dead link: the socket is torn down and 'close' fires instead of hanging forever.
//
//   const c = new MqttClient('wss://broker.example:8084/mqtt');
//   c.on('message', (topic, text, { retain, bytes }) => ...);
//   c.on('close', ({ reason, local }) => ...);   // once, when an established connection ends
//   await c.connect(); await c.subscribe('a/b'); c.publish('a/b', 'hi', { retain: true });
//   await c.disconnect();
// A client is single-use: after it closes, make a new one (reuse clientId to take over the session).

const CONNECT = 1, CONNACK = 2, PUBLISH = 3, PUBACK = 4, PUBREC = 5, PUBREL = 6, PUBCOMP = 7;
const SUBSCRIBE = 8, SUBACK = 9, UNSUBSCRIBE = 10, UNSUBACK = 11, PINGREQ = 12, PINGRESP = 13, DISCONNECT = 14;
const MAX_PACKET = 4 * 1024 * 1024; // refuse to buffer anything bigger (brokers cap far lower)
const CONNACK_TEXT = ['accepted', 'unacceptable protocol version', 'identifier rejected',
  'server unavailable', 'bad user name or password', 'not authorized'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const now = () => performance.now();
const netError = (message, code = 'network') => Object.assign(new Error(message), { code });

/** MQTT "remaining length" varint: 1-4 bytes, 7 bits each, least significant group first. */
export function encodeLength(n) {
  if (!Number.isInteger(n) || n < 0 || n > 268435455) throw new RangeError('MQTT remaining length out of range: ' + n);
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 128;
    out.push(b);
  } while (n > 0);
  return out;
}

/** Decodes a remaining length at buf[offset]; null if more bytes are needed. Throws if malformed. */
export function decodeLength(buf, offset = 0, end = buf.length) {
  let value = 0;
  let mult = 1;
  for (let i = 0; i < 4; i++) {
    if (offset + i >= end) return null;
    const b = buf[offset + i];
    value += (b & 127) * mult;
    if (b < 128) return { value, bytes: i + 1 };
    mult *= 128;
  }
  throw new Error('malformed MQTT remaining length');
}

const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Uniform random string from crypto.getRandomValues (rejection sampling, no modulo bias). */
export function randomString(len, alphabet = ALNUM) {
  const limit = 256 - (256 % alphabet.length);
  const bytes = new Uint8Array(len + 8);
  let out = '';
  while (out.length < len) {
    crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && out.length < len; i++) {
      if (bytes[i] < limit) out += alphabet[bytes[i] % alphabet.length];
    }
  }
  return out;
}

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return encoder.encode(v == null ? '' : String(v));
}

/** UTF-8 string / binary field with its 2-byte big-endian length prefix. */
function field(v) {
  const b = toBytes(v);
  if (b.length > 65535) throw new RangeError('MQTT string field too long');
  const out = new Uint8Array(b.length + 2);
  out[0] = b.length >> 8;
  out[1] = b.length & 255;
  out.set(b, 2);
  return out;
}

function packet(first, parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const head = encodeLength(len);
  const out = new Uint8Array(1 + head.length + len);
  out[0] = first;
  out.set(head, 1);
  let o = 1 + head.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u16 = (n) => Uint8Array.of((n >> 8) & 255, n & 255);

export class MqttClient {
  /**
   * @param {string} url wss://host:port/path
   * @param {object} [opts]
   * @param {string} [opts.clientId] default: random 22 chars (fits the 23-char MQTT 3.1.1 guarantee)
   * @param {number} [opts.keepalive=30] seconds, sent in CONNECT
   * @param {number} [opts.connectTimeout=5000] ms until CONNACK
   * @param {number} [opts.ackTimeout=8000] ms to wait for SUBACK / UNSUBACK / PINGRESP
   * @param {{topic: string, payload?: string|Uint8Array, retain?: boolean}} [opts.will] QoS 0 last will
   * @param {(url: string, protocols: string[]) => WebSocket} [opts.createSocket] custom WebSocket factory
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.clientId = opts.clientId || 'nb' + randomString(20);
    this.keepalive = opts.keepalive ?? 30;
    this.connectTimeout = opts.connectTimeout ?? 5000;
    this.ackTimeout = opts.ackTimeout ?? 8000;
    this.will = opts.will || null;
    this.createSocket = opts.createSocket || ((u, protocols) => new WebSocket(u, protocols));
    this.state = 'new'; // 'new' | 'connecting' | 'open' | 'closed'
    this.connected = false;
    this.pingRtt = 0; // ms, last PINGREQ -> PINGRESP
    this._ws = null;
    this._ev = new Map();
    this._buf = new Uint8Array(4096);
    this._len = 0;
    this._pid = 0;
    this._waits = new Map(); // packet id -> { resolve, reject, timer }
    this._timer = 0;
    this._connectTimer = 0;
    this._connectWait = null;
    this._pingSent = 0;
    this._lastTx = 0;
    this._lastRx = 0;
  }

  on(event, fn) {
    if (!this._ev.has(event)) this._ev.set(event, new Set());
    this._ev.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    this._ev.get(event)?.delete(fn);
    return this;
  }

  _emit(event, ...args) {
    const set = this._ev.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** Bytes queued in the WebSocket but not yet sent (0 where the runtime does not report it). */
  get bufferedAmount() {
    return (this._ws && this._ws.bufferedAmount) || 0;
  }

  /** Opens the socket and resolves on CONNACK; rejects with err.code 'timeout' | 'network' | 'refused'. */
  connect() {
    if (this.state !== 'new') return Promise.reject(netError('MqttClient is single-use'));
    this.state = 'connecting';
    return new Promise((resolve, reject) => {
      this._connectWait = { resolve, reject };
      this._connectTimer = setTimeout(() => this._connectFailed('MQTT connect timeout', 'timeout'), this.connectTimeout);
      let ws;
      try {
        ws = this.createSocket(this.url, ['mqtt']);
      } catch (e) {
        this._connectFailed('WebSocket: ' + ((e && e.message) || e));
        return;
      }
      this._ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => this._write(this._connectPacket());
      ws.onmessage = (e) => this._onData(e.data);
      ws.onerror = () => {
        if (this.state === 'connecting') this._connectFailed('WebSocket error');
      };
      ws.onclose = (e) => {
        const why = `socket closed (${e.code}${e.reason ? ' ' + e.reason : ''})`;
        if (this.state === 'connecting') this._connectFailed(why);
        else this._drop(why);
      };
    });
  }

  _connectPacket() {
    let flags = 0x02; // clean session
    const head = Uint8Array.of(4, 0, (this.keepalive >> 8) & 255, this.keepalive & 255); // level 4 = 3.1.1
    const parts = [field('MQTT'), head, field(this.clientId)];
    const w = this.will;
    if (w) {
      flags |= 0x04 | (w.retain ? 0x20 : 0); // will flag, QoS 0, optional will retain
      parts.push(field(w.topic), field(w.payload ?? ''));
    }
    head[1] = flags;
    return packet(CONNECT << 4, parts);
  }

  _connectFailed(message, code = 'network') {
    if (this.state !== 'connecting') return;
    const wait = this._connectWait;
    this._shutdown();
    wait?.reject(netError(message, code));
  }

  /** QoS 0 publish; returns false when not connected (the message is dropped). */
  publish(topic, payload = '', { retain = false } = {}) {
    if (this.state !== 'open') return false;
    return this._write(packet((PUBLISH << 4) | (retain ? 1 : 0), [field(topic), toBytes(payload)]));
  }

  /** QoS 0 subscription(s); resolves with the granted QoS list once SUBACK arrives. */
  subscribe(topics) {
    const list = [].concat(topics);
    const parts = [];
    for (const t of list) parts.push(field(t), Uint8Array.of(0));
    return this._request(SUBSCRIBE, parts).then((codes) => {
      if (codes.length < list.length || codes.some((c) => c > 2)) throw netError('MQTT subscribe refused', 'refused');
      return Array.from(codes);
    });
  }

  unsubscribe(topics) {
    return this._request(UNSUBSCRIBE, [].concat(topics).map(field)).then(() => undefined);
  }

  _request(type, parts) {
    return new Promise((resolve, reject) => {
      if (this.state !== 'open') {
        reject(netError('MQTT not connected'));
        return;
      }
      this._pid = (this._pid % 65535) + 1;
      const id = this._pid;
      const timer = setTimeout(() => {
        this._waits.delete(id);
        reject(netError('MQTT ack timeout', 'timeout'));
      }, this.ackTimeout);
      this._waits.set(id, { resolve, reject, timer });
      this._write(packet((type << 4) | 2, [u16(id), ...parts]));
    });
  }

  /** Sends a PINGREQ now (unless one is outstanding); no PINGRESP within ackTimeout -> 'close'. */
  probe() {
    if (this.state !== 'open' || this._pingSent) return;
    this._pingSent = now();
    this._write(Uint8Array.of(PINGREQ << 4, 0));
  }

  /** Clean shutdown: DISCONNECT (the broker discards the will), then closes the socket. */
  disconnect() {
    if (this.state === 'connecting') this._connectFailed('disconnected');
    if (this.state !== 'open') return Promise.resolve();
    this._write(Uint8Array.of(DISCONNECT << 4, 0));
    const ws = this._ws;
    this._ws = null; // keep the socket open until its queued bytes (DISCONNECT included) are flushed
    this._shutdown();
    this._emit('close', { reason: 'local', local: true });
    if (!ws) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 1500);
      ws.onopen = ws.onmessage = ws.onerror = null;
      ws.onclose = done;
      try {
        ws.close(1000);
      } catch {
        done();
      }
    });
  }

  /** Abrupt close without DISCONNECT, as if the network dropped: the broker publishes the will. */
  terminate() {
    if (this.state === 'connecting') this._connectFailed('terminated');
    else this._drop('terminated');
  }

  // ---------------------------------------------------------------- internals

  _write(bytes) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(bytes);
    } catch (e) {
      this._drop('send failed: ' + ((e && e.message) || e));
      return false;
    }
    this._lastTx = now();
    return true;
  }

  /** An established connection ended unexpectedly. */
  _drop(reason) {
    if (this.state !== 'open') return;
    this._shutdown();
    this._emit('close', { reason, local: false });
  }

  _shutdown() {
    this.state = 'closed';
    this.connected = false;
    this._connectWait = null;
    clearTimeout(this._connectTimer);
    clearInterval(this._timer);
    this._timer = 0;
    for (const w of this._waits.values()) {
      clearTimeout(w.timer);
      w.reject(netError('MQTT connection closed'));
    }
    this._waits.clear();
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        // already closing
      }
    }
  }

  _tick() {
    if (this.state !== 'open') return;
    const t = now();
    if (this._pingSent) {
      if (t - this._pingSent > this.ackTimeout) this._drop('ping timeout');
      return;
    }
    const idle = this.keepalive * 500; // ping at half the keepalive, both directions
    if (t - this._lastTx >= idle || t - this._lastRx >= idle) this.probe();
  }

  /** Appends a WebSocket frame and handles every complete MQTT packet in the buffer. */
  _onData(data) {
    if (typeof data === 'string' || this.state === 'closed') return; // MQTT over WS is binary-only
    const chunk = data instanceof ArrayBuffer ? new Uint8Array(data) : toBytes(data);
    this._lastRx = now();
    if (this._len + chunk.length > this._buf.length) {
      let cap = this._buf.length * 2;
      while (cap < this._len + chunk.length) cap *= 2;
      const grown = new Uint8Array(cap);
      grown.set(this._buf.subarray(0, this._len));
      this._buf = grown;
    }
    this._buf.set(chunk, this._len);
    this._len += chunk.length;
    let off = 0;
    try {
      while (this._len - off >= 2) {
        const rl = decodeLength(this._buf, off + 1, this._len);
        if (!rl) break;
        if (rl.value > MAX_PACKET) throw new Error('MQTT packet too large: ' + rl.value);
        const start = off + 1 + rl.bytes;
        const end = start + rl.value;
        if (end > this._len) break;
        const first = this._buf[off];
        off = end;
        this._packet(first >> 4, first & 15, this._buf.subarray(start, end));
        if (this.state === 'closed') return;
      }
    } catch (e) {
      this._emit('error', e);
      if (this.state === 'connecting') this._connectFailed('MQTT protocol error: ' + e.message);
      else this._drop('protocol error: ' + e.message);
      return;
    }
    if (off) {
      this._buf.copyWithin(0, off, this._len);
      this._len -= off;
    }
    if (this._buf.length > 65536 && this._len <= 4096) { // give back the room a big packet needed
      const small = new Uint8Array(4096);
      small.set(this._buf.subarray(0, this._len));
      this._buf = small;
    }
  }

  _packet(type, flags, b) {
    if (type === CONNACK) {
      if (this.state !== 'connecting') return;
      const rc = b.length >= 2 ? b[1] : 255;
      if (rc !== 0) {
        this._connectFailed('MQTT connection refused: ' + (CONNACK_TEXT[rc] || rc), 'refused');
        return;
      }
      const wait = this._connectWait;
      this._connectWait = null;
      clearTimeout(this._connectTimer);
      this.state = 'open';
      this.connected = true;
      this._lastRx = this._lastTx = now();
      this._timer = setInterval(() => this._tick(), 1000);
      wait?.resolve();
      return;
    }
    if (this.state !== 'open') return;
    switch (type) {
      case PUBLISH: {
        if (b.length < 2) throw new Error('short PUBLISH');
        const qos = (flags >> 1) & 3;
        const tl = (b[0] << 8) | b[1];
        let o = 2 + tl;
        if (o > b.length) throw new Error('bad PUBLISH topic length');
        const topic = decoder.decode(b.subarray(2, o));
        if (qos) {
          if (o + 2 > b.length) throw new Error('short PUBLISH');
          const id = (b[o] << 8) | b[o + 1];
          o += 2;
          this._write(packet((qos === 1 ? PUBACK : PUBREC) << 4, [u16(id)]));
        }
        const bytes = b.slice(o);
        this._emit('message', topic, decoder.decode(bytes), { retain: !!(flags & 1), qos, dup: !!(flags & 8), bytes });
        return;
      }
      case PUBREL:
        if (b.length >= 2) this._write(packet(PUBCOMP << 4, [b.slice(0, 2)]));
        return;
      case SUBACK:
      case UNSUBACK: {
        if (b.length < 2) return;
        const id = (b[0] << 8) | b[1];
        const w = this._waits.get(id);
        if (w) {
          this._waits.delete(id);
          clearTimeout(w.timer);
          w.resolve(b.slice(2));
        }
        return;
      }
      case PINGRESP:
        if (this._pingSent) {
          this.pingRtt = now() - this._pingSent;
          this._pingSent = 0;
        }
        return;
      default: // PUBACK / PUBREC / PUBCOMP: we only publish QoS 0
    }
  }
}
