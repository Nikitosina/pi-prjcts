// Subscription limits for the status line and Settings → Providers. Manual only: `limits-snapshot` returns what the host last
// observed and never contacts a provider; only the refresh button (`limits-refresh`) does. Nothing here runs on a timer.
import { call } from "./api.js";
import { emit, state } from "./state.js";

export async function loadLimits() {
  const snapshot = await call("limits-snapshot").catch(() => null);
  if (!snapshot?.providers) return;
  state.limits = snapshot.providers;
  emit("limits");
}
/** Failed refreshes keep the numbers already shown; the reason goes to `state.limitsError`, said in place by the callers. */
export async function refreshLimits() {
  if (state.limitsRefreshing) return;
  state.limitsRefreshing = true;
  state.limitsError = null;
  emit("limits");
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
    state.limits = snapshot.providers;
  } catch (error) {
    state.limitsError = error.message || "The host did not answer";
  } finally {
    state.limitsRefreshing = false;
    emit("limits");
  }
}
