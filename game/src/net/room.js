// Online versus rooms relayed through free public MQTT brokers: no server of our own, no accounts.
//
// Both players keep one MQTT-over-WSS connection to the same broker; the first digit of the 5-digit
// room code says which one (BROKERS index + 1). Topics under nbvs1/<code>/:
//   info  retained {v, t, state: 'open'|'full'} from the host, refreshed every 20 s; cleared on
//         close and by the host's last will (EMQX / HiveMQ fire it when the socket dies)
//   h     frames to the host            g     frames to the guest
// Every frame is JSON with f (sender session id) and to (receiver). Control frames: hello / welcome /
// reject / bye. Data frames (k: 'd') batch, per direction:
//   r: [[seq, type, data], ...]  reliable: sequence numbers, cumulative ack `a`, resend after ~1 s
//                                (adapts to rtt + jitter), in-order delivery without duplicates
//   u: [[useq, type, data], ...] unreliable: anything older than the newest delivered of its type
//                                is dropped
//   a ack, pi ping timestamp, po/ph pong (echoed timestamp, ms it was held back)
// Everything sent in one task shares a frame; acks, pings and pongs wait up to RIDE_MS for one.
//
// broker.emqx.io silently drops publishes above 10/s per connection, so a room spends at most
// FRAMES_PER_SEC publishes per sliding second. When that budget is spent, sends wait and are merged
// into the next frame (unreliable messages of one type collapse to the newest): latency, never loss.
//
//   const room = await createRoom({ version, name, onStatus });      // host; show room.code
//   const room = await joinRoom(code, { version, name, onStatus });  // guest
//   room.on('message', ({ type, data }) => ...); room.send('build', {...});
//   room.send('snap', state, { reliable: false });
//   room.on('status', ...); room.on('closed', (reason) => ...); room.close();
import { MqttClient, randomString } from './mqtt.js';

/** Brokers in fallback order. The room code's first digit is the index + 1 (max 9 entries). */
export const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

/** Largest message send() accepts: UTF-8 bytes of JSON.stringify([seq, type, data]). */
export const MAX_MESSAGE_BYTES = 15000;

const PREFIX = 'nbvs1/';
const MAX_FRAME_BYTES = 16000; // one MQTT payload
const FRAMES_PER_SEC = 8; // publish budget per sliding second (EMQX drops above 10/s)
const CONNECT_MS = 5000;
const CODE_CHECK_MS = 1000; // host: wait after SUBACK for a retained info on a candidate code
const INFO_WAIT_MS = 4000; // guest: wait for the room's retained info...
const INFO_AFTER_SUBACK_MS = 2000; // ...but no longer than this past the SUBACK
const WELCOME_MS = 6000;
const STALE_WELCOME_MS = 3000; // info looked stale (dead room or skewed clocks): ask briefly anyway
const HELLO_EVERY_MS = 1000;
const INFO_EVERY_MS = 20000;
const INFO_FRESH_MS = 60000;
const PING_EVERY_MS = 2000;
const LAG_MS = 6000;
const LOST_MS = 20000;
const PROBE_MS = 3000; // peer silent this long: make sure our own broker link still answers
const RIDE_MS = 100; // acks, pings and pongs wait this long for a data frame to ride on
const RESEND_MS = 1000; // resend timeout floor; adapts to rtt + jitter, see _rto()
const RESEND_FIRST_MS = 2000; // before the first rtt sample (and while the peer is lagging)
const RESEND_MAX_MS = 4000;
const MAX_TRIES = 10;
const WINDOW_BYTES = 48000; // reliable bytes in flight
const RECONNECT_DELAYS = [1000, 2000, 4000];
const TICK_MS = 250;
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const SESSION_ID = /^[0-9A-Za-z]{1,32}$/;

const now = () => performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ERROR_TEXT = {
  'bad-code': '房間代碼不正確',
  'not-found': '找不到這個房間',
  full: '房間已滿',
  version: '雙方遊戲版本不同',
  network: '無法連線到伺服器',
  timeout: '房主沒有回應',
};

function roomError(code, extra) {
  return Object.assign(new Error(ERROR_TEXT[code] || code), { code }, extra);
}

function utf8Length(s) {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 2; // surrogate pair: 4 bytes for 2 UTF-16 units
      i++;
    } else n += 2;
  }
  return n;
}

function makeCode(brokerIndex) {
  const r = new Uint16Array(1);
  do crypto.getRandomValues(r); while (r[0] >= 60000); // unbiased 0..9999
  return String(brokerIndex + 1) + String(r[0] % 10000).padStart(4, '0');
}

function parseInfo(text) {
  if (!text) return null;
  try {
    const o = JSON.parse(text);
    if (o && typeof o === 'object' && typeof o.t === 'number') return { v: o.v, t: o.t, state: o.state === 'full' ? 'full' : 'open' };
  } catch {
    // not ours
  }
  return null;
}

// Phone clocks can disagree. A live room whose info looks stale (host clock behind / guest clock
// ahead) is still asked briefly before joinRoom reports not-found; a timestamp from the future
// counts as fresh, so at worst a dead room ends in 'timeout' instead of 'not-found'.
const isFresh = (info) => Date.now() - info.t < INFO_FRESH_MS;

const cleanName = (n) => (typeof n === 'string' ? Array.from(n.trim()).slice(0, 24).join('') : '');

function statusReporter(onStatus) {
  return (text) => {
    try {
      onStatus?.(text);
    } catch (e) {
      console.error(e);
    }
  };
}

/**
 * Connects, retrying fast failures for a few seconds: test.mosquitto.org resets about half of all
 * TLS / WebSocket handshakes, sometimes 4 in a row. A timeout (unreachable broker) or a refused
 * CONNACK is final; an offline device fails its DNS lookups instantly, so it gives up quickly too.
 */
async function connectClient(url, opts) {
  const t0 = now();
  for (let attempt = 1; ; attempt++) {
    const client = new MqttClient(url, { connectTimeout: CONNECT_MS, ...opts });
    try {
      await client.connect();
      return client;
    } catch (e) {
      if (attempt >= 8 || e.code !== 'network' || now() - t0 > CONNECT_MS + 4000) throw e;
      await sleep(250);
    }
  }
}

/**
 * Subscribes to `topics`; resolves with the first info seen on infoTopic, or null after totalMs
 * (or afterSubackMs past the SUBACK, if sooner: brokers send retained messages right behind it).
 */
function readInfo(client, topics, infoTopic, totalMs, afterSubackMs) {
  return new Promise((resolve, reject) => {
    const deadline = now() + totalMs;
    let done = false;
    let timer = setTimeout(() => finish(null), totalMs);
    const finish = (info, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.off('message', onMessage);
      client.off('close', onClose);
      if (err) reject(err);
      else resolve(info);
    };
    const onMessage = (topic, text) => {
      if (topic === infoTopic) finish(parseInfo(text));
    };
    const onClose = () => finish(null, roomError('network'));
    client.on('message', onMessage);
    client.on('close', onClose);
    client.subscribe(topics).then(() => {
      if (done) return;
      clearTimeout(timer);
      timer = setTimeout(() => finish(null), Math.max(0, Math.min(deadline - now(), afterSubackMs)));
    }, () => finish(null, roomError('network')));
  });
}

class Room {
  constructor({ code, isHost, version, name, url, clientId, will }) {
    /** 5-digit room code. */
    this.code = code;
    this.isHost = isHost;
    /** {name, version} of the other player, or null (host waiting). */
    this.peer = null;
    /** Smoothed round trip to the peer through the broker, ms (0 until measured). */
    this.rtt = 0;
    /** 'waiting' | 'connected' | 'lagging' | 'lost' | 'closed' */
    this.status = 'waiting';
    this.version = version;
    this.name = cleanName(name);
    /** Broker URL this room lives on. */
    this.broker = url;
    this._clientId = clientId;
    this._will = will || null;
    this._sid = randomString(8, BASE36);
    const base = PREFIX + code + '/';
    this._tInfo = base + 'info';
    this._tIn = base + (isHost ? 'h' : 'g');
    this._tOut = base + (isHost ? 'g' : 'h');
    this._client = null;
    this._ev = new Map();
    this._inbox = []; // messages that arrived before anyone listened
    this._closed = false;
    this._closing = null;
    this._joining = null;
    this._helloSent = false;
    this._reconnecting = false;
    this._timer = 0;
    this._flushQueued = false;
    this._flushTimer = 0;
    this._flushAt = 0;
    this._sent = []; // publish times within the last second (pacing)
    this._infoState = 'open';
    this._infoAt = 0;
    this._throttled = new Map();
    this._gen = 0;
    this._lossRate = 0; // test hook: share of outgoing data frames silently dropped
    this._stats = { framesOut: 0, framesIn: 0, resent: 0, dup: 0, stale: 0, deferred: 0, reconnects: 0 };
    this._onMessage = (topic, text) => this._onMqtt(topic, text);
    this._onClose = () => this._onClientClose();
    this._resetLink(null);
  }

  // ---------------------------------------------------------------- public API

  on(event, fn) {
    if (!this._ev.has(event)) this._ev.set(event, new Set());
    this._ev.get(event).add(fn);
    if (event === 'message' && this._inbox.length) queueMicrotask(() => this._drainInbox());
    return this;
  }

  off(event, fn) {
    this._ev.get(event)?.delete(fn);
    return this;
  }

  /**
   * Queues a message for the peer. Reliable (default): delivered once, in order, resent until acked.
   * Unreliable: fire-and-forget, only the newest of each type matters (state snapshots).
   * Returns false when nothing was queued: nobody to send to (host waiting, closed), unreliable
   * while reconnecting, or an unreliable message above MAX_MESSAGE_BYTES (dropped with a warning).
   * A reliable message above MAX_MESSAGE_BYTES throws RangeError: dropping it would desync the game.
   */
  send(type, data, { reliable = true } = {}) {
    if (this._closed || !this._peerId || this._joining) return false;
    type = String(type);
    if (reliable) {
      const seq = this._txSeq + 1;
      const json = JSON.stringify([seq, type, data === undefined ? null : data]);
      const bytes = utf8Length(json);
      if (bytes > MAX_MESSAGE_BYTES) throw new RangeError(`net message "${type}" is ${bytes} bytes (max ${MAX_MESSAGE_BYTES})`);
      this._txSeq = seq;
      this._pending.push({ seq, json, bytes, sentAt: 0, tries: 0 });
    } else {
      if (!this._client || this._reconnecting) return false;
      const json = JSON.stringify([this._uSeq + 1, type, data === undefined ? null : data]);
      const bytes = utf8Length(json);
      if (bytes > MAX_MESSAGE_BYTES) {
        if (this._throttle('big:' + type, 10000)) console.warn(`net: unreliable "${type}" dropped: ${bytes} bytes (max ${MAX_MESSAGE_BYTES})`);
        return false;
      }
      this._uSeq++;
      this._uOut.delete(type);
      this._uOut.set(type, { type, json, bytes });
    }
    this._scheduleFlush(0);
    return true;
  }

  /**
   * Leaves the room: queued messages are flushed, the peer gets a bye (its room emits 'closed' 'left',
   * or 'peer-left' on a host), a host clears its retained info, then a clean disconnect.
   * Emits 'closed' with reason 'local' (and `reason` as detail). Resolves when the socket is closed.
   */
  close(reason = 'left') {
    if (this._closed) return this._closing || Promise.resolve();
    const c = this._client;
    if (c && c.connected) {
      if (this._peerId && !this._joining) {
        this._flush(true);
        this._control({ k: 'bye', to: this._peerId, r: String(reason) });
      }
      if (this.isHost) this._publishInfo(null, true);
    }
    this._finish('local', reason);
    this._closing = c ? c.disconnect() : Promise.resolve();
    return this._closing;
  }

  // ---------------------------------------------------------------- events

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

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this._emit('status', s);
  }

  _deliver(type, data, reliable) {
    const msg = { type, data, reliable };
    const listening = this._ev.get('message')?.size > 0;
    if (this._inbox.length || !listening) {
      if (this._inbox.length < 5000) this._inbox.push(msg);
      if (listening) queueMicrotask(() => this._drainInbox());
      return;
    }
    this._emit('message', msg);
  }

  _drainInbox() {
    while (this._inbox.length && !this._closed && this._ev.get('message')?.size > 0) {
      this._emit('message', this._inbox.shift());
    }
  }

  // ---------------------------------------------------------------- link state

  /** Fresh per-peer state: sequence numbers, queues, liveness. */
  _resetLink(peerId) {
    this._gen++;
    this._peerId = peerId;
    this._txSeq = 0;
    this._pending = []; // reliable, unacked: {seq, json, bytes, sentAt, tries}
    this._rxNext = 1;
    this._rxBuf = new Map(); // out-of-order reliable arrivals
    this._ackDue = false;
    this._uSeq = 0;
    this._uOut = new Map(); // newest unreliable per type, waiting for a frame
    this._uIn = new Map(); // newest delivered useq per type
    this._pingDue = false;
    this._pongDue = 0;
    this._pongAt = 0;
    this._pingAt = 0;
    this._probeAt = 0;
    this._lastHeard = now();
    this._srtt = 0;
    this._rttvar = 0;
    this.rtt = 0;
    this._inbox = [];
  }

  _attach(client) {
    this._client = client;
    client.on('message', this._onMessage);
    client.on('close', this._onClose);
  }

  _startTimer() {
    if (!this._timer && !this._closed) this._timer = setInterval(() => this._tick(), TICK_MS);
  }

  _throttle(key, ms) {
    const t = now();
    const last = this._throttled.get(key);
    if (last !== undefined && t - last < ms) return false;
    if (this._throttled.size > 100) this._throttled.clear();
    this._throttled.set(key, t);
    return true;
  }

  _rttSample(ms) {
    if (!this._srtt) {
      this._srtt = ms;
      this._rttvar = ms / 2;
    } else {
      this._rttvar += (Math.abs(this._srtt - ms) - this._rttvar) * 0.25;
      this._srtt += (ms - this._srtt) * 0.2;
    }
    this.rtt = Math.round(this._srtt);
  }

  /** Resend timeout, RFC 6298 style: ~1 s on a quick link, longer on a slow or jittery one. */
  _rto() {
    if (!this._srtt) return RESEND_FIRST_MS;
    return Math.min(RESEND_MAX_MS, Math.max(RESEND_MS, this._srtt + 4 * this._rttvar));
  }

  // ---------------------------------------------------------------- outgoing

  _budget(t) {
    const s = this._sent;
    while (s.length && t - s[0] >= 1000) s.shift();
    return FRAMES_PER_SEC - s.length;
  }

  _publish(topic, text, retain = false) {
    const c = this._client;
    if (!c || !c.connected) return false;
    this._sent.push(now());
    return c.publish(topic, text, { retain });
  }

  _control(obj) {
    obj.f = this._sid;
    return this._publish(this._tOut, JSON.stringify(obj));
  }

  _publishInfo(state, clear = false) {
    if (state) this._infoState = state;
    this._infoAt = now();
    this._publish(this._tInfo, clear ? '' : JSON.stringify({ v: this.version, t: Date.now(), state: this._infoState }), true);
  }

  /** delay 0: flush after the current task (batches synchronous sends); otherwise by a timer. */
  _scheduleFlush(delay) {
    if (delay <= 0) {
      if (this._flushQueued) return;
      this._flushQueued = true;
      queueMicrotask(() => {
        this._flushQueued = false;
        this._flush();
      });
      return;
    }
    const at = now() + delay;
    if (this._flushTimer && this._flushAt <= at) return;
    clearTimeout(this._flushTimer);
    this._flushAt = at;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = 0;
      this._flush();
    }, delay);
  }

  /** Packs everything due into as few frames as the publish budget allows; the rest waits. */
  _flush(force = false) {
    const c = this._client;
    if (this._closed || !this._peerId || this._joining || !c || !c.connected || this._reconnecting) {
      this._uOut.clear();
      return;
    }
    const t = now();
    const connected = this.status === 'connected';
    const resendMs = connected ? this._rto() : Math.max(RESEND_FIRST_MS, this._rto());
    const due = (p) => !p.sentAt || t - p.sentAt >= resendMs;
    if (!(this._pingDue || this._pongDue || this._ackDue || this._uOut.size || this._pending.some(due))) return;
    const budget = force ? Infinity : this._budget(t);
    if (budget < 1) {
      this._deferFlush(t);
      return;
    }
    const head = `{"k":"d","f":"${this._sid}","to":"${this._peerId}","a":${this._rxNext - 1}`;
    let extra = '';
    if (this._pingDue) extra += `,"pi":${Math.max(1, Math.round(t))}`;
    if (this._pongDue) extra += `,"po":${this._pongDue},"ph":${Math.round(t - this._pongAt)}`;
    const frames = [];
    let rel = [];
    let uni = [];
    let size = head.length + extra.length + 2;
    const cut = () => {
      let s = head + extra;
      if (rel.length) s += ',"r":[' + rel.map((p) => p.json).join(',') + ']';
      if (uni.length) s += ',"u":[' + uni.map((u) => u.json).join(',') + ']';
      frames.push(s + '}');
      for (const p of rel) {
        if (p.sentAt) {
          this._stats.resent++;
          if (connected) p.tries++;
        }
        p.sentAt = t;
      }
      for (const u of uni) this._uOut.delete(u.type);
      rel = [];
      uni = [];
      extra = '';
      size = head.length + 2;
    };
    let more = false;
    let inflight = 0;
    for (const p of this._pending) {
      inflight += p.bytes;
      if (inflight > WINDOW_BYTES && p !== this._pending[0]) break;
      if (!due(p)) continue;
      if (size + p.bytes + 1 > MAX_FRAME_BYTES && (rel.length || uni.length)) {
        if (frames.length + 2 > budget) {
          more = true;
          break;
        }
        cut();
      }
      rel.push(p);
      size += p.bytes + 1;
    }
    if (!more) {
      for (const u of this._uOut.values()) {
        if (size + u.bytes + 1 > MAX_FRAME_BYTES && (rel.length || uni.length)) {
          if (frames.length + 2 > budget) {
            more = true;
            break;
          }
          cut();
        }
        uni.push(u);
        size += u.bytes + 1;
      }
    }
    if (rel.length || uni.length || extra || (this._ackDue && !frames.length)) cut();
    this._pingDue = false;
    this._pongDue = 0;
    this._ackDue = false;
    for (const f of frames) {
      this._stats.framesOut++;
      if (this._lossRate && Math.random() < this._lossRate) {
        this._sent.push(now()); // a lost frame still spent its budget
        continue;
      }
      this._publish(this._tOut, f);
    }
    if (more) this._deferFlush(now());
  }

  _deferFlush(t) {
    const s = this._sent;
    const k = s.length - FRAMES_PER_SEC; // entries that must expire before one frame fits
    const wait = k >= 0 ? s[k] + 1000 - t : 0;
    this._stats.deferred++;
    this._scheduleFlush(Math.max(5, wait + 2));
  }

  // ---------------------------------------------------------------- incoming

  _onMqtt(topic, text) {
    if (this._closed || topic !== this._tIn) return;
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    // Anyone can publish on a public broker: only well-formed frames from plain ids get through.
    if (!m || typeof m !== 'object' || typeof m.f !== 'string' || !SESSION_ID.test(m.f) || m.f === this._sid) return;
    if (m.k === 'hello') {
      if (this.isHost) this._onHello(m);
      return;
    }
    // A guest that gave up joining says bye before it knows the host's id (no `to`).
    const forUs = m.to === this._sid || (m.k === 'bye' && m.to === undefined && this.isHost);
    if (!forUs) return;
    if (this._joining) {
      if (m.k === 'welcome') this._onWelcome(m);
      else if (m.k === 'reject') this._joinDone(m.r === 'version' ? roomError('version', { hostVersion: m.v }) : roomError('full'));
      return;
    }
    if (m.f !== this._peerId) {
      // Data from a guest this host no longer knows: tell it once in a while.
      if (this.isHost && m.k === 'd' && this._throttle('kick:' + m.f, 2000)) this._control({ k: 'bye', to: m.f, r: 'kicked' });
      return;
    }
    this._stats.framesIn++;
    this._lastHeard = now();
    if (this.status === 'lagging' && !this._reconnecting) this._setStatus('connected');
    if (m.k === 'd') this._onData(m);
    else if (m.k === 'bye') this._onBye(m);
  }

  _onHello(m) {
    const gid = m.f;
    const ts = typeof m.ts === 'number' ? m.ts : undefined;
    if (gid === this._peerId) { // our welcome got lost: repeat it
      this._control({ k: 'welcome', to: gid, n: this.name, v: this.version, ts });
      return;
    }
    if (!this._throttle('hello:' + gid, 400)) return;
    if (this._peerId) {
      this._control({ k: 'reject', to: gid, r: 'full', v: this.version });
      return;
    }
    if (String(m.v) !== String(this.version)) {
      this._control({ k: 'reject', to: gid, r: 'version', v: this.version });
      return;
    }
    this._resetLink(gid);
    this.peer = { name: cleanName(m.n), version: m.v };
    this._control({ k: 'welcome', to: gid, n: this.name, v: this.version, ts });
    this._publishInfo('full');
    this.status = 'connected';
    this._emit('peer', this.peer);
    this._emit('status', 'connected');
    this._tick();
  }

  _onWelcome(m) {
    this._resetLink(m.f);
    this.peer = { name: cleanName(m.n), version: m.v };
    if (typeof m.ts === 'number') {
      const ms = now() - m.ts;
      if (ms >= 0 && ms < 30000) this._rttSample(ms);
    }
    this.status = 'connected';
    this._joinDone(null);
    this._startTimer();
    this._tick();
  }

  _onData(m) {
    const gen = this._gen;
    if (Number.isInteger(m.a)) {
      const p = this._pending;
      let i = 0;
      while (i < p.length && p[i].seq <= m.a) i++;
      if (i) p.splice(0, i);
    }
    if (typeof m.po === 'number') {
      const ms = now() - m.po - (typeof m.ph === 'number' ? m.ph : 0);
      if (ms >= 0 && ms < 60000) this._rttSample(ms);
    }
    // Hidden browser tabs clamp timers to ~1 s, which would hold acks past the peer's resend
    // timeout; microtasks are not throttled, so answer right away there.
    const ackDelay = globalThis.document?.hidden ? 0 : RIDE_MS;
    if (typeof m.pi === 'number') {
      this._pongDue = m.pi;
      this._pongAt = now();
      this._scheduleFlush(ackDelay);
    }
    if (Array.isArray(m.r) && m.r.length) {
      this._ackDue = true;
      this._scheduleFlush(ackDelay);
      for (const it of m.r) {
        if (!Array.isArray(it) || !Number.isInteger(it[0]) || typeof it[1] !== 'string') continue;
        const seq = it[0];
        if (seq < this._rxNext) {
          this._stats.dup++;
          continue;
        }
        if (seq > this._rxNext) {
          if (seq - this._rxNext < 10000 && this._rxBuf.size < 10000) this._rxBuf.set(seq, it);
          continue;
        }
        this._rxNext++;
        this._deliver(it[1], it[2], true);
        if (this._gen !== gen || this._closed) return;
        while (this._rxBuf.has(this._rxNext)) {
          const next = this._rxBuf.get(this._rxNext);
          this._rxBuf.delete(this._rxNext);
          this._rxNext++;
          this._deliver(next[1], next[2], true);
          if (this._gen !== gen || this._closed) return;
        }
      }
    }
    if (Array.isArray(m.u)) {
      for (const it of m.u) {
        if (!Array.isArray(it) || !Number.isInteger(it[0]) || typeof it[1] !== 'string') continue;
        const last = this._uIn.get(it[1]);
        if (last !== undefined && it[0] <= last) {
          this._stats.stale++;
          continue;
        }
        this._uIn.set(it[1], it[0]);
        this._deliver(it[1], it[2], false);
        if (this._gen !== gen || this._closed) return;
      }
    }
  }

  _onBye(m) {
    const r = typeof m.r === 'string' ? m.r.slice(0, 40) : 'left';
    if (!this.isHost) {
      this._shutdown(r === 'kicked' || r === 'timeout' ? r : 'left', r, false);
      return;
    }
    const peer = this.peer;
    this._resetLink(null);
    this.peer = null;
    this._publishInfo('open');
    this.status = 'waiting';
    this._emit('peer-left', { ...peer, reason: r });
    this._emit('status', 'waiting');
  }

  // ---------------------------------------------------------------- liveness, reconnect, closing

  _tick() {
    if (this._closed) return;
    const t = now();
    const c = this._client;
    const online = !!c && c.connected && !this._reconnecting;
    if (this.isHost && online && t - this._infoAt >= INFO_EVERY_MS) this._publishInfo();
    if (!this._peerId || this._joining) return;
    if (!this._reconnecting) {
      const silent = t - this._lastHeard;
      if (silent >= LOST_MS) {
        this._setStatus('lost');
        this._shutdown('timeout', undefined, true);
        return;
      }
      if (silent >= LAG_MS && this.status === 'connected') this._setStatus('lagging');
      if (silent >= PROBE_MS && online && t - this._probeAt >= PROBE_MS) {
        this._probeAt = t;
        c.probe(); // a dead link of our own fails the probe and triggers a reconnect
      }
    }
    if (!online) return;
    if (this._pending.length && this._pending[0].tries >= MAX_TRIES) {
      this._shutdown('network', 'undeliverable', true);
      return;
    }
    if (t - this._pingAt >= PING_EVERY_MS) {
      this._pingAt = t; // the timestamp itself is taken when the frame goes out
      this._pingDue = true;
      this._scheduleFlush(RIDE_MS);
    }
    if (this._pending.length) this._flush(); // resends that are due
  }

  _onClientClose() {
    if (this._closed) return;
    const c = this._client;
    if (c) {
      c.off('message', this._onMessage);
      c.off('close', this._onClose);
    }
    this._client = null;
    if (this._joining) {
      this._joinDone(roomError('network'));
      return;
    }
    if (this._reconnecting) return;
    this._reconnecting = true;
    if (this._peerId && this.status === 'connected') this._setStatus('lagging');
    this._reconnect();
  }

  /** Same broker, same client id (takes over a half-dead session), backoff 1/2/4 s. */
  async _reconnect() {
    for (const delay of RECONNECT_DELAYS) {
      await sleep(delay);
      if (this._closed) return;
      let client;
      try {
        client = await connectClient(this.broker, { clientId: this._clientId, will: this._will });
      } catch {
        continue;
      }
      try {
        client.on('message', this._onMessage);
        await client.subscribe(this._tIn);
      } catch {
        client.off('message', this._onMessage);
        client.disconnect();
        continue;
      }
      if (this._closed) {
        client.off('message', this._onMessage);
        client.disconnect();
        return;
      }
      this._attach(client);
      this._reconnecting = false;
      this._stats.reconnects++;
      this._lastHeard = Math.max(this._lastHeard, now() - LAG_MS); // peer gets time to answer
      for (const p of this._pending) p.sentAt = 0;
      this._pingAt = 0;
      if (this.isHost) this._publishInfo();
      this._tick();
      return;
    }
    if (!this._closed) this._shutdown('network', 'reconnect failed', false);
  }

  /** Ends the room for a non-local reason: best-effort bye and info cleanup, then disconnect. */
  _shutdown(reason, detail, sayBye) {
    if (this._closed) return;
    const c = this._client;
    if (c && c.connected) {
      if (sayBye && this._peerId) this._control({ k: 'bye', to: this._peerId, r: reason });
      if (this.isHost) this._publishInfo(null, true);
    }
    this._finish(reason, detail);
    if (c) this._closing = c.disconnect();
  }

  _finish(reason, detail) {
    this._closed = true;
    this._reconnecting = false;
    clearInterval(this._timer);
    this._timer = 0;
    clearTimeout(this._flushTimer);
    this._flushTimer = 0;
    const c = this._client;
    if (c) {
      c.off('message', this._onMessage);
      c.off('close', this._onClose);
    }
    this._setStatus('closed');
    this._emit('closed', reason, detail);
  }

  // ---------------------------------------------------------------- guest handshake

  _handshake(ms, timeoutCode) {
    return new Promise((resolve, reject) => {
      const hello = () => {
        this._helloSent = true;
        this._control({ k: 'hello', n: this.name, v: this.version, ts: Math.round(now()) });
      };
      this._joining = {
        resolve,
        reject,
        hello: setInterval(hello, HELLO_EVERY_MS),
        timer: setTimeout(() => this._joinDone(roomError(timeoutCode)), ms),
      };
      hello();
    });
  }

  _joinDone(err) {
    const j = this._joining;
    if (!j) return;
    this._joining = null;
    clearInterval(j.hello);
    clearTimeout(j.timer);
    if (err) j.reject(err);
    else j.resolve();
  }

  /** A join that failed: no events, just let go (and tell the host in case it did accept us). */
  _abort() {
    const c = this._client;
    if (c && c.connected && this._helloSent && !this._peerId) this._control({ k: 'bye', r: 'left' });
    this._closed = true;
    clearInterval(this._timer);
    clearTimeout(this._flushTimer);
    if (c) {
      c.off('message', this._onMessage);
      c.off('close', this._onClose);
    }
    this._client = null;
    this.status = 'closed';
  }
}

/**
 * Hosts a new room: tries BROKERS in order (~5 s connect timeout each), draws a free code, publishes
 * the retained room info and listens for a guest. Rejects with err.code 'network' if no broker works.
 * @param {{version: string, name?: string, onStatus?: (text: string) => void}} opts
 * @returns {Promise<Room>} status 'waiting'; 'peer' fires when a guest joins
 */
export async function createRoom({ version, name = '', onStatus } = {}) {
  const say = statusReporter(onStatus);
  const urls = BROKERS.slice();
  for (let b = 0; b < urls.length; b++) {
    say(b === 0 ? '連線中…' : `伺服器 ${b} 無法連線，改用伺服器 ${b + 1}…`);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeCode(b);
      const will = { topic: PREFIX + code + '/info', payload: '', retain: true };
      let client;
      try {
        client = await connectClient(urls[b], { will });
      } catch {
        break; // broker unreachable: next one
      }
      const room = new Room({ code, isHost: true, version, name, url: urls[b], clientId: client.clientId, will });
      try {
        if (attempt === 0) say('建立房間中…');
        // One SUBSCRIBE for the inbox and the code check; nobody knows the code yet, so no hello is missed.
        const info = await readInfo(client, [room._tIn, room._tInfo], room._tInfo, CONNECT_MS, CODE_CHECK_MS);
        if (info && isFresh(info)) { // code in use: draw another
          await client.disconnect();
          continue;
        }
        client.unsubscribe(room._tInfo).catch(() => {});
        room._attach(client);
        room._publishInfo('open');
        room._startTimer();
        say('已建立房間');
        return room;
      } catch {
        client.disconnect();
        break;
      }
    }
  }
  throw roomError('network');
}

/**
 * Joins a room by code. Rejects with err.code 'bad-code' | 'not-found' | 'full' |
 * 'version' (err.hostVersion) | 'network' | 'timeout'.
 * @param {string} code 5 digits
 * @param {{version: string, name?: string, onStatus?: (text: string) => void}} opts
 * @returns {Promise<Room>} status 'connected', room.peer = host
 */
export async function joinRoom(code, { version, name = '', onStatus } = {}) {
  const say = statusReporter(onStatus);
  const clean = String(code ?? '').replace(/\s+/g, '');
  const b = /^\d{5}$/.test(clean) ? clean.charCodeAt(0) - 49 : -1;
  if (b < 0 || b >= BROKERS.length) throw roomError('bad-code');
  const url = BROKERS[b];
  say('連線中…');
  let client;
  try {
    client = await connectClient(url);
  } catch {
    throw roomError('network');
  }
  const room = new Room({ code: clean, isHost: false, version, name, url, clientId: client.clientId });
  try {
    say('尋找房間…');
    const info = await readInfo(client, [room._tIn, room._tInfo], room._tInfo, INFO_WAIT_MS, INFO_AFTER_SUBACK_MS);
    if (!info) throw roomError('not-found');
    const fresh = isFresh(info);
    if (fresh && String(info.v) !== String(version)) throw roomError('version', { hostVersion: info.v });
    if (fresh && info.state === 'full') throw roomError('full');
    room._attach(client);
    client.unsubscribe(room._tInfo).catch(() => {});
    say('加入房間中…');
    await room._handshake(fresh ? WELCOME_MS : STALE_WELCOME_MS, fresh ? 'timeout' : 'not-found');
    say('已加入房間');
    return room;
  } catch (e) {
    room._abort();
    client.disconnect();
    throw e && e.code && ERROR_TEXT[e.code] ? e : roomError('network');
  }
}
