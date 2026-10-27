// PROTOTYPE — wipe me. See web/PROTOTYPE-SIDEBAR-NOTES.md.
// Three variants of "expandable project sidebar of non-archived coordinators + cross-project top tab bar",
// mounted on the existing inbox page via ?variant=A|B|C (sub-shape A). All state lives in memory below;
// nothing here calls the host API. Loaded only when ?variant= is present (see the loader at the end of app.js)
// and served only when NODE_ENV !== "production" (src/web.ts).
(() => {
  const VARIANTS = { A: "Arc project tree + compact tabs", B: "Hermes workspace navigator + document tabs", C: "Split rail + grouped tabs" };
  const keys = Object.keys(VARIANTS);
  const initialKey = new URLSearchParams(location.search).get("variant");
  if (!keys.includes(initialKey)) return;

  // ---- sample coordinators (cycled over projects by index); `archived` ones must never show ----
  const SETS = [
    [
      { t: "Main coordinator", st: "working", blurb: "Wiring OAuth refresh into the session store; 3 workers on it.", w: 3, ago: "2m" },
      { t: "Release 0.9 checklist", st: "needs", blurb: "Waiting on your OK to tag v0.9.0 and push the release branch.", w: 1, ago: "14m" },
      { t: "Flaky e2e triage", st: "idle", blurb: "Quarantined 4 tests; root cause is fake timers in the queue suite.", w: 0, ago: "3h" },
      { t: "Q2 dependency sweep", st: "idle", blurb: "Finished and archived.", w: 0, ago: "6d", archived: true },
    ],
    [
      { t: "Main coordinator", st: "idle", blurb: "Invoice rounding fix merged; nothing running.", w: 0, ago: "1h" },
      { t: "Stripe webhook retries", st: "working", blurb: "Reviewer is checking idempotency keys on the retry path.", w: 2, ago: "now" },
      { t: "Tax table import", st: "done", blurb: "EU rates loaded, 212 rows diffed. Not yet checked by you.", w: 0, ago: "27m" },
      { t: "Old ledger spike", st: "idle", blurb: "Abandoned prototype.", w: 0, ago: "3w", archived: true },
      { t: "Dunning emails", st: "idle", blurb: "Copy approved; waiting for template slot next sprint.", w: 0, ago: "2d" },
    ],
    [
      { t: "Main coordinator", st: "needs", blurb: "Asked: ship dark-mode icons now or after the redesign?", w: 0, ago: "8m" },
      { t: "iOS 19 build fixes", st: "working", blurb: "Scout is bisecting a SwiftUI preview crash.", w: 2, ago: "4m" },
      { t: "Push notification copy", st: "idle", blurb: "Three drafts saved to knowledge/push-copy.md.", w: 0, ago: "1d" },
    ],
    [
      { t: "Main coordinator", st: "idle", blurb: "Docs build green on main.", w: 0, ago: "5h" },
      { t: "API reference regen", st: "done", blurb: "OpenAPI v3.2 pages regenerated; 14 files changed.", w: 0, ago: "40m" },
      { t: "Broken-link audit", st: "working", blurb: "Crawler worker at 312 / 1,040 pages.", w: 1, ago: "1m" },
      { t: "Legacy v1 docs", st: "idle", blurb: "Removed.", w: 0, ago: "2mo", archived: true },
    ],
  ];
  const SAMPLE_PROJECTS = [{ id: "sample-billing", name: "Billing service" }, { id: "sample-mobile", name: "Mobile app" }, { id: "sample-docs", name: "Docs site" }];

  // ---- in-memory state ----
  const state = { variant: initialKey, expanded: new Set(), tabs: [], active: null, seeded: false };

  const esc = value => String(value).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const initials = name => name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();
  const STATE_LABEL = { working: "Working", needs: "Needs you", done: "Done", idle: "Idle" };

  // Real projects first (from app.js's global `projects`), padded with samples so cross-project tabs are testable on a one-project host.
  function model() {
    const real = (typeof projects !== "undefined" ? projects : []).map(p => ({ id: p.id, name: p.name, real: true }));
    const all = [...real, ...SAMPLE_PROJECTS.map(p => ({ ...p, real: false }))].slice(0, Math.max(real.length, 4));
    return all.map((p, index) => ({
      ...p, hue: (index * 67 + 18) % 360,
      all: SETS[index % SETS.length].map((c, i) => ({ ...c, id: `${p.id}::${i}`, pid: p.id })),
      coordinators: SETS[index % SETS.length].map((c, i) => ({ ...c, id: `${p.id}::${i}`, pid: p.id })).filter(c => !c.archived),
    }));
  }
  const byId = (m, id) => { for (const p of m) for (const c of p.coordinators) if (c.id === id) return { p, c }; return null; };

  // ---- actions ----
  function toggle(pid) { state.expanded.has(pid) ? state.expanded.delete(pid) : state.expanded.add(pid); draw(); }
  // Real project: use the app's own project switch (read-only navigation) so the page below follows the active tab; tabs live here and survive it.
  function followActive() {
    const hit = state.active && byId(model(), state.active);
    if (hit?.p.real && typeof projectId !== "undefined" && hit.p.id !== projectId) document.querySelector(`#project-list [data-select-project="${CSS.escape(hit.p.id)}"]`)?.click();
  }
  function open(id) {
    if (!state.tabs.includes(id)) state.tabs.push(id);
    state.active = id;
    followActive();
    draw();
  }
  function close(id) {
    const at = state.tabs.indexOf(id);
    if (at < 0) return;
    state.tabs.splice(at, 1);
    if (state.active === id) { state.active = state.tabs[at] ?? state.tabs[at - 1] ?? null; followActive(); } // right neighbour, else left, else empty
    draw();
  }
  function setVariant(key) {
    state.variant = key;
    const url = new URL(location.href); url.searchParams.set("variant", key); history.replaceState(null, "", url);
    draw();
  }

  // ---- DOM mounting ----
  const side = document.querySelector("#side"), main = document.querySelector(".main"), phead = document.querySelector(".phead");
  const nav = Object.assign(document.createElement("div"), { id: "proto-nav" });
  const bar = Object.assign(document.createElement("div"), { id: "proto-tabs" });
  const detail = Object.assign(document.createElement("div"), { id: "proto-detail" });
  side.querySelector("#project-list").after(nav);
  phead.before(bar, detail);
  const switcher = Object.assign(document.createElement("div"), { id: "proto-switcher", role: "toolbar" });
  switcher.setAttribute("aria-label", "Prototype variant switcher");
  document.body.append(switcher);

  const dot = c => `<span class="pp-dot" data-state="${c.st}" title="${STATE_LABEL[c.st]}"></span>`;
  const x = c => `<span class="pp-x" role="button" tabindex="0" data-pp-close="${esc(c.id)}" aria-label="Close ${esc(c.t)}">×</span>`;

  function renderNav(m) {
    const v = state.variant;
    const child = (p, c) => {
      const on = state.active === c.id, opened = state.tabs.includes(c.id);
      if (v === "B") return `<button class="pp-child ${on ? "on" : ""} ${opened ? "opened" : ""}" data-pp-open="${esc(c.id)}"><span class="pp-line">${dot(c)}<b>${esc(c.t)}</b><em>${c.ago}</em></span><span class="pp-blurb">${esc(c.blurb)}</span><span class="pp-pill" data-state="${c.st}">${STATE_LABEL[c.st]}${c.w ? ` · ${c.w} worker${c.w > 1 ? "s" : ""}` : ""}</span></button>`;
      if (v === "C") return `<button class="pp-child ${on ? "on" : ""} ${opened ? "opened" : ""}" data-pp-open="${esc(c.id)}" style="--h:${p.hue}">${dot(c)}<span class="pp-t">${esc(c.t)}</span><span class="pp-ago">${c.ago}</span></button>`;
      return `<button class="pp-child ${on ? "on" : ""} ${opened ? "opened" : ""}" data-pp-open="${esc(c.id)}">${dot(c)}<span class="pp-t">${esc(c.t)}</span></button>`;
    };
    if (v === "C") {
      const rail = m.map(p => `<button class="pp-rail-btn ${state.expanded.has(p.id) ? "open" : ""}" data-pp-toggle="${esc(p.id)}" style="--h:${p.hue}" title="${esc(p.name)} — ${p.coordinators.length} coordinators" aria-expanded="${state.expanded.has(p.id)}" aria-label="${esc(p.name)}">${esc(initials(p.name))}<i>${p.coordinators.length}</i></button>`).join("");
      const groups = m.filter(p => state.expanded.has(p.id)).map(p => `<section class="pp-group" style="--h:${p.hue}"><header>${esc(p.name)}<span>${p.coordinators.length}</span></header>${p.coordinators.map(c => child(p, c)).join("")}</section>`).join("") || `<p class="pp-empty">Tap a project in the rail to expand it.</p>`;
      return `<div class="pp-rail">${rail}</div><div class="pp-list">${groups}</div>`;
    }
    return m.map(p => {
      const open = state.expanded.has(p.id), nOpen = p.coordinators.filter(c => state.tabs.includes(c.id)).length;
      const head = v === "B"
        ? `<button class="pp-proj" data-pp-toggle="${esc(p.id)}" aria-expanded="${open}" style="--h:${p.hue}"><span class="pp-av">${esc(initials(p.name))}</span><span class="pp-name"><b>${esc(p.name)}</b><small>${p.coordinators.length} coordinators${nOpen ? ` · ${nOpen} open` : ""}</small></span><span class="pp-chev">${open ? "−" : "+"}</span></button>`
        : `<button class="pp-proj" data-pp-toggle="${esc(p.id)}" aria-expanded="${open}" style="--h:${p.hue}"><span class="pp-chev">${open ? "▾" : "▸"}</span><span class="pp-av">${esc(initials(p.name))}</span><span class="pp-name">${esc(p.name)}</span><span class="pp-count">${p.coordinators.length}</span></button>`;
      return `<section class="pp-node ${open ? "open" : ""}">${head}${open ? `<div class="pp-children">${p.coordinators.map(c => child(p, c)).join("")}</div>` : ""}</section>`;
    }).join("");
  }

  function renderTabs(m) {
    const v = state.variant;
    const tab = id => {
      const hit = byId(m, id); if (!hit) return "";
      const { p, c } = hit, on = state.active === id;
      const inner = v === "B"
        ? `<span class="pp-crumb">${esc(p.name)}</span><span class="pp-tt">${dot(c)}${esc(c.t)}</span>`
        : `${v === "A" ? `<span class="pp-tag" style="--h:${p.hue}">${esc(initials(p.name))}</span>` : ""}${dot(c)}<span class="pp-tt">${esc(c.t)}</span>`;
      return `<div class="pp-tab ${on ? "on" : ""}" role="tab" aria-selected="${on}" data-pp-open="${esc(id)}" style="--h:${p.hue}" title="${esc(p.name)} / ${esc(c.t)}">${inner}${x(c)}</div>`;
    };
    if (!state.tabs.length) return `<span class="pp-none">No coordinators open — pick one in the sidebar</span>`;
    if (v === "C") {
      const order = [...new Set(state.tabs.map(id => byId(m, id)?.p.id))];
      return order.map(pid => { const p = m.find(q => q.id === pid); return `<div class="pp-tabgroup" style="--h:${p.hue}"><span class="pp-grp">${esc(p.name)}</span>${state.tabs.filter(id => byId(m, id)?.p.id === pid).map(tab).join("")}</div>`; }).join("");
    }
    return state.tabs.map(tab).join("");
  }

  function renderDetail(m) {
    const hit = state.active && byId(m, state.active);
    if (!hit) return `<span class="pp-none">Empty state: no active coordinator</span>`;
    const { p, c } = hit;
    return `<span class="pp-dtitle">${dot(c)}<b>${esc(c.t)}</b><small>in ${esc(p.name)}${p.real ? "" : " (sample project)"}</small></span><span class="pp-dblurb">${esc(c.blurb)}</span><span class="pp-pill" data-state="${c.st}">${STATE_LABEL[c.st]}${c.w ? ` · ${c.w} worker${c.w > 1 ? "s" : ""}` : ""} · ${c.ago}</span>`;
  }

  function draw() {
    const m = model();
    if (!state.seeded && m.some(p => p.real)) { state.seeded = true; m.slice(0, 2).forEach(p => state.expanded.add(p.id)); }
    document.body.dataset.protoVariant = state.variant;
    nav.innerHTML = renderNav(m);
    bar.innerHTML = renderTabs(m);
    bar.setAttribute("role", "tablist");
    detail.innerHTML = renderDetail(m);
    const at = keys.indexOf(state.variant);
    switcher.innerHTML = `<button data-pp-prev aria-label="Previous variant">←</button><span class="pp-label"><b>${state.variant}</b> — ${esc(VARIANTS[state.variant])}</span><button data-pp-next aria-label="Next variant">→</button>`
      + `<span class="pp-state" aria-label="Prototype state">expanded: ${[...state.expanded].map(id => m.find(p => p.id === id)?.name).filter(Boolean).join(", ") || "none"} · open: ${state.tabs.length} · active: ${state.active ? byId(m, state.active)?.c.t : "none"}</span>`;
    switcher.dataset.at = at;
  }

  // ---- events ----
  document.addEventListener("click", event => {
    const closeBtn = event.target.closest("[data-pp-close]");
    if (closeBtn) { event.stopPropagation(); close(closeBtn.dataset.ppClose); return; }
    const t = event.target.closest("[data-pp-toggle]"); if (t) return toggle(t.dataset.ppToggle);
    const o = event.target.closest("[data-pp-open]"); if (o) return open(o.dataset.ppOpen);
    if (event.target.closest("[data-pp-prev]")) setVariant(keys[(keys.indexOf(state.variant) + keys.length - 1) % keys.length]);
    if (event.target.closest("[data-pp-next]")) setVariant(keys[(keys.indexOf(state.variant) + 1) % keys.length]);
  }, true);
  document.addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const el = document.activeElement;
    if (el && (el.matches("input, textarea, select") || el.isContentEditable)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || document.querySelector("dialog[open]")) return;
    setVariant(keys[(keys.indexOf(state.variant) + (event.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length]);
  });
  // The real project list loads late and re-renders on live updates; follow it.
  new MutationObserver(draw).observe(document.querySelector("#project-list"), { childList: true });
  draw();
})();
