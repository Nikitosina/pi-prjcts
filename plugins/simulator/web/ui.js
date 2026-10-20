// Project simulator card: a read-only screenshot view and owner controls, loaded by the host as /plugins/simulator/ui.js.
(() => {
const ui = window.piProjects, now = ui.state;
const { dialog, showDialog, closeDialog, dlgActions, dlgBtn, esc, setHtml, ago, toast, requireProject } = ui;
// Simulator images stay outside the rendered controls so ordinary chat polling does not reload them.
const simulatorIntents = new Map();
const simulator = { project: null, selected: null, snapshot: null, error: null, intent: null, pending: false, poll: null, capture: null, epoch: 0, nextPoll: 0, nextFrame: 0, url: null, frameUdid: null, capturedAt: null, frameError: null };
function resetSimulator() {
  simulator.capture?.abort();
  if (simulator.url) URL.revokeObjectURL(simulator.url);
  const intent = simulatorIntents.get(now().projectId) ?? null;
  Object.assign(simulator, { project: now().projectId, selected: null, snapshot: null, error: null, intent, pending: !!intent?.pending, poll: null, capture: null, epoch: 0, nextPoll: 0, nextFrame: 0, url: null, frameUdid: null, capturedAt: null, frameError: null });
  document.querySelector("#simulator-image").removeAttribute("src");
  renderSimulator();
}
function simulatorDevice() {
  const devices = simulator.snapshot?.devices ?? [];
  return devices.find(device => device.udid === simulator.selected) ?? devices.find(device => device.state === "Booted") ?? devices[0] ?? null;
}
function simulatorActive() { return !!now().view && !!now().projectId && now().tab === "coordinator" && !document.hidden; }
function simulatorReady() {
  const s = simulator.snapshot;
  const d = simulatorDevice();
  return !simulator.pending && s?.enabled && !s.operation && !s.error && d?.state === "Booted";
}
function simulatorLocked(ignoreLease = false) {
  const s = simulator.snapshot;
  return simulator.pending || !!simulator.intent || (!ignoreLease && !!simulatorDevice()?.lease) || !!s?.operation || ["creating", "preparing", "working", "uncertain"].includes(s?.status) || now().view?.project.archived || now().view?.project.deleted;
}
function simulatorRecoverable() {
  return simulator.snapshot?.status === "uncertain" && !simulator.pending && !simulator.intent && !now().view?.project.archived && !now().view?.project.deleted;
}
function simulatorButton(label, action, disabled = false, cls = "ghost small") {
  return `<button type="button" class="${cls}" data-action="simulator-${action}"${disabled ? " disabled" : ""}>${label}</button>`;
}
function renderSimulator() {
  const card = document.querySelector("#simulator-card");
  card.hidden = !now().view || simulator.project !== now().projectId;
  if (card.hidden) return;
  const s = simulator.snapshot, d = simulatorDevice(), locked = simulatorLocked();
  const status = !s ? simulator.error ? "Unavailable" : "Loading" : !s.enabled ? "Off" : s.status === "uncertain" ? "Needs inspection" : s.operation ? ({ create: "Creating", boot: "Preparing" }[s.operation.operation] ?? "Working") : s.status === "error" ? "Error" : !d ? "No simulator" : s.devices.length > 1 ? `${s.devices.filter(device => device.state === "Booted").length}/${s.devices.length} running` : d.state === "Booted" ? "Running" : "Shut down";
  document.querySelector("#simulator-status").textContent = status;
  const sourceName = udid => s?.sources.find(source => source.udid === udid)?.name;
  document.querySelector("#simulator-description").textContent = !s ? "Reading simulator availability…" : !s.enabled ? "Off. Agents cannot create or manage simulators for this project." : !d ? "No simulator yet. The coordinator creates the ones its workers need." : `${sourceName(d.sourceUdid) ?? d.name} clone · iOS ${d.osVersion}. View only; no clicks or keyboard input are sent to the simulator.`;
  const tabs = s?.devices.length > 1 ? s.devices.map(device => `<button type="button" class="chip-toggle${device.udid === d?.udid ? " on" : ""}" data-action="simulator-select" data-udid="${esc(device.udid)}" title="${esc(`${device.udid} · ${device.state}`)}">${esc(sourceName(device.sourceUdid) ?? device.name.replace(/^pi-projects \S+ /, "").slice(0, 8))}<small>${esc(device.state === "Booted" ? "on" : "off")}</small></button>`).join("") : "";
  const picker = document.querySelector("#simulator-devices");
  if (picker.dataset.html !== tabs) { picker.innerHTML = tabs; picker.dataset.html = tabs; }
  picker.hidden = !tabs;
  const ready = simulatorReady(), showFrame = ready && simulator.url && simulator.frameUdid === d.udid;
  document.querySelector("#simulator-screen").hidden = !showFrame;
  const caption = document.querySelector("#simulator-caption");
  caption.hidden = !ready;
  caption.textContent = simulator.capturedAt ? `Screenshot ${ago(simulator.capturedAt)}. Refreshes about every 4 seconds.${simulator.frameError ? " Last capture failed; showing the previous frame." : ""}` : "Waiting for a screenshot…";
  let actions = "";
  if (!s) actions = simulatorButton("Retry", "refresh");
  else if (!s.enabled) actions = simulatorButton("Turn on", "add", locked, "small");
  else {
    if (s.devices.length < s.maxOwned) actions += simulatorButton(d ? "New clone…" : "Create simulator…", "new", simulatorLocked(true), d ? "ghost small" : "small");
    if (d) {
      if (showFrame) actions += simulatorButton("Expand", "expand");
      actions += simulatorButton(d.state === "Booted" ? "Shut down" : "Boot", d.state === "Booted" ? "shutdown" : "boot", locked);
      actions += simulatorButton("Reset…", "reset", locked, "ghost small danger") + simulatorButton("Delete…", "delete", locked, "ghost small danger");
    }
    actions += simulatorButton("Turn off…", "disable", simulatorLocked(true));
  }
  if (s?.status === "uncertain") actions += simulatorButton("Inspect / acknowledge…", "recover", !simulatorRecoverable(), "small");
  if (simulator.intent && !simulator.pending) actions += simulatorButton("Retry exact request", "retry", false, "small");
  const controls = document.querySelector("#simulator-actions");
  if (controls.dataset.html !== actions) {
    const focused = document.activeElement?.closest("#simulator-actions button")?.dataset.action;
    controls.innerHTML = actions; controls.dataset.html = actions;
    if (focused) (controls.querySelector(`[data-action="${focused}"]:not(:disabled)`) ?? controls.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
  }
  const issue = [simulator.error || (simulator.intent && !simulator.pending ? "An earlier request is unconfirmed. Inspect the simulator state before retrying the exact request." : null), s?.error, d?.problem, d?.lease ? `In use by worker ${d.lease.threadId}. Its lifecycle actions are blocked until the lease is released.` : null, simulator.frameError].filter(Boolean).join(" ");
  const error = document.querySelector("#simulator-error"); error.textContent = issue; error.hidden = !issue;
  const details = document.querySelector("#simulator-facts"); details.hidden = !s;
  if (s) setHtml("#simulator-details", `<p class="note">Agents create, boot, shut down, reset and delete up to ${esc(s.maxOwned)} clones for this project while management is on. Source simulators, shared runtimes and global caches are never changed.</p><dl class="simulator-facts"><dt>Default source</dt><dd>${esc(sourceName(s.defaultSourceUdid) ?? "Newest shut-down iPhone")}</dd>${d ? `<dt>Cloned from</dt><dd>${esc(sourceName(d.sourceUdid) ?? d.sourceUdid)}</dd><dt>Device</dt><dd class="mono">${esc(d.udid)}</dd><dt>Slimming</dt><dd>${d.slim ? `${esc(d.slim.managedDisabled)}/${esc(d.slim.managedTotal)} services disabled${d.slim.persistent ? ", persistent" : ""}` : "Not reported"}</dd>` : ""}</dl>`);
  for (const button of dialog.querySelectorAll('[data-action="simulator-enable"], [data-action="simulator-confirm"]')) button.disabled = simulatorLocked(button.dataset.operation === "disable" || button.dataset.action === "simulator-enable") || button.dataset.action === "simulator-enable" && !s?.sources.some(source => source.state === "Shutdown");
  const acknowledgement = dialog.querySelector('[data-action="simulator-recover-confirm"]');
  if (acknowledgement) acknowledgement.disabled = !simulatorRecoverable();
  const expanded = dialog.querySelector("[data-simulator-expanded]");
  if (expanded && (!showFrame || expanded.dataset.project !== now().projectId)) closeDialog();
}
async function loadSimulator() {
  if (!simulatorActive() || simulator.poll) return;
  const job = { id: now().projectId, generation: now().generation, epoch: simulator.epoch }; simulator.poll = job;
  try {
    const data = await ui.rpc("simulator", "snapshot", job.id);
    if (job.id !== now().projectId || job.generation !== now().generation || simulator.project !== job.id || job.epoch !== simulator.epoch) return;
    if (!data || typeof data.enabled !== "boolean" || !Array.isArray(data.sources)) throw new Error("Invalid simulator snapshot");
    simulator.snapshot = data; simulator.error = null;
    if (!simulatorReady() || simulator.frameUdid && simulator.frameUdid !== simulatorDevice()?.udid) { simulator.capture?.abort(); clearSimulatorFrame(); }
  } catch (error) { if (job.id === now().projectId && job.generation === now().generation && job.epoch === simulator.epoch) simulator.error = error.message; }
  finally {
    if (simulator.poll === job) { simulator.poll = null; simulator.nextPoll = Date.now() + 3000; }
    renderSimulator();
  }
}
function clearSimulatorFrame() {
  if (simulator.url) URL.revokeObjectURL(simulator.url);
  simulator.url = null; simulator.frameUdid = null; simulator.capturedAt = null; simulator.frameError = null;
  document.querySelector("#simulator-image").removeAttribute("src");
}
async function captureSimulator() {
  if (!simulatorActive() || !simulatorReady() || simulator.capture) return;
  const id = now().projectId, udid = simulatorDevice().udid, current = now().generation, controller = new AbortController();
  simulator.capture = controller;
  try {
    const response = await ui.fetch(`/plugins/simulator/frame?project=${encodeURIComponent(id)}&udid=${encodeURIComponent(udid)}`, { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]) });
    if (!response.ok) throw new Error(`Screenshot unavailable (${response.status})`);
    const type = response.headers.get("content-type")?.split(";")[0];
    if (!["image/png", "image/jpeg"].includes(type)) throw new Error("Simulator returned an unsupported image");
    const blob = await response.blob();
    if (id !== now().projectId || current !== now().generation || !simulatorActive() || !simulatorReady() || simulatorDevice()?.udid !== udid) return;
    const next = URL.createObjectURL(blob), old = simulator.url;
    simulator.url = next; simulator.frameUdid = udid; simulator.capturedAt = Date.now(); simulator.frameError = null;
    document.querySelector("#simulator-image").src = next;
    const expanded = dialog.querySelector("[data-simulator-expanded]");
    if (expanded?.dataset.project === id) expanded.src = next;
    if (old) URL.revokeObjectURL(old);
  } catch (error) { if (!controller.signal.aborted && id === now().projectId && current === now().generation) simulator.frameError = error.message; }
  finally {
    if (simulator.capture === controller) { simulator.capture = null; simulator.nextFrame = Date.now() + 4000; }
    renderSimulator();
  }
}
function simulatorTick() {
  if (!simulatorActive()) { simulator.capture?.abort(); return; }
  if (Date.now() >= simulator.nextPoll) void loadSimulator();
  if (Date.now() >= simulator.nextFrame) void captureSimulator();
  renderSimulator();
}
async function simulatorRequest(input, label, retry = false) {
  if (!retry && (input?.method === "recover" ? !simulatorRecoverable() : simulatorLocked(input?.method === "configure" && input.params.enabled === false || input?.params.operation === "create"))) return;
  const id = now().projectId, version = now().dialogVersion;
  const intent = retry ? simulator.intent : { input: { method: input.method, id, params: { ...input.params, requestId: crypto.randomUUID() } }, label, pending: false };
  if (!intent || intent.input.id !== id || simulator.pending) return;
  intent.pending = true; simulatorIntents.set(id, intent);
  simulator.epoch++; simulator.capture?.abort();
  simulator.intent = intent; simulator.pending = true; simulator.error = null; renderSimulator();
  try {
    const result = await ui.rpc("simulator", intent.input.method, intent.input.id, intent.input.params);
    if (simulatorIntents.get(id) === intent) simulatorIntents.delete(id);
    if (id !== now().projectId || simulator.intent !== intent) return;
    simulator.snapshot = result; simulator.intent = null; simulator.nextPoll = 0;
    if (!simulatorReady()) { simulator.capture?.abort(); clearSimulatorFrame(); }
    if (dialog.open && version === now().dialogVersion) closeDialog();
    toast(intent.label);
  } catch (error) {
    if (error.rejected && simulatorIntents.get(id) === intent) simulatorIntents.delete(id);
    if (id === now().projectId && simulator.intent === intent) {
      if (error.rejected) { simulator.intent = null; simulator.nextPoll = 0; }
      simulator.error = error.rejected ? error.message : `${error.message}. Response unconfirmed. Inspect the simulator state, then retry the exact request if needed.`;
    }
  } finally {
    intent.pending = false;
    if (id === now().projectId && (!simulator.intent || simulator.intent === intent)) { simulator.pending = false; renderSimulator(); }
  }
}
function simulatorAdd() {
  const s = simulator.snapshot;
  if (!s || simulatorLocked()) return;
  return simulatorRequest({ method: "configure", params: { enabled: true } }, "Simulator management on");
}
function simulatorNew() {
  const s = simulator.snapshot;
  if (!s || simulatorLocked(true)) return;
  const available = s.sources.filter(source => source.state === "Shutdown");
  showDialog("New project simulator", `<p>Choose a shut-down simulator to clone. Its apps and settings are copied; the source is not changed. The coordinator can also do this itself.</p><label class="field">Clone source<select id="simulator-source">${s.sources.map(source => `<option value="${esc(source.udid)}"${source.state !== "Shutdown" ? " disabled" : ""}${source.udid === s.sourceUdid ? " selected" : ""}>${esc(source.name)} · iOS ${esc(source.osVersion)} · ${esc(source.state)}</option>`).join("")}</select></label><p class="note">simslim can disable features such as push notifications and iCloud on the clone.</p>${available.length ? "" : '<p class="notice">No shut-down source is available. Shut down a source outside pi-prjcts, then refresh.</p>'}${dlgActions(dlgBtn("Cancel", { action: "close-dialog" }), `<button type="button" class="primary" data-action="simulator-enable"${available.length ? "" : " disabled"}>Create clone</button>`)}`);
  const picker = dialog.querySelector("#simulator-source");
  picker.value = available.some(source => source.udid === s.defaultSourceUdid) ? s.defaultSourceUdid : available[0]?.udid || "";
}
function simulatorConfirm(operation) {
  const s = simulator.snapshot, d = simulatorDevice();
  if (!s || simulatorLocked(operation === "disable")) return;
  const text = operation === "reset" ? "Permanently erase all apps, accounts and data on this project's owned simulator, then prepare it again. The original source is not changed." : operation === "delete" ? "Permanently delete this owned simulator and all its apps and data. The original source is not changed; agents can create a new clone later." : "Turn off simulator management for this project. Agents can no longer create, boot or delete its simulators. Owned clones and their data are retained; no device is deleted.";
  showDialog(operation === "disable" ? "Turn off simulator management?" : `${operation === "reset" ? "Reset" : "Delete"} owned simulator?`, `<p>${text}</p>${d && operation !== "disable" ? `<p class="note mono">${esc(d.name)}<br>${esc(d.udid)}</p>` : ""}${dlgActions(dlgBtn("Cancel", { action: "close-dialog" }), dlgBtn(operation === "disable" ? "Turn off" : operation === "reset" ? "Reset simulator" : "Delete simulator", { action: "simulator-confirm", operation, project: now().projectId, udid: d?.udid ?? "" }, operation === "disable" ? "primary" : "primary danger"))}`);
  dialog.querySelector('[data-action="close-dialog"]')?.focus();
}
function simulatorRecover() {
  if (!simulatorRecoverable()) return;
  const recorded = simulator.snapshot.devices.find(device => device.udid === simulator.snapshot.operation?.udid);
  showDialog("Inspect interrupted simulator operation", `<p>${esc(simulator.snapshot.error || "The simulator operation has an unknown outcome.")}</p>${recorded ? `<p class="note">Recorded clone: ${esc(recorded.name)}<br><span class="mono">${esc(recorded.udid)}</span></p>` : ""}<p>Inspect the simulator list and any remaining clone outside pi-prjcts before acknowledging. Acknowledgement never retries the operation or adopts an unknown simulator. A matching recorded clone is retained; missing or changed ownership is released, with the previous receipt saved for inspection.</p><p class="note">An unrecorded clone may remain on disk and require manual cleanup. Agents cannot acknowledge unknown outcomes.</p>${dlgActions(dlgBtn("Cancel", { action: "close-dialog" }), dlgBtn("I inspected; acknowledge", { action: "simulator-recover-confirm", project: now().projectId }, "primary"))}`);
  dialog.querySelector('[data-action="close-dialog"]')?.focus();
}
function simulatorExpand() {
  if (!simulatorReady() || !simulator.url) return;
  showDialog("Project simulator", `<div class="simulator-expanded"><img data-simulator-expanded data-project="${esc(now().projectId)}" src="${esc(simulator.url)}" alt="Current project simulator screenshot" draggable="false"></div><p class="note">View only. Polled screenshots, not video. No clicks, gestures or keyboard input are sent to the simulator.</p>`);
}

async function action(name, node) {
  switch (name) {
      case "simulator-refresh": simulator.nextPoll = 0; await loadSimulator(); break;
      case "simulator-add": await simulatorAdd(); break;
      case "simulator-new": simulatorNew(); break;
      case "simulator-select": simulator.selected = node.dataset.udid; simulator.capture?.abort(); clearSimulatorFrame(); simulator.nextFrame = 0; simulatorTick(); break;
      case "simulator-enable": {
        const sourceUdid = dialog.querySelector("#simulator-source")?.value;
        if (!simulator.snapshot?.sources.some(source => source.udid === sourceUdid && source.state === "Shutdown")) throw new Error("Choose a shut-down clone source");
        await simulatorRequest({ method: "action", params: { operation: "create", sourceUdid } }, "Simulator clone requested"); break;
      }
      case "simulator-boot": case "simulator-shutdown": {
        const operation = name.slice("simulator-".length), udid = simulatorDevice()?.udid;
        await simulatorRequest({ method: "action", params: { operation, ...(udid ? { udid } : {}) } }, "Simulator request accepted"); break;
      }
      case "simulator-reset": case "simulator-delete": case "simulator-disable": simulatorConfirm(name.slice("simulator-".length)); break;
      case "simulator-confirm": {
        requireProject(node.dataset.project);
        const operation = node.dataset.operation;
        if (!["reset", "delete", "disable"].includes(operation)) throw new Error("Invalid simulator action");
        await simulatorRequest(operation === "disable" ? { method: "configure", params: { enabled: false } } : { method: "action", params: { operation, udid: node.dataset.udid } }, "Simulator request accepted"); break;
      }
      case "simulator-recover": simulatorRecover(); break;
      case "simulator-recover-confirm": {
        requireProject(node.dataset.project);
        await simulatorRequest({ method: "recover", params: { confirm: now().projectId } }, "Simulator outcome acknowledged"); break;
      }
      case "simulator-expand": simulatorExpand(); break;
      case "simulator-retry": await simulatorRequest(null, null, true); break;
    default: throw new Error(`Unknown simulator action ${name}`);
  }
}
ui.register({
  name: "simulator",
  mount(slot) { slot.innerHTML = `<section id="simulator-card" class="card simulator-card" aria-label="Project simulator" hidden>
  <div class="row between"><b>Simulator</b><span id="simulator-status" class="chip">Loading</span></div>
  <p id="simulator-description" class="note"></p>
  <div id="simulator-devices" class="row simulator-devices" role="group" aria-label="Project simulators" hidden></div>
  <div id="simulator-screen" class="simulator-screen" hidden><img id="simulator-image" alt="Current project simulator screenshot" draggable="false"></div>
  <p id="simulator-caption" class="note" hidden></p>
  <div id="simulator-actions" class="row simulator-actions"></div>
  <p id="simulator-error" class="simulator-error" role="status" hidden></p>
  <details id="simulator-facts" hidden><summary>Details</summary><div id="simulator-details"></div></details>
</section>`; },
  projectChanged: resetSimulator,
  render: renderSimulator,
  tick: simulatorTick,
  hide() { simulator.capture?.abort(); clearSimulatorFrame(); },
  action,
});
})();
