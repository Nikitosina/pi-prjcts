import { createHash } from "node:crypto";
import type { SectionRow, SectionTone, SectionView } from "../../src/plugin-types.ts";
import type { createSimulators } from "./simulator.ts";

type Snapshot = Awaited<ReturnType<ReturnType<typeof createSimulators>["snapshot"]>>;
/** Request ids for one view's buttons; equal while nothing changed, so an unchanged state draws the same view. */
export type RequestIds = (key: string) => string;

/** Ids derived from `seed` (per host start, project and change counter) and the button's target. */
export function requestIds(seed: string): RequestIds {
  return (key) => {
    const hex = createHash("sha256").update(`${seed}\0${key}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };
}

const clip = (text: string) => (text.length > 500 ? `${text.slice(0, 499)}…` : text);
const STATUS: Record<Snapshot["status"], { label: string; tone: SectionTone }> = {
  uncertain: { label: "Needs inspection", tone: "bad" },
  creating: { label: "Creating", tone: "work" },
  preparing: { label: "Preparing", tone: "work" },
  working: { label: "Working", tone: "work" },
  error: { label: "Error", tone: "bad" },
  ready: { label: "Ready", tone: "good" },
  none: { label: "No simulator", tone: "neutral" },
};
const STATE: Record<string, { label: string; tone: SectionTone }> = {
  Booted: { label: "Running", tone: "good" },
  Shutdown: { label: "Shut down", tone: "neutral" },
  Unknown: { label: "Unknown", tone: "bad" },
};

/** The simulator section in Settings → Plugins: management on or off, the owned clones and the acknowledgement of an unknown outcome. */
export function simulatorView(projectId: string, s: Snapshot, id: RequestIds): SectionView {
  const busy = !!s.operation || s.status === "uncertain";
  const management: SectionRow = {
    label: "Management",
    text: s.enabled
      ? `On. Agents create, boot, shut down, reset and delete up to ${s.maxOwned} clones for this project.`
      : "Off. Agents cannot create or manage simulators for this project.",
    status: s.enabled ? STATUS[s.status] : { label: "Off", tone: "neutral" },
  };
  if (!busy)
    management.buttons = [
      s.enabled
        ? {
            label: "Turn off",
            method: "configure",
            params: { enabled: false, requestId: id("enabled:false") },
            confirm:
              "Turn off simulator management for this project? Agents can no longer create, boot or delete its simulators. Owned clones and their data are kept; no device is deleted.",
          }
        : { label: "Turn on", method: "configure", params: { enabled: true, requestId: id("enabled:true") } },
    ];
  const rows: SectionRow[] = [management];
  if (s.status === "uncertain")
    rows.push({
      label: "Unknown outcome",
      text: clip(s.error ?? "The simulator operation has an unknown outcome."),
      status: STATUS.uncertain,
      detail: [
        "Inspect the simulator list and any remaining clone outside pi-prjcts before acknowledging.",
        "Agents cannot acknowledge unknown outcomes.",
      ],
      buttons: [
        {
          label: "I inspected; acknowledge",
          method: "recover",
          params: { confirm: projectId, requestId: id("recover") },
          confirm:
            "Acknowledge the unknown outcome? It never retries the operation or adopts an unknown simulator. A matching recorded clone is kept; missing or changed ownership is released, and the previous receipt is saved for inspection. An unrecorded clone may remain on disk and need manual cleanup.",
        },
      ],
    });
  else if (s.error) rows.push({ label: "Error", text: clip(s.error), status: { label: "error", tone: "bad" } });
  const sourceName = (udid: string) => s.sources.find((source) => source.udid === udid)?.name;
  const nameOf = (device: Snapshot["devices"][number]) => sourceName(device.sourceUdid) ?? device.name.replace(/^pi-projects \S+ /, "");
  for (const device of s.devices) {
    const same = s.devices.filter((other) => nameOf(other) === nameOf(device));
    rows.push({
      label: "Clone",
      text: clip(same.length > 1 ? `${nameOf(device)} ${same.indexOf(device) + 1}` : nameOf(device)),
      status: STATE[device.state] ?? { label: clip(device.state).slice(0, 40) || "Unknown", tone: "work" },
      detail: [
        device.lease ? `In use by ${device.lease.threadId}` : "Not in use",
        clip(`${device.osVersion ? `iOS ${device.osVersion} · ` : ""}${device.udid}`),
        ...(device.problem ? [clip(device.problem)] : []),
      ],
    });
  }
  return { rows };
}

/** The simslim categories a project keeps enabled; agents have no tool for them, so this section is the owner's only control. */
export function slimmingView(s: Snapshot, id: RequestIds): SectionView {
  const busy = !!s.operation || s.status === "uncertain";
  const kept = new Set<string>(s.keepCategories);
  const rows = s.categories.map((category): SectionRow => {
    const keep = kept.has(category);
    const next = s.categories.filter((item) => (item === category ? !keep : kept.has(item)));
    return {
      text: category,
      status: keep ? { label: "Kept", tone: "good" } : { label: "Slimmed", tone: "neutral" },
      ...(busy
        ? {}
        : {
            buttons: [
              {
                label: keep ? "Slim" : "Keep",
                method: "configure",
                params: { keepCategories: next, requestId: id(`keep:${next.join()}`) },
              },
            ],
          }),
    };
  });
  return {
    rows,
    footer: "Kept services stay enabled on the next create, boot or reset, not on running clones. Needs simslim 0.15.0 or later.",
  };
}
