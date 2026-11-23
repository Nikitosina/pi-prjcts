import { esc } from "./format.js";
const JS_RE =
  /(\/\/.*$)|(\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`?)|\b(const|let|var|function|return|if|else|for|while|of|in|new|throw|try|catch|finally|async|await|import|export|from|default|class|extends|typeof|instanceof|null|undefined|true|false|this|break|continue|switch|case|type|interface|as|void|never|string|number|boolean)\b|\b(\d[\d_.]*)\b|([A-Za-z_$][\w$]*)(?=\()/g;
const CSS_RE =
  /(\/\*.*?\*\/)|("[^"]*")|(--[\w-]+)|([a-z-]+)(?=\s*:)|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|ms|%|em|rem|s)?\b)|(var|color-mix|calc)(?=\()/g;
const MD_RE = /(^#{1,6} .*$)|(`[^`]+`)|(\*\*[^*]+\*\*)/g;

function tokens(text, lang) {
  const re = lang === "css" ? CSS_RE : lang === "md" ? MD_RE : JS_RE;
  re.lastIndex = 0;
  let out = "",
    last = 0,
    m;
  while ((m = re.exec(text))) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    out += esc(text.slice(last, m.index));
    let cls = "";
    if (lang === "css") cls = m[1] ? "c" : m[2] ? "s" : m[3] ? "v" : m[4] ? "p" : m[5] ? "n" : "f";
    else if (lang === "md") cls = m[1] ? "h" : m[2] ? "s" : "k";
    else cls = m[1] || m[2] ? "c" : m[3] ? "s" : m[4] ? "k" : m[5] ? "n" : "f";
    out += `<span class="tk-${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

export const langOf = (path) => (/\.css$/.test(path) ? "css" : /\.md$/.test(path) ? "md" : "js");

export function codeHtml(text, lang, range) {
  if (text.length > 2000) return esc(text);
  if (!text) return "&#8203;";
  if (!range) return tokens(text, lang);
  const [a, b] = range;
  return (
    tokens(text.slice(0, a), lang) + `<mark class="dx">${tokens(text.slice(a, b), lang) || "&#8203;"}</mark>` + tokens(text.slice(b), lang)
  );
}

function changedRange(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (p + s === 0 || (a.length - p - s > 0.7 * a.length && b.length - p - s > 0.7 * b.length)) return [null, null];
  return [
    [p, a.length - s],
    [p, b.length - s],
  ];
}

export function hunkRows(h) {
  const rows = [];
  let o = h.oldStart,
    n = h.newStart,
    i = 0;
  const L = h.lines;
  while (i < L.length) {
    const c = L[i][0];
    if (c === " ") {
      rows.push({ t: "ctx", o: o++, n: n++, text: L[i].slice(1) });
      i++;
      continue;
    }
    const dels = [],
      adds = [];
    while (i < L.length && L[i][0] === "-") dels.push(L[i++].slice(1));
    while (i < L.length && L[i][0] === "+") adds.push(L[i++].slice(1));
    const dRows = dels.map((text) => ({ t: "del", o: o++, n: null, text })),
      aRows = adds.map((text) => ({ t: "add", o: null, n: n++, text }));
    for (let k = 0; k < Math.min(dRows.length, aRows.length); k++) {
      const [ra, rb] = changedRange(dRows[k].text, aRows[k].text);
      dRows[k].range = ra;
      aRows[k].range = rb;
      dRows[k].pair = aRows[k];
      aRows[k].pair = dRows[k];
    }
    for (const row of dRows) rows.push(row);
    for (const row of aRows) rows.push(row);
  }
  return rows;
}

function hunks(diff) {
  const out = [];
  let h = null;
  for (const line of diff.split("\n")) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (match) {
      h = { oldStart: +match[1], newStart: +match[2], lines: [] };
      out.push(h);
    } else if (h && /^[ +-]/.test(line)) h.lines.push(line);
  }
  return out;
}
export function thread(t) {
  return `<aside class="rv-thread"><b>${t.resolved ? "Resolved thread" : t.outdated ? "Outdated thread" : "Review thread"}</b>${t.comments.map((c) => `<p><strong>${esc(c.author)}</strong> ${esc(c.body)}</p>`).join("")}</aside>`;
}
export function renderDiff(diff, path, split, threads) {
  const lang = langOf(path),
    pending = new Set(threads);
  const cell = (r) =>
    r ? `<span class="rv-cell ${r.t}"><small>${r.n ?? r.o}</small><code>${codeHtml(r.text, lang, r.range)}</code></span>` : "<span></span>";
  const row = (l, r) => {
    const notes = [];
    for (const t of pending) {
      if (!t.outdated && t.line != null && t.line === (t.side === "LEFT" ? l?.o : r?.n)) {
        notes.push(thread(t));
        pending.delete(t);
      }
    }
    return `<div class="rv-row${split ? " rv-split" : ""}">${split ? cell(l && { ...l, n: null }) + cell(r) : cell(r ?? l)}</div>${notes.join("")}`;
  };
  let html = "",
    next = 1;
  for (const h of hunks(diff)) {
    if (next < h.newStart)
      html += `<button class="link-btn rv-gap" data-start="${next}" data-end="${h.newStart}">Expand ${h.newStart - next} context lines</button>`;
    html += `<div class="rv-hunk">@@ −${h.oldStart} +${h.newStart} @@</div>`;
    for (const r of hunkRows(h)) {
      if (r.n) next = r.n + 1;
      if (r.t === "ctx") html += row(r, r);
      else if (!split) html += r.t === "del" ? row(r, null) : row(null, r);
      else if (r.t === "del") html += row(r, r.pair);
      else if (!r.pair) html += row(null, r);
    }
  }
  if (html && !diff.includes("\n+++ /dev/null\n"))
    html += `<button class="link-btn rv-gap" data-start="${next}">Read following context</button>`;
  return (html || `<pre>${esc(diff || "No textual changes")}</pre>`) + Array.from(pending, thread).join("");
}
