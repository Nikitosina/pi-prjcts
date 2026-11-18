// The notes panel in Settings → Plugins and the notes section in the chat's right panel, both over the same RPC methods as the Host agent.
{
  const { esc } = window.piProjects;

  function paint(slot, notes) {
    slot.querySelector("[data-notes-list]").innerHTML = notes.length
      ? notes.map((note) => `<li>${esc(note.text)}</li>`).join("")
      : `<li class="notes-empty">No notes yet.</li>`;
  }

  window.piProjects.register({
    name: "notes",
    async mount(slot, panel) {
      slot.innerHTML = `<div class="notes-panel"><ul data-notes-list><li class="notes-empty">Loading…</li></ul><div class="notes-add"><input type="text" maxlength="500" placeholder="A short note" aria-label="New note" data-notes-text><button type="button" class="ghost-btn small" data-action="notes-add">Add note</button></div></div>`;
      paint(slot, (await panel.rpc("list")).notes);
    },
    // The right panel of the chat: the latest notes, and the chat the owner has selected. It mounts again for each project and chat.
    sidebar: {
      async mount(slot, section) {
        slot.innerHTML = `<div class="notes-panel"><p class="small muted" data-notes-chat></p><ul data-notes-list><li class="notes-empty">Loading…</li></ul></div>`;
        slot.querySelector("[data-notes-chat]").textContent = `Chat: ${section.chatId}`;
        paint(slot, (await section.rpc("list")).notes.slice(-3));
      },
    },
    async action(name, node, panel) {
      const slot = node.closest(".notes-panel").parentElement,
        input = slot.querySelector("[data-notes-text]");
      if (name !== "notes-add" || !input.value.trim()) return;
      const { notes } = await panel.rpc("add", { text: input.value.trim() });
      input.value = "";
      paint(slot, notes);
    },
  });
}
