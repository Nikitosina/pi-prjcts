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

/** Restored ids remembered per surface, so a stale response that offers one again adds nothing. */
const RECEIPTS = 200;
/**
 * What a surface holds: the editor's text, the uploads and origin of restored messages, restored ids the host may not have forgotten yet
 * (`unacked`), ids already restored and acknowledged (`done`), and the sends in flight (`sending`: each owns its text, uploads, origin and
 * request id until the host accepted it, so a reload or a rejected request loses nothing).
 */
export function readDraft(surface) {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT + surface) ?? "null");
    return {
      text: draft?.text ?? "",
      attachments: draft?.attachments ?? [],
      origin: draft?.origin,
      unacked: draft?.unacked ?? [],
      done: draft?.done ?? [],
      sending: draft?.sending ?? [],
    };
  } catch {
    return { text: "", attachments: [], unacked: [], done: [], sending: [] };
  }
}
/** Throws when the browser refuses the write, so nothing is acknowledged on the strength of a draft that was not kept. */
export function writeDraft(surface, draft) {
  const empty = !draft.text && !draft.attachments?.length && !draft.unacked?.length && !draft.done?.length && !draft.sending?.length;
  if (empty) localStorage.removeItem(DRAFT + surface);
  else
    localStorage.setItem(
      DRAFT + surface,
      JSON.stringify({
        text: draft.text,
        attachments: draft.attachments ?? [],
        origin: draft.origin,
        unacked: draft.unacked ?? [],
        done: (draft.done ?? []).slice(-RECEIPTS),
        sending: draft.sending ?? [],
      }),
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
/** Sends this page has in flight; a recovery never resends one of them. */
const inFlight = new Set();
/**
 * A send starts: the message takes the editor text, the uploads and the origin out of the draft and keeps them, with its request id, until the
 * host accepted it. Whatever is restored or typed meanwhile belongs to the next send. Returns null when the browser would not keep the record:
 * nothing was cleared, so the caller sends nothing and the text stays in the editor.
 */
export function beginSend(surface, { requestId, text, delivery }) {
  const draft = readDraft(surface);
  const record = { requestId, text, delivery, attachments: draft.attachments, origin: draft.origin };
  try {
    writeDraft(surface, { ...draft, text: "", attachments: [], origin: undefined, sending: [...draft.sending, record] });
  } catch {
    return null;
  }
  inFlight.add(requestId);
  return record;
}
/** The host accepted the message: it is the host's now. Only this send's record goes. */
export function finishSend(surface, requestId) {
  inFlight.delete(requestId);
  const draft = readDraft(surface);
  quietly(() => writeDraft(surface, { ...draft, sending: draft.sending.filter((record) => record.requestId !== requestId) }));
}
/** What the draft holds besides the record, and whether the record may join it as one message: same origin, uploads within the limit. */
function joins(draft, record) {
  const held = Boolean(draft.text.trim()) || draft.attachments.length > 0;
  const sameOrigin = !held || (draft.origin ?? null) === (record.origin ?? null);
  return sameOrigin && new Set([...record.attachments, ...draft.attachments]).size <= ATTACHMENT_LIMIT;
}
/**
 * A send failed. The host says it refused (`error.refused`: nothing recorded): the text, uploads and origin go back in front of the editor's
 * current text, or, when they cannot join it, stay as a refused record that Alt+Up offers. Any other failure is an unknown outcome: the record
 * keeps its request id and payload and is sent again, and the host's id check makes it run once. Returns "refused" or "unknown".
 */
export function failSend(surface, requestId, error, editor) {
  inFlight.delete(requestId);
  const refused = !error || error.refused === true;
  if (!refused) return "unknown";
  const draft = readDraft(surface);
  const record = draft.sending.find((item) => item.requestId === requestId);
  if (!record) return "refused";
  const shown = editor?.live();
  if (shown) draft.text = editor.read();
  const rest = draft.sending.filter((item) => item.requestId !== requestId);
  if (!joins(draft, record)) {
    quietly(() =>
      writeDraft(surface, { ...draft, sending: draft.sending.map((item) => (item === record ? { ...record, refused: true } : item)) }),
    );
    return "refused";
  }
  const next = {
    ...draft,
    text: joinText(record.text, draft.text),
    attachments: [...new Set([...record.attachments, ...draft.attachments])],
    origin: draft.origin ?? record.origin,
    sending: rest,
  };
  quietly(() => writeDraft(surface, next));
  if (shown) editor.show(next.text);
  return "refused";
}
/**
 * A page that finds sends the last page never saw accepted sends each again under its own request id (the host takes an id once and refuses a
 * different payload under it, so a request that did arrive is not repeated). A refusal puts the text back; any other failure keeps the record
 * for the next recovery. Returns how many were accepted.
 */
export async function recoverSends(surface, resend, editor) {
  let accepted = 0;
  for (const record of readDraft(surface).sending.filter((item) => !item.refused && !inFlight.has(item.requestId))) {
    inFlight.add(record.requestId);
    try {
      await resend(record);
      finishSend(surface, record.requestId);
      accepted++;
    } catch (error) {
      failSend(surface, record.requestId, error, editor);
    }
  }
  return accepted;
}

/**
 * Longest prefix of the restored messages (in Pi's order) that is one message together with the draft: the uploads fit the limit and the origin
 * is the same (a Telegram message and a web one never become one). `held` says why the rest stays.
 */
function fit(restored, draft) {
  const held = new Set(draft.attachments);
  let origin = draft.text.trim() || draft.attachments.length ? (draft.origin ?? null) : undefined;
  const take = [];
  let why = "";
  for (const entry of restored) {
    const next = new Set([...held, ...(entry.attachments ?? [])]);
    if (next.size > ATTACHMENT_LIMIT) {
      why = "uploads";
      break;
    }
    if (origin !== undefined && origin !== (entry.origin ?? null)) {
      why = "origin";
      break;
    }
    origin = entry.origin ?? null;
    next.forEach((id) => held.add(id));
    take.push(entry);
  }
  return { take, left: restored.slice(take.length), attachments: [...held], origin: origin ?? undefined, why };
}

/**
 * Alt+Up. `dequeue` and `acknowledge` call the host; `editor` is `{ live, read, show }` (`live` is false once the owner left the surface, so a
 * detached editor is never written). The restored text goes in front of the draft, is kept in localStorage, and only then acknowledged.
 * Messages that would push the draft past the upload limit stay withdrawn and unacknowledged, so the next Alt+Up offers them again.
 * Returns how many inputs came back.
 */
const queues = new Map();
export function restoreInto(options) {
  // One restore at a time per composer, also across tabs (a Web Lock named for the surface): a second Alt+Up waits for the first one's acknowledgment.
  const exclusive = (work) => (globalThis.navigator?.locks ? navigator.locks.request(`pi-ui2-restore:${options.surface}`, work) : work());
  const run = (queues.get(options.surface) ?? Promise.resolve()).then(() => exclusive(() => restoreOnce(options)));
  queues.set(
    options.surface,
    run.catch(() => {}),
  );
  return run;
}
async function restoreOnce({ surface, editor, dequeue, acknowledge, toast, grow }) {
  const result = await dequeue();
  const draft = readDraft(surface);
  if (editor.live()) draft.text = editor.read();
  // A refused send that could not join the editor is the page's own; it comes back with the host's restored messages, oldest first.
  const local = draft.sending
    .filter((record) => record.refused)
    .map((record) => ({
      id: record.requestId,
      text: record.text,
      delivery: record.delivery,
      attachments: record.attachments,
      origin: record.origin,
    }));
  const localIds = new Set(local.map((entry) => entry.id));
  // Offered again after a lost acknowledgment: already in the draft, so only the acknowledgment is retried.
  if (!result.restored.length && !local.length) {
    toast(result.kept.length ? "Already delivered; nothing to restore" : "No queued messages to restore");
    return 0;
  }
  // A stale response can offer what an earlier restore already put in the draft and acknowledged.
  const offered = [...local, ...result.restored.filter((entry) => !draft.done.includes(entry.id))];
  if (!offered.length) return 0;
  const again = offered.filter((entry) => draft.unacked.includes(entry.id));
  const fresh = offered.filter((entry) => !draft.unacked.includes(entry.id));
  const { take, left, attachments, origin, why } = fit(fresh, draft);
  const heldNote = left.length
    ? why === "origin"
      ? `${left.length} queued message${left.length > 1 ? "s come" : " comes"} from another origin than the editor; send the editor first. ${left.length > 1 ? "They stay" : "It stays"} queued for the next Alt+Up.`
      : `${left.length} queued message${left.length > 1 ? "s carry" : " carries"} more uploads than one message can send; send the editor first. ${left.length > 1 ? "They stay" : "It stays"} queued for the next Alt+Up.`
    : "";
  const taken = [...again, ...take];
  if (!taken.length) {
    if (heldNote) toast(heldNote);
    return 0;
  }
  const takenIds = new Set(take.map((entry) => entry.id));
  const merged = {
    ...draft,
    text: take.length ? joinText(take.map((entry) => entry.text).join("\n\n"), draft.text) : draft.text,
    attachments,
    origin: take.length ? origin : draft.origin,
    unacked: [...draft.unacked, ...take.filter((entry) => !localIds.has(entry.id)).map((entry) => entry.id)],
    // The text is in the draft now: an unknown send of the same id or a refused record is no longer a second owner of it.
    sending: draft.sending.filter((record) => !takenIds.has(record.requestId)),
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
  await acknowledgeDraft({ surface, acknowledge, ids: taken.map((entry) => entry.id).filter((id) => !localIds.has(id)) });
  return take.length;
}

/** The host forgets restored text only now that the draft holds it. A failure keeps the ids, so the next visit or Alt+Up retries. */
export async function acknowledgeDraft({ surface, acknowledge, ids = readDraft(surface).unacked }) {
  if (!ids.length) return;
  await acknowledge(ids);
  const draft = readDraft(surface);
  writeDraft(surface, { ...draft, unacked: draft.unacked.filter((id) => !ids.includes(id)), done: [...draft.done, ...ids] });
}
