// The owner's unsent composer text: one draft per host, project and chat, and one per host for its Host agent. localStorage keeps it under the
// host's storage prefix (`pi-host:<id>:` for a remote host), so a reload brings it back and Forget host or a revocation removes a host's drafts.
// A tab writes only for its own owner's input; nothing here expires or evicts.
const MARK = "pi-draft:";

export const chatDraftKey = (prefix, projectId, chatId) => `${prefix}${MARK}${encodeURIComponent(projectId)}:${encodeURIComponent(chatId)}`;
export const hostAgentDraftKey = (prefix) => `${prefix}${MARK}host-agent`;

/** `{ text, caret }`, or null when there is none. */
export function loadDraft(key) {
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
export function dropDraftIf(key, text) {
  if (loadDraft(key)?.text === text) dropDraft(key);
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
