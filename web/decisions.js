// The shared Decision inbox at the top of the list while remote hosts are configured: open questions and pending approvals of every
// online host, each labelled with its host. A question opens in its chat on its own host; an approval is decided here, on its host only.
// Without remote hosts it stays hidden: questions wait in the chat dock and approvals in the Host agent drawer, as before.
import { clip, esc } from "./format.js";
import { emit, fail, on, state, toast } from "./state.js";
import { groups, loadProjects, online, remoteGroups } from "./hosts.js";

export function mountDecisions() {
  const box = document.querySelector("#decisions");
  const deciding = new Set(); // `${group key}:${approval id}` while its decision is on the way
  const unknown = new Set(); // decisions whose answer was lost, until that host lists its approvals again

  /** Questions and approvals of online hosts, local host first; a host without question titles (older answer) gives one row per project. */
  function items() {
    const out = [];
    for (const group of groups.filter(online)) {
      for (const project of group.projects) {
        const count = project.notice?.questions ?? 0;
        if (!count) continue;
        const asked = Array.isArray(project.notice.items) ? project.notice.items : null;
        if (asked) for (const item of asked) out.push({ kind: "question", group, project, entry: item.id, title: item.title });
        else out.push({ kind: "question", group, project, title: `${count} question${count === 1 ? "" : "s"}` });
      }
      for (const approval of group.approvals) out.push({ kind: "approval", group, approval });
    }
    return out;
  }
  const count = () => (remoteGroups() ? items().length : 0);

  function where(group, project) {
    return `<span class="d-where">${project ? `<span class="one-line">${esc(clip(project.name, 40))}</span>` : ""}<span class="host-tag">${esc(group.name)}</span></span>`;
  }
  function render() {
    const list = remoteGroups() ? items() : [];
    box.hidden = !list.length;
    if (!list.length) return box.replaceChildren();
    const keep = document.activeElement instanceof HTMLElement && box.contains(document.activeElement) ? keyOf(document.activeElement) : "";
    box.innerHTML =
      `<h2 class="list-label" id="decisions-h">Needs you <span class="count needs">${list.length}</span></h2>` +
      list
        .map((item) => {
          if (item.kind === "question")
            return `<button type="button" class="decision" data-decision-host="${esc(item.group.key)}" data-decision-project="${esc(item.project.id)}"${item.entry ? ` data-decision-entry="${esc(item.entry)}"` : ""}><span class="d-head"><span class="badge s-needs">Question</span><span class="d-title">${esc(clip(item.title, 90))}</span></span>${where(item.group, item.project)}</button>`;
          const { approval, group } = item,
            busy = deciding.has(`${group.key}:${approval.id}`) || unknown.has(`${group.key}:${approval.id}`);
          const project = approval.requestedBy?.projectId
            ? group.projects.find((entry) => entry.id === approval.requestedBy.projectId)
            : null;
          return `<article class="decision approval" data-decision-host="${esc(group.key)}" data-approval="${esc(approval.id)}" aria-label="Approval: ${esc(approval.summary)}"><span class="d-head"><span class="badge t-needs">${esc(approval.action)}</span><span class="d-title">${esc(clip(approval.summary, 120))}</span></span>${where(group, project)}<span class="d-actions"><button type="button" class="primary small" data-decide="approve"${busy ? " disabled" : ""}>Approve</button><button type="button" class="ghost-btn small" data-decide="deny"${busy ? " disabled" : ""}>Deny</button></span></article>`;
        })
        .join("");
    if (keep) box.querySelector(keep)?.focus({ preventScroll: true });
  }
  function keyOf(node) {
    const row = node.closest("[data-decision-host]");
    if (!row) return "";
    const own = [...row.attributes].filter((a) => a.name.startsWith("data-decision") || a.name === "data-approval");
    const selector = own.map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join("");
    return node.dataset.decide ? `${selector} [data-decide="${node.dataset.decide}"]` : selector;
  }

  async function decide(group, id, decision) {
    const key = `${group.key}:${id}`;
    if (deciding.has(key) || unknown.has(key)) return;
    deciding.add(key);
    render();
    try {
      const { approval } = await group.client.call("approval-decide", { id, decision });
      group.approvals = group.approvals.filter((item) => item.id !== id);
      toast(
        `${approval.state === "denied" ? "Denied" : approval.state === "failed" ? "Approved, but it failed" : "Approved"} on ${group.name}: ${clip(approval.summary, 60)}`,
      );
    } catch (error) {
      // Unless the host refused it, the decision may have landed: the buttons stay off until the host lists its approvals again.
      if (error.refused !== true) unknown.add(key);
      fail(error);
    } finally {
      deciding.delete(key);
      render();
      emit("needs");
    }
  }

  box.addEventListener("click", (event) => {
    const row = event.target.closest("[data-decision-host]");
    const group = row && groups.find((item) => item.key === row.dataset.decisionHost);
    if (!group) return;
    const button = event.target.closest("[data-decide]");
    if (button) return void decide(group, row.dataset.approval, button.dataset.decide);
    if (row.dataset.decisionProject)
      emit("open-question", { projectId: row.dataset.decisionProject, entry: row.dataset.decisionEntry ?? null });
  });
  on("projects", render);
  on("hosts", render);
  on("decisions", (group) => {
    for (const key of [...unknown]) if (!group || key.startsWith(`${group.key}:`)) unknown.delete(key);
    render();
  });
  // The answer form lives in the chat dock; after an answer that host's list reports the question gone.
  on("answered", ({ projectId }) => {
    const group = groups.find((item) => item.projects.some((project) => project.id === projectId));
    if (group) void loadProjects(group);
  });

  function focusFirst() {
    box.querySelector("button")?.focus();
  }
  return { count, focusFirst, render };
}
