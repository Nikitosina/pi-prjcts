// PROTOTYPE — three structurally different "Projects" layouts over sample data.
// Switch with ?variant=claude|cursor|mission, the bottom bar, or ←/→.
// Nothing here calls the host. Actions mutate in-memory state only.
const M = window.MOCK;
const S = {
  project: "p1",
  thread: null,
  tab: { claude: "chat", cursor: "changes", mission: "overview" },
  wtab: "changes",
  dock: "events",
  dockOpen: true,
  level: "all",
  src: "all",
  answered: {},
  drafts: {},
};
const VARIANTS = [
  ["claude", "Project home (Claude-style)"],
  ["cursor", "Agents IDE (Cursor-style)"],
  ["mission", "Mission control"],
];
let variant = new URL(location.href).searchParams.get("variant") ?? "claude";
if (!VARIANTS.some(([k]) => k === variant)) variant = "claude";
// Deep links for screenshots: ?thread=t1&tab=observe
S.thread = new URL(location.href).searchParams.get("thread");
S.tab[variant] = new URL(location.href).searchParams.get("tab") ?? S.tab[variant];

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = d => { if (!d) return "—"; const m = Math.round((M.now - +d) / 60000); return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const clock = d => d ? new Date(d).toTimeString().slice(0, 5) : "—";
const k = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
const project = () => M.projects.find(p => p.id === S.project);
const pending = () => M.decisions.filter(d => !S.answered[d.id]);
const thread = id => M.threads.find(t => t.id === id);
const dot = s => `<span class="dot ${s}"></span>`;
const chip = (s, label = s) => `<span class="chip ${s}">${esc(label)}</span>`;
const totalTokens = () => M.threads.reduce((a, t) => a + t.tokens, 0);
const totalCost = () => M.threads.reduce((a, t) => a + t.cost, 0);
const kindIcon = { instructions: "✎", topic: "◆", library: "▤", evidence: "◉" };

function toast(text) { const n = $("#toast"); n.textContent = text; n.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => n.classList.remove("on"), 2200); }

// Consent dialog: Cancel is default and focused; nothing is prefilled.
function confirmDialog({ title, body, effect, confirm }) {
  const d = $("#dialog");
  d.innerHTML = `<form method="dialog" class="confirm"><h3>${esc(title)}</h3><p>${esc(body)}</p>${effect ? `<div class="effect"><b>Effect</b> ${esc(effect)}</div>` : ""}
    <label class="ack"><input type="checkbox" name="ack"> I inspected the exact target and want this executed</label>
    <div class="row end"><button value="cancel" autofocus>Cancel</button><button value="ok" class="primary" disabled>${esc(confirm)}</button></div></form>`;
  const ok = d.querySelector('[value="ok"]');
  d.querySelector("[name=ack]").onchange = e => ok.disabled = !e.target.checked;
  d.returnValue = "";
  d.showModal();
  return new Promise(r => d.addEventListener("close", () => r(d.returnValue === "ok"), { once: true }));
}

async function act(id, choice) {
  const d = M.decisions.find(x => x.id === id);
  if (d.kind === "approval") {
    const ok = await confirmDialog({ title: d.title, body: d.body, effect: d.effect, confirm: "Approve & execute" });
    if (!ok) return toast("Cancelled. Nothing executed.");
  }
  S.answered[id] = choice;
  toast(d.kind === "question" ? `Answered: ${choice}` : `${choice}: ${d.title}`);
  render();
}

function send(target, text) {
  if (!text.trim()) return;
  const t = thread(target) ?? thread("t0");
  t.messages.push({ who: "you", at: new Date(M.now), text });
  t.messages.push({ who: t.kind === "coordinator" ? "coordinator" : "worker", at: new Date(M.now), text: "(prototype) Received. A real host would reply here." });
  S.drafts[target] = "";
  if (variant === "claude") { S.tab.claude = "chat"; S.thread = t.id === "t0" ? null : t.id; }
  render();
}

// ---------- shared observability widgets (data viz only, not layout) ----------
function gantt({ width = 640, dark = false } = {}) {
  const rows = M.threads, h = 26, span = 190, left = 150, w = width - left - 10;
  const x = m => left + w * (1 - m / span);
  const mins = d => (M.now - +d) / 60000;
  const ticks = [180, 120, 60, 0].map(m => `<line x1="${x(m)}" x2="${x(m)}" y1="0" y2="${rows.length * h + 4}" class="g-grid"/><text x="${x(m)}" y="${rows.length * h + 16}" class="g-tick">${m ? `-${m}m` : "now"}</text>`).join("");
  const bars = rows.map((t, i) => {
    const y = i * h + 4;
    const label = `<text x="0" y="${y + 13}" class="g-label">${esc(t.title.length > 22 ? t.title.slice(0, 21) + "…" : t.title)}</text>`;
    if (!t.started) return label + `<rect x="${x(0) - 30}" y="${y + 3}" width="30" height="12" rx="3" class="g-bar queued"/>`;
    const a = x(mins(t.started)), b = t.ended ? x(mins(t.ended)) : x(0);
    const marks = (t.messages ?? []).flatMap(m => (m.tools ?? []).map(() => m.at)).map(at => `<line x1="${x(mins(at))}" x2="${x(mins(at))}" y1="${y + 3}" y2="${y + 15}" class="g-mark"/>`).join("");
    return label + `<rect x="${a}" y="${y + 3}" width="${Math.max(3, b - a)}" height="12" rx="3" class="g-bar ${t.status}"><title>${esc(t.title)} · ${t.status}</title></rect>${marks}`;
  }).join("");
  return `<svg class="gantt ${dark ? "dark" : ""}" viewBox="0 0 ${width} ${rows.length * h + 22}" width="100%">${ticks}${bars}</svg>`;
}

function usageChart({ width = 520, height = 120 } = {}) {
  const max = Math.max(...M.usage.map(u => u.input + u.output));
  const bw = width / M.usage.length;
  const bars = M.usage.map((u, i) => {
    const hi = (u.input / max) * (height - 16), ho = (u.output / max) * (height - 16);
    return `<rect x="${i * bw + 2}" y="${height - hi - ho}" width="${bw - 4}" height="${hi}" class="u-in"><title>in ${k(u.input)}</title></rect><rect x="${i * bw + 2}" y="${height - ho}" width="${bw - 4}" height="${ho}" class="u-out"><title>out ${k(u.output)}</title></rect>`;
  }).join("");
  return `<svg class="usage" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="none">${bars}</svg><div class="legend"><span class="sw u-in"></span>input <span class="sw u-out"></span>output · 10-min buckets · last 3h</div>`;
}

function spark(values, w = 90, h = 24) {
  const max = Math.max(...values), pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts}"/></svg>`;
}

function eventLog() {
  const rows = M.events.filter(e => (S.level === "all" || e.level === S.level) && (S.src === "all" || e.src === S.src)).slice().reverse();
  const srcs = ["all", "host", ...M.threads.map(t => t.id)];
  return `<div class="ev-filter"><select data-set="level">${["all", "info", "warn", "error"].map(l => `<option ${S.level === l ? "selected" : ""}>${l}</option>`).join("")}</select>
    <select data-set="src">${srcs.map(s => `<option value="${s}" ${S.src === s ? "selected" : ""}>${s === "all" ? "all sources" : s === "host" ? "host" : `${s} · ${esc(thread(s).title)}`}</option>`).join("")}</select>
    <span class="muted">${rows.length} events · live</span></div>
    <table class="events"><tbody>${rows.map(e => `<tr class="${e.level}"><td class="mono">${clock(e.at)}</td><td>${chip(e.level)}</td><td class="mono">${e.src}</td><td class="mono">${esc(e.type)}</td><td>${esc(e.msg)}</td></tr>`).join("")}</tbody></table>`;
}

function healthGrid() {
  const h = M.health;
  return `<div class="health">${[["Durable", h.durable], ["Socket", h.socket], ["Mac awake", h.awake], ["Leases", h.leases], ["Uptime", h.uptime], ["Queue", h.queueDepth], ["Tool p95", h.p95Tool], ["Errors 1h", h.errors1h]].map(([a, b]) => `<div><span class="muted">${a}</span><b>${esc(b)}</b></div>`).join("")}</div>`;
}

function traceTree() {
  const node = t => `<li><details open><summary>${dot(t.status)} <b>${esc(t.title)}</b> <span class="muted">${t.role} · ${t.model} · ${k(t.tokens)} tok · $${t.cost.toFixed(2)}</span></summary>
    <ul>${(t.messages ?? []).flatMap(m => (m.tools ?? []).map(tool => `<li class="mono">${clock(m.at)} <span class="tool">${esc(tool.name)}</span> ${esc(tool.arg)}</li>`)).join("") || '<li class="muted">no tool calls yet</li>'}</ul></details></li>`;
  const [coord, ...workers] = M.threads;
  return `<ul class="trace"><li><details open><summary>${dot(coord.status)} <b>Coordinator</b> <span class="muted">${coord.model} · ${k(coord.tokens)} tok · $${coord.cost.toFixed(2)}</span></summary><ul>${workers.map(node).join("")}</ul></details></li></ul>`;
}

function decisionCard(d, { compact = false } = {}) {
  const done = S.answered[d.id];
  if (done) return `<div class="decision done">✓ ${esc(d.title)} <span class="muted">· ${esc(done)}</span></div>`;
  const actions = d.kind === "question"
    ? d.options.map(o => `<button data-act="${d.id}" data-choice="${esc(o)}">${esc(o)}</button>`).join("")
    : d.kind === "approval"
      ? `<button data-act="${d.id}" data-choice="Rejected">Reject</button><button class="primary" data-act="${d.id}" data-choice="Approved">Review & approve…</button>`
      : `<button data-act="${d.id}" data-choice="Changes requested">Request changes</button><button class="primary" data-act="${d.id}" data-choice="Accepted">Accept result</button>`;
  return `<div class="decision ${d.kind}"><div class="row between"><span>${chip(d.kind)} <b>${esc(d.title)}</b></span><span class="muted">${ago(d.at)} · ${esc(thread(d.thread).title)}</span></div>
    ${compact ? "" : `<p>${esc(d.body)}</p>`}${d.effect && !compact ? `<div class="effect"><b>${esc(d.provider)}</b> ${esc(d.effect)} · head <code>${d.head}</code></div>` : ""}
    ${d.evidence && !compact ? `<div class="row">${d.evidence.map(e => `<span class="file">◉ ${esc(e)}</span>`).join("")}</div>` : ""}
    <div class="row end">${actions}</div></div>`;
}

function transcript(t, { dark = false } = {}) {
  if (!t.messages.length) return `<div class="empty">${dot(t.status)} ${esc(t.blockedBy ?? "No messages yet")}</div>`;
  return t.messages.map(m => `<div class="msg ${m.who}"><div class="who">${m.who === "you" ? "You" : m.who === "coordinator" ? "Coordinator" : esc(t.role)} <span class="muted">${clock(m.at)}</span></div>
    <div class="text">${esc(m.text)}</div>
    ${(m.tools ?? []).map(tool => `<details class="tool-call"><summary><span class="tool">${esc(tool.name)}</span> <span class="mono">${esc(tool.arg)}</span></summary><pre>(sample) output of ${esc(tool.name)} ${esc(tool.arg)}</pre></details>`).join("")}
    ${m.decision ? decisionCard(M.decisions.find(d => d.id === m.decision)) : ""}</div>`).join("");
}

function composer(target, placeholder, extra = "") {
  return `<form class="composer" data-send="${target}"><textarea name="m" placeholder="${esc(placeholder)}" rows="2">${esc(S.drafts[target] ?? "")}</textarea><div class="row between"><span class="muted">${extra}</span><button class="primary">Send ↵</button></div></form>`;
}

function setupStepper() {
  return `<ol class="stepper">${M.setup.map((s, i) => `<li class="${s.done ? "done" : ""}"><span class="n">${s.done ? "✓" : i + 1}</span><div><b>${esc(s.step)}</b><div class="muted">${esc(s.detail)}</div></div><button class="${s.done ? "" : "primary"}" data-toast="Guided form would open (prototype)">${s.done ? "Review" : "Set up"}</button></li>`).join("")}</ol>`;
}

const runStrip = r => Array.from({ length: 14 }, (_, i) => `<i class="${i === 13 && r.last === "skipped" ? "skip" : i % 6 === 5 ? "fail" : "ok"}"></i>`).join("");

function workerPanel(t, tab) {
  if (tab === "evidence") {
    const ev = t.id === "t1" ? M.knowledge.filter(f => f.name === "lint-locales.log") : t.id === "t2" ? M.knowledge.filter(f => f.name.endsWith(".png")) : [];
    return ev.map(f => `<div class="b-ev"><div class="thumb">${f.name.endsWith(".png") ? "🖼" : "≣"}</div><div><b>${esc(f.name)}</b><small class="muted">${f.size} · ${f.hash}</small></div></div>`).join("") || '<div class="empty">No evidence yet.</div>';
  }
  if (!t.diff) return '<div class="empty">No changes from this worker.</div>';
  return `<div class="muted">${t.diff.files} files · <span class="add">+${t.diff.add}</span> <span class="del">−${t.diff.del}</span></div><div class="b-files">${["Locales/uk/layout.json +412", "Locales/uk/dictionary.tsv +48k lines", "Locales/uk/autocorrect.tsv +210", "Locales/index.json +3 −1", "Tests/LocaleTests.swift +38", "…9 more"].map(f => `<div class="mono">M ${esc(f)}</div>`).join("")}</div><pre class="diff">@@ Locales/index.json @@\n   "ru": "Locales/ru",\n<span class="add">+  "uk": "Locales/uk",</span>\n<span class="del">-  "_next": null</span>\n<span class="add">+  "_next": "kk"</span></pre>`;
}

// ---------- Variant A: Claude-style project home ----------
function claude() {
  const p = project(), tab = S.tab.claude, t = thread(S.thread ?? "t0");
  const tabs = [["chat", "Coordinator"], ["knowledge", "Knowledge"], ["activity", "Activity"], ["observe", "Observability"], ["settings", "Settings"]];
  const sidebar = `<aside class="a-side"><div class="a-brand">π <b>Projects</b></div><button class="a-new">＋ New project</button>
    <div class="a-label">Projects</div>${M.projects.filter(x => x.state !== "archived").map(x => `<button class="a-proj ${x.id === S.project ? "on" : ""}" data-project="${x.id}"><span class="emoji" style="background:${x.color}22">${x.emoji}</span><span class="grow">${esc(x.name)}<small>${x.state} · ${ago(new Date(M.now - x.updated * 60000))}</small></span>${x.needs ? `<span class="badge">${x.needs}</span>` : ""}</button>`).join("")}
    <div class="a-label">Archived</div>${M.projects.filter(x => x.state === "archived").map(x => `<button class="a-proj dim" data-project="${x.id}"><span class="emoji">${x.emoji}</span><span class="grow">${esc(x.name)}</span></button>`).join("")}
    <div class="a-foot">${dot("ok")} Host connected · Mac awake</div></aside>`;
  const header = `<header class="a-head"><div class="row"><span class="emoji big" style="background:${p.color}22">${p.emoji}</span><div><h1>${esc(p.name)}</h1><p class="muted">${esc(p.description)}</p></div></div>
    <div class="row">${chip(p.state)}<button>${p.state === "paused" ? "▶ Resume" : "❚❚ Pause"}</button><button class="ghost">⋯</button></div></header>
    <nav class="a-tabs">${tabs.map(([key, label]) => `<button data-tab="claude:${key}" class="${tab === key ? "on" : ""}">${label}${key === "chat" && pending().length ? ` <span class="badge">${pending().length}</span>` : ""}</button>`).join("")}</nav>`;
  let body;
  if (tab === "chat" && t.kind === "worker") {
    // Worker chat: transcript + steer on the left, B's Changes/Evidence panel on the right.
    const wt = [["changes", "Changes"], ["evidence", "Evidence"]];
    body = `<div class="a-grid"><div class="a-convo"><button class="ghost" data-thread="">← Coordinator</button><div class="row between"><h2>${dot(t.status)} ${esc(t.title)}</h2><span class="row">${chip(t.status)}<span class="muted">${t.role} · ${t.model}</span>${t.status === "running" ? '<button class="small">Stop</button>' : ""}</span></div>
      <div class="a-transcript">${pending().filter(d => d.thread === t.id).map(d => decisionCard(d)).join("")}${transcript(t)}</div>${composer(t.id, "Steer this worker (confirmation required before delivery)…")}</div>
      <aside class="a-panel"><div class="card a-insp"><nav class="a-subtabs">${wt.map(([key, label]) => `<button data-wtab="${key}" class="${S.wtab === key ? "on" : ""}">${label}</button>`).join("")}</nav>${workerPanel(t, S.wtab)}</div></aside></div>`;
  } else if (tab === "chat") {
    // Default view: coordinator conversation; needs-you, workers and knowledge in the side column.
    const workers = M.threads.filter(x => x.kind === "worker");
    body = `<div class="a-grid"><div class="a-convo"><div class="row between"><h2>Coordinator</h2><span class="muted">${t.model} · plans, spawns and steers workers</span></div>
      <div class="a-transcript">${transcript(t)}</div>${composer("t0", `Message the coordinator about ${p.name}…`, "Enter sends · / commands · @ topics")}</div>
      <aside class="a-panel">${pending().length ? `<div class="card"><div class="row between"><b>Needs you</b><span class="badge">${pending().length}</span></div>${pending().map(d => decisionCard(d, { compact: true })).join("")}</div>` : ""}
        <div class="card"><b>Workers</b>${workers.map(x => `<button class="a-row" data-thread="${x.id}">${dot(x.status)}<span class="grow"><b>${esc(x.title)}</b><small>${x.role} · ${esc(x.blockedBy ?? x.status)}${x.diff ? ` · +${x.diff.add} −${x.diff.del}` : ""}</small></span>${x.status === "running" ? `<span class="bar"><i style="width:${x.progress * 100}%"></i></span>` : `<span class="muted">${ago(x.ended ?? x.messages.at(-1)?.at)}</span>`}</button>`).join("")}
        <div class="stats"><div><b>$${totalCost().toFixed(2)}</b><small>today</small></div><div><b>${k(totalTokens())}</b><small>tokens</small></div><div><b>${workers.filter(x => x.status === "queued").length}</b><small>queued</small></div></div></div>
        <div class="card"><div class="row between"><b>Project knowledge</b><button class="ghost small" data-tab="claude:knowledge">Open</button></div>
        <div class="instructions"><small class="muted">Instructions</small><p>${esc(p.instructions || "Add instructions…")}</p></div>
        <div class="cap"><i style="width:23%"></i></div><small class="muted">23% of project context used</small>
        ${M.knowledge.slice(1, 6).map(f => `<div class="file-row"><span>${kindIcon[f.kind]}</span><span class="grow">${esc(f.name)}</span><small class="muted">${f.size}</small></div>`).join("")}</div></aside></div>`;
  } else if (tab === "knowledge") {
    body = `<div class="a-know"><div class="card instructions-card"><div class="row between"><b>Instructions</b><button class="small">Edit</button></div><p>${esc(p.instructions)}</p><small class="muted">Revision a81c · edits are compare-and-swap</small></div>
      ${["topic", "library", "evidence"].map(kind => `<h3 class="a-h">${{ topic: "Managed topics", library: "Library (hash-pinned)", evidence: "Evidence" }[kind]}</h3><div class="tiles">${M.knowledge.filter(f => f.kind === kind).map(f => `<div class="tile"><div class="ic">${kindIcon[kind]}</div><b>${esc(f.name)}</b><small class="muted">${f.size} · ${ago(f.updated)} ${f.hash ? `· ${f.hash}` : f.rev ? `· rev ${f.rev}` : ""}</small></div>`).join("")}<button class="tile add">＋ ${kind === "library" ? "Paste reference" : kind === "topic" ? "New topic" : "—"}</button></div>`).join("")}</div>`;
  } else if (tab === "activity") {
    body = `<div class="a-activity">${M.events.slice().reverse().map(e => `<div class="act ${e.level}"><span class="mono muted">${clock(e.at)}</span>${dot(e.level === "error" ? "error" : e.level === "warn" ? "queued" : "done")}<span><b>${esc(e.type)}</b> — ${esc(e.msg)} <span class="muted">${e.src === "host" ? "host" : esc(thread(e.src).title)}</span></span></div>`).join("")}</div>`;
  } else if (tab === "observe") {
    body = `<div class="a-observe"><div class="kpis">${[["Spend today", `$${totalCost().toFixed(2)}`, M.usage.map(u => u.input)], ["Tokens", k(totalTokens()), M.usage.map(u => u.output)], ["Active workers", "1 / 1 writer", [1, 1, 2, 1, 1, 2, 2, 1]], ["Errors (1h)", "1", [0, 0, 1, 0, 0, 0, 1, 0]]].map(([a, b, s]) => `<div class="card kpi"><small class="muted">${a}</small><b>${b}</b>${spark(s)}</div>`).join("")}</div>
      <div class="card"><b>Worker timeline</b>${gantt({ width: 1060 })}</div><div class="card"><b>Trace</b> <small class="muted">coordinator → workers → tool calls</small>${traceTree()}</div><div class="two"><div class="card"><b>Token usage</b>${usageChart()}</div><div class="card"><b>Host health</b>${healthGrid()}</div></div><div class="card"><b>Event log</b>${eventLog()}</div></div>`;
  } else {
    body = `<div class="a-settings"><div class="card"><b>Owner setup</b><p class="muted">Guided replacement for the JSON payload editors. Each step re-reads the current revision before asking for consent.</p>${setupStepper()}</div>
      <div class="card"><b>Models & roles</b>${["coordinator", "writer", "verifier"].map(r => `<div class="file-row"><span class="grow">${r}</span><select><option>${r === "coordinator" ? "claude-opus-5-5" : "claude-sonnet-5-5"}</option></select></div>`).join("")}<div class="file-row"><span class="grow">Max concurrent writers</span><input type="number" value="1" style="width:70px"></div></div>
      <div class="card"><b>Automations</b>${M.routines.map(r => `<div class="file-row"><label class="switch"><input type="checkbox" ${r.enabled ? "checked" : ""}><i></i></label><span class="grow">${esc(r.name)} <small class="muted mono">${esc(r.cron)}</small></span><span class="runs" title="last 14 runs">${runStrip(r)}</span><small class="muted">next ${esc(r.next)}</small></div>`).join("")}<small class="muted">Toggling asks for confirmation.</small></div>
      <div class="card danger"><b>Lifecycle</b><div class="row"><button>Archive project</button><button class="danger">Delete…</button></div></div></div>`;
  }
  return `<div class="va">${sidebar}<main class="a-main">${header}<div class="a-body">${body}</div></main></div>`;
}

// ---------- Variant B: Cursor-style agents IDE ----------
function cursor() {
  const p = project(), sel = thread(S.thread ?? "t2"), tab = S.tab.cursor;
  const needs = t => pending().some(d => d.thread === t.id);
  const groups = [["Needs you", M.threads.filter(needs)], ...[["Running", "running"], ["Queued", "queued"], ["Done", "done"]].map(([g, s]) => [g, M.threads.filter(t => t.status === s && !needs(t))])];
  const agentRow = t => `<button class="b-agent ${t.id === sel.id ? "on" : ""}" data-thread="${t.id}">${dot(t.status)}<span class="grow"><span class="t">${esc(t.title)}</span><small>${t.kind === "coordinator" ? "coordinator" : t.role} · ${t.model.replace("claude-", "")}${t.diff ? ` · <span class="add">+${t.diff.add}</span> <span class="del">−${t.diff.del}</span>` : ""}</small>${t.status === "running" && t.progress ? `<span class="bar"><i style="width:${t.progress * 100}%"></i></span>` : ""}</span><small>${ago(t.messages.at(-1)?.at ?? t.started)}</small></button>`;
  const left = `<aside class="b-left"><div class="b-proj"><select data-set="project">${M.projects.map(x => `<option value="${x.id}" ${x.id === S.project ? "selected" : ""}>${x.emoji} ${esc(x.name)}</option>`).join("")}</select></div>
    <button class="b-newagent">＋ New task for coordinator <kbd>⌘N</kbd></button>
    ${groups.map(([g, list]) => list.length ? `<div class="b-group">${g} <span>${list.length}</span></div>${list.map(agentRow).join("")}` : "").join("")}
    <div class="b-foot">${dot("ok")} durable · ${M.health.leases} leases · ${p.repo}</div></aside>`;
  const decisionsHere = pending().filter(d => d.thread === sel.id);
  const center = `<section class="b-center"><header class="b-head"><div>${dot(sel.status)} <b>${esc(sel.title)}</b> <span class="muted">${sel.role} · ${sel.model} · ${k(sel.tokens)} tok · $${sel.cost.toFixed(2)}</span></div>
    <div class="row">${sel.status === "running" ? '<button class="small">❚❚ Pause</button><button class="small danger">■ Stop</button>' : ""}${sel.diff ? '<button class="small">Open diff</button>' : ""}</div></header>
    <div class="b-transcript">${decisionsHere.map(d => decisionCard(d)).join("")}${transcript(sel, { dark: true })}</div>
    ${composer(sel.id, sel.kind === "coordinator" ? "Message coordinator…  (@ to mention a topic, / for commands)" : "Steer worker…  (confirmation required before delivery)", `${sel.kind === "coordinator" ? "Coordinator" : "Steer"} · ${sel.model}`)}</section>`;
  const tabs = [["changes", "Changes"], ["evidence", "Evidence"], ["approvals", `Approvals${pending().length ? ` ${pending().length}` : ""}`], ["context", "Context"]];
  let insp;
  if (tab === "changes") insp = sel.diff ? `<div class="b-files">${["Locales/uk/layout.json +412", "Locales/uk/dictionary.tsv +48k lines", "Locales/uk/autocorrect.tsv +210", "Locales/index.json +3 −1", "Tests/LocaleTests.swift +38", "…9 more"].map(f => `<div class="mono">M ${esc(f)}</div>`).join("")}</div><pre class="diff">@@ Locales/index.json @@\n   "ru": "Locales/ru",\n<span class="add">+  "uk": "Locales/uk",</span>\n<span class="del">-  "_next": null</span>\n<span class="add">+  "_next": "kk"</span></pre>` : `<div class="empty">No changes from this agent.</div>`;
  else if (tab === "evidence") insp = M.knowledge.filter(f => f.kind === "evidence").map(f => `<div class="b-ev"><div class="thumb">${f.name.endsWith(".png") ? "🖼" : "≣"}</div><div><b>${esc(f.name)}</b><small class="muted">${f.size} · ${f.hash}</small></div></div>`).join("");
  else if (tab === "approvals") insp = pending().map(d => decisionCard(d, { compact: true })).join("") || '<div class="empty">Nothing pending.</div>';
  else insp = `<div class="b-ctx"><b>Instructions</b><p class="muted">${esc(p.instructions)}</p><b>Attached knowledge</b>${M.knowledge.filter(f => f.kind !== "evidence").map(f => `<div class="mono">${kindIcon[f.kind]} ${esc(f.name)}</div>`).join("")}<b>Scope</b><div class="mono">${esc(p.workspace)} · write</div><div class="mono">${esc(p.repo)} · draft PR only</div></div>`;
  const right = `<aside class="b-right"><nav class="b-tabs">${tabs.map(([key, label]) => `<button data-tab="cursor:${key}" class="${tab === key ? "on" : ""}">${label}</button>`).join("")}</nav><div class="b-insp">${insp}</div></aside>`;
  const docks = [["events", "Events"], ["timeline", "Timeline"], ["trace", "Trace"], ["usage", "Usage"], ["health", "Health"]];
  const dockBody = { events: eventLog, timeline: () => gantt({ width: 900, dark: true }), trace: traceTree, usage: () => `<div class="two">${usageChart({ width: 600 })}<div>${M.threads.map(t => `<div class="file-row"><span class="grow">${esc(t.title)}</span><span class="mono">${k(t.tokens)}</span><span class="mono">$${t.cost.toFixed(2)}</span></div>`).join("")}</div></div>`, health: healthGrid }[S.dock];
  const dock = `<section class="b-dock ${S.dockOpen ? "" : "closed"}"><nav>${docks.map(([key, label]) => `<button data-dock="${key}" class="${S.dock === key ? "on" : ""}">${label}${key === "events" ? ` <span class="err">${M.events.filter(e => e.level === "error").length}</span>` : ""}</button>`).join("")}<span class="grow"></span><button data-dock-toggle>${S.dockOpen ? "▾" : "▴"}</button></nav>${S.dockOpen ? `<div class="b-dockbody">${dockBody()}</div>` : ""}</section>`;
  return `<div class="vb">${left}<div class="b-mid"><div class="b-split">${center}${right}</div>${dock}</div></div>`;
}

// ---------- Variant C: mission control ----------
function mission() {
  const p = project(), tab = S.tab.mission;
  const tabs = [["overview", "Overview"], ["threads", "Threads"], ["knowledge", "Knowledge"], ["observe", "Observability"], ["automations", "Automations"], ["setup", "Setup"]];
  const top = `<header class="c-top"><div class="row"><b class="c-logo">π</b><select data-set="project">${M.projects.map(x => `<option value="${x.id}" ${x.id === S.project ? "selected" : ""}>${x.emoji} ${esc(x.name)}</option>`).join("")}</select>${chip(p.state)}<span class="muted mono">${esc(p.repo)}</span></div>
    <nav class="c-tabs">${tabs.map(([key, label]) => `<button data-tab="mission:${key}" class="${tab === key ? "on" : ""}">${label}</button>`).join("")}</nav>
    <div class="row"><span class="c-live">${dot("running")} live</span><button>❚❚ Pause project</button></div></header>`;
  let body;
  if (tab === "overview") {
    body = `<div class="c-kpis">${[["Needs you", pending().length, "warn"], ["Running", M.threads.filter(t => t.status === "running").length, ""], ["Queued", M.threads.filter(t => t.status === "queued").length, ""], ["Spend today", `$${totalCost().toFixed(2)}`, ""], ["Tokens", k(totalTokens()), ""], ["Errors 1h", M.health.errors1h, "err"]].map(([a, b, c]) => `<div class="c-kpi ${c}"><small>${a}</small><b>${b}</b></div>`).join("")}</div>
      <div class="c-grid"><section class="c-card span2"><h3>Needs you</h3>${pending().map(d => decisionCard(d)).join("") || '<div class="empty">All clear.</div>'}</section>
      <section class="c-card"><h3>Ask the coordinator</h3>${composer("t0", "New task, question, or plan change…")}<h3>Latest from coordinator</h3><p class="quote">${esc(thread("t0").messages.at(-1).text)}</p></section>
      <section class="c-card span2"><h3>Worker timeline <small class="muted">last 3h · ticks = tool calls</small></h3>${gantt({ width: 760 })}</section>
      <section class="c-card"><h3>Pipeline</h3><div class="pipeline">${[["Plan", "done"], ["uk writer", "done"], ["uk E2E", "running"], ["kk/uz", "queued"], ["PR", "blocked"]].map(([a, s]) => `<div class="stage ${s}">${dot(s)} ${a}</div>`).join('<span class="arrow">→</span>')}</div><h3>Outcomes</h3>${M.receipts.map(r => `<div class="file-row">${chip(r.kind)}<span class="grow">${esc(r.ref)}</span><small class="muted">${esc(r.state)} · CI ${esc(r.ci)}</small></div>`).join("")}</section>
      <section class="c-card span2"><h3>Token usage</h3>${usageChart({ width: 760 })}</section><section class="c-card"><h3>Health</h3>${healthGrid()}</section></div>`;
  } else if (tab === "threads") {
    const sel = thread(S.thread ?? "t0");
    body = `<div class="c-threads"><table class="c-table"><thead><tr><th></th><th>Thread</th><th>Role</th><th>Model</th><th>Progress</th><th>Tokens</th><th>Cost</th><th>Last</th></tr></thead><tbody>${M.threads.map(t => `<tr data-thread="${t.id}" class="${t.id === sel.id ? "on" : ""}"><td>${dot(t.status)}</td><td><b>${esc(t.title)}</b>${t.blockedBy ? `<small class="muted"> · ${esc(t.blockedBy)}</small>` : ""}</td><td>${t.role}</td><td class="mono">${t.model.replace("claude-", "")}</td><td><span class="bar"><i style="width:${(t.progress ?? (t.status === "running" ? 0.5 : 0)) * 100}%"></i></span></td><td class="mono">${k(t.tokens)}</td><td class="mono">$${t.cost.toFixed(2)}</td><td>${ago(t.messages.at(-1)?.at)}</td></tr>`).join("")}</tbody></table>
      <div class="c-detail"><div class="row between"><h3>${esc(sel.title)}</h3>${chip(sel.status)}</div><div class="c-transcript">${transcript(sel)}</div>${composer(sel.id, sel.kind === "coordinator" ? "Message coordinator…" : "Steer worker…")}</div></div>`;
  } else if (tab === "knowledge") {
    body = `<table class="c-table"><thead><tr><th>Kind</th><th>Name</th><th>Size</th><th>Identity</th><th>Updated</th><th></th></tr></thead><tbody>${M.knowledge.map(f => `<tr><td>${chip(f.kind)}</td><td><b>${esc(f.name)}</b></td><td>${f.size}</td><td class="mono">${esc(f.hash ?? (f.rev ? `rev ${f.rev}` : "—"))}</td><td>${ago(f.updated)}</td><td><button class="small">${f.kind === "topic" || f.kind === "instructions" ? "Edit" : "View"}</button></td></tr>`).join("")}</tbody></table>`;
  } else if (tab === "observe") {
    body = `<div class="c-grid"><section class="c-card span2"><h3>Trace</h3>${traceTree()}</section><section class="c-card"><h3>Cost by thread</h3>${M.threads.filter(t => t.cost).map(t => `<div class="hbar"><span>${esc(t.title)}</span><i style="width:${(t.cost / totalCost()) * 100}%"></i><b>$${t.cost.toFixed(2)}</b></div>`).join("")}<h3>Health</h3>${healthGrid()}</section>
      <section class="c-card span3"><h3>Events</h3>${eventLog()}</section></div>`;
  } else if (tab === "automations") {
    body = `<div class="c-grid">${M.routines.map(r => `<section class="c-card"><div class="row between"><h3>${esc(r.name)}</h3><label class="switch"><input type="checkbox" ${r.enabled ? "checked" : ""}><i></i></label></div><div class="mono muted">${esc(r.cron)}</div><p>Next: <b>${esc(r.next)}</b> · last: ${esc(r.last)}</p><div class="runs">${runStrip(r)}</div><small class="muted">Toggling asks for confirmation.</small></section>`).join("")}<section class="c-card add">＋ New routine</section></div>`;
  } else {
    body = `<div class="c-grid"><section class="c-card span2"><h3>Owner setup</h3>${setupStepper()}</section><section class="c-card"><h3>Why steps matter</h3><p class="muted">Workers only get workspace, GitHub target, command profile and skills you grant here. Missing grants stay visible blockers; nothing is inferred.</p></section></div>`;
  }
  return `<div class="vc">${top}<main class="c-body">${body}</main></div>`;
}

// ---------- shell ----------
function render() {
  $("#app").innerHTML = { claude, cursor, mission }[variant]();
  const i = VARIANTS.findIndex(([key]) => key === variant);
  $("#switcher").innerHTML = `<button data-cycle="-1">←</button><span>${String.fromCharCode(65 + i)} — ${VARIANTS[i][1]}</span><button data-cycle="1">→</button>`;
  document.body.dataset.variant = variant;
}

function setVariant(next) {
  variant = next;
  const url = new URL(location.href); url.searchParams.set("variant", next); history.replaceState(null, "", url);
  S.thread = null; render();
}

document.addEventListener("click", e => {
  const el = e.target.closest("[data-cycle],[data-project],[data-thread],[data-tab],[data-act],[data-dock],[data-dock-toggle],[data-toast],[data-wtab]");
  if (!el) return;
  const ds = el.dataset;
  if (ds.cycle) { const i = VARIANTS.findIndex(([key]) => key === variant); return setVariant(VARIANTS[(i + +ds.cycle + VARIANTS.length) % VARIANTS.length][0]); }
  if (ds.project) { S.project = ds.project; S.thread = null; }
  else if (ds.thread !== undefined) S.thread = ds.thread || null;
  else if (ds.tab) { const [v, key] = ds.tab.split(":"); S.tab[v] = key; if (v === "claude") S.thread = null; }
  if (ds.thread !== undefined && variant === "claude") S.tab.claude = "chat";
  else if (ds.act) return void act(ds.act, ds.choice);
  else if (ds.dock) { S.dock = ds.dock; S.dockOpen = true; }
  else if ("dockToggle" in ds) S.dockOpen = !S.dockOpen;
  else if (ds.toast) return toast(ds.toast);
  else if (ds.wtab) S.wtab = ds.wtab;
  render();
});
document.addEventListener("change", e => { const key = e.target.dataset.set; if (!key) return; S[key] = e.target.value; if (key === "project") S.thread = null; render(); });
document.addEventListener("input", e => { const f = e.target.closest("[data-send]"); if (f) S.drafts[f.dataset.send] = e.target.value; });
document.addEventListener("submit", e => { const f = e.target.closest("[data-send]"); if (!f) return; e.preventDefault(); send(f.dataset.send, f.m.value); });
document.addEventListener("keydown", e => {
  if (e.target.closest("input,textarea,select,[contenteditable]") || $("#dialog").open) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") { const i = VARIANTS.findIndex(([key]) => key === variant); setVariant(VARIANTS[(i + (e.key === "ArrowRight" ? 1 : -1) + VARIANTS.length) % VARIANTS.length][0]); }
});
render();
