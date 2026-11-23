// PROTOTYPE diff renderer shared by the variants: rows, syntax tokens, word-level changes, threads and drafts between rows.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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

/** Highlighted HTML for one line; `range` marks the changed middle of a paired line. */
export function codeHtml(text, lang, range) {
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

/** Rows of a hunk with numbers and word ranges: {t: ctx|add|del, o, n, text, range}. */
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
    rows.push(...dRows, ...aRows);
  }
  return rows;
}

/** New-side line of the first row whose text contains `find` (falls back to the old side). */
export function anchorLine(file, find) {
  for (const h of file.hunks)
    for (const r of hunkRows(h)) if (r.text.includes(find)) return r.n ? { side: "new", line: r.n } : { side: "old", line: r.o };
  return null;
}

export function fileIcon(status) {
  return status === "A"
    ? `<span class="fs fs-a" title="Added">A</span>`
    : status === "D"
      ? `<span class="fs fs-d" title="Deleted">D</span>`
      : `<span class="fs fs-m" title="Modified">M</span>`;
}

export function statBar(add, del, cells = 5) {
  const total = add + del || 1,
    a = Math.round((add / total) * cells),
    d = Math.min(cells - a, Math.round((del / total) * cells));
  return `<span class="statbar" aria-hidden="true">${"<i class=a></i>".repeat(a)}${"<i class=d></i>".repeat(d)}${"<i></i>".repeat(cells - a - d)}</span>`;
}

function md(text) {
  return text
    .split(/\n\n+/)
    .map(
      (p) =>
        `<p>${esc(p)
          .replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
}

const initials = (who) => (who.startsWith("pr-review") ? "✦" : who.startsWith("worker") ? "⚒" : who.slice(0, 1).toUpperCase());

export function threadHtml(t, prov, opts = {}) {
  const head = t.comments[0];
  const tag =
    t.kind === "ai"
      ? `<span class="th-tag" data-sev="${esc(t.severity)}">${esc(t.severity)}</span><span class="chip">${esc(t.axis)}</span>`
      : t.kind === "ci"
        ? `<span class="chip">CI</span>`
        : "";
  if (t.resolved && !opts.open)
    return `<div class="thread resolved" data-thread="${t.id}"><button type="button" class="th-collapsed" data-thread-open="${t.id}"><span class="th-av" data-role="${esc(head.role)}">${initials(head.who)}</span><span class="muted">Resolved</span><span class="th-snip">${esc(head.body.replace(/`/g, ""))}</span><span class="muted small">${t.comments.length} comments ▸</span></button></div>`;
  const comments = t.comments
    .map(
      (c) =>
        `<div class="th-c"><span class="th-av" data-role="${esc(c.role)}">${initials(c.who)}</span><div class="th-main"><div class="th-meta"><b>${esc(c.who)}</b><span class="muted">${esc(c.role)}</span><time>${esc(c.when)}</time></div><div class="th-body">${md(c.body)}</div></div></div>`,
    )
    .join("");
  const issue = prov.issue && t.issue ? `<span class="badge t-bad">issue</span>` : "";
  return `<div class="thread${t.resolved ? " resolved open" : ""}" data-thread="${t.id}" data-kind="${t.kind}"><div class="th-top">${tag}${issue}<span class="grow"></span>${t.resolved ? `<span class="badge t-ready">Resolved</span>` : ""}</div>${comments}<div class="th-actions"><button type="button" class="th-reply" data-reply="${t.id}">Reply…</button>${t.kind === "ai" && !t.resolved ? `<button type="button" class="ghost-btn small" data-fix="${t.id}">⚒ Add to fix list</button>` : ""}<button type="button" class="ghost-btn small" data-resolve="${t.id}">${t.resolved ? "Unresolve" : esc(prov.resolve)}</button></div></div>`;
}

export function draftHtml(d, prov) {
  const dest =
    d.dest === "worker"
      ? `<span class="dest dest-worker">⚒ for the worker</span>`
      : `<span class="dest dest-pub">↗ ${esc(prov.draftDest)}</span>`;
  return `<div class="draft" data-draft="${d.id}"><div class="dr-top"><span class="badge t-needs">Draft</span>${dest}${d.issue ? `<span class="badge t-bad">issue</span>` : ""}<span class="grow"></span><button type="button" class="icon-btn small" data-draft-del="${d.id}" aria-label="Delete draft">✕</button></div><div class="th-body">${md(d.body)}</div></div>`;
}

export function composerHtml(c, prov) {
  const range = c.from === c.to ? `line ${c.to}` : `lines ${c.from}–${c.to}`;
  return `<form class="inline-composer" data-composer="${esc(c.path)}"><div class="ic-top"><span class="muted small">Comment on ${range}</span><span class="grow"></span>${prov.noWorker ? `<span class="small dest dest-pub">↗ ${esc(prov.name)} draft</span>` : `<div class="seg" role="radiogroup" aria-label="Where this comment goes"><button type="button" role="radio" aria-checked="${c.dest === "worker"}" data-dest="worker" title="Goes into the brief of the next fix">⚒ Worker</button><button type="button" role="radio" aria-checked="${c.dest === "pub"}" data-dest="pub" title="Published on the PR when you publish">↗ ${esc(prov.name)}</button></div>`}</div><textarea rows="3" placeholder="${c.dest === "worker" ? "What should the worker change here?" : `Leave a ${prov.commentNoun}…`}" aria-label="Comment">${esc(c.text ?? "")}</textarea><div class="ic-actions"><button type="button" class="link-btn" data-suggest>± Suggest change</button>${prov.issue && c.dest === "pub" ? `<label class="small muted ic-issue"><input type="checkbox" data-issue ${c.issue ? "checked" : ""}> ${esc(prov.issue)}</label>` : ""}<span class="grow"></span><span class="muted small"><kbd>⌘↵</kbd></span><button type="button" class="ghost-btn small" data-cancel-composer>Cancel</button><button type="submit" class="primary small">Add draft</button></div></form>`;
}

/**
 * One file's diff body.
 * opts: mode (unified|split), threads, drafts, composer, annotations, selected {from,to}, expanded {hunkIndex: n}, compact, notes [{line,text}], hunks (indexes to show)
 */
export function fileBody(file, prov, opts) {
  const lang = langOf(file.path);
  const split = opts.mode === "split";
  const byLine = new Map();
  const attach = (line, html) => byLine.set(line, (byLine.get(line) ?? "") + html);
  for (const t of opts.threads ?? []) if (t.line) attach(t.line, threadHtml(t, prov, { open: opts.openThreads?.has(t.id) }));
  for (const d of opts.drafts ?? []) if (d.line) attach(d.line, draftHtml(d, prov));
  for (const n of opts.notes ?? [])
    if (n.line) attach(n.line, `<div class="map-note"><span aria-hidden="true">✦</span> ${esc(n.text)}</div>`);
  for (const a of opts.annotations ?? [])
    if (a.line) attach(a.line, `<div class="annot" data-level="${a.level}"><b>${esc(a.source)}</b> ${esc(a.text)}</div>`);
  if (opts.composer?.path === file.path) attach(opts.composer.to, composerHtml(opts.composer, prov));
  const sel = opts.selected?.path === file.path ? opts.selected : null;
  const inSel = (n) => sel && n && n >= sel.from && n <= sel.to;
  const cols = split ? 4 : 3;
  let html = "";
  let prevNewEnd = 0;
  const hunks = opts.hunks ?? file.hunks.map((_, i) => i);
  for (const hi of hunks) {
    const h = file.hunks[hi];
    const gap = h.newStart - 1 - prevNewEnd;
    const shown = Math.min(gap, opts.expanded?.[hi] ?? 0);
    if (gap > 0 && !opts.compact) {
      const left = gap - shown;
      html += left
        ? `<div class="hunk-head" data-hunk="${hi}"><button type="button" class="expand" data-expand="${hi}" title="Show ${Math.min(20, left)} more lines">↑</button><span class="hh-range">@@ −${h.oldStart} +${h.newStart} @@</span><span class="hh-sec">${esc(h.section)}</span><span class="grow"></span><button type="button" class="link-btn" data-expand-all="${hi}">${left} hidden lines</button></div>`
        : "";
      const delta = h.newStart - h.oldStart;
      for (let n = h.newStart - shown; n < h.newStart; n++) {
        const text = file.ctx?.[n] ?? "";
        html += row({ t: "ctx", o: n - delta, n, text }, lang, split, inSel(n), file.path);
        if (byLine.has(n)) html += `<div class="row-extra" style="--cols:${cols}">${byLine.get(n)}</div>`;
      }
    } else if (opts.compact) {
      html += `<div class="hunk-head compact"><span class="hh-range">@@ −${h.oldStart} +${h.newStart} @@</span><span class="hh-sec">${esc(h.section)}</span></div>`;
    }
    const rows = hunkRows(h);
    if (split) {
      const pairs = [];
      for (let i = 0; i < rows.length;) {
        if (rows[i].t === "ctx") {
          pairs.push([rows[i], rows[i]]);
          i++;
          continue;
        }
        const d = [],
          a = [];
        while (i < rows.length && rows[i].t === "del") d.push(rows[i++]);
        while (i < rows.length && rows[i].t === "add") a.push(rows[i++]);
        for (let k = 0; k < Math.max(d.length, a.length); k++) pairs.push([d[k] ?? null, a[k] ?? null]);
      }
      for (const [l, r] of pairs) {
        html += splitRow(l, r, lang, inSel(r?.n), file.path);
        const n = r?.n ?? null;
        if (n && byLine.has(n)) html += `<div class="row-extra" style="--cols:4">${byLine.get(n)}</div>`;
      }
    } else
      for (const r of rows) {
        html += row(r, lang, false, inSel(r.n), file.path);
        if (r.n && byLine.has(r.n)) html += `<div class="row-extra" style="--cols:3">${byLine.get(r.n)}</div>`;
      }
    prevNewEnd = h.newStart + h.newLines - 1;
  }
  return `<div class="diff ${split ? "split" : "unified"}${opts.wrap === false ? " nowrap" : ""}" data-lang="${lang}">${html}</div>`;
}

function row(r, lang, split, selected, path) {
  const sign = r.t === "add" ? "+" : r.t === "del" ? "−" : "";
  const line = r.n ?? r.o;
  return `<div class="drow ${r.t}${selected ? " sel" : ""}" data-path="${esc(path)}" data-line="${r.n ?? ""}" data-old="${r.o ?? ""}"><span class="ln o">${r.o ?? ""}</span><span class="ln n">${r.n ?? ""}<button type="button" class="add-c" tabindex="-1" aria-label="Comment on line ${line}">+</button></span><span class="code" data-sign="${sign}">${codeHtml(r.text, lang, r.range)}</span></div>`;
}

function splitRow(l, r, lang, selected, path) {
  const side = (x, which) =>
    x
      ? `<span class="ln ${which}">${which === "o" ? x.o : (x.n ?? "")}${which === "n" ? `<button type="button" class="add-c" tabindex="-1" aria-label="Comment">+</button>` : ""}</span><span class="code ${x.t}" data-sign="${x.t === "add" ? "+" : x.t === "del" ? "−" : ""}">${codeHtml(x.text, lang, x.range)}</span>`
      : `<span class="ln ${which} empty"></span><span class="code empty"></span>`;
  return `<div class="drow srow${selected ? " sel" : ""}" data-path="${esc(path)}" data-line="${r?.n ?? ""}">${side(l, "o")}${side(r, "n")}</div>`;
}
