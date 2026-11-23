import { esc } from "./format.js";
const counts = (a, d) => `<span class="plus">+${esc(a)}</span> <span class="minus">−${esc(d)}</span>`;
const pathParts = (p) => [p.slice(0, p.lastIndexOf("/") + 1), p.slice(p.lastIndexOf("/") + 1)];
const icon = (f) => `<span class="fs fs-${esc(f.status.toLowerCase())}">${esc(f.status)}</span>`;
const threadCount = (f) => {
  const n = f.threads.filter((t) => !t.resolved).length;
  return n ? `◌${n}` : "";
};
export function fileHeader(f, i, collapsed, disabled) {
  const [dir, name] = pathParts(f.path),
    total = f.stats?.additions + f.stats?.deletions || 0,
    a = total ? Math.round((5 * f.stats?.additions) / total) : 0,
    d = total ? 5 - a : 0;
  return `<section class="fblock" data-idx="${i}"><header class="fhead"><button class="fh-toggle" data-toggle aria-label="Toggle file" aria-expanded="${!collapsed}" ${disabled ? "disabled" : ""}>${collapsed ? "▸" : "▾"}</button>${icon(f)}<span class="fh-path mono"><span class="p-dir">${esc(dir)}</span><b>${esc(name)}</b></span><span class="fh-th">${threadCount(f)}</span><span class="grow"></span><span class="fh-stat mono">${f.stats?.additions == null ? "" : counts(f.stats?.additions, f.stats?.deletions)}</span><span class="statbar">${'<i class="a"></i>'.repeat(a) + '<i class="d"></i>'.repeat(d) + "<i></i>".repeat(5 - a - d)}</span><label class="viewed-box"><input type="checkbox" data-mark ${f.viewed ? "checked" : ""}> Viewed</label></header><div class="diff rv-code" ${collapsed ? "hidden" : ""}>Loading…</div></section>`;
}
export function fileTree(files, filter, current) {
  const groups = new Map();
  files.forEach((f, i) => {
    if (!f.path.toLowerCase().includes(filter.toLowerCase())) return;
    const [dir, name] = pathParts(f.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups
      .get(dir)
      .push(
        `<button data-goto="${i}" class="ft-file ${current === i ? "current" : ""} ${f.viewed ? "viewed" : ""}">${icon(f)}<span class="ft-name mono">${esc(name)}</span><span class="ft-th">${threadCount(f)}</span><span class="ft-stat mono">${f.stats?.additions == null ? "" : counts(f.stats?.additions, f.stats?.deletions)}</span><span class="ft-check">${f.viewed ? "✓" : ""}</span></button>`,
      );
  });
  return [...groups].map(([dir, rows]) => `<div class="ft-dirname mono">${esc(dir || "/")}</div>${rows.join("")}`).join("");
}
const pass = (c) => /^(success|neutral|skipped)$/i.test(c.result);
export function header(s, focus, head, since, split, wrap, files, checks, open, back) {
  const v = (h) => "v" + (s.iterations.findIndex((it) => it.head === h) + 1),
    choice = (key, label, on, disabled = false) =>
      `<button data-${key} aria-pressed="${on}" ${disabled ? "disabled" : ""}>${label}</button>`,
    url = /^https?:\/\//i.test(s.url) ? s.url : null;
  return `<div class="rv-head">${back}<span class="rv-icon">⎇</span><h1>${esc(s.title)}</h1><span class="chip mono">#${esc(focus.id)}</span>${s.state ? `<span class="badge">${esc(s.state)}</span>` : ""}<span class="grow"></span><div class="seg">${choice("unified", "Unified", !split)}${choice("split", "Split", split)}</div><button class="icon-btn" data-wrap aria-pressed="${wrap}" title="Wrap long lines">↩︎</button>${url ? `<a class="ghost-btn small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open on ${esc(focus.provider === "github" ? "GitHub" : focus.provider)} ↗</a>` : ""}</div>
<div class="rv-sub"><span class="mono rv-branch">${esc(s.branch || head.slice(0, 8))} → ${esc(s.baseBranch || s.iterations.find((it) => it.head === head).base.slice(0, 8))}</span><span class="rv-pill ${checks?.length && checks.every(pass) ? "ok" : ""}">${checks?.length ? `${checks.filter(pass).length}/${checks.length} checks` : checks ? "No checks" : "Checks unavailable"}</span><span class="rv-pill ${open.length ? "needs" : ""}">◌ ${open.length} open</span><span class="mono">${counts(
    files.reduce((n, f) => n + (f.stats?.additions || 0), 0),
    files.reduce((n, f) => n + (f.stats?.deletions || 0), 0),
  )}</span><span class="muted">${files.length} files</span><span class="grow"></span><ol class="iter-dots">${s.iterations.map((it) => `<li data-head="${it.head === head}"><button title="${esc(it.head)}" data-iteration="${esc(it.head)}"><span>${v(it.head)}</span></button></li>`).join("")}</ol><div class="seg range-seg">${choice("all", "All changes " + v(head), !since)}${choice("since", "Since you looked", since, !s.previous || s.iterations.findIndex((it) => it.head === s.previous) >= s.iterations.findIndex((it) => it.head === head))}</div></div>${since ? `<div class="since-note">↻ Showing changes between <b>${v(s.previous)}</b> (you looked here) and <b>${v(head)}</b>. Viewed marks reset for files that changed.</div>` : ""}`;
}
export function context(s, head, checks, open) {
  return `<section class="ctx-section"><h2>Checks <span class="count">${checks?.length ?? "—"}</span></h2>${checks?.map((c) => `<div class="ck-row"><span>${pass(c) ? "✓" : "·"}</span><span>${esc(c.name)}</span><span class="grow"></span><small class="muted mono">${esc(c.result)}</small></div>`).join("") || '<small class="muted">No checks reported</small>'}</section><section class="ctx-section"><h2>Open threads <span class="count">${open.length}</span></h2>${open.map((t) => `<button class="ctx-thread" data-jump="${t.index}" ${t.jumpable ? "" : "disabled"}><span class="th-tag">${esc(t.severity || "◌")}</span><span class="ct-text">${esc(t.comments[0]?.body)}</span><span class="ct-loc mono muted">${esc(t.path)}:${esc(t.line ?? "—")}${t.jumpable ? "" : " · Outside diff"}</span></button>`).join("")}</section><section class="ctx-section"><h2>Iterations</h2><ol class="iter-list">${s.iterations
    .map(
      (it, i) =>
        `<li data-head="${it.head === head}"><span class="il-n mono">v${i + 1}</span><span class="il-t mono">${esc(it.head.slice(0, 8))}${it.head === s.previous ? '<span class="il-seen">you looked here</span>' : ""}</span></li>`,
    )
    .reverse()
    .join("")}</ol></section>`;
}
