window.piProjects.register({
  name: "side-b",
  sidebar: {
    async mount(slot, section) {
      const answer = await section.rpc("read", { chatId: section.chatId });
      slot.innerHTML = `<p data-side-b>${window.piProjects.esc(answer.chatId)}</p>`;
    },
  },
});
