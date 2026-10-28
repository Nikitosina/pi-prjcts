// PROTOTYPE, round 3 — wipe me. See web/PROTOTYPE-SIDEBAR-NOTES.md.
// Owner picked direction E (Arc-like tinted sidebar + inset content canvas + top tabs). Round 3 makes it run on the REAL app:
// no overlay and no fixtures. The real sidebar, header, chat transcript, composer, decisions, workers, knowledge, observability and
// settings stay as they are (app.js renders them); this file only (1) replaces the sidebar project list with an expandable tree of each
// project's non-archived chats ("coordinators"), (2) adds a tab bar of opened coordinators across projects above the real header, and
// (3) hides the old all-coordinator strip (CSS). Opening a tab calls the app's own changeProject/changeChat. Tab and layout state is in memory.
// Chats of other projects are read with the app's read-only `show` action. Loaded only with ?variant=E (loader at the end of app.js)
// and served only when NODE_ENV !== "production" (src/web.ts).
(() => {
  if (new URLSearchParams(location.search).get("variant") !== "E") return;

  const state = { tabs: [], active: null, expanded: new Set(), empty: false, lastLoc: null, chats: new Map(), quick: null };
  const esc = value => String(value).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const glyph = name => name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0] ?? "").join("").toUpperCase() || "π";
  const keyOf = (pid, cid) => `${pid}::${cid}`;
  const hueOf = pid => { const i = projects.findIndex(p => p.id === pid); return ((i < 0 ? 0 : i) * 67 + 18) % 360; };
  const live = pid => view?.project?.id === pid && pid === projectId && view.chats ? view.chats : null; // the open project: the app's own live data
  const chatsOf = pid => live(pid) ?? state.chats.get(pid) ?? null;
  const visible = pid => chatsOf(pid)?.filter(chat => !chat.archived) ?? null;
  const find = (pid, cid) => chatsOf(pid)?.find(chat => chat.id === cid) ?? null;

  async function load(pid) {
    try { const shown = await api({ action: "show", id: pid }); if (Array.isArray(shown?.chats)) state.chats.set(pid, shown.chats); } catch { /* project gone or host busy: keep the old list */ }
    draw();
  }

  // One state dot: the app's own rules for the open project, the chat summary for the others.
  function dotOf(pid, chat) {
    if (!chat) return `<span class="pp-dot" data-state="idle"></span>`;
    if (live(pid)) { const { state: s, label } = chatState(chat); return `<span class="pp-dot" data-state="${s}" title="${esc(label)}"></span>`; }
    const s = chat.attention ? "needs" : chat.busy ? "working" : "idle";
    return `<span class="pp-dot" data-state="${s}" title="${s === "idle" ? "Idle" : s === "needs" ? "Needs you" : "Working"}"></span>`;
  }

  // ---- actions (navigation only: the app's own switch functions; nothing here writes to the host) ----
  function go(pid, cid) {
    if (typeof workerChat !== "undefined" && workerChat) closeWorkerDetail();
    if (pid !== projectId) changeProject(pid, cid); else if (cid !== chatId) changeChat(cid);
    if (tab !== "coordinator") setTab("coordinator");
    state.lastLoc = keyOf(projectId, chatId); // our own navigation, not one to follow
  }
  function open(pid, cid) {
    const key = keyOf(pid, cid);
    if (!state.tabs.includes(key)) state.tabs.push(key);
    state.active = key; state.empty = false;
    go(pid, cid); draw();
  }
  function close(key) {
    const at = state.tabs.indexOf(key);
    if (at < 0) return;
    state.tabs.splice(at, 1);
    if (state.active === key) {
      state.active = state.tabs[at] ?? state.tabs[at - 1] ?? null; // right neighbour, else left, else empty
      if (state.active) go(...state.active.split("::")); else state.empty = true;
    }
    draw();
  }
  const toggle = pid => { if (state.expanded.has(pid)) state.expanded.delete(pid); else { state.expanded.add(pid); if (!chatsOf(pid)) void load(pid); } draw(); };

  // Follow the app: any navigation it does itself (new chat, search hit, restore, archive falling back to Main) is mirrored into the tabs.
  function sync() {
    if (!projects.length || !projectId) return;
    if (live(projectId)) state.chats.set(projectId, view.chats);
    const here = keyOf(projectId, chatId);
    if (here !== state.lastLoc) {
      state.lastLoc = here;
      if (!state.tabs.includes(here)) state.tabs.push(here);
      state.active = here; state.empty = false; state.expanded.add(projectId);
    }
    // A tab whose chat was archived or removed (and is not on screen) goes away.
    for (const key of [...state.tabs]) {
      if (key === here) continue;
      const [pid, cid] = key.split("::"), chat = chatsOf(pid)?.find(item => item.id === cid);
      if (chatsOf(pid) && (!chat || chat.archived)) state.tabs.splice(state.tabs.indexOf(key), 1);
    }
    if (state.active && !state.tabs.includes(state.active)) state.active = state.tabs.includes(here) ? here : state.tabs[0] ?? null;
  }

  // ---- DOM ----
  const side = document.querySelector("#side"), main = document.querySelector(".main");
  const nav = Object.assign(document.createElement("div"), { id: "proto-nav" });
  const bar = Object.assign(document.createElement("div"), { id: "proto-tabs" });
  const empty = Object.assign(document.createElement("div"), { id: "proto-empty" });
  const quickPill = Object.assign(document.createElement("button"), { id: "proto-quick-pill", type: "button", innerHTML: `<span>Jump to coordinator…</span><kbd></kbd>` });
  const grip = Object.assign(document.createElement("div"), { id: "proto-grip", role: "separator" });
  grip.setAttribute("aria-orientation", "vertical"); grip.title = "Drag to resize the sidebar";
  quickPill.querySelector("kbd").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘J" : "Ctrl J";
  document.querySelector("#create").before(quickPill);
  document.querySelector("#project-list").after(nav);
  main.prepend(bar); main.append(empty); side.append(grip);
  const setHtml = (node, next) => { if (node.dataset.h !== next) { node.innerHTML = next; node.dataset.h = next; } };

  function tree() {
    return projects.map(p => {
      const open = state.expanded.has(p.id), kids = visible(p.id);
      const rows = !open ? "" : !kids ? `<p class="pp-note">Loading…</p>` : `<div class="pp-children">${kids.map(chat => `<button class="pp-child ${state.active === keyOf(p.id, chat.id) ? "on" : ""} ${state.tabs.includes(keyOf(p.id, chat.id)) ? "opened" : ""}" data-pp-open="${esc(keyOf(p.id, chat.id))}" title="${esc(chat.title)}">${dotOf(p.id, chat)}<span class="pp-t">${esc(chat.title)}</span></button>`).join("")}</div>`;
      const { state: s, label } = projectState(p);
      return `<section class="pp-node ${open ? "open" : ""}" style="--h:${hueOf(p.id)}"><button class="pp-proj" data-pp-toggle="${esc(p.id)}" aria-expanded="${open}" title="${esc(p.name)}"><span class="pp-glyph">${esc(glyph(p.name))}</span><span class="pp-name">${esc(p.name)}</span>${s === "idle" ? "" : `<span class="pp-dot" data-state="${s}" title="${esc(label)}"></span>`}${!open && kids ? `<span class="pp-count">${kids.length}</span>` : ""}<i class="pp-chev"></i></button>${rows}</section>`;
    }).join("");
  }
  function tabs() {
    const items = state.tabs.map(key => {
      const [pid, cid] = key.split("::"), p = projects.find(q => q.id === pid), chat = find(pid, cid), title = chat?.title ?? "Coordinator";
      if (!p) return "";
      return `<div class="pp-tab ${state.active === key ? "on" : ""}" role="tab" aria-selected="${state.active === key}" data-pp-focus="${esc(key)}" style="--h:${hueOf(pid)}" title="${esc(p.name)} / ${esc(title)}"><span class="pp-chip">${esc(glyph(p.name))}</span>${dotOf(pid, chat)}<span class="pp-tt">${esc(title)}</span><span class="pp-x" role="button" tabindex="0" data-pp-close="${esc(key)}" aria-label="Close ${esc(title)}">×</span></div>`;
    }).join("");
    return `<div class="pp-tablist" role="tablist">${items}</div><button class="pp-plus" data-pp-new title="New chat in the open project" aria-label="New chat">＋</button><span class="pp-proto" title="Prototype E: live data from this host. Open tabs and sidebar layout are in memory. ${state.expanded.size} project(s) expanded.">E · prototype</span>`;
  }
  function draw() {
    const pid = state.active ? state.active.split("::")[0] : projectId;
    document.body.style.setProperty("--ah", projects.some(p => p.id === pid) ? hueOf(pid) : 30);
    document.body.classList.toggle("proto-empty", state.empty && !state.tabs.length);
    setHtml(nav, tree()); setHtml(bar, tabs());
    setHtml(empty, `<div><b>No coordinators open</b><span>Pick one in the sidebar, or press ${quickPill.querySelector("kbd").textContent} to jump to any coordinator.</span></div>`);
    bar.querySelector(".pp-tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ---- quick switcher: every non-archived coordinator of every project ----
  async function quick() {
    if (state.quick) return closeQuick();
    const box = Object.assign(document.createElement("div"), { id: "proto-quick", innerHTML: `<div class="pp-qbox" role="dialog" aria-label="Jump to coordinator"><input type="text" placeholder="Jump to coordinator…" aria-label="Jump to coordinator" autocomplete="off" spellcheck="false"><div class="pp-qlist" role="listbox"></div></div>` });
    document.body.append(box); state.quick = { box, at: 0 };
    const input = box.querySelector("input"); input.focus();
    const items = () => projects.flatMap(p => (visible(p.id) ?? []).map(chat => ({ pid: p.id, cid: chat.id, text: `${p.name} / ${chat.title}`, p, chat }))).filter(item => item.text.toLowerCase().includes(input.value.trim().toLowerCase()));
    const paint = () => { const list = items(); state.quick.at = Math.min(state.quick.at, Math.max(0, list.length - 1)); box.querySelector(".pp-qlist").innerHTML = list.map((item, i) => `<button class="${i === state.quick.at ? "on" : ""}" role="option" data-pp-q="${esc(keyOf(item.pid, item.cid))}">${dotOf(item.pid, item.chat)}<span>${esc(item.chat.title)}</span><small>${esc(item.p.name)}</small></button>`).join("") || `<p class="pp-note">No match.</p>`; };
    paint();
    box.addEventListener("click", event => { const hit = event.target.closest("[data-pp-q]"); if (hit) { closeQuick(); open(...hit.dataset.ppQ.split("::")); } else if (event.target === box) closeQuick(); });
    input.addEventListener("input", () => { state.quick.at = 0; paint(); });
    input.addEventListener("keydown", event => {
      const list = items();
      if (event.key === "Escape") { event.preventDefault(); closeQuick(); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); state.quick.at = (state.quick.at + (event.key === "ArrowDown" ? 1 : list.length - 1)) % Math.max(1, list.length); paint(); }
      else if (event.key === "Enter" && list[state.quick.at]) { event.preventDefault(); const item = list[state.quick.at]; closeQuick(); open(item.pid, item.cid); }
    });
    await Promise.all(projects.filter(p => !chatsOf(p.id)).map(p => load(p.id)));
    if (state.quick) paint();
  }
  function closeQuick() { state.quick?.box.remove(); state.quick = null; }

  // ---- events ----
  document.addEventListener("click", event => {
    const t = event.target;
    let el;
    if ((el = t.closest("[data-pp-close]"))) { event.stopPropagation(); return close(el.dataset.ppClose); }
    if ((el = t.closest("[data-pp-toggle]"))) return toggle(el.dataset.ppToggle);
    if ((el = t.closest("[data-pp-open]"))) return open(...el.dataset.ppOpen.split("::"));
    if ((el = t.closest("[data-pp-focus]"))) return open(...el.dataset.ppFocus.split("::"));
    if (t.closest("[data-pp-new]")) { document.querySelector('#chat-bar [data-action="chat-new"]')?.click(); return; }
    if (t.closest("#proto-quick-pill")) return void quick();
  }, true);
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "j" && !document.querySelector("dialog[open]")) { event.preventDefault(); void quick(); }
  });
  // Resizable sidebar: drag the grip; the width lives in a CSS variable (the app's own collapse toggle still works).
  grip.addEventListener("pointerdown", event => {
    event.preventDefault(); grip.setPointerCapture(event.pointerId);
    const move = e => document.body.style.setProperty("--pp-side-w", `${Math.min(460, Math.max(200, e.clientX))}px`);
    const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); };
    grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up);
  });

  // The project list and the open project's chats arrive from the app's own polling; follow them. Other open projects refresh slowly.
  let ticks = 0;
  setInterval(() => {
    sync(); draw();
    if (++ticks % 20 === 0 && !document.hidden) for (const p of projects) if (p.id !== projectId && (state.expanded.has(p.id) || state.tabs.some(key => key.startsWith(p.id)))) void load(p.id);
  }, 500);
  document.body.dataset.protoVariant = "E";
  sync(); draw();
})();
