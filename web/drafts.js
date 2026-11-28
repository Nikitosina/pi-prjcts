// The owner's unsent composer text: one draft per host, project and chat, and one per host for its Host agent. localStorage keeps it under the
// host's storage prefix (`pi-host:<id>:` for a remote host), so a reload brings it back and Forget host or a revocation removes a host's drafts.
// A tab writes only for its own owner's input; nothing here expires or evicts. localStorage has no compare-and-set, so every read-modify-write of
// one key runs inside a Web Lock named after it: tabs take turns, and a check followed by a delete cannot lose another tab's newer text.
const MARK = "pi-draft:";
const SETTLED = "pi-send-settled:";
const SETTLED_KEEP_MS = 7 * 24 * 3600 * 1000;

export const chatDraftKey = (prefix, projectId, chatId) => `${prefix}${MARK}${encodeURIComponent(projectId)}:${encodeURIComponent(chatId)}`;
export const hostAgentDraftKey = (prefix) => `${prefix}${MARK}host-agent`;
/** Where a refused Host agent text lives until Retry or Dismiss: the Host agent has no bubble, and its draft may already hold newer text. */
export const hostAgentRefusedKey = (prefix) => `${prefix}${MARK}host-agent-refused`;

/** Runs `work` alone among all tabs that touch `key`. */
export function withDraft(key, work) {
  return navigator.locks ? navigator.locks.request(`pi-draft-lock:${key}`, work) : Promise.resolve().then(work);
}

const typed = new Map(); // key → the latest text this tab typed and has not written yet
const queued = new Set();

/** `{ text, caret }`, or null when there is none. */
export function loadDraft(key) {
  if (typed.has(key)) {
    const { text, caret } = typed.get(key);
    return text === "" ? null : { text, caret };
  }
  return readDraft(key);
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
    } catch {}
    if (loadDraft(key)?.text === text) dropDraft(key);
  });
export function forgetOldSettles() {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(SETTLED) && Date.now() - Number(localStorage.getItem(key)) > SETTLED_KEEP_MS) localStorage.removeItem(key);
  } catch {}
}
/** Writes the owner's latest text of `key` in turn with other tabs. An earlier input still waiting for the lock is overtaken by a later one, never the other
 * way round. `done(false)` when the browser refused to keep it. */
export function typeDraft(key, text, caret, done) {
  typed.set(key, { text, caret });
  if (queued.has(key)) return;
  queued.add(key);
  void withDraft(key, () => {
    queued.delete(key);
    const latest = typed.get(key);
    typed.delete(key);
    if (latest) done(saveDraft(key, latest.text, latest.caret));
  });
}
/** False when the browser refused to keep the text; the older stored text is then left as it was. An empty field is no draft. */
export function saveDraft(key, text, caret = text.length) {
  if (text === "") {
    dropDraft(key);
    return true;
  }
  try {
    localStorage.setItem(key, JSON.stringify({ text, caret }));
    return true;
  } catch {
    return false;
  }
}
/** Forget host or a revoked device: every draft one remote host left in this browser. */
export function dropHostDrafts(hostId) {
  try {
    const prefix = `pi-host:${hostId}:${MARK}`;
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
  } catch {}
}
