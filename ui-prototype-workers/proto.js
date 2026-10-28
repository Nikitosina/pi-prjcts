// PROTOTYPE — throwaway. Three variants of the coordinator Workers card, switchable via ?variant=A|B|C.
// Question: how to tell worker conversations apart from their running, queued and settled tasks, without repeating
// one conversation's live context reading on every task row. Fixture is anonymized and in memory; reload resets it.
"use strict";
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// One context reading per conversation (thread), never per task.
const conversations = [
  { id: "c1", key: "W1", role: "worker", name: "Checkout refactor", thread: "3f2a91c0", context: { tokens: 134000, window: 200000 }, parent: null },
  { id: "c2", key: "W2", role: "worker", name: "Search filters", thread: "8b17e4d2", context: { tokens: 62000, window: 200000 }, parent: null },
  { id: "c3", key: "S1", role: "scout", name: "Chart library research", thread: "c40de733", context: { tokens: 176000, window: 200000 }, parent: null },
  { id: "c4", key: "V1", role: "verifier", name: "Verify checkout refactor", thread: "e9a05b18", context: { tokens: 21000, window: 200000 }, parent: "c1" },
];
// All names and tasks are fictional. Raw text is what the current card clips to a title; title is the readable name a real version would need.
const tasks = [
  { conv: "c1", status: "running", title: "Refactor the checkout form", raw: "## Goal Refactor the checkout…", startedMin: 12 },
  { conv: "c1", status: "queued", order: 1, title: "Add address validation", raw: "## Goal Add address validation…" },
  { conv: "c1", status: "queued", order: 2, title: "Update the receipt email", raw: "## Goal Update the receipt…" },
  { conv: "c1", status: "blocked", title: "Fix the price rounding bug", raw: "## Goal Fix the price rounding…", reason: "Verifier could not reproduce the fix", endedMin: 41 },
  { conv: "c1", status: "blocked", title: "Write the release notes", raw: "## Goal Write the release notes…", reason: "Waiting for an owner decision", endedMin: 95 },
  { conv: "c4", status: "running", title: "Verify the checkout refactor build", raw: "Fresh verification of …", startedMin: 3 },
  { conv: "c2", status: "running", title: "Add a date filter to search", raw: "## Goal Add a date filter…", startedMin: 26 },
  { conv: "c2", status: "completed", title: "Sketch the filter panel", raw: "## Goal Sketch…", endedMin: 64 },
  { conv: "c3", status: "completed", title: "Compare chart libraries", raw: "## Goal Compare…", endedMin: 8 },
];
const variants = [
  { key: "A", name: "Conversation tree", legend: "Each conversation is a node with its one context ring. Under it: Now, Up next (numbered queue), History (collapsed). Child verifier is its own nested node with its own ring." },
  { key: "B", name: "Queue lanes", legend: "Tasks sit in lanes Running · Up next · Needs attention · Done. A colored conversation chip names the owner. Context lives only in the conversation strip at the top." },
  { key: "C", name: "Conversation summary + timeline", legend: "One line per conversation: context, current task, counts. Expand a line for its task timeline: history ↑ · now · queue ↓." },
];
// In-memory interaction state; printed in the state panel after every change.
const state = { variant: null, open: new Set(["c1"]), lastAction: "load" };

const of = conv => tasks.filter(task => task.conv === conv);
const conv = id => conversations.find(item => item.id === id);
const percent = c => Math.round(c.context.tokens / c.context.window * 100);
function ring(c, size = 14) {
  const p = percent(c), level = p >= 90 ? "high" : p >= 70 ? "mid" : "low", r = 6, len = 2 * Math.PI * r;
  return `<span class="ctx-ring" data-level="${level}" title="${esc(c.key)} context: ${Math.round(c.context.tokens / 1000)}k of ${c.context.window / 1000}k tokens"><svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true"><circle cx="8" cy="8" r="${r}" class="track"/><circle cx="8" cy="8" r="${r}" class="fill" stroke-dasharray="${(len * p / 100).toFixed(1)} ${len.toFixed(1)}" transform="rotate(-90 8 8)"/></svg>${p}%</span>`;
}
const ident = c => `<span class="pw-id" data-conv="${c.id}">${esc(c.key)}</span>`;
const when = t => t.status === "running" ? `running ${t.startedMin}m` : t.status === "queued" ? `queued #${t.order}` : `${t.status} ${t.endedMin}m ago`;
const counts = c => { const list = of(c.id), n = s => list.filter(t => t.status === s).length; return [n("running") && `${n("running")} running`, n("queued") && `${n("queued")} queued`, n("blocked") && `${n("blocked")} blocked`, n("completed") && `${n("completed")} done`].filter(Boolean).join(" · "); };
const taskRow = t => `<div class="pw-task ${t.status}" title="Raw task text: ${esc(t.raw)}"><span class="pw-mark"></span><span class="pw-title">${esc(t.title)}</span><small>${esc(when(t))}</small>${t.reason ? `<small class="pw-reason">${esc(t.reason)}</small>` : ""}</div>`;

// A: tree. Conversation node → Now / Up next / History; child conversations nest inside their parent node.
function variantA() {
  const node = c => {
    const list = of(c.id), now = list.filter(t => t.status === "running"), next = list.filter(t => t.status === "queued").sort((a, b) => a.order - b.order), past = list.filter(t => t.status === "blocked" || t.status === "completed");
    const kids = conversations.filter(k => k.parent === c.id), open = state.open.has(c.id);
    return `<div class="pa-node${c.parent ? " child" : ""}"><div class="pa-head">${ident(c)}<span class="pa-name"><b>${esc(c.name)}</b><small>${esc(c.role)} · thread ${esc(c.thread)}</small></span>${ring(c, 16)}</div>
      ${now.length ? `<div class="pa-group"><span class="pa-label">Now</span>${now.map(taskRow).join("")}</div>` : `<div class="pa-group"><span class="pa-label">Now</span><small class="note">Idle · conversation kept for follow-ups</small></div>`}
      ${next.length ? `<div class="pa-group queue"><span class="pa-label">Up next · ${next.length}</span>${next.map(taskRow).join("")}</div>` : ""}
      ${past.length ? `<button class="pa-hist ghost small" data-toggle="${c.id}">${open ? "▾" : "▸"} History · ${past.length}${past.some(t => t.status === "blocked") ? ` · ${past.filter(t => t.status === "blocked").length} blocked` : ""}</button>${open ? `<div class="pa-group past">${past.map(taskRow).join("")}</div>` : ""}` : ""}
      ${kids.map(node).join("")}</div>`;
  };
  return conversations.filter(c => !c.parent).map(node).join("");
}
// B: lanes. Task-first; conversation identity is a chip, context is in the strip only.
function variantB() {
  const strip = `<div class="pb-strip">${conversations.map(c => `<span class="pb-conv">${ident(c)}<span>${esc(c.parent ? `${c.role} of ${conv(c.parent).key}` : c.role)}</span>${ring(c)}</span>`).join("")}</div>`;
  const lane = (label, list, cls) => list.length ? `<div class="pb-lane ${cls}"><div class="pb-lane-head">${label}<span class="count-soft">${list.length}</span></div>${list.map(t => `<div class="pb-card ${t.status}">${ident(conv(t.conv))}<span class="pw-title">${esc(t.title)}</span><small>${esc(when(t))}${conv(t.conv).parent ? ` · checks ${conv(conv(t.conv).parent).key}` : ""}</small>${t.reason ? `<small class="pw-reason">${esc(t.reason)}</small>` : ""}</div>`).join("")}</div>` : "";
  return strip + lane("Running", tasks.filter(t => t.status === "running"), "running") + lane("Up next", tasks.filter(t => t.status === "queued").sort((a, b) => a.order - b.order), "queued") + lane("Needs attention", tasks.filter(t => t.status === "blocked"), "blocked") + lane("Done", tasks.filter(t => t.status === "completed"), "completed");
}
// C: one summary line per conversation; expanding shows a vertical timeline, oldest at top, queue at bottom.
function variantC() {
  return conversations.map(c => {
    const list = of(c.id), current = list.find(t => t.status === "running"), open = state.open.has(c.id);
    const past = list.filter(t => t.status === "blocked" || t.status === "completed").sort((a, b) => b.endedMin - a.endedMin), next = list.filter(t => t.status === "queued").sort((a, b) => a.order - b.order);
    return `<div class="pc-conv${c.parent ? " child" : ""}"><button class="pc-line" data-toggle="${c.id}" aria-expanded="${open}"><span class="pc-caret">${open ? "▾" : "▸"}</span>${ident(c)}<span class="pc-main"><b>${c.parent ? `↳ ${esc(c.role)} of ${esc(conv(c.parent).key)}` : esc(c.name)}</b><small>${current ? `▶ ${esc(current.title)}` : "idle"}</small><small class="pc-counts">${esc(counts(c))}</small></span>${ring(c, 16)}</button>
      ${open ? `<ol class="pc-timeline">${past.map(t => `<li class="${t.status}">${taskRow(t)}</li>`).join("")}${current ? `<li class="running now">${taskRow(current)}</li>` : ""}${next.map(t => `<li class="queued">${taskRow(t)}</li>`).join("")}</ol>` : ""}</div>`;
  }).join("");
}

function render() {
  const v = variants.find(item => item.key === state.variant);
  const totals = `${conversations.length} conversations · ${tasks.length} tasks (${tasks.filter(t => t.status === "running").length} running, ${tasks.filter(t => t.status === "queued").length} queued, ${tasks.filter(t => t.status === "blocked").length} blocked, ${tasks.filter(t => t.status === "completed").length} done) · 1 verifier child`;
  $("#activity").innerHTML = `<div class="pw-variant pw-${v.key}">${{ A: variantA, B: variantB, C: variantC }[v.key]()}</div>`;
  $("#proto-state").innerHTML = `<b>Throwaway prototype · ${v.key} — ${esc(v.name)}</b><p>${esc(v.legend)}</p><p class="mono">fixture: ${esc(totals)}<br>expanded: ${esc([...state.open].map(id => conv(id).key).join(", ") || "none")} · last action: ${esc(state.lastAction)}</p><p class="pw-legend"><span class="pw-task running"><span class="pw-mark"></span>running</span><span class="pw-task queued"><span class="pw-mark"></span>queued (not started)</span><span class="pw-task blocked"><span class="pw-mark"></span>blocked</span><span class="pw-task completed"><span class="pw-mark"></span>done</span></p>`;
  $("#proto-bar .label").textContent = `${v.key} — ${v.name}`;
}
function setVariant(key, action) {
  state.variant = variants.some(v => v.key === key) ? key : "A";
  state.lastAction = action;
  const url = new URL(location.href); url.searchParams.set("variant", state.variant); history.replaceState(null, "", url);
  render();
}
const step = (delta, action) => setVariant(variants[(variants.findIndex(v => v.key === state.variant) + delta + variants.length) % variants.length].key, action);

// Static stand-in for the real app chrome around the Workers card (app.js is not loaded in this preview).
function chrome() {
  document.querySelector('[data-tab="coordinator"]').classList.add("on");
  $("#title").textContent = "Demo project";
  $("#avatar").textContent = "DP";
  $("#project-list").innerHTML = `<button class="proj on"><span class="avatar sm">DP</span><span class="grow side-text">Demo project</span></button><button class="proj"><span class="avatar sm">SA</span><span class="grow side-text">Sample app</span></button>`;
  $("#connection").textContent = "Prototype · no host";
  $("#chat-bar").innerHTML = `<nav class="chat-list"><button class="chat-tab on ghost small">Main</button></nav>`;
  $("#messages").innerHTML = `<article class="msg you"><div class="who">You</div><div class="text">Refactor the checkout flow and get it verified.</div></article><article class="msg them"><div class="who">Coordinator</div><div class="text">W1 is refactoring checkout with two follow-ups queued behind it. V1 is verifying its build. W2 is adding search filters.</div></article>`;
  $("#queue").innerHTML = `<p class="note">Nothing needs you.</p>`;
  $("#notes").innerHTML = `<p class="note">3 documents</p>`;
  $("#outcomes").innerHTML = `<p class="note">S1 finished: Compare chart libraries</p>`;
  document.querySelectorAll("#compose textarea, #compose button").forEach(node => { if (node.tagName === "BUTTON") node.disabled = true; });
  const panel = document.createElement("div"); panel.id = "proto-state"; panel.className = "card proto-state";
  $("#workers-card").after(panel);
  $("#workers-card .row b").insertAdjacentHTML("afterend", '<span class="proto-tag">Throwaway prototype</span>');
  const bar = document.createElement("nav"); bar.id = "proto-bar"; bar.setAttribute("aria-label", "Prototype variants");
  bar.innerHTML = `<button data-step="-1" aria-label="Previous variant">←</button><span class="label" aria-live="polite"></span><button data-step="1" aria-label="Next variant">→</button>`;
  document.body.append(bar);
}

chrome();
document.addEventListener("click", event => {
  const stepper = event.target.closest("#proto-bar [data-step]");
  if (stepper) { step(Number(stepper.dataset.step), `click ${stepper.dataset.step === "1" ? "→" : "←"}`); return; }
  const toggle = event.target.closest("[data-toggle]");
  if (toggle) { const id = toggle.dataset.toggle; state.open.has(id) ? state.open.delete(id) : state.open.add(id); state.lastAction = `${state.open.has(id) ? "expand" : "collapse"} ${conv(id).key}`; render(); }
});
document.addEventListener("keydown", event => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
  event.preventDefault(); step(event.key === "ArrowRight" ? 1 : -1, `key ${event.key}`);
});
setVariant(new URL(location.href).searchParams.get("variant") ?? "A", "load from URL");
