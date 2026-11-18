// The Tasks section in the chat's right panel: the selected chat's open tasks, read through the plugin's read-only `list` method.
{
  const { esc } = window.piProjects;
  const POLL_MS = 3000;
  const STAGES = { planned: "Planned", "in-progress": "In progress", "in-review": "In review", blocked: "Blocked", done: "Done" };
  const isLink = (url) => /^https?:\/\//i.test(url ?? "");

  function prLine(pr) {
    const label = esc(`${pr.provider} ${pr.repository}#${pr.number}`);
    return isLink(pr.url) ? `<a href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  }

  function row(task) {
    const note = task.note ? `<div class="tasks-note">${esc(task.note)}</div>` : "";
    const job = task.job ? `<span class="tasks-meta">${esc(task.job)}</span>` : "";
    const pr = task.pr ? `<span class="tasks-meta tasks-pr">${prLine(task.pr)}</span>` : `<span class="tasks-meta">no PR</span>`;
    return `<li class="tasks-row" data-task="${esc(task.id)}" data-stage="${esc(task.stage)}"><div class="tasks-head"><span class="tasks-title">${esc(task.title)}</span><span class="badge tasks-stage">${esc(STAGES[task.stage] ?? task.stage)}</span></div><div class="tasks-line">${pr}${job}</div>${note}</li>`;
  }

  function paint(slot, tasks) {
    const open = tasks.filter((task) => task.stage !== "done"),
      finished = tasks.length - open.length;
    slot.querySelector("[data-tasks-list]").innerHTML = open.length
      ? open.map(row).join("")
      : `<li class="tasks-empty">No open tasks.</li>`;
    slot.querySelector("[data-tasks-finished]").textContent = finished ? `${finished} finished` : "";
  }

  window.piProjects.register({
    name: "tasks",
    sidebar: {
      async mount(slot, section) {
        slot.innerHTML = `<div class="tasks-panel"><ul data-tasks-list></ul><div class="tasks-foot"><span data-tasks-finished></span><span data-tasks-error></span></div></div>`;
        const error = slot.querySelector("[data-tasks-error]");
        slot.querySelector("[data-tasks-list]").innerHTML = `<li class="tasks-empty">Loading…</li>`;
        let reading = false;
        // One read at a time: a slow host never has every answer discarded, and a failed read never stops the next one.
        const load = async () => {
          if (reading || section.signal.aborted) return;
          reading = true;
          try {
            const { tasks } = await section.rpc("list", { chatId: section.chatId });
            paint(slot, tasks);
            error.textContent = "";
          } catch (failure) {
            if (failure?.name !== "AbortError") error.textContent = "Tasks could not be refreshed";
          } finally {
            reading = false;
          }
        };
        let timer;
        const poll = () => {
          timer = setTimeout(async () => {
            if (!document.hidden) await load();
            if (!section.signal.aborted) poll();
          }, POLL_MS);
        };
        section.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
        await load();
        poll();
        document.addEventListener("visibilitychange", () => !document.hidden && void load(), { signal: section.signal });
      },
    },
  });
}
