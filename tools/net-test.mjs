// Live test of the online versus layer (game/src/net/) against the REAL public MQTT brokers.
// One Node process; every scenario uses independent Room instances (separate MQTT connections).
// Usage:
//   node tools/net-test.mjs             codec checks, per-broker suite on every broker, then the
//                                       extended suite + broker fallback on the first broker that works
//   node tools/net-test.mjs --quick     skip the slow cases (6 s lagging, 20 s lost timeout)
//   node tools/net-test.mjs --broker 2  per-broker suite only on broker #2 (extended suite runs there)
//   node tools/net-test.mjs --limits    only probe payload size / publish rate limits of each broker
// Exit code 0 when everything passed. Traffic stays small: a few hundred KB per broker.
import { MqttClient, encodeLength, decodeLength, randomString } from '../game/src/net/mqtt.js';
import { BROKERS, MAX_MESSAGE_BYTES, createRoom, joinRoom } from '../game/src/net/room.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i < 0 ? def : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const QUICK = !!opt('quick', false);
const ONLY = opt('broker', null);
const LIMITS = !!opt('limits', false);

const ORIGINAL = BROKERS.slice();
const DEAD_DNS = 'wss://nb-unreachable.invalid/mqtt'; // no such host: fails fast
const BLACKHOLE = 'wss://192.0.2.1:8084/mqtt'; // TEST-NET-1, never answers: runs into the connect timeout
const VERSION = 'net-test-1';
const HOST_NAME = '房主 Host';
const GUEST_NAME = '客人 Guest';

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const rand4 = () => String(Math.floor(Math.random() * 10000)).padStart(4, '0');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function until(pred, ms, what) {
  const t0 = now();
  while (!pred()) {
    if (now() - t0 > ms) throw new Error('timed out waiting for ' + (typeof what === 'function' ? what() : what));
    await sleep(15);
  }
}

function once(target, event, pred = () => true, ms = 15000) {
  return new Promise((resolve, reject) => {
    const fn = (...a) => {
      if (!pred(...a)) return;
      clearTimeout(timer);
      target.off(event, fn);
      resolve(a);
    };
    const timer = setTimeout(() => {
      target.off(event, fn);
      reject(new Error(`no '${event}' event within ${ms} ms`));
    }, ms);
    target.on(event, fn);
  });
}

function stats(list) {
  const s = [...list].sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], med: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}
const fmt = (st, keys = ['min', 'med', 'p95', 'max']) => (st ? keys.map((k) => Math.round(st[k])).join('/') : '-');

function useBrokers(list) {
  BROKERS.length = 0;
  BROKERS.push(...list);
}
/** Brokers before #i made unreachable, so createRoom has to fall back to #i (code digit i + 1). */
const forced = (i) => ORIGINAL.map((u, j) => (j < i ? DEAD_DNS : u));

// ---------------------------------------------------------------- runner

const results = [];
let group = '';
function section(name) {
  group = name;
  console.log(`\n== ${name}`);
}

async function test(name, fn, ms = 45000) {
  const t0 = now();
  let ok = false;
  let note = '';
  let timer;
  try {
    const r = await Promise.race([fn(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`test timed out after ${ms} ms`)), ms)))]);
    ok = true;
    if (typeof r === 'string') note = r;
  } catch (e) {
    note = (e && e.message) || String(e);
  }
  clearTimeout(timer);
  const t = Math.round(now() - t0);
  results.push({ group, name, ok, ms: t, note });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} ${String(t).padStart(6)} ms  ${note}`);
  return ok;
}

const open = new Set();
function track(room) {
  open.add(room);
  room.on('closed', () => open.delete(room));
  return room;
}
async function closeAll() {
  await Promise.all([...open].map((r) => r.close('test-end')));
  open.clear();
}

async function expectReject(promise, code) {
  let room;
  try {
    room = await promise;
  } catch (e) {
    if (e.code === code) return e;
    throw new Error(`expected '${code}', got '${e.code}' (${e.message})`);
  }
  track(room);
  throw new Error(`expected '${code}', but it succeeded`);
}

/** A plain MQTT connection, retrying handshake resets like the game does (test.mosquitto.org drops ~50%). */
async function rawClient(url) {
  for (let i = 1; ; i++) {
    const c = new MqttClient(url);
    try {
      await c.connect();
      return c;
    } catch (e) {
      if (i >= 8 || e.code !== 'network') throw new Error(`connect failed ${i}x: ${e.message}`);
      await sleep(300);
    }
  }
}

/** Reads a room's retained info with a separate connection. */
async function readInfoRaw(url, code) {
  const c = await rawClient(url);
  try {
    let info;
    c.on('message', (t, text) => {
      if (t.endsWith('/info')) info = text ? JSON.parse(text) : null;
    });
    await c.subscribe(`nbvs1/${code}/info`);
    await until(() => info !== undefined, 3000, 'retained info').catch(() => {});
    return info;
  } finally {
    await c.disconnect();
  }
}

async function pair({ hostVersion = VERSION, guestVersion = VERSION } = {}) {
  const log = [];
  let t0 = now();
  const host = track(await createRoom({ version: hostVersion, name: HOST_NAME, onStatus: (s) => log.push('host ' + s) }));
  const createMs = now() - t0;
  const joined = once(host, 'peer');
  // Sent the moment the guest is accepted, before its joinRoom() resolves: it must not get lost.
  host.on('peer', () => host.send('greet', { text: '歡迎 👋' }));
  t0 = now();
  const guest = track(await joinRoom(host.code, { version: guestVersion, name: GUEST_NAME, onStatus: (s) => log.push('guest ' + s) }));
  const joinMs = now() - t0;
  await joined;
  return { host, guest, createMs, joinMs, log };
}

// ---------------------------------------------------------------- scenario helpers

async function reliableExchange(a, b, n, ms = 30000) {
  const got = { toA: [], toB: [] };
  const fa = (m) => m.type === 'seq' && got.toA.push(m.data.i);
  const fb = (m) => m.type === 'seq' && got.toB.push(m.data.i);
  a.on('message', fa);
  b.on('message', fb);
  try {
    for (let i = 0; i < n; i += 10) { // bursts of 10, so they span many frames
      for (let k = i; k < Math.min(n, i + 10); k++) {
        a.send('seq', { i: k, pad: 'x'.repeat(k % 61), zh: '霓虹防線' });
        b.send('seq', { i: k, pad: 'y'.repeat((k * 7) % 61) });
      }
      await sleep(25);
    }
    await until(() => got.toA.length >= n && got.toB.length >= n, ms, () => `${n} each way (got ${got.toB.length} / ${got.toA.length})`);
    await sleep(800); // late duplicates would show up here
    for (const [side, list] of Object.entries(got)) {
      assert(list.length === n, `${side}: ${list.length} delivered, expected ${n} (duplicates)`);
      list.forEach((v, idx) => assert(v === idx, `${side}: out of order at #${idx}: got ${v}`));
    }
  } finally {
    a.off('message', fa);
    b.off('message', fb);
  }
}

/** 40 snapshots of ~2 KB at 20 Hz (above the room's publish budget, so they get coalesced). */
async function unreliableStream(from, to, count = 40, every = 50) {
  const seen = [];
  const delays = [];
  const f = (m) => {
    if (m.type !== 'snap') return;
    seen.push(m.data.n);
    delays.push(now() - m.data.t);
  };
  to.on('message', f);
  try {
    for (let n = 0; n < count; n++) {
      from.send('snap', { n, t: now(), body: 'x'.repeat(2000) }, { reliable: false });
      await sleep(every);
    }
    await until(() => seen.includes(count - 1), 8000, 'the newest snapshot');
    for (let k = 1; k < seen.length; k++) assert(seen[k] > seen[k - 1], 'older snapshot after a newer one: ' + seen.join(','));
    // Inject a frame carrying an old unreliable sequence number: it must be dropped.
    await sleep(1100); // let the publish budget recover first (raw publish bypasses the room's pacing)
    const stale = to._stats.stale;
    from._client.publish(from._tOut, JSON.stringify({ k: 'd', f: from._sid, to: to._sid, a: from._rxNext - 1, u: [[1, 'snap', { n: -1, t: now() }]] }));
    await until(() => to._stats.stale > stale, 5000, 'the stale frame');
    assert(!seen.includes(-1), 'stale snapshot was delivered');
    return { delivered: seen.length, delays: stats(delays) };
  } finally {
    to.off('message', f);
  }
}

function bigPayload(bytes) {
  const zh = '霓虹防線'.repeat(300); // 3600 UTF-8 bytes
  const base = enc.encode(JSON.stringify([99999, 'big', { zh, pad: '' }])).length;
  return { zh, pad: 'p'.repeat(bytes - base) };
}

async function bigMessages(host, guest) {
  let threw = false;
  try {
    host.send('big', bigPayload(MAX_MESSAGE_BYTES + 50));
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert(threw, 'an oversized reliable send() must throw RangeError');
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  let sent;
  try {
    sent = host.send('big', bigPayload(MAX_MESSAGE_BYTES + 50), { reliable: false });
  } finally {
    console.warn = warn;
  }
  assert(sent === false && warnings.length === 1, 'an oversized unreliable send() must be dropped with a warning');
  const data = bigPayload(MAX_MESSAGE_BYTES - 20);
  const got = [];
  const f = (m) => m.type === 'big' && got.push(m);
  host.on('message', f);
  guest.on('message', f);
  try {
    host.send('big', data);
    guest.send('big', data, { reliable: false });
    await until(() => got.length >= 2, 15000, 'both big messages');
    for (const m of got) assert(m.data.zh === data.zh && m.data.pad === data.pad, 'big message corrupted');
    return `${enc.encode(JSON.stringify([1, 'big', data])).length} B each way`;
  } finally {
    host.off('message', f);
    guest.off('message', f);
  }
}

/**
 * Versus-match traffic, both ways at once: ~3 KB enemy snapshot at 5 Hz + tower list at 1 Hz
 * (unreliable) + a reliable command every 0.6 s. Checks the publish rate never exceeds what
 * broker.emqx.io accepts (10/s per connection) and that every command arrives.
 */
async function gameLoad(host, guest, seconds = 10) {
  const sides = [host, guest].map((room) => {
    const s = { room, pubs: [], snaps: [], delays: [], cmds: [], sentCmds: 0, resent0: room._stats.resent };
    const orig = room._publish;
    room._publish = function (...x) {
      s.pubs.push(now());
      return orig.apply(this, x);
    };
    s.restore = () => delete room._publish;
    return s;
  });
  const [h, g] = sides;
  const listen = (s) => (m) => {
    if (m.type === 'lsnap') {
      s.snaps.push(m.data.n);
      s.delays.push(now() - m.data.t);
    } else if (m.type === 'cmd') s.cmds.push(m.data.i);
  };
  const lh = listen(h);
  const lg = listen(g);
  host.on('message', lh);
  guest.on('message', lg);
  const enemies = (n, k) => Array.from({ length: n }, (_, i) => [1000 + i, i % 17, -1500 + ((i * 37 + k * 11) % 3000), 2200 - ((i * 53 + k * 7) % 4400), 100 - (i % 100), i % 7]);
  const towers = (n) => Array.from({ length: n }, (_, i) => [i + 1, i % 11, 1 + (i % 4), i % 3, i % 13, (i * 5) % 9, i % 4]);
  try {
    const t0 = now();
    let n = 0;
    while (now() - t0 < seconds * 1000) {
      for (const [from, s] of [[host, g], [guest, h]]) { // s: the receiving side's record
        from.send('lsnap', { n, t: now(), l: 20, e: 1234, w: 7, en: enemies(110, n) }, { reliable: false });
        if (n % 5 === 0) from.send('towers', { tw: towers(30) }, { reliable: false });
        if (n % 3 === 0) from.send('cmd', { i: s.sentCmds++ });
      }
      n++;
      await sleep(200);
    }
    await until(() => h.cmds.length >= h.sentCmds && g.cmds.length >= g.sentCmds, 15000, 'all commands');
    await sleep(500);
    const perSec = (list) => {
      let best = 0;
      for (let i = 0, j = 0; i < list.length; i++) {
        while (list[i] - list[j] >= 1000) j++;
        best = Math.max(best, i - j + 1);
      }
      return best;
    };
    for (const s of sides) {
      assert(s.cmds.length === s.sentCmds && s.cmds.every((v, k) => v === k), 'commands out of order / missing');
      assert(perSec(s.pubs) <= 9, `published ${perSec(s.pubs)} frames in one second (EMQX drops above 10)`);
    }
    const snapBytes = enc.encode(JSON.stringify([1, 'lsnap', { n: 1, t: 1, l: 20, e: 1234, w: 7, en: enemies(110, 1) }])).length;
    const d = stats([...h.delays, ...g.delays]);
    return {
      note: `snap ${snapBytes} B: ${g.snaps.length}+${h.snaps.length}/${2 * n} delivered, delay med/p95 ${fmt(d, ['med', 'p95'])} ms; ` +
        `max ${perSec(h.pubs)}/${perSec(g.pubs)} publishes/s; resent ${host._stats.resent - h.resent0}/${guest._stats.resent - g.resent0}`,
      delays: d,
    };
  } finally {
    host.off('message', lh);
    guest.off('message', lg);
    for (const s of sides) s.restore();
  }
}

async function roundTrips(host, guest, count = 15) {
  await until(() => host.rtt > 0 && guest.rtt > 0, 8000, 'heartbeat rtt on both sides');
  const samples = [];
  const echo = (m) => m.type === 'echo' && host.send('echo-r', m.data);
  host.on('message', echo);
  try {
    for (let k = 0; k < count; k++) {
      const t = now();
      const back = once(guest, 'message', (m) => m.type === 'echo-r' && m.data.k === k, 8000);
      guest.send('echo', { k });
      await back;
      samples.push(now() - t);
      await sleep(120);
    }
  } finally {
    host.off('message', echo);
  }
  return stats(samples);
}

// ---------------------------------------------------------------- codec (offline)

const field = (s) => {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
};
const pk = (first, ...parts) => {
  const body = parts.flat();
  return [first, ...encodeLength(body.length), ...body];
};
const pub = (topic, payload, retain = 0, qos = 0, id = 0) =>
  pk(0x30 | (qos << 1) | retain, field(topic), qos ? [id >> 8, id & 255] : [], [...enc.encode(payload)]);
const same = (a, b) => a && a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const dec = new TextDecoder();

function fakeSocket() {
  const sock = {
    readyState: 0,
    sent: [],
    send(b) {
      this.sent.push(Uint8Array.from(b));
    },
    close() {
      this.readyState = 3;
      setTimeout(() => this.onclose && this.onclose({ code: 1000, reason: '' }));
    },
    feed(bytes) {
      this.onmessage({ data: Uint8Array.from(bytes).buffer });
    },
  };
  const create = (url, protocols) => {
    sock.protocols = protocols;
    setTimeout(() => {
      sock.readyState = 1;
      sock.onopen();
    });
    return sock;
  };
  return { sock, create };
}

async function codecPackets() {
  const { sock, create } = fakeSocket();
  const c = new MqttClient('wss://fake.invalid/mqtt', { clientId: 'nbFAKE01', createSocket: create, will: { topic: 'w/主題', payload: '', retain: true } });
  const connecting = c.connect();
  await sleep(5);
  assert(sock.protocols.join() === 'mqtt' && sock.binaryType === 'arraybuffer', 'subprotocol mqtt + arraybuffer');
  const cp = sock.sent[0];
  const rl = decodeLength(cp, 1);
  const body = cp.subarray(1 + rl.bytes);
  assert(cp[0] === 0x10 && body.length === rl.value, 'CONNECT fixed header');
  assert(dec.decode(body.subarray(2, 6)) === 'MQTT' && body[6] === 4, 'protocol name / level 4');
  assert(body[7] === 0x26, 'connect flags clean session + will + will retain, got 0x' + body[7].toString(16));
  assert(body[8] === 0 && body[9] === 30, 'keepalive 30 s');
  const idLen = (body[10] << 8) | body[11];
  assert(dec.decode(body.subarray(12, 12 + idLen)) === 'nbFAKE01', 'client id');
  const wt = 12 + idLen;
  const wl = (body[wt] << 8) | body[wt + 1];
  assert(dec.decode(body.subarray(wt + 2, wt + 2 + wl)) === 'w/主題', 'will topic (UTF-8)');
  sock.feed([0x20, 2, 0, 0]);
  await connecting;
  assert(c.connected, 'connected after CONNACK');

  const msgs = [];
  c.on('message', (topic, payload, meta) => msgs.push({ topic, payload, ...meta }));
  const subscribing = c.subscribe(['a/b', '主題/x']);
  const sp = sock.sent[1];
  assert(sp[0] === 0x82, 'SUBSCRIBE fixed header 0x82');
  const pid = [sp[2], sp[3]];
  // One WebSocket frame carrying SUBACK + a retained PUBLISH + a PUBLISH with UTF-8 topic and payload.
  sock.feed([...pk(0x90, pid, [0, 0]), ...pub('a/b', '你好', 1), ...pub('主題/x', 'z'.repeat(300))]);
  const granted = await subscribing;
  assert(granted.join() === '0,0', 'SUBACK granted QoS 0');
  assert(msgs.length === 2 && msgs[0].topic === 'a/b' && msgs[0].payload === '你好' && msgs[0].retain, 'coalesced packet 1');
  assert(msgs[1].topic === '主題/x' && msgs[1].payload.length === 300 && !msgs[1].retain, 'coalesced packet 2');

  // One packet (3-byte remaining length) split over 6 frames, the last one also carrying half of the next packet.
  const big = pub('big', 'q'.repeat(20000));
  let o = 0;
  for (const n of [1, 1, 2, 7, 4000]) {
    sock.feed(big.slice(o, o + n));
    o += n;
  }
  assert(msgs.length === 2, 'no message before the packet is complete');
  const tail = pub('s', 'tail');
  sock.feed([...big.slice(o), ...tail.slice(0, 3)]);
  assert(msgs.length === 3 && msgs[2].payload.length === 20000, 'split packet reassembled');
  sock.feed(tail.slice(3));
  assert(msgs.length === 4 && msgs[3].payload === 'tail', 'partial packet completed by the next frame');

  sock.feed(pub('q1', 'one', 0, 1, 0x1234));
  assert(same(sock.sent.at(-1), [0x40, 2, 0x12, 0x34]), 'QoS 1 delivery -> PUBACK');
  sock.feed(pub('q2', 'two', 0, 2, 0x0102));
  assert(same(sock.sent.at(-1), [0x50, 2, 1, 2]), 'QoS 2 delivery -> PUBREC');
  sock.feed([0x62, 2, 1, 2]);
  assert(same(sock.sent.at(-1), [0x70, 2, 1, 2]), 'PUBREL -> PUBCOMP');

  c.probe();
  assert(same(sock.sent.at(-1), [0xc0, 0]), 'PINGREQ');
  sock.feed([0xd0, 0]);
  assert(c._pingSent === 0, 'PINGRESP clears the outstanding ping');

  c.publish('t/x', '', { retain: true });
  assert(same(sock.sent.at(-1), [0x31, 5, 0, 3, 116, 47, 120]), 'retained PUBLISH with empty payload (clear)');
  c.publish('t', 'é');
  assert(same(sock.sent.at(-1), [0x30, 5, 0, 1, 116, 0xc3, 0xa9]), 'UTF-8 payload');

  const unsubscribing = c.unsubscribe('a/b');
  const up = sock.sent.at(-1);
  assert(up[0] === 0xa2, 'UNSUBSCRIBE fixed header 0xa2');
  sock.feed([0xb0, 2, up[2], up[3]]);
  await unsubscribing;

  const closes = [];
  c.on('close', (info) => closes.push(info));
  const disconnecting = c.disconnect();
  assert(same(sock.sent.at(-1), [0xe0, 0]), 'DISCONNECT');
  await disconnecting;
  assert(closes.length === 1 && closes[0].local && !c.connected, 'local close event');

  // Malformed remaining length (5 bytes) -> protocol error -> 'close'.
  const f2 = fakeSocket();
  const c2 = new MqttClient('wss://fake.invalid/mqtt', { createSocket: f2.create });
  const p2 = c2.connect();
  await sleep(5);
  f2.sock.feed([0x20, 2, 0, 0]);
  await p2;
  const closes2 = [];
  c2.on('close', (info) => closes2.push(info));
  f2.sock.feed([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]);
  assert(closes2.length === 1 && /protocol/.test(closes2[0].reason) && !closes2[0].local, 'malformed packet closes the link');

  // Refused CONNACK and connect timeout reject connect() with a code.
  const f3 = fakeSocket();
  const c3 = new MqttClient('wss://fake.invalid/mqtt', { createSocket: f3.create });
  const p3 = c3.connect();
  await sleep(5);
  f3.sock.feed([0x20, 2, 0, 5]);
  const e3 = await p3.then(() => null, (e) => e);
  assert(e3 && e3.code === 'refused', 'CONNACK 5 -> refused');
  const f4 = fakeSocket();
  const c4 = new MqttClient('wss://fake.invalid/mqtt', { createSocket: f4.create, connectTimeout: 100 });
  const e4 = await c4.connect().then(() => null, (e) => e);
  assert(e4 && e4.code === 'timeout', 'no CONNACK -> timeout');
}

async function codecSuite() {
  section('codec (offline)');
  await test('remaining-length varint round trip', async () => {
    const cases = [[0, 1], [1, 1], [127, 1], [128, 2], [16383, 2], [16384, 3], [2097151, 3], [2097152, 4], [268435455, 4]];
    for (const [n, len] of cases) {
      const b = encodeLength(n);
      assert(b.length === len, `${n}: ${b.length} bytes, want ${len}`);
      const d = decodeLength(Uint8Array.from(b));
      assert(d && d.value === n && d.bytes === len, `${n}: decoded ${JSON.stringify(d)}`);
      if (len > 1) assert(decodeLength(Uint8Array.from(b.slice(0, -1))) === null, `${n}: partial must be null`);
    }
    assert(!(() => { try { decodeLength(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 1)); return true; } catch { return false; } })(), '5-byte length must throw');
    assert(!(() => { try { encodeLength(268435456); return true; } catch { return false; } })(), 'length > 268435455 must throw');
  });
  await test('packet layout, coalesced + split frames, acks, ping', codecPackets);
}

// ---------------------------------------------------------------- per broker

async function brokerSuite(i) {
  const url = ORIGINAL[i];
  section(`broker ${i + 1}: ${url}`);
  const lat = { url };
  let ok = await test('raw MQTT: connect, subscribe, self-echo', async () => {
    const t0 = now();
    const c = await rawClient(url);
    lat.connect = now() - t0;
    try {
      const topic = 'nbvs1-test/' + randomString(10);
      const arrivals = [];
      c.on('message', () => arrivals.push(now()));
      await c.subscribe(topic);
      const echo = [];
      for (let k = 0; k < 6; k++) {
        const s = now();
        const n = arrivals.length;
        c.publish(topic, 'echo ' + k);
        await until(() => arrivals.length > n, 5000, 'echo');
        echo.push(arrivals[n] - s);
        await sleep(150);
      }
      lat.echo = stats(echo);
      return `connect ${Math.round(lat.connect)} ms, echo min/med ${fmt(lat.echo, ['min', 'med'])} ms`;
    } finally {
      await c.disconnect();
    }
  });
  if (!ok) return { ok: false, lat };
  useBrokers(forced(i));
  let p;
  try {
    ok = await test('createRoom + joinRoom (code digit, peer info, greet)', async () => {
      let retried = '';
      try {
        p = await pair();
      } catch (e) {
        if (e.code !== 'network') throw e;
        // Broker refused our handshakes even after the room's own retries: one more go, reported.
        await closeAll();
        await sleep(2000);
        retried = ' (2nd try: broker handshakes failed)';
        p = await pair();
      }
      const { host, guest } = p;
      lat.create = p.createMs;
      lat.join = p.joinMs;
      assert(host.code.length === 5 && host.code[0] === String(i + 1), 'code ' + host.code);
      assert(host.broker === url && guest.broker === url, 'wrong broker');
      assert(host.isHost && !guest.isHost, 'isHost');
      assert(host.status === 'connected' && guest.status === 'connected', `status ${host.status}/${guest.status}`);
      assert(host.peer && host.peer.name === GUEST_NAME && host.peer.version === VERSION, 'host.peer ' + JSON.stringify(host.peer));
      assert(guest.peer && guest.peer.name === HOST_NAME && guest.peer.version === VERSION, 'guest.peer ' + JSON.stringify(guest.peer));
      const [m] = await once(guest, 'message', (x) => x.type === 'greet', 5000);
      assert(m.data.text === '歡迎 👋' && m.reliable, 'greet message');
      const steps = p.log.filter((s) => s.startsWith('host')).map((s) => s.slice(5));
      assert(steps.at(-1) === '已建立房間' && p.log.at(-1) === 'guest 已加入房間', 'onStatus: ' + p.log.join(' | '));
      return `code ${host.code}, create ${Math.round(p.createMs)} ms, join ${Math.round(p.joinMs)} ms${retried}`;
    });
    if (!ok) return { ok: false, lat };
    const { host, guest } = p;
    await test('reliable: 200 msgs each way, in order, no loss/dup', async () => {
      await reliableExchange(host, guest, 200);
      return `frames out ${host._stats.framesOut}/${guest._stats.framesOut}, deferred ${host._stats.deferred}/${guest._stats.deferred}`;
    });
    await test('unreliable: latest wins, stale frame dropped', async () => {
      const r = await unreliableStream(host, guest);
      lat.snap = r.delays;
      return `${r.delivered}/40 delivered (coalesced), one-way delay med/max ${fmt(r.delays, ['med', 'max'])} ms`;
    });
    await test('max-size message both ways; oversize throws/drops', () => bigMessages(host, guest));
    await test('game-like load 10 s both ways (5 Hz snapshots)', async () => {
      const r = await gameLoad(host, guest);
      lat.load = r.delays;
      return r.note;
    }, 40000);
    await test('heartbeat rtt + 15 app round trips', async () => {
      lat.app = await roundTrips(host, guest);
      lat.hb = [host.rtt, guest.rtt];
      return `heartbeat rtt ${host.rtt}/${guest.rtt} ms, app round trip ${fmt(lat.app)} ms`;
    });
    await test('host close -> guest closed(left), info cleared', async () => {
      const closed = once(guest, 'closed', () => true, 10000);
      await host.close();
      const [reason] = await closed;
      assert(reason === 'left', 'guest closed with ' + reason);
      assert(host.status === 'closed' && guest.status === 'closed', `status ${host.status}/${guest.status}`);
      const info = await readInfoRaw(url, host.code);
      assert(!info, 'retained info still there: ' + JSON.stringify(info));
    });
    return { ok: true, lat };
  } finally {
    await closeAll();
    useBrokers(ORIGINAL);
  }
}

// ---------------------------------------------------------------- extended (one broker)

async function extendedSuite(i) {
  const url = ORIGINAL[i];
  section(`extended suite on broker ${i + 1}`);
  useBrokers(forced(i));
  try {
    await test('bad codes rejected without network', async () => {
      for (const code of ['', '1234', '123456', 'abcde', '01234', `${ORIGINAL.length + 1}1234`, null, '1 23'] ) {
        const t0 = now();
        await expectReject(joinRoom(code, { version: VERSION }), 'bad-code');
        assert(now() - t0 < 100, 'bad-code took network time');
      }
    });

    await test('unknown code -> not-found', async () => {
      const t0 = now();
      await expectReject(joinRoom(String(i + 1) + rand4(), { version: VERSION }), 'not-found');
      return `${Math.round(now() - t0)} ms`;
    });

    await test('stale info, live host (clock skew) -> joins', async () => {
      const host = track(await createRoom({ version: VERSION, name: 'skew' }));
      // Overwrite the retained info with a 2-minute-old timestamp, as a guest clock running ahead sees it.
      const raw = await rawClient(url);
      raw.publish(`nbvs1/${host.code}/info`, JSON.stringify({ v: VERSION, t: Date.now() - 120000, state: 'open' }), { retain: true });
      await sleep(500);
      await raw.disconnect();
      const guest = track(await joinRoom(host.code, { version: VERSION, name: 'skewed' }));
      assert(guest.status === 'connected' && host.peer && host.peer.name === 'skewed', 'join failed');
      await closeAll();
    });

    await test('stale info, no host -> not-found', async () => {
      const code = String(i + 1) + rand4();
      const raw = await rawClient(url);
      raw.publish(`nbvs1/${code}/info`, JSON.stringify({ v: VERSION, t: Date.now() - 120000, state: 'open' }), { retain: true });
      await sleep(500);
      try {
        const t0 = now();
        await expectReject(joinRoom(code, { version: VERSION }), 'not-found');
        return `${Math.round(now() - t0)} ms`;
      } finally {
        raw.publish(`nbvs1/${code}/info`, '', { retain: true }); // clean up the fake room
        await sleep(300);
        await raw.disconnect();
      }
    });

    await test('version mismatch -> version (info + host check)', async () => {
      const host = track(await createRoom({ version: 'A-1', name: 'v-host' }));
      const e = await expectReject(joinRoom(host.code, { version: 'B-2' }), 'version');
      assert(e.hostVersion === 'A-1', 'hostVersion ' + e.hostVersion);
      // A client that skips the info check still gets rejected by the host.
      const raw = await rawClient(url);
      const replies = [];
      raw.on('message', (t, text) => replies.push(JSON.parse(text)));
      await raw.subscribe(`nbvs1/${host.code}/g`);
      raw.publish(`nbvs1/${host.code}/h`, JSON.stringify({ k: 'hello', f: 'rawprobe1', n: 'raw', v: 'B-2', ts: 1 }));
      await until(() => replies.some((m) => m.to === 'rawprobe1'), 5000, 'reject');
      const r = replies.find((m) => m.to === 'rawprobe1');
      await raw.disconnect();
      assert(r.k === 'reject' && r.r === 'version' && r.v === 'A-1', 'reply ' + JSON.stringify(r));
      assert(host.peer === null && host.status === 'waiting', 'host accepted a wrong version');
      await host.close();
    });

    await test('third client -> full (info + host check)', async () => {
      const { host, guest } = await pair();
      await expectReject(joinRoom(host.code, { version: VERSION, name: 'third' }), 'full');
      const raw = await rawClient(url);
      const replies = [];
      raw.on('message', (t, text) => replies.push(JSON.parse(text)));
      await raw.subscribe(`nbvs1/${host.code}/g`);
      raw.publish(`nbvs1/${host.code}/h`, JSON.stringify({ k: 'hello', f: 'rawprobe2', n: 'raw', v: VERSION, ts: 1 }));
      await until(() => replies.some((m) => m.to === 'rawprobe2'), 5000, 'reject');
      await raw.disconnect();
      const r = replies.find((m) => m.to === 'rawprobe2');
      assert(r.k === 'reject' && r.r === 'full', 'reply ' + JSON.stringify(r));
      assert(host.peer.name === GUEST_NAME && guest.status === 'connected' && host.status === 'connected', 'pair disturbed');
      await closeAll();
    });

    await test('two guests join at once -> one in, one full', async () => {
      const host = track(await createRoom({ version: VERSION, name: 'race' }));
      const res = await Promise.allSettled(['A', 'B'].map((n) => joinRoom(host.code, { version: VERSION, name: n })));
      for (const r of res) if (r.status === 'fulfilled') track(r.value);
      const okList = res.filter((r) => r.status === 'fulfilled');
      const bad = res.filter((r) => r.status === 'rejected');
      assert(okList.length === 1 && bad.length === 1, `fulfilled ${okList.length}, rejected ${bad.map((r) => r.reason.code)}`);
      assert(bad[0].reason.code === 'full', 'loser got ' + bad[0].reason.code);
      assert(['A', 'B'].includes(host.peer.name), 'host.peer ' + JSON.stringify(host.peer));
      await closeAll();
    });

    await test('30% frame loss both ways: 200 msgs intact', async () => {
      const { host, guest } = await pair();
      host._lossRate = guest._lossRate = 0.3;
      await reliableExchange(host, guest, 200, 40000);
      host._lossRate = guest._lossRate = 0;
      const s = (r) => `${r._stats.resent} resent/${r._stats.dup} dup`;
      const note = `host ${s(host)}, guest ${s(guest)}`;
      await closeAll();
      return note;
    }, 60000);

    if (!QUICK) {
      await test('peer silent 6 s -> lagging -> connected', async () => {
        const { host, guest } = await pair();
        guest._lossRate = 1; // guest frames vanish
        const t0 = now();
        await once(host, 'status', (s) => s === 'lagging', 10000);
        const lagMs = now() - t0;
        guest._lossRate = 0;
        await once(host, 'status', (s) => s === 'connected', 6000);
        await closeAll();
        return `lagging after ${(lagMs / 1000).toFixed(1)} s, recovered`;
      });
    }

    await test('guest socket drop -> reconnect, queue kept', async () => {
      const { host, guest } = await pair();
      const got = { h: [], g: [] };
      host.on('message', (m) => m.type === 'rc' && got.h.push(m.data.i));
      guest.on('message', (m) => m.type === 'rc' && got.g.push(m.data.i));
      const statuses = [];
      guest.on('status', (s) => statuses.push(s));
      const t0 = now();
      guest._client.terminate(); // as if the network dropped
      for (let k = 0; k < 20; k++) {
        guest.send('rc', { k, i: k });
        host.send('rc', { k, i: k });
      }
      await until(() => got.h.length >= 20 && got.g.length >= 20, 25000, () => `delivery (${got.h.length}/${got.g.length})`);
      const ms = now() - t0;
      await sleep(500);
      for (const list of [got.h, got.g]) assert(list.length === 20 && list.every((v, k) => v === k), 'order/dup: ' + list.join(','));
      assert(guest._stats.reconnects === 1, 'reconnects ' + guest._stats.reconnects);
      await until(() => guest.status === 'connected' && host.status === 'connected', 8000, 'connected again');
      assert(statuses[0] === 'lagging', 'guest statuses ' + statuses.join(','));
      await closeAll();
      return `all delivered ${Math.round(ms)} ms after the drop; guest status ${statuses.join(' -> ')}`;
    });

    await test('host socket drop -> reconnect, info restored', async () => {
      const { host, guest } = await pair();
      host._client.terminate();
      await until(() => host._stats.reconnects === 1, 20000, 'host reconnect');
      const got = [];
      guest.on('message', (m) => m.type === 'after' && got.push(m.data.i));
      for (let k = 0; k < 5; k++) host.send('after', { i: k });
      await until(() => got.length >= 5, 10000, 'messages after reconnect');
      const info = await readInfoRaw(url, host.code);
      assert(info && info.state === 'full' && info.v === VERSION, 'info ' + JSON.stringify(info));
      await until(() => guest.status === 'connected' && host.status === 'connected', 8000, 'connected again');
      await closeAll();
    });

    await test('guest leaves -> peer-left -> new guest joins', async () => {
      const { host, guest } = await pair();
      const left = once(host, 'peer-left');
      await guest.close();
      const [p] = await left;
      assert(p.name === GUEST_NAME && p.reason === 'left', 'peer-left ' + JSON.stringify(p));
      assert(host.status === 'waiting' && host.peer === null, 'host ' + host.status);
      const info = await readInfoRaw(url, host.code);
      assert(info && info.state === 'open', 'info ' + JSON.stringify(info));
      const g2 = track(await joinRoom(host.code, { version: VERSION, name: '第二位' }));
      assert(host.peer.name === '第二位' && g2.peer.name === HOST_NAME && host.status === 'connected', 'rejoin');
      const got = [];
      host.on('message', (m) => m.type === 'again' && got.push(m.data.i));
      for (let k = 0; k < 5; k++) g2.send('again', { i: k });
      await until(() => got.length >= 5, 10000, 'messages from the new guest');
      assert(got.join() === '0,1,2,3,4', 'order ' + got.join());
      await closeAll();
    });

    if (!QUICK) {
      await test('peer silent 20 s -> lost -> closed(timeout)', async () => {
        const { host, guest } = await pair();
        const hs = [];
        host.on('status', (s) => hs.push(s));
        const hostClosed = once(host, 'closed', () => true, 30000);
        const guestClosed = once(guest, 'closed', () => true, 30000);
        guest._lossRate = 1;
        const t0 = now();
        const [reason] = await hostClosed;
        const ms = now() - t0;
        assert(reason === 'timeout' && hs.join() === 'lagging,lost,closed', `host ${reason}: ${hs.join(',')}`);
        const [greason] = await guestClosed;
        assert(greason === 'timeout', 'guest closed with ' + greason);
        return `host lost after ${(ms / 1000).toFixed(1)} s; guest told via bye`;
      }, 60000);
    }
  } finally {
    await closeAll();
    useBrokers(ORIGINAL);
  }
}

async function fallbackSuite(i) {
  section('broker fallback');
  try {
    await test('unreachable brokers skipped (timeout + DNS)', async () => {
      useBrokers([BLACKHOLE, DEAD_DNS, ORIGINAL[i]]);
      const log = [];
      const t0 = now();
      const host = track(await createRoom({ version: VERSION, name: 'fb', onStatus: (s) => log.push(s) }));
      const ms = now() - t0;
      assert(host.code[0] === '3' && host.broker === ORIGINAL[i], `code ${host.code} on ${host.broker}`);
      assert(log.some((s) => s.includes('改用伺服器 2')) && log.some((s) => s.includes('改用伺服器 3')), 'onStatus ' + log.join(' | '));
      const guest = track(await joinRoom(host.code, { version: VERSION, name: 'fb-guest' }));
      assert(guest.broker === ORIGINAL[i] && host.peer, 'join over the fallback broker');
      await closeAll();
      return `room on #3 after ${(ms / 1000).toFixed(1)} s: ${log.join(' → ')}`;
    }, 60000);
    await test('join on an unreachable broker -> network', async () => {
      useBrokers([DEAD_DNS, ...ORIGINAL.slice(1)]);
      await expectReject(joinRoom('1' + rand4(), { version: VERSION }), 'network');
    });
  } finally {
    await closeAll();
    useBrokers(ORIGINAL);
  }
}

// ---------------------------------------------------------------- optional limits probe

async function limitsProbe() {
  section('broker limits probe: payload delivered? / publishes per second received of sent');
  for (const url of ORIGINAL) {
    const out = [];
    try {
      for (const kb of [16, 64, 256, 1024]) {
        const c = await rawClient(url);
        const topic = 'nbvs1-test/' + randomString(10);
        let got = null;
        let closed = null;
        c.on('message', (t, text, m) => (got = m.bytes.length));
        c.on('close', (info) => (closed = info.reason));
        await c.subscribe(topic);
        c.publish(topic, 'x'.repeat(kb * 1024));
        await until(() => got !== null || closed, 10000, '').catch(() => {});
        out.push(`${kb}KB:${got !== null ? 'ok' : closed ? 'disconnected' : 'lost'}`);
        await c.disconnect();
      }
      for (const rate of [8, 12, 20]) {
        const c = await rawClient(url);
        const topic = 'nbvs1-test/' + randomString(10);
        let n = 0;
        c.on('message', () => n++);
        await c.subscribe(topic);
        const total = rate * 3;
        const t0 = now();
        for (let k = 0; k < total; k++) {
          c.publish(topic, 'r' + k);
          const wait = t0 + ((k + 1) * 1000) / rate - now();
          if (wait > 0) await sleep(wait);
        }
        await sleep(2500);
        out.push(`${rate}/s:${n}/${total}`);
        await c.disconnect();
      }
    } catch (e) {
      out.push('error ' + e.message);
    }
    console.log(`  ${url}\n      ${out.join('  ')}`);
  }
}

// ---------------------------------------------------------------- main

console.log(`NEON BASTION net test  ${new Date().toISOString()}  node ${process.version}${QUICK ? '  (quick)' : ''}`);
if (LIMITS) {
  await limitsProbe();
  process.exit(0);
}
const t0 = now();
await codecSuite();
const indices = ONLY ? [Number(ONLY) - 1] : ORIGINAL.map((_, k) => k);
const perBroker = [];
for (const i of indices) perBroker[i] = await brokerSuite(i);
const firstOk = indices.find((i) => perBroker[i] && perBroker[i].ok);
if (firstOk !== undefined) {
  await extendedSuite(firstOk);
  await fallbackSuite(firstOk);
} else {
  console.log('\nno broker passed its suite: extended suite skipped');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n== latency per broker (ms; min/med/p95/max)`);
console.log('  #  broker                               connect  mqtt-echo  create  join  heartbeat h/g   app round trip  one-way: snap med/max  under load med/p95');
for (const i of indices) {
  const b = perBroker[i];
  if (!b) continue;
  const l = b.lat;
  const r = (v) => (v == null ? '-' : String(Math.round(v)));
  console.log(`  ${i + 1}  ${l.url.padEnd(36)} ${r(l.connect).padStart(7)}  ${fmt(l.echo, ['min', 'med']).padStart(9)}  ${r(l.create).padStart(6)}  ${r(l.join).padStart(4)}  ${(l.hb ? l.hb.join('/') : '-').padStart(13)}  ${fmt(l.app).padStart(15)}  ${fmt(l.snap, ['med', 'max']).padStart(21)}  ${fmt(l.load, ['med', 'p95']).padStart(18)}  ${b.ok ? 'OK' : 'FAILED'}`);
}
console.log(`\n== ${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length}/${results.length} passed in ${((now() - t0) / 1000).toFixed(0)} s`);
for (const f of failed) console.log(`  FAIL  [${f.group}] ${f.name}: ${f.note}`);
process.exit(failed.length ? 1 : 0);
