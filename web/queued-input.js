// What the owner queued for a working agent, and Alt+Up to take it back. Shared by the Coordinator chat, a worker's focus view and the Host agent
// drawer: each shows the same pending list and restores with the same two steps (the host withdraws and returns the text; the page acknowledges
// once the text is in the editor, so a lost response loses nothing).
import { clip, esc, oneLine } from "./format.js";

export const queuedOf = (items) => (items ?? []).filter((item) => item.state === "queued");
/** Withdrawn earlier and never acknowledged: Alt+Up offers it again. */
export const unclaimedOf = (items) => (items ?? []).filter((item) => item.state === "withdrawn");
export const joinText = (...parts) => parts.filter((part) => part.trim()).join("\n\n");

/** Pi's pending list: steering first, then follow-up, one line each. */
export function pendingHtml(items) {
  const rank = (item) => (item.delivery === "steer" ? 0 : 1);
  return items.length
    ? [...items]
        .sort((a, b) => rank(a) - rank(b))
        .map(
          (item) =>
            `<div class="pending-row" data-pending="${esc(item.id)}"><span class="pending-kind">${item.delivery === "steer" ? "Steering" : "Follow-up"}:</span> <span class="pending-text">${esc(clip(oneLine(item.text), 200))}</span></div>`,
        )
        .join("") + `<div class="pending-hint muted small">↳ <kbd>⌥↑</kbd> to edit all queued messages</div>`
    : "";
}

export function paintPending(box, items) {
  const queued = queuedOf(items);
  box.hidden = !queued.length;
  box.innerHTML = pendingHtml(queued);
}

export const isAltUp = (event) => event.key === "ArrowUp" && event.altKey && !event.isComposing;

/**
 * Alt+Up on a composer without uploads (worker, Host agent). `dequeue` and `acknowledge` call the host; the text goes in front of the draft.
 * Returns how many inputs came back.
 */
export async function restoreInto({ input, dequeue, acknowledge, toast, grow }) {
  const result = await dequeue();
  if (!result.restored.length) {
    toast(result.kept.length ? "Already delivered; nothing to restore" : "No queued messages to restore");
    return 0;
  }
  input.value = joinText(result.restored.map((item) => item.text).join("\n\n"), input.value);
  grow?.();
  toast(`Restored ${result.restored.length} queued message${result.restored.length > 1 ? "s" : ""} to editor`);
  // The text is in the editor now; only then may the host forget it.
  await acknowledge(result.restored.map((item) => item.id));
  return result.restored.length;
}
