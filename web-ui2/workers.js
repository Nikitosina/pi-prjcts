// Right context panel: the selected chat's workers (2–3 lines each), PRs and plugin cards; and the worker transcript in the center.
import { call, uuid } from "./api.js";
import { clip, dur, esc, oneLine, shortModel } from "./format.js";
import { emit, fail, on, stale, state, toast } from "./state.js";
import { transcriptClick, transcriptHtml } from "./chat.js";
import { hydrateMedia } from "./media.js";

const box = document.querySelector("#workers");
const lastTools = new Map(); // worker id -> { name, args } of its newest tool call
let tiers = null; // tiers-get result, re-read when the host publishes `tiers`
let armed = null; // job id whose Approve was clicked once

const ROLE_ICON = { worker: "⚒", scout: "⌕", reviewer: "◎" };
const STATE = {
  running: { label: "Working", tone: "work" },
  checkpoint: { label: "Checkpoint", tone: "needs" },
  ready: { label: "Ready", tone: "ready" },
  "ready-with-gaps": { label: "Ready with gaps", tone: "needs" },
  failed: { label: "Failed", tone: "bad" },
  stopped: { label: "Stopped", tone: "muted" },
  approved: { label: "Approved", tone: "done" },
  completed: { label: "Done", tone: "done" },
};

export async function loadJobs() {
  const gen = state.generation;
  try {
    const [jobs, tierData] = await Promise.all([
      call("jobs-snapshot", { id: state.projectId }),
      tiers ? tiers : call("tiers-get").catch(() => null),
    ]);
    if (stale(gen)) return;
    tiers = tierData;
    state.jobs = jobs;
    renderWorkers();
    emit("jobs", jobs);
    void loadLastTools(gen);
  } catch (error) {
    if (!stale(gen)) fail(error);
  }
}
on("select", () => {
  state.jobs = null;
  lastTools.clear();
  box.replaceChildren();
});

function chatConversation() {
  return (state.view?.chats ?? []).find((chat) => chat.id === state.chatId)?.conversationId ?? 1;
}
/** Workers spawned from the selected chat: Jobs first (newest first), then scouts and reviewers that are not part of a Job. */
export function chatWorkers() {
  if (!state.jobs) return [];
  const conversation = chatConversation();
  const jobs = state.jobs.jobs
    .filter((job) => job.chat === conversation && !job.dismissedAt)
    .map((job) => ({ kind: "job", role: "worker", ...job }));
  const agents = state.jobs.agents
    .filter((agent) => agent.chat === conversation && !agent.jobId && !agent.dismissedAt)
    .map((agent) => ({ kind: "agent", ...agent, status: agent.working ? "running" : agent.endedAt ? "completed" : "running", plan: [] }));
  return [...jobs, ...agents].sort((a, b) => b.createdAt - a.createdAt);
}
/** The model the agent runs on (from jobs-snapshot), lettered with its profile's tier only when the model is in that tier. */
function modelChip(worker) {
  const model = worker.model;
  if (!model) return "";
  const tierId = state.view?.project?.profiles?.[worker.role]?.tier,
    tier = tierId ? tiers?.tiers.find((item) => item.id === tierId) : null,
    place = tier ? tier.models.indexOf(model) : -1;
  const where = !tier
    ? "no tier"
    : place < 0
      ? `outside its tier ${tier.name}`
      : place === 0
        ? tier.name
        : `${tier.name}, fallback ${place + 1} of ${tier.models.length}`;
  const moved = worker.modelMoves?.length ? ` · moved from ${worker.modelMoves[0].from}` : "";
  return `<span class="chip mono" data-model="${esc(model)}" title="${esc(`${model} · ${where}${moved}`)}">${place >= 0 ? `<b>${esc(tier.letter)}</b>` : ""}${esc(shortModel(model))}</span>`;
}
function renderWorkers() {
  const list = chatWorkers();
  document.querySelector("#workers-count").textContent = list.length ? String(list.length) : "";
  if (!list.length) {
    box.innerHTML = `<p class="muted small empty-line">No workers in this chat yet.</p>`;
    return;
  }
  box.innerHTML = list.map(workerHtml).join("");
}
function workerHtml(worker) {
  const stalled = worker.status === "running" && worker.stalledAt;
  const look = stalled ? { label: "Stalled", tone: "needs" } : (STATE[worker.status] ?? { label: worker.status, tone: "muted" });
  const plan = worker.plan ?? [],
    done = plan.filter((step) => step.status === "done").length,
    doing = plan.find((step) => step.status === "doing") ?? plan.find((step) => step.status === "todo");
  const eta = worker.eta?.etaMin;
  const step = plan.length
    ? `<div class="w-plan"><span class="mono">${done}/${plan.length}</span><span class="w-step">${esc(clip(doing?.title ?? (done === plan.length ? "All steps done" : ""), 60))}</span>${eta && worker.status === "running" ? `<span class="muted">~${esc(dur(eta * 60000))}</span>` : ""}</div><div class="bar" role="progressbar" aria-label="Plan progress" aria-valuemin="0" aria-valuemax="${plan.length}" aria-valuenow="${done}"><span style="width:${Math.round((100 * done) / plan.length)}%"></span></div>`
    : worker.status === "running"
      ? `<div class="w-plan muted">Planning…</div>`
      : "";
  const tool = worker.working && lastTools.get(worker.id);
  const toolLine = tool
    ? `<div class="w-tool mono"><span class="spin small" aria-hidden="true"></span>${esc(tool.name)} <span class="muted">${esc(clip(tool.args, 60))}</span></div>`
    : "";
  const action =
    worker.status === "ready" || worker.status === "ready-with-gaps"
      ? armed === worker.id
        ? `<button type="button" class="primary small danger" data-approve="${esc(worker.id)}">Confirm approve${worker.pr ? ` #${esc(worker.pr)}` : ""}</button>`
        : `<button type="button" class="primary small" data-approve="${esc(worker.id)}">Approve</button>`
      : stalled
        ? `<button type="button" class="ghost-btn small" data-open-worker="${esc(worker.id)}" data-steer="1">Steer</button>`
        : worker.status === "failed" || worker.status === "checkpoint"
          ? `<button type="button" class="ghost-btn small" data-open-worker="${esc(worker.id)}">Open</button>`
          : "";
  return `<article class="worker${worker.working ? " working" : ""}" data-status="${esc(worker.status)}" data-tone="${look.tone}"><div class="w-line1"><span class="w-role" aria-label="${esc(worker.role)}">${ROLE_ICON[worker.role] ?? "•"}</span><button type="button" class="w-title" data-open-worker="${esc(worker.id)}">${esc(clip(worker.title, 70))}</button>${modelChip(worker)}</div>${step}${toolLine}<div class="w-foot"><span class="badge t-${look.tone}">${esc(look.label)}</span>${worker.pr ? `<span class="muted small mono">PR #${esc(worker.pr)}</span>` : ""}<span class="grow"></span>${action}</div></article>`;
}
async function loadLastTools(gen) {
  const running = chatWorkers()
    .filter((worker) => worker.working)
    .slice(0, 4);
  for (const worker of running) {
    const page = await call("thread-history", { id: state.projectId, threadId: worker.id, limit: 8 }).catch(() => null);
    if (stale(gen) || !page) return;
    const last = page.items.findLast((item) => item.kind === "tool-call");
    if (last) lastTools.set(worker.id, { name: last.name, args: oneLine(last.argsPreview) });
  }
  if (running.length) renderWorkers();
}
box.addEventListener("click", async (event) => {
  const approve = event.target.closest("[data-approve]");
  if (approve) {
    const id = approve.dataset.approve;
    if (armed !== id) {
      armed = id;
      renderWorkers();
      box.querySelector(`[data-approve="${CSS.escape(id)}"]`)?.focus();
      setTimeout(() => {
        if (armed === id) {
          armed = null;
          renderWorkers();
        }
      }, 6000);
      return;
    }
    armed = null;
    const gen = state.generation;
    try {
      await call("job-approve", { id: state.projectId, jobId: id });
      if (stale(gen)) return;
      toast("Approved.");
      void loadJobs();
    } catch (error) {
      fail(error);
    }
    return;
  }
  const open = event.target.closest("[data-open-worker]");
  if (open) emit("open", { kind: "worker", id: open.dataset.openWorker, steer: !!open.dataset.steer });
});

// ---------------------------------------------------------------------------------------------------------------- PRs, plugins

export async function loadSide() {
  const gen = state.generation;
  const [prs, plugins] = await Promise.all([call("prs", { id: state.projectId }).catch(() => null), call("plugins").catch(() => null)]);
  if (stale(gen)) return;
  const items = (prs?.providers ?? []).flatMap((provider) =>
    (provider.prs ?? provider.items ?? []).map((pr) => ({ ...pr, provider: provider.label ?? provider.id })),
  );
  document.querySelector("#prs").innerHTML = items.length
    ? items
        .slice(0, 12)
        .map(
          (pr) =>
            `<div class="pr-row"><span class="mono">#${esc(pr.number ?? pr.id ?? "")}</span><span class="pr-title">${esc(clip(pr.title ?? "", 70))}</span><span class="badge">${esc(pr.state ?? pr.status ?? "")}</span></div>`,
        )
        .join("")
    : `<p class="muted small empty-line">No pull requests followed.</p>`;
  const cards = (plugins?.web ?? []).filter((card) => card.title || card.label);
  document.querySelector("#plugin-cards").innerHTML = cards.length
    ? `<h2>Plugins</h2>${cards.map((card) => `<div class="plugin-card"><b>${esc(card.title ?? card.label)}</b>${card.text ? `<p class="small muted">${esc(clip(card.text, 160))}</p>` : ""}</div>`).join("")}`
    : "";
}

// ---------------------------------------------------------------------------------------------------------------- worker in the center

// Worker live frames are not exposed per thread; the transcript re-reads on the jobs topic.
/** Which prompt a running agent has, when it is not simply the saved one (jobs-snapshot `agents[].prompt`). */
const PROMPT = {
  pending: "Prompt update pending",
  "legacy-unchecked": "Prompt check pending",
  frozen: "Prompt frozen",
};
function promptLine(worker) {
  // A Job's details show its worker agent.
  const agent =
    worker && "prompt" in worker ? worker : state.jobs?.agents.find((item) => item.jobId === worker?.id && item.role === "worker");
  const prompt = agent?.prompt;
  if (!prompt || !PROMPT[prompt.state]) return "";
  return `<p class="w-prompt" data-prompt-state="${esc(prompt.state)}"><b>${PROMPT[prompt.state]}</b>${prompt.reason ? ` <span>${esc(prompt.reason)}</span>` : ""}</p>`;
}
export async function renderWorker(root, id, { steer = false } = {}) {
  const gen = state.generation;
  const find = () =>
    chatWorkers().find((item) => item.id === id) ??
    state.jobs?.jobs.find((job) => job.id === id) ??
    state.jobs?.agents.find((agent) => agent.id === id);
  const head = () => {
    const worker = find();
    const look = worker ? (STATE[worker.status] ?? { label: worker.status ?? "", tone: "muted" }) : null;
    return `<div class="focus-head"><button type="button" class="back" data-cmd="leave-focus" aria-label="Back to chat">← <kbd>Esc</kbd></button><span class="w-role" aria-hidden="true">${ROLE_ICON[worker?.role ?? "worker"] ?? "⚒"}</span><h1>${esc(worker?.title ?? "Worker")}</h1>${look ? `<span class="badge t-${look.tone}">${esc(look.label)}</span>` : ""}<span class="grow"></span>${worker?.working ? `<button type="button" class="ghost-btn small" data-stop-worker>Stop</button>` : ""}</div>${promptLine(worker)}${worker?.ready ? `<div class="report-card"><b>Ready report</b><p>${esc(worker.ready.summary)}</p>${worker.ready.proof?.length ? `<ul>${worker.ready.proof.map((item) => `<li class="mono small">${esc(item)}</li>`).join("")}</ul>` : ""}</div>` : ""}`;
  };
  root.innerHTML = `${head()}<div id="worker-feed" class="feed-inner"><p class="loading-line">Loading transcript…</p></div><form class="worker-send"><span class="glyph" aria-hidden="true">❯</span><textarea rows="1" aria-label="Message this worker" placeholder="${steer ? "Steer this worker…" : "Message this worker…"}" maxlength="24000"></textarea><button type="submit" class="send" aria-label="Send to worker">↵</button></form>`;
  let items = [];
  // The focus view is reused: this render lives only while its own feed is on the page.
  const node = root.querySelector("#worker-feed"),
    alive = () => node.isConnected && !stale(gen);
  const paint = () => {
    if (!alive()) return;
    const worker = find();
    node.innerHTML =
      transcriptHtml(
        items,
        !!worker?.working,
        worker?.role === "worker" ? "Worker" : worker?.role ? worker.role[0].toUpperCase() + worker.role.slice(1) : "Worker",
      ) || `<p class="muted">No transcript yet.</p>`;
    hydrateMedia(node, { project: state.projectId, threadId: id });
    node.scrollTop = node.scrollHeight;
  };
  const load = async () => {
    const page = await call("thread-history", { id: state.projectId, threadId: id, limit: 200 }).catch((error) => {
      if (alive()) node.innerHTML = `<p class="muted">${esc(error.message)}</p>`;
      return null;
    });
    if (!page || !alive()) return;
    items = page.items;
    root.querySelector(".focus-head").outerHTML = head().replace(/<p class="w-prompt"[\s\S]*$|<div class="report-card">[\s\S]*$/, "");
    const line = promptLine(find()),
      old = root.querySelector(".w-prompt");
    if (old) old.outerHTML = line;
    else if (line) root.querySelector(".focus-head").insertAdjacentHTML("afterend", line);
    paint();
  };
  await load();
  if (!alive()) return;
  node.addEventListener("click", (event) => void transcriptClick(event, root, paint));
  const unsub = on("jobs", () => {
    if (!alive()) return unsub();
    void load();
  });
  root.addEventListener("click", async (event) => {
    if (!alive() || !event.target.closest("[data-stop-worker]")) return;
    try {
      await call("thread-stop", { id: state.projectId, threadId: id });
      toast("Stopped. History and files kept.");
    } catch (error) {
      fail(error);
    }
  });
  const form = root.querySelector(".worker-send"),
    text = form.querySelector("textarea");
  if (steer) text.focus();
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = text.value.trim();
    if (!value) return;
    const worker = find();
    text.value = "";
    try {
      await call(worker?.working ? "thread-steer" : "thread-send", { id: state.projectId, threadId: id, requestId: uuid(), text: value });
      if (stale(gen)) return;
      toast(worker?.working ? "Steer sent." : "Sent to the worker.");
      void load();
    } catch (error) {
      text.value = value;
      fail(error);
    }
  });
}
// A tier edit can change the letter on every model chip.
on("tiers", () => {
  tiers = null;
  if (state.projectId) void loadJobs();
});
