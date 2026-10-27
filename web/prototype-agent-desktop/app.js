// THROWAWAY PROTOTYPE — three interaction models over static, in-memory data.
// ?variant=terminal|desktop|dispatch. No host, persistence, shell, API, or model calls.
const VARIANTS = [
  ["terminal", "Modal Pi TUI"],
  ["desktop", "Hermes-inspired workspace"],
  ["dispatch", "Decision desk"],
];
const workers = [
  ["w1", "Streaming reconnect", "running", "sonnet 4.6", "74%", "npm run e2e -- streaming-reconnect"],
  ["w2", "Mobile safe areas", "running", "sonnet 4.6", "41%", "iPhone 15 Pro · Safari"],
  ["w3", "Review retry semantics", "blocked", "gpt-5.3", "28%", "waiting for owner decision"],
  ["w4", "Trace compaction", "done", "sonnet 4.6", "19%", "14 files · no changes"],
];
const baseSessions = [
  ["release", "Release coordination", "2 running · now"],
  ["mobile", "Mobile verification", "simulator · 2m"],
  ["retry", "Retry policy review", "decision · 6m"],
  ["compaction", "Compaction research", "done · 18m"],
];
const decisions = [
  { title: "Reconnect without spending a retry?", tag: "RETRY POLICY", impact: "Unblocks reviewer w3", brief: "A dropped connection is a transport failure. Should recovery keep the original model attempt, or count against the retry budget?", choices: ["Reuse original attempt", "Count as a retry"], evidence: ["17 reconnect checks pass; the late compaction case is still running.", "The current retry policy counts model failures, not dropped streams.", "No production retry behavior has changed."], consequence: "The reviewer can finish the policy review. Reconnect and mobile workers continue independently." },
  { title: "Include mobile fixes in this handoff?", tag: "RELEASE SCOPE", impact: "Sets the release boundary", brief: "Safe-area changes are isolated from reconnect. Bundle them only after the remaining simulator checks finish.", choices: ["Wait for mobile checks", "Split into a follow-up"], evidence: ["12 of 14 simulator checks are complete.", "Mobile changes have their own worktree.", "A separate handoff avoids coupling the reconnect fix to layout verification."], consequence: "Only the local release brief changes. No PR is created and no worker receives a message." },
];
const state = {
  overlay: null, overlayIndex: 0, lastAction: "ready · static mock data",
  mode: "normal", selectedBlock: 0, search: "", toolOpen: new Set([0, 2]), diffOpen: true, workersOpen: true,
  sessions: [...baseSessions], activeSession: "release", drafts: { terminal: "", desktop: "" }, history: [], historyIndex: null,
  queued: [], sent: [],
  desktopView: "chat", inspector: "diff", inspectorOpen: innerWidth > 680, inspectorWidth: 380, sidebarOpen: innerWidth > 1000,
  contextAttached: false, model: "Opus 4.6 · high", running: true,
  decisionIndex: 0, decisions: {}, evidenceTab: "evidence", selectedFile: "app.js", compacted: false,
};
let variant = new URL(location.href).searchParams.get("variant");
if (!VARIANTS.some(([key]) => key === variant)) variant = "terminal";
let returnFocus = null;
const esc = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const editable = node => node?.closest("input, textarea, select, [contenteditable]");
const currentSession = () => state.sessions.find(session => session[0] === state.activeSession) ?? state.sessions[0];

function toolBlock(index, name, command, output, tone = "done") {
  const open = state.toolOpen.has(index);
  return `<div class="tui-block ${state.selectedBlock === index ? "cursor" : ""}" data-block="${index}" data-search="${esc(`${name} ${command} ${output}`.toLowerCase())}"><button class="tui-tool-line" data-action="tool" data-tool="${index}" aria-expanded="${open}"><span class="tool-state ${tone}">${tone === "running" ? "⠋" : tone === "blocked" ? "!" : "✓"}</span><b>${name}</b><code>${esc(command)}</code><span class="tool-elapsed">${tone === "running" ? "42s" : "0.4s"}</span><span>${open ? "▾" : "▸"}</span></button>${open ? `<pre class="tui-output">${esc(output)}</pre>` : ""}</div>`;
}
function tuiTranscript() {
  const blocks = [
    `<div class="tui-block tui-copy ${state.selectedBlock === 3 ? "cursor" : ""}" data-block="3" data-search="owner reconnect fix retry semantics mobile diff"><span class="tui-prefix user">you</span><p>Ship the reconnect fix, but don’t change retry semantics until we agree. Keep mobile stable and show me the diff before the PR.</p></div>`,
    `<div class="tui-block tui-copy ${state.selectedBlock === 4 ? "cursor" : ""}" data-block="4" data-search="coordinator workers reconnect mobile reviewer retry decision"><span class="tui-prefix">π</span><p>I’ve split this into two workers. The reviewer is holding on your retry decision; no merges or production changes.</p></div>`,
    toolBlock(0, "projects_delegate", 'task:"Fix SSE reconnect"', "worker w1 allocated\nbranch pi/streaming-4a91\nscope web/** src/host.ts\nlease ios-simulator acquired"),
    toolBlock(1, "projects_search", '"usage limits retry reconnect"', "research/streaming-recovery.md · 3,842 chars\ndecisions/retry-policy.md · 1,206 chars"),
    `<div class="tui-block tui-compact ${state.selectedBlock === 5 ? "cursor" : ""}" data-block="5" data-search="context compacted tokens"><span>◇ compacted</span><span>84,210 → 31,840 tokens</span><span>kept 18 recent messages</span></div>`,
    toolBlock(2, "bash", "npm run e2e -- streaming-reconnect", "PASS 17 chunks resumed after reconnect\nPASS owner draft retained\n⠋ replaying late compaction frame…", "running"),
  ];
  if (state.activeSession !== "release") return `<div class="tui-copy"><span class="tui-prefix">π</span><p>${esc(currentSession()[1])} session\n${state.activeSession === "mobile" ? "Safe-area verification: 12/14 checks. Composer stays above the mock keyboard." : state.activeSession === "retry" ? "Reviewer paused. Awaiting owner choice on reconnect retry accounting." : "Compaction research complete. 14 files read; no changes."}</p></div>`;
  const filtered = blocks.filter(block => !state.search || block.toLowerCase().includes(state.search.toLowerCase()));
  return `${filtered.join("") || `<div class="tui-empty">No transcript matches “${esc(state.search)}”. Press Esc to clear.</div>`}${state.diffOpen ? `<div class="tui-block tui-diff ${state.selectedBlock === 6 ? "cursor" : ""}" data-block="6" data-search="diff app host render live settled refresh"><div><span>diff</span><code>worker/w1 · 4 files · +184 −39</code><span>working tree</span></div><pre><span class="dim">@@ ${esc(state.selectedFile)} / renderLive(frame) @@</span>\n  if (!frame?.running) {\n<span class="del">-   node.hidden = true;</span>\n<span class="add">+   if (liveFrame?.entries !== frame.entries) {</span>\n<span class="add">+     await settledRefresh();</span>\n<span class="add">+   }</span>\n    renderWorkingPill();</pre></div>` : ""}<div class="tui-block tui-question ${state.selectedBlock === 7 ? "cursor" : ""}" data-block="7" data-search="owner question reconnect retry attempt"><span>? owner</span><p>Reuse the original model attempt after reconnect?</p><button data-action="decision">${state.decisions[0] ? "✓ recorded locally" : "y · reuse attempt"}</button><button data-action="decision-compare">n · inspect tradeoff</button></div>`;
}
function prompt(kind) {
  const queued = kind === "terminal" ? state.queued.map((text, index) => `<div class="queued-steer"><span>queued ${index + 1}</span><code>${esc(text)}</code><button data-action="unqueue" data-index="${index}" aria-label="Remove queued steer">×</button></div>`).join("") : "";
  return `${queued}<form class="${kind}-prompt" data-compose="${kind}"><span class="prompt-mark">${kind === "terminal" ? "❯" : "+"}</span><textarea id="${kind}-composer" name="message" rows="2" aria-label="${kind} mock prompt" placeholder="${kind === "terminal" ? "steer coordinator · / commands · ↑ history" : "Message the coordinator or steer this workspace…"}">${esc(state.drafts[kind])}</textarea>${kind === "desktop" && state.contextAttached ? '<span class="attached-context">@ retry-policy.md <button type="button" data-action="attach">×</button></span>' : ""}<div class="prompt-foot"><span>${kind === "terminal" ? `${state.mode.toUpperCase()} · enter queue steer · shift+enter newline` : "Mock composer · nothing is sent"}</span>${kind === "desktop" ? `<button type="button" data-action="attach">@ context</button><button type="button" data-action="model">${state.model}</button>` : ""}<button class="prompt-send" type="submit">${kind === "terminal" ? "queue ↵" : "↑"}</button></div></form>`;
}

// A — full-viewport modal TUI. Every shown key performs a local action.
function terminalVariant() {
  const session = currentSession();
  return `<main class="tui" aria-label="Modal Pi TUI prototype">
    <header class="tui-title"><span class="tui-logo">π</span><b>projects</b><span>~/mari</span><span class="tui-branch">git:main*</span><span class="tui-session">[${esc(session[1])}]</span><span class="tui-mode">${state.mode.toUpperCase()}</span></header>
    <nav class="tui-tabs" aria-label="Mock sessions">${state.sessions.slice(0, 4).map((item, index) => `<button data-action="session" data-session="${item[0]}" class="${item[0] === state.activeSession ? "active" : ""}">${index + 1}:${esc(item[1].toLowerCase().replaceAll(" ", "-"))}${index === 0 ? "*" : ""}</button>`).join("")}<span>14:32:08</span></nav>
    <div class="tui-body">
      <section class="tui-main">
        <div class="tui-scroll">${state.search ? `<div class="tui-filter">filter:/${esc(state.search)} <span>Esc clears</span></div>` : ""}${tuiTranscript()}</div>
        <div class="tui-command-line">${prompt("terminal")}</div>
        <footer class="tui-status"><span class="mode-cell">${state.mode === "insert" ? "-- INSERT --" : "NORMAL"}</span><span>${state.running ? "⠋ coordinator + 2 workers" : "Ⅱ paused"}</span><span>queue:${state.queued.length}</span><span>↑${state.compacted ? "31.8" : "84.2"}k ↓12.8k</span><span>$1.84</span><span>ctx:${state.compacted ? "25" : "68"}%</span></footer>
        <footer class="tui-hints"><span><kbd>i</kbd> insert</span><span><kbd>j/k</kbd> select</span><span><kbd>o</kbd> output</span><span><kbd>d</kbd> diff</span><span><kbd>f</kbd> find</span><span><kbd>s</kbd> sessions</span><span><kbd>/</kbd> commands</span><button data-action="help"><kbd>?</kbd> help</button></footer>
      </section>
      ${state.workersOpen ? `<aside class="tui-workers"><div class="tui-rail-title">WORKERS <span>w:close</span></div>${workers.map((worker, index) => `<button data-action="worker" data-worker="${index}" class="tui-worker ${worker[2]}"><span>${worker[2] === "running" ? "⠋" : worker[2] === "blocked" ? "!" : "✓"}</span><div><b>${worker[1]}</b><code>${worker[0]} · ${worker[3]} · ctx ${worker[4]}</code><small>${worker[5]}</small></div></button>`).join("")}<div class="tui-rail-title">PROCESS</div><pre class="tui-process">14:32:08 read web/app.js\n14:32:11 edit src/host.ts\n14:32:19 $ npm run check\n14:32:24 ✓ typecheck\n14:32:41 ⠋ reconnect-e2e</pre><div class="tui-rail-title">CONTEXT</div><div class="tui-meter">68% [████████████░░░░░░]</div><small class="tui-rail-note">last compact 5m ago<br>reserve 42.3k tokens</small></aside>` : ""}
    </div>
  </main>`;
}

function inspectorContent() {
  if (state.inspector === "files") return `<div class="inspector-intro"><b>Workspace files</b><small>~/Projects/mari · mock working tree</small></div>${[["src", "folder"], ["web", "folder"], ["app.js", "M  +82 −21"], ["host.ts", "M  +46 −12"], ["styles.css", "M  +31 −6"], ["retry-policy.md", "decision reference"]].map(([name, meta]) => `<button class="workspace-file" data-action="file" data-file="${name}"><span>${meta === "folder" ? "▸" : "·"}</span><code>${name}</code><small>${meta}</small></button>`).join("")}<pre class="file-preview">${esc(state.selectedFile)}\n\nexport function renderLive(frame) {\n  // Mock file preview\n  return frame.entries;\n}</pre>`;
  if (state.inspector === "activity") return `<div class="inspector-intro"><b>Workspace activity</b><small>live mock event feed</small></div><div class="workspace-activity">${[["14:32", "verification", "17/18 reconnect checks pass"], ["14:27", "worker w1", "4 files changed"], ["14:21", "owner", "retry requirement changed"], ["14:16", "system", "coordinator compacted"], ["14:08", "coordinator", "2 worktrees allocated"]].map(row => `<div><time>${row[0]}</time><span><b>${row[1]}</b>${row[2]}</span></div>`).join("")}</div>`;
  if (state.inspector === "context") return `<div class="inspector-intro"><b>Coordinator context</b><small>${state.compacted ? "34,100" : "91,648"} / 134,000 estimated tokens</small></div><div class="workspace-context"><strong>${state.compacted ? "25" : "68"}<span>%</span></strong><div style="background:linear-gradient(to right, #6681d1 ${state.compacted ? 25 : 68}%, #e0e4ed 0)"><i></i></div><dl><dt>System + project</dt><dd>18.2k</dd><dt>Conversation</dt><dd>${state.compacted ? "6.5k" : "42.6k"}</dd><dt>Worker reports</dt><dd>${state.compacted ? "9.4k" : "21.1k"}</dd><dt>Available</dt><dd>${state.compacted ? "99.9k" : "42.3k"}</dd></dl><button data-action="compact">Compact mock context</button></div>`;
  return `<div class="inspector-intro"><b>Working changes</b><small>worker w1 · mock uncommitted diff</small><span><em>+184</em> <del>−39</del></span></div><div class="inspector-file-tabs">${["app.js", "host.ts"].map(file => `<button class="${state.selectedFile === file ? "active" : ""}" data-action="diff-file" data-file="${file}">${file}</button>`).join("")}</div><pre class="workspace-diff"><span>@@ ${esc(state.selectedFile)} / renderLive(frame) @@</span>\n  if (!frame?.running) {\n<span class="del">-   node.hidden = true;</span>\n<span class="add">+   if (liveFrame?.entries !== frame.entries) {</span>\n<span class="add">+     await settledRefresh();</span>\n<span class="add">+   }</span>\n    renderWorkingPill();</pre><button class="inspector-action" data-action="inspector-next">Open host.ts →</button>`;
}
function desktopTranscript() {
  if (state.activeSession.startsWith("new-")) return `<div class="desktop-empty"><span>π</span><h2>New local session</h2><p>This session exists only in memory. Add a mock message to see the workspace respond.</p></div>`;
  if (state.activeSession === "mobile") return `<div class="desktop-day">MOBILE VERIFICATION</div><div class="desktop-message agent"><span class="hermes-mark">M</span><div><p>iPhone 15 Pro is running the safe-area pass. The keyboard no longer covers the composer in the mocked trace.</p><div class="workspace-callout">Simulator · iOS 18.2 <b>12/14 checks</b></div><small>Mobile worker · 2m ago</small></div></div>`;
  if (state.activeSession === "compaction") return `<div class="desktop-day">COMPACTION RESEARCH</div><div class="desktop-message agent"><span class="hermes-mark">C</span><div><p>Read 14 files. The context summary keeps worker IDs, retry constraints, and current evidence. No file changes.</p><small>Research worker · 18m ago</small></div></div>`;
  if (state.activeSession === "retry") return `<div class="desktop-day">RETRY POLICY REVIEW</div><div class="desktop-message agent"><span class="hermes-mark">R</span><div><p>A reconnect can preserve the original model attempt, or consume one retry. The owner decision is still pending.</p><small>Reviewer · 6m ago</small></div></div>`;
  return `<div class="desktop-day"><span>Today, 14:21</span></div><div class="desktop-message user"><p>Ship the reconnect fix, but don’t change retry semantics until we agree. Keep mobile stable and show me the diff before the PR.</p><small>You · 14:21</small></div><div class="desktop-message agent"><span class="hermes-mark">π</span><div><p>I’ve split this into two workers. The reviewer is holding on your retry decision; no merges or production changes.</p><button class="tool-summary" data-action="inspector-diff"><span>◆</span><b>2 tasks delegated</b><small>streaming reconnect · mobile safe areas</small><span>→</span></button><small>Pi Coordinator · 14:22</small></div></div><div class="desktop-message agent"><span class="hermes-mark">π</span><div><p>Reconnect checks are green so far. I’m keeping retry policy frozen.</p><div class="workspace-callout"><span class="spinner">⠋</span> streaming-reconnect <b>17/18</b></div><small>Pi Coordinator · now</small></div></div>`;
}

// B — desktop workspace: durable session navigation, working panes, direct manipulation.
function desktopVariant() {
  return `<main class="desktop-os ${state.sidebarOpen ? "" : "sidebar-closed"}" aria-label="Hermes-inspired desktop workspace prototype">
    <header class="os-titlebar"><div class="traffic"><i></i><i></i><i></i></div><button data-action="workspace-menu">π <b>Mari</b> / Release 2.4 <span>⌄</span></button><span class="os-title">${esc(currentSession()[1])}</span><div><button data-action="palette" aria-label="Command palette">⇧⌘P</button><button data-action="help" aria-label="Keyboard help">?</button></div></header>
    <div class="os-body">
      <nav class="os-rail" aria-label="Workspace destinations"><button class="brand-button" data-action="workspace-menu">π</button>${[["chat", "▤", "Chat"], ["sessions", "◷", "Sessions"], ["files", "▱", "Files"]].map(([view, glyph, label]) => `<button data-action="desktop-view" data-view="${view}" class="${state.desktopView === view ? "active" : ""}" aria-label="${label}"><span>${glyph}</span><small>${label}</small></button>`).join("")}<button class="rail-bottom" data-action="settings" aria-label="Mock workspace settings">⚙</button></nav>
      ${state.sidebarOpen ? `<aside class="os-sidebar"><div class="sidebar-heading"><span>${state.desktopView === "files" ? "WORKSPACE" : "SESSIONS"}</span><button data-action="new-session" aria-label="New mock session">+</button></div><label class="session-search"><span>⌕</span><input id="session-filter" aria-label="Filter sessions" placeholder="Filter sessions" value="${esc(state.sessionFilter ?? "")}"></label><div class="session-group">PINNED</div>${state.sessions.filter(session => !state.sessionFilter || session[1].toLowerCase().includes(state.sessionFilter.toLowerCase())).map(session => `<button data-action="session" data-session="${session[0]}" class="os-session ${session[0] === state.activeSession ? "active" : ""}"><span class="session-glyph">${session[1][0]}</span><span><b>${esc(session[1])}</b><small>${session[2]}</small></span></button>`).join("")}<div class="session-group">WORKERS</div>${workers.slice(0, 3).map(worker => `<button class="os-worker" data-action="desktop-worker"><i class="${worker[2]}"></i><span>${worker[1]}</span><small>${worker[2]}</small></button>`).join("")}<div class="sidebar-bottom"><button data-action="project-switch">M</button><span><b>Mari</b><small>Local workspace</small></span></div></aside>` : ""}
      <section class="os-chat"><header class="chat-header"><div><small>COORDINATOR</small><h1>${esc(currentSession()[1])}</h1></div><button data-action="toggle-running">${state.running ? "Ⅱ Pause" : "▶ Resume"}</button><button data-action="toggle-sidebar" aria-label="Toggle sessions">${state.sidebarOpen ? "◧" : "◨"}</button><button data-action="toggle-inspector" aria-label="Toggle inspector">${state.inspectorOpen ? "◨" : "◧"}</button></header><div class="os-transcript">${desktopTranscript()}${state.sent.filter(item => item.session === state.activeSession).map(item => `<div class="desktop-message user"><p>${esc(item.text)}</p><small>You · local mock</small></div>`).join("")}</div>${prompt("desktop")}<footer class="os-chat-status"><span><i class="${state.running ? "live" : ""}"></i>${state.running ? "2 workers active" : "workspace paused"}</span><button data-action="model">${state.model}</button><span>${state.compacted ? "34.1" : "91.6"}k tokens · $1.84</span></footer></section>
      ${state.inspectorOpen ? `<div id="inspector-resize" class="inspector-resize" role="separator" aria-label="Resize inspector" aria-orientation="vertical" tabindex="0"></div><aside class="desktop-inspector" style="width:${state.inspectorWidth}px"><nav>${["diff", "files", "activity", "context"].map(tab => `<button data-action="inspector" data-inspector="${tab}" class="${state.inspector === tab ? "active" : ""}">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join("")}<button data-action="toggle-inspector" aria-label="Close inspector">×</button></nav><div class="inspector-body">${inspectorContent()}</div><div class="inspector-workers"><span>ACTIVE WORKERS</span>${workers.slice(0, 2).map(worker => `<button data-action="desktop-worker"><i class="${worker[2]}"></i><span><b>${worker[1]}</b><small>${worker[3]} · ${worker[4]} context</small></span></button>`).join("")}</div></aside>` : ""}
    </div>
    <footer class="os-status"><span>LOCAL MOCK WORKSPACE</span><span>main*</span><span>4 changes</span><span class="status-action">${esc(state.lastAction)}</span><button data-action="help">shortcuts ?</button></footer>
  </main>`;
}

// C: one owner choice at a time, with evidence and a local decision ledger.
function dispatchVariant() {
  const item = decisions[state.decisionIndex], saved = state.decisions[state.decisionIndex];
  return `<main class="decision-desk" aria-label="Decision-first prototype"><header class="desk-header"><span>π / MARI</span><small>OWNER DESK · RELEASE 2.4 · THROWAWAY</small><button data-action="help">? shortcuts</button></header><div class="desk-summary"><span>YOUR NEXT MOVE</span><h1>${Object.keys(state.decisions).length === decisions.length ? "All choices recorded." : "Two choices. Work keeps moving."}</h1><p>Local decisions only. Nothing is approved, sent, or merged.</p></div><nav class="decision-queue" aria-label="Decision queue">${decisions.map((decision, index) => `<button data-action="select-decision" data-index="${index}" class="${state.decisionIndex === index ? "active" : ""}"><span>0${index + 1} / ${state.decisions[index] ? "RECORDED" : "NEEDS YOU"}</span><b>${decision.tag}</b><small>${decision.impact}</small></button>`).join("")}</nav><div class="desk-body"><section class="decision-paper"><small>${item.tag}</small><h2>${item.title}</h2><p>${item.brief}</p><nav class="evidence-tabs">${["evidence", "consequence"].map(tab => `<button data-action="evidence-tab" data-tab="${tab}" class="${state.evidenceTab === tab ? "active" : ""}">${tab}</button>`).join("")}</nav>${state.evidenceTab === "evidence" ? `<ol>${item.evidence.map(text => `<li>${text}</li>`).join("")}</ol>` : `<div class="decision-consequence">${item.consequence}</div>`}<div class="decision-choices">${item.choices.map((choice, index) => `<button data-action="record-decision" data-choice="${index}" class="${saved === choice ? "chosen" : ""}"><span>${index + 1}</span>${choice}</button>`).join("")}</div><div class="decision-receipt" role="status">${saved ? `Recorded locally: ${saved}. <button data-action="undo-decision">Undo</button>` : "Choose an option to record a mock decision. You can undo it."}</div></section><aside class="desk-ledger"><h3>Work continues</h3>${workers.map(worker => `<div><i class="${worker[2]}"></i><span><b>${worker[1]}</b><small>${worker[2]} · ${worker[4]} context</small></span></div>`).join("")}<h3>Decision ledger</h3>${Object.entries(state.decisions).map(([index, choice]) => `<p>${decisions[index].tag}<br><b>${esc(choice)}</b><small>Memory only · undo available</small></p>`).join("") || "<p>No choices recorded yet.</p>"}<footer>RELEASE BOUNDARY<br>No production changes.<br>No automatic handoff.</footer></aside></div></main>`;
}

function commands() {
  if (variant === "terminal") return [
    ["focus", "Focus prompt", "i"], ["search", "Search transcript", "f"], ["sessions", "Switch session", "s"],
    ["toggle-diff", `${state.diffOpen ? "Hide" : "Show"} inline diff`, "d"], ["toggle-workers", `${state.workersOpen ? "Hide" : "Show"} workers`, "w"], ["help", "Keyboard help", "?"],
  ];
  if (variant === "desktop") return [
    ["focus", "Focus composer", ""], ["new-session", "New local session", "+"], ["desktop-files", "Open workspace files", ""],
    ["toggle-inspector", `${state.inspectorOpen ? "Close" : "Open"} inspector`, "]"], ["attach", `${state.contextAttached ? "Remove" : "Attach"} retry-policy.md`, "@"], ["help", "Keyboard shortcuts", "?"],
  ];
  return [["help", "Keyboard shortcuts", "?"]];
}
function slashCommands() {
  return [["/steer", "Queue a steering instruction"], ["/compact", "Mock compact this session"], ["/diff", "Toggle inline diff"], ["/sessions", "Open session switcher"], ["/help", "Show keyboard help"]];
}
function overlayItems() {
  if (state.overlay === "slash") return slashCommands().filter(item => item[0].startsWith(state.drafts.terminal));
  if (state.overlay === "sessions") return state.sessions.filter(item => !state.overlayQuery || item[1].toLowerCase().includes(state.overlayQuery.toLowerCase()));
  if (state.overlay === "palette") return commands().filter(item => !state.overlayQuery || item.join(" ").toLowerCase().includes(state.overlayQuery.toLowerCase()));
  return [];
}
function overlay() {
  if (!state.overlay) return "";
  if (state.overlay === "help") {
    const rows = variant === "terminal" ? [["i", "enter insert mode / focus prompt"], ["Esc", "normal mode / close overlay"], ["j / k", "select transcript block"], ["o", "expand/collapse selected tool"], ["d / w", "toggle diff / worker rail"], ["f / s / /", "find / sessions / commands"], ["↑ / ↓", "prompt history; edit to leave history"], ["Enter", "queue steering instruction"]] : variant === "desktop" ? [["⇧⌘P or ^⇧P", "command palette"], ["[ / ]", "toggle sessions / inspector"], ["F6", "move focus across workspace panes"], ["?", "this shortcut sheet"], ["Esc", "close overlay"]] : [["j / k", "next / previous decision"], ["1 / 2", "record a local choice"], ["u", "undo current decision"], ["?", "this shortcut sheet"]];
    return `<div class="proto-overlay help-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"><section><header><span>KEYBOARD MAP</span><button data-action="close">Esc ×</button></header><h2>${variant === "terminal" ? "Modal, not mouse-required." : variant === "desktop" ? "Workspace shortcuts" : "Decide, inspect, undo"}</h2><div class="help-grid">${rows.map(([key, text]) => `<kbd>${key}</kbd><span>${text}</span>`).join("")}</div><p>Prototype switcher arrows never fire while editing, using a modifier, or inside an overlay.</p></section></div>`;
  }
  if (state.overlay === "sessions") return `<div class="proto-overlay palette-overlay" role="dialog" aria-modal="true" aria-label="Switch session"><section><header>SWITCH SESSION <span>local mock</span></header><input id="overlay-input" aria-label="Filter sessions" placeholder="Type to filter sessions" value="${esc(state.overlayQuery ?? "")}"><div class="palette-list">${state.sessions.filter(session => !state.overlayQuery || session[1].toLowerCase().includes(state.overlayQuery.toLowerCase())).map((session, index) => `<button data-action="session" data-session="${session[0]}" class="${index === state.overlayIndex ? "active" : ""}"><span>${session[1][0]}</span><b>${session[1]}</b><small>${session[2]}</small></button>`).join("")}</div><footer>↑↓ select · enter open · esc close</footer></section></div>`;
  if (state.overlay === "search") return `<div class="proto-overlay search-overlay" role="dialog" aria-modal="true" aria-label="Search transcript"><section><span>find /</span><input id="overlay-input" aria-label="Search transcript" placeholder="tool, file, message…" value="${esc(state.search)}"><kbd>Esc</kbd><small>${document.querySelectorAll(".tui-block").length} blocks · live filter</small></section></div>`;
  const slash = state.overlay === "slash";
  const list = overlayItems();
  return `<div class="proto-overlay ${slash ? "slash-overlay" : "palette-overlay"}" role="dialog" aria-modal="true" aria-label="${slash ? "Slash commands" : "Command palette"}"><section>${slash ? "" : `<header>COMMAND PALETTE <span>${variant}</span></header><input id="overlay-input" aria-label="Filter commands" placeholder="Type a command" value="${esc(state.overlayQuery ?? "")}">`}<div class="palette-list">${list.map((item, index) => `<button data-action="${slash ? "slash-command" : "command"}" data-command="${item[0]}" class="${index === state.overlayIndex ? "active" : ""}"><b>${item[slash ? 0 : 1]}</b><small>${slash ? item[1] : item[0]}${!slash && item[2] ? ` · ${item[2]}` : ""}</small></button>`).join("") || "<p>No matching commands</p>"}</div>${slash ? "" : "<footer>↑↓ select · enter run · esc close</footer>"}</section></div>`;
}

function captureFocus() {
  const node = document.activeElement;
  return node?.id ? { id: node.id, start: node.selectionStart, end: node.selectionEnd } : null;
}
function render(focus = null) {
  const scrolls = [...document.querySelectorAll(".tui-scroll, .os-transcript, .inspector-body")].map(node => [node.className, node.scrollTop]);
  state.inspectorWidth = Math.min(state.inspectorWidth, maxInspectorWidth());
  document.body.dataset.prototypeVariant = variant;
  document.querySelector(".app").innerHTML = { terminal: terminalVariant, desktop: desktopVariant, dispatch: dispatchVariant }[variant]();
  document.querySelector("#prototype-overlay").innerHTML = overlay();
  const index = VARIANTS.findIndex(([key]) => key === variant);
  document.querySelector("#prototype-switcher").innerHTML = `<button data-action="cycle" data-direction="-1" aria-label="Previous prototype">←</button><span class="switcher-label"><b>${String.fromCharCode(65 + index)} · ${VARIANTS[index][1]}</b><small>MOCK · ${esc(state.lastAction)}</small></span><button data-action="cycle" data-direction="1" aria-label="Next prototype">→</button>`;
  document.querySelector("#limits-bar").innerHTML = `<span class="prototype-foot"><b>THROWAWAY ${variant.toUpperCase()}</b><span>memory only</span><span>${esc(state.lastAction)}</span></span>`;
  document.title = `THROWAWAY ${String.fromCharCode(65 + index)} · ${VARIANTS[index][1]}`;
  for (const [name, top] of scrolls) { const node = document.getElementsByClassName(name)[0]; if (node) node.scrollTop = top; }
  if (focus) {
    const node = document.getElementById(focus.id);
    if (node) { node.focus(); if (typeof focus.start === "number" && node.setSelectionRange) node.setSelectionRange(focus.start, focus.end); }
  }
}
function act(note) {
  if (variant === "terminal") state.mode = "normal";
  state.lastAction = note;
  render();
}
function setVariant(next) {
  variant = next; state.overlay = null; state.mode = "normal"; state.lastAction = `switched to ${next} · state retained in memory`;
  const url = new URL(location.href); url.searchParams.set("variant", next); history.replaceState(null, "", url);
  render();
}
function cycle(direction) {
  const index = VARIANTS.findIndex(([key]) => key === variant);
  setVariant(VARIANTS[(index + direction + VARIANTS.length) % VARIANTS.length][0]);
}
function openOverlay(name) {
  returnFocus = document.activeElement?.id;
  state.overlay = name; state.overlayIndex = 0; state.overlayQuery = ""; render();
  if (["palette", "sessions", "search"].includes(name)) document.querySelector("#overlay-input")?.focus();
  else document.querySelector("#prototype-overlay button")?.focus();
}
function focusPrompt() {
  state.overlay = null; state.mode = "insert"; render();
  const input = document.querySelector(`#${variant}-composer`); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length);
}
function selectSession(id) {
  state.activeSession = id; state.overlay = null; state.lastAction = `opened ${currentSession()[1]}`; render();
}
function runCommand(command) {
  state.overlay = null;
  if (command === "focus") return focusPrompt();
  if (command === "help" || command === "search" || command === "sessions") return openOverlay(command);
  if (command === "toggle-diff") { state.diffOpen = !state.diffOpen; return act(`inline diff ${state.diffOpen ? "shown" : "hidden"}`); }
  if (command === "toggle-workers") { state.workersOpen = !state.workersOpen; return act(`worker rail ${state.workersOpen ? "shown" : "hidden"}`); }
  if (command === "new-session") {
    const id = `new-${state.sessions.length}`; state.sessions.push([id, `Local session ${state.sessions.length - 3}`, "new · memory only"]); return selectSession(id);
  }
  if (command === "desktop-files") { state.inspector = "files"; state.inspectorOpen = true; return act("workspace files opened"); }
  if (command === "toggle-inspector") { state.inspectorOpen = !state.inspectorOpen; return act(`inspector ${state.inspectorOpen ? "opened" : "closed"}`); }
  if (command === "attach") { state.contextAttached = !state.contextAttached; return act(`@retry-policy.md ${state.contextAttached ? "attached" : "removed"}`); }

}
function runSlash(command) {
  state.drafts.terminal = ""; state.overlay = null; state.mode = "insert";
  if (command === "/steer") { state.drafts.terminal = "Please prioritize "; render(); return focusPrompt(); }
  if (command === "/compact") { state.compacted = true; act("mock compaction complete · 84.2k → 31.8k"); return focusPrompt(); }
  if (command === "/diff") { state.diffOpen = !state.diffOpen; render(); return focusPrompt(); }
  if (command === "/sessions") return openOverlay("sessions");
  if (command === "/help") return openOverlay("help");
}
function toast(note) {
  const node = document.querySelector("#toast"); node.textContent = `${note} · mock only`; node.classList.add("visible");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("visible"), 2200);
}

// Static host markup is only a mount point now; each model owns the whole viewport.
document.querySelector("footer").insertAdjacentHTML("afterend", '<div id="prototype-overlay"></div><nav id="prototype-switcher" aria-label="Prototype variants" aria-live="polite"></nav>');
render();

document.addEventListener("click", event => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "cycle") return cycle(Number(target.dataset.direction));
  if (action === "close") { state.overlay = null; return render(returnFocus ? { id: returnFocus } : null); }
  if (action === "help" || action === "search" || action === "sessions") return openOverlay(action);
  if (action === "palette") return openOverlay("palette");
  if (action === "session") return selectSession(target.dataset.session);
  if (action === "command") return runCommand(target.dataset.command);
  if (action === "slash-command") return runSlash(target.dataset.command);
  if (action === "tool") {
    const index = Number(target.dataset.tool); state.selectedBlock = index;
    state.toolOpen.has(index) ? state.toolOpen.delete(index) : state.toolOpen.add(index);
    return act(`tool ${index + 1} ${state.toolOpen.has(index) ? "expanded" : "collapsed"}`);
  }
  if (action === "unqueue") { const [removed] = state.queued.splice(Number(target.dataset.index), 1); return act(`removed queued steer: ${removed}`); }
  if (action === "decision") { state.decisions[0] = decisions[0].choices[0]; return act("choice recorded locally · no worker notified"); }
  if (action === "decision-compare") { state.decisionIndex = 0; state.evidenceTab = "consequence"; return setVariant("dispatch"); }
  if (action === "worker") return act(`selected ${workers[Number(target.dataset.worker)][1]} · read-only process`);
  if (action === "desktop-view") { state.desktopView = target.dataset.view; if (state.desktopView === "sessions") state.sidebarOpen = true; if (state.desktopView === "files") { state.inspector = "files"; state.inspectorOpen = true; } return act(`${state.desktopView} destination opened`); }
  if (action === "new-session") return runCommand("new-session");
  if (action === "toggle-running") { state.running = !state.running; return act(state.running ? "mock workers resumed" : "mock workspace paused"); }
  if (action === "toggle-sidebar") { state.sidebarOpen = !state.sidebarOpen; return act(`session sidebar ${state.sidebarOpen ? "opened" : "closed"}`); }
  if (action === "toggle-inspector") return runCommand("toggle-inspector");
  if (action === "inspector") { state.inspector = target.dataset.inspector; return act(`${state.inspector} inspector selected`); }
  if (action === "inspector-diff" || action === "inspector-next") { state.selectedFile = action === "inspector-next" ? "host.ts" : "app.js"; state.inspector = "diff"; state.inspectorOpen = true; return act("working diff inspector opened"); }
  if (action === "desktop-worker") { state.inspector = "activity"; state.inspectorOpen = true; return act("worker activity opened in inspector"); }
  if (action === "diff-file") { state.selectedFile = target.dataset.file; state.inspector = "diff"; return act(`${state.selectedFile} diff opened`); }
  if (action === "file") { state.selectedFile = target.dataset.file; state.inspector = "files"; return act(`${target.dataset.file} preview opened`); }
  if (action === "attach") return runCommand("attach");
  if (action === "model") { state.model = state.model.startsWith("Opus") ? "Sonnet 4.6 · high" : "Opus 4.6 · high"; return act(`mock model selected: ${state.model}`); }
  if (action === "compact") { state.compacted = true; return act("mock context compacted · 91.6k → 34.1k"); }
  if (action === "workspace-menu" || action === "project-switch") return act("workspace: Mari / Release 2.4 · only mock workspace");
  if (action === "settings") return act("settings unavailable in throwaway · no controls changed");
  if (action === "select-decision") { state.decisionIndex = Number(target.dataset.index); return act("decision selected"); }
  if (action === "evidence-tab") { state.evidenceTab = target.dataset.tab; return act(`${state.evidenceTab} opened`); }
  if (action === "record-decision") return recordDecision(Number(target.dataset.choice));
  if (action === "undo-decision") { delete state.decisions[state.decisionIndex]; return act("local decision undone"); }
});
document.addEventListener("input", event => {
  const focus = captureFocus();
  if (event.target.matches("[data-compose] textarea")) {
    const kind = event.target.closest("[data-compose]").dataset.compose;
    state.drafts[kind] = event.target.value; state.historyIndex = null;
    if (kind === "terminal" && event.target.value.startsWith("/") && !event.target.value.includes(" ")) {
      state.overlay = "slash"; returnFocus = "terminal-composer"; state.overlayIndex = 0; render(focus);
    } else if (state.overlay === "slash") { state.overlay = null; render(focus); }
  }
  if (event.target.id === "overlay-input") {
    if (state.overlay === "search") state.search = event.target.value;
    else state.overlayQuery = event.target.value;
    state.overlayIndex = 0; render(focus);
  }
  if (event.target.id === "session-filter") { state.sessionFilter = event.target.value; render(focus); }
});
document.addEventListener("submit", event => {
  const form = event.target.closest("[data-compose]");
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.compose, text = state.drafts[kind].trim();
  if (!text) return toast("Empty prompt");
  state.history.push(text); state.historyIndex = null; state.drafts[kind] = ""; state.overlay = null;
  if (kind === "terminal") { state.queued.push(text); state.lastAction = `queued steer #${state.queued.length} · not delivered`; }
  else { state.sent.push({ session: state.activeSession, text }); state.lastAction = "mock message appended locally · no model call"; }
  render(); focusPrompt();
  const transcript = document.querySelector(".os-transcript"); if (transcript) transcript.scrollTop = transcript.scrollHeight;
});
document.addEventListener("keydown", event => {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    if (state.overlay) { state.overlay = null; if (state.search) state.search = ""; render(returnFocus ? { id: returnFocus } : null); }
    else if (editable(event.target)) { state.mode = "normal"; event.target.blur(); render(); }
    event.preventDefault(); return;
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "p") { event.preventDefault(); return openOverlay("palette"); }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (state.overlay) {
    if (event.key === "Tab" && state.overlay !== "slash") {
      const nodes = [...document.querySelectorAll("#prototype-overlay input, #prototype-overlay button")];
      event.preventDefault(); if (nodes.length) nodes[(nodes.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length].focus(); return;
    }
    if (event.key === "Enter" && event.target.closest(".palette-list button")) { event.preventDefault(); event.target.closest("button").click(); return; }
    const list = overlayItems();
    if (["ArrowDown", "ArrowUp"].includes(event.key) && list.length) { event.preventDefault(); state.overlayIndex = (state.overlayIndex + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length; return render(captureFocus()); }
    if ((event.key === "Enter" || event.key === "Tab" && state.overlay === "slash") && list.length) {
      event.preventDefault(); const item = list[state.overlayIndex] ?? list[0];
      return state.overlay === "slash" ? runSlash(item[0]) : state.overlay === "palette" ? runCommand(item[0]) : selectSession(item[0]);
    }
    return;
  }
  if (event.key === "F6" && variant === "desktop") {
    event.preventDefault(); const panes = ["#session-filter", "#desktop-composer", "#inspector-resize"].map(selector => document.querySelector(selector)).filter(node => node && node.getBoundingClientRect().width);
    panes[(panes.indexOf(document.activeElement) + 1) % panes.length]?.focus(); return;
  }
  if (event.target.id === "inspector-resize" && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
    event.preventDefault(); state.inspectorWidth = Math.max(290, Math.min(maxInspectorWidth(), state.inspectorWidth + (event.key === "ArrowLeft" ? 20 : -20))); state.lastAction = `inspector width ${state.inspectorWidth}px`; return render({ id: "inspector-resize" });
  }
  if (editable(event.target)) {
    if (event.target.matches("[data-compose] textarea")) {
      const kind = event.target.closest("[data-compose]").dataset.compose;
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); return event.target.closest("form").requestSubmit(); }
      if (kind === "terminal" && event.key === "ArrowUp" && (!event.target.value || state.historyIndex !== null) && state.history.length) { event.preventDefault(); state.historyIndex = state.historyIndex === null ? state.history.length - 1 : Math.max(0, state.historyIndex - 1); state.drafts.terminal = state.history[state.historyIndex]; return render({ id: "terminal-composer", start: state.drafts.terminal.length, end: state.drafts.terminal.length }); }
      if (kind === "terminal" && event.key === "ArrowDown" && state.historyIndex !== null) { event.preventDefault(); state.historyIndex++; if (state.historyIndex >= state.history.length) state.historyIndex = null; state.drafts.terminal = state.historyIndex === null ? "" : state.history[state.historyIndex]; return render({ id: "terminal-composer", start: state.drafts.terminal.length, end: state.drafts.terminal.length }); }
    }
    return;
  }
  if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.target.closest("button, [role=separator], [type=range]") && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); return cycle(event.key === "ArrowLeft" ? -1 : 1); }
  if (event.key === "?") { event.preventDefault(); return openOverlay("help"); }
  if (variant === "terminal") {
    if (event.key === "/") { event.preventDefault(); return openOverlay("palette"); }
    if (event.key === "y") { event.preventDefault(); state.decisionIndex = 0; return recordDecision(0); }
    if (event.key === "n") { event.preventDefault(); state.decisionIndex = 0; state.evidenceTab = "consequence"; return setVariant("dispatch"); }
    if (event.key === "i") { event.preventDefault(); return focusPrompt(); }
    if (event.key === "f") { event.preventDefault(); return openOverlay("search"); }
    if (event.key === "s") { event.preventDefault(); return openOverlay("sessions"); }
    if (event.key === "d") { event.preventDefault(); return runCommand("toggle-diff"); }
    if (event.key === "w") { event.preventDefault(); return runCommand("toggle-workers"); }
    if (["j", "k"].includes(event.key)) { event.preventDefault(); const order = [...document.querySelectorAll(".tui-block[data-block]")].map(node => Number(node.dataset.block)); state.selectedBlock = order[(order.indexOf(state.selectedBlock) + (event.key === "j" ? 1 : -1) + order.length) % order.length]; render(); return document.querySelector(`[data-block="${state.selectedBlock}"]`)?.scrollIntoView({ block: "nearest" }); }
    if (event.key === "o") { event.preventDefault(); const index = state.selectedBlock; if (![0, 1, 2].includes(index)) return toast("Select a tool block with j/k"); state.toolOpen.has(index) ? state.toolOpen.delete(index) : state.toolOpen.add(index); return act(`tool ${index + 1} ${state.toolOpen.has(index) ? "expanded" : "collapsed"}`); }
  } else if (variant === "desktop") {
    if (event.key === "+") { event.preventDefault(); return runCommand("new-session"); }
    if (event.key === "@") { event.preventDefault(); return runCommand("attach"); }
    if (event.key === "[") { event.preventDefault(); state.sidebarOpen = !state.sidebarOpen; return act(`session sidebar ${state.sidebarOpen ? "opened" : "closed"}`); }
    if (event.key === "]") { event.preventDefault(); return runCommand("toggle-inspector"); }

  } else {
    if (["j", "k"].includes(event.key)) { event.preventDefault(); state.decisionIndex = (state.decisionIndex + 1) % decisions.length; return act("decision selected"); }
    if (["1", "2"].includes(event.key)) { event.preventDefault(); return recordDecision(Number(event.key) - 1); }
    if (event.key === "u") { delete state.decisions[state.decisionIndex]; return act("local decision undone"); }
  }
});
document.addEventListener("pointerdown", event => {
  if (event.target.id !== "inspector-resize") return;
  event.preventDefault(); state.resizeStart = { x: event.clientX, width: state.inspectorWidth }; event.target.setPointerCapture(event.pointerId);
});
document.addEventListener("pointermove", event => {
  if (!state.resizeStart) return;
  state.inspectorWidth = Math.max(290, Math.min(maxInspectorWidth(), state.resizeStart.width + state.resizeStart.x - event.clientX));
  const pane = document.querySelector(".desktop-inspector"); if (pane) pane.style.width = `${state.inspectorWidth}px`;
});
document.addEventListener("pointerup", () => { if (state.resizeStart) { state.resizeStart = null; act(`inspector width ${state.inspectorWidth}px`); } });
function recordDecision(choice) {
  state.decisions[state.decisionIndex] = decisions[state.decisionIndex].choices[choice];
  act("decision recorded in memory · nothing sent");
}
function maxInspectorWidth() {
  return Math.max(290, Math.min(560, innerWidth - 58 - (state.sidebarOpen && innerWidth > 1000 ? 220 : 0) - 300 - 5));
}
window.addEventListener("resize", () => render(captureFocus()));
document.addEventListener("focusin", event => {
  if (event.target.id === "terminal-composer" && state.mode !== "insert") {
    state.mode = "insert"; render(captureFocus());
  }
});
