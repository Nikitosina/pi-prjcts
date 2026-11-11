// Records what the core does to it in window.__probe; the e2e reads that. It writes through a page-wide lookup on purpose (13).
const probe = (window.__probe ??= { evaluations: 0, mounts: 0, aborts: 0, projects: [], slowProject: null, duplicate: null });
probe.evaluations++;
const box = () => document.querySelector('.plugin-panel[data-plugin="panel-probe"] .probe-box');
const definition = {
  name: "panel-probe",
  async mount(slot, panel) {
    probe.mounts++;
    panel.signal.addEventListener("abort", () => probe.aborts++);
    slot.innerHTML = `<div class="probe-box"><p data-probe-project>…</p><p data-probe-clicks></p><p data-probe-echo></p><button type="button" data-action="panel-probe-click">Count</button><button type="button" data-action="panel-probe-boom">Boom</button><button type="button" data-profile="worker">Not core</button></div>`;
    const answer = await panel.rpc("who", { slow: panel.projectId === probe.slowProject });
    probe.projects.push(answer.projectId);
    box().querySelector("[data-probe-project]").textContent = answer.projectId;
    const echo = await panel.fetch("echo", { q: "hi" });
    box().querySelector("[data-probe-echo]").textContent = `${echo.status} ${await echo.text()}`;
  },
  async action(name, node, panel) {
    if (name === "panel-probe-boom") throw new Error('<img src=x onerror="window.__pwned=2"> boom in action');
    const answer = await panel.rpc("click");
    node.closest(".probe-box").querySelector("[data-probe-clicks]").textContent = `clicks ${answer.clicks}`;
  },
};
window.piProjects.register(definition);
try {
  window.piProjects.register(definition);
} catch (error) {
  probe.duplicate = error.message;
}
