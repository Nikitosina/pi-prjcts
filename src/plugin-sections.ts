import type { PluginRpcKind, PluginSection, SectionLink, SectionPlace, SectionTone } from "./plugin-types.ts";

/*
 * Declarative plugin sections (scripts/plugin-sections-failures.md): the load-time check of a plugin's `sections` and the check of every view
 * a `read` returns. A view leaves the host only as the copy built here, so a field outside the schema never reaches a browser.
 */

export type SectionEntry = { plugin: string; id: string; title: string; place: SectionPlace; refreshMs: number | null };
export type SectionButtonData = { label: string; method: string; params?: unknown; confirm?: string; kind: PluginRpcKind };
export type SectionRowData = {
  label?: string;
  text: string;
  status?: { label: string; tone: SectionTone };
  detail?: string[];
  links?: SectionLink[];
  buttons?: SectionButtonData[];
};
export type SectionViewData = { rows: SectionRowData[]; empty?: string; footer?: string };

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const PLACES: readonly SectionPlace[] = ["settings", "chat"];
const TONES: readonly SectionTone[] = ["neutral", "good", "work", "needs", "bad"];
const MAX_SECTIONS = 4,
  MAX_ROWS = 50,
  MAX_PARTS = 3,
  MAX_PARAMS = 2048,
  MIN_REFRESH_MS = 2000,
  MAX_REFRESH_MS = 3_600_000;

function fail(path: string, rule: string): never {
  throw new Error(`${path} ${rule}`);
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    (values as readonly unknown[]).includes(value);
const isPlace = oneOf(PLACES),
  isTone = oneOf(TONES);

function text(value: unknown, path: string, max: number, required = false): string {
  if (typeof value !== "string") return fail(path, "must be a string");
  if (value.length > max) fail(path, `must be at most ${max} characters`);
  if (required && !value.trim()) fail(path, "must not be empty");
  return value;
}
const optionalText = (value: unknown, path: string, max: number): string | undefined =>
  value === undefined ? undefined : text(value, path, max);
function list(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) return fail(path, "must be an array");
  if (value.length > max) fail(path, `must have at most ${max} items`);
  // A sparse array would skip holes in map but reach the page as null.
  return Array.from(value);
}

/** Throws a message naming the field of the first declaration rule a plugin's `sections` breaks. */
export function checkSections(sections: unknown): void {
  if (sections === undefined) return;
  if (!isRecord(sections)) fail("sections", "must be an object of sections by id");
  const entries = Object.entries(sections as Record<string, unknown>);
  if (entries.length > MAX_SECTIONS) fail("sections", `must declare at most ${MAX_SECTIONS} sections`);
  for (const [id, section] of entries) {
    const path = `sections.${id}`;
    if (!ID.test(id)) fail(path, "must have a kebab-case id of up to 40 characters");
    if (!isRecord(section)) fail(path, "must be an object");
    const { title, place, refreshMs, read } = section as Record<string, unknown>;
    text(title, `${path}.title`, 60, true);
    if (!isPlace(place)) fail(`${path}.place`, 'must be "settings" or "chat"');
    if (
      refreshMs !== undefined &&
      (!Number.isInteger(refreshMs) || (refreshMs as number) < MIN_REFRESH_MS || (refreshMs as number) > MAX_REFRESH_MS)
    )
      fail(`${path}.refreshMs`, `must be an integer from ${MIN_REFRESH_MS} to ${MAX_REFRESH_MS}`);
    if (typeof read !== "function") fail(`${path}.read`, "must be a function");
  }
}

export const sectionEntry = (plugin: string, id: string, section: PluginSection): SectionEntry => ({
  plugin,
  id,
  title: section.title,
  place: section.place,
  refreshMs: section.refreshMs ?? null,
});

function link(value: unknown, path: string): SectionLink {
  if (!isRecord(value)) return fail(path, "must be an object");
  const url = text(value.url, `${path}.url`, 500, true);
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    /* refused below */
  }
  if (protocol !== "http:" && protocol !== "https:") fail(`${path}.url`, "must be an absolute http or https URL");
  return { label: text(value.label, `${path}.label`, 300, true), url };
}

function button(value: unknown, path: string, kindOf: (method: string, params: unknown) => PluginRpcKind | undefined): SectionButtonData {
  if (!isRecord(value)) return fail(path, "must be an object");
  const label = text(value.label, `${path}.label`, 40, true);
  const method = text(value.method, `${path}.method`, 64, true);
  let params: unknown;
  if (value.params !== undefined) {
    let json: string | undefined;
    try {
      json = JSON.stringify(value.params);
    } catch {
      /* refused below */
    }
    if (json === undefined) fail(`${path}.params`, "must be JSON");
    if (Buffer.byteLength(json) > MAX_PARAMS) fail(`${path}.params`, `must be at most ${MAX_PARAMS} bytes of JSON`);
    params = JSON.parse(json);
  }
  const kind = kindOf(method, params);
  if (!kind) fail(`${path}.method`, "must name an rpc method of this plugin with an rpcPolicy entry");
  const confirm = optionalText(value.confirm, `${path}.confirm`, 300);
  if (kind === "dangerous" && !confirm?.trim()) fail(`${path}.confirm`, "is required for a dangerous call");
  return { label, method, ...(params === undefined ? {} : { params }), ...(confirm ? { confirm } : {}), kind };
}

function row(value: unknown, path: string, kindOf: (method: string, params: unknown) => PluginRpcKind | undefined): SectionRowData {
  if (!isRecord(value)) return fail(path, "must be an object");
  const out: SectionRowData = { text: text(value.text, `${path}.text`, 500) };
  const label = optionalText(value.label, `${path}.label`, 60);
  if (label !== undefined) out.label = label;
  if (value.status !== undefined) {
    if (!isRecord(value.status)) fail(`${path}.status`, "must be an object");
    const status = value.status as Record<string, unknown>;
    const tone = status.tone ?? "neutral";
    if (!isTone(tone)) return fail(`${path}.status.tone`, `must be one of ${TONES.join(", ")}`);
    out.status = { label: text(status.label, `${path}.status.label`, 40, true), tone };
  }
  if (value.detail !== undefined)
    out.detail = list(value.detail, `${path}.detail`, MAX_PARTS).map((line, index) => text(line, `${path}.detail[${index}]`, 500));
  if (value.links !== undefined)
    out.links = list(value.links, `${path}.links`, MAX_PARTS).map((item, index) => link(item, `${path}.links[${index}]`));
  if (value.buttons !== undefined)
    out.buttons = list(value.buttons, `${path}.buttons`, MAX_PARTS).map((item, index) => button(item, `${path}.buttons[${index}]`, kindOf));
  return out;
}

/** The checked copy of a view, each button with its kind for these params; throws a message naming the first field that breaks a rule. */
export function checkView(view: unknown, kindOf: (method: string, params: unknown) => PluginRpcKind | undefined): SectionViewData {
  if (!isRecord(view)) return fail("view", "must be an object");
  const out: SectionViewData = { rows: list(view.rows, "rows", MAX_ROWS).map((item, index) => row(item, `rows[${index}]`, kindOf)) };
  const empty = optionalText(view.empty, "empty", 300),
    footer = optionalText(view.footer, "footer", 300);
  if (empty !== undefined) out.empty = empty;
  if (footer !== undefined) out.footer = footer;
  return out;
}
