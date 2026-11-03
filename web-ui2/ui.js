// The host `ui` document (theme, animations, hotkeys, panels, status line) through `ui-get` / `ui-set`, followed on host topic `ui`.
// Before the backend merge the requests are unknown: the same document is kept in this browser instead, and the settings say so.
import { contract, isUnavailable } from "./api.js";
import { setOverrides } from "./hotkeys.js";
import { emit, fail, state } from "./state.js";

export const DEFAULT_UI = {
  theme: "claude",
  animations: "subtle",
  hotkeys: {},
  panels: { list: true, context: true, hostAgent: false },
  statusLine: true,
};
const LOCAL = "pi-ui2-ui";

function local() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL) || "null");
  } catch {
    return null;
  }
}
function normalize(ui) {
  return { ...DEFAULT_UI, ...(ui ?? {}), panels: { ...DEFAULT_UI.panels, ...(ui?.panels ?? {}) }, hotkeys: { ...(ui?.hotkeys ?? {}) } };
}
function apply(ui) {
  state.ui = ui;
  try {
    localStorage.setItem(LOCAL, JSON.stringify(ui)); // also the pre-paint cache read by boot.js
  } catch {}
  window.piUi2Boot.apply(ui);
  const app = document.querySelector("#app");
  app.dataset.list = ui.panels.list ? "1" : "0";
  app.dataset.context = ui.panels.context ? "1" : "0";
  app.dataset.statusline = ui.statusLine ? "1" : "0";
  setOverrides(ui.hotkeys);
  emit("ui", ui);
}

export async function loadUi() {
  const result = await contract("ui-get").catch((error) => {
    fail(error);
    return null;
  });
  if (result && !isUnavailable(result)) {
    state.uiAvailable = true;
    state.uiRevision = result.revision;
    apply(normalize(result.ui));
  } else {
    state.uiAvailable = !result ? state.uiAvailable : false;
    apply(normalize(local()));
  }
}
let writing = Promise.resolve();
/** Applies the patch at once, then writes it to the host; a stale revision re-reads and retries once. */
export function setUi(patch) {
  const next = normalize({ ...state.ui, ...patch, panels: { ...state.ui.panels, ...(patch.panels ?? {}) } });
  apply(next);
  if (!state.uiAvailable) return Promise.resolve();
  writing = writing.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await contract("ui-set", { revision: state.uiRevision, patch });
        if (isUnavailable(result)) {
          state.uiAvailable = false;
          return;
        }
        state.uiRevision = result.revision;
        apply(normalize(result.ui));
        return;
      } catch (error) {
        if (attempt || !/revision/i.test(error.message)) return fail(error);
        const fresh = await contract("ui-get");
        if (!isUnavailable(fresh)) state.uiRevision = fresh.revision;
      }
    }
  });
  return writing;
}
// System theme follows the OS while the page is open.
window.piUi2Boot.dark.addEventListener("change", () => state.ui && window.piUi2Boot.apply(state.ui));
window.piUi2Boot.reduced.addEventListener("change", () => state.ui && window.piUi2Boot.apply(state.ui));
