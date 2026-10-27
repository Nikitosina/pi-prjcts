// PROTOTYPE, round 2 — wipe me. See web/PROTOTYPE-SIDEBAR-NOTES.md.
// Round 1 (A/B/C) was rejected by the owner and removed. Round 2: three desktop-shell directions on the existing inbox route,
// opt-in with ?variant=D|E|F. Each variant is a full-window shell (project tree + cross-project tabs + a mock conversation) laid
// over the real page, so the shell can be judged as one piece. Everything is in memory; this file never calls the host API.
// Loaded only when ?variant= is present (loader at the end of app.js) and served only when NODE_ENV !== "production" (src/web.ts).
(() => {
  const VARIANTS = { D: "Titlebar tabs + dark tree", E: "Inset canvas (Arc-like)", F: "IDE explorer + status bar" };
  const keys = Object.keys(VARIANTS);
  const initialKey = new URLSearchParams(location.search).get("variant");
  if (!keys.includes(initialKey)) return;

  // ---- sample coordinators (cycled over projects by index); `archived` ones must never show ----
  const SETS = [
    [
      { t: "Main coordinator", st: "working", blurb: "Wiring OAuth refresh into the session store. Two workers are editing, one reviewing.", w: 3, ago: "2m" },
      { t: "Release 0.9 checklist", st: "needs", blurb: "Everything on the checklist is green. I need your OK before I tag v0.9.0 and push the release branch.", ask: "Tag v0.9.0 and push release/0.9?", w: 1, ago: "14m" },
      { t: "Flaky e2e triage", st: "idle", blurb: "Quarantined 4 tests. Root cause is fake timers leaking between cases in the queue suite.", w: 0, ago: "3h" },
      { t: "Q2 dependency sweep", st: "idle", blurb: "Finished and archived.", w: 0, ago: "6d", archived: true },
    ],
    [
      { t: "Main coordinator", st: "idle", blurb: "Invoice rounding fix is merged. Nothing is running.", w: 0, ago: "1h" },
      { t: "Stripe webhook retries", st: "working", blurb: "A reviewer is checking idempotency keys on the retry path. Backoff is capped at 6 attempts.", w: 2, ago: "now" },
      { t: "Tax table import", st: "done", blurb: "EU rates are loaded and 212 rows diffed against last quarter. 9 changed, none above 1 point.", w: 0, ago: "27m" },
      { t: "Old ledger spike", st: "idle", blurb: "Abandoned prototype.", w: 0, ago: "3w", archived: true },
      { t: "Dunning emails", st: "idle", blurb: "Copy is approved. Waiting for a template slot next sprint.", w: 0, ago: "2d" },
    ],
    [
      { t: "Main coordinator", st: "needs", blurb: "Dark-mode icons are ready. They would ship with a visible style mismatch until the redesign lands.", ask: "Ship dark-mode icons now or after the redesign?", w: 0, ago: "8m" },
      { t: "iOS 19 build fixes", st: "working", blurb: "A scout is bisecting a SwiftUI preview crash. Narrowed to three commits.", w: 2, ago: "4m" },
      { t: "Push notification copy", st: "idle", blurb: "Three drafts are saved to knowledge/push-copy.md.", w: 0, ago: "1d" },
    ],
    [
      { t: "Main coordinator", st: "idle", blurb: "Docs build is green on main.", w: 0, ago: "5h" },
      { t: "API reference regen", st: "done", blurb: "OpenAPI v3.2 pages regenerated. 14 files changed, no broken anchors.", w: 0, ago: "40m" },
      { t: "Broken-link audit", st: "working", blurb: "The crawler worker is at 312 of 1,040 pages. 7 dead links so far, all in the v1 archive.", w: 1, ago: "1m" },
      { t: "Legacy v1 docs", st: "idle", blurb: "Removed.", w: 0, ago: "2mo", archived: true },
    ],
  ];
  const SAMPLE_PROJECTS = [{ id: "sample-billing", name: "Billing service" }, { id: "sample-mobile", name: "Mobile app" }, { id: "sample-docs", name: "Docs site" }];
  const STATE_LABEL = { working: "Working", needs: "Needs you", done: "Done", idle: "Idle" };
  const ROLES = ["implementer", "reviewer", "scout"];

  // ---- in-memory state ----
  const state = { variant: initialKey, expanded: new Set(), tabs: [], active: null, seeded: false, drafts: {}, extra: {}, answered: {}, sideHidden: false };

  const esc = value => String(value).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const initials = name => name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase();

  // Real project names first (app.js's global `projects`), padded with samples so cross-project tabs work on a one-project host.
  function model() {
    const real = (typeof projects !== "undefined" ? projects : []).map(p => ({ id: p.id, name: p.name }));
    const all = [...real, ...SAMPLE_PROJECTS].slice(0, Math.max(real.length, 4));
    return all.map((p, index) => {
      const coordinators = SETS[index % SETS.length].map((c, i) => ({ ...c, id: `${p.id}::${i}`, pid: p.id })).filter(c => !c.archived);
      return { ...p, hue: (index * 67 + 18) % 360, coordinators };
    });
  }
  const byId = (m, id) => { for (const p of m) for (const c of p.coordinators) if (c.id === id) return { p, c }; return null; };

  // ---- mock conversation for one coordinator ----
  function conversation(p, c) {
    const done = { working: 2, needs: 3, done: 4, idle: 4 }[c.st];
    const steps = ["Read the relevant code and recent history", "Make the change in an isolated worktree", "Review it and run the checks", "Report back to you"];
    const plan = `<ul class="pp-plan">${steps.map((s, i) => `<li data-s="${i < done ? "done" : i === done && c.st === "working" ? "run" : "wait"}">${s}</li>`).join("")}</ul>`;
    const events = Array.from({ length: c.w }, (_, i) => `<div class="msg ev"><span class="pp-dot" data-state="working"></span><b>${ROLES[i % 3]}-${i + 1}</b> ${["edited 6 files in the worktree, checks running", "is reading the diff, no findings yet", "searched 31 files and wrote notes to knowledge"][i % 3]}</div>`).join("");
    const answered = state.answered[c.id];
    const ask = c.ask ? `<div class="pp-ask"><p>${esc(c.ask)}</p>${answered ? `<p class="pp-answered">You answered: ${esc(answered)}</p>` : `<button data-pp-answer="Yes, go ahead">Yes, go ahead</button><button data-pp-answer="Not yet">Not yet</button>`}</div>` : "";
    const extra = (state.extra[c.id] ?? []).map(m => `<article class="msg ${m.who}"><span class="who">${m.who === "you" ? "you" : "coordinator"}</span><div class="txt">${esc(m.text)}</div><time>now</time></article>`).join("");
    return `<div class="pp-chead"><b>${esc(c.t)}</b><span>${esc(p.name)}</span></div>`
      + `<article class="msg you"><span class="who">you</span><div class="txt">Pick up “${esc(c.t)}”. What is the plan?</div><time>${c.ago === "now" ? "1h" : "1d"}</time></article>`
      + `<article class="msg coord"><span class="who">coordinator</span><div class="txt"><p>Here is the plan. Workers run in their own worktrees and I report back when each step is done.</p>${plan}</div><time>${c.ago === "now" ? "55m" : "1d"}</time></article>`
      + events
      + `<article class="msg coord"><span class="who">coordinator</span><div class="txt"><p>${esc(c.blurb)}</p>${ask}</div><time>${c.ago}</time></article>`
      + extra;
  }

  // ---- actions ----
  const toggle = pid => { state.expanded.has(pid) ? state.expanded.delete(pid) : state.expanded.add(pid); draw(); };
  function open(id) { if (!state.tabs.includes(id)) state.tabs.push(id); state.active = id; draw(); }
  function focus(id) { state.active = id; draw(); }
  function close(id) {
    const at = state.tabs.indexOf(id);
    if (at < 0) return;
    state.tabs.splice(at, 1);
    if (state.active === id) state.active = state.tabs[at] ?? state.tabs[at - 1] ?? null; // right neighbour, else left, else empty
    draw();
  }
  function setVariant(key) {
    state.variant = key;
    const url = new URL(location.href); url.searchParams.set("variant", key); history.replaceState(null, "", url);
    draw();
  }
  function send(text) {
    const id = state.active; if (!id || !text.trim()) return;
    (state.extra[id] ??= []).push({ who: "you", text });
    state.drafts[id] = "";
    const box = shell.querySelector("textarea"); if (box) box.value = "";
    draw(true);
    setTimeout(() => { (state.extra[id] ??= []).push({ who: "coord", text: "Noted. This is a prototype: no model is called and nothing is saved." }); draw(true); }, 500);
  }
  function answer(text) {
    const id = state.active; state.answered[id] = text;
    (state.extra[id] ??= []).push({ who: "you", text }, { who: "coord", text: text === "Not yet" ? "Understood, I will hold and keep the branch as it is." : "On it. I will report back when it is done." });
    draw(true);
  }

  // ---- DOM ----
  const shell = Object.assign(document.createElement("div"), { id: "proto-shell" });
  const switcher = Object.assign(document.createElement("div"), { id: "proto-switcher", role: "toolbar" });
  switcher.setAttribute("aria-label", "Prototype variant switcher");
  document.body.append(shell, switcher);

  const dot = c => `<span class="pp-dot" data-state="${c.st}" title="${STATE_LABEL[c.st]}"></span>`;
  const x = c => `<span class="pp-x" role="button" tabindex="0" data-pp-close="${esc(c.id)}" aria-label="Close ${esc(c.t)}">×</span>`;

  function tree(m) {
    return m.map(p => {
      const open = state.expanded.has(p.id);
      const kids = open ? `<div class="pp-children">${p.coordinators.map(c => `<button class="pp-child ${state.active === c.id ? "on" : ""} ${state.tabs.includes(c.id) ? "opened" : ""}" data-pp-open="${esc(c.id)}" title="${esc(c.blurb)}">${dot(c)}<span class="pp-t">${esc(c.t)}</span><span class="pp-meta">${c.st === "needs" ? "!" : c.ago}</span></button>`).join("")}</div>` : "";
      const needs = p.coordinators.filter(c => c.st === "needs").length;
      return `<section class="pp-node ${open ? "open" : ""}" style="--h:${p.hue}"><button class="pp-proj" data-pp-toggle="${esc(p.id)}" aria-expanded="${open}"><i class="pp-chev"></i><span class="pp-glyph">${esc(initials(p.name))}</span><span class="pp-name">${esc(p.name)}</span>${!open && needs ? `<span class="pp-badge">${needs}</span>` : `<span class="pp-count">${p.coordinators.length}</span>`}</button>${kids}</section>`;
    }).join("");
  }
  function tabs(m) {
    if (!state.tabs.length) return "";
    return state.tabs.map(id => {
      const { p, c } = byId(m, id), on = state.active === id;
      return `<div class="pp-tab ${on ? "on" : ""}" role="tab" aria-selected="${on}" data-pp-focus="${esc(id)}" style="--h:${p.hue}" title="${esc(p.name)} / ${esc(c.t)}">${dot(c)}<span class="pp-tt">${esc(c.t)}</span><span class="pp-tp">${esc(p.name)}</span>${x(c)}</div>`;
    }).join("");
  }
  function main(m) {
    const hit = state.active && byId(m, state.active);
    if (!hit) return `<div class="pp-scroll"><div class="pp-empty"><b>No coordinators open</b><span>Pick one in the sidebar to open it in a tab.</span></div></div>`;
    return `<div class="pp-scroll"><div class="pp-convo">${conversation(hit.p, hit.c)}</div></div><form class="pp-composer"><textarea rows="2" aria-label="Message coordinator (prototype)" placeholder="Message ${esc(hit.c.t)}…">${esc(state.drafts[state.active] ?? "")}</textarea><button type="submit">Send</button></form>`;
  }
  function status(m) {
    const hit = state.active && byId(m, state.active);
    return hit ? `${dot(hit.c)} ${STATE_LABEL[hit.c.st]}${hit.c.w ? ` · ${hit.c.w} worker${hit.c.w > 1 ? "s" : ""}` : ""}` : "No coordinator";
  }

  function layout(v, m) {
    const side = `<div class="pp-tree">${tree(m)}</div>`;
    if (v === "D") return `<div class="pp-top"><div class="pp-brand"><button class="pp-toggle" data-pp-side aria-label="Toggle sidebar">◧</button><b>π Projects</b></div><div class="pp-tabs" role="tablist">${tabs(m)}</div><div class="pp-topstat">${status(m)}</div></div><aside class="pp-side">${side}<div class="pp-foot">${state.tabs.length} open · ${m.length} projects</div></aside><main class="pp-main">${main(m)}</main>`;
    if (v === "E") return `<aside class="pp-side"><div class="pp-sidehead"><b>π</b><button class="pp-toggle" data-pp-side aria-label="Toggle sidebar">◧</button></div><div class="pp-label">Projects</div>${side}</aside><main class="pp-card"><div class="pp-tabs" role="tablist">${tabs(m)}</div>${main(m)}</main>`;
    return `<aside class="pp-side"><div class="pp-label">COORDINATORS</div>${side}</aside><main class="pp-main"><div class="pp-tabs" role="tablist">${tabs(m)}</div>${main(m)}</main><footer class="pp-statusbar"><span>${status(m)}</span><span>${state.active ? esc(byId(m, state.active).p.name) : ""}</span><span class="pp-sp"></span><span>${state.expanded.size} expanded · ${state.tabs.length} tab${state.tabs.length === 1 ? "" : "s"}</span></footer>`;
  }

  function draw(keepScroll) {
    const m = model();
    if (!state.seeded && typeof projects !== "undefined" && projects.length) {
      state.seeded = true;
      m.slice(0, 2).forEach(p => state.expanded.add(p.id));
      const pick = [m[0].coordinators[1], m[1]?.coordinators[1], m[2]?.coordinators[1]].filter(Boolean);
      state.tabs = pick.map(c => c.id); state.active = pick[0]?.id ?? null;
    }
    // Keep the typed draft, focus and scroll positions across a full re-render.
    const old = shell.querySelector("textarea"), hadFocus = old && document.activeElement === old;
    if (old && shell.dataset.active) state.drafts[shell.dataset.active] = old.value; // the coordinator that was on screen, not the new active one
    const scrolls = { side: shell.querySelector(".pp-tree")?.scrollTop ?? 0, convo: shell.querySelector(".pp-scroll")?.scrollTop ?? 0, tabs: shell.querySelector(".pp-tabs")?.scrollLeft ?? 0, id: shell.dataset.active };
    const hit = state.active && byId(m, state.active);
    shell.dataset.v = state.variant; shell.dataset.active = state.active ?? "";
    shell.dataset.side = state.sideHidden ? "hidden" : "shown";
    shell.style.setProperty("--ah", hit ? hit.p.hue : 30);
    shell.innerHTML = layout(state.variant, m);
    const tree_ = shell.querySelector(".pp-tree"), sc = shell.querySelector(".pp-scroll"), tb = shell.querySelector(".pp-tabs");
    if (tree_) tree_.scrollTop = scrolls.side;
    if (tb) { tb.scrollLeft = scrolls.tabs; shell.querySelector(".pp-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" }); }
    if (sc) sc.scrollTop = keepScroll || scrolls.id === shell.dataset.active ? (keepScroll ? sc.scrollHeight : scrolls.convo) : sc.scrollHeight;
    if (hadFocus) { const ta = shell.querySelector("textarea"); ta?.focus(); ta?.setSelectionRange(ta.value.length, ta.value.length); }
    document.body.dataset.protoVariant = state.variant;
    switcher.innerHTML = `<button data-pp-prev aria-label="Previous variant">←</button><span class="pp-label"><b>${state.variant}</b> — ${esc(VARIANTS[state.variant])}</span><button data-pp-next aria-label="Next variant">→</button>`
      + `<span class="pp-state" aria-label="Prototype state">expanded: ${[...state.expanded].map(id => m.find(p => p.id === id)?.name).filter(Boolean).join(", ") || "none"} · open: ${state.tabs.length} · active: ${hit ? hit.c.t : "none"}</span>`;
  }

  // ---- events ----
  document.addEventListener("click", event => {
    const t = event.target;
    const closeBtn = t.closest("[data-pp-close]");
    if (closeBtn) { event.stopPropagation(); close(closeBtn.dataset.ppClose); return; }
    let el;
    if ((el = t.closest("[data-pp-toggle]"))) return toggle(el.dataset.ppToggle);
    if ((el = t.closest("[data-pp-open]"))) return open(el.dataset.ppOpen);
    if ((el = t.closest("[data-pp-focus]"))) return focus(el.dataset.ppFocus);
    if ((el = t.closest("[data-pp-answer]"))) return answer(el.dataset.ppAnswer);
    if (t.closest("[data-pp-side]")) { state.sideHidden = !state.sideHidden; return draw(); }
    if (t.closest("[data-pp-prev]")) setVariant(keys[(keys.indexOf(state.variant) + keys.length - 1) % keys.length]);
    if (t.closest("[data-pp-next]")) setVariant(keys[(keys.indexOf(state.variant) + 1) % keys.length]);
  }, true);
  shell.addEventListener("submit", event => { event.preventDefault(); send(event.target.querySelector("textarea").value); });
  shell.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && event.target.matches("textarea")) { event.preventDefault(); send(event.target.value); } });
  document.addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const el = document.activeElement;
    if (el && (el.matches("input, textarea, select") || el.isContentEditable)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || document.querySelector("dialog[open]")) return;
    setVariant(keys[(keys.indexOf(state.variant) + (event.key === "ArrowRight" ? 1 : keys.length - 1)) % keys.length]);
  });
  // The real project list loads late; follow it for names.
  new MutationObserver(() => draw(true)).observe(document.querySelector("#project-list"), { childList: true });
  draw();
})();
