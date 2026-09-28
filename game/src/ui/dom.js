// Tiny DOM helpers + inline SVG icon set.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

export function svg(name) {
  const span = document.createElement('span');
  span.style.display = 'inline-flex';
  span.innerHTML = ICONS[name] || '';
  return span.firstChild;
}

const S = (inner, fill = false) => `<svg viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const ICONS = {
  core: S('<path d="M12 2l6 8-6 12-6-12z"/><path d="M6 10h12"/><path d="M12 2v20" opacity=".5"/>'),
  credits: S('<path d="M12 2l8.5 5v10L12 22l-8.5-5V7z"/><path d="M14.5 9.5c-.6-.9-1.5-1.3-2.5-1.3-1.5 0-2.6.8-2.6 1.9 0 2.8 5.3 1.4 5.3 4 0 1.1-1.2 1.9-2.7 1.9-1.1 0-2-.4-2.6-1.3M12 6.8v1.4M12 15.9v1.4"/>'),
  wave: S('<path d="M3 7l4 5-4 5"/><path d="M10 7l4 5-4 5"/><path d="M17 7l4 5-4 5"/>'),
  pause: S('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>', true),
  play: S('<path d="M6 4l14 8-14 8z"/>', true),
  ff: S('<path d="M3 5l9 7-9 7z"/><path d="M12 5l9 7-9 7z"/>', true),
  gear: S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>'),
  back: S('<path d="M15 18l-6-6 6-6"/>'),
  research: S('<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/>'),
  star: S('<path d="M12 2l3 6.9 7.5.7-5.7 5 1.7 7.4L12 18.3 5.5 22l1.7-7.4-5.7-5 7.5-.7z"/>', true),
  lock: S('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 118 0v4"/>'),
  sell: S('<path d="M12 2l8.5 5v10L12 22l-8.5-5V7z"/><path d="M9 12h6"/>'),
  up: S('<path d="M6 15l6-6 6 6"/><path d="M6 20l6-6 6 6" opacity=".6"/>'),
  target: S('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>'),
  stasis: S('<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7"/><path d="M9 3l3 3 3-3M9 21l3-3 3 3"/>'),
  restart: S('<path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.8L3 8"/><path d="M3 3v5h5"/>'),
  home: S('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
  check: S('<path d="M5 12l5 5L20 7"/>'),
  close: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  infinity: S('<path d="M18.2 8.2a5 5 0 110 7.6L12 12l-6.2-3.8a5 5 0 100 7.6L12 12z"/>'),
  auto: S('<path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  skull: S('<path d="M12 2a8 8 0 00-8 8c0 3 1.5 5 3 6v3h10v-3c1.5-1 3-3 3-6a8 8 0 00-8-8z"/><circle cx="9" cy="11" r="1.5" fill="currentColor"/><circle cx="15" cy="11" r="1.5" fill="currentColor"/>'),
  thunder: S('<path d="M7 9a5 5 0 019.6-1.9A3.5 3.5 0 1117.5 14H7.5A3.5 3.5 0 017 9z"/><path d="M12.5 13l-2.5 4.5h3l-2 4.5" stroke-width="2.2"/>'),
  wrench: S('<path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>'),
  codex: S('<path d="M4 4h6a3 3 0 013 3v13a2 2 0 00-2-2H4z"/><path d="M20 4h-6a3 3 0 00-3 3v13a2 2 0 012-2h7z"/>'),
  deploy: S('<path d="M12 2c3 2 5 6 5 10l-2 4H9l-2-4c0-4 2-8 5-10z"/><circle cx="12" cy="10" r="2"/><path d="M9 16l-2 5 3-2M15 16l2 5-3-2"/>'),
  eye: S('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
};

export function fmt(n) {
  n = Math.round(n);
  return n >= 100000 ? (n / 1000).toFixed(0) + 'k' : n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}
