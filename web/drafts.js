// The owner's unsent composer text: one draft per host, project and chat, and one per host for its Host agent. localStorage keeps it under the
// host's storage prefix (`pi-host:<id>:` for a remote host), so a reload brings it back and Forget host or a revocation removes a host's drafts.
// A tab writes only for its own owner's input; nothing here expires or evicts. localStorage has no compare-and-set, so every read-modify-write of
// one key runs inside a Web Lock named after it: tabs take turns, and a check followed by a delete cannot lose another tab's newer text.
import { toast } from "./state.js";

const MARK = "pi-draft:";
const SETTLED = "pi-send-settled:";
const SETTLED_KEEP_MS = 7 * 24 * 3600 * 1000;
/** The chat keeps one handle per pending send under this prefix until the send is settled. */
export const PENDING_PREFIX = "pi-pending-send:";

export const chatDraftKey = (prefix, projectId, chatId) => `${prefix}${MARK}${encodeURIComponent(projectId)}:${encodeURIComponent(chatId)}`;
export const hostAgentDraftKey = (prefix) => `${prefix}${MARK}host-agent`;

/** Runs `work` alone among all tabs that touch `key`. */
export function withDraft(key, work) {
  return navigator.locks ? navigator.locks.request(`pi-draft-lock:${key}`, work) : Promise.resolve().then(work);
}

const typed = new Map(); // key → the latest text this tab typed and has not written yet, with the turn that writes it
const unsaved = new Map(); // key → text the browser refused to store; this tab keeps showing it until a write or a removal of the key succeeds
let turns = 0;

/** `{ text, caret }`, or null when there is none. */
export function loadDraft(key) {
  if (typed.has(key)) {
    const { text, caret } = typed.get(key);
    return text === "" ? null : { text, caret };
  }
  return unsaved.get(key) ?? readDraft(key);
}
function readDraft(key) {
  try {
    const draft = JSON.parse(localStorage.getItem(key) ?? "null");
    return typeof draft?.text === "string" && draft.text !== ""
      ? { text: draft.text, caret: Number.isInteger(draft.caret) ? draft.caret : draft.text.length }
      : null;
  } catch {
    return null;
  }
}
export function dropDraft(key) {
  unsaved.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {}
}
/** Removes the draft only while it still holds exactly `text`: another tab may have stored a newer one since the message was sent. */
export const dropDraftIf = (key, text) =>
  withDraft(key, () => {
    if (loadDraft(key)?.text === text) dropDraft(key);
  });
/** An unconditional removal (a confirmed archive), in turn with other tabs. */
export const removeDraft = (key) => withDraft(key, () => dropDraft(key));
/** Dismiss of a refused message: takes the draft only while it is still the untouched `text`; true when it did. */
export const takeDraftIf = (key, text) =>
  withDraft(key, () => {
    if (loadDraft(key)?.text !== text) return false;
    dropDraft(key);
    return true;
  });
/** The host admitted send `id`: its draft goes if it still holds exactly `text`. A send settles once across tabs: the first caller wins, and its mark
 * outlives the pending handle, so a second tab's copy never deletes a fresh draft that happens to read the same. */
export const settleDraft = (key, id, text) =>
  withDraft(key, () => {
    try {
      if (localStorage.getItem(SETTLED + id)) return;
      localStorage.setItem(SETTLED + id, String(Date.now()));
    } catch {
      return; // without its mark, another tab's copy could settle again and delete a fresh draft
    }
    if (loadDraft(key)?.text === text) dropDraft(key);
  });
export function forgetOldSettles() {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(SETTLED) && Date.now() - Number(localStorage.getItem(key)) > SETTLED_KEEP_MS) localStorage.removeItem(key);
  } catch {}
}
/** Writes the owner's latest text of `key` in turn with other tabs. Every input queues its own turn and writes only while it is still this tab's
 * latest, so an earlier input never lands after a later one, whatever other tabs queued in between. */
export function typeDraft(key, text, caret) {
  const turn = ++turns;
  typed.set(key, { text, caret, turn });
  void withDraft(key, () => {
    const latest = typed.get(key);
    if (latest?.turn !== turn) return;
    typed.delete(key);
    saveDraft(key, latest.text, latest.caret);
  });
}
/** A text given back after a failed send joins what is already there: alone when there is nothing, else below it after a blank line. */
export const joinDraft = (current, text) => (current === "" ? text : `${current}\n\n${text}`);
/** Gives a refused `text` back to the stored draft of `key` in turn with other tabs, so a newer draft stays and the text joins it. `shown` is what
 * the sending tab's composer holds now: a stored draft that is still the sent text itself becomes exactly that. This tab's earlier inputs wrote
 * before this turn, and a later one writes after it. */
export const restoreDraft = (key, text, shown) =>
  withDraft(key, () => {
    const current = (unsaved.get(key) ?? readDraft(key))?.text ?? "";
    saveDraft(key, current === text ? shown : joinDraft(current, text));
  });
/** The older stored text is left as it was when the browser refuses the new one, and the owner is told. An empty field is no draft. */
function saveDraft(key, text, caret = text.length) {
  if (text === "") return dropDraft(key);
  try {
    localStorage.setItem(key, JSON.stringify({ text, caret }));
    unsaved.delete(key);
  } catch {
    unsaved.set(key, { text, caret });
    toast("Draft not saved: browser storage is full. The text stays in the box, but a reload would lose it.", { error: true, ms: 8000 });
  }
}
/** Forget host or a revoked device: every draft and pending-send handle one remote host left in this browser. */
export function dropHostDrafts(hostId) {
  const prefix = `pi-host:${hostId}:`;
  const ownHandle = (key) => {
    try {
      const handle = JSON.parse(localStorage.getItem(key) ?? "null");
      return handle?.hostPrefix === prefix || (typeof handle?.draftKey === "string" && handle.draftKey.startsWith(prefix));
    } catch {
      return false;
    }
  };
  // This tab's queued writes of the host find nothing left to write.
  for (const key of [...typed.keys(), ...unsaved.keys()])
    if (key.startsWith(prefix + MARK)) {
      typed.delete(key);
      unsaved.delete(key);
    }
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(prefix + MARK) || (key.startsWith(PENDING_PREFIX) && ownHandle(key))) localStorage.removeItem(key);
  } catch {}
}
