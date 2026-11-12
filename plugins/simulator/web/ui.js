// The simulator panel in Settings → Plugins: the project's owned clones, a read-only screenshot and owner controls.
// Served as /plugins/simulator/ui.js; the contract is mount(slot, panel) and action(name, node, panel) (docs/plugins/reference.md).
(() => {
  const { esc } = window.piProjects;
  // Requests whose answer never arrived, per project. They outlive a mount so the owner can retry the exact request after reopening.
  const intents = new Map();
  const views = new WeakMap(); // panel -> its mount's state
  const POLL_MS = 3000,
    FRAME_MS = 4000,
    CAPTURE_TIMEOUT_MS = 60000;
  const isAbort = (error) => error?.name === "AbortError";
  // A refusal the host answered carries its HTTP status; any other failure may have reached the host.
  const answered = (error) => typeof error?.status === "number";
  const ago = (at) => {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
  };

  function device(v) {
    const devices = v.snapshot?.devices ?? [];
    return devices.find((item) => item.udid === v.selected) ?? devices.find((item) => item.state === "Booted") ?? devices[0] ?? null;
  }
  // `sender` is the mount waiting for the intent's answer; it lets go when its panel goes away, so the next mount can retry.
  const pending = (v) => !!v.intent?.sender;
  function ready(v) {
    const s = v.snapshot;
    return !pending(v) && s?.enabled && !s.operation && !s.error && device(v)?.state === "Booted";
  }
  function locked(v, ignoreLease = false) {
    const s = v.snapshot;
    return (
      pending(v) ||
      !!v.intent ||
      (!ignoreLease && !!device(v)?.lease) ||
      !!s?.operation ||
      ["creating", "preparing", "working", "uncertain"].includes(s?.status)
    );
  }
  const recoverable = (v) => v.snapshot?.status === "uncertain" && !v.intent;
  const sourceName = (v, udid) => v.snapshot?.sources.find((source) => source.udid === udid)?.name;
  const button = (label, action, disabled = false, cls = "ghost-btn small", data = {}) =>
    `<button type="button" class="${cls}" data-action="simulator-${action}"${Object.entries(data)
      .map(([key, value]) => ` data-${key}="${esc(value)}"`)
      .join("")}${disabled ? " disabled" : ""}>${label}</button>`;
  // Replaces a region only when its markup changed, so a polled render keeps focus, selection and open details.
  function patch(node, html) {
    if (node.dataset.html === html) return false;
    node.innerHTML = html;
    node.dataset.html = html;
    return true;
  }

  function statusOf(v) {
    const s = v.snapshot,
      d = device(v);
    if (!s) return v.error ? "Unavailable" : "Loading";
    if (!s.enabled) return "Off";
    if (s.status === "uncertain") return "Needs inspection";
    if (s.operation) return { create: "Creating", boot: "Preparing", erase: "Erasing" }[s.operation.operation] ?? "Working";
    if (s.status === "error") return "Error";
    if (!d) return "No simulator";
    if (s.devices.length > 1) return `${s.devices.filter((item) => item.state === "Booted").length}/${s.devices.length} running`;
    return d.state === "Booted" ? "Running" : "Shut down";
  }

  function confirmation(v) {
    const s = v.snapshot,
      c = v.confirm;
    if (!c || !s) return "";
    const cancel = button("Cancel", "cancel");
    if (c.kind === "new") {
      const available = s.sources.filter((source) => source.state === "Shutdown");
      return `<p><b>New project simulator</b></p><p class="small">Choose a shut-down simulator to clone. Its apps and settings are copied; the source is not changed. The coordinator can also do this itself.</p><label class="small simulator-field">Clone source <select data-simulator-source>${s.sources
        .map(
          (source) =>
            `<option value="${esc(source.udid)}"${source.state !== "Shutdown" ? " disabled" : ""}>${esc(source.name)} · iOS ${esc(source.osVersion)} · ${esc(source.state)}</option>`,
        )
        .join(
          "",
        )}</select></label><p class="small muted">simslim can disable features such as push notifications and iCloud on the clone.</p>${available.length ? "" : '<p class="small simulator-error">No shut-down source is available. Shut down a source outside pi-prjcts, then refresh.</p>'}<div class="simulator-actions">${cancel}${button("Create clone", "enable", locked(v, true) || !available.length, "primary small")}</div>`;
    }
    if (c.kind === "recover") {
      const recorded = s.devices.find((item) => item.udid === s.operation?.udid);
      return `<p><b>Inspect interrupted simulator operation</b></p><p class="small">${esc(s.error || "The simulator operation has an unknown outcome.")}</p>${recorded ? `<p class="small muted">Recorded clone: ${esc(recorded.name)}<br><span class="mono">${esc(recorded.udid)}</span></p>` : ""}<p class="small">Inspect the simulator list and any remaining clone outside pi-prjcts before acknowledging. Acknowledgement never retries the operation or adopts an unknown simulator. A matching recorded clone is retained; missing or changed ownership is released, with the previous receipt saved for inspection.</p><p class="small muted">An unrecorded clone may remain on disk and require manual cleanup. Agents cannot acknowledge unknown outcomes.</p><div class="simulator-actions">${cancel}${button("I inspected; acknowledge", "recover-confirm", !recoverable(v), "primary small")}</div>`;
    }
    const named = s.devices.find((item) => item.udid === c.udid);
    const text =
      c.kind === "reset"
        ? "Permanently erase all apps, accounts and data on this project's owned simulator, then prepare it again. The original source is not changed."
        : c.kind === "delete"
          ? "Permanently delete this owned simulator and all its apps and data. The original source is not changed; agents can create a new clone later."
          : "Turn off simulator management for this project. Agents can no longer create, boot or delete its simulators. Owned clones and their data are retained; no device is deleted.";
    const title = c.kind === "disable" ? "Turn off simulator management?" : `${c.kind === "reset" ? "Reset" : "Delete"} owned simulator?`;
    const label = c.kind === "disable" ? "Turn off" : c.kind === "reset" ? "Reset simulator" : "Delete simulator";
    return `<p><b>${title}</b></p><p class="small">${text}</p>${named && c.kind !== "disable" ? `<p class="small mono">${esc(named.name)}<br>${esc(named.udid)}</p>` : ""}<div class="simulator-actions">${cancel}${button(label, "confirm", locked(v, c.kind === "disable") || (c.kind !== "disable" && !named), c.kind === "disable" ? "primary small" : "primary small danger", { operation: c.kind, udid: c.udid ?? "" })}</div>`;
  }

  function render(v) {
    if (v.panel.signal.aborted) return;
    const { slot } = v,
      s = v.snapshot,
      d = device(v),
      lock = locked(v);
    const $ = (name) => slot.querySelector(`[data-simulator-${name}]`);
    $("status").textContent = statusOf(v);
    $("description").textContent = !s
      ? v.error
        ? "The simulator state could not be read."
        : "Reading simulator availability…"
      : !s.enabled
        ? "Off. Agents cannot create or manage simulators for this project."
        : !d
          ? "No simulator yet. The coordinator creates the ones its workers need."
          : `${sourceName(v, d.sourceUdid) ?? d.name} clone · iOS ${d.osVersion}. View only; no clicks or keyboard input are sent to the simulator.`;
    const tabs =
      s?.devices.length > 1
        ? s.devices
            .map(
              (item) =>
                `<button type="button" class="simulator-tab${item.udid === d?.udid ? " on" : ""}" data-action="simulator-select" data-udid="${esc(item.udid)}" title="${esc(`${item.udid} · ${item.state}`)}">${esc(sourceName(v, item.sourceUdid) ?? item.name.replace(/^pi-projects \S+ /, "").slice(0, 8))}<small>${item.state === "Booted" ? "on" : "off"}</small></button>`,
            )
            .join("")
        : "";
    patch($("devices"), tabs);
    $("devices").hidden = !tabs;
    const live = ready(v),
      showFrame = live && v.url && v.frameUdid === d.udid;
    $("screen").hidden = !showFrame;
    $("screen").classList.toggle("expanded", !!v.expanded);
    const caption = $("caption");
    caption.hidden = !live;
    caption.textContent = v.capturedAt
      ? `Screenshot ${ago(v.capturedAt)}. Refreshes about every 4 seconds.${v.frameError ? " Last capture failed; showing the previous frame." : ""}`
      : "Waiting for a screenshot…";
    let actions = "";
    if (!s) actions = button("Retry", "refresh");
    else if (!s.enabled) actions = button("Turn on", "add", lock, "primary small");
    else {
      if (s.devices.length < s.maxOwned)
        actions += button(d ? "New clone…" : "Create simulator…", "new", locked(v, true), d ? "ghost-btn small" : "primary small");
      if (d) {
        if (showFrame) actions += button(v.expanded ? "Smaller" : "Expand", "expand");
        actions += button(d.state === "Booted" ? "Shut down" : "Boot", d.state === "Booted" ? "shutdown" : "boot", lock);
        actions += button("Reset…", "reset", lock, "ghost-btn small danger") + button("Delete…", "delete", lock, "ghost-btn small danger");
      }
      actions += button("Turn off…", "disable", locked(v, true));
    }
    if (s?.status === "uncertain") actions += button("Inspect / acknowledge…", "recover", !recoverable(v), "primary small");
    if (v.intent && !pending(v)) actions += button("Retry exact request", "retry", false, "primary small");
    const controls = $("actions"),
      focused = document.activeElement?.closest("[data-simulator-actions] button")?.dataset.action;
    if (patch(controls, actions) && focused)
      (controls.querySelector(`[data-action="${focused}"]:not(:disabled)`) ?? controls.querySelector("button:not(:disabled)"))?.focus({
        preventScroll: true,
      });
    const confirm = $("confirm"),
      chosen = confirm.querySelector("[data-simulator-source]")?.value;
    if (patch(confirm, confirmation(v))) {
      const picker = confirm.querySelector("[data-simulator-source]");
      if (picker) {
        const free = s.sources.filter((source) => source.state === "Shutdown").map((source) => source.udid);
        picker.value = [chosen, s.defaultSourceUdid].find((udid) => udid && free.includes(udid)) ?? free[0] ?? "";
      }
    }
    confirm.hidden = !v.confirm;
    const issue = [
      v.error ||
        (v.intent && !pending(v)
          ? "An earlier request is unconfirmed. Inspect the simulator state before retrying the exact request."
          : null),
      s?.error,
      d?.problem,
      d?.lease ? `In use by worker ${d.lease.threadId}. Its lifecycle actions are blocked until the lease is released.` : null,
      v.frameError,
    ]
      .filter(Boolean)
      .join(" ");
    $("error").textContent = issue;
    $("error").hidden = !issue;
    $("notice").textContent = v.notice ?? "";
    $("notice").hidden = !v.notice;
    $("facts").hidden = !s;
    if (s)
      patch(
        $("details"),
        `<p class="small muted">Agents create, boot, shut down, reset and delete up to ${esc(s.maxOwned)} clones for this project while management is on. Source simulators, shared runtimes and global caches are never changed.</p><dl class="simulator-facts"><dt>Default source</dt><dd>${esc(sourceName(v, s.defaultSourceUdid) ?? "Newest shut-down iPhone")}</dd>${d ? `<dt>Cloned from</dt><dd>${esc(sourceName(v, d.sourceUdid) ?? d.sourceUdid)}</dd><dt>Device</dt><dd class="mono">${esc(d.udid)}</dd><dt>Slimming</dt><dd>${d.slim ? `${esc(d.slim.managedDisabled)}/${esc(d.slim.managedTotal)} services disabled${d.slim.persistent ? ", persistent" : ""}` : "Not reported"}</dd>` : ""}</dl>`,
      );
  }

  function clearFrame(v) {
    v.frameEpoch++;
    if (v.url) URL.revokeObjectURL(v.url);
    Object.assign(v, { url: null, frameUdid: null, capturedAt: null, frameError: null, expanded: false });
    v.slot.querySelector("[data-simulator-frame]").removeAttribute("src");
  }

  async function load(v) {
    if (v.polling) return;
    const epoch = v.epoch;
    v.polling = true;
    try {
      const data = await v.panel.rpc("snapshot");
      if (epoch !== v.epoch) return;
      if (!data || typeof data.enabled !== "boolean" || !Array.isArray(data.sources)) throw new Error("Invalid simulator snapshot");
      v.snapshot = data;
      v.error = null;
      if (!ready(v) || (v.frameUdid && v.frameUdid !== device(v)?.udid)) clearFrame(v);
    } catch (error) {
      if (isAbort(error) || epoch !== v.epoch) return;
      // Controls for a state that can no longer be read would act blind; only Retry stays.
      v.snapshot = null;
      v.confirm = null;
      v.error = error.message;
      clearFrame(v);
    } finally {
      v.polling = false;
      v.nextPoll = Date.now() + POLL_MS;
      render(v);
    }
  }

  // One capture per frame epoch: a new epoch (another clone, a request) captures at once, and a late answer of an old one is dropped.
  async function capture(v) {
    if (!ready(v) || v.capturing === v.frameEpoch) return;
    const udid = device(v).udid,
      epoch = v.frameEpoch;
    v.capturing = epoch;
    let timer;
    try {
      // panel.fetch takes no signal of its own, so a stalled capture is abandoned rather than aborted.
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Screenshot timed out")), CAPTURE_TIMEOUT_MS);
      });
      const blob = await Promise.race([
        v.panel.fetch("frame", { udid }).then((response) => {
          if (!response.ok) throw new Error(`Screenshot unavailable (${response.status})`);
          const type = response.headers.get("content-type")?.split(";")[0];
          if (!["image/png", "image/jpeg"].includes(type)) throw new Error("Simulator returned an unsupported image");
          return response.blob();
        }),
        timeout,
      ]);
      if (epoch !== v.frameEpoch || v.panel.signal.aborted || !ready(v) || device(v)?.udid !== udid) return;
      const old = v.url;
      v.url = URL.createObjectURL(blob);
      v.frameUdid = udid;
      v.capturedAt = Date.now();
      v.frameError = null;
      v.slot.querySelector("[data-simulator-frame]").src = v.url;
      if (old) URL.revokeObjectURL(old);
    } catch (error) {
      if (!isAbort(error) && epoch === v.frameEpoch) v.frameError = error.message;
    } finally {
      clearTimeout(timer);
      if (v.capturing === epoch) {
        v.capturing = null;
        v.nextFrame = Date.now() + FRAME_MS;
      }
      render(v);
    }
  }

  function tick(v) {
    if (document.hidden) return;
    if (Date.now() >= v.nextPoll) void load(v);
    if (Date.now() >= v.nextFrame) void capture(v);
    render(v);
  }

  async function request(v, input, label, retry = false) {
    if (
      !retry &&
      (input.method === "recover"
        ? !recoverable(v)
        : locked(v, (input.method === "configure" && input.params.enabled === false) || input.params.operation === "create"))
    )
      return;
    const intent = retry
      ? v.intent
      : { input: { method: input.method, params: { ...input.params, requestId: crypto.randomUUID() } }, label, sender: null };
    if (!intent || intent.sender) return;
    intent.sender = v;
    intents.set(v.projectId, intent);
    v.epoch++;
    v.intent = intent;
    v.error = null;
    v.notice = null;
    v.confirm = null;
    v.frameEpoch++;
    render(v);
    try {
      const result = await v.panel.rpc(intent.input.method, intent.input.params);
      if (intents.get(v.projectId) === intent) intents.delete(v.projectId);
      v.snapshot = result;
      v.intent = null;
      v.nextPoll = 0;
      v.notice = intent.label;
      if (!ready(v)) clearFrame(v);
    } catch (error) {
      // After the panel went away the answer belongs to no mount (a refusal arrives unwrapped); the intent stays for the next mount.
      if (isAbort(error) || v.panel.signal.aborted) return;
      if (answered(error)) {
        if (intents.get(v.projectId) === intent) intents.delete(v.projectId);
        v.intent = null;
        v.nextPoll = 0;
        v.error = error.message;
      } else v.error = `${error.message}. Response unconfirmed. Inspect the simulator state, then retry the exact request if needed.`;
    } finally {
      if (intent.sender === v) intent.sender = null;
      render(v);
    }
  }

  async function action(name, node, panel) {
    const v = views.get(panel);
    if (!v) return;
    const s = v.snapshot,
      d = device(v);
    switch (name) {
      case "simulator-refresh":
        v.nextPoll = 0;
        await load(v);
        break;
      case "simulator-add":
        if (s) await request(v, { method: "configure", params: { enabled: true } }, "Simulator management on");
        break;
      case "simulator-new":
        if (s && !locked(v, true)) v.confirm = { kind: "new" };
        break;
      case "simulator-select":
        v.selected = node.dataset.udid;
        v.confirm = null;
        clearFrame(v);
        v.nextFrame = 0;
        tick(v);
        break;
      case "simulator-enable": {
        const sourceUdid = v.slot.querySelector("[data-simulator-source]")?.value;
        if (!s?.sources.some((source) => source.udid === sourceUdid && source.state === "Shutdown"))
          throw new Error("Choose a shut-down clone source");
        await request(v, { method: "action", params: { operation: "create", sourceUdid } }, "Simulator clone requested");
        break;
      }
      case "simulator-boot":
      case "simulator-shutdown":
        await request(
          v,
          { method: "action", params: { operation: name.slice("simulator-".length), ...(d ? { udid: d.udid } : {}) } },
          "Simulator request accepted",
        );
        break;
      case "simulator-reset":
      case "simulator-delete":
      case "simulator-disable": {
        const kind = name.slice("simulator-".length);
        if (s && !locked(v, kind === "disable")) v.confirm = { kind, udid: kind === "disable" ? undefined : d?.udid };
        break;
      }
      case "simulator-confirm": {
        const operation = node.dataset.operation;
        if (!["reset", "delete", "disable"].includes(operation)) throw new Error("Invalid simulator action");
        await request(
          v,
          operation === "disable"
            ? { method: "configure", params: { enabled: false } }
            : { method: "action", params: { operation, udid: node.dataset.udid } },
          "Simulator request accepted",
        );
        break;
      }
      case "simulator-cancel":
        v.confirm = null;
        break;
      case "simulator-recover":
        if (recoverable(v)) v.confirm = { kind: "recover" };
        break;
      case "simulator-recover-confirm":
        await request(v, { method: "recover", params: { confirm: v.projectId } }, "Simulator outcome acknowledged");
        break;
      case "simulator-expand":
        v.expanded = !v.expanded;
        break;
      case "simulator-retry":
        await request(v, null, null, true);
        break;
      default:
        throw new Error(`Unknown simulator action ${name}`);
    }
    panel.signal.throwIfAborted();
    render(v);
  }

  window.piProjects.register({
    name: "simulator",
    async mount(slot, panel) {
      slot.innerHTML = `<section class="simulator-panel" aria-label="Project simulator">
  <div class="simulator-head"><b>Simulator</b><span class="badge" data-simulator-status>Loading</span></div>
  <p class="small muted" data-simulator-description></p>
  <div class="simulator-devices" role="group" aria-label="Project simulators" data-simulator-devices hidden></div>
  <div class="simulator-screen" data-simulator-screen hidden><img data-simulator-frame alt="Current project simulator screenshot" draggable="false"></div>
  <p class="small muted" data-simulator-caption hidden></p>
  <div class="simulator-actions" data-simulator-actions></div>
  <div class="simulator-confirm" data-simulator-confirm hidden></div>
  <p class="small simulator-error" role="status" data-simulator-error hidden></p>
  <p class="small muted" role="status" data-simulator-notice hidden></p>
  <details data-simulator-facts hidden><summary>Details</summary><div data-simulator-details></div></details>
</section>`;
      const intent = intents.get(panel.projectId) ?? null;
      const v = {
        panel,
        slot,
        projectId: panel.projectId,
        selected: null,
        snapshot: null,
        error: null,
        notice: null,
        intent,
        confirm: null,
        polling: false,
        capturing: null,
        epoch: 0,
        frameEpoch: 0,
        nextPoll: 0,
        nextFrame: 0,
        url: null,
        frameUdid: null,
        capturedAt: null,
        frameError: null,
        expanded: false,
      };
      views.set(panel, v);
      const timer = setInterval(() => tick(v), 1000);
      panel.signal.addEventListener(
        "abort",
        () => {
          clearInterval(timer);
          if (v.url) URL.revokeObjectURL(v.url);
          v.url = null;
          if (v.intent?.sender === v) v.intent.sender = null;
        },
        { once: true },
      );
      render(v);
      await load(v);
      panel.signal.throwIfAborted();
    },
    action,
  });
})();
