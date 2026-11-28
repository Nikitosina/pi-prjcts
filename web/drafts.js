// The owner's unsent composer text: one draft per host, project and chat, and one per host for its Host agent. localStorage keeps it under the
// host's storage prefix (`pi-host:<id>:` for a remote host), so a reload brings it back and Forget host or a revocation removes a host's drafts.
// A tab writes only for its own owner's input; nothing here expires or evicts. localStorage has no compare-and-set, so every read-modify-write of
// one key runs inside a Web Lock named after it: tabs take turns, and a check followed by a delete cannot lose another tab's newer text.
// Every stored write gets its own revision. A send remembers the revision it took, and only that revision is ever settled, dismissed or replaced
// on its behalf: a newer draft of any tab, even one that reads the same, has another revision.
import { toast } from "./state.js";

const MARK = "pi-draft:";
const DROPPED = "pi-drafts-dropped:"; // + storage prefix → when Forget host or a revocation removed that host's drafts
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

/** What the composer shows for `key`: `{ text, caret }`, or null when there is none. */
export function loadDraft(key) {
  if (typed.has(key)) {
    const { text, caret } = typed.get(key);
    return text === "" ? null : { text, caret };
  }
  return unsaved.get(key) ?? readDraft(key);
}
/** The stored draft with its revision, or null. */
function readDraft(key) {
  try {
    const draft = JSON.parse(localStorage.getItem(key) ?? "null");
    return typeof draft?.text === "string" && draft.text !== ""
      ? {
          text: draft.text,
          caret: Number.isInteger(draft.caret) ? draft.caret : draft.text.length,
          rev: typeof draft.rev === "string" ? draft.rev : undefined,
        }
      : null;
  } catch {
    return null;
  }
}
function dropDraft(key) {
  unsaved.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {}
}
/** An unconditional removal (a confirmed archive), in turn with other tabs. */
export const removeDraft = (key) => withDraft(key, () => dropDraft(key));
/** The revision of the stored draft while it holds exactly `text`, after this tab's earlier inputs were written; a send keeps it. */
export const draftRevision = (key, text) =>
  withDraft(key, () => {
    const stored = readDraft(key);
    return stored?.text === text ? stored.rev : undefined;
  });
/** Removes what a send of `text` with revision `rev` left: the stored draft only while it is still that revision, and this tab's unsaved copy only
 * while it is still that text. True when anything went. */
function takeSent(key, rev, text) {
  let took = false;
  if (unsaved.get(key)?.text === text) {
    unsaved.delete(key);
    took = true;
  }
  if (rev !== undefined && readDraft(key)?.rev === rev) {
    dropDraft(key);
    took = true;
  }
  return took;
}
/** The host admitted the message: its draft goes, unless anything newer was stored since. A second tab's copy of the send finds another revision. */
export const settleDraft = (key, rev, text) => withDraft(key, () => void takeSent(key, rev, text));
/** Dismiss of a refused message: takes the draft only while it is still the untouched one; true when it did. */
export const takeDraftIf = (key, rev, text) => withDraft(key, () => takeSent(key, rev, text));
/** Writes the owner's latest text of `key` in turn with other tabs. Every input queues its own turn and writes only while it is still this tab's
 * latest, so an earlier input never lands after a later one, whatever other tabs queued in between. */
export function typeDraft(key, text, caret) {
  const turn = ++turns,
    since = Date.now();
  typed.set(key, { text, caret, turn });
  void withDraft(key, () => {
    const latest = typed.get(key);
    if (latest?.turn !== turn) return;
    typed.delete(key);
    if (!dropped(key, since)) saveDraft(key, latest.text, latest.caret);
  });
}
/** A text given back after a failed send joins what is already there: alone when there is nothing, else below it after a blank line. */
export const joinDraft = (current, text) => (current === "" ? text : `${current}\n\n${text}`);
/** Gives a refused `text` back to the stored draft of `key` in turn with other tabs. While the stored draft is still the send's revision `rev`, it
 * becomes `shown`, what the sending composer holds now; anything else stored is newer, and the text joins it. */
export function restoreDraft(key, text, rev, shown) {
  const since = Date.now();
  return withDraft(key, () => {
    if (dropped(key, since)) return;
    const stored = readDraft(key);
    saveDraft(key, rev !== undefined && stored?.rev === rev ? shown : joinDraft(stored?.text ?? "", text));
  });
}
/** The older stored text is left as it was when the browser refuses the new one, and the owner is told. An empty field is no draft. */
function saveDraft(key, text, caret = text.length) {
  if (text === "") return dropDraft(key);
  try {
    localStorage.setItem(key, JSON.stringify({ text, caret, rev: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }));
    unsaved.delete(key);
  } catch {
    unsaved.set(key, { text, caret });
    toast("Draft not saved: browser storage is full. The text stays in the box, but a reload would lose it.", { error: true, ms: 8000 });
  }
}
/** A write queued at `since` for a host whose drafts were removed after that must not bring them back, in any tab. */
function dropped(key, since) {
  if (!key.startsWith("pi-host:")) return false;
  const prefix = key.slice(0, key.indexOf(MARK));
  try {
    return Number(localStorage.getItem(DROPPED + prefix) ?? 0) >= since;
  } catch {
    return false;
  }
}
/** Forget host or a revoked device: every draft and pending-send handle one remote host left in this browser, and every write already queued for
 * them in any tab. */
export function dropHostDrafts(hostId) {
  const prefix = `pi-host:${hostId}:`;
  for (const key of [...typed.keys(), ...unsaved.keys()])
    if (key.startsWith(prefix + MARK)) {
      typed.delete(key);
      unsaved.delete(key);
    }
  const ownHandle = (key) => {
    try {
      const handle = JSON.parse(localStorage.getItem(key) ?? "null");
      return handle?.hostPrefix === prefix || (typeof handle?.draftKey === "string" && handle.draftKey.startsWith(prefix));
    } catch {
      return false;
    }
  };
  try {
    localStorage.setItem(DROPPED + prefix, String(Date.now()));
  } catch {}
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(prefix + MARK) || (key.startsWith(PENDING_PREFIX) && ownHandle(key))) localStorage.removeItem(key);
  } catch {}
}
