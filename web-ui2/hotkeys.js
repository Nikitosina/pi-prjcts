// One hotkey registry. Features register named commands; bindings are the plan's defaults merged with `UiSettings.hotkeys`.
// A binding is "Mod+K" style: Mod is ⌘ on macOS and Ctrl elsewhere; single keys ("[", "h") fire only outside text fields.

export const DEFAULTS = {
  "toggle-list": "[",
  "toggle-context": "]",
  "host-agent": "\\",
  "focus-composer": "/",
  "leave-focus": "Escape",
  palette: "Mod+K",
  settings: "Mod+,",
  stop: "Mod+.",
  "toggle-steer": "B",
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`chat-${i + 1}`, String(i + 1)])),
  // Settings sections, active only while the overlay is open.
  "settings-general": "G",
  "settings-context": "C",
  "settings-model": "M",
  "settings-prompt": "P",
  "settings-tools": "T",
  "settings-automations": "R",
  "settings-tiers": "I",
  "settings-theme": "H",
  "settings-animations": "A",
  "settings-statusline": "S",
  "settings-hotkeys": "?",
  "settings-notifications": "N",
  "settings-remote": "O",
  "settings-deploy": "D",
  "settings-providers": "V",
};
export const LABELS = {
  "toggle-list": "Toggle list",
  "toggle-context": "Toggle context panel",
  "host-agent": "Host agent",
  "focus-composer": "Focus composer",
  "leave-focus": "Leave focus / close",
  palette: "Search and commands",
  settings: "Settings",
  stop: "Stop the current turn",
  "toggle-steer": "Queue or steer while busy",
};

const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const commands = new Map();
let overrides = {};
let capture = null;
const listeners = new Set();

/** `when()` decides whether the command is live (e.g. settings letters only inside the overlay). */
export function register(id, run, { when = () => true, label } = {}) {
  commands.set(id, { run, when });
  if (label) LABELS[id] ??= label;
}
export function setOverrides(next) {
  overrides = { ...(next ?? {}) };
  for (const listener of listeners) listener();
  paintHints();
}
export const onBindingsChange = (listener) => listeners.add(listener);
export function binding(id) {
  return overrides[id] ?? DEFAULTS[id] ?? "";
}
export function bindings() {
  return Object.keys(DEFAULTS).map((id) => ({ id, label: LABELS[id] ?? id, binding: binding(id), changed: id in overrides }));
}
/** Commands sharing a binding inside the same context; the hotkeys page shows them as conflicts. */
export function conflicts() {
  const seen = new Map(),
    out = new Set();
  for (const { id, binding: value } of bindings()) {
    if (!value) continue;
    const scope = id.startsWith("settings-") ? "settings" : "global";
    const k = `${scope}:${value.toLowerCase()}`;
    if (seen.has(k)) {
      out.add(id);
      out.add(seen.get(k));
    } else seen.set(k, id);
  }
  return out;
}
export function display(value) {
  if (!value) return "";
  return value
    .split("+")
    .map((part) =>
      part === "Mod"
        ? mac
          ? "⌘"
          : "Ctrl"
        : part === "Shift"
          ? "⇧"
          : part === "Alt"
            ? mac
              ? "⌥"
              : "Alt"
            : part === "Escape"
              ? "Esc"
              : part,
    )
    .join(mac ? "" : "+");
}
/** Fills every `<kbd data-hint="command">` with the current binding. */
export function paintHints(root = document) {
  for (const node of root.querySelectorAll("kbd[data-hint]")) {
    const text = display(binding(node.dataset.hint));
    node.textContent = text;
    node.hidden = !text;
  }
}
function eventBinding(event) {
  const k = event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return "";
  const mods = [];
  if (mac ? event.metaKey : event.ctrlKey) mods.push("Mod");
  if (event.altKey) mods.push("Alt");
  // Shift is part of the character for symbols ("?", "{"); only letters and named keys record it.
  if (event.shiftKey && (/^[A-Z]$/.test(k) ? false : k.length > 1)) mods.push("Shift");
  return [...mods, k].join("+");
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
/** The next key press is returned instead of dispatched (hotkeys page, Edit). */
export function captureNext() {
  return new Promise((resolve) => {
    capture = resolve;
  });
}
function typing(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}
addEventListener(
  "keydown",
  (event) => {
    if (event.isComposing) return;
    const pressed = eventBinding(event);
    if (!pressed) return;
    if (capture) {
      event.preventDefault();
      event.stopPropagation();
      const done = capture;
      capture = null;
      done(pressed === "Escape" ? null : pressed);
      return;
    }
    const modified = pressed.startsWith("Mod+");
    if (typing(event.target) && !modified && pressed !== "Escape") return;
    // Single keys must not steal from buttons that use the key (Space/Enter are never bound by default).
    for (const [id, command] of commands) {
      const bound = binding(id);
      if (!bound || !same(bound, pressed) || !command.when(event)) continue;
      if (command.run(event) === false) continue;
      event.preventDefault();
      return;
    }
  },
  true,
);
