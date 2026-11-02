import { esc } from "./format.js";

export function coordinatorAccessHtml(view, projectId, chatId) {
  const access = view?.coordinatorAccess,
    chat = view?.chats?.find((chat) => chat.id === chatId);
  if (
    !access ||
    view.project?.id !== projectId ||
    view.chatId !== chatId ||
    access.chatId !== chatId ||
    access.conversationId !== chat?.conversationId
  )
    return "";
  const workspace = access.workspace;
  const location =
    workspace.state === "ready"
      ? `<dl><dt>Worktree</dt><dd><code>${esc(workspace.cwd)}</code></dd><dt>Provider</dt><dd>${esc(workspace.provider)}</dd><dt>Branch</dt><dd><code>${esc(workspace.branch)}</code></dd></dl>`
      : workspace.state === "unallocated"
        ? "<p>Worktree not allocated.</p>"
        : `<p>Worktree unavailable: ${esc(workspace.reason)}</p>`;
  return `${location}
    <p>Trusted local execution. Commands run as the host user, not sandboxed. Merge, deployment and destructive operations require owner approval as behavioral policy, not technical enforcement.</p>
    <p>Resolved tools for the next request. Remote service reachability is not verified.</p>
    ${access.toolNames.length ? `<ul class="coordinator-tool-list">${access.toolNames.map((name) => `<li><code>${esc(name)}</code></li>`).join("")}</ul>` : "<p>No tools offered.</p>"}
    <p>Browser execution uses installed automation through bash or configured MCPs, not a built-in browser tool.</p>
    <p>MCP and skill gateway settings remain unchanged. They are not OS confinement.</p>`;
}

export function renderCoordinatorAccess(view, projectId, chatId) {
  const node = document.querySelector("#coordinator-access"),
    body = node.querySelector(".coordinator-access-body"),
    html = coordinatorAccessHtml(view, projectId, chatId),
    key = `${projectId}/${chatId}`;
  if (node.dataset.key !== key || !html) node.open = false;
  node.dataset.key = key;
  node.hidden = !html;
  if (body.dataset.html !== html) {
    body.innerHTML = html;
    body.dataset.html = html;
  }
}
