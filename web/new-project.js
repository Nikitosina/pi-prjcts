// New project on one chosen host (the group's menu, shown while remote hosts exist). The request goes to that host's client only.
import { uuid } from "./api.js";
import { loadProjects } from "./hosts.js";
import { emit, fail, on, toast } from "./state.js";

export function mountNewProject() {
  const dialog = document.querySelector("#new-project");
  on("new-project", ({ group }) => {
    dialog.innerHTML = `<form method="dialog" class="confirm"><h2 id="np-title">New project on ${esc(group.name)}</h2><label>Name<input name="name" required maxlength="200" /></label><label>Workspace path on ${esc(group.name)}<input name="cwd" required placeholder="/Users/…/repo" /></label><p class="muted small" role="alert" id="np-error"></p><div class="confirm-actions"><button type="button" class="ghost-btn" value="cancel">Cancel</button><button type="submit" class="primary">Create</button></div></form>`;
    const form = dialog.querySelector("form"),
      requestId = uuid();
    form.querySelector("[value=cancel]").onclick = () => dialog.close();
    form.onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      try {
        const project = await group.client.call("create", { name: data.get("name").trim(), cwd: data.get("cwd").trim(), requestId });
        dialog.close();
        await loadProjects(group);
        toast(`Created ${project.name} on ${group.name}.`);
        emit("select-request", { projectId: project.id, chatId: "main" });
      } catch (error) {
        form.querySelector("#np-error").textContent = error.message;
      }
    };
    dialog.showModal();
    form.querySelector("input").focus();
  });
}
const esc = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
