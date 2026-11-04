// Subscription limits for the status line and Settings → Providers. Manual only: `limits-snapshot` returns what the host last
// observed and never contacts a provider; only the refresh button (`limits-refresh`) does. Nothing here runs on a timer.
// Which providers the status line shows is the host's saved `limits-visibility` (Telegram /status reads it too),
// followed on host topic `limits`.
import { call } from "./api.js";
import { emit, state } from "./state.js";

// Bumped by every confirmed save, so a read that started before it cannot put the older choice back.
let saves = 0;
function apply(snapshot, savesAtStart) {
  state.limits = snapshot.providers;
  if (snapshot.visibility && savesAtStart === saves) state.limitsVisibility = snapshot.visibility;
}

export async function loadLimits() {
  const at = saves;
  const snapshot = await call("limits-snapshot").catch(() => null);
  if (!snapshot?.providers) return;
  apply(snapshot, at);
  emit("limits");
}
/** False only for a provider the owner hid; an unknown choice shows. */
export const limitShown = (provider) => state.limitsVisibility?.[provider] !== false;

/** Failed refreshes keep the numbers already shown; the reason goes to `state.limitsError`, said in place by the callers. */
export async function refreshLimits() {
  if (state.limitsRefreshing) return;
  state.limitsRefreshing = true;
  state.limitsError = null;
  emit("limits");
  const at = saves;
  try {
    const snapshot = await call("limits-refresh");
    // Providers that were never set up always have a reason; a failure is a reading that is now stale, or no reading at all.
    const stale = snapshot.providers.filter((item) => item.status === "ok" && item.reason);
    const none = !snapshot.providers.some((item) => item.status === "ok");
    state.limitsError = stale.length
      ? stale.map((item) => `${item.label}: ${item.reason}`).join("\n")
      : none
        ? snapshot.providers.map((item) => `${item.label}: ${item.reason ?? "no data"}`).join("\n")
        : null;
    apply(snapshot, at);
  } catch (error) {
    state.limitsError = error.message || "The host did not answer";
  } finally {
    state.limitsRefreshing = false;
    emit("limits");
  }
}

// Saves run one at a time in click order. `state.limitsPending` holds the choice a toggle shows until the host has answered its
// last queued save; the status line follows only `state.limitsVisibility`, the host's answer, so a failed save never shows as done.
let queue = Promise.resolve();
const queued = new Map();
export function setLimitShown(provider, visible) {
  state.limitsPending = { ...state.limitsPending, [provider]: visible };
  state.limitsVisibilityError = null;
  queued.set(provider, (queued.get(provider) ?? 0) + 1);
  emit("limits");
  queue = queue.then(async () => {
    try {
      const snapshot = await call("limits-visibility", { provider, visible });
      saves++;
      state.limits = snapshot.providers;
      state.limitsVisibility = snapshot.visibility;
    } catch (error) {
      const label = state.limits?.find((item) => item.provider === provider)?.label ?? provider;
      state.limitsVisibilityError = `${label} not saved: ${error.message || "the host did not answer"}`;
    }
    const left = queued.get(provider) - 1;
    if (left) queued.set(provider, left);
    else {
      queued.delete(provider);
      const { [provider]: _, ...rest } = state.limitsPending;
      state.limitsPending = rest;
    }
    emit("limits");
  });
  return queue;
}

/** Starts the host's Cursor sign-in and opens Cursor's page. The host says on topic `limits` when it ends; nothing polls. */
export async function connectCursor() {
  const started = await call("cursor-connect").catch((error) => ({ state: "failed", loginUrl: null, error: error.message }));
  const cursor = state.limits?.find((item) => item.provider === "cursor");
  if (cursor) cursor.connect = started;
  emit("limits");
  if (started.loginUrl) window.open(started.loginUrl, "_blank", "noopener,noreferrer");
}
