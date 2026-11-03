import { api, getGeneration, getProjectId, getView, onProjectChange, onRender, onTab, registerActions, setHtml, tab } from "./shell.js";
import { badge, duration, esc } from "./format.js";
import { jobChatId, jobsSnap, pendingCount } from "./decisions.js";

// Observability usage is pinned to the project/generation that requested it.
let usageObs = null,
  usageLoading = false;
let observability = null,
  observabilityLoading = false,
  eventOffset = 0;
onProjectChange(() => {
  observability = null;
  observabilityLoading = false;
  eventOffset = 0;
  usageObs = null;
  for (const selector of ["#obs-kpis", "#obs-usage", "#obs-health", "#obs-trace", "#obs-timeline", "#obs-event-log", "#obs-usage-time"])
    document.querySelector(selector).replaceChildren();
});
onTab((next) => {
  if (next !== "observability") return;
  void loadUsage();
  void loadObservability();
});

// Agent ids whose transcripts belong to a Job: its worker and the subagents the worker started.
const jobThreads = (job) => [job.id, ...job.children.map((child) => child.id)];
function renderObservability() {
  const p = getView().project,
    jobs = jobsSnap?.jobs ?? [];
  const count = (...statuses) => jobs.filter((job) => statuses.includes(job.status)).length;
  const kpi = (label, value, tone = "") => `<div class="card kpi ${tone}"><small>${esc(label)}</small><b>${esc(value)}</b></div>`;
  setHtml(
    "#obs-kpis",
    [
      kpi("Needs you", pendingCount(), pendingCount() ? "warn" : ""),
      kpi("Running", count("running")),
      kpi("Ready", count("ready", "ready-with-gaps")),
      kpi("Failed", count("failed"), count("failed") ? "err" : ""),
      kpi("Jobs", jobs.length),
    ].join(""),
  );
  renderHealth(p);
  if (tab === "observability" && jobsSnap && !observability && !observabilityLoading) void loadObservability();
  // One node per chat; each Job sits under the chat that spawned it, with its subagents below.
  const chats = getView().chats ?? [{ id: "main", title: "Coordinator", conversationId: null, busy: getView().busy, archived: false }];
  const toolsOf = (threadId) =>
    (observability?.tools ?? [])
      .filter((call) => call.threadId === threadId)
      .map((call) => `<li>${toolCallHtml(call)}</li>`)
      .join("");
  const jobHtml = (job) =>
    `<li data-thread="${esc(job.id)}"><details ${job.status === "running" ? "open" : ""}><summary>${badge(job.status)} <b>${esc(job.title)}</b> <small class="inline mono">${esc(job.id.slice(0, 8))}</small> <button class="ghost small" data-action="thread" data-project="${esc(getProjectId())}" data-thread="${esc(job.id)}">history ↗</button></summary><ul>${toolsOf(job.id)}${job.children
      .map(
        (child) =>
          `<li class="trace-child" data-parent="${esc(job.id)}" data-thread="${esc(child.id)}">${badge(child.working ? "running" : "done")} ${esc(child.role)} · ${esc(child.title)} <button class="ghost small" data-action="thread" data-project="${esc(getProjectId())}" data-thread="${esc(child.id)}">history ↗</button><ul>${toolsOf(child.id)}</ul></li>`,
      )
      .join("")}</ul></details></li>`;
  setHtml(
    "#obs-trace",
    `<ul class="trace">${chats
      .map((chat) => {
        const owned = jobs.filter((job) => jobChatId(job) === chat.id);
        return `<li class="trace-chat" data-chat="${esc(chat.id)}"><details ${chat.busy || owned.length || chat.id === "main" ? "open" : ""}><summary><b>${esc(chat.title)}</b> <small class="inline">chat · ${esc(p.model)} · ${chat.busy ? "busy" : "idle"}${chat.archived ? " · archived" : ""}${chat.attention ? " · needs attention" : ""}</small></summary><ul>${owned.map(jobHtml).join("") || '<li class="note">No Jobs from this chat.</li>'}</ul></details></li>`;
      })
      .join("")}</ul>`,
  );
  setHtml("#obs-usage", usageHtml());
  renderUsageBuckets();
  const now = Date.now(),
    starts = jobs.map((job) => job.createdAt),
    ends = jobs.map((job) => job.endedAt).filter(Number.isFinite);
  const rangeStart = Math.min(...starts, now),
    rangeEnd = Math.max(now, ...ends),
    span = Math.max(1, rangeEnd - rangeStart);
  setHtml(
    "#obs-timeline",
    jobs.length
      ? jobs
          .toReversed()
          .map((job) => {
            const end = job.endedAt ?? (job.status === "running" ? now : job.createdAt + 1);
            const x = Math.max(0, Math.min(100, ((job.createdAt - rangeStart) / span) * 100)),
              width = Math.max(1, Math.min(100 - x, ((end - job.createdAt) / span) * 100));
            return `<div class="timeline-row"><small>${esc(job.title.slice(0, 90))}</small><svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${esc(job.status)}"><rect x="${x}" y="1" width="${width}" height="6" rx="3" class="timeline-bar"></rect></svg><small>${esc(new Date(job.createdAt).toLocaleTimeString())}${job.endedAt ? ` – ${esc(new Date(job.endedAt).toLocaleTimeString())}` : " · ongoing"}</small></div>`;
          })
          .join("")
      : '<p class="note">No Jobs recorded.</p>',
  );
  if (tab === "observability" && jobsSnap && (!usageObs || Date.now() - usageObs.at > 15000)) void loadUsage();
}
onRender(renderObservability);

async function loadUsage() {
  if (!jobsSnap || usageLoading) return;
  const id = getProjectId(),
    current = getGeneration();
  usageLoading = true;
  try {
    const page = await api({ action: "usage-snapshot", id, offset: 0, limit: 100 });
    if (id !== getProjectId() || current !== getGeneration()) return;
    if (!page?.coordinator?.total || !Array.isArray(page.workers) || page.offset !== 0)
      throw new Error("Usage projection differs from its owned conversation/page");
    usageObs = { at: Date.now(), page };
    setHtml("#obs-usage", usageHtml());
    renderUsageBuckets();
  } catch (error) {
    if (id === getProjectId() && current === getGeneration()) {
      usageObs = { at: Date.now(), error: error.message };
      setHtml("#obs-usage", usageHtml());
    }
  } finally {
    usageLoading = false;
  }
}
function usageHtml() {
  if (!jobsSnap) return '<p class="note">Usage counters require a Durable project.</p>';
  if (!usageObs) return '<p class="note">Reading SDK conversation counters…</p>';
  if (usageObs.error) return `<p class="note">Usage unavailable: ${esc(usageObs.error)}</p>`;
  const { page } = usageObs,
    money = (value) => `$${Number(value).toFixed(2)}`,
    tokens = (value) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));
  const rows = [
    ...usageChatRows(page).map((row) => ({ label: row.label, total: row.value.total })),
    ...page.workers.map((worker) => {
      const job = jobsSnap?.jobs.find((item) => jobThreads(item).includes(worker.threadId));
      return {
        label: job ? `${job.title.slice(0, 72)}` : `Thread ${worker.threadId.slice(0, 8)}`,
        total: worker.total,
      };
    }),
  ];
  const max = Math.max(...rows.map((row) => row.total.totalTokens), 1);
  const cost = rows.reduce((sum, row) => sum + row.total.cost.total, 0),
    all = rows.reduce((sum, row) => sum + row.total.totalTokens, 0);
  return `<div class="usage-head"><div><b>${tokens(all)}</b><small>tokens</small></div><div><b>${money(cost)}</b><small>SDK estimate</small></div><div><b>${1 + (page.chats?.length ?? 0)}</b><small>chats</small></div><div><b>${page.totalWorkers}</b><small>worker conversations</small></div></div>${rows.map((row) => `<div class="hbar"><span title="${esc(row.label)}">${esc(row.label)}</span><progress max="${max}" value="${row.total.totalTokens}"></progress><small class="mono">${tokens(row.total.totalTokens)} · ${money(row.total.cost.total)}</small></div>`).join("")}<p class="note">${page.nextOffset !== null ? "First 100 workers only. " : ""}Estimates are not billing. Observed ${esc(new Date(page.observedAtMs ?? usageObs.at).toLocaleTimeString())}.</p>`;
}

// Main is the root coordinator conversation; every other chat is counted too.
function usageChatRows(page) {
  const main = getView()?.chats?.find((chat) => chat.id === "main")?.title ?? "Main";
  return [
    { label: `Chat · ${main}`, value: page.coordinator },
    ...(page.chats ?? []).map((chat) => ({ label: `Chat · ${chat.title}${chat.archived ? " (archived)" : ""}`, value: chat })),
  ];
}
async function loadObservability() {
  if (!jobsSnap || observabilityLoading) return;
  const id = getProjectId(),
    current = getGeneration();
  observabilityLoading = true;
  try {
    const [events, health, histories] = await Promise.all([
      api({ action: "event-log", id, offset: eventOffset, limit: 20 }),
      api({ action: "host-health", id }),
      Promise.all(
        [...new Set(jobsSnap.jobs.flatMap(jobThreads))].map((threadId) => api({ action: "thread-history", id, threadId, limit: 100 })),
      ),
    ]);
    if (id !== getProjectId() || current !== getGeneration() || tab !== "observability") return;
    if (!Array.isArray(events.events) || !Number.isSafeInteger(events.total) || typeof health.uptimeMs !== "number")
      throw new Error("Invalid observability response");
    observability = {
      events,
      health,
      tools: histories.flatMap((page) =>
        page.items.filter((item) => item.kind === "tool-call").map((item) => ({ ...item, threadId: page.threadId })),
      ),
    };
    renderHealth(getView().project);
    renderEventLog();
    renderUsageBuckets();
    renderObservability();
  } catch (error) {
    if (id === getProjectId() && current === getGeneration()) {
      setHtml("#obs-event-log", `<p class="note">Event log unavailable: ${esc(error.message)}</p>`);
      setHtml("#obs-usage-time", `<p class="note">Usage history unavailable: ${esc(error.message)}</p>`);
    }
  } finally {
    observabilityLoading = false;
  }
}
function renderHealth(project) {
  const h = observability?.health;
  const values = [
    ["Host", document.querySelector("#connection").textContent.split(" · ")[0]],
    ["Runtime", project.runtime],
    [
      "Coordinator",
      (getView().chats ?? []).some((chat) => chat.busy) || getView().busy
        ? `busy${(getView().chats?.length ?? 0) > 1 ? ` · ${getView().chats.filter((chat) => chat.busy).length}/${getView().chats.length} chats` : ""}`
        : "idle",
    ],
    [
      "Project",
      project.deleted
        ? "deleted"
        : project.archived
          ? "archived"
          : getView().paused
            ? "paused"
            : project.phase === "attention"
              ? "needs attention"
              : "ready",
    ],
    ["Uptime", h ? duration(h.uptimeMs) : "Reading…"],
    ["Queue depth", h ? (h.queue?.queued ?? 0) + (h.queue?.running ?? 0) : "Reading…"],
    ["Leases", h?.activeLeases ?? "—"],
    ["Project locks", h?.activeLocks ?? "—"],
    ["Mac awake", h?.macAwake === null ? "Unknown" : (h?.macAwake ?? "Reading…")],
    ["Failed jobs", getView().failedJobs ?? getView().jobs.filter((job) => ["failed", "interrupted"].includes(job.state)).length],
    ["Evidence", getView().evidence.length],
  ];
  setHtml(
    "#obs-health",
    `<div class="health">${values.map(([label, value]) => `<div><small>${esc(label)}</small><b>${esc(value)}</b></div>`).join("")}</div>`,
  );
}
function renderEventLog() {
  const events = observability?.events;
  if (!events) return;
  setHtml(
    "#obs-event-log",
    `<p class="note">Newest first · ${events.total} events</p><div class="row">${eventOffset ? '<button data-action="event-page" data-offset="0">Newest</button><button data-action="event-page" data-offset="-20">Newer</button>' : ""}${eventOffset + events.events.length < events.total ? '<button data-action="event-page" data-offset="20">Older</button>' : ""}</div>${events.events.length ? events.events.map((event) => `<article class="event-row"><b>${esc(event.kind ?? event.type ?? "Event")}</b><small>${esc(event.source ?? "")}${event.at ? ` · ${esc(new Date(event.at).toLocaleString())}` : ""}</small>${event.detail ? `<span class="mono">${esc(String(event.detail).replace(/:[0-9a-f-]{36}$/i, ""))}</span>` : ""}</article>`).join("") : '<p class="note">No events recorded.</p>'}`,
  );
}
function renderUsageBuckets() {
  const target = document.querySelector("#obs-usage-time");
  const rows = [
    ...(usageObs?.page ? usageChatRows(usageObs.page) : []),
    ...(usageObs?.page?.workers ?? []).map((worker) => ({ label: worker.title ?? worker.role ?? worker.name ?? "Worker", value: worker })),
  ];
  if (!rows.length || usageObs?.error) {
    if (usageObs?.error) setHtml("#obs-usage-time", `<p class="note">Usage over time unavailable: ${esc(usageObs.error)}</p>`);
    return;
  }
  const buckets = rows.flatMap((row) =>
    ["hourly", "daily"].flatMap((period) =>
      (row.value?.timeBuckets?.[period] ?? []).map((bucket) => ({ ...bucket, period, label: row.label })),
    ),
  );
  const max = Math.max(1, ...buckets.map((bucket) => bucket.totalTokens ?? 0));
  target.innerHTML = buckets.length
    ? `<div class="usage-bars">${buckets
        .slice(-60)
        .map(
          (bucket) =>
            `<div class="usage-bar-row"><small>${esc(bucket.label)} · ${esc(bucket.period)} ${esc(new Date(bucket.at).toLocaleString())}</small><progress max="${max}" value="${Number(bucket.totalTokens) || 0}"></progress><b>${Number(bucket.totalTokens) || 0} tokens</b></div>`,
        )
        .join("")}</div>`
    : '<p class="note">No time-bucketed usage recorded.</p>';
}

function toolArgs(call) {
  try {
    const args = JSON.parse(call.argsPreview ?? "");
    return args && typeof args === "object" ? args : {};
  } catch {
    return {};
  }
}
export function toolLabel(call) {
  const a = toolArgs(call),
    path = a.path ?? a.file ?? a.filePath ?? "";
  const labels = {
    agents: () =>
      ({
        spawn: `Started a ${a.role ?? "worker"}${a.title ? `: ${a.title}` : ""}`,
        send: "Messaged an agent",
        stop: `Stopped an agent${a.reason ? `: ${a.reason}` : ""}`,
        status: "Checked agents",
        wait: "Waited for agents",
      })[a.action] ?? "Managed agents",
    job: () => ({ plan: "Updated the plan", candidate: "Recorded the candidate", ready: "Reported Ready" })[a.action] ?? "Updated the Job",
    subagent: () => `Asked a ${a.role ?? "subagent"}${a.task ? `: ${String(a.task).split("\n")[0]}` : ""}`,
    projects_question: () => `Asked you${a.question ? `: ${a.question.split("\n")[0]}` : ""}`,
    projects_knowledge_write: () => `Updated knowledge ${path}`,
    projects_knowledge_read: () => `Read knowledge ${path}`,
    projects_knowledge_list: () => "Listed knowledge",
    projects_knowledge_history: () => `Read history of ${path}`,
    projects_note: () => "Added a note",
    projects_notes: () => "Read notes",
    projects_evidence: () => `Attached evidence${a.title ? `: ${a.title}` : ""}`,
    projects_library_list: () => "Listed the library",
    projects_library_read: () => "Read from the library",
    projects_search: () => `Searched knowledge${a.query ? ` for “${a.query}”` : ""}`,
    projects_upload_list: () => "Listed uploads",
    projects_upload_read: () => `Read upload ${getView()?.uploads?.find((item) => item.id === a.uploadId)?.filename ?? ""}`.trim(),
    projects_workspace_catalog: () => "Checked workspaces",
    projects_skill_read: () => `Read skill ${a.name ?? ""}`,
    projects_skill_file: () => `Read skill file ${a.skill ?? ""}/${a.path ?? "SKILL.md"}`,
    projects_github_issue_read: () => `Read GitHub #${a.number ?? ""}`,
    projects_github_issues: () => (a.query ? `Searched GitHub for “${a.query}”` : `Listed GitHub ${a.kind === "pr" ? "PRs" : "issues"}`),
    projects_github_issue_write: () =>
      ({
        create: `Created GitHub issue “${a.title ?? ""}”`,
        comment: `Commented on GitHub #${a.number}`,
        update: `Updated GitHub #${a.number}`,
        close: `Closed GitHub #${a.number}`,
        reopen: `Reopened GitHub #${a.number}`,
      })[a.action] ?? "Changed a GitHub issue",
    code_read: () => `Read ${path}`,
    read: () => `Read ${path}`,
    code_grep: () => `Searched for “${a.pattern ?? ""}”`,
    grep: () => `Searched for “${a.pattern ?? ""}”`,
    code_find: () => `Found files ${a.pattern ?? a.glob ?? ""}`,
    find: () => `Found files ${a.pattern ?? ""}`,
    code_ls: () => `Listed ${path || "."}`,
    ls: () => `Listed ${path || "."}`,
    bash: () => `Ran ${a.command ?? "a command"}`,
    codemode: () => "Ran a script",
    edit: () => `Edited ${path}`,
    write: () => `Wrote ${path}`,
  };
  return (labels[call.name]?.() ?? call.name ?? "Tool call").replace(/\s+/g, " ").trim();
}
export function toolCallHtml(call) {
  const status = ["ok", "error"].includes(call.status) ? call.status : "pending";
  const icon = status === "ok" ? "✓" : status === "error" ? "✕" : "…";
  return `<details class="tool-call" data-status="${status}"><summary title="${esc(call.name)}"><span class="tool-icon" aria-label="${status}">${icon}</span><span class="tool-label">${esc(toolLabel(call))}</span>${status === "error" ? '<span class="tool-failed">failed</span>' : ""}</summary><pre>${esc(call.name)}\nArgs: ${esc(String(call.argsPreview ?? "").slice(0, 500))}\nResult: ${esc(String(call.resultPreview ?? "").slice(0, 500))}</pre></details>`;
}
export function when(at) {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
registerActions({
  async "event-page"(node) {
    const delta = Number(node.dataset.offset),
      id = getProjectId(),
      current = getGeneration();
    eventOffset = node.dataset.offset === "0" ? 0 : Math.max(0, eventOffset + delta);
    observability = null;
    await loadObservability();
    if (id !== getProjectId() || current !== getGeneration()) return;
  },
});
