const log = (window.__side ??= { evaluations: 0, mounts: [], aborts: [], late: [], settingsMounts: 0 });
log.evaluations++;
const node = () => document.querySelector('#plugin-sections [data-plugin="side-a"] .plugin-slot');
window.piProjects.register({
  name: "side-a",
  mount(slot) {
    log.settingsMounts++;
    slot.textContent = "side-a settings";
  },
  sidebar: {
    async mount(slot, section) {
      const entry = { chatId: section.chatId, projectId: section.projectId };
      log.mounts.push(entry);
      section.signal.addEventListener("abort", () => log.aborts.push(section.chatId));
      slot.innerHTML = `<p data-side-chat>…</p><p data-side-echo></p><button type="button" data-action="side-a-late">Late</button><button type="button" data-profile="worker">Not core</button>`;
      const slow = section.chatId === log.slowChat ? 1500 : 0;
      const answer = await section.rpc("read", { chatId: section.chatId, slow });
      node().querySelector("[data-side-chat]").textContent = `${answer.projectId}/${answer.chatId}`;
      const echo = await section.fetch("echo");
      node().querySelector("[data-side-echo]").textContent = await echo.text();
    },
    async action(name, _node, section) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      log.lateAttempted = true;
      await section.rpc("ping").catch((error) => (log.lateError = error.name));
    },
  },
});
