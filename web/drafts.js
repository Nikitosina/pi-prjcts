// The owner's unsent composer text: one draft per host, project and chat, and one for each host's Host agent. localStorage keeps it under the
// host's storage prefix (`pi-host:<id>:` for a remote host), so a reload brings it back and Forget host or a revocation can remove all of a host's.
const MARK = "pi-draft:";
const LIMITS = { drafts: 60, chars: 200_000 };

export const chatDraftKey = (host, projectId, chatId) => `${host.storagePrefix}${MARK}${projectId}:${chatId}`;
export const hostAgentDraftKey = (host) => `${host.storagePrefix}${MARK}host-agent`;

/** `{ text, caret }`, or null when there is none. */
export function loadDraft(key) {
  try {
    const draft = JSON.parse(localStorage.getItem(key) ?? "null");
    return typeof draft?.text === "string" ? draft : null;
  } catch {
    return null;
  }
}
export function dropDraft(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}
/** Removes the draft only while it still holds `text`: another tab may have written a newer one since it was sent. */
export function dropDraftIf(key, text) {
  if (loadDraft(key)?.text.trim() === text.trim()) dropDraft(key);
}
/** An empty draft is not stored. Over the limits the oldest drafts go first. */
export function saveDraft(key, text, caret = text.length) {
  if (!text.trim()) return dropDraft(key);
  try {
    localStorage.setItem(key, JSON.stringify({ text, caret, at: Date.now() }));
    const all = [];
    for (let index = 0; index < localStorage.length; index++) {
      const other = localStorage.key(index);
      if (!other?.includes(MARK)) continue;
      const draft = loadDraft(other);
      all.push({ key: other, at: draft?.at ?? 0, size: draft?.text.length ?? 0 });
    }
    all.sort((a, b) => a.at - b.at);
    let chars = all.reduce((sum, item) => sum + item.size, 0),
      count = all.length;
    for (const old of all) {
      if (count <= LIMITS.drafts && chars <= LIMITS.chars) break;
      if (old.key === key) continue;
      dropDraft(old.key);
      count--;
      chars -= old.size;
    }
  } catch {}
}
/** Everything one remote host left in this browser's local storage: its drafts, saved view state and prompt drafts. */
export function dropHostStorage(hostId) {
  try {
    const prefix = `pi-host:${hostId}:`;
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
  } catch {}
}
