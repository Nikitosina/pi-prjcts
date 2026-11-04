// One provider's subscription details, opened from its status line item by hover, keyboard focus or a tap (a tap or Enter pins
// it until a second press, Escape or a press elsewhere). Drawn from the readings already in `state.limits`: opening it asks the
// host nothing and nothing here runs on a timer. A single popup outside the bar, so the bar's sideways scroll cannot cut it.
import { ago, dur, esc, usd } from "./format.js";
import { state } from "./state.js";

const WINDOW_WORDS = { "5h": "5-hour window", "7d": "7-day window", mo: "month" };
const pop = Object.assign(document.createElement("div"), { id: "limit-detail", hidden: true });
pop.setAttribute("role", "group");
document.body.append(pop);
let open = null; // { provider, pinned }

const read = (at) => {
  const age = ago(at);
  return age === "now" ? "read just now" : age ? `read ${age} ago` : "";
};
// Windows run for hours to a month: days past two of them.
const span = (ms) => (ms < 48 * 3600e3 ? dur(ms) : `${Math.floor(ms / 86400e3)}d ${Math.floor((ms % 86400e3) / 3600e3)}h`);
const until = (at) => (at <= Date.now() ? "reset passed" : `resets in ${span(at - Date.now())}`);
const when = (at) => new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
function windowRow(sample) {
  const stale = sample.resetsAt !== null && sample.resetsAt <= Date.now(),
    pct = Math.round(sample.usedPercent ?? 0);
  const reset = sample.resetsAt === null ? "reset time unknown" : `${until(sample.resetsAt)} · ${when(sample.resetsAt)}`;
  const facts = [
    WINDOW_WORDS[sample.window] ?? sample.window,
    reset,
    stale ? "the reading is from before the reset" : "",
    `${read(sample.observedAt)} via ${sample.source === "headers" ? "response headers" : "usage endpoint"}`,
  ].filter(Boolean);
  return `<div class="ld-row"><span class="mono">${esc(sample.window)}</span><span class="sl-bar ${pct >= 90 ? "hot" : ""}"><span style="width:${Math.min(100, pct)}%"></span></span><span class="mono">${stale ? "—" : `${pct}% used`}</span><small>${esc(facts.join(" · "))}</small></div>`;
}
function costRows(usage) {
  const stale = usage.periodEndAt <= Date.now();
  const month = new Date(usage.periodStartAt).toLocaleString([], { month: "long", year: "numeric", timeZone: "UTC" });
  return `<div class="ld-row"><span class="mono">${esc(usd(usage.amountUsd))}</span><span>${stale ? "previous period" : "month to date"}</span><small>${esc(
    [
      `${month} · all usage`,
      `account ${usage.account}${usage.pool ? ` · pool ${usage.pool}` : ""}`,
      `${until(usage.periodEndAt)} at 00:00 UTC`,
      read(usage.observedAt),
    ]
      .filter(Boolean)
      .join(" · "),
  )}</small></div>`;
}
/** What the retired classic inbox's popup said: each window's use and reset, the reading's age and source, the cost, and failures. */
function detailHtml(item) {
  const has = item.samples?.length || item.usage;
  const rows = item.usage ? costRows(item.usage) : (item.samples ?? []).map(windowRow).join("");
  const tried = item.lastAttemptAt ? ` · ${read(item.lastAttemptAt).replace("read", "tried")}` : "";
  const note = has
    ? item.reason
      ? `<p class="ld-error">Last refresh failed: ${esc(item.reason)}${esc(tried)}</p>`
      : ""
    : `<p class="muted">${item.status === "unavailable" ? "Not connected" : "No data yet"}${item.reason ? `: ${esc(item.reason)}` : ""}${esc(tried)}</p>`;
  return `<b>${esc(item.label)} subscription</b>${rows}${note}<p class="ld-foot muted">Not the cost of this chat. Changes only when you refresh.</p>`;
}

/** Status line item name: the provider and its numbers, for screen readers. */
export function limitSummary(item) {
  if (item.usage) return `${item.label}: ${usd(item.usage.amountUsd)} this period, details`;
  const windows = (item.samples ?? []).map((sample) => `${sample.window} ${Math.round(sample.usedPercent ?? 0)}% used`);
  return `${item.label}: ${windows.join(", ") || "no data"}, details`;
}
export const limitDetailFor = () => open?.provider ?? null;
export const limitDetailOpen = () => !!open;

const anchor = () => open && document.querySelector(`#statusline [data-limit-item="${CSS.escape(open.provider)}"]`);
/** Redraws after the status line repaints or the readings change; a provider that left the bar (hidden, no reading) closes. */
export function drawLimitDetail() {
  const item = open && state.limits?.find((entry) => entry.provider === open.provider),
    at = item && anchor();
  if (!at) open = null;
  for (const button of document.querySelectorAll("#statusline [data-limit-item]"))
    button.setAttribute("aria-expanded", String(button.dataset.limitItem === open?.provider));
  pop.hidden = !open;
  if (!open) return;
  pop.innerHTML = detailHtml(item);
  pop.setAttribute("aria-label", `${item.label} details`);
  // Above the item, inside the screen: as wide as fits, as tall as the room above the item.
  const margin = 8,
    box = at.getBoundingClientRect();
  pop.style.maxWidth = `${Math.min(380, innerWidth - 2 * margin)}px`;
  pop.style.maxHeight = `${Math.max(80, box.top - 6 - margin)}px`;
  pop.style.bottom = `${innerHeight - box.top + 6}px`;
  pop.style.left = `${Math.max(margin, Math.min(box.left, innerWidth - pop.offsetWidth - margin))}px`;
}
function show(provider, pinned) {
  open = { provider, pinned };
  drawLimitDetail();
}
/** Escape (app.js leaveTop) and every other close; the keyboard stays where it is. */
export function closeLimitDetail() {
  if (!open) return;
  open = null;
  drawLimitDetail();
}

const bar = document.querySelector("#statusline");
const itemOf = (node) => node?.closest?.("[data-limit-item]");
bar.addEventListener("mouseover", (event) => {
  const item = itemOf(event.target);
  if (item && !open?.pinned) show(item.dataset.limitItem, false);
});
bar.addEventListener("mouseout", (event) => {
  const item = itemOf(event.target);
  if (!item || item.contains(event.relatedTarget) || open?.pinned || document.activeElement === item) return;
  closeLimitDetail();
});
bar.addEventListener("focusin", (event) => {
  const item = itemOf(event.target);
  if (item && open?.provider !== item.dataset.limitItem) show(item.dataset.limitItem, false);
});
// A repaint replaces the focused item and focuses its successor in the same task, so look once that has settled.
bar.addEventListener("focusout", () =>
  queueMicrotask(() => {
    if (open && !itemOf(document.activeElement)) closeLimitDetail();
  }),
);
bar.addEventListener("click", (event) => {
  const item = itemOf(event.target);
  if (!item) return;
  const provider = item.dataset.limitItem;
  if (open?.provider === provider && open.pinned) closeLimitDetail();
  else show(provider, true);
});
document.addEventListener("pointerdown", (event) => {
  if (open && !itemOf(event.target) && !pop.contains(event.target)) closeLimitDetail();
});
addEventListener("resize", () => open && drawLimitDetail());
