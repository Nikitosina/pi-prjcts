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
  // A clone's short name: its source's name, numbered when several clones share it.
  function label(v, item) {
    const devices = v.snapshot?.devices ?? [];
    const name = (other) => sourceName(v, other.sourceUdid) ?? other.name.replace(/^pi-projects \S+ /, "");
    const same = devices.filter((other) => name(other) === name(item));
    return same.length > 1 ? `${name(item)} ${same.indexOf(item) + 1}` : name(item);
  }
  // Inline 16 px stroke icons in the inbox's own style (web/tree.js, web/statusline.js).
  const PATHS = {
    boot: "M5.5 3.6v8.8L12.4 8z",
    shutdown: "M8 2.4v5M4.7 4.4a4.9 4.9 0 1 0 6.6 0",
    new: "M8 3.2v9.6M3.2 8h9.6",
    expand: "M9.6 2.6h3.8v3.8M6.4 13.4H2.6V9.6M13.4 2.6 9.2 6.8M2.6 13.4l4.2-4.2",
    shrink: "M13.4 6.6H9.4V2.6M2.6 9.4h4v4M9.4 6.6l4-4M6.6 9.4l-4 4",
    reset: "M2.8 8a5.2 5.2 0 1 0 1.6-3.7M2.6 2.2v3.2h3.2",
    delete: "M2.8 4.4h10.4M6.3 4.4V2.8h3.4v1.6M4.3 4.4l.6 8.8h6.2l.6-8.8",
    disable: "M5.2 4.6h5.6a3.4 3.4 0 0 1 0 6.8H5.2a3.4 3.4 0 0 1 0-6.8zM5.4 8h.1",
    refresh: "M13.2 8a5.2 5.2 0 1 0-1.6 3.7M13.4 13.8v-3.2h-3.2",
    info: "M8 1.9a6.1 6.1 0 1 1 0 12.2A6.1 6.1 0 0 1 8 1.9zM8 7.2v4M8 4.9v.1",
    more: "M3.4 8h.1M8 8h.1M12.6 8h.1",
  };
  const icon = (name) =>
    `<svg class="simulator-glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="${PATHS[name]}" fill="none" stroke="currentColor" stroke-width="${name === "more" ? 2.4 : 1.5}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const button = (label, action, disabled = false, cls = "ghost-btn small", data = {}, glyph = "") =>
    `<button type="button" class="${cls}" data-action="simulator-${action}"${Object.entries(data)
      .map(([key, value]) => ` data-${key}="${esc(value)}"`)
      .join("")}${disabled ? " disabled" : ""}>${glyph ? icon(glyph) : ""}${label}</button>`;
  // An icon-only button: its name is the aria-label, and the same title for a pointer.
  const tool = (glyph, name, action, disabled = false) =>
    `<button type="button" class="icon-btn simulator-tool" data-action="simulator-${action}" aria-label="${esc(name)}" title="${esc(name)}"${disabled ? " disabled" : ""}>${icon(glyph)}</button>`;
  const item = (glyph, name, action, disabled, danger = false) =>
    button(name, action, disabled, `simulator-item${danger ? " danger-text" : ""}`, {}, glyph);
  // Replaces a region only when its markup changed, so a polled render keeps focus, selection and open details.
  function patch(node, html) {
    if (node.dataset.html === html) return false;
    node.innerHTML = html;
    node.dataset.html = html;
    return true;
  }

  const TONES = {
    Running: "good",
    Error: "bad",
    Unavailable: "bad",
    "Needs inspection": "bad",
    Off: "",
    "Shut down": "",
    "No simulator": "",
  };
  function toneOf(status) {
    if (status in TONES) return TONES[status];
    if (/running$/.test(status)) return status.startsWith("0/") ? "" : "good";
    return "work";
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
    // A patched region drops the focused button; the same action (and clone) gets it back.
    const held = document.activeElement?.closest(".simulator-panel button"),
      focused = held && slot.contains(held) ? held.dataset.action : null,
      focusedUdid = held?.dataset.udid;
    const status = statusOf(v);
    $("status").textContent = status;
    $("status").dataset.tone = toneOf(status);
    $("description").textContent = !s
      ? v.error
        ? "The simulator state could not be read."
        : "Reading simulator availability…"
      : !s.enabled
        ? "Off. Agents cannot create or manage simulators for this project."
        : !d
          ? "No simulator yet. The coordinator creates the ones its workers need."
          : "";
    $("description").hidden = !$("description").textContent;
    const tabs =
      s?.devices.length > 1
        ? s.devices
            .map(
              (item) =>
                `<button type="button" class="simulator-tab${item.udid === d?.udid ? " on" : ""}" aria-pressed="${item.udid === d?.udid}" data-action="simulator-select" data-udid="${esc(item.udid)}" title="${esc(item.udid)}"><span class="simulator-dot"${item.state === "Booted" ? " data-on" : ""} aria-hidden="true"></span>${esc(label(v, item))}<span class="simulator-sr">, ${item.state === "Booted" ? "running" : "shut down"}</span></button>`,
            )
            .join("")
        : d
          ? `<span class="simulator-name" title="${esc(d.udid)}">${esc(label(v, d))}</span>`
          : "";
    patch($("devices"), tabs);
    $("devices").setAttribute("role", s?.devices.length > 1 ? "group" : "none");
    const live = ready(v),
      showFrame = live && v.url && v.frameUdid === d.udid;
    $("screen").hidden = !live;
    $("screen").classList.toggle("waiting", !showFrame);
    $("screen").classList.toggle("expanded", !!v.expanded);
    $("frame").hidden = !showFrame;
    const caption = $("caption");
    caption.hidden = !live;
    caption.textContent = v.capturedAt
      ? `Updated ${ago(v.capturedAt)}${v.frameError ? " · showing the previous frame" : ""}`
      : "Waiting for a screenshot…";
    let actions = "",
      menu = "";
    if (!s) actions = button("Retry", "refresh", false, "ghost-btn small", {}, "refresh");
    else if (!s.enabled) actions = button("Turn on", "add", lock, "primary small");
    else {
      if (d) {
        const booted = d.state === "Booted";
        if (showFrame) actions += tool(v.expanded ? "shrink" : "expand", v.expanded ? "Shrink screenshot" : "Enlarge screenshot", "expand");
        if (s.devices.length < s.maxOwned) actions += tool("new", "New clone…", "new", locked(v, true));
        actions += button(
          booted ? "Shut down" : "Boot",
          booted ? "shutdown" : "boot",
          lock,
          "ghost-btn small",
          {},
          booted ? "shutdown" : "boot",
        );
        menu += item("reset", "Reset…", "reset", lock, true) + item("delete", "Delete…", "delete", lock, true);
      } else if (s.devices.length < s.maxOwned) actions += button("Create simulator…", "new", locked(v, true), "primary small", {}, "new");
      menu += item("disable", "Turn off management…", "disable", locked(v, true));
    }
    patch($("actions"), actions);
    patch($("menu"), menu);
    $("more").hidden = !menu;
    if (!menu) $("more").open = false;
    let fix = "";
    if (s?.status === "uncertain") fix += button("Inspect / acknowledge…", "recover", !recoverable(v), "primary small");
    if (v.intent && !pending(v)) fix += button("Retry exact request", "retry", false, "primary small", {}, "refresh");
    patch($("fix"), fix);
    $("fix").hidden = !fix;
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
    $("alert").hidden = !issue && !fix;
    $("notice").textContent = v.notice ?? "";
    $("notice").hidden = !v.notice;
    $("facts").hidden = !s;
    if (s)
      patch(
        $("details"),
        `${d ? `<p class="small muted">View only: the screenshot refreshes about every 4 seconds, and no clicks or keyboard input are sent to the simulator.</p>` : ""}<p class="small muted">Agents create, boot, shut down, reset and delete up to ${esc(s.maxOwned)} clones for this project while management is on. Source simulators, shared runtimes and global caches are never changed.</p><dl class="simulator-facts"><dt>Default source</dt><dd>${esc(sourceName(v, s.defaultSourceUdid) ?? "Newest shut-down iPhone")}</dd>${d ? `<dt>Cloned from</dt><dd>${esc(sourceName(v, d.sourceUdid) ?? d.sourceUdid)}</dd><dt>iOS</dt><dd>${esc(d.osVersion)}</dd><dt>Device</dt><dd class="mono">${esc(d.udid)}</dd><dt>Slimming</dt><dd>${d.slim ? `${esc(d.slim.managedDisabled)}/${esc(d.slim.managedTotal)} services disabled${d.slim.persistent ? ", persistent" : ""}` : "Not reported"}</dd>` : ""}</dl>`,
      );
    if (focused && !slot.contains(document.activeElement))
      (
        slot.querySelector(`[data-action="${focused}"]${focusedUdid ? `[data-udid="${CSS.escape(focusedUdid)}"]` : ""}:not(:disabled)`) ??
        $("actions").querySelector("button:not(:disabled)")
      )?.focus({ preventScroll: true });
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
      d = device(v),
      asked = v.confirm;
    v.slot.querySelector("[data-simulator-more]").open = false;
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
    // A confirmation opened from the menu takes the keyboard, since the menu item it came from is now hidden.
    if (v.confirm && v.confirm !== asked) v.slot.querySelector('[data-simulator-confirm] [data-action="simulator-cancel"]')?.focus();
  }

  window.piProjects.register({
    name: "simulator",
    async mount(slot, panel) {
      slot.innerHTML = `<section class="simulator-panel" aria-label="Project simulator">
  <div class="simulator-bar">
    <div class="simulator-devices" aria-label="Project simulators" data-simulator-devices></div>
    <span class="badge simulator-status" data-simulator-status>Loading</span>
    <div class="simulator-tools" data-simulator-actions></div>
    <details class="simulator-more" data-simulator-more hidden><summary class="icon-btn simulator-tool" aria-label="More actions" title="More actions">${icon("more")}</summary><div class="simulator-menu" data-simulator-menu></div></details>
  </div>
  <p class="small muted" data-simulator-description></p>
  <div class="simulator-screen" data-simulator-screen hidden><img data-simulator-frame alt="Current project simulator screenshot" draggable="false" hidden></div>
  <p class="small muted simulator-caption" data-simulator-caption hidden></p>
  <div class="simulator-alert" data-simulator-alert hidden>
    <p class="small simulator-error" role="status" data-simulator-error hidden></p>
    <div class="simulator-actions" data-simulator-fix hidden></div>
  </div>
  <div class="simulator-confirm" data-simulator-confirm hidden></div>
  <p class="small muted" role="status" data-simulator-notice hidden></p>
  <details class="simulator-details" data-simulator-facts hidden><summary>${icon("info")}Details</summary><div data-simulator-details></div></details>
</section>`;
      // The menu closes on a press anywhere outside it (touch included); its own summary toggles it.
      const more = slot.querySelector("[data-simulator-more]");
      document.addEventListener("pointerdown", (event) => more.open && !more.contains(event.target) && (more.open = false), {
        signal: panel.signal,
      });
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
