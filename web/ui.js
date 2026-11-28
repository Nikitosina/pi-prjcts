// The host `ui` document (theme, font, animations, hotkeys, panels, status line and its items) through `ui-get` / `ui-set`, followed on host topic `ui`.
// localStorage keeps the last copy only as the pre-paint cache (theme.js) and for a page that cannot reach the host.
import { setOverrides } from "./hotkeys.js";
import { emit, fail, state } from "./state.js";

export function mountUi(client) {
  const DEFAULT_UI = {
    theme: "claude",
    font: "jetbrains-mono",
    chatTextSize: "default",
    chatTextPercent: 100,
    animations: "subtle",
    hotkeys: {},
    panels: { list: true, context: true, hostAgent: false },
    statusLine: true,
    showThinking: true,
    toolSummaries: { enabled: false, model: null },
    statusItems: ["activity", "model", "thinking", "context", "cost", "limits", "spacer", "machine", "connection", "hints"].map((id) => ({
      id,
      enabled: true,
    })),
  };
  const LOCAL = client.storagePrefix + "pi-ui2-ui";

  function local() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL) || "null");
    } catch {
      return null;
    }
  }
  function normalize(ui) {
    return {
      ...DEFAULT_UI,
      ...(ui ?? {}),
      panels: { ...DEFAULT_UI.panels, ...(ui?.panels ?? {}) },
      hotkeys: { ...(ui?.hotkeys ?? {}) },
      toolSummaries: { ...DEFAULT_UI.toolSummaries, ...(ui?.toolSummaries ?? {}) },
      // A cache from before the field, or from an older host, draws today's bar.
      statusItems: Array.isArray(ui?.statusItems) ? ui.statusItems : DEFAULT_UI.statusItems,
    };
  }
  function apply(ui) {
    state.ui = ui;
    try {
      localStorage.setItem(LOCAL, JSON.stringify(ui)); // also the pre-paint cache read by theme.js
    } catch {}
    window.piUi2Boot.apply(ui);
    const app = document.querySelector("#app");
    app.dataset.list = ui.panels.list ? "1" : "0";
    app.dataset.context = ui.panels.context ? "1" : "0";
    app.dataset.statusline = ui.statusLine ? "1" : "0";
    setOverrides(ui.hotkeys);
    emit("ui", ui);
    const display = JSON.stringify([ui.showThinking, ui.toolSummaries]);
    if (display !== chatDisplay) {
      chatDisplay = display;
      emit("chat-display", ui); // transcripts redraw; turning summaries on needs a read, since the host hides them while off
    }
  }
  let chatDisplay = "";

  /** Reads the host's settings. A change notice that arrives while this page still has writes queued is left to the last write's
   * answer, which carries the host's full settings. */
  async function loadUi() {
    if (queued) return;
    await readUi();
  }
  async function readUi() {
    const result = await client.call("ui-get").catch((error) => {
      fail(error);
      return null;
    });
    if (result) {
      state.uiRevision = result.revision;
      apply(normalize(result.ui));
    } else if (!state.ui) apply(normalize(local()));
  }
  let writing = Promise.resolve(),
    queued = 0;
  /** Applies the patch at once, then writes it to the host; a stale revision re-reads and retries once. Resolves true when the
   * host kept it. While later writes wait, the page keeps its own copy: the host's answer predates them and would undo them. */
  function setUi(patch) {
    const next = normalize({
      ...state.ui,
      ...patch,
      panels: { ...state.ui.panels, ...(patch.panels ?? {}) },
      toolSummaries: { ...state.ui.toolSummaries, ...(patch.toolSummaries ?? {}) },
    });
    apply(next);
    queued++;
    const gate0 = client.guard(); // the connection period of the owner's change: a write queued across a drop is refused

    const done = writing.then(async () => {
      let gate = gate0;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await gate.call("ui-set", { revision: state.uiRevision, patch });
          state.uiRevision = result.revision;
          if (queued === 1) apply(normalize(result.ui));
          return true;
        } catch (error) {
          if (attempt || !/revision/i.test(error.message)) {
            fail(error);
            await readUi(); // show what the host kept, not the refused change
            return false;
          }
          // The revision lookup and the write that follows never run after the host went offline in between.
          try {
            state.uiRevision = (await gate.call("ui-get")).revision;
          } catch (lookup) {
            fail(lookup);
            await readUi();
            return false;
          }
        }
      }
    });
    writing = done.catch(() => false).finally(() => queued--);
    return done;
  }
  // System theme follows the OS while the page is open.
  window.piUi2Boot.dark.addEventListener("change", () => state.ui && window.piUi2Boot.apply(state.ui));
  window.piUi2Boot.reduced.addEventListener("change", () => state.ui && window.piUi2Boot.apply(state.ui));

  return { DEFAULT_UI, loadUi, setUi };
}
