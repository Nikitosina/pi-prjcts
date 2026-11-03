// Bottom status line: built-in items drawn in the order and visibility of the host `ui` document's `statusItems`
// (Settings → Status line, or the Host agent's ui_set). `statusLine: false` hides the whole bar (ui.js).
import { esc, shortModel, tokens, usd } from "./format.js";
import { on, state } from "./state.js";
import { DEFAULT_UI } from "./ui.js";
import { refreshLimits } from "./limits.js";

/** Owner-facing names and one-line hints, in the built-in order; the ids are the host's fixed `statusItems` ids. */
export const STATUS_ITEMS = [
  { id: "activity", label: "Activity", hint: "idle, working, thinking, writing or compacting" },
  { id: "model", label: "Model", hint: "the coordinator's effective model" },
  { id: "thinking", label: "Thinking", hint: "the coordinator's thinking level" },
  { id: "context", label: "Context", hint: "context use of this chat, and a failed compaction" },
  { id: "cost", label: "Chat cost", hint: "coordinator cost of this chat" },
  { id: "limits", label: "Subscription limits", hint: "usage of every provider subscription that reports it" },
  { id: "spacer", label: "Spacer", hint: "pushes the items after it to the right" },
  { id: "connection", label: "Connection", hint: "connected or reconnecting to the host" },
  { id: "hints", label: "Key hints", hint: "⌘K commands, ? in settings" },
];

function activity() {
  const live = state.live;
  const status = live?.running
    ? live.compacting
      ? "compacting"
      : live.retry
        ? "retrying"
        : live.text
          ? "writing"
          : live.thinking
            ? "thinking"
            : "working"
    : "idle";
  return `<span class="sl-item" data-item="activity"><span class="sl-dot ${live?.running ? "on" : ""}" aria-hidden="true"></span>${esc(status)}</span>`;
}
function model() {
  const ref = state.profiles?.coordinator?.effectiveModel ?? state.view?.project?.model ?? "";
  return `<span class="sl-item mono" data-item="model" title="${esc(ref)}">${esc(shortModel(ref) || "–")}</span>`;
}
const thinking = () => `<span class="sl-item mono sl-think" data-item="thinking">think ${esc(state.thinking ?? "medium")}</span>`;
function context() {
  const ctx = state.view?.context;
  const pct = ctx?.window ? Math.round((100 * (ctx.tokens ?? 0)) / ctx.window) : null;
  const failed = ctx?.compactionFailure && !ctx?.compacting;
  return `<span class="sl-item mono" data-item="context" title="Context">${pct === null ? "ctx –" : `ctx ${tokens(ctx.tokens)}/${tokens(ctx.window)} <span class="sl-bar"><span style="width:${Math.min(100, pct)}%"></span></span> ${pct}%`}</span>${failed ? `<span class="sl-item mono t-needs" data-item="context" title="${esc(ctx.compactionFailure.error)}">compaction failed</span>` : ""}`;
}
function cost() {
  const total = state.usage?.coordinator?.total?.cost?.total;
  return `<span class="sl-item sl-cost mono" data-item="cost" title="Coordinator cost of this chat">${esc(Number.isFinite(total) ? usd(total) : "$–")} chat</span>`;
}
const WINDOW_WORDS = { "5h": "5-hour window", "7d": "7-day window", mo: "month" };
const REFRESH_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.4 2.2v3.2h-3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
/** Refreshing is manual only: this button is the one way the page asks the providers (web-ui2/limits.js). */
function limitsRefresh(empty) {
  const busy = state.limitsRefreshing;
  const button = `<button type="button" class="sl-refresh${busy ? " busy" : ""}" data-limits-refresh aria-label="${busy ? "Refreshing subscription limits" : "Refresh subscription limits"}" title="${busy ? "Refreshing…" : "Refresh subscription limits now"}"${busy ? ` aria-disabled="true" aria-busy="true"` : ""}>${REFRESH_ICON}${empty && !busy ? "<span>limits</span>" : ""}</button>`;
  const failed = state.limitsError
    ? `<span class="sl-item mono t-needs" data-item="limits" data-limits-error title="${esc(state.limitsError)}">refresh failed</span>`
    : "";
  return `<span class="sl-item sl-limits-refresh" data-item="limits">${button}</span>${failed}`;
}
/** Subscription usage: what it is, the period, and where it comes from, in words and a tooltip. */
function limits() {
  const shown = (state.limits ?? []).filter((item) => item.status === "ok");
  return `${shown
    .map((item) => {
      if (item.usage) {
        const { amountUsd, periodStartAt, periodEndAt, account } = item.usage;
        const days = (periodEndAt - periodStartAt) / 86400000;
        const period = days > 26 && days < 33 ? "this month" : "this period";
        const tip = `${item.label} subscription: ${usd(amountUsd)} spent ${period} (${new Date(periodStartAt).toLocaleDateString()}–${new Date(periodEndAt).toLocaleDateString()}${account ? `, ${account}` : ""}), read from ${item.label}'s usage endpoint. Not the cost of this chat.`;
        return `<span class="sl-item sl-limit mono" data-item="limits" title="${esc(tip)}">${esc(item.label)} · ${esc(usd(amountUsd))} ${period}</span>`;
      }
      const sample = [...(item.samples ?? [])].sort((a, b) => b.usedPercent - a.usedPercent)[0];
      if (!sample) return "";
      const pct = Math.round(sample.usedPercent ?? 0);
      const tip = `${item.label} subscription: ${pct}% of the ${WINDOW_WORDS[sample.window] ?? sample.window} used${sample.resetsAt ? `, resets ${new Date(sample.resetsAt).toLocaleString()}` : ""}.`;
      return `<span class="sl-item sl-limit mono" data-item="limits" title="${esc(tip)}">${esc(item.label)} ${esc(sample.window)} <span class="sl-bar ${pct >= 90 ? "hot" : ""}"><span style="width:${Math.min(100, pct)}%"></span></span> ${pct}%</span>`;
    })
    .join("")}${limitsRefresh(!shown.length)}`;
}
const spacer = () => `<span class="grow" data-item="spacer"></span>`;
const connection = () =>
  `<span class="sl-item mono ${state.connected ? "ok" : "off"}" data-item="connection">${state.connected ? "● connected" : "○ reconnecting"}</span>`;
const hints = () => `<span class="sl-item hint" data-item="hints"><kbd>⌘K</kbd> commands <kbd>?</kbd> in settings</span>`;

const RENDER = { activity, model, thinking, context, cost, limits, spacer, connection, hints };

export function paintStatusLine() {
  const items = state.ui?.statusItems ?? DEFAULT_UI.statusItems;
  const bar = document.querySelector("#statusline");
  // Repaints follow every live frame; the keyboard stays on the refresh button (aria-disabled while busy, so still focusable).
  const focused = bar.contains(document.activeElement) && document.activeElement.matches("[data-limits-refresh]");
  bar.innerHTML = items
    .filter((item) => item.enabled && RENDER[item.id])
    .map((item) => RENDER[item.id]())
    .join("");
  if (focused) bar.querySelector("[data-limits-refresh]")?.focus();
}
on("ui", paintStatusLine);
on("limits", paintStatusLine);
document.querySelector("#statusline").addEventListener("click", (event) => {
  if (event.target.closest("[data-limits-refresh]")) void refreshLimits();
});
