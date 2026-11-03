// The host `ui` document (theme, font, animations, hotkeys, panels, status line) through `ui-get` / `ui-set`, followed on host topic `ui`.
// localStorage keeps the last copy only as the pre-paint cache (boot.js) and for a page that cannot reach the host.
import { call } from "./api.js";
import { setOverrides } from "./hotkeys.js";
import { emit, fail, state } from "./state.js";

export const DEFAULT_UI = {
  theme: "claude",
  font: "jetbrains-mono",
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
  const result = await call("ui-get").catch((error) => {
    fail(error);
    return null;
  });
  if (result) {
    state.uiRevision = result.revision;
    apply(normalize(result.ui));
  } else if (!state.ui) apply(normalize(local()));
}
let writing = Promise.resolve();
/** Applies the patch at once, then writes it to the host; a stale revision re-reads and retries once. Resolves true when the
 * host kept it. */
export function setUi(patch) {
  const next = normalize({ ...state.ui, ...patch, panels: { ...state.ui.panels, ...(patch.panels ?? {}) } });
  apply(next);
  const done = writing.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await call("ui-set", { revision: state.uiRevision, patch });
        state.uiRevision = result.revision;
        apply(normalize(result.ui));
        return true;
      } catch (error) {
        if (attempt || !/revision/i.test(error.message)) {
          fail(error);
          await loadUi(); // show what the host kept, not the refused change
          return false;
        }
        state.uiRevision = (await call("ui-get")).revision;
      }
    }
  });
  writing = done.catch(() => false);
  return done;
}
// System theme follows the OS while the page is open.
window.piUi2Boot.dark.addEventListener("change", () => state.ui && window.piUi2Boot.apply(state.ui));
window.piUi2Boot.reduced.addEventListener("change", () => state.ui && window.piUi2Boot.apply(state.ui));
