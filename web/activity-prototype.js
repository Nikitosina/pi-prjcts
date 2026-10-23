// THROWAWAY PROTOTYPE — delete this file, web/activity-prototype.css and web/ACTIVITY-PROTOTYPE-NOTES.md once the owner has a verdict.
// One-line plan: Three structural variants of Activity, plus today's layout as the default, switchable from a floating bar via ?variant=, hosted on the existing Activity tab.
// Question: what should Activity look like so a worker's status, context use and current work are graspable at a glance, and should it stay a tab or fold into the Coordinator?
// There is no production bundle: this flag gates the scripts, the CSS and the switcher. It must be deleted (with the files and their index.html / src/web.ts registrations), never shipped.
const ACTIVITY_PROTOTYPE_ENABLED = true;

// Runs as a classic script after app.js and reads its globals (view, plan, chatId, tab, projectId, api, esc, badge, inSelectedChat, chatMessageHtml, setTab, inspectThread, artifactBlob, fmtBytes).
if (ACTIVITY_PROTOTYPE_ENABLED) (() => {
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = "/activity-prototype.css";
  document.head.append(link);

  const KEYS = ["", "A", "B", "C"], GROUPS = ["Running", "Waiting", "Blocked", "Finished"];
  const NAMES = { "": "Today's layout", A: "Board", B: "Inspector", C: "Workers card" };
  const param = new URL(location.href).searchParams.get("variant") ?? "";
  let variant = KEYS.includes(param) ? param : "";
  let focus = null;                 // threadId of the worker the variant is showing (A/C: expanded, B: selected)
  const ctxCache = new Map();       // threadId -> { value, at, loading }  (value = thread-history `context`, or null when unavailable)
  const pageCache = new Map();      // threadId -> { items, total, at, loading }
  const artCache = new Map();       // threadId -> { files, at, loading }
  let running = 0;                  // concurrent thread-history reads for rings
  let lastHtml = "", lastStrip = "";

  const terminal = work => ["completed", "failed", "stopped"].includes(work.status);
  const groupOf = work => work.status === "running" ? "Running" : work.status === "queued" || work.status === "interrupted" ? "Waiting" : work.status === "blocked" ? "Blocked" : "Finished";
  const ago = ms => { const m = Math.floor(Math.max(0, ms) / 60000); return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`; };
  const age = work => work.status === "running" && work.startedAt ? ago(Date.now() - work.startedAt) : terminal(work) && work.endedAt ? `${ago(Date.now() - work.endedAt)} ago` : work.startedAt ? ago(Date.now() - work.startedAt) : "—";
  const oneLine = (text, size) => clip(String(text ?? "").replace(/\s+/g, " ").trim(), size);

  // The selected coordinator's workers: one entry per thread (its latest work item), archived hidden.
  function workers() {
    if (!plan) return [];
    const byThread = new Map();
    for (const work of plan.work) if (inSelectedChat(work) && !work.archived) byThread.set(work.threadId, work);
    return [...byThread.values()];
  }
  const chatTitle = () => currentChat()?.title ?? "Main";
  const others = () => plan ? plan.work.filter(work => !terminal(work) && !work.archived && !inSelectedChat(work)).length : 0;
  const modelOf = work => work.attempt?.model ?? ctxCache.get(work.threadId)?.value?.model ?? "—";

  // ---- data: context (real, from thread-history `context`), conversation page, artifacts ----
  function readHistory(threadId, tail) {
    const args = { action: "thread-history", id: projectId, threadId, limit: tail ? 30 : 1, textOffset: 0, textLimit: tail ? 1500 : 1, context: true };
    return api({ ...args, offset: 0 }).then(page => tail && page.total > 30 ? api({ ...args, offset: page.total - 30 }) : page);
  }
  function wantContext(work) {
    const entry = ctxCache.get(work.threadId);
    const ttl = terminal(work) ? 120000 : 8000;
    if (entry && (entry.loading || Date.now() - entry.at < ttl) || running >= 2) return;
    ctxCache.set(work.threadId, { value: entry?.value, at: entry?.at ?? 0, loading: true });
    running++;
    readHistory(work.threadId, false).then(page => ctxCache.set(work.threadId, { value: page.context ?? null, at: Date.now(), loading: false }), () => ctxCache.set(work.threadId, { value: null, at: Date.now(), loading: false })).finally(() => { running--; render(); });
  }
  function wantPage(work) {
    const entry = pageCache.get(work.threadId);
    if (entry && (entry.loading || Date.now() - entry.at < (terminal(work) ? 60000 : 4000))) return;
    pageCache.set(work.threadId, { ...entry, at: entry?.at ?? 0, loading: true });
    readHistory(work.threadId, true).then(page => {
      pageCache.set(work.threadId, { items: page.items.map((item, i) => ({ ...item, index: page.offset + i })), total: page.total, at: Date.now(), loading: false });
      if (page.context) ctxCache.set(work.threadId, { value: page.context, at: Date.now(), loading: false });
    }, error => pageCache.set(work.threadId, { items: [], total: 0, error: error.message, at: Date.now(), loading: false })).finally(render);
  }
  function wantArtifacts(work) {
    const entry = artCache.get(work.threadId);
    if (entry && (entry.loading || Date.now() - entry.at < 6000)) return;
    artCache.set(work.threadId, { ...entry, at: entry?.at ?? 0, loading: true });
    api({ action: "artifacts-list", id: projectId, threadId: work.threadId }).then(listing => artCache.set(work.threadId, { files: listing.files ?? [], at: Date.now(), loading: false }), error => artCache.set(work.threadId, { files: [], error: error.message, at: Date.now(), loading: false })).finally(render);
  }

  // ---- shared bits (a header and small formatters; no shared layout) ----
  function ring(work, size = 22) {
    const ctx = ctxCache.get(work.threadId)?.value;
    const r = 8, c = 2 * Math.PI * r;
    const known = ctx && ctx.window;
    const pct = known ? Math.min(100, Math.round(ctx.tokens / ctx.window * 100)) : 0;
    const level = pct >= 90 ? "high" : pct >= 70 ? "mid" : "low";
    const dash = known ? `${(c * pct / 100).toFixed(2)} ${c.toFixed(2)}` : `0 ${c.toFixed(2)}`;
    const text = ctx === undefined ? "…" : ctx === null ? "context n/a" : known ? `${pct}%` : `${ctx.tokens.toLocaleString()} tok · window unknown`;
    const title = ctx ? known ? `${ctx.tokens.toLocaleString()} / ${ctx.window.toLocaleString()} tokens${ctx.compacting ? " · compacting" : ""}` : `${ctx.tokens.toLocaleString()} tokens, window unknown` : "No context figure";
    return `<span class="context-meter proto-ring ${known ? "" : "unknown"}" data-level="${level}" title="${esc(title)}"><svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true"><circle cx="10" cy="10" r="8" class="track"/><circle cx="10" cy="10" r="8" class="fill" stroke-dasharray="${dash}" transform="rotate(-90 10 10)"/></svg><span class="context-pct">${esc(text)}</span></span>`;
  }
  const actions = work => `<span class="proto-actions"><button type="button" class="small" data-action="thread-send" data-project="${esc(projectId)}" data-thread="${esc(work.threadId)}">Follow up…</button><button type="button" class="small" data-action="thread-steer" data-project="${esc(projectId)}" data-thread="${esc(work.threadId)}">Steer…</button><button type="button" class="small danger" data-action="thread-stop" data-project="${esc(projectId)}" data-thread="${esc(work.threadId)}">Stop…</button></span>`;
  const header = (label, count) => `<div class="proto-head"><b>${esc(label)}</b><span class="proto-chat">Chat: ${esc(chatTitle())}</span><small class="note">${count} worker${count === 1 ? "" : "s"}</small>${others() ? `<small class="note">${others()} active in other chats</small>` : ""}</div>`;
  const artifactChips = work => {
    const entry = artCache.get(work.threadId);
    if (!entry?.files) return `<p class="note">${entry?.loading ? "Reading artifacts…" : "—"}</p>`;
    if (!entry.files.length) return '<p class="note">No artifacts.</p>';
    return entry.files.toSorted((a, b) => b.mtimeMs - a.mtimeMs).map(file => `<button type="button" class="proto-chip" data-proto-artifact="${esc(file.path)}" data-thread="${esc(work.threadId)}" title="${esc(file.path)}">${esc(file.path.split("/").at(-1))} <small>${esc(fmtBytes(file.size ?? 0))}</small></button>`).join("");
  };
  const open = work => `<button type="button" class="ghost small" data-proto-open="${esc(work.threadId)}">Open in Current layout</button>`;

  // ---- Variant A — Board: workers grouped by state, one card each, one card expanded in place ----
  function VariantA() {
    const ws = workers();
    const card = work => {
      const expanded = focus === work.threadId;
      const page = pageCache.get(work.threadId);
      return `<article class="proto-card ${esc(work.status)} ${expanded ? "expanded" : ""}"><button type="button" class="proto-card-main" data-proto-focus="${esc(work.threadId)}" aria-expanded="${expanded}"><span class="proto-card-task" title="${esc(work.text)}">${esc(oneLine(work.text, 90))}</span><span class="proto-card-meta"><span class="worker-role">${esc(work.role)}</span><span>${esc(modelOf(work))}</span><span>${esc(age(work))}</span>${badge(work.status)}</span>${ring(work, 28)}</button>${expanded ? `<div class="proto-card-body"><div class="proto-convo" data-keep="convo">${page?.items ? page.items.map(item => chatMessageHtml(item, "Worker")).join("") || '<p class="note">No messages yet.</p>' : '<p class="note">Reading conversation…</p>'}</div><div class="proto-art">${artifactChips(work)}</div><div class="proto-card-actions">${actions(work)}${open(work)}</div></div>` : ""}</article>`;
    };
    const sections = GROUPS.map(name => {
      const group = ws.filter(work => groupOf(work) === name).toSorted((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      return `<section class="proto-group" data-group="${name}"><h3>${name} <small>${group.length}</small></h3><div class="proto-grid">${group.map(card).join("") || '<p class="note">None.</p>'}</div></section>`;
    }).join("");
    return `<div class="proto-a">${header("Board", ws.length)}${sections}</div>`;
  }

  const orderedB = () => workers().toSorted((a, b) => GROUPS.indexOf(groupOf(a)) - GROUPS.indexOf(groupOf(b)) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const selectedB = () => { const ws = orderedB(); return ws.find(work => work.threadId === focus) ?? ws[0]; };

  // ---- Variant B — Inspector: narrow list, one worker filling the rest; timeline spine of tool calls ----
  function VariantB() {
    const ws = orderedB(), selected = selectedB();
    const list = ws.map(work => `<button type="button" class="proto-row ${esc(work.status)} ${work === selected ? "on" : ""}" data-proto-focus="${esc(work.threadId)}"><span class="dot"></span><span class="proto-row-task" title="${esc(work.text)}">${esc(oneLine(work.text, 48))}</span>${ring(work, 16)}</button>`).join("") || '<p class="note">No workers from this chat.</p>';
    let detail = '<p class="note">Select a worker.</p>';
    if (selected) {
      const ctx = ctxCache.get(selected.threadId)?.value, page = pageCache.get(selected.threadId);
      const big = ctx === undefined ? "Reading context…" : ctx === null ? "Context unavailable" : ctx.window ? `${ctx.tokens.toLocaleString()} / ${ctx.window.toLocaleString()} tokens` : `${ctx.tokens.toLocaleString()} tokens · window unknown`;
      const timeline = page?.items ? page.items.map(item => {
        if (item.kind === "tool") return `<li class="tl-tool ${esc(item.status)}"><span class="tl-node"></span><b>${esc(item.name)}</b> <code>${esc(oneLine(item.argsPreview, 90))}</code>${item.status === "error" ? ' <span class="tl-err">error</span>' : ""}</li>`;
        const text = oneLine(item.text, 160);
        return text ? `<li class="tl-note ${esc(item.role)}"><span class="tl-who">${item.role === "user" ? "task" : "worker"}</span> ${esc(text)}</li>` : "";
      }).join("") : '<li class="tl-note">Reading timeline…</li>';
      detail = `<div class="proto-b-top">${ring(selected, 96)}<div class="proto-b-ctx"><b>${esc(big)}</b>${ctx?.compacting ? " <span class=\"chip\">compacting</span>" : ""}<p class="proto-b-task">${esc(selected.text)}</p><p class="note">${badge(selected.status)} ${esc(selected.role)} · ${esc(modelOf(selected))} · ${esc(age(selected))}${selected.blocker ? ` · ${esc(selected.blocker)}` : ""}</p><div class="proto-card-actions">${actions(selected)}${open(selected)}</div></div></div><ol class="proto-timeline" data-keep="timeline">${timeline}</ol><div class="proto-strip">${artifactChips(selected)}</div>`;
    }
    return `<div class="proto-b">${header("Inspector", ws.length)}<div class="proto-b-body"><nav class="proto-b-list" aria-label="Workers">${list}</nav><div class="proto-b-detail">${detail}</div></div></div>`;
  }

  // ---- Variant C — Workers card is the whole surface (Coordinator tab, no Activity tab) ----
  function VariantC() {
    const ws = workers();
    const active = ws.filter(work => !terminal(work)).toSorted((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    const done = ws.filter(terminal).toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 4);
    const row = work => {
      const expanded = focus === work.threadId, page = pageCache.get(work.threadId);
      const events = page?.items ? page.items.slice(-6).map(item => item.kind === "tool" ? `<li class="${esc(item.status)}"><b>${esc(item.name)}</b> <code>${esc(oneLine(item.argsPreview, 60))}</code></li>` : oneLine(item.text, 120) ? `<li class="msg-line">${esc(oneLine(item.text, 120))}</li>` : "").join("") : "<li>Reading…</li>";
      return `<div class="proto-crow ${esc(work.status)} ${expanded ? "expanded" : ""}"><button type="button" class="proto-crow-main" data-proto-focus="${esc(work.threadId)}" aria-expanded="${expanded}"><span class="dot"></span><span class="proto-crow-task" title="${esc(work.text)}">${esc(oneLine(work.text, 70))}</span>${ring(work, 18)}<small class="worker-meta">${esc(work.role)} · ${esc(work.status)} · ${esc(age(work))}</small></button>${expanded ? `<div class="proto-crow-body"><ul class="proto-events">${events}</ul>${work.blocker ? `<p class="note">Blocked: ${esc(work.blocker)}</p>` : ""}${actions(work)}</div>` : ""}</div>`;
    };
    return `<div class="proto-c"><p class="note proto-chat">Chat: ${esc(chatTitle())}</p>${active.map(row).join("") || '<p class="note">No active workers from this chat.</p>'}${done.length ? `<h4>Finished</h4>${done.map(row).join("")}` : ""}${others() ? `<p class="note other-chats">${others()} active in other chats</p>` : ""}</div>`;
  }

  // ---- mount / render ----
  const root = document.createElement("div");
  root.id = "proto-root";
  function mount() {
    document.body.dataset.protoVariant = variant;
    const target = variant === "C" ? document.querySelector("#activity")?.parentElement : variant ? document.querySelector('[data-panel="activity"]') : null;
    if (target) { if (root.parentElement !== target) target.append(root); } else root.remove();
    if (variant === "C" && tab === "activity") setTab("coordinator");
  }
  function visibleWorkers() {
    if (variant === "A" || variant === "B") return tab === "activity" ? workers() : [];
    if (variant === "C") return tab === "coordinator" ? workers() : [];
    return [];
  }
  function focusedWork() {
    const id = variant === "B" ? selectedB()?.threadId : variant ? focus : workerChat?.threadId;
    return id ? plan?.work.findLast(work => work.threadId === id) ?? null : null;
  }
  function render() {
    if (!view || !plan) return;
    mount();
    if (variant) {
      const ws = visibleWorkers();
      for (const work of ws) wantContext(work);
      const open = variant === "B" ? (ws.length ? selectedB() : null) : ws.find(work => work.threadId === focus);
      if (open) { wantPage(open); if (variant !== "C") wantArtifacts(open); }
      const focused = focusedWork();
      if (focused) wantContext(focused);
      const html = variant === "A" ? VariantA() : variant === "B" ? VariantB() : VariantC();
      if (html !== lastHtml || !root.firstChild) {
        const keep = new Map([...root.querySelectorAll("[data-keep]")].map(node => [node.dataset.keep, [node.scrollTop, node.scrollHeight - node.scrollTop - node.clientHeight < 40]]));
        root.innerHTML = html; lastHtml = html;
        for (const node of root.querySelectorAll("[data-keep]")) { const [top, atEnd] = keep.get(node.dataset.keep) ?? [0, true]; node.scrollTop = atEnd ? node.scrollHeight : top; }
      }
    } else lastHtml = "";
    strip();
  }

  // ---- floating switcher + state strip (deliberately ugly: it is not part of the design) ----
  const bar = document.createElement("div");
  bar.id = "proto-bar";
  bar.innerHTML = '<div class="proto-state" id="proto-state"></div><div class="proto-pill"><button type="button" data-proto-step="-1" aria-label="Previous variant">←</button><span id="proto-label"></span><button type="button" data-proto-step="1" aria-label="Next variant">→</button></div>';
  document.body.append(bar);
  const field = (name, value) => `<span><i>${name}</i> ${esc(value)}</span>`;
  function strip() {
    const label = `${variant || "Current"} — ${NAMES[variant]}`;
    bar.querySelector("#proto-label").textContent = label;
    const work = focusedWork();
    const ctx = work ? ctxCache.get(work.threadId)?.value : undefined;
    const fmt = value => value === undefined || value === null ? "unknown" : String(value);
    const parts = [field("variant", label), field("chat", `${chatId} “${chatTitle()}”`)];
    if (work) parts.push(field("status", work.status), field("role", work.role), field("model", modelOf(work)), field("thread", work.threadId), field("ctx tokens", ctx ? ctx.tokens : "unknown"), field("window", ctx ? fmt(ctx.window) : "unknown"), field("compacting", ctx ? ctx.compacting : "unknown"), field("blocker", work.blocker ?? "none"));
    else parts.push(field("focus", "none"));
    const next = parts.join("");
    if (next !== lastStrip) { bar.querySelector("#proto-state").innerHTML = next; lastStrip = next; }
  }
  function setVariant(next) {
    variant = next;
    const url = new URL(location.href);
    if (next) url.searchParams.set("variant", next); else url.searchParams.delete("variant");
    history.replaceState(null, "", url);
    lastHtml = "";
    render();
  }
  const cycle = step => setVariant(KEYS[(KEYS.indexOf(variant) + step + KEYS.length) % KEYS.length]);

  document.addEventListener("click", async event => {
    const step = event.target.closest?.("[data-proto-step]");
    if (step) { cycle(Number(step.dataset.protoStep)); return; }
    const focusNode = event.target.closest?.("[data-proto-focus]");
    if (focusNode) { const id = focusNode.dataset.protoFocus; focus = variant === "B" ? id : focus === id ? null : id; render(); return; }
    const art = event.target.closest?.("[data-proto-artifact]");
    if (art) { const url = await artifactBlob(projectId, art.dataset.thread, art.dataset.protoArtifact).catch(() => null); if (url) window.open(url, "_blank", "noopener"); return; }
    const openNode = event.target.closest?.("[data-proto-open]");
    if (openNode) { const thread = openNode.dataset.protoOpen; setVariant(""); await inspectThread(thread).catch(report); }
  });
  addEventListener("keydown", event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const active = document.activeElement;
    if (active?.matches?.("input, textarea, select, [contenteditable]") || active?.isContentEditable || document.querySelector("dialog[open]")) return;
    event.preventDefault();
    cycle(event.key === "ArrowRight" ? 1 : -1);
  });
  // The app re-renders on its own schedule; follow it by polling instead of hooking its render.
  setInterval(() => { try { render(); } catch (error) { console.error("activity prototype", error); } }, 1000);
  document.addEventListener("click", () => setTimeout(render, 0));
  try { render(); } catch {}
})();
