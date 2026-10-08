// Runs before first paint (blocking script in <head>; the CSP forbids inline scripts). Preference lives in localStorage per browser: system | light | dark.
(() => {
  const key = "pi-projects-theme", query = matchMedia("(prefers-color-scheme: dark)");
  const preference = () => { try { const value = localStorage.getItem(key); return value === "light" || value === "dark" ? value : "system"; } catch { return "system"; } };
  const apply = () => { const pref = preference(); document.documentElement.dataset.theme = pref === "system" ? (query.matches ? "dark" : "light") : pref; document.documentElement.dataset.themePref = pref; };
  apply(); query.addEventListener("change", apply);
  window.piTheme = { get: preference, set(value) { try { value === "light" || value === "dark" ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {} apply(); } };
})();
