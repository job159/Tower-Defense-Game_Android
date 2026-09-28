// Shared look of the download pages: the LAN server (serve.mjs) and the static GitHub Pages site (build-site.mjs).

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ------------------------------------------------------------------ emblem (same art as the launcher icon)

const HEX = 'M54,28L76.52,41L76.52,67L54,80L31.48,67L31.48,41Z';
const NODES = [[54, 28], [76.52, 41], [76.52, 67], [54, 80], [31.48, 67], [31.48, 41]];
const dots = (r) => NODES.map(([x, y]) => `M${x - r},${y}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`).join('');

export function emblemSvg({ background = false, className = '' } = {}) {
  const id = background ? 'i' : 'e';
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" viewBox="${background ? '18 18 72 72' : '20 20 68 68'}" aria-hidden="true">
<defs><radialGradient id="${id}a" cx="54" cy="54" r="21" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FF3DCB" stop-opacity=".55"/><stop offset="1" stop-color="#FF3DCB" stop-opacity="0"/></radialGradient>
<radialGradient id="${id}b" cx="54" cy="54" r="60" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#16235A"/><stop offset="1" stop-color="#070B1E"/></radialGradient></defs>
${background ? `<rect x="18" y="18" width="72" height="72" rx="16" fill="url(#${id}b)"/>` : ''}
<g transform="translate(54 54) scale(1.08) translate(-54 -54)">
<circle cx="54" cy="54" r="21" fill="url(#${id}a)"/>
<g fill="none" stroke="#22E6FF"><path d="${HEX}" stroke-opacity=".12" stroke-width="7" stroke-linejoin="round"/><path d="${HEX}" stroke-opacity=".28" stroke-width="4" stroke-linejoin="round"/><path d="${HEX}" stroke-width="2"/>
<path d="M57.38,36.45L67.51,42.3M70.89,48.15L70.89,59.85M67.51,65.7L57.38,71.55M50.62,71.55L40.49,65.7M37.11,59.85L37.11,48.15M40.49,42.3L50.62,36.45" stroke-opacity=".55" stroke-width=".9" stroke-linecap="round"/></g>
<path d="${HEX}" fill="none" stroke="#DDFCFF" stroke-opacity=".9" stroke-width=".7"/>
<path d="${dots(3.2)}" fill="#22E6FF" fill-opacity=".35"/><path d="${dots(1.5)}" fill="#E8FEFF"/>
<path d="M54,32.5L66.5,51.5L54,75L41.5,51.5Z" fill="#FF3DCB" fill-opacity=".1"/><path d="M54,36.5L63.8,51.5L54,71L44.2,51.5Z" fill="#FF3DCB" fill-opacity=".2"/>
<path d="M54,40L46.5,51.5L54,51.5Z" fill="#FFA6EC"/><path d="M54,40L61.5,51.5L54,51.5Z" fill="#FF3DCB"/><path d="M46.5,51.5L54,68L54,51.5Z" fill="#C81E9E"/><path d="M61.5,51.5L54,68L54,51.5Z" fill="#850C66"/>
<path d="M54,40L61.5,51.5L54,68L46.5,51.5Z" fill="none" stroke="#FFD6F5" stroke-opacity=".9" stroke-width=".6" stroke-linejoin="round"/>
<path d="M53.2,42.2L48.4,49.6" stroke="#FFF" stroke-opacity=".85" stroke-width=".8" stroke-linecap="round"/>
</g></svg>`;
}

// ------------------------------------------------------------------ pages

export const BASE_CSS = `
:root{--bg:#05060f;--cyan:#22e6ff;--magenta:#ff3dcb;--text:#dff8ff;--muted:#8ea6c8;--panel:rgba(11,17,42,.78)}
*{box-sizing:border-box}
html{background:var(--bg);color-scheme:dark;-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;color:var(--text);
 font-family:system-ui,-apple-system,"Segoe UI","Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;
 background:
  radial-gradient(70% 45% at 50% -5%,rgba(34,230,255,.20),transparent 70%),
  radial-gradient(60% 40% at 50% 105%,rgba(255,61,203,.18),transparent 70%),
  linear-gradient(rgba(34,230,255,.06) 1px,transparent 1px) 0 0/28px 28px,
  linear-gradient(90deg,rgba(34,230,255,.06) 1px,transparent 1px) 0 0/28px 28px,
  var(--bg)}
h1{margin:0;font-weight:800;letter-spacing:.14em;color:#f4fdff;
 text-shadow:0 0 6px var(--cyan),0 0 18px rgba(34,230,255,.8),0 0 44px rgba(34,230,255,.45)}
.sub{margin:6px 0 0;font:700 14px/1 ui-monospace,"Cascadia Mono",Consolas,monospace;letter-spacing:.55em;
 padding-left:.55em;color:var(--magenta);text-shadow:0 0 10px rgba(255,61,203,.85)}
.panel{background:var(--panel);border:1px solid rgba(34,230,255,.22);border-radius:16px;
 box-shadow:0 0 30px rgba(34,230,255,.06) inset}
.panel h2{margin:0 0 12px;font-size:15px;letter-spacing:.14em;color:var(--cyan)}
ol{margin:0;padding:0;list-style:none;counter-reset:s}
li{counter-increment:s;position:relative;padding:0 0 14px 40px;line-height:1.6}
li::before{content:counter(s);position:absolute;left:0;top:0;width:28px;height:28px;border-radius:8px;
 display:grid;place-items:center;font-weight:800;font-size:14px;color:var(--magenta);
 border:1px solid rgba(255,61,203,.6);box-shadow:0 0 10px rgba(255,61,203,.35) inset}
b{color:#fff}
code{font-family:ui-monospace,Consolas,monospace;background:rgba(255,255,255,.09);padding:1px 6px;border-radius:5px}
@keyframes glow{50%{box-shadow:0 0 0 1px rgba(255,255,255,.4) inset,0 0 36px rgba(34,230,255,.8),0 0 80px rgba(255,61,203,.5)}}
@keyframes float{50%{transform:translateY(-6px)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
`;

export function page(title, css, body, favicon = '/favicon.svg') {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#05060f">
<title>${esc(title)}</title>
<link rel="icon" href="${favicon}" type="image/svg+xml">
<style>${BASE_CSS}${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export const DOWNLOAD_CSS = `
body{display:flex;justify-content:center;
 padding:max(20px,env(safe-area-inset-top)) 16px max(28px,env(safe-area-inset-bottom))}
main{width:100%;max-width:460px}
.hero{text-align:center;margin-top:8px}
.emblem{width:132px;height:132px;filter:drop-shadow(0 0 16px rgba(34,230,255,.45));animation:float 6s ease-in-out infinite}
h1{margin-top:6px;font-size:44px}
.meta{display:flex;justify-content:center;flex-wrap:wrap;gap:8px;margin:18px 0 22px}
.chip{font-size:13px;padding:5px 11px;border:1px solid rgba(34,230,255,.35);border-radius:999px;background:rgba(34,230,255,.08)}
.download{display:flex;align-items:center;justify-content:center;gap:14px;width:100%;min-height:76px;padding:14px 20px;
 border-radius:18px;text-decoration:none;color:#03121a;font-size:23px;font-weight:900;letter-spacing:.1em;
 background:linear-gradient(120deg,#22e6ff,#7df5ff 45%,#ff3dcb);
 box-shadow:0 0 0 1px rgba(255,255,255,.4) inset,0 0 24px rgba(34,230,255,.6),0 0 60px rgba(255,61,203,.35);
 animation:glow 2.8s ease-in-out infinite;-webkit-tap-highlight-color:transparent}
.download:active{transform:translateY(1px) scale(.99)}
.download svg{width:30px;height:30px;flex:none}
.download small{display:block;font-size:13px;font-weight:700;letter-spacing:.04em;opacity:.75}
.download.off{background:#161d3d;color:var(--muted);box-shadow:none;animation:none;pointer-events:none;font-size:19px}
.warn{margin:12px 0 0;text-align:center;color:#ffb3e9;font-size:14px;line-height:1.6}
.panel{margin-top:22px;padding:18px 18px 6px;font-size:15px}
.play{display:block;margin-top:16px;padding:15px;text-align:center;border-radius:14px;text-decoration:none;
 border:1px solid rgba(255,61,203,.55);background:rgba(255,61,203,.08);color:#ffd6f5;font-weight:700;letter-spacing:.06em}
.play.off{opacity:.45;pointer-events:none}
footer{margin-top:20px;text-align:center;color:var(--muted);font-size:13px;line-height:1.7}
footer a{color:var(--muted)}
`;

export const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 19h16"/></svg>';

// Install instructions shown on both download pages.
export const INSTALL_STEPS = `<ol>
<li>點上方按鈕下載。瀏覽器若提示「<b>不安全的下載</b>」或「檔案可能有害」，請選「<b>保留</b>」（或「仍要下載」）。</li>
<li>下載完成後，點通知或到「下載」資料夾<b>開啟 NeonBastion.apk</b>。</li>
<li>系統若詢問，允許此來源（你的瀏覽器）<b>安裝未知應用程式</b>，然後返回繼續安裝。</li>
<li>若 <b>Play 安全防護</b>跳出詢問，選「更多詳細資料」→「<b>仍要安裝</b>」。</li>
<li>日後更新：直接下載新版覆蓋安裝，遊戲進度會保留。</li>
</ol>`;
