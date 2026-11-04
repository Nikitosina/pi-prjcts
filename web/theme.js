// Runs before first paint (a blocking classic script; the CSP forbids inline scripts). Applies the last known theme, font and animation
// level from this browser's cache of the host `ui` document. The host document stays the source.
(() => {
  const root = document.documentElement,
    dark = matchMedia("(prefers-color-scheme: dark)"),
    reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let cached = {};
  try {
    cached = JSON.parse(localStorage.getItem("pi-ui2-ui") || "{}") || {};
  } catch {}
  const apply = (ui) => {
    const theme = ["claude", "midnight", "light", "system"].includes(ui.theme) ? ui.theme : "claude";
    root.dataset.themePref = theme;
    root.dataset.theme = theme === "system" ? (dark.matches ? "claude" : "light") : theme;
    root.dataset.font = ["jetbrains-mono", "system-sans", "system-mono"].includes(ui.font) ? ui.font : "jetbrains-mono";
    const level = ["off", "subtle", "full"].includes(ui.animations) ? ui.animations : "subtle";
    root.dataset.motion = reduced.matches ? "off" : level;
  };
  apply(cached);
  window.piUi2Boot = { apply, dark, reduced };
})();
