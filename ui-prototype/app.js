const variants = ["desk", "board", "inbox"];
const names = { desk: "Command desk", board: "Work board", inbox: "Decision inbox" };
const labels = { running: "Running", queued: "Queued", paused: "Paused", question: "Decision", review: "Review ready", done: "Complete" };
const app = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
let variant = new URL(location.href).searchParams.get("variant") || "desk";
if (!variants.includes(variant)) variant = "desk";
let projects = makeProjects();
let projectId = "keyboard";
let selected = "locale-scope";
let tab = "summary";
let filter = "all";
let sheet = false;
let draft = "";
let toastTimer;

function render() {
  document.body.dataset.variant = variant;
  document.title = `Pi Projects · ${names[variant]}`;
  app.innerHTML = topBar() + ({ desk: commandDesk, board: workBoard, inbox: decisionInbox }[variant])();
  document.querySelector("#switcher").innerHTML = `
    <button data-action="cycle" data-step="-1" aria-label="Previous variant">←</button>
    ${variants.map((key, i) => `<button data-action="variant" data-variant="${key}" ${key === variant ? 'aria-current="page"' : ""}>${i + 1} · ${names[key]}</button>`).join("")}
    <button data-action="cycle" data-step="1" aria-label="Next variant">→</button>
    <span class="divider"></span><span class="switch-note">SIMULATION ONLY</span>`;
}

function topBar() {
  return `<header class="shell-top">
    <div><span class="brand">pi / projects</span><span class="trial">UI PROTOTYPE · ${esc(names[variant])}</span></div>
    <div class="row"><button class="small ghost" data-action="state">Scenario state</button>
      <button class="small" data-action="advance" ${running().length ? "" : "disabled"}>Finish demo run</button>
      <button class="small ghost" data-action="reset">Reset</button></div>
  </header>`;
}

function projectPicker() {
  return `<label><span class="eyebrow">Project</span><select class="project-picker" aria-label="Select project" data-project-picker>
    ${Object.values(projects).map(p => `<option value="${p.id}" ${p.id === projectId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
  </select></label>`;
}

function commandDesk() {
  const p = project();
  const tasks = visibleTasks();
  const task = p.tasks.find(t => t.id === selected);
  return `<main class="desk">
    <div class="desk-heading row between"><div><h1>${esc(p.name)}</h1><small class="mono">${esc(p.workspace)} · selected checkout · one writer</small></div>${projectPicker()}</div>
    <div class="desk-frame">
      <aside class="desk-nav">
        <div class="eyebrow">Workspace</div>
        ${[["all", "All work", p.tasks.length], ["attention", "Needs you", attention().length], ["evidence", "Evidence", p.tasks.filter(t => t.evidence).length], ["notes", "Shared notes", p.notes.length]].map(([key, title, count]) => `<button class="nav-item ${filter === key ? "active" : ""}" data-action="filter" data-filter="${key}"><span>${title}</span><span>${count}</span></button>`).join("")}
        <div class="nav-divider"></div>
        <div class="eyebrow">Coordinator</div><div class="note"><span class="note-title mono">gpt-5.6-sol</span>Delegates and gathers results. Your message box stays available while workers run.</div>
        <div class="nav-divider"></div>
        <div class="note"><span class="note-title">No chat flood</span>Workers live in the inspector. Decisions have their own place.</div>
      </aside>
      <section class="desk-tasks" aria-label="Project tasks">
        <div class="panel-head row between"><span>${filter === "notes" ? "SHARED KNOWLEDGE" : "TASKS / " + tasks.length}</span><small>j / k to select</small></div>
        ${filter === "notes" ? p.notes.map((note, index) => `<button class="task-row" data-action="note" data-index="${index}"><small>NOTE ${String(index + 1).padStart(2, "0")}</small><span class="task-title">${esc(note)}</span></button>`).join("") : tasks.map(t => `<button class="task-row ${selected === t.id ? "selected" : ""}" data-action="select" data-id="${t.id}" ${selected === t.id ? 'aria-pressed="true"' : 'aria-pressed="false"'}><div class="row">${badge(t)}<small>${esc(t.run)}</small></div><strong class="task-title">${esc(t.title)}</strong><small>${esc(t.role)} · ${esc(t.model)}</small></button>`).join("") || '<div class="empty"><strong>Nothing here yet.</strong>Choose another view.</div>'}
      </section>
      <section class="desk-inspector" aria-label="Task inspector">${filter === "notes" ? `<div class="eyebrow">Project memory</div><h2>Notes survive the conversation.</h2><p class="description">In this trial, all notes are simulated and reset on reload.</p>${p.notes.map(n => `<div class="block" style="margin-bottom:12px"><p style="margin:0">${esc(n)}</p></div>`).join("")}` : task && tasks.some(t => t.id === task.id) ? detail(task) : '<div class="empty"><strong>Select a task.</strong>Read its transcript, steer it, or inspect evidence.</div>'}</section>
    </div>
    <section class="desk-command" aria-label="Coordinator chat"><form data-compose><div class="composer"><span class="prompt-mark">›</span><textarea aria-label="Message coordinator" name="message" placeholder="Ask the coordinator to implement something, or change the plan…" required>${esc(draft)}</textarea><button class="primary" type="submit">Send</button></div></form><div class="notice">Coordinator messages become tasks in this simulation. No worker is launched.</div></section>
    <div class="bottom-note"><span>${esc(p.events[0].text)}</span><span>/ to focus prompt · ← / → to compare layouts</span></div>
  </main>`;
}

function workBoard() {
  const p = project();
  const lanes = [["planned", "Planned", ["queued", "paused"]], ["running", "Running", ["running"]], ["attention", "Needs you", ["question", "review"]], ["done", "Complete", ["done"]]];
  const task = p.tasks.find(t => t.id === selected);
  return `<main class="board-wrap">
    <div class="board-heading"><div class="row between"><div><div class="eyebrow">Project workspace</div><h1>${esc(p.name)}</h1><small>${esc(p.workspace)} · no automatic worktrees</small></div><div class="row">${projectPicker()}<button class="primary" data-action="compose">+ New task</button></div></div></div>
    <div class="board-summary"><div class="stats"><div><strong>${running().length}</strong><small>running writer</small></div><div><strong>${attention().length}</strong><small>need your input</small></div><div><strong>${p.tasks.filter(t => t.status === "done").length}</strong><small>complete</small></div></div><span class="notice">One writer per checkout. Scouts and reviewers can run alongside it.</span></div>
    <div class="board-grid">
      ${lanes.map(([key, title, statuses]) => {
        const tasks = p.tasks.filter(t => statuses.includes(t.status));
        return `<section class="lane" data-lane="${key}" aria-label="${title}"><div class="lane-head"><h2>${title}</h2><span>${tasks.length}</span></div>${tasks.map(t => `<article class="board-card ${["question", "review"].includes(t.status) ? "attention" : ""}" tabindex="0" role="button" aria-label="Inspect ${esc(t.title)}" data-action="inspect" data-id="${t.id}" draggable="${["running", "queued", "paused"].includes(t.status)}">${badge(t)}<h3>${esc(t.title)}</h3><p>${esc(t.hint)}</p><div class="card-footer row between"><span class="row"><span class="avatar">${esc(t.role[0].toUpperCase())}</span>${esc(t.role)}</span><small>${t.evidence ? "2 artifacts" : esc(t.run)}</small></div></article>`).join("")}${key === "planned" ? '<button class="board-add" data-action="compose">+ Add a task</button>' : ""}</section>`;
      }).join("")}
    </div>
    <p class="board-tip">Try dragging a writer to Running or Planned. Decisions and results use explicit actions in their details.</p>
    <div class="board-activity"><section class="block"><h2>Coordinator</h2>${composer("Tell it what should happen next…")}<div class="notice">Simulated messages. Workers never receive these.</div></section><section class="block"><h2>Recent activity</h2>${feed(4)}</section></div>
    ${sheet && task ? `<button class="board-backdrop" data-action="close-sheet" aria-label="Close task details"></button><aside class="board-detail" aria-label="Task details"><button class="close small" data-action="close-sheet">Close</button>${detail(task)}</aside>` : ""}
  </main>`;
}

function decisionInbox() {
  const tasks = attention();
  const p = project();
  const task = tasks.find(t => t.id === selected) || tasks[0];
  return `<main class="inbox-wrap">
    <header class="inbox-heading"><div><div class="eyebrow">${esc(p.name)} / decision inbox</div><h1>${tasks.length ? `${tasks.length} things need your call.` : "Nothing needs your call."}</h1><p>${tasks.length ? "The coordinator is holding these questions and results for you. Everything else can stay out of the way." : "You have cleared the inbox. Check the current work or give the coordinator a new goal."}</p></div><div class="row">${projectPicker()}</div></header>
    <div class="inbox-layout"><section>
      <div class="inbox-queue">${tasks.map((t, index) => `<button class="inbox-item ${task.id === t.id ? "active" : ""}" data-action="select" data-id="${t.id}"><span class="index">${String(index + 1).padStart(2, "0")}</span><span class="item-body"><strong>${esc(t.title)}</strong><small>${t.status === "question" ? "A decision before the next verification" : "A result ready for your review"}</small></span><span class="arrow">↗</span></button>`).join("")}</div>
      ${task ? `<article class="inbox-letter"><div class="row between"><span class="eyebrow">${task.status === "question" ? "From your coordinator" : "From your reviewer"}</span>${badge(task)}</div><h2 class="detail-title">${esc(task.title)}</h2>${task.status === "question" ? decision(task) : `<p>${esc(task.description)}</p>${artifacts(task)}<div class="row"><button class="primary" data-action="accept" data-id="${task.id}">Accept result</button><button data-action="revise" data-id="${task.id}">Request changes</button></div><p class="notice" style="margin-top:12px">Accepting closes this review. It does not merge, commit, or publish.</p>`}<p class="signoff">${esc(task.status === "question" ? "Coordinator · gpt-5.6-sol" : "Reviewer · gpt-5.6-sol")} · simulated</p></article>` : '<div class="inbox-done"><h2>You are caught up.</h2><p>Use "Finish demo run" to create the next review request.</p><button data-action="variant" data-variant="board">See the work board</button></div>'}
      <section class="inbox-compose"><h2>A new goal or a change of direction</h2>${composer("Tell the coordinator what you want next…")}</section>
    </section><aside class="inbox-aside">
      <h2>While you decide</h2>${p.tasks.filter(t => ["running", "queued", "paused"].includes(t.status)).map(t => `<div class="running-task">${badge(t)}<strong>${esc(t.title)}</strong><small>${esc(t.hint)}</small><br><button class="small ghost" data-action="peek" data-id="${t.id}">Inspect worker ↗</button></div>`).join("") || '<p class="note">No workers are running.</p>'}
      <hr><h2>Recent outcomes</h2>${p.tasks.filter(t => t.status === "done").slice(-3).map(t => `<div class="running-task"><strong>${esc(t.title)}</strong><button class="small ghost" data-action="peek" data-id="${t.id}">Read result ↗</button></div>`).join("") || '<p class="note">No accepted results yet.</p>'}
      <hr><h2>Project memory</h2><p class="note">${esc(p.notes.at(-1))}</p><button class="small ghost" data-action="notes">Read all ${p.notes.length} notes ↗</button>
      <hr><p class="note">Selected checkout. One writer at a time. The Mac must stay awake for real work.</p>
    </aside></div>
  </main>`;
}

function detail(t) {
  const contents = {
    summary: () => t.status === "question" ? decision(t) : `<p class="description">${esc(t.description)}</p><div class="fact-row"><span>Worker</span><span>${esc(t.role)} · ${esc(t.model)}</span></div><div class="fact-row"><span>Run</span><span class="mono">${esc(t.run)}</span></div><div class="fact-row"><span>Checkout</span><span>Selected workspace, no worktree allocation</span></div><div class="fact-row"><span>State</span><span>${esc(t.hint)}</span></div>${t.status === "review" ? `<div class="decision" style="margin-top:18px"><p>Review the sample evidence, then close this result or ask for another pass.</p><div class="row"><button class="primary" data-action="accept" data-id="${t.id}">Accept result</button><button data-action="revise" data-id="${t.id}">Request changes</button></div><small>Accepting does not merge or publish.</small></div>` : ""}`,
    transcript: () => t.log.map(l => `<div class="log-line"><div class="stamp">${esc(l.time)} / ${esc(l.actor)}</div><p>${esc(l.text)}</p></div>`).join(""),
    evidence: () => t.evidence ? artifacts(t) : '<div class="empty"><strong>No evidence yet.</strong>Finish the demo run to produce sample artifacts.</div>'
  };
  return `${badge(t)}<h2 class="detail-title">${esc(t.title)}</h2><div class="detail-actions row">${t.status === "running" ? `<button class="primary small" data-action="steer" data-id="${t.id}">Steer worker</button><button class="small danger" data-action="stop" data-id="${t.id}">Stop worker</button>` : ["queued", "paused"].includes(t.status) ? `<button class="primary small" data-action="start" data-id="${t.id}">${t.status === "paused" ? "Resume" : "Start when free"}</button><button class="small" data-action="steer" data-id="${t.id}">Add instruction</button>` : ""}</div><div class="tabs" role="tablist" aria-label="Task views">${["summary", "transcript", "evidence"].map(key => `<button class="${tab === key ? "active" : ""}" role="tab" aria-selected="${tab === key}" data-action="tab" data-tab="${key}" data-id="${t.id}">${key[0].toUpperCase() + key.slice(1)}</button>`).join("")}</div><section role="tabpanel">${contents[tab]()}</section>`;
}

function decision(t) {
  return `<div class="decision"><p>${esc(t.description)}</p><div class="stack">${t.choices.map((choice, index) => `<button class="${index === 0 ? "primary" : ""}" data-action="answer" data-id="${t.id}" data-choice="${index}">${esc(choice)}</button>`).join("")}<button class="ghost" data-action="custom-answer" data-id="${t.id}">Write a different answer…</button></div></div>`;
}

function artifacts(t) {
  return `<button class="artifact" data-action="artifact" data-id="${t.id}" data-file="report"><span class="file-icon">JSON</span><span><strong>e2e/report.json</strong><small>Sample verification assertions</small></span></button><button class="artifact" data-action="artifact" data-id="${t.id}" data-file="capture"><span class="file-icon">TXT</span><span><strong>${projectId === "keyboard" ? "e2e/host-field.txt" : "e2e/worker-stop.txt"}</strong><small>${projectId === "keyboard" ? "Sample captured text and locale" : "Sample stop receipt"}</small></span></button>`;
}

function composer(placeholder) {
  return `<form data-compose><div class="stack"><textarea name="message" aria-label="Message coordinator" placeholder="${esc(placeholder)}" required>${esc(draft)}</textarea><div class="row between"><small>Simulated · no live connection</small><button class="primary" type="submit">Send to coordinator</button></div></div></form>`;
}

function feed(limit) {
  return `<div class="feed">${project().events.slice(0, limit).map(e => `<div class="feed-line"><time>${esc(e.time)}</time><span>${esc(e.text)}</span></div>`).join("")}</div>`;
}

function badge(t) {
  return `<span class="badge status-${t.status}"><span class="dot ${t.status}"></span>${labels[t.status]}</span>`;
}

function switchVariant(key) {
  variant = key;
  sheet = false;
  closeDialog();
  const url = new URL(location.href);
  url.searchParams.set("variant", key);
  history.replaceState(null, "", url);
  render();
  window.scrollTo(0, 0);
}

function handleAction(button) {
  const action = button.dataset.action;
  const t = project().tasks.find(t => t.id === button.dataset.id);
  switch (action) {
    case "variant": switchVariant(button.dataset.variant); break;
    case "cycle": switchVariant(variants[(variants.indexOf(variant) + Number(button.dataset.step) + variants.length) % variants.length]); break;
    case "select": selected = t.id; tab = "summary"; render(); break;
    case "inspect": selected = t.id; tab = "summary"; sheet = true; render(); document.querySelector(".board-detail .close").focus(); break;
    case "close-sheet": sheet = false; render(); break;
    case "filter": filter = button.dataset.filter; selected = visibleTasks()[0]?.id || ""; tab = "summary"; render(); break;
    case "tab": tab = button.dataset.tab; render(); if (dialog.open) dialog.querySelector(".dialog-body").innerHTML = detail(t); break;
    case "peek": selected = t.id; tab = "transcript"; showDialog("Worker inspector", detail(t)); break;
    case "steer": case "revise": case "custom-answer": messageDialog(action, t); break;
    case "stop": t.status = "paused"; t.hint = "Stopped by you. Resume explicitly."; addLog(t, "You", "Stop requested. Partial work stays in the checkout."); event(`Stopped: ${t.title}`); startNext(); render(); toast("Worker stopped in the simulation. Partial work is kept."); if (dialog.open) dialog.querySelector(".dialog-body").innerHTML = detail(t); break;
    case "start": t.status = "queued"; t.hint = "Waiting for the writer slot."; startNext(); render(); toast(t.status === "running" ? "Worker resumed in the simulation." : "Queued. The current writer keeps its slot."); if (dialog.open) dialog.querySelector(".dialog-body").innerHTML = detail(t); break;
    case "answer": answer(t, t.choices[Number(button.dataset.choice)]); break;
    case "accept": t.status = "done"; t.hint = "You accepted the result. Nothing was merged."; addLog(t, "You", "Accepted the sample E2E result."); project().notes.push(`Accepted result: ${t.title}. Evidence stays attached to the task.`); event(`Accepted: ${t.title}`); render(); toast("Result accepted. No commit, merge, or publish."); closeDialog(); break;
    case "artifact": showArtifact(t, button.dataset.file); break;
    case "compose": showDialog("Give the coordinator a goal", composer("Describe an implementation or a change of plan…")); dialog.querySelector("textarea").focus(); break;
    case "notes": showDialog("Shared project notes", project().notes.map(n => `<div class="block" style="margin-bottom:12px">${esc(n)}</div>`).join("")); break;
    case "note": showDialog("Shared project note", `<p>${esc(project().notes[Number(button.dataset.index)])}</p>`); break;
    case "state": showDialog("Scenario state", `<p class="dialog-description">This is the full simulated state for the current project. Nothing here connects to the Projects host.</p><pre>${esc(JSON.stringify({ variant, selected, ...project() }, null, 2))}</pre>`); break;
    case "advance": advance(); break;
    case "reset": projects = makeProjects(); selected = project().tasks.find(t => t.status === "question")?.id || project().tasks[0].id; tab = "summary"; filter = "all"; sheet = false; draft = ""; closeDialog(); render(); toast("Scenario reset. Switching layouts will keep your next changes."); break;
    case "close-dialog": closeDialog(); break;
  }
}

function messageDialog(action, t) {
  const titles = { steer: "Steer this worker", revise: "Request another pass", "custom-answer": "Answer the coordinator" };
  showDialog(titles[action], `<p class="dialog-description">${esc(t.title)} · ${esc(t.run)}</p><form data-task-message data-id="${t.id}" data-mode="${action}"><textarea name="message" aria-label="${titles[action]}" placeholder="${action === "revise" ? "What should change before you accept this result?" : "Write your instruction…"}" required></textarea><div class="dialog-footer row"><button class="primary" type="submit">Send</button><button type="button" data-action="close-dialog">Cancel</button></div></form>`);
  dialog.querySelector("textarea").focus();
}

function showArtifact(t, file) {
  const keyboard = projectId === "keyboard";
  const assertions = keyboard ? ["Russian remains selected after relaunch", "Host field receives expected text"] : ["Stopped worker has a terminal receipt", "Controls survive reconnect"];
  const capture = keyboard ? "SIMULATED EVIDENCE\n\nHost app: keyboard debug field\nLocale: ru-RU\nExpected text: привет\nCaptured text: привет\n\nThis is a text fixture, not a real Simulator capture." : "SIMULATED EVIDENCE\n\nRun: worker-a17\nStop requested: yes\nTerminal receipt: stopped\nReconnect: controls restored\n\nNo real worker was stopped.";
  const content = file === "report" ? JSON.stringify({ simulated: true, task: t.title, status: "pass", assertions: assertions.map(name => ({ name, pass: true })), note: "No real test ran. This evidence is fictional." }, null, 2) : capture;
  const path = file === "report" ? "e2e/report.json" : keyboard ? "e2e/host-field.txt" : "e2e/worker-stop.txt";
  showDialog(path, `<p class="dialog-description">Simulated artifact for ${esc(t.title)}. This is what an inspectable result could look like.</p><pre>${esc(content)}</pre>`);
}

function answer(t, text) {
  t.status = "done";
  t.hint = text;
  addLog(t, "You", text);
  project().notes.push(`Decision: ${text}`);
  event(`Decision recorded: ${text}`);
  closeDialog(); render(); toast("Decision recorded in the simulated shared notes.");
}

function advance() {
  const t = running()[0];
  if (!t) return;
  t.status = "review"; t.evidence = true;
  t.hint = "Verification finished. Review the result.";
  addLog(t, "Worker", "Sample verification passed. Attached report.json and host-field.txt.");
  event(`Ready for review: ${t.title}`);
  startNext();
  render(); toast("Demo run finished. Evidence is ready; the next writer can start.");
}

function startNext() {
  if (running().length) return;
  const next = project().tasks.find(t => t.status === "queued");
  if (!next) return;
  next.status = "running"; next.hint = "Writer slot acquired. Implementing the task.";
  addLog(next, "Coordinator", "The previous writer ended. Starting this queued task.");
  event(`Started: ${next.title}`);
}

function showDialog(title, content) {
  if (dialog.open) dialog.close();
  dialog.innerHTML = `<div class="row between"><h2 id="dialog-title">${esc(title)}</h2><button class="small" data-action="close-dialog" aria-label="Close dialog">Close</button></div><div class="dialog-body">${content}</div>`;
  dialog.showModal();
}
function closeDialog() { if (dialog.open) dialog.close(); }
function toast(text) { clearTimeout(toastTimer); const node = document.querySelector("#toast"); node.textContent = text; node.classList.add("visible"); toastTimer = setTimeout(() => node.classList.remove("visible"), 3800); }
function project() { return projects[projectId]; }
function attention() { return project().tasks.filter(t => ["question", "review"].includes(t.status)); }
function running() { return project().tasks.filter(t => t.status === "running"); }
function visibleTasks() { return project().tasks.filter(t => filter === "attention" ? ["question", "review"].includes(t.status) : filter === "evidence" ? t.evidence : true); }
function clock() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }); }
function event(text) { project().events.unshift({ time: clock(), text }); }
function addLog(t, actor, text) { t.log.push({ time: clock(), actor, text }); }
function esc(value) { return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

function makeProjects() {
  const keyboard = {
    id: "keyboard", name: "Yandex Keyboard", workspace: "arcadia / keyboard / ios",
    notes: ["Verify inserted text in the host field, not only the keyboard view.", "Keep the current layout when restoring a locale. Do not publish from workers."],
    events: [{ time: "10:42", text: "Coordinator is waiting for your locale-scope decision." }, { time: "10:40", text: "Worker is checking locale restoration in the selected checkout." }, { time: "10:38", text: "Previous verification result is ready for review." }],
    tasks: [
      { id: "locale-scope", title: "Which locales should the E2E cover?", status: "question", role: "coordinator", model: "gpt-5.6-sol", run: "decision-02", hint: "Choose a verification scope.", description: "The first run can cover English and Russian, or all installed locales. The full matrix costs more Simulator time. Which scope do you want?", choices: ["English + Russian first", "All installed locales"], evidence: false, log: [{ time: "10:42", actor: "Coordinator", text: "Before verification, I need a scope decision. The implementation can continue meanwhile." }] },
      { id: "locale-code", title: "Restore the chosen keyboard locale", status: "running", role: "worker", model: "gpt-5.6-terra", run: "worker-a17", hint: "Checking restoration after relaunch.", description: "Persist the selected locale and restore it when the extension restarts. Keep layout selection unchanged. Return repeatable E2E evidence.", evidence: false, log: [{ time: "10:36", actor: "Coordinator", text: "Implement locale restoration. One writer, current checkout, no VCS mutations." }, { time: "10:39", actor: "Worker", text: "Read locale state and extension initialization. The default locale currently replaces the saved choice." }, { time: "10:40", actor: "Worker", text: "Updated restoration order. Preparing a relaunch verification." }] },
      { id: "locale-e2e", title: "Add a relaunch regression scenario", status: "queued", role: "worker", model: "gpt-5.6-terra", run: "queued-b04", hint: "Waiting for the writer slot.", description: "Use the approved locale matrix. Run a relaunch scenario and capture the text inserted into the host field. Keep the evidence repeatable.", evidence: false, log: [{ time: "10:40", actor: "Coordinator", text: "Queued behind the implementation writer. Do not edit the checkout concurrently." }] },
      { id: "locale-evidence", title: "Review the baseline typing check", status: "review", role: "reviewer", model: "gpt-5.6-sol", run: "review-c09", hint: "Two sample artifacts are ready.", description: "The baseline typing check produced a report and a captured host-field value. Inspect the evidence, then accept it or request another pass. This does not merge the implementation.", evidence: true, log: [{ time: "10:34", actor: "Worker", text: "Sample baseline check completed. Captured host field text: привет." }, { time: "10:38", actor: "Reviewer", text: "Attached sample assertions and the captured text. Waiting for your review." }] },
      { id: "locale-scout", title: "Map locale ownership", status: "done", role: "scout", model: "gpt-5.6-luna", run: "scout-d11", hint: "Saved findings to shared notes.", description: "Locale state belongs to extension initialization. Shared notes record the ownership and the host-field verification requirement.", evidence: false, log: [{ time: "10:28", actor: "Scout", text: "Read initialization and locale selection. No writes or shell commands." }, { time: "10:31", actor: "Scout", text: "Saved locale ownership and verification notes for the worker." }] }
    ]
  };
  const pi = structuredClone(keyboard);
  pi.id = "projects"; pi.name = "Pi Projects"; pi.workspace = "~/.pi/agent/projects-mvp";
  pi.notes = ["Interrupted requests must not replay automatically.", "Keep completion notices outside the main chat history."];
  const titles = ["How should completion notifications appear?", "Reconnect quietly after a restart", "Capture a reconnect walkthrough", "Review the worker stop controls", "Map the project host lifecycle"];
  pi.tasks.forEach((t, i) => { t.title = titles[i]; });
  pi.tasks[0].description = "Should the coordinator interrupt you for every result, or only for decisions and review requests? Other activity stays in the project inspector.";
  pi.tasks[0].choices = ["Only decisions and reviews", "Every finished task"];
  pi.tasks[0].hint = "Choose a notification policy.";
  pi.tasks[1].hint = "Checking recovery after host restart.";
  pi.tasks[1].description = "Restore the coordinator session without flooding the client with old output. Keep existing worker controls available.";
  pi.tasks[2].description = "Capture a repeatable reconnect walkthrough after the first writer finishes.";
  pi.tasks[3].description = "Inspect the sample stop receipt, then accept the result or ask for changes. No real worker was stopped.";
  pi.tasks[4].description = "Read the host lifecycle and record where interrupted requests stop.";
  pi.events = [{ time: "10:42", text: "Coordinator is waiting for your notification preference." }, { time: "10:40", text: "Worker is improving reconnect output." }];
  pi.tasks.forEach(t => { t.log = [{ time: "10:40", actor: t.role, text: `Sample activity: ${t.title}. No real tool ran.` }]; });
  return { keyboard, projects: pi };
}

// All interactions change this fixture only. No network or Projects host is used.
document.addEventListener("click", e => {
  const button = e.target.closest("[data-action]");
  if (button && !button.disabled) handleAction(button);
});
document.addEventListener("input", e => { if (e.target.closest("[data-compose]") && e.target.name === "message") draft = e.target.value; });
document.addEventListener("change", e => {
  if (!e.target.matches("[data-project-picker]")) return;
  projectId = e.target.value; selected = attention()[0]?.id || project().tasks[0].id;
  tab = "summary"; filter = "all"; sheet = false; draft = "";
  render(); toast(`Switched to ${project().name}. Both projects are simulated.`);
});
document.addEventListener("submit", e => {
  if (!e.target.matches("[data-compose], [data-task-message]")) return;
  e.preventDefault();
  const text = new FormData(e.target).get("message").trim();
  if (!text) return;
  if (e.target.matches("[data-compose]")) {
    const id = `task-${Date.now()}`;
    const t = { id, title: text, status: "queued", role: "worker", model: "gpt-5.6-terra", run: `queued-${project().tasks.length + 1}`, hint: "Waiting for the writer slot.", description: text, evidence: false, log: [{ time: clock(), actor: "You", text }] };
    project().tasks.push(t); event(`Coordinator queued: ${text}`); startNext();
    selected = id; filter = "all"; draft = ""; closeDialog(); render(); toast("Task added to the simulated plan. No real implementation started.");
  } else {
    const t = project().tasks.find(t => t.id === e.target.dataset.id);
    const mode = e.target.dataset.mode;
    if (mode === "custom-answer") { answer(t, text); return; }
    addLog(t, "You", text);
    if (mode === "revise") { t.status = "queued"; t.role = "worker"; t.model = "gpt-5.6-terra"; t.run = `queued-${t.id}`; t.hint = "Another pass requested. Waiting for the writer slot."; t.evidence = false; startNext(); }
    event(`${mode === "revise" ? "Changes requested" : "Instruction sent"}: ${text}`);
    closeDialog(); render(); toast(mode === "revise" ? "Another pass queued in the simulation." : "Instruction attached to this simulated worker.");
  }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && sheet && !dialog.open) { sheet = false; render(); return; }
  if (dialog.open || e.ctrlKey || e.metaKey || e.altKey || e.target.closest("input, textarea, select, [contenteditable]")) return;
  if (["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); switchVariant(variants[(variants.indexOf(variant) + (e.key === "ArrowRight" ? 1 : -1) + variants.length) % variants.length]); }
  if (e.key === "/") { e.preventDefault(); document.querySelector("[data-compose] textarea").focus(); }
  if (["j", "k"].includes(e.key) && variant === "desk" && filter !== "notes") {
    const tasks = visibleTasks(); if (!tasks.length) return;
    e.preventDefault(); const index = tasks.findIndex(t => t.id === selected);
    selected = tasks[(index + (e.key === "j" ? 1 : -1) + tasks.length) % tasks.length].id;
    tab = "summary"; render(); document.querySelector(`.task-row[data-id="${selected}"]`).focus();
  }
  if (["Enter", " "].includes(e.key) && e.target.matches(".board-card")) { e.preventDefault(); handleAction(e.target); }
});
document.addEventListener("dragstart", e => { const card = e.target.closest(".board-card"); if (card && card.draggable) e.dataTransfer.setData("text/plain", card.dataset.id); });
document.addEventListener("dragover", e => { const lane = e.target.closest("[data-lane]"); if (lane) { e.preventDefault(); lane.classList.add("drag-over"); } });
document.addEventListener("dragleave", e => { const lane = e.target.closest("[data-lane]"); if (lane && !lane.contains(e.relatedTarget)) lane.classList.remove("drag-over"); });
document.addEventListener("drop", e => {
  const lane = e.target.closest("[data-lane]"); if (!lane) return;
  e.preventDefault(); lane.classList.remove("drag-over");
  const t = project().tasks.find(t => t.id === e.dataTransfer.getData("text/plain"));
  if (!t || !["running", "queued", "paused"].includes(t.status)) return;
  if (lane.dataset.lane === "running") handleAction({ dataset: { action: "start", id: t.id } });
  else if (lane.dataset.lane === "planned") handleAction({ dataset: { action: "stop", id: t.id } });
  else toast("Use Finish demo run or the decision and review actions to change this state.");
});
window.addEventListener("popstate", () => { const key = new URL(location.href).searchParams.get("variant"); switchVariant(variants.includes(key) ? key : "desk"); });
render();
