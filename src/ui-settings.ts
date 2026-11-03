import { Type, type Static } from "typebox";

/** The built-in status line items, in today's order. `limits` is the whole subscription-usage group; `spacer` pushes the items after it
 * to the right. */
const StatusItemId = Type.Union([
  Type.Literal("activity"),
  Type.Literal("model"),
  Type.Literal("thinking"),
  Type.Literal("context"),
  Type.Literal("cost"),
  Type.Literal("limits"),
  Type.Literal("spacer"),
  Type.Literal("connection"),
  Type.Literal("hints"),
]);
export type StatusItemId = Static<typeof StatusItemId>;
export const STATUS_ITEM_IDS = StatusItemId.anyOf.map((item) => item.const);
const StatusItem = Type.Object({ id: StatusItemId, enabled: Type.Boolean() }, { additionalProperties: false });
/** Every item exactly once, so reordering and hiding never loses one; uniqueness is checked by `checkStatusItems`. */
const StatusItems = Type.Array(StatusItem, { minItems: STATUS_ITEM_IDS.length, maxItems: STATUS_ITEM_IDS.length });

/** The host UI document (docs/ui2-contract.md): one per host, shared by every browser. */
export const UiSettings = Type.Object(
  {
    theme: Type.Union([Type.Literal("claude"), Type.Literal("midnight"), Type.Literal("light"), Type.Literal("system")]),
    font: Type.Union([Type.Literal("jetbrains-mono"), Type.Literal("system-sans"), Type.Literal("system-mono")]),
    animations: Type.Union([Type.Literal("off"), Type.Literal("subtle"), Type.Literal("full")]),
    hotkeys: Type.Record(Type.String({ pattern: "^[a-z][a-zA-Z0-9.-]{0,63}$" }), Type.String({ minLength: 1, maxLength: 40 }), {
      maxProperties: 200,
    }),
    panels: Type.Object({ list: Type.Boolean(), context: Type.Boolean(), hostAgent: Type.Boolean() }, { additionalProperties: false }),
    statusLine: Type.Boolean(),
    statusItems: StatusItems,
  },
  { additionalProperties: false },
);
export type UiSettings = Static<typeof UiSettings>;
export const UiPatch = Type.Partial(
  Type.Object(
    {
      theme: UiSettings.properties.theme,
      font: UiSettings.properties.font,
      animations: UiSettings.properties.animations,
      hotkeys: UiSettings.properties.hotkeys,
      panels: Type.Partial(UiSettings.properties.panels),
      statusLine: UiSettings.properties.statusLine,
      statusItems: Type.Array(StatusItem, { maxItems: 64 }),
    },
    { additionalProperties: false },
  ),
);
export const DEFAULT_UI: UiSettings = {
  theme: "claude",
  font: "jetbrains-mono",
  animations: "subtle",
  hotkeys: {},
  panels: { list: true, context: true, hostAgent: true },
  statusLine: true,
  statusItems: STATUS_ITEM_IDS.map((id) => ({ id, enabled: true })),
};

/** Refuses a list that names an item twice or leaves one out; the schema already refuses unknown ids. */
export function checkStatusItems(items: readonly { id: StatusItemId }[]): void {
  const seen = new Set<StatusItemId>();
  for (const { id } of items) {
    if (seen.has(id)) throw new Error(`Status line item "${id}" is listed twice`);
    seen.add(id);
  }
  const missing = STATUS_ITEM_IDS.filter((id) => !seen.has(id));
  if (missing.length)
    throw new Error(`Status line items missing: ${missing.join(", ")}; list every item once and set enabled: false to hide one`);
}
