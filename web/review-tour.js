import { esc } from "./format.js";
export function reviewTour(snapshot, chatId, rpc, live, show) {
  let status = snapshot.tour ?? {},
    touring = false,
    selected = "",
    timer;
  const changed = (map, current, path) => map.blobs[":" + path] !== (current.get(path)?.patchId ?? current.get(path)?.blob);
  const stale = (m) => m.head !== snapshot.head || m.base !== snapshot.base;
  const mode = () => status.map?.steps.find((s) => s.title === selected) ?? status.map?.steps[0];
  function controls() {
    const m = status.map;
    return (
      (m
        ? `<div class="seg"><button data-tour-mode="files" aria-pressed="${!touring}">Files</button><button data-tour-mode="tour" aria-pressed="${touring}">✦ Tour ${m.steps.indexOf(mode()) + 1}/${m.steps.length}${stale(m) ? " •" : ""}</button></div>`
        : "") +
      (status.building
        ? '<span data-tour-building class="small muted">✦ Scout is drawing the review map…</span>'
        : !m || status.error
          ? `<button class="ghost-btn small" data-tour-request title="${esc(status.error ?? "Build a map for this PR")}">${status.error ? "↻ Retry tour" : "✦ Guided tour"}</button>`
          : "")
    );
  }
  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!live()) return;
      try {
        status = await rpc("tour-status", {});
      } catch (e) {
        status = { ...status, building: false, error: e.message };
      }
      if (!live()) return;
      if (status.building) return poll();
      const control = live().querySelector("[data-tour-control]");
      if (!control?.childElementCount) return;
      if (live().querySelector(".rv-compose,dialog[open]") || status.error) {
        control.innerHTML = controls();
        return;
      }
      touring = !!status.map;
      await show();
    }, 1200);
  }
  function view(files, enabled) {
    const m = status.map,
      current = new Map(files.map((f) => [f.path, f]));
    if (!enabled || !touring || !m) return null;
    const step = mode(),
      idx = m.steps.indexOf(step);
    const modified = (p) => changed(m, current, p);
    const stepFiles = files.filter((f) => step.files.includes(f.path));
    return {
      files: stepFiles,
      step,
      modified,
      nav:
        `<div class="ft-title">Review map</div>` +
        m.steps
          .map(
            (s, i) =>
              `<button data-step="${i}" class="tour-step ${s.files.some(modified) ? "changed" : ""}" aria-current="${s === step}"><span>${i + 1}</span><b>${esc(s.title)}</b><small>${s.files.some(modified) ? "↻" : esc(s.risk)}</small></button>`,
          )
          .join(""),
      intro: `${stale(m) ? `<div class="stale-map">↻ Map built on ${esc(m.head.slice(0, 8))}. Marked files changed; notes may be outdated. ${status.building ? "" : "<button data-tour-request>↻ Rebuild map</button>"}</div>` : ""}<section class="tour-card"><small>STEP ${idx + 1} OF ${m.steps.length} · ${esc(step.risk.toUpperCase())} RISK</small><h2>${esc(step.title)}</h2><small>✦ Scout’s map · ${m.ours ? "diff + Ready report" : "diff + PR description"}</small><p>${esc(step.why)}</p>${step.checks.map((c) => `<label><input type="checkbox"> ${esc(c)}</label>`).join("")}<button data-approve-step ${stepFiles.length ? "" : "disabled"}>✓ Approve step</button></section>`,
    };
  }
  async function click(el) {
    const d = el.dataset;
    if ("tourRequest" in d) {
      if (status.building) return true;
      el.disabled = true;
      try {
        status = await rpc("tour", { head: snapshot.head, base: snapshot.base, chatId });
        if (!live()) return;
        live().querySelector("[data-tour-control]").innerHTML = controls();
        if (status.building) poll();
        else await show();
      } finally {
        el.disabled = !!status.building;
      }
      return true;
    }
    if ("tourMode" in d) touring = d.tourMode === "tour";
    else if ("step" in d) selected = status.map.steps[+d.step].title;
    else if ("approveStep" in d) {
      el.disabled = true;
      try {
        await rpc("approve-step", {
          head: snapshot.head,
          base: snapshot.base,
          mapHead: status.map.head,
          mapBase: status.map.base,
          title: mode().title,
        });
      } finally {
        el.disabled = false;
      }
    } else return false;
    if (live()) await show();
    return true;
  }
  if (status.building) poll();
  return { controls, view, click, stop: () => clearTimeout(timer) };
}
