#!/usr/bin/env node
// LAN distribution server for 霓虹防線 NEON BASTION.
//
//   /                 mobile download page (Traditional Chinese)
//   /NeonBastion.apk  the signed APK from dist/ (supports resumable downloads)
//   /play/            the web build from dist/www/ for playing in a browser
//   /qr               page for the PC screen: big QR code to scan with the phone
//
// Usage: node scripts/serve.mjs [--port 8765] [--host <lan-ip>] [--apk <file>] [--www <dir>]
//        (PORT env var also works; --host only changes the advertised address, it always binds 0.0.0.0)

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import { esc, emblemSvg, page, DOWNLOAD_CSS, DOWNLOAD_ICON, INSTALL_STEPS } from './site-common.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      apk: { type: 'string' },
      www: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
if (args.help) {
  console.log('Usage: node scripts/serve.mjs [--port 8765] [--host <lan-ip>] [--apk <file>] [--www <dir>]');
  process.exit(0);
}

const PORT = Number(args.port ?? process.env.PORT ?? 8765);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid port: ${args.port ?? process.env.PORT}`);
  process.exit(2);
}
const APK_FILE = path.resolve(args.apk ?? path.join(ROOT, 'dist', 'NeonBastion.apk'));
const WWW_DIR = path.resolve(args.www ?? path.join(ROOT, 'dist', 'www'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

// ------------------------------------------------------------------ LAN address detection

const WIFI_NAME = /wi-?fi|wlan|無線|wireless/i;
const WIRED_NAME = /ethernet|乙太網路|以太网|^eth\d|^en\d/i;
const VIRTUAL_NAME = /virtualbox|vbox|vmware|vmnet|hyper-?v|vethernet|wsl|docker|podman|tailscale|zerotier|wireguard|vpn|\btap\b|\btun\b|loopback|bluetooth|藍牙/i;
// VirtualBox, VMware and Hyper-V virtual NICs, recognisable by MAC prefix even when named "Ethernet 2".
const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|00:15:5d)/i;

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Non-internal IPv4 addresses, best candidate for "phone on the same Wi-Fi" first. */
function lanCandidates() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || a.address.startsWith('169.254.')) continue;
      let score = isPrivateIPv4(a.address) ? 10 : 0;
      if (WIFI_NAME.test(name)) score += 100;
      else if (WIRED_NAME.test(name)) score += 50;
      if (VIRTUAL_NAME.test(name) || VIRTUAL_MAC.test(a.mac ?? '') || a.address.startsWith('192.168.56.')) score -= 200;
      list.push({ name, address: a.address, score });
    }
  }
  return list.sort((x, y) => y.score - x.score);
}

function addresses() {
  const found = lanCandidates();
  if (args.host) {
    return [{ name: '--host', address: args.host }, ...found.filter((c) => c.address !== args.host)];
  }
  return found.length ? found : [{ name: 'localhost', address: 'localhost' }];
}

const urlFor = (address) => `http://${address}:${PORT}/`;

// ------------------------------------------------------------------ helpers


async function statOrNull(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

async function appVersion() {
  try {
    return JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8')).version ?? '?';
  } catch {
    return '?';
  }
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatTime(date) {
  const absolute = date.toLocaleString('zh-TW', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat('zh-TW', { numeric: 'auto' });
  const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
  const [unit, size] = units.find(([, s]) => Math.abs(seconds) >= s) ?? ['second', 1];
  return `${absolute}（${rtf.format(Math.round(seconds / size), unit)}）`;
}

/** APK + web build status, read fresh on every request so rebuilds show up immediately. */
async function buildInfo() {
  const [apk, index, version] = await Promise.all([
    statOrNull(APK_FILE), statOrNull(path.join(WWW_DIR, 'index.html')), appVersion(),
  ]);
  return {
    version,
    apk: apk?.isFile() ? { size: formatSize(apk.size), built: formatTime(apk.mtime) } : null,
    play: Boolean(index?.isFile()),
  };
}

function send(req, res, status, type, body, headers = {}) {
  const buf = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff', ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

const sendHtml = (req, res, html) => send(req, res, 200, 'text/html; charset=utf-8', html);
const sendText = (req, res, status, text) => send(req, res, status, 'text/plain; charset=utf-8', text);

/** Streams a file with ETag/304 and single-range (resumable download) support. */
function sendFile(req, res, file, st, type, headers = {}) {
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const lastModified = st.mtime.toUTCString();
  const base = {
    'Content-Type': type, ETag: etag, 'Last-Modified': lastModified, 'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...headers,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, base);
    return res.end();
  }

  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const ifRange = req.headers['if-range'];
  const range = (!ifRange || ifRange === etag || ifRange === lastModified)
    && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), st.size - 1);
    } else {
      start = Math.max(0, st.size - Number(range[2])); // suffix range: last N bytes
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    base['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }

  res.writeHead(status, { ...base, 'Content-Length': Math.max(0, end - start + 1) });
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

async function downloadPage() {
  const info = await buildInfo();
  const button = info.apk
    ? `<a class="download" href="/NeonBastion.apk" download="NeonBastion.apk">${DOWNLOAD_ICON}<span>下載 APK<small>NeonBastion.apk · ${esc(info.apk.size)}</small></span></a>`
    : `<span class="download off">APK 尚未建置</span>
<p class="warn">請先在電腦上執行 <code>npm run build</code>，完成後重新整理此頁。</p>`;
  const meta = [`v${esc(info.version)}`, ...(info.apk ? [esc(info.apk.size), `建置於 ${esc(info.apk.built)}`] : [])]
    .map((m) => `<span class="chip">${m}</span>`).join('');
  return page('霓虹防線 NEON BASTION · 下載', DOWNLOAD_CSS, `<main>
<header class="hero">
${emblemSvg({ className: 'emblem' })}
<h1>霓虹防線</h1>
<p class="sub">NEON BASTION</p>
</header>
<div class="meta">${meta}</div>
${button}
<section class="panel">
<h2>安裝步驟</h2>
${INSTALL_STEPS}
</section>
<a class="play${info.play ? '' : ' off'}" href="/play/">${info.play ? '在瀏覽器直接試玩 →' : '在瀏覽器直接試玩（網頁版尚未建置）'}</a>
<footer>需要 Android 8.0 以上 · 手機與電腦須連在同一個 Wi-Fi<br><a href="/qr">在電腦上顯示 QR Code</a></footer>
</main>`);
}

const QR_CSS = `
body{display:flex;align-items:center;justify-content:center;padding:32px}
main{display:grid;grid-template-columns:auto minmax(320px,560px);gap:48px;align-items:center;max-width:1200px}
.qr{background:#fff;padding:18px;border-radius:22px;width:min(62vh,500px);
 box-shadow:0 0 0 2px rgba(34,230,255,.9),0 0 40px rgba(34,230,255,.55),0 0 110px rgba(255,61,203,.35)}
.qr svg{display:block;width:100%;height:auto}
.brand{display:flex;align-items:center;gap:18px}
.brand svg{width:84px;height:84px;filter:drop-shadow(0 0 12px rgba(34,230,255,.5))}
h1{font-size:40px}
.lead{margin:26px 0 8px;font-size:20px;color:var(--muted)}
.url{font:700 clamp(20px,2.4vw,34px)/1.2 ui-monospace,"Cascadia Mono",Consolas,monospace;color:#fff;overflow-wrap:anywhere;
 text-shadow:0 0 12px rgba(34,230,255,.7)}
.status{margin:10px 0 0;color:var(--muted);font-size:15px}
.panel{margin-top:26px;padding:18px 20px 6px;font-size:15px}
.others{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:22px;align-items:center}
.others h2{width:100%;margin:0;font-size:15px;color:var(--muted);font-weight:600}
.alt{display:flex;align-items:center;gap:14px;background:var(--panel);border:1px solid rgba(34,230,255,.2);border-radius:14px;padding:12px 16px 12px 12px}
.alt .qr{width:120px;padding:8px;border-radius:10px;box-shadow:none}
.alt code{font-size:15px}
.alt span{display:block;color:var(--muted);font-size:13px;margin-top:4px}
@media (max-width:900px){main{grid-template-columns:1fr}.qr{width:min(80vw,440px)}}
`;

async function qrSvg(url, dark = '#05060f') {
  return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark, light: '#ffffff' } });
}

async function qrPage() {
  const [primary, ...others] = addresses();
  const info = await buildInfo();
  const url = urlFor(primary.address);
  const alts = await Promise.all(others.map(async (c) => `<div class="alt"><div class="qr">${await qrSvg(urlFor(c.address))}</div>
<div><code>${esc(urlFor(c.address))}</code><span>${esc(c.name)}</span></div></div>`));
  const status = info.apk
    ? `APK v${esc(info.version)} · ${esc(info.apk.size)} · 建置於 ${esc(info.apk.built)}`
    : '⚠ 尚未建置 APK：請先執行 <code>npm run build</code>';
  return page('霓虹防線 · 掃描下載', QR_CSS, `<main>
<div class="qr">${await qrSvg(url)}</div>
<div>
<div class="brand">${emblemSvg()}<div><h1>霓虹防線</h1><p class="sub">NEON BASTION</p></div></div>
<p class="lead">用手機相機掃描 QR Code，或在手機瀏覽器輸入：</p>
<div class="url">${esc(url)}</div>
<p class="status">${status}</p>
<section class="panel">
<h2>手機打不開網頁？</h2>
<ol>
<li>確認手機和這台電腦連在<b>同一個 Wi-Fi</b>（訪客網路通常會隔離裝置）。</li>
<li>第一次啟動時 Windows 會跳出「Windows 安全性警訊」詢問 Node.js：如果這台電腦的 Wi-Fi 網路設定檔是「<b>公用</b>」，必須勾選「<b>公用網路</b>」再按「允許存取」。</li>
<li>先前按了取消？到「Windows 安全性 → 防火牆與網路保護 → 允許應用程式通過防火牆」，把 Node.js 的「公用」打勾。</li>
<li>或把 Wi-Fi 網路設定檔改為「<b>私人</b>」：設定 → 網路和網際網路 → Wi-Fi → 此網路的內容 → 網路設定檔類型。</li>
</ol>
</section>
</div>
${alts.length ? `<section class="others"><h2>掃不到？試試其他網路介面的位址：</h2>${alts.join('')}</section>` : ''}
</main>`);
}

// ------------------------------------------------------------------ routing

async function serveApk(req, res) {
  const st = await statOrNull(APK_FILE);
  if (!st?.isFile()) return sendText(req, res, 404, 'NeonBastion.apk 尚未建置。請先在電腦上執行 npm run build。\n');
  sendFile(req, res, APK_FILE, st, 'application/vnd.android.package-archive', {
    'Content-Disposition': 'attachment; filename="NeonBastion.apk"',
  });
}

async function servePlay(req, res, rawPath) {
  let rel;
  try {
    rel = decodeURIComponent(rawPath.slice('/play/'.length));
  } catch {
    return sendText(req, res, 400, 'Bad request\n');
  }
  let file = path.resolve(WWW_DIR, rel);
  if (rel.includes('\0') || (file !== WWW_DIR && !file.startsWith(WWW_DIR + path.sep))) {
    return sendText(req, res, 403, 'Forbidden\n');
  }
  let st = await statOrNull(file);
  if (st?.isDirectory()) {
    // Relative URLs inside index.html only resolve correctly from a URL ending in "/".
    if (!rawPath.endsWith('/')) return redirect(res, `${rawPath}/`);
    file = path.join(file, 'index.html');
    st = await statOrNull(file);
  }
  if (!st?.isFile()) {
    const hint = (await statOrNull(WWW_DIR)) ? '' : '網頁版尚未建置：請先執行 npm run build:web。\n';
    return sendText(req, res, 404, `${hint}Not found\n`);
  }
  sendFile(req, res, file, st, MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Content-Length': 0 });
  res.end();
}

async function route(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(req, res, 405, 'text/plain; charset=utf-8', 'Method not allowed\n', { Allow: 'GET, HEAD' });
  }
  const rawPath = req.url.split(/[?#]/)[0];
  if (rawPath === '/' || rawPath === '/index.html') return sendHtml(req, res, await downloadPage());
  if (rawPath === '/NeonBastion.apk') return serveApk(req, res);
  if (rawPath === '/qr') return sendHtml(req, res, await qrPage());
  if (rawPath === '/play') return redirect(res, '/play/');
  if (rawPath.startsWith('/play/')) return servePlay(req, res, rawPath);
  if (rawPath === '/favicon.svg' || rawPath === '/favicon.ico') {
    return send(req, res, 200, 'image/svg+xml', emblemSvg({ background: true }));
  }
  return sendText(req, res, 404, 'Not found\n');
}

// ------------------------------------------------------------------ server

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    const time = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    console.log(`[${time}] ${ip} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
  });
  try {
    await route(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendText(req, res, 500, 'Internal error\n');
    else res.destroy();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Try: npm run serve -- --port ${PORT + 1}`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', async () => {
  const [primary, ...others] = addresses();
  const info = await buildInfo();
  const url = urlFor(primary.address);
  const rel = (p) => (p.startsWith(ROOT + path.sep) ? path.relative(ROOT, p) : p);
  console.log('');
  console.log('  霓虹防線 NEON BASTION · LAN server');
  console.log(`  APK   ${rel(APK_FILE)}  ${info.apk ? `v${info.version}, ${info.apk.size}, 建置於 ${info.apk.built}` : '(missing: run npm run build)'}`);
  console.log(`  Play  ${rel(WWW_DIR)}  ${info.play ? '(ok)' : '(missing: run npm run build:web)'}`);
  console.log('');
  console.log(`  Phone:    ${url}   (${primary.name})`);
  for (const c of others) console.log(`  Also:     ${urlFor(c.address)}   (${c.name})`);
  console.log(`  QR page:  http://localhost:${PORT}/qr   (show this on the PC screen)`);
  console.log('');
  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  console.log('  If the phone cannot connect, allow Node.js through the Windows firewall (details on /qr). Ctrl+C to stop.');
});

const shutdown = () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
