// What the owner queued for a working agent, and Alt+Up to take it back. Shared by the Coordinator chat, a worker's focus view and the Host agent
// drawer: each shows the same pending list and restores with the same two steps (the host withdraws and returns the text; the page acknowledges
// once the text is in the surface's draft in localStorage, so a lost response, a reload or leaving the surface loses nothing).
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

// ---------------------------------------------------------------------------------------------------------------- drafts

/** The host sends at most this many uploads with one message (`attachments` in the `message` schema). */
export const ATTACHMENT_LIMIT = 10;
const DRAFT = "pi-ui2-draft:";
/** One draft per place a message is typed: a Coordinator chat, a worker, the Host agent. */
export const surfaces = {
  chat: (projectId, chatId) => `chat:${projectId}:${chatId ?? "main"}`,
  worker: (projectId, threadId) => `worker:${projectId}:${threadId}`,
  host: "host",
};

/** What the owner has in a surface's editor: text, the uploads and origin of restored messages, and restored ids the host may not have forgotten yet. */
export function readDraft(surface) {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT + surface) ?? "null");
    return { text: draft?.text ?? "", attachments: draft?.attachments ?? [], origin: draft?.origin, unacked: draft?.unacked ?? [] };
  } catch {
    return { text: "", attachments: [], unacked: [] };
  }
}
/** Throws when the browser refuses the write, so nothing is acknowledged on the strength of a draft that was not kept. */
export function writeDraft(surface, draft) {
  const empty = !draft.text && !draft.attachments?.length && !draft.unacked?.length;
  if (empty) localStorage.removeItem(DRAFT + surface);
  else
    localStorage.setItem(
      DRAFT + surface,
      JSON.stringify({ text: draft.text, attachments: draft.attachments ?? [], origin: draft.origin, unacked: draft.unacked ?? [] }),
    );
}
/** Typing: the editor text follows into the draft. An emptied editor drops the uploads of restored messages with their text. */
export function persistText(surface, text) {
  const draft = readDraft(surface);
  const blank = !text.trim();
  try {
    writeDraft(surface, { ...draft, text, ...(blank ? { attachments: [], origin: undefined } : {}) });
  } catch {
    // A full store only costs the draft of what is being typed; restored text is written (and checked) by `restoreInto`.
  }
}
const quietly = (write) => {
  try {
    write();
  } catch {
    // The draft is a convenience; only restored text needs a write that succeeded, and `restoreInto` checks that itself.
  }
};
/** A send starts: the editor text leaves the draft; the uploads and origin ride along with this message and stay until it is accepted. */
export function beginSend(surface) {
  const draft = readDraft(surface);
  quietly(() => writeDraft(surface, { ...draft, text: "" }));
  return { attachments: draft.attachments, origin: draft.origin };
}
/** The host accepted the message: its uploads and origin are the host's now, whatever was restored meanwhile stays. */
export function finishSend(surface, sent) {
  const draft = readDraft(surface);
  quietly(() =>
    writeDraft(surface, {
      ...draft,
      attachments: draft.attachments.filter((id) => !sent.attachments.includes(id)),
      origin: draft.origin === sent.origin ? undefined : draft.origin,
    }),
  );
}
/** The host refused it: the text goes back in front of whatever is in the draft now (the uploads never left). */
export function failSend(surface, text) {
  const draft = readDraft(surface);
  quietly(() => writeDraft(surface, { ...draft, text: joinText(text, draft.text) }));
}

/** Longest prefix of the restored messages (in Pi's order) whose uploads, together with the draft's, fit one message. */
function fit(restored, attachments) {
  const held = new Set(attachments);
  const take = [];
  for (const entry of restored) {
    const next = new Set([...held, ...(entry.attachments ?? [])]);
    if (next.size > ATTACHMENT_LIMIT) break;
    next.forEach((id) => held.add(id));
    take.push(entry);
  }
  return { take, left: restored.slice(take.length), attachments: [...held] };
}

/**
 * Alt+Up. `dequeue` and `acknowledge` call the host; `editor` is `{ live, read, show }` (`live` is false once the owner left the surface, so a
 * detached editor is never written). The restored text goes in front of the draft, is kept in localStorage, and only then acknowledged.
 * Messages that would push the draft past the upload limit stay withdrawn and unacknowledged, so the next Alt+Up offers them again.
 * Returns how many inputs came back.
 */
export async function restoreInto({ surface, editor, dequeue, acknowledge, toast, grow }) {
  const result = await dequeue();
  const draft = readDraft(surface);
  if (editor.live()) draft.text = editor.read();
  // Offered again after a lost acknowledgment: already in the draft, so only the acknowledgment is retried.
  const again = result.restored.filter((entry) => draft.unacked.includes(entry.id));
  const fresh = result.restored.filter((entry) => !draft.unacked.includes(entry.id));
  if (!result.restored.length) {
    toast(result.kept.length ? "Already delivered; nothing to restore" : "No queued messages to restore");
    return 0;
  }
  const { take, left, attachments } = fit(fresh, draft.attachments);
  const heldNote = left.length
    ? `${left.length} queued message${left.length > 1 ? "s carry" : " carries"} more uploads than one message can send; send the editor first. ${left.length > 1 ? "They stay" : "It stays"} queued for the next Alt+Up.`
    : "";
  const taken = [...again, ...take];
  if (!taken.length) {
    if (heldNote) toast(heldNote);
    return 0;
  }
  const origins = new Set(take.map((entry) => entry.origin ?? null));
  const merged = {
    text: take.length ? joinText(take.map((entry) => entry.text).join("\n\n"), draft.text) : draft.text,
    attachments,
    origin: draft.origin ?? (origins.size === 1 ? ([...origins][0] ?? undefined) : undefined),
    unacked: [...draft.unacked, ...take.map((entry) => entry.id)],
  };
  try {
    writeDraft(surface, merged);
  } catch {
    toast("Could not keep the restored text in this browser; it stays queued and was not removed");
    return 0;
  }
  if (editor.live()) {
    editor.show(merged.text);
    grow?.();
  }
  if (take.length) toast(`Restored ${take.length} queued message${take.length > 1 ? "s" : ""} to editor`);
  if (heldNote) toast(heldNote);
  await acknowledgeDraft({ surface, acknowledge, ids: taken.map((entry) => entry.id) });
  return take.length;
}

/** The host forgets restored text only now that the draft holds it. A failure keeps the ids, so the next visit or Alt+Up retries. */
export async function acknowledgeDraft({ surface, acknowledge, ids = readDraft(surface).unacked }) {
  if (!ids.length) return;
  await acknowledge(ids);
  const draft = readDraft(surface);
  writeDraft(surface, { ...draft, unacked: draft.unacked.filter((id) => !ids.includes(id)) });
}
