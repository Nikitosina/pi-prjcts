// Page-side contrast helper shared by the theme and settings-polish E2Es: window.__scan(dark, root) -> { bright, low, texts }.
export const contrastLib = `(() => {
  const parse = c => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const over = (top, bottom) => { const a = top.a + bottom.a * (1 - top.a); return a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a, g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a, b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a, a }; };
  const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = el => { let color = { r: 0, g: 0, b: 0, a: 0 }; const chain = []; for (let n = el; n; n = n.parentElement) chain.push(n); for (const n of chain) { const bg = parse(getComputedStyle(n).backgroundColor); if (bg && bg.a > 0) { color = color.a === 0 ? bg : over(color, bg); if (color.a >= 0.999) break; } } return color.a >= 0.999 ? color : over(color, parse(getComputedStyle(document.documentElement).backgroundColor)); };
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0; };
  const label = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
  // Elements whose background is deliberately light in dark (toast / popups invert) are listed here.
  const inverted = el => !!el.closest('#toast, .context-popup, img, video');
  window.__scan = (dark, root = document.body) => {
    const bright = [], low = []; let texts = 0;
    for (const el of root.querySelectorAll('*')) {
      if (!visible(el) || inverted(el)) continue;
      const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      const bg = bgOf(el);
      if (dark && bg.a >= 0.999 && lum(bg) > 0.35 && el.getBoundingClientRect().width > 12) bright.push(label(el) + ' ' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b));
      if (own) { texts++; const fg = parse(getComputedStyle(el).color); const r = ratio(over(fg, bg), bg); const size = parseFloat(getComputedStyle(el).fontSize); if (r < (size >= 18 ? 3 : 4.5)) low.push(label(el) + ' ' + r.toFixed(2) + ' "' + el.textContent.trim().slice(0, 24) + '"'); }
    }
    return { bright: [...new Set(bright)], low: [...new Set(low)], texts };
  };
  window.__color = sel => { const el = document.querySelector(sel); const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color, scheme: s.colorScheme }; };
})()`;
