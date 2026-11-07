// Bottom status line: built-in items drawn in the order and visibility of the host `ui` document's `statusItems`
// (Settings → Status line, or the Host agent's ui_set). `statusLine: false` hides the whole bar (ui.js).
import { call } from "./api.js";
import { esc, shortModel, tokens, usd } from "./format.js";
import { on, state } from "./state.js";
import { DEFAULT_UI } from "./ui.js";
import { limitShown, refreshLimits } from "./limits.js";
import { drawLimitDetail, limitDetailFor, limitSummary } from "./limit-detail.js";
import { drawDiskDetail } from "./disk-detail.js";

/** Owner-facing names and one-line hints, in the built-in order; the ids are the host's fixed `statusItems` ids. */
export const STATUS_ITEMS = [
  { id: "activity", label: "Activity", hint: "idle, working, thinking, writing or compacting" },
  { id: "model", label: "Model", hint: "the coordinator's effective model" },
  { id: "thinking", label: "Thinking", hint: "the coordinator's thinking level" },
  { id: "context", label: "Context", hint: "context use of this chat, and a failed compaction" },
  { id: "cost", label: "Chat cost", hint: "coordinator cost of this chat" },
  { id: "limits", label: "Subscription limits", hint: "usage of every provider subscription that reports it" },
  { id: "spacer", label: "Spacer", hint: "pushes the items after it to the right" },
  { id: "machine", label: "Machine", hint: "memory, CPU, free disk and battery of the host machine" },
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
    : (state.liveHeld ?? "idle"); // the run ended but its last step is not in the transcript yet (chat.js `held`)
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
const REFRESH_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.4 2.2v3.2h-3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
/** Refreshing is manual only: this button is the one way the page asks the providers (web/limits.js). */
function limitsRefresh(empty) {
  const busy = state.limitsRefreshing;
  const button = `<button type="button" class="sl-refresh${busy ? " busy" : ""}" data-limits-refresh aria-label="${busy ? "Refreshing subscription limits" : "Refresh subscription limits"}" title="${busy ? "Refreshing…" : "Refresh subscription limits now"}"${busy ? ` aria-disabled="true" aria-busy="true"` : ""}>${REFRESH_ICON}${empty && !busy ? "<span>limits</span>" : ""}</button>`;
  const failed = state.limitsError
    ? `<span class="sl-item mono t-needs" data-item="limits" data-limits-error title="${esc(state.limitsError)}">refresh failed</span>`
    : "";
  return `<span class="sl-item sl-limits-refresh" data-item="limits">${button}</span>${failed}`;
}
/** Subscription usage, one button per shown provider: hover, focus or a tap opens its details (web/limit-detail.js). Hidden
 * providers (Settings → Providers) leave only the refresh button, which stays even when every provider is hidden. */
function limits() {
  const shown = (state.limits ?? []).filter((item) => item.status === "ok" && limitShown(item.provider));
  const item = (provider, body) =>
    `<button type="button" class="sl-item sl-limit mono" data-item="limits" data-limit-item="${esc(provider.provider)}" aria-controls="limit-detail" aria-expanded="${limitDetailFor() === provider.provider}" aria-label="${esc(limitSummary(provider))}">${body}</button>`;
  return `${shown
    .map((provider) => {
      if (provider.usage) {
        const { amountUsd, periodStartAt, periodEndAt } = provider.usage;
        const days = (periodEndAt - periodStartAt) / 86400000;
        return item(provider, `${esc(provider.label)} · ${esc(usd(amountUsd))} ${days > 26 && days < 33 ? "this month" : "this period"}`);
      }
      const sample = [...(provider.samples ?? [])].sort((a, b) => b.usedPercent - a.usedPercent)[0];
      if (!sample) return "";
      const pct = Math.round(sample.usedPercent ?? 0);
      return item(
        provider,
        `${esc(provider.label)} ${esc(sample.window)} <span class="sl-bar ${pct >= 90 ? "hot" : ""}"><span style="width:${Math.min(100, pct)}%"></span></span> ${pct}%`,
      );
    })
    .join("")}${limitsRefresh(!shown.length)}`;
}
const spacer = () => `<span class="grow" data-item="spacer"></span>`;
// Machine readout (host-sampled, cached ~5 s there), polled every 10 s while the tab is visible. Its values fill a fixed container, so a
// CPU tick never rebuilds the rest of the bar. A null value is unreadable (–); a missing one does not exist on this machine.
const LOW_DISK_GB = 50;
let machineStatus = null;
const machine = () => `<span class="sl-item sl-machine mono" data-item="machine" role="group" aria-label="Machine status"></span>`;
function machineHtml() {
  const m = machineStatus;
  if (!m) return "";
  const pct = (value) => (typeof value === "number" ? `${value}%` : "–");
  const items = [];
  if ("ram" in m) items.push(["ram", m.ram ? `mem ${m.ram.usedGb}/${m.ram.totalGb} GB` : "mem –", "Memory in use / total"]);
  if ("cpu" in m) items.push(["cpu", `cpu ${pct(m.cpu)}`, "CPU usage across all cores"]);
  if ("ssdFreeGb" in m || "ssd" in m) {
    const free = typeof m.ssdFreeGb === "number" ? m.ssdFreeGb : null;
    const low = free !== null && free < LOW_DISK_GB;
    items.push([
      "ssd",
      free === null ? `disk ${pct(m.ssd)}` : `${Math.round(free)} GB free`,
      `Disk: ${pct(m.ssd)} used${low ? `, less than ${LOW_DISK_GB} GB free` : ""}. Press for use by project`,
      low,
      true,
    ]);
  }
  if ("battery" in m) items.push(["battery", `bat ${pct(m.battery)}`, "Battery charge"]);
  return items
    .map(([kind, text, what, low, detail]) =>
      detail
        ? `<button type="button" class="sl-mach sl-disk${low ? " t-needs" : ""}" data-kind="${kind}" data-disk-detail aria-controls="disk-detail" aria-expanded="false" title="${esc(what)}" aria-label="${esc(`${what}: ${text}`)}">${esc(text)}</button>`
        : `<span class="sl-mach${low ? " t-needs" : ""}" data-kind="${kind}" title="${esc(what)}" aria-label="${esc(`${what}: ${text}`)}">${esc(text)}</span>`,
    )
    .join("");
}
function fillMachine() {
  const slot = document.querySelector('#statusline [data-item="machine"]');
  const html = machineHtml();
  if (slot && slot.dataset.html !== html) {
    slot.innerHTML = html;
    slot.dataset.html = html;
  }
  drawDiskDetail(typeof machineStatus?.ssdFreeGb === "number" ? machineStatus.ssdFreeGb : null);
}
async function loadMachine() {
  if (document.hidden) return;
  const loaded = await call("machine-status").catch(() => null);
  if (loaded && typeof loaded === "object") {
    machineStatus = loaded;
    fillMachine();
  }
}
const connection = () =>
  `<span class="sl-item mono ${state.connected ? "ok" : "off"}" data-item="connection">${state.connected ? "● connected" : "○ reconnecting"}</span>`;
const hints = () => `<span class="sl-item hint" data-item="hints"><kbd>⌘K</kbd> commands <kbd>?</kbd> in settings</span>`;

const RENDER = { activity, model, thinking, context, cost, limits, spacer, machine, connection, hints };

export function paintStatusLine() {
  const items = state.ui?.statusItems ?? DEFAULT_UI.statusItems;
  const bar = document.querySelector("#statusline");
  // Repaints follow every live frame; the keyboard stays on the refresh button (aria-disabled while busy, so still focusable)
  // or on the provider it was on.
  const active = bar.contains(document.activeElement) ? document.activeElement : null;
  const focus = active?.matches("[data-limits-refresh]")
    ? "[data-limits-refresh]"
    : active?.dataset.limitItem
      ? `[data-limit-item="${CSS.escape(active.dataset.limitItem)}"]`
      : null;
  const html = items
    .filter((item) => item.enabled && RENDER[item.id])
    .map((item) => RENDER[item.id]())
    .join("");
  if (bar.dataset.html !== html) {
    bar.innerHTML = html;
    bar.dataset.html = html;
    if (focus) bar.querySelector(focus)?.focus();
  }
  fillMachine();
  drawLimitDetail();
}
on("ui", paintStatusLine);
on("limits", paintStatusLine);
document.querySelector("#statusline").addEventListener("click", (event) => {
  if (event.target.closest("[data-limits-refresh]")) void refreshLimits();
});
setInterval(() => void loadMachine(), 10_000);
document.addEventListener("visibilitychange", () => void loadMachine());
void loadMachine();
