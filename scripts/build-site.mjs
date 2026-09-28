#!/usr/bin/env node
// Builds the public static site (GitHub Pages) into dist/site/:
//   index.html   download page: APK from the latest GitHub Release, install steps, QR code of this page
//   play/        the web build (dist/www) for playing in a browser
//
// Run `node scripts/build-web.mjs` first. The repository (owner/name) comes from $GITHUB_REPOSITORY
// (set by GitHub Actions) or the "repository" field of package.json. Nothing here needs updating per
// release: the page links to /releases/latest/download/NeonBastion.apk and reads the version from the API.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { esc, emblemSvg, page, DOWNLOAD_CSS, DOWNLOAD_ICON, INSTALL_STEPS } from './site-common.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WWW = path.join(ROOT, 'dist', 'www');
const OUT = path.join(ROOT, 'dist', 'site');
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));

const repoField = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
const slug = process.env.GITHUB_REPOSITORY || repoField.replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '');
const [owner, repo] = slug.split('/');
if (!owner || !repo) {
  console.error('Unknown GitHub repository: set "repository" in package.json or $GITHUB_REPOSITORY.');
  process.exit(1);
}
const SITE_URL = `https://${owner.toLowerCase()}.github.io/${repo}/`;
const APK_URL = `https://github.com/${owner}/${repo}/releases/latest/download/NeonBastion.apk`;
const REPO_URL = `https://github.com/${owner}/${repo}`;
const API_URL = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

try {
  await fs.access(path.join(WWW, 'index.html'));
} catch {
  console.error('dist/www is missing: run `node scripts/build-web.mjs` first.');
  process.exit(1);
}

const qr = await QRCode.toString(SITE_URL, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#05060f', light: '#ffffff' } });

const SITE_CSS = `${DOWNLOAD_CSS}
.scan{display:none;margin-top:22px;padding:16px;align-items:center;gap:16px}
.scan .qr{flex:none;width:132px;background:#fff;padding:8px;border-radius:12px;box-shadow:0 0 0 2px rgba(34,230,255,.8),0 0 24px rgba(34,230,255,.4)}
.scan .qr svg{display:block;width:100%;height:auto}
.scan p{margin:0;font-size:14px;line-height:1.6;color:var(--muted)}
.scan code{font-size:12px;overflow-wrap:anywhere}
@media (min-width:700px) and (hover:hover){.scan{display:flex}}
`;

// The latest release is looked up in the browser so this page never goes stale; if the API is unreachable
// (rate limit, offline) the button still works because the /latest/download/ link always resolves.
const SCRIPT = `
(async () => {
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  try {
    const r = await fetch(${JSON.stringify(API_URL)}, { headers: { Accept: 'application/vnd.github+json' } });
    if (r.status === 404) {
      const b = document.getElementById('dl');
      b.classList.add('off');
      b.textContent = 'APK 準備中，請稍後再來';
      return;
    }
    if (!r.ok) return;
    const rel = await r.json();
    const apk = (rel.assets || []).find((a) => /\\.apk$/i.test(a.name));
    set('ver', rel.tag_name || '最新版');
    if (apk) {
      const mb = apk.size / 1048576;
      set('size', mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(apk.size / 1024) + ' KB');
      set('dlsize', 'NeonBastion.apk · ' + document.getElementById('size').textContent);
    }
    if (rel.published_at) set('date', '發佈於 ' + new Date(rel.published_at).toLocaleDateString('zh-TW'));
  } catch (e) { /* keep the static defaults */ }
})();
`;

const html = page('霓虹防線 NEON BASTION · 下載', SITE_CSS, `<main>
<header class="hero">
${emblemSvg({ className: 'emblem' })}
<h1>霓虹防線</h1>
<p class="sub">NEON BASTION</p>
</header>
<div class="meta"><span class="chip" id="ver">最新版</span><span class="chip" id="size">Android APK</span><span class="chip" id="date">免費 · 開源</span></div>
<a class="download" id="dl" href="${esc(APK_URL)}">${DOWNLOAD_ICON}<span>下載 APK<small id="dlsize">NeonBastion.apk</small></span></a>
<section class="panel">
<h2>安裝步驟</h2>
${INSTALL_STEPS}
</section>
<a class="play" href="play/">在瀏覽器直接玩 →</a>
<section class="panel scan">
<div class="qr">${qr}</div>
<p>在電腦上？用手機相機掃描 QR Code 開啟這個下載頁：<br><code>${esc(SITE_URL)}</code></p>
</section>
<footer>需要 Android 8.0 以上 · 任何網路皆可下載<br><a href="${esc(REPO_URL)}">原始碼（MIT 授權）</a> · <a href="${esc(REPO_URL)}/releases">所有版本</a></footer>
</main>
<script>${SCRIPT}</script>`, 'favicon.svg');

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'index.html'), html);
await fs.writeFile(path.join(OUT, 'favicon.svg'), emblemSvg({ background: true }));
await fs.writeFile(path.join(OUT, '.nojekyll'), '');
await fs.cp(WWW, path.join(OUT, 'play'), { recursive: true });
console.log(`site -> ${path.relative(ROOT, OUT)}  (${SITE_URL})`);
