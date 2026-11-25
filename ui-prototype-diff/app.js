// PROTOTYPE: four PR / diff viewer variants in the pi-prjcts shell. In-memory state only; nothing reaches a host or a provider.
import { PROVIDERS, WORKER, THREADS, DRAFTS, ANNOTATIONS, REVIEW_MAP, API_MAP, CHAT } from "./data.js";
import { esc, fileBody, fileIcon, statBar, anchorLine, hunkRows, codeHtml, langOf } from "./diff.js";

const D = window.DIFF_DATA;
const VARIANTS = [
  [
    "combo",
    "Review room + tour on demand",
    "A is the default; the tour button asks a scout for a review map and switches the room to steps",
  ],
  ["review", "Review room", "Center takes over: file tree, whole diff, threads, review bar"],
  ["sheet", "Diff beside chat", "Chat stays; diff opens as a wide right sheet; lines go into the composer"],
  ["walk", "Guided walkthrough", "The worker's review map leads you step by step"],
  ["feed", "Card in the chat", "The PR lives in the feed: change map, expandable files, iteration deltas"],
];
const params = new URLSearchParams(location.search);
const byPath = new Map(D.files.map((f) => [f.path, f]));
for (const f of D.interdiff.files) f.ctx = byPath.get(f.path)?.ctx;

const S = {
  variant: VARIANTS.some(([k]) => k === params.get("variant")) ? params.get("variant") : "combo",
  provider: params.get("provider") === "arc" ? "arc" : "github",
  theme: ["claude", "midnight", "light"].includes(params.get("theme")) ? params.get("theme") : "claude",
  mode: "unified",
  wrap: true,
  range: "all",
  viewed: new Set(["docs/plugins/development.md", "scripts/plugin-catalog-failures.md", "src/host.ts", "web/api.js"]),
  collapsed: new Set(),
  current: D.files[0].path,
  threads: THREADS.map((t) => ({ ...t, comments: [...t.comments], ...anchorLine(byPath.get(t.path), t.find) })),
  drafts: DRAFTS.map((d) => ({ ...d, ...anchorLine(byPath.get(d.path), d.find) })),
  annotations: ANNOTATIONS.map((a) => ({ ...a, ...anchorLine(byPath.get(a.path), a.find) })),
  openThreads: new Set(),
  composer: null,
  selected: null,
  expanded: {},
  filter: "",
  sheetOpen: true,
  sheetFile: "src/host-restart.ts",
  chips: [],
  extraFeed: [],
  step: 0,
  stepState: {},
  checked: new Set(),
  questions: [],
  asking: false,
  cardOpen: new Set(["src/host-restart.ts"]),
  iterOpen: new Set(["web/settings.js"]),
  listBefore: null,
  tour: "none",
  tourView: "files",
  author: params.get("author") === "colleague" ? "colleague" : "ours",
  mapAt: 0,
};
const isCombo = () => S.variant === "combo";
const isReview = () => S.variant === "review" || (isCombo() && S.tourView === "files");
const isWalk = () => S.variant === "walk" || (isCombo() && S.tourView === "tour");

function tourCtl() {
  if (!isCombo()) return "";
  if (S.tour === "none")
    return `<button type="button" class="ghost-btn small tour-btn" data-tour-request title="Ask the worker for a review map: files grouped into steps, riskiest first, with why and what to check">✦ Guided tour</button>`;
  if (S.tour === "loading")
    return `<span class="tour-loading small"><span class="spin" aria-hidden="true"></span>Scout is drawing the review map…</span>`;
  return `<div class="seg" role="radiogroup" aria-label="Review mode"><button type="button" role="radio" aria-checked="${S.tourView === "files"}" data-tour-view="files">Files</button><button type="button" role="radio" aria-checked="${S.tourView === "tour"}" data-tour-view="tour">✦ Tour${mapStale() ? `<span class="new-dot" title="The map is older than ${prov().iterShort(iterNow)}"></span>` : ""} <span class="muted mono">${Object.keys(S.stepState).length}/${REVIEW_MAP.length}</span></button></div>`;
}
const prov = () => (ours() ? PROVIDERS[S.provider] : { ...PROVIDERS[S.provider], noWorker: true });
const ours = () => !isCombo() || S.author === "ours";
const mapStale = () => isCombo() && S.tour === "ready" && S.mapAt < iterNow;
const changedSince = new Set(D.interdiff.files.map((f) => f.path));
const stepChanged = (s) => mapStale() && s.files.some((f) => changedSince.has(f));
const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app"),
  center = $("#center"),
  context = $("#context");
let uid = 10;

const files = () => (S.range === "since" ? D.interdiff.files : D.files);
const fileOf = (path) => files().find((f) => f.path === path) ?? byPath.get(path);
const threadsOf = (path) => S.threads.filter((t) => t.path === path);
const openThreads = () => S.threads.filter((t) => !t.resolved);
const totals = (list) => list.reduce((a, f) => ({ add: a.add + f.add, del: a.del + f.del }), { add: 0, del: 0 });
const splitPath = (p) => {
  const i = p.lastIndexOf("/");
  return [i < 0 ? "" : p.slice(0, i + 1), p.slice(i + 1)];
};
const pathHtml = (p) => {
  const [dir, name] = splitPath(p);
  return `<span class="p-dir">${esc(dir)}</span><span class="p-name">${esc(name)}</span>`;
};
const TITLE = "Restart the current host version from the plugin catalog";
const iterNow = D.iterations.length;
const lastSeen = 3;

function bodyOpts(f, extra = {}) {
  return {
    mode: S.mode,
    wrap: S.wrap,
    threads: threadsOf(f.path),
    drafts: S.drafts.filter((d) => d.path === f.path),
    annotations: S.provider === "github" ? S.annotations.filter((a) => a.path === f.path) : [],
    composer: S.composer,
    selected: S.selected,
    expanded: S.expanded[f.path],
    openThreads: S.openThreads,
    ...extra,
  };
}

// ------------------------------------------------------------------------------------------------ shared pieces

function checksPill() {
  const c = prov().checks;
  return `<span class="rv-pill ok" title="${esc(c.map((x) => x.name).join(", "))}"><span aria-hidden="true">✓</span> ${c.length}/${c.length} checks</span>`;
}
function threadsPill() {
  const n = openThreads().length;
  return `<span class="rv-pill${n ? " needs" : ""}"><span aria-hidden="true">◌</span> ${n} open</span>`;
}
function rangeSeg() {
  const p = prov();
  return `<div class="seg range-seg" role="radiogroup" aria-label="Which changes"><button type="button" role="radio" aria-checked="${S.range === "all"}" data-range="all">All changes <span class="muted">${p.iterShort(iterNow)}</span></button><button type="button" role="radio" aria-checked="${S.range === "since"}" data-range="since">Since you looked <span class="muted">${p.iterShort(lastSeen)}→${p.iterShort(iterNow)}</span><span class="new-dot" aria-label="new changes"></span></button></div>`;
}
function iterDots() {
  const p = prov();
  return `<ol class="iter-dots" aria-label="${esc(p.iterNoun)}s">${D.iterations.map((it) => `<li data-seen="${it.n <= lastSeen}" data-head="${it.n === iterNow}" title="${esc(`${p.iter(it.n)} · ${it.sha.slice(0, 7)} · ${it.title}`)}"><span>${p.iterShort(it.n)}</span></li>`).join("")}</ol>`;
}
function workerCard() {
  return `<article class="worker" data-tone="ready"><div class="w-line1"><span class="w-role" aria-label="worker">⚒</span><button type="button" class="w-title">${esc(WORKER.title)}</button><span class="chip mono">${esc(WORKER.model)}</span></div><div class="w-plan"><span class="mono">5/5</span><span class="w-step">All steps done</span></div><div class="bar" role="progressbar" aria-valuenow="5" aria-valuemax="5"><span style="width:100%"></span></div><div class="w-foot"><span class="badge t-ready">Ready</span><span class="muted small mono">${esc(prov().ref)}</span><span class="grow"></span><button type="button" class="ghost-btn small">Open</button></div></article>`;
}
function draftCounts() {
  const w = S.drafts.filter((d) => d.dest === "worker").length;
  return { w, p: S.drafts.length - w };
}
function toast(text) {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<span>${text}</span>`;
  $("#toasts").append(t);
  setTimeout(() => {
    t.classList.add("leaving");
    setTimeout(() => t.remove(), 200);
  }, 3200);
}

function fileBlock(f, opts = {}) {
  const viewed = S.viewed.has(f.path),
    collapsed = S.collapsed.has(f.path) || (viewed && !opts.forceOpen);
  const th = threadsOf(f.path).filter((t) => !t.resolved).length;
  const dr = S.drafts.filter((d) => d.path === f.path).length;
  return `<section class="fblock${viewed ? " viewed" : ""}" data-file="${esc(f.path)}" id="f-${cssId(f.path)}"><header class="fhead"><button type="button" class="fh-toggle" data-collapse="${esc(f.path)}" aria-expanded="${!collapsed}" aria-label="Collapse file">${collapsed ? "▸" : "▾"}</button>${fileIcon(f.status)}<span class="fh-path mono" title="${esc(f.path)}">${pathHtml(f.path)}</span><button type="button" class="icon-btn small" data-copy="${esc(f.path)}" title="Copy path" aria-label="Copy path">⧉</button>${th ? `<span class="fh-th" title="Open threads">◌ ${th}</span>` : ""}${dr ? `<span class="fh-dr" title="Your drafts">✎ ${dr}</span>` : ""}${opts.changed ? `<span class="fh-chg" title="Changed after the map was built">↻ ${esc(prov().iterShort(iterNow))}</span>` : ""}<span class="grow"></span><span class="fh-stat mono"><span class="plus">+${f.add}</span> <span class="minus">−${f.del}</span></span>${statBar(f.add, f.del)}<label class="viewed-box" title="${esc(prov().viewed)}"><input type="checkbox" data-viewed="${esc(f.path)}" ${viewed ? "checked" : ""}> Viewed</label></header>${collapsed ? "" : fileBody(f, prov(), bodyOpts(f, opts.body))}</section>`;
}
const cssId = (p) => p.replace(/[^a-z0-9]/gi, "-");

// ------------------------------------------------------------------------------------------------ A: review room

function renderReview() {
  const p = prov(),
    list = files(),
    t = totals(list),
    { w, p: pub } = draftCounts();
  const viewedN = list.filter((f) => S.viewed.has(f.path)).length;
  const groups = new Map();
  for (const f of list) {
    if (S.filter && !f.path.toLowerCase().includes(S.filter.toLowerCase())) continue;
    const [dir] = splitPath(f.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  const tree = [...groups]
    .map(
      ([dir, fs]) =>
        `<div class="ft-dir"><div class="ft-dirname mono">${esc(dir || "./")}</div>${fs
          .map((f) => {
            const th = threadsOf(f.path).filter((x) => !x.resolved).length;
            return `<button type="button" class="ft-file${S.current === f.path ? " current" : ""}${S.viewed.has(f.path) ? " viewed" : ""}" data-goto="${esc(f.path)}">${fileIcon(f.status)}<span class="ft-name mono">${esc(splitPath(f.path)[1])}</span>${th ? `<span class="ft-th" title="${th} open">◌${th}</span>` : ""}<span class="ft-stat mono"><span class="plus">+${f.add}</span><span class="minus">−${f.del}</span></span><span class="ft-check" aria-label="${S.viewed.has(f.path) ? "viewed" : "not viewed"}">${S.viewed.has(f.path) ? "✓" : ""}</span></button>`;
          })
          .join("")}</div>`,
    )
    .join("");
  center.innerHTML = `<section class="view rv" aria-label="Pull request review">
  <div class="rv-head"><button type="button" class="back" data-back>← <kbd>Esc</kbd></button><span class="rv-icon" aria-hidden="true">⎇</span><h1>${esc(TITLE)}</h1><span class="chip mono">${esc(p.ref)}</span>${ours() ? `<span class="badge t-ready">Ready</span>` : `<span class="chip">by @a-kolesnikov</span>`}<span class="grow"></span>${tourCtl()}
    <div class="seg" role="radiogroup" aria-label="Layout"><button type="button" role="radio" aria-checked="${S.mode === "unified"}" data-mode="unified">Unified</button><button type="button" role="radio" aria-checked="${S.mode === "split"}" data-mode="split">Split</button></div>
    <button type="button" class="icon-btn" data-wrap aria-pressed="${S.wrap}" title="Wrap long lines">↩︎</button>
    <a class="ghost-btn small" href="#" data-noop>${esc(p.open)} ↗</a></div>
  <div class="rv-sub"><span class="mono rv-branch">${esc(p.head)} <span class="muted">→</span> ${esc(p.base)}</span><span class="dotsep">·</span>${checksPill()}${threadsPill()}<span class="dotsep">·</span><span class="mono"><span class="plus">+${t.add}</span> <span class="minus">−${t.del}</span></span><span class="muted">${list.length} files</span><span class="grow"></span>${iterDots()}${rangeSeg()}</div>
  ${S.range === "since" ? `<div class="since-note"><span aria-hidden="true">↻</span> Showing what changed between ${esc(p.iter(lastSeen))} (you looked Nov 20, 09:10) and ${esc(p.iter(iterNow))}: <b>${esc(D.iterations[3].title)}</b>. Viewed marks reset for files that changed.</div>` : ""}
  <div class="rv-body">
    <nav class="rv-files" aria-label="Changed files"><div class="ft-head"><span>Files</span><span class="grow"></span><span class="mono muted small">${viewedN}/${list.length} viewed</span></div><div class="bar ft-bar"><span style="width:${(viewedN / list.length) * 100}%"></span></div><input class="ft-filter" type="search" placeholder="Filter files…" value="${esc(S.filter)}" aria-label="Filter files" data-filter>${tree}</nav>
    <div class="rv-scroll" id="rv-scroll">${list.map((f) => fileBlock(f)).join("")}<div class="rv-end muted small">End of changes · ${list.length} files</div></div>
  </div>
  <div class="rv-bar"><div class="rb-drafts"><button type="button" class="rb-count" data-show-drafts><span class="badge t-needs">${S.drafts.length} draft${S.drafts.length === 1 ? "" : "s"}</span></button><span class="muted small">${ours() ? `${w} for the worker · ` : ""}${pub} for ${esc(p.name)}</span></div><span class="rb-keys muted small"><kbd>j</kbd><kbd>k</kbd> files <kbd>v</kbd> viewed <kbd>c</kbd> comment <kbd>s</kbd> split</span><span class="grow"></span><button type="button" class="${ours() ? "ghost-btn" : "primary"}" data-publish>${esc(p.publish)}…</button>${ours() ? `<button type="button" class="primary" data-ask-worker ${w ? "" : "disabled"}>⚒ Ask worker to fix${w ? ` · ${w}` : ""} <kbd class="on-accent">⌘↵</kbd></button>` : ""}</div>
</section>`;
  const ai = S.threads.filter((x) => x.kind === "ai");
  const axis = (name) => {
    const items = ai.filter((x) => x.axis === name);
    const open = items.filter((x) => !x.resolved);
    return `<div class="ax-row"><span class="ax-name">${name}</span><span class="grow"></span>${open.length ? open.map((x) => `<span class="th-tag" data-sev="${x.severity}">${x.severity}</span>`).join("") : `<span class="muted small">✓ no findings</span>`}</div>`;
  };
  context.innerHTML = `<section class="ctx-section"><h2>Checks <span class="count">${p.checks.length}</span></h2>${p.checks.map((c) => `<div class="ck-row"><span class="st ok">✓</span><span class="ck-name">${esc(c.name)}</span><span class="grow"></span><span class="muted small mono">${esc(c.note)}</span></div>`).join("")}</section>
<section class="ctx-section"><h2>Open threads <span class="count">${openThreads().length}</span></h2>${openThreads()
    .map(
      (x) =>
        `<button type="button" class="ctx-thread" data-jump="${x.id}"><span class="th-tag" data-sev="${esc(x.severity ?? "")}">${esc(x.severity ?? "·")}</span><span class="ct-text">${esc(x.comments[0].body.replace(/`/g, "").split("\n")[0])}</span><span class="ct-loc mono muted">${esc(splitPath(x.path)[1])}:${x.line}</span></button>`,
    )
    .join("")}</section>
<section class="ctx-section"><h2>AI review <span class="muted small rv-ai-at">${esc(p.iterShort(3))}</span></h2>${axis("Standards")}${axis("Spec")}${axis("Bugs")}<button type="button" class="link-btn rerun">↻ Review ${esc(p.iterShort(iterNow))} again</button></section>
<section class="ctx-section"><h2>${esc(p.iterNoun)}s</h2><ol class="iter-list">${D.iterations
    .slice()
    .reverse()
    .map(
      (it) =>
        `<li data-head="${it.n === iterNow}"><span class="il-n mono">${esc(p.iterShort(it.n))}</span><span class="il-t">${esc(it.title)}<span class="muted small mono"> · ${it.commits.length} commit${it.commits.length === 1 ? "" : "s"} · ${it.sha.slice(0, 7)}</span>${it.n === lastSeen ? `<span class="il-seen">you looked here</span>` : ""}</span></li>`,
    )
    .join("")}</ol></section>
${ours() ? `<section class="ctx-section"><h2>Worker</h2>${workerCard()}</section>` : ""}`;
  wireScrollSpy();
}

function wireScrollSpy() {
  const sc = $("#rv-scroll");
  if (!sc) return;
  sc.addEventListener("scroll", () => {
    requestAnimationFrame(() => {
      const top = sc.getBoundingClientRect().top + 40;
      let cur = null;
      for (const b of sc.querySelectorAll(".fblock")) {
        if (b.getBoundingClientRect().top <= top) cur = b.dataset.file;
        else break;
      }
      if (cur && cur !== S.current) {
        S.current = cur;
        for (const el of document.querySelectorAll(".ft-file")) el.classList.toggle("current", el.dataset.goto === cur);
      }
    });
  });
}

function gotoFile(path, line) {
  S.current = path;
  if (S.collapsed.has(path) || S.viewed.has(path)) {
    S.collapsed.delete(path);
    S.viewed.delete(path);
    render();
  }
  const sc = $("#rv-scroll") ?? $(".sh-scroll") ?? $(".wk-main");
  const block = document.getElementById(`f-${cssId(path)}`);
  if (!sc || !block) return;
  const target = line ? (block.querySelector(`.drow[data-line="${line}"]`) ?? block) : block;
  sc.scrollTo({
    top: sc.scrollTop + target.getBoundingClientRect().top - sc.getBoundingClientRect().top - (line ? 120 : 0),
    behavior: "smooth",
  });
  if (line) flash(target);
  for (const el of document.querySelectorAll(".ft-file")) el.classList.toggle("current", el.dataset.goto === path);
}
function flash(el) {
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

// ------------------------------------------------------------------------------------------------ B: diff beside chat

function feedHtml(items) {
  return items
    .map((m) => {
      if (m.kind === "owner")
        return `<article class="msg owner"><div class="msg-meta"><span class="who">You</span><time>${m.time}</time></div><div class="bubble"><div class="msg-body">${m.quote ? quoteHtml(m.quote) : ""}<p>${esc(m.text)}</p></div></div></article>`;
      if (m.kind === "tool")
        return `<div class="tool-row" data-status="ok"><div class="tool-line"><button type="button" class="tool-head"><span class="st ok">✓</span><span class="tool-name">${esc(m.name)}</span><span class="tool-args">${esc(m.args)}</span><span class="tool-dur">${esc(m.dur)}</span></button>${m.worker ? `<button type="button" class="link-btn">worker ↗</button>` : ""}</div></div>`;
      if (m.kind === "agent")
        return `<article class="msg agent"><div class="msg-meta"><span class="who">Coordinator</span><time>${m.time}</time></div><div class="prose"><p>${m.html}</p></div></article>`;
      if (m.kind === "typing")
        return `<article class="msg agent"><div class="msg-meta"><span class="who">Coordinator</span></div><div class="prose typing"><span></span><span></span><span></span></div></article>`;
      if (m.kind === "report")
        return `<div class="report-row" data-status="ready"><span class="report-icon" aria-hidden="true">↩</span><span class="report-text"><b>worker</b> <span class="badge s-ready">Ready</span> ${esc(m.title)}<span class="muted"> · ${esc(m.note)}</span></span><button type="button" class="link-btn">Open worker ↗</button></div>`;
      if (m.kind === "html") return m.html;
      return "";
    })
    .join("");
}
const ref = (path, line, label) =>
  `<button type="button" class="code-ref mono" data-ref="${esc(path)}" data-ref-line="${line}">${esc(label ?? `${splitPath(path)[1]}:${line}`)}</button>`;
const lineOf = (path, find) => anchorLine(byPath.get(path), find)?.line;

function quoteHtml(q) {
  const f = byPath.get(q.path),
    lang = langOf(q.path);
  const rows = [];
  for (const h of f.hunks) for (const r of hunkRows(h)) if (r.n && r.n >= q.from && r.n <= q.to) rows.push(r);
  return `<div class="quote"><button type="button" class="quote-head mono" data-ref="${esc(q.path)}" data-ref-line="${q.from}">${pathHtml(q.path)}<span class="muted">:${q.from}${q.to > q.from ? `–${q.to}` : ""} @ ${esc(prov().iterShort(iterNow))}</span></button><div class="diff unified mini">${rows.map((r) => `<div class="drow ${r.t}"><span class="ln n">${r.n}</span><span class="code" data-sign="${r.t === "add" ? "+" : ""}">${codeHtml(r.text, lang)}</span></div>`).join("")}</div></div>`;
}

function chatItems() {
  const p = prov();
  return [
    ...CHAT,
    {
      kind: "agent",
      time: "09:14",
      html: `<button type="button" class="pr-ref mono" data-pr-hover>${esc(p.ref)}</button> is ready, checks green. The restart itself is ${ref("src/host-restart.ts", lineOf("src/host-restart.ts", "export function prepareReplacement"))}; the loader that pins the code is ${ref("src/host-restart.ts", lineOf("src/host-restart.ts", "function pinnedLoader"))}. One open P1 from review: ${ref("src/host-restart.ts", lineOf("src/host-restart.ts", "function refuse(){"))} exits 0 on refusal. I'd fix that before merge.`,
    },
  ];
}

function composerDock(placeholder) {
  const chips = S.chips
    .map(
      (c, i) =>
        `<span class="anchor-chip mono"><span aria-hidden="true">❝</span>${esc(splitPath(c.path)[1])}:${c.from}${c.to > c.from ? `–${c.to}` : ""}<span class="muted">@${esc(prov().iterShort(iterNow))}</span><button type="button" data-chip-del="${i}" aria-label="Remove">✕</button></span>`,
    )
    .join("");
  return `<div id="dock">${chips ? `<div class="anchor-chips">${chips}</div>` : ""}<form id="composer" autocomplete="off" data-chat-form><span class="glyph" aria-hidden="true">❯</span><textarea id="composer-input" rows="1" placeholder="${esc(placeholder)}" aria-label="Message coordinator"></textarea><div class="composer-side"><button type="submit" class="send" aria-label="Send">↵</button></div></form><p class="composer-hints" aria-hidden="true"><span><kbd>↵</kbd> send</span><span><kbd>⇧↵</kbd> newline</span><span><kbd>/</kbd> focus</span></p></div>`;
}

function renderSheet() {
  const p = prov();
  center.innerHTML = `<section id="chat-view" class="view"><div id="feed" role="log"><section class="turn">${feedHtml(chatItems().slice(0, 3))}</section><section class="turn">${feedHtml(chatItems().slice(3))}</section>${S.extraFeed.length ? `<section class="turn">${feedHtml(S.extraFeed)}</section>` : ""}</div>${composerDock(S.chips.length ? "Ask about the quoted lines…" : "Message the coordinator…")}</section>`;
  const feed = $("#feed");
  feed.scrollTop = feed.scrollHeight;
  if (!S.sheetOpen) {
    context.innerHTML = `<section class="ctx-section"><h2>Workers <span class="count">1</span></h2>${workerCard()}</section><section class="ctx-section"><h2>Pull requests</h2>${prRowRich()}</section>`;
    return;
  }
  const list = files();
  const idx = Math.max(
    0,
    list.findIndex((f) => f.path === S.sheetFile),
  );
  const f = list[idx] ?? list[0];
  const sel = S.selected?.path === f.path ? S.selected : null;
  context.innerHTML = `<div class="sheet">
  <div class="sh-head"><span class="rv-icon" aria-hidden="true">⎇</span><span class="chip mono">${esc(p.ref)}</span><span class="sh-title">${esc(TITLE)}</span><span class="grow"></span>${checksPill()}<button type="button" class="icon-btn" data-to-review title="Open the full review">⤢</button><button type="button" class="icon-btn" data-sheet-close aria-label="Close diff">✕</button></div>
  <div class="sh-files">${list.map((x) => `<button type="button" class="sh-chip${x.path === f.path ? " on" : ""}${S.viewed.has(x.path) ? " viewed" : ""}" data-sheet-file="${esc(x.path)}" title="${esc(x.path)}">${fileIcon(x.status)}<span class="mono">${esc(splitPath(x.path)[1])}</span>${threadsOf(x.path).some((t) => !t.resolved) ? `<span class="sh-dot" aria-label="open thread"></span>` : ""}</button>`).join("")}</div>
  <div class="sh-file"><button type="button" class="icon-btn small" data-sheet-step="-1" aria-label="Previous file">‹</button><span class="mono sh-path">${pathHtml(f.path)}</span><span class="muted small mono">${idx + 1}/${list.length}</span><button type="button" class="icon-btn small" data-sheet-step="1" aria-label="Next file">›</button><span class="grow"></span><span class="fh-stat mono"><span class="plus">+${f.add}</span> <span class="minus">−${f.del}</span></span>${rangeSegMini()}</div>
  <div class="sh-scroll">${fileBlock(f, { forceOpen: true })}</div>
  ${sel ? `<div class="sel-bar" role="toolbar" aria-label="Selected lines"><span class="mono small">${esc(splitPath(sel.path)[1])}:${sel.from}${sel.to > sel.from ? `–${sel.to}` : ""}</span><span class="grow"></span><button type="button" class="primary small" data-quote>❝ Ask in chat</button><button type="button" class="ghost-btn small" data-sel-comment>＋ Draft for worker</button><button type="button" class="icon-btn small" data-sel-clear aria-label="Clear selection">✕</button></div>` : `<div class="sh-hint muted small">Click a line number to select, <kbd>⇧</kbd>-click to extend. Selected lines go into the chat as a quote.</div>`}
</div>`;
}
function rangeSegMini() {
  const p = prov();
  return `<div class="seg mini" role="radiogroup" aria-label="Which changes"><button type="button" role="radio" aria-checked="${S.range === "all"}" data-range="all">All</button><button type="button" role="radio" aria-checked="${S.range === "since"}" data-range="since">${p.iterShort(lastSeen)}→${p.iterShort(iterNow)}</button></div>`;
}
function prRowRich() {
  const p = prov(),
    t = totals(D.files);
  return `<button type="button" class="pr-rich" data-sheet-open><span class="pr-rich-1"><span class="mono">${esc(p.ref)}</span><span class="pr-title">${esc(TITLE)}</span></span><span class="pr-rich-2"><span class="st ok">✓</span><span class="mono"><span class="plus">+${t.add}</span> <span class="minus">−${t.del}</span></span><span class="muted">${D.files.length} files</span><span class="needs-t">◌ ${openThreads().length}</span><span class="grow"></span><span class="link-btn">Review ▸</span></span></button>`;
}

// ------------------------------------------------------------------------------------------------ C: guided walkthrough

function renderWalk() {
  const p = prov();
  const steps = REVIEW_MAP;
  const total = steps.length;
  const done = S.step >= total;
  const st = steps[Math.min(S.step, total - 1)];
  const stepSize = (s) => totals(s.files.map((x) => byPath.get(x)).filter(Boolean));
  const stepper = steps
    .map((s, i) => {
      const state = S.stepState[s.id];
      const sz = stepSize(s);
      return `<li><button type="button" class="wk-step${i === S.step ? " current" : ""}" data-step="${i}" data-state="${state ?? ""}"><span class="wk-num">${state === "ok" ? "✓" : state === "ask" ? "?" : i + 1}</span><span class="wk-st"><span class="wk-title">${esc(s.title)}</span><span class="wk-meta muted small">${s.files.length ? `${s.files.length} file${s.files.length > 1 ? "s" : ""} · <span class="plus">+${sz.add}</span> <span class="minus">−${sz.del}</span>` : "summary"}</span></span>${stepChanged(s) ? `<span class="chg-mark" title="Files changed after the map was built">↻</span>` : s.risk ? `<span class="risk" data-risk="${s.risk}">${s.risk}</span>` : ""}</button></li>`;
    })
    .join("");
  let main;
  if (done) main = verdictHtml();
  else {
    const filesHtml = st.files
      .map((path) => {
        const f = byPath.get(path);
        if (!f) return "";
        const notes = (st.notes ?? [])
          .map((n) => ({ text: n.text, line: anchorLine(f, n.find)?.line }))
          .filter((n) => n.line && st.files[0] === path);
        return fileBlock(f, {
          forceOpen: true,
          changed: mapStale() && changedSince.has(path),
          body: { compact: true, mode: "unified", notes },
        });
      })
      .join("");
    const intro =
      st.id === "intent"
        ? `<div class="wk-overview"><div class="wk-ov-row">${steps
            .slice(1)
            .map((s) => {
              const sz = stepSize(s);
              return `<div class="wk-ov" style="flex:${Math.max(sz.add + sz.del, 30)}"><span class="wk-ov-bar" data-risk="${s.risk}"></span><span class="small">${esc(s.title)}</span><span class="muted small mono">+${sz.add} −${sz.del}</span></div>`;
            })
            .join(
              "",
            )}</div><p class="muted small">${isCombo() ? "The scout" : "The worker"} grouped ${D.files.length} files into ${total - 1} steps, riskiest first. ${isCombo() && !ours() ? "Risk and notes come from reading the diff and the PR description" : "Risk and notes come from the worker’s Ready report"}; the diff under each step is the real one.</p></div>`
        : "";
    main = `<div class="wk-card"><div class="wk-kicker muted small">Step ${S.step + 1} of ${total}${st.risk ? ` · <span class="risk" data-risk="${st.risk}">${st.risk} risk</span>` : ""}</div><h2 class="wk-h">${esc(st.title)}</h2><div class="wk-why"><span class="wk-by">${isCombo() ? `✦ scout’s map · ${esc(prov().iterShort(S.mapAt))} · ${ours() ? "diff + worker’s Ready report" : "diff + PR description"}` : `<span aria-hidden="true">⚒</span> worker’s map`}</span><p>${esc(st.why).replace(/`([^`]+)`/g, "<code>$1</code>")}</p></div><ul class="wk-checks">${st.checks.map((c, i) => `<li><label><input type="checkbox" data-check="${st.id}:${i}" ${S.checked.has(`${st.id}:${i}`) ? "checked" : ""}> ${esc(c)}</label></li>`).join("")}</ul>${intro}</div>${filesHtml}<div class="wk-pad"></div>`;
  }
  const answered = Object.keys(S.stepState).length;
  center.innerHTML = `<section class="view wk" aria-label="Review walkthrough">
  <div class="rv-head"><button type="button" class="back" data-back>← <kbd>Esc</kbd></button><span class="rv-icon" aria-hidden="true">⎇</span><h1>${esc(TITLE)}</h1><span class="chip mono">${esc(p.ref)}</span><span class="grow"></span><span class="muted small mono">${answered}/${total} steps</span><div class="wk-progress" aria-hidden="true">${steps.map((s, i) => `<i data-state="${S.stepState[s.id] ?? (i === S.step ? "cur" : "")}"></i>`).join("")}</div>${isCombo() ? tourCtl() : `<button type="button" class="ghost-btn small" data-to-review>All files ⤢</button>`}</div>
  <div class="wk-body"><ol class="wk-steps" aria-label="Steps">${stepper}<li><button type="button" class="wk-step verdict${done ? " current" : ""}" data-step="${total}"><span class="wk-num">◆</span><span class="wk-st"><span class="wk-title">Verdict</span><span class="wk-meta muted small">approve or send back</span></span></button></li></ol>
  <div class="wk-main">${mapStale() ? staleBanner() : ""}${main}</div></div>
  ${
    done
      ? ""
      : `<div class="rv-bar wk-bar">${S.asking ? `<form class="wk-ask" data-ask-form><textarea rows="2" placeholder="Question or change for “${esc(st.title)}”…" aria-label="Question"></textarea><button type="button" class="ghost-btn small" data-ask-cancel>Cancel</button><button type="submit" class="primary small">Add question</button></form>` : `<button type="button" class="ghost-btn" data-step-go="-1" ${S.step ? "" : "disabled"}>← Back</button><span class="grow"></span><button type="button" class="ghost-btn" data-ask>? Ask about this step <kbd>a</kbd></button><button type="button" class="primary" data-step-ok>Looks good, next → <kbd class="on-accent">↵</kbd></button>`}</div>`
  }
</section>`;
  context.innerHTML = `<section class="ctx-section"><h2>Your questions <span class="count">${S.questions.length}</span></h2>${S.questions.length ? S.questions.map((q) => `<div class="q-item"><span class="muted small">${esc(q.step)}</span><p>${esc(q.text)}</p></div>`).join("") : `<p class="muted small empty-line">None yet. “Ask about this step” collects them here; they go to the worker together.</p>`}</section>
<section class="ctx-section"><h2>Open findings <span class="count">${openThreads().length}</span></h2>${openThreads()
    .map(
      (x) =>
        `<div class="ctx-thread static"><span class="th-tag" data-sev="${esc(x.severity ?? "")}">${esc(x.severity ?? "·")}</span><span class="ct-text">${esc(x.comments[0].body.replace(/`/g, "").split("\n")[0])}</span><span class="ct-loc mono muted">${esc(splitPath(x.path)[1])}:${x.line}</span></div>`,
    )
    .join("")}</section>
${ours() ? `<section class="ctx-section"><h2>Worker</h2>${workerCard()}</section>` : ""}`;
  $(".wk-main")?.scrollTo(0, 0);
  if (S.asking) $(".wk-ask textarea")?.focus();
}

function staleBanner() {
  const p = prov();
  const n = REVIEW_MAP.filter(stepChanged).length;
  return `<div class="stale-map"><span class="stale-ic" aria-hidden="true">↻</span><span><b>The map was built on ${esc(p.iterShort(S.mapAt))}.</b> ${esc(p.iterShort(iterNow))} changed ${changedSince.size} files in ${n} steps; they are marked ↻ and show the current diff. Their notes may be out of date.</span><span class="grow"></span><button type="button" class="ghost-btn small" data-tour-request>↻ Rebuild map</button></div>`;
}

function verdictHtml() {
  const p = prov();
  const qs = S.questions.length + openThreads().filter((t) => t.severity === "P1").length;
  return `<div class="wk-card verdict"><div class="wk-kicker muted small">Verdict</div><h2 class="wk-h">You went through ${Object.keys(S.stepState).length} of ${REVIEW_MAP.length} steps</h2>
  <table class="wk-sum">${REVIEW_MAP.map(
    (s) =>
      `<tr><td>${S.stepState[s.id] === "ok" ? `<span class="st ok">✓</span>` : S.stepState[s.id] === "ask" ? `<span class="q-mark">?</span>` : `<span class="muted">–</span>`}</td><td>${esc(s.title)}</td><td>${s.risk ? `<span class="risk" data-risk="${s.risk}">${s.risk}</span>` : ""}</td><td class="muted small">${esc(
        S.questions
          .filter((q) => q.step === s.title)
          .map((q) => q.text)
          .join(" · "),
      )}</td></tr>`,
  ).join("")}</table>
  <div class="verdict-grid">${ours() ? "" : `<button type="button" class="v-opt" data-publish><span class="v-ic">✓</span><b>Approve on ${esc(p.name)}</b><span class="muted small">Publish your notes with an approval. Nothing goes to a worker: it is a colleague’s PR.</span></button>`}<button type="button" class="v-opt" data-ask-worker ${ours() ? "" : "hidden"}><span class="v-ic">⚒</span><b>Send back to a worker</b><span class="muted small">${qs} item${qs === 1 ? "" : "s"}: your questions and the open P1. A fresh worker continues ${esc(p.head)}.</span></button><button type="button" class="v-opt" data-merge ${ours() ? "" : "hidden"}><span class="v-ic">✓</span><b>Approve and ask to merge</b><span class="muted small">The Coordinator checks the head and merges through the normal flow.</span></button><button type="button" class="v-opt" data-publish><span class="v-ic">↗</span><b>${esc(p.publish)}</b><span class="muted small">${ours() ? `Post your questions on ${esc(p.name)} instead of to a worker.` : `Post your questions on ${esc(p.name)} without approving.`}</span></button></div></div>`;
}

// ------------------------------------------------------------------------------------------------ D: card in the chat

function renderFeed() {
  const p = prov(),
    t = totals(D.files);
  const dirColor = (path) =>
    path.startsWith("src/") ? "src" : path.startsWith("web/") ? "web" : path.startsWith("scripts/") ? "scripts" : "docs";
  const map = D.files
    .map(
      (f) =>
        `<button type="button" class="cm-seg" data-dir="${dirColor(f.path)}" style="flex:${f.add + f.del}" data-card-file="${esc(f.path)}" title="${esc(`${f.path} +${f.add} −${f.del}`)}"${S.cardOpen.has(f.path) ? ' data-on="1"' : ""}></button>`,
    )
    .join("");
  const rows = (list, open, key) =>
    list
      .map((f) => {
        const isOpen = open.has(f.path);
        const th = threadsOf(f.path).filter((x) => !x.resolved).length;
        return `<li class="pc-file${isOpen ? " open" : ""}"><button type="button" class="pc-row" data-${key}="${esc(f.path)}" aria-expanded="${isOpen}"><span class="chev" aria-hidden="true">${isOpen ? "▾" : "▸"}</span>${fileIcon(f.status)}<span class="mono pc-path">${pathHtml(f.path)}</span>${th ? `<span class="ft-th">◌${th}</span>` : ""}<span class="grow"></span><span class="mono small"><span class="plus">+${f.add}</span> <span class="minus">−${f.del}</span></span>${statBar(f.add, f.del)}</button>${isOpen ? `<div class="pc-diff">${fileBody(f, p, bodyOpts(f, { mode: "unified", compact: false }))}</div>` : ""}</li>`;
      })
      .join("");
  const { w } = draftCounts();
  const card = `<article class="pr-card" aria-label="Pull request ${esc(p.ref)}"><header class="pc-head"><span class="rv-icon" aria-hidden="true">⎇</span><b class="mono">${esc(p.ref)}</b><span class="pc-title">${esc(TITLE)}</span><span class="grow"></span>${checksPill()}${threadsPill()}</header>
  <div class="pc-sub mono small"><span>${esc(p.head)} → ${esc(p.base)}</span><span class="dotsep">·</span><span>${iterNow} ${esc(p.iterNoun)}es</span><span class="dotsep">·</span><span><span class="plus">+${t.add}</span> <span class="minus">−${t.del}</span></span><span class="dotsep">·</span><span>${D.files.length} files</span></div>
  <div class="change-map" role="group" aria-label="Change map: one segment per file, width is lines changed">${map}</div><div class="cm-legend small muted"><span data-dir="src">src</span><span data-dir="web">web</span><span data-dir="scripts">scripts</span><span data-dir="docs">docs</span><span class="grow"></span><span>click a segment or a row to open its diff here</span></div>
  <ul class="pc-files">${rows(D.files, S.cardOpen, "card-file")}</ul>
  <footer class="pc-foot">${w ? `<span class="badge t-needs">${w} draft${w > 1 ? "s" : ""}</span>` : ""}<span class="grow"></span><button type="button" class="ghost-btn small" data-to-review>Full review ⤢</button><button type="button" class="ghost-btn small" data-ask-worker ${w ? "" : "disabled"}>⚒ Ask worker to fix</button><button type="button" class="primary small" data-merge>Approve & merge…</button></footer></article>`;
  const it = D.iterations[3];
  const inter = D.interdiff.files;
  const itt = totals(inter);
  const iterCard = `<article class="iter-card"><header class="pc-head"><span class="ic-badge" aria-hidden="true">↻</span><span><b>Worker pushed ${esc(p.iterShort(iterNow))}</b><span class="muted"> · ${esc(it.title)}</span></span><span class="grow"></span><span class="mono small"><span class="plus">+${itt.add}</span> <span class="minus">−${itt.del}</span> · ${inter.length} files since you looked at ${esc(p.iterShort(lastSeen))}</span></header><ul class="pc-files">${rows(inter, S.iterOpen, "iter-file").replace(/data-card-file/g, "data-iter-file")}</ul></article>`;
  const items = chatItems();
  center.innerHTML = `<section id="chat-view" class="view"><div id="feed" role="log"><section class="turn">${feedHtml(items.slice(0, 3))}</section><section class="turn">${feedHtml(items.slice(3, 4))}${card}${feedHtml(items.slice(4))}</section><section class="turn"><div class="tool-row" data-status="ok"><div class="tool-line"><button type="button" class="tool-head"><span class="st ok">✓</span><span class="tool-name">agents</span><span class="tool-args">send worker “fix the second confirmation focus”</span><span class="tool-dur">0.2s</span></button></div></div>${iterCard}<article class="msg agent"><div class="msg-meta"><span class="who">Coordinator</span><time>09:31</time></div><div class="prose"><p>The worker pinned the focus assertion; checks are green again on ${esc(p.iterShort(iterNow))}.</p></div></article></section></div>${composerDock("Message the coordinator…")}</section>`;
  context.innerHTML = `<section class="ctx-section"><h2>Workers <span class="count">1</span></h2>${workerCard()}</section><section class="ctx-section"><h2>Pull requests</h2>${prRowRich()}</section>`;
  const feed = $("#feed");
  feed.scrollTop = 0;
}

// ------------------------------------------------------------------------------------------------ dialogs

function briefText() {
  const p = prov();
  const lines = S.drafts
    .filter((d) => d.dest === "worker")
    .map((d) => `- ${d.path}:${d.line} @ ${D.head.slice(0, 7)}: ${d.body}`)
    .concat(S.questions.map((q) => `- (${q.step}) ${q.text}`));
  return `Continue ${p.ref} on ${p.head} with a fresh worker.\n\nThe owner reviewed ${p.iter(iterNow)} (${D.head.slice(0, 7)}) and asks for these changes:\n${lines.join("\n") || "- (none)"}\n\nKeep the merge-not-rebase rule. Push to the same branch.`;
}
function openDialog(html) {
  const d = $("#proto-dialog");
  d.innerHTML = html;
  d.showModal();
}
function askWorkerDialog() {
  openDialog(
    `<form method="dialog" class="confirm"><h2>Send ${draftCounts().w + S.questions.length} notes to a fresh worker?</h2><p class="muted">The Coordinator gets the message below and starts a fresh worker on <b class="mono">${esc(prov().head)}</b>. Nothing is posted on ${esc(prov().name)}.</p><pre class="merge-text">${esc(briefText())}</pre><div class="confirm-actions"><button type="button" class="ghost-btn" data-dlg-close>Cancel</button><button type="button" class="primary" data-dlg-send>Send to the Coordinator</button></div></form>`,
  );
}
function publishDialog() {
  const p = prov(),
    pub = S.drafts.filter((d) => d.dest === "pub");
  openDialog(
    `<form method="dialog" class="confirm pub"><h2>${esc(p.publish)} on ${esc(p.ref)}</h2><p class="muted">${pub.length ? `${pub.length} draft${pub.length > 1 ? "s" : ""} for ${esc(p.name)}.` : `No drafts for ${esc(p.name)}; you can still leave a verdict.`} Drafts for the worker stay here.</p>${pub.map((d) => `<div class="pub-d mono small">${esc(d.path)}:${d.line} — <span class="muted">${esc(d.body)}</span></div>`).join("")}<div class="pub-verbs" role="radiogroup">${p.publishVerbs.map(([k, l, note], i) => `<label class="pub-verb"><input type="radio" name="verb" value="${k}" ${i === 0 ? "checked" : ""}><span><b>${esc(l)}</b><span class="muted small">${esc(note)}</span></span></label>`).join("")}</div><p class="small warn">Posts as <b>${esc(p.author)}</b> on ${esc(p.name)}. Others see it at once; it cannot be unsent from here.</p><div class="confirm-actions"><button type="button" class="ghost-btn" data-dlg-close>Cancel</button><button type="button" class="primary" data-dlg-publish>Publish</button></div></form>`,
  );
}
function mergeDialog() {
  const p = prov();
  openDialog(
    `<form method="dialog" class="confirm"><h2>Ask the Coordinator to merge ${esc(p.ref)}?</h2><p>${esc(TITLE)}</p><p class="muted">Same flow as the Merge button today: the Coordinator checks the PR is still open and mergeable at <span class="mono">${D.head.slice(0, 7)}</span>, merges, and reports. ${openThreads().length ? `<b>${openThreads().length} threads are still open.</b>` : ""}</p><div class="confirm-actions"><button type="button" class="ghost-btn" data-dlg-close>Cancel</button><button type="button" class="primary" data-dlg-merge>Send merge request</button></div></form>`,
  );
}
function apiDialog() {
  const md = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  openDialog(
    `<div class="api-map"><div class="api-head"><h2>Where each part comes from</h2><span class="muted small">GitHub · Arcanum (Arc plugin) · pi-prjcts host</span><span class="grow"></span><button type="button" class="icon-btn" data-dlg-close aria-label="Close">✕</button></div><div class="api-scroll"><table><thead><tr><th>Feature</th><th data-on="${S.provider === "github"}">GitHub</th><th data-on="${S.provider === "arc"}">Arc / Arcanum</th><th>pi-prjcts</th></tr></thead><tbody>${API_MAP.map((r) => `<tr><td><b>${esc(r.feature)}</b></td><td data-on="${S.provider === "github"}">${md(r.github) || '<span class="muted">—</span>'}</td><td data-on="${S.provider === "arc"}">${md(r.arc) || '<span class="muted">—</span>'}</td><td>${md(r.host) || '<span class="muted">—</span>'}</td></tr>`).join("")}</tbody></table></div></div>`,
  );
}

// ------------------------------------------------------------------------------------------------ switcher

function renderBar() {
  const i = VARIANTS.findIndex(([k]) => k === S.variant);
  const [, name, desc] = VARIANTS[i];
  $("#proto-bar").innerHTML =
    `<span class="pb-tag">PROTOTYPE</span><button type="button" data-variant-step="-1" aria-label="Previous variant">‹</button><span class="pb-label" title="${esc(desc)}"><b>${String.fromCharCode(65 + i)}</b> — ${esc(name)}<span class="pb-desc">${esc(desc)}</span></span><button type="button" data-variant-step="1" aria-label="Next variant">›</button><span class="pb-sep"></span><span class="pb-group" role="radiogroup" aria-label="Provider">${["github", "arc"].map((k) => `<button type="button" role="radio" aria-checked="${S.provider === k}" data-provider="${k}">${k === "github" ? "GitHub" : "Arc"}</button>`).join("")}</span><span class="pb-group" role="radiogroup" aria-label="Theme">${["claude", "midnight", "light"].map((k) => `<button type="button" role="radio" aria-checked="${S.theme === k}" data-theme-pick="${k}" title="${k}" class="pb-sw sw-${k}"></button>`).join("")}</span>${
      isCombo()
        ? `<span class="pb-sep"></span><span class="pb-group" role="radiogroup" aria-label="Whose PR">${[
            ["ours", "Our PR"],
            ["colleague", "Colleague’s"],
          ]
            .map(([k, l]) => `<button type="button" role="radio" aria-checked="${S.author === k}" data-author="${k}">${l}</button>`)
            .join("")}</span><button type="button" data-sim-push title="Pretend a push arrived after the map was built">Sim push</button>`
        : ""
    }<button type="button" class="pb-api" data-api>API map</button>`;
}
function setUrl() {
  const u = new URL(location.href);
  u.searchParams.set("variant", S.variant);
  u.searchParams.set("provider", S.provider);
  u.searchParams.set("theme", S.theme);
  history.replaceState(null, "", u);
}

// ------------------------------------------------------------------------------------------------ render + events

function render() {
  const keep = $("#rv-scroll")?.scrollTop ?? $(".sh-scroll")?.scrollTop ?? $(".wk-main")?.scrollTop;
  const keepFeed = $("#feed")?.scrollTop;
  document.documentElement.dataset.theme = S.theme;
  app.dataset.variant = S.variant;
  const full = isReview() || isWalk();
  if (full && S.listBefore === null) {
    S.listBefore = app.dataset.list;
    app.dataset.list = "0";
  } else if (!full && S.listBefore !== null) {
    app.dataset.list = S.listBefore;
    S.listBefore = null;
  }
  app.dataset.sheet = S.variant === "sheet" && S.sheetOpen ? "1" : "0";
  $("#crumbs").innerHTML = full
    ? `<b>pi-prjcts</b><span class="sep">/</span><span>Main</span><span class="sep">›</span><span class="muted">${esc(prov().ref)}</span>`
    : `<b>pi-prjcts</b><span class="sep">/</span><span>Main</span>`;
  if (isCombo()) (S.tourView === "tour" ? renderWalk : renderReview)();
  else ({ review: renderReview, sheet: renderSheet, walk: renderWalk, feed: renderFeed })[S.variant]();
  renderBar();
  setUrl();
  if (keep != null) {
    const sc = $("#rv-scroll") ?? $(".sh-scroll") ?? (S.variant === "walk" && !S.stepChanged ? $(".wk-main") : null);
    if (sc) sc.scrollTop = keep;
  }
  S.stepChanged = false;
  if (keepFeed != null && S.variant === "feed") $("#feed").scrollTop = keepFeed;
  if (S.composer) {
    const ta = $(".inline-composer textarea");
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }
}

function openComposer(path, line) {
  const sel = S.selected?.path === path && line >= S.selected.from && line <= S.selected.to ? S.selected : { from: line, to: line };
  S.composer = { path, from: sel.from, to: sel.to, dest: ours() ? "worker" : "pub", text: "" };
  render();
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("button, a, input, [data-ref]");
  if (!t) return;
  const d = t.dataset;
  if (t.matches("a[data-noop]")) e.preventDefault();
  if (d.variantStep) {
    const i = VARIANTS.findIndex(([k]) => k === S.variant);
    S.variant = VARIANTS[(i + Number(d.variantStep) + VARIANTS.length) % VARIANTS.length][0];
    S.composer = null;
    S.selected = null;
    return render();
  }
  if (d.provider) return ((S.provider = d.provider), render());
  if (d.themePick) return ((S.theme = d.themePick), render());
  if (d.api !== undefined) return apiDialog();
  if (d.cmd === "toggle-list") return (app.dataset.list = app.dataset.list === "0" ? "1" : "0");
  if (d.cmd === "toggle-context") return (app.dataset.context = app.dataset.context === "0" ? "1" : "0");
  if (d.dlgClose !== undefined) return $("#proto-dialog").close();
  if (d.dlgSend !== undefined) {
    $("#proto-dialog").close();
    S.drafts = S.drafts.filter((x) => x.dest !== "worker");
    S.questions = [];
    toast(`Sent to the Coordinator. A fresh worker continues <b>${esc(prov().head)}</b>.`);
    return render();
  }
  if (d.dlgPublish !== undefined) {
    $("#proto-dialog").close();
    const n = S.drafts.filter((x) => x.dest === "pub").length;
    S.drafts = S.drafts.filter((x) => x.dest !== "pub");
    toast(`Published on ${esc(prov().name)}${n ? ` with ${n} comment${n > 1 ? "s" : ""}` : ""} (prototype: nothing was sent).`);
    return render();
  }
  if (d.dlgMerge !== undefined) {
    $("#proto-dialog").close();
    return toast("Merge request sent to the Coordinator (prototype: nothing was sent).");
  }
  if (d.mode) return ((S.mode = d.mode), render());
  if (d.wrap !== undefined) return ((S.wrap = !S.wrap), render());
  if (d.range) {
    S.range = d.range;
    if (S.range === "since") for (const f of D.interdiff.files) S.viewed.delete(f.path);
    if (S.variant === "sheet" && !files().some((f) => f.path === S.sheetFile)) S.sheetFile = files()[0].path;
    return render();
  }
  if (d.goto) return gotoFile(d.goto);
  if (d.collapse) {
    const p = d.collapse;
    if (S.viewed.has(p)) S.viewed.delete(p);
    else S.collapsed.has(p) ? S.collapsed.delete(p) : S.collapsed.add(p);
    return render();
  }
  if (d.viewed) {
    S.viewed.has(d.viewed) ? S.viewed.delete(d.viewed) : S.viewed.add(d.viewed);
    return render();
  }
  if (d.copy) return toast(`Copied <span class="mono">${esc(d.copy)}</span>`);
  if (d.expand) {
    const p = t.closest(".fblock").dataset.file;
    S.expanded[p] = { ...S.expanded[p], [d.expand]: (S.expanded[p]?.[d.expand] ?? 0) + 20 };
    return render();
  }
  if (d.expandAll) {
    const p = t.closest(".fblock").dataset.file;
    S.expanded[p] = { ...S.expanded[p], [d.expandAll]: 9999 };
    return render();
  }
  if (t.classList.contains("add-c")) {
    const row = t.closest(".drow");
    return openComposer(row.dataset.path, Number(row.dataset.line));
  }
  if (d.dest) {
    S.composer.dest = d.dest;
    S.composer.text = $(".inline-composer textarea").value;
    return render();
  }
  if (d.issue !== undefined && S.composer) return (S.composer.issue = t.checked);
  if (d.suggest !== undefined) {
    const ta = $(".inline-composer textarea");
    const f = byPath.get(S.composer.path);
    const rows = f.hunks.flatMap(hunkRows).filter((r) => r.n >= S.composer.from && r.n <= S.composer.to);
    ta.value += `${ta.value ? "\n" : ""}\`\`\`suggestion\n${rows.map((r) => r.text).join("\n")}\n\`\`\``;
    S.composer.text = ta.value;
    return ta.focus();
  }
  if (d.cancelComposer !== undefined) return ((S.composer = null), render());
  if (d.draftDel) return ((S.drafts = S.drafts.filter((x) => x.id !== d.draftDel)), render());
  if (d.resolve) {
    const th = S.threads.find((x) => x.id === d.resolve);
    th.resolved = !th.resolved;
    S.openThreads.delete(th.id);
    toast(th.resolved ? `${esc(prov().resolve)}d (prototype)` : "Reopened");
    return render();
  }
  if (d.threadOpen) return (S.openThreads.add(d.threadOpen), render());
  if (d.fix) {
    const th = S.threads.find((x) => x.id === d.fix);
    S.drafts.push({
      id: `d${uid++}`,
      path: th.path,
      line: th.line,
      dest: "worker",
      body: `Fix the ${th.axis} finding: ${th.comments[0].body.split("\n")[0].replace(/`/g, "")}`,
    });
    toast("Added to the fix list for the worker.");
    return render();
  }
  if (d.reply) {
    const th = S.threads.find((x) => x.id === d.reply);
    S.composer = { path: th.path, from: th.line, to: th.line, dest: "pub", text: "" };
    return render();
  }
  if (d.jump) {
    const th = S.threads.find((x) => x.id === d.jump);
    return gotoFile(th.path, th.line);
  }
  if (d.askWorker !== undefined) return askWorkerDialog();
  if (d.publish !== undefined) return publishDialog();
  if (d.merge !== undefined) return mergeDialog();
  if (d.showDrafts !== undefined) {
    const first = S.drafts[0];
    return first && gotoFile(first.path, first.line);
  }
  if (d.back !== undefined) return toast("Esc returns to the chat (prototype stays here).");
  if (d.toReview !== undefined) return isCombo() ? ((S.tourView = "files"), render()) : ((S.variant = "review"), render());
  if (d.tourRequest !== undefined) {
    const again = S.tour === "ready";
    S.tour = "loading";
    render();
    return setTimeout(() => {
      S.tour = "ready";
      S.mapAt = iterNow;
      S.tourView = "tour";
      if (!again) S.step = 0;
      S.stepChanged = true;
      toast(
        again
          ? `The scout rebuilt the map for ${esc(prov().iterShort(iterNow))}.`
          : `The scout sent a review map: 6 steps, riskiest first${ours() ? ", built with the worker's Ready report" : ""}.`,
      );
      render();
    }, 1600);
  }
  if (d.author) return ((S.author = d.author), (S.tour = "none"), (S.tourView = "files"), (S.stepState = {}), render());
  if (d.simPush !== undefined) {
    if (S.tour !== "ready") return toast("Build a map first.");
    S.mapAt = lastSeen;
    toast(`${esc(prov().iterShort(iterNow))} arrived after the map was built (simulated).`);
    return render();
  }
  if (d.tourView) return ((S.tourView = d.tourView), (S.stepChanged = true), render());
  // B
  if (d.sheetClose !== undefined) return ((S.sheetOpen = false), render());
  if (d.sheetOpen !== undefined) {
    if (S.variant === "feed") return ((S.variant = "review"), render());
    return ((S.sheetOpen = true), render());
  }
  if (d.sheetFile) return ((S.sheetFile = d.sheetFile), (S.selected = null), render());
  if (d.sheetStep) {
    const list = files(),
      i = list.findIndex((f) => f.path === S.sheetFile);
    S.sheetFile = list[(i + Number(d.sheetStep) + list.length) % list.length].path;
    S.selected = null;
    return render();
  }
  if (d.ref) {
    if (S.variant === "sheet") {
      S.sheetOpen = true;
      S.sheetFile = d.ref;
      S.range = "all";
      render();
      const row = $(`.sh-scroll .drow[data-line="${d.refLine}"]`);
      if (row) {
        row.scrollIntoView({ block: "center" });
        flash(row);
      }
      return;
    }
    S.variant = "review";
    render();
    return gotoFile(d.ref, Number(d.refLine));
  }
  if (d.quote !== undefined) {
    S.chips.push({ ...S.selected });
    S.selected = null;
    render();
    return $("#composer-input").focus();
  }
  if (d.selComment !== undefined) return openComposer(S.selected.path, S.selected.to);
  if (d.selClear !== undefined) return ((S.selected = null), render());
  if (d.chipDel) return (S.chips.splice(Number(d.chipDel), 1), render());
  // C
  if (d.step) {
    S.step = Number(d.step);
    S.asking = false;
    S.stepChanged = true;
    return render();
  }
  if (d.stepGo) return ((S.step = Math.max(0, S.step + Number(d.stepGo))), (S.stepChanged = true), render());
  if (d.stepOk !== undefined) return stepOk();
  if (d.ask !== undefined) return ((S.asking = true), render());
  if (d.askCancel !== undefined) return ((S.asking = false), render());
  if (d.check) {
    t.checked ? S.checked.add(d.check) : S.checked.delete(d.check);
    return;
  }
  // D
  if (d.cardFile) {
    S.cardOpen.has(d.cardFile) ? S.cardOpen.delete(d.cardFile) : S.cardOpen.add(d.cardFile);
    return render();
  }
  if (d.iterFile) {
    S.iterOpen.has(d.iterFile) ? S.iterOpen.delete(d.iterFile) : S.iterOpen.add(d.iterFile);
    return render();
  }
});

// Line selection: click a line number, shift-click to extend.
document.addEventListener("mousedown", (e) => {
  const ln = e.target.closest(".ln.n");
  if (!ln || e.target.closest(".add-c")) return;
  const row = ln.closest(".drow");
  const line = Number(row.dataset.line);
  if (!line) return;
  e.preventDefault();
  const path = row.dataset.path;
  if (e.shiftKey && S.selected?.path === path)
    S.selected = { path, from: Math.min(S.selected.from, line), to: Math.max(S.selected.to, line) };
  else S.selected = S.selected?.path === path && S.selected.from === line && S.selected.to === line ? null : { path, from: line, to: line };
  render();
});

function stepOk() {
  const st = REVIEW_MAP[S.step];
  if (st) S.stepState[st.id] = S.stepState[st.id] === "ask" ? "ask" : "ok";
  if (st && isCombo()) for (const f of st.files) S.viewed.add(f);
  S.step = Math.min(REVIEW_MAP.length, S.step + 1);
  S.stepChanged = true;
  render();
}

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.matches(".inline-composer")) {
    const text = f.querySelector("textarea").value.trim();
    if (!text) return;
    S.drafts.push({
      id: `d${uid++}`,
      path: S.composer.path,
      line: S.composer.to,
      dest: S.composer.dest,
      body: text,
      issue: S.composer.issue,
    });
    S.composer = null;
    S.selected = null;
    return render();
  }
  if (f.matches("[data-ask-form]")) {
    const text = f.querySelector("textarea").value.trim();
    if (!text) return;
    const st = REVIEW_MAP[S.step];
    S.questions.push({ step: st.title, text });
    S.stepState[st.id] = "ask";
    S.asking = false;
    return render();
  }
  if (f.matches("[data-chat-form]")) {
    const ta = f.querySelector("textarea");
    const text = ta.value.trim() || "Why is this needed?";
    const quote = S.chips[0];
    S.extraFeed.push({ kind: "owner", time: "09:40", text, quote });
    S.chips = [];
    S.extraFeed.push({ kind: "typing" });
    render();
    setTimeout(() => {
      S.extraFeed.pop();
      const where = quote ? ref(quote.path, quote.from) : "the PR";
      S.extraFeed.push(
        { kind: "tool", name: "read", args: quote ? `${quote.path}:${quote.from}-${quote.to + 6}` : "pr #66", dur: "0.1s" },
        {
          kind: "agent",
          time: "09:40",
          html: `About ${where}: the replacement must run exactly the revision the owner confirmed. Re-checking right before <code>execve</code> closes the gap between the confirmation and the exec. Want me to send this to the worker as a change?`,
        },
      );
      render();
    }, 900);
  }
});

document.addEventListener("input", (e) => {
  if (e.target.matches(".inline-composer textarea") && S.composer) S.composer.text = e.target.value;
  if (e.target.matches("[data-filter]")) {
    S.filter = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const inp = $("[data-filter]");
    inp.focus();
    inp.setSelectionRange(pos, pos);
  }
});

document.addEventListener("keydown", (e) => {
  const typing = e.target.closest("input, textarea, [contenteditable]");
  if (typing) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.target.closest("form")?.requestSubmit();
    }
    if (e.key === "Escape" && S.composer) {
      S.composer = null;
      render();
    }
    if (e.key === "Enter" && !e.shiftKey && e.target.id === "composer-input") {
      e.preventDefault();
      e.target.closest("form").requestSubmit();
    }
    return;
  }
  if ($("#proto-dialog").open) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const i = VARIANTS.findIndex(([k]) => k === S.variant);
    S.variant = VARIANTS[(i + (e.key === "ArrowRight" ? 1 : -1) + VARIANTS.length) % VARIANTS.length][0];
    S.composer = null;
    S.selected = null;
    return render();
  }
  if (e.key === "Escape") {
    if (S.composer || S.selected) {
      S.composer = null;
      S.selected = null;
      return render();
    }
  }
  if (isReview()) {
    const list = files().map((f) => f.path);
    const i = list.indexOf(S.current);
    if (e.key === "j") return gotoFile(list[Math.min(list.length - 1, i + 1)]);
    if (e.key === "k") return gotoFile(list[Math.max(0, i - 1)]);
    if (e.key === "v") {
      S.viewed.has(S.current) ? S.viewed.delete(S.current) : S.viewed.add(S.current);
      render();
      return gotoFile(list[Math.min(list.length - 1, i + 1)]);
    }
    if (e.key === "s") return ((S.mode = S.mode === "split" ? "unified" : "split"), render());
    if (e.key === "c" && S.selected) return openComposer(S.selected.path, S.selected.to);
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draftCounts().w) return askWorkerDialog();
  }
  if (isWalk()) {
    if (e.key === "Enter" && S.step < REVIEW_MAP.length) return stepOk();
    if (e.key === "a" && S.step < REVIEW_MAP.length) return ((S.asking = true), render());
  }
});

// Hovering a PR reference shows its card.
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-pr-hover]");
  const pop = $("#popover");
  if (!el) return pop.hidden || e.target.closest("#popover") ? undefined : (pop.hidden = true);
  const p = prov(),
    t = totals(D.files),
    r = el.getBoundingClientRect();
  pop.innerHTML = `<div class="pr-pop"><div class="pc-head"><span class="rv-icon">⎇</span><b class="mono">${esc(p.ref)}</b><span class="badge t-ready">Ready</span></div><div class="pp-title">${esc(TITLE)}</div><div class="pp-row small">${checksPill()}${threadsPill()}<span class="mono"><span class="plus">+${t.add}</span> <span class="minus">−${t.del}</span></span></div><div class="change-map small-map">${D.files.map((f) => `<span class="cm-seg" data-dir="${f.path.split("/")[0] === "src" ? "src" : f.path.split("/")[0] === "web" ? "web" : f.path.split("/")[0] === "scripts" ? "scripts" : "docs"}" style="flex:${f.add + f.del}"></span>`).join("")}</div><div class="muted small">Click to open the review</div></div>`;
  pop.hidden = false;
  pop.style.left = `${Math.min(r.left, innerWidth - 340)}px`;
  pop.style.top = `${r.bottom + 6}px`;
});
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-pr-hover]")) {
    $("#popover").hidden = true;
    S.variant = S.variant === "sheet" ? "sheet" : "review";
    S.sheetOpen = true;
    render();
  }
});

render();
