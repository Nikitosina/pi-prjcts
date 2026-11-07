// Disk use per active project, opened by pressing the free-disk readout in the status line. Sizes come from `storage-summary`
// (the host reuses totals for 10 minutes); a project opens its Settings → Storage. Escape or a press elsewhere closes it.
import { call } from "./api.js";
import { ago, esc, size } from "./format.js";
import { emit } from "./state.js";

const pop = Object.assign(document.createElement("div"), { id: "disk-detail", hidden: true });
pop.setAttribute("role", "group");
pop.setAttribute("aria-label", "Disk use by project");
document.body.append(pop);
let summary = null,
  loading = false,
  failed = "",
  free = null;

const anchor = () => document.querySelector("#statusline [data-disk-detail]");
export const diskDetailOpen = () => !pop.hidden;

function projectRow(item) {
  if ("error" in item)
    return `<button type="button" class="dd-row" data-storage-project="${esc(item.id)}"><span>${esc(item.name)}</span><span class="dd-error">unknown</span><small>${esc(item.error)}</small></button>`;
  const facts = [
    item.reclaimableBytes ? `cleanup frees ${size(item.reclaimableBytes)}` : "",
    item.unknown ? `${item.unknown} not measured` : "",
  ].filter(Boolean);
  return `<button type="button" class="dd-row" data-storage-project="${esc(item.id)}"><span>${esc(item.name)}</span><span class="mono">${esc(size(item.bytes))}</span>${facts.length ? `<small>${esc(facts.join(" · "))}</small>` : ""}</button>`;
}
function html() {
  const head = `<b>${free === null ? "Disk" : `${Math.round(free)} GB free`}</b><p class="muted">Kept by projects on this host. Pick one to see its Storage.</p>`;
  if (!summary) return `${head}<p class="muted">${loading ? "Measuring… this can take a minute." : esc(failed || "No data yet")}</p>`;
  const rows = [...summary.projects].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  const oldest = Math.min(...rows.filter((item) => item.measuredAt).map((item) => item.measuredAt));
  const total = rows.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  const when = Number.isFinite(oldest) ? (ago(oldest) === "now" ? "measured just now" : `measured ${ago(oldest)} ago`) : "";
  return `${head}${rows.length ? rows.map(projectRow).join("") : `<p class="muted">No active projects.</p>`}<p class="dd-foot muted">${rows.length ? `${esc(size(total))} in all · ` : ""}${esc(when)} <button type="button" class="link-btn" data-disk-measure ${loading ? "disabled" : ""}>${loading ? "Measuring…" : "Measure again"}</button>${failed ? ` <span class="dd-error">${esc(failed)}</span>` : ""}</p>`;
}
function draw() {
  const at = anchor();
  at?.setAttribute("aria-expanded", String(!pop.hidden));
  if (pop.hidden) return;
  if (!at) return closeDiskDetail();
  pop.innerHTML = html();
  // Above the readout, inside the screen.
  const margin = 8,
    box = at.getBoundingClientRect();
  pop.style.maxWidth = `${Math.min(380, innerWidth - 2 * margin)}px`;
  pop.style.maxHeight = `${Math.max(80, box.top - 6 - margin)}px`;
  pop.style.bottom = `${innerHeight - box.top + 6}px`;
  pop.style.left = `${Math.max(margin, Math.min(box.right - pop.offsetWidth, innerWidth - pop.offsetWidth - margin))}px`;
}
async function load(fresh) {
  loading = true;
  failed = "";
  draw();
  try {
    summary = await call("storage-summary", fresh ? { fresh: true } : {});
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
  } finally {
    loading = false;
    draw();
  }
}
/** The status line repainted: keep the open popup on its (new) readout and refresh the free-space heading. */
export function drawDiskDetail(freeGb) {
  free = freeGb;
  draw();
}
export function closeDiskDetail() {
  if (pop.hidden) return;
  pop.hidden = true;
  draw();
}
function toggle() {
  if (!pop.hidden) return closeDiskDetail();
  pop.hidden = false;
  draw();
  if (!loading) void load(false);
}

document.querySelector("#statusline").addEventListener("click", (event) => {
  if (event.target.closest("[data-disk-detail]")) toggle();
});
pop.addEventListener("click", (event) => {
  if (event.target.closest("[data-disk-measure]")) return void load(true);
  const project = event.target.closest("[data-storage-project]");
  if (!project) return;
  closeDiskDetail();
  emit("select-request", { projectId: project.dataset.storageProject, chatId: "main", keepFocus: true });
  emit("open-settings", "storage");
});
document.addEventListener("pointerdown", (event) => {
  if (!pop.hidden && !pop.contains(event.target) && !event.target.closest?.("[data-disk-detail]")) closeDiskDetail();
});
addEventListener("resize", draw);
