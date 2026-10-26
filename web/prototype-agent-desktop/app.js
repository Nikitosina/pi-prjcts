// THROWAWAY PROTOTYPE — three coordinator layouts over static, in-memory data.
// ?variant=terminal|desktop|dispatch; ←/→ or the bottom switcher. No host/model calls.
const VARIANTS = [
  ["terminal", "Pi terminal workbench"],
  ["desktop", "Hermes-inspired desktop"],
  ["dispatch", "Decision-first dispatch"],
];
const workers = [
  { id: "w1", name: "Streaming message polish", role: "worker", state: "running", branch: "pi/streaming-4a91", model: "sonnet 4.6", context: "74%", detail: "Replaying reconnect at chunk boundary", ago: "now" },
  { id: "w2", name: "Mobile keyboard safe areas", role: "worker", state: "running", branch: "pi/mobile-82bc", model: "sonnet 4.6", context: "41%", detail: "iPhone 15 Pro · Safari", ago: "2m" },
  { id: "w3", name: "Review PR #184", role: "reviewer", state: "blocked", branch: "pull/184", model: "gpt-5.3", context: "28%", detail: "Needs owner decision on retry semantics", ago: "6m" },
  { id: "w4", name: "Trace compaction boundary", role: "scout", state: "done", branch: "main@959d84a", model: "sonnet 4.6", context: "19%", detail: "Read 14 files · no changes", ago: "18m" },
];
const state = {
  pending: 2,
  selectedWorker: "w1",
  desktopPane: "changes",
  selectedDecision: "retry",
  sent: { terminal: [], desktop: [], dispatch: [] },
};
let variant = new URL(location.href).searchParams.get("variant");
if (!VARIANTS.some(([key]) => key === variant)) variant = "terminal";
const esc = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const status = `<span class="proto-status"><i></i> 2 running</span><span>1 blocked</span><span>68% context</span>`;
const tool = (name, command, result, open = false) => `<details class="proto-tool" ${open ? "open" : ""}><summary><span class="tool-glyph">◆</span><b>${name}</b><code>${esc(command)}</code><span class="tool-time">${result}</span></summary><pre>${esc(command)}\n${result === "running" ? "⠋ waiting for process output…" : "exit 0 · 0.42s\nsrc/host.ts:218  return frame\nweb/app.js:184  renderLive(frame)"}</pre></details>`;
const compaction = `<div class="proto-compaction"><span>◇ CONTEXT COMPACTED</span><span>84,210 → 31,840 tokens</span><button data-stub="View compaction summary">summary</button></div>`;
const userText = "Ship the reconnect fix, but don’t change retry semantics until we agree. Keep mobile stable and show me the diff before the PR.";
const coordinatorText = "I’ve split this into two workers: reconnect handling and mobile safe areas. The reviewer is holding on your retry decision; no merges or production changes.";

function composer(kind) {
  const placeholder = kind === "terminal" ? "Message coordinator…  / for commands, @ for files" : kind === "desktop" ? "Ask Pi, attach context, or steer a worker…" : "Add an instruction to the current plan…";
  const sent = state.sent[kind].map(message => `<div class="proto-sent"><b>You · just now</b><p>${esc(message)}</p><small>Mock reply: noted in memory only. Nothing was sent.</small></div>`).join("");
  return `${sent}<form class="proto-composer ${kind}-composer" data-compose="${kind}"><span class="prompt">${kind === "terminal" ? "›" : "+"}</span><textarea name="message" rows="2" aria-label="Prototype message" placeholder="${placeholder}"></textarea><div class="compose-bottom"><span>${kind === "terminal" ? "enter send · shift+enter newline" : "Mock input · no model call"}</span><button type="button" data-stub="Attach context">⌘K context</button><button class="send" type="submit">${kind === "terminal" ? "send ↵" : "↑"}</button></div></form>`;
}
function workerRows(mode = "") {
  return workers.map(worker => `<button class="proto-worker ${worker.state} ${state.selectedWorker === worker.id ? "selected" : ""} ${mode}" data-worker="${worker.id}"><span class="worker-dot"></span><span class="worker-copy"><b>${esc(worker.name)}</b><small>${worker.role} · ${worker.model}</small><small class="worker-detail">${esc(worker.detail)}</small></span><span class="worker-meta">${worker.ago}<br>${worker.context}</span></button>`).join("");
}

// A — Pi coding-agent TUI: one dense event stream, tools inline, workers as a process tree.
function terminalVariant() {
  const worker = workers.find(item => item.id === state.selectedWorker);
  return `<section class="terminal-workbench" aria-label="Terminal workbench prototype">
    <div class="terminal-main">
      <div class="terminal-tabbar"><span><b>π coordinator</b> / main</span><span class="terminal-path">~/Projects/mari</span><button data-stub="Open command palette">⌘K</button></div>
      <div class="terminal-transcript">
        <div class="term-line muted">pi projects · session 81e3b641 · opus 4.6 high · branch main</div>
        <div class="term-user"><span>you</span><p>${userText}</p></div>
        <div class="term-agent"><span>π</span><p>${coordinatorText}</p></div>
        ${tool("projects_delegate", 'task: "Fix SSE reconnect without retry changes"', "worker w1 running")}
        ${tool("projects_delegate", 'task: "Verify iPhone keyboard safe areas"', "worker w2 running")}
        <div class="term-note"><span>↳</span> Two scoped worktrees allocated. Owner checkout untouched.</div>
        ${compaction}
        <div class="term-tool-group"><div class="term-line"><span class="ok">✓</span><b>projects_search</b><code>"usage limits retry reconnect"</code><span>1.2s</span></div><div class="term-output">research/streaming-recovery.md · 3,842 chars<br>decisions/retry-policy.md · 1,206 chars</div></div>
        <div class="term-line"><span class="running-glyph">⠋</span><b>bash</b><code>npm run e2e -- streaming-reconnect</code><span>00:42</span></div>
        <div class="term-output live">PASS 17 chunks resumed after reconnect<br>PASS owner draft retained<br><span>⠋ replaying late compaction frame…</span></div>
        <div class="term-agent"><span>π</span><p>Reconnect checks pass. One decision remains before I let the worker touch retry behavior.</p></div>
        <div class="term-question"><span>? OWNER INPUT</span><b>Should a reconnect reuse the original attempt, or count as a new retry?</b><div><button data-decision>Reuse original attempt</button><button data-stub="Inspect retry tradeoffs">Inspect tradeoffs</button></div></div>
      </div>
      ${composer("terminal")}
      <div class="terminal-status"><span><i></i> coordinating</span><span>2 tools running</span><span>↑ 84.2k ↓ 12.8k</span><span>$1.84</span><span>ctx 68%</span></div>
    </div>
    <aside class="terminal-rail">
      <div class="rail-heading">WORKERS <span>4</span></div>
      ${workerRows("terminal-worker")}
      <div class="rail-heading">SELECTED PROCESS</div>
      <div class="process-head"><b>${esc(worker.name)}</b><code>${worker.branch}</code></div>
      <dl class="process-stats"><div><dt>state</dt><dd>${worker.state}</dd></div><div><dt>model</dt><dd>${worker.model}</dd></div><div><dt>context</dt><dd>${worker.context}</dd></div><div><dt>lease</dt><dd>ios-simulator</dd></div></dl>
      <div class="rail-heading">LATEST OUTPUT</div>
      <pre class="rail-output">14:32:08 read web/app.js\n14:32:11 edit src/host.ts\n14:32:19 bash npm run check\n14:32:24 ✓ typecheck\n14:32:41 ⠋ reconnect-e2e</pre>
      <button class="rail-action" data-stub="Open worker transcript">Open full worker transcript ↗</button>
      <div class="rail-heading">PROJECT</div>
      <div class="term-knowledge">MEMORY.md<br>├─ decisions/retry-policy.md<br>├─ research/streaming.md<br>└─ runbooks/e2e.md</div>
    </aside>
  </section>`;
}

// B — Hermes Desktop: chat-first, flat surfaces, session tabs and a side-by-side working pane.
function desktopVariant() {
  const panes = ["changes", "activity", "context"];
  let pane;
  if (state.desktopPane === "changes") pane = `<div class="diff-summary"><span><b>7 files changed</b><small>worker w1 · uncommitted mock diff</small></span><span class="add">+184</span><span class="del">−39</span></div><div class="file-list"><button data-stub="Preview app.js diff"><span>M</span> web/app.js <small>+82 −21</small></button><button data-stub="Preview host diff"><span>M</span> src/host.ts <small>+46 −12</small></button><button data-stub="Preview CSS diff"><span>M</span> web/styles.css <small>+31 −6</small></button><button data-stub="Preview streaming test"><span>A</span> scripts/reconnect-e2e.mjs <small>+25</small></button></div><pre class="desktop-diff"><span>@@ renderLive(frame) @@</span>\n  if (!frame?.running) {\n<span class="del">-   node.hidden = true;</span>\n<span class="add">+   if (liveFrame?.entries !== frame.entries) {</span>\n<span class="add">+     await settledRefresh();</span>\n<span class="add">+   }</span>\n    renderWorkingPill();</pre><button class="text-action" data-stub="Open complete diff">Open complete diff ↗</button>`;
  else if (state.desktopPane === "activity") pane = `<div class="activity-feed">${[["14:32", "worker", "Reconnect test passed chunk resume"], ["14:31", "tool", "Read research/streaming-recovery.md"], ["14:29", "coordinator", "Allocated mobile verification worker"], ["14:27", "system", "Compacted coordinator context"], ["14:21", "you", "Changed retry requirement"]].map(([time, who, text]) => `<div><time>${time}</time><span><b>${who}</b>${text}</span></div>`).join("")}</div>`;
  else pane = `<div class="context-pane"><div class="context-ring"><span>68<small>%</small></span></div><h3>Coordinator context</h3><p>91,648 of 134,000 estimated tokens</p><div class="context-bar"><i></i></div><dl><div><dt>System + project</dt><dd>18.2k</dd></div><div><dt>Conversation</dt><dd>42.6k</dd></div><div><dt>Worker reports</dt><dd>21.1k</dd></div><div><dt>Available</dt><dd>42.3k</dd></div></dl><button data-stub="Compact this mock chat">Compact now</button><small>Last compaction 5 minutes ago</small></div>`;
  return `<section class="desktop-workspace" aria-label="Hermes-inspired desktop prototype">
    <div class="desktop-chat">
      <div class="desktop-session-tabs"><button class="active"><span class="session-avatar">π</span> Release coordination <i></i></button><button data-stub="Open mobile chat"><span class="session-avatar alt">M</span> Mobile verification <small>2</small></button><button class="new-tab" data-stub="New chat">+</button><span class="window-actions">— □</span></div>
      <div class="desktop-heading"><span><small>COORDINATOR</small><h2>Release coordination</h2></span><button data-stub="Session actions">•••</button></div>
      <div class="desktop-transcript">
        <div class="desktop-day"><span>Today, 14:21</span></div>
        <div class="desktop-message user"><p>${userText}</p><small>You · 14:21</small></div>
        <div class="desktop-message agent"><span class="hermes-mark">π</span><div><p>${coordinatorText}</p><div class="desktop-tools">${tool("Delegate", "Streaming message polish", "running")}${tool("Delegate", "Mobile keyboard safe areas", "running")}</div><small>Pi Coordinator · 14:22</small></div></div>
        ${compaction}
        <div class="desktop-message agent"><span class="hermes-mark">π</span><div><p>Both workers are underway. The reconnect path is green so far; I’m keeping the retry policy frozen.</p><div class="inline-progress"><i></i><span><b>Running verification</b><small>streaming-reconnect · 42s</small></span><code>17/18</code></div><small>Pi Coordinator · now</small></div></div>
        <div class="desktop-approval"><span class="approval-icon">?</span><div><small>DECISION NEEDED</small><b>How should reconnects affect retry count?</b><p>The reviewer found two valid interpretations. Your choice updates the brief only.</p><div><button data-decision>Reuse original attempt</button><button data-stub="Compare retry choices">Compare choices</button></div></div></div>
      </div>
      ${composer("desktop")}
      <div class="desktop-chat-status"><span><i></i> Local host ready</span><span>Opus 4.6 · High</span><span>91.6k tokens · $1.84</span></div>
    </div>
    <aside class="desktop-pane">
      <nav>${panes.map(paneName => `<button data-pane="${paneName}" class="${state.desktopPane === paneName ? "active" : ""}">${paneName[0].toUpperCase() + paneName.slice(1)}${paneName === "activity" ? " · 5" : ""}</button>`).join("")}<button class="pane-close" data-stub="Close working pane">×</button></nav>
      <div class="desktop-pane-body">${pane}</div>
      <div class="desktop-workers"><div class="pane-label">WORKERS <span>2 active</span></div>${workerRows("desktop-worker")}</div>
    </aside>
  </section>`;
}

// C — Dispatch: briefing and decisions lead; conversation and worker execution support the current objective.
function dispatchVariant() {
  const retry = state.selectedDecision === "retry";
  return `<section class="dispatch-workspace" aria-label="Decision-first dispatch prototype">
    <header class="dispatch-brief"><div><span class="brief-kicker">WEDNESDAY · RELEASE 2.4</span><h2>Two decisions unblock the release.</h2><p>Everything else is moving. Reconnect checks are green; mobile verification is running.</p></div><div class="brief-stats"><span><b>${state.pending}</b>needs you</span><span><b>2</b>working</span><span><b>68%</b>context</span></div></header>
    <div class="dispatch-grid">
      <aside class="dispatch-agenda">
        <div class="agenda-label">NOW</div>
        <button class="agenda-item ${retry ? "selected" : ""}" data-agenda="retry"><span class="agenda-index">01</span><span><b>Reconnect retry policy</b><small>Owner decision · blocks reviewer</small></span><i>required</i></button>
        <button class="agenda-item ${!retry ? "selected" : ""}" data-agenda="scope"><span class="agenda-index">02</span><span><b>Approve expanded test scope</b><small>Worker request · 2 min read</small></span><i>review</i></button>
        <div class="agenda-label">IN MOTION</div>
        ${workerRows("dispatch-worker")}
        <div class="agenda-label">LATER</div>
        <div class="later-line"><span>16:00</span><p>Weekly knowledge compile<small>scheduled · no action needed</small></p></div>
        <div class="later-line"><span>PR</span><p>Draft release handoff<small>waiting for 2 workers</small></p></div>
      </aside>
      <main class="dispatch-focus">
        ${retry ? `<div class="focus-label"><span>DECISION 01 / 02</span><span>from Review PR #184 · 6m ago</span></div><h3>Should a reconnect reuse the original attempt?</h3><p class="focus-deck">The current runner retries immediately after transport failure. Resuming an SSE stream is different: the model attempt may still be valid.</p><div class="decision-options"><button data-decision><span>A</span><div><b>Reuse the original attempt</b><p>Reconnect is transport recovery. Retry budget changes only on a new model request.</p><small>Recommended by reviewer · preserves current quota semantics</small></div></button><button data-stub="Choose new retry"><span>B</span><div><b>Count a new retry</b><p>Simpler accounting, but a flaky network can consume the model retry budget.</p><small>Changes decisions/retry-policy.md</small></div></button></div><div class="decision-evidence"><span>Evidence</span><button data-stub="Open retry decision">decisions/retry-policy.md ↗</button><button data-stub="Open reconnect trace">reconnect-trace.json ↗</button></div>` : `<div class="focus-label"><span>DECISION 02 / 02</span><span>from Mobile keyboard safe areas · 2m ago</span></div><h3>Include one older iOS Safari run?</h3><p class="focus-deck">The worker can cover iOS 16 in the same simulator pass. It adds about four minutes and does not touch production code.</p><div class="decision-options"><button data-decision><span>A</span><div><b>Include iOS 16 verification</b><p>Useful release evidence with no source changes.</p></div></button><button data-stub="Keep current test scope"><span>B</span><div><b>Keep the current matrix</b><p>Stay with iOS 17 and 18 for this pass.</p></div></button></div>`}
        <div class="focus-conversation"><div class="focus-label"><span>COORDINATOR NOTE</span><span>14:32</span></div><p>${coordinatorText}</p>${tool("verification", "streaming-reconnect · 17 of 18 checks", "running")}<button class="text-action" data-stub="Read full coordinator conversation">Read full conversation ↗</button></div>
        ${composer("dispatch")}
      </main>
      <aside class="dispatch-pulse">
        <div class="pulse-label">PROJECT PULSE</div>
        <div class="pulse-objective"><small>CURRENT OBJECTIVE</small><p>Stabilize the coordinator for release without changing owner-controlled retry policy.</p></div>
        <div class="pulse-track"><div class="done"><i>✓</i><span><b>Plan</b><small>3 scoped tasks</small></span></div><div class="active"><i>2</i><span><b>Implement & verify</b><small>2 running · 1 waiting</small></span></div><div><i>3</i><span><b>Review handoff</b><small>after your decisions</small></span></div></div>
        <div class="pulse-label">CONTEXT</div><div class="dispatch-context"><div><span>Coordinator</span><b>68%</b></div><div class="context-bar"><i></i></div><small>Compacted 5m ago · 31.8k retained</small></div>
        <div class="pulse-label">RECENT RESULTS</div><button class="result-link" data-stub="Open typecheck result"><span>✓</span><p>Typecheck<small>0 errors · 14:31</small></p></button><button class="result-link" data-stub="Open streaming evidence"><span>✓</span><p>Chunk resume<small>17 checks · 14:32</small></p></button><button class="result-link" data-stub="Open scout report"><span>↗</span><p>Compaction trace<small>Scout report · 14:14</small></p></button>
      </aside>
    </div>
  </section>`;
}

function setVariant(next) {
  variant = next;
  const url = new URL(location.href);
  url.searchParams.set("variant", next);
  history.replaceState(null, "", url);
  render();
  document.querySelector(".proto-main-scroll")?.scrollTo(0, 0);
}
function cycle(direction) {
  const index = VARIANTS.findIndex(([key]) => key === variant);
  setVariant(VARIANTS[(index + direction + VARIANTS.length) % VARIANTS.length][0]);
}
function toast(message) {
  const node = document.querySelector("#toast");
  node.textContent = `${message} — prototype only`;
  node.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("visible"), 2200);
}
function render() {
  document.body.dataset.prototypeVariant = variant;
  const renderVariant = { terminal: terminalVariant, desktop: desktopVariant, dispatch: dispatchVariant }[variant];
  const panel = document.querySelector('[data-panel="coordinator"]');
  panel.innerHTML = renderVariant();
  panel.classList.remove("grid2");
  const index = VARIANTS.findIndex(([key]) => key === variant);
  document.querySelector("#prototype-switcher").innerHTML = `<button data-cycle="-1" aria-label="Previous prototype">←</button><span class="switcher-label"><b>${String.fromCharCode(65 + index)} · ${VARIANTS[index][1]}</b><small>MOCK · ${state.pending} pending · 2 running · 68% context</small></span><button data-cycle="1" aria-label="Next prototype">→</button>`;
  document.title = `THROWAWAY ${String.fromCharCode(65 + index)} · ${VARIANTS[index][1]}`;
}

// Reuse the actual app shell and populate it with static project context.
document.querySelector("#title").textContent = "Mari · iOS release";
document.querySelector("#avatar").textContent = "M";
document.querySelector("#needs-count").textContent = "2";
document.querySelector("#needs-count").hidden = false;
document.querySelector("#project-list").innerHTML = [
  ["M", "Mari · iOS release", "needs"], ["P", "Pi Projects", "working"], ["Y", "Yandex Keyboard", "done"], ["W", "Weekly knowledge", "idle"],
].map(([avatar, name, statusName], index) => `<button class="proj ${index === 0 ? "on" : ""}" data-stub="Switch to ${name}"><span class="avatar sm">${avatar}</span><span class="grow side-text">${name}</span><span class="state-dot" data-state="${statusName}"></span></button>`).join("");
document.querySelector("#connection").textContent = "Prototype · mock";
document.querySelector("#connection").dataset.state = "up";
document.querySelector("#refresh").textContent = "Reset view";
document.querySelector("#create").innerHTML = '<span class="create-plus">＋</span><span class="side-text">&nbsp;New project</span>';
document.querySelector("#projects").innerHTML = "<option>Mari · iOS release</option>";
document.querySelectorAll(".panel:not([data-panel=coordinator]), #inline-thread").forEach(node => { node.hidden = true; });
document.querySelector(".tabs").querySelectorAll("button").forEach(button => button.classList.toggle("on", button.dataset.tab === "coordinator"));
document.querySelector("#limits-bar").innerHTML = '<span class="prototype-foot"><b>THROWAWAY PROTOTYPE</b><span>static mock data</span><span>no host API</span><span>no model calls</span><span>memory only</span></span>';
document.querySelector("footer").insertAdjacentHTML("afterend", '<nav id="prototype-switcher" aria-label="Prototype variants" aria-live="polite"></nav>');
render();

document.addEventListener("click", event => {
  const target = event.target.closest("button, [data-stub]");
  if (!target) return;
  if (target.dataset.cycle) return cycle(Number(target.dataset.cycle));
  if (target.id === "refresh") { state.sent = { terminal: [], desktop: [], dispatch: [] }; state.pending = 2; render(); return toast("Reset in-memory messages"); }
  if (target.dataset.worker) { state.selectedWorker = target.dataset.worker; render(); return; }
  if (target.dataset.pane) { state.desktopPane = target.dataset.pane; render(); return; }
  if (target.dataset.agenda) { state.selectedDecision = target.dataset.agenda; render(); return; }
  if (target.hasAttribute("data-decision")) { state.pending = Math.max(0, state.pending - 1); render(); return toast("Choice recorded in memory; no worker was notified"); }
  if (target.id === "side-toggle") { document.querySelector(".app").classList.toggle("side-collapsed"); return; }
  event.preventDefault();
  toast(target.dataset.stub || `${target.textContent.trim()} is a stub`);
});
document.addEventListener("submit", event => {
  const form = event.target.closest("[data-compose]");
  if (!form) return;
  event.preventDefault();
  const input = form.elements.message;
  const text = input.value.trim();
  if (!text) return toast("Type a mock message first");
  state.sent[form.dataset.compose].push(text);
  render();
  toast("Message kept in memory only");
});
document.addEventListener("keydown", event => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (event.target.closest("input, textarea, select, [contenteditable]") || event.isComposing) return;
  event.preventDefault();
  cycle(event.key === "ArrowLeft" ? -1 : 1);
});
