import { Type, type Static } from "typebox";

/** The host UI document (docs/ui2-contract.md): one per host, shared by every browser. */
export const UiSettings = Type.Object(
  {
    theme: Type.Union([Type.Literal("claude"), Type.Literal("midnight"), Type.Literal("light"), Type.Literal("system")]),
    animations: Type.Union([Type.Literal("off"), Type.Literal("subtle"), Type.Literal("full")]),
    hotkeys: Type.Record(Type.String({ pattern: "^[a-z][a-zA-Z0-9.-]{0,63}$" }), Type.String({ minLength: 1, maxLength: 40 }), {
      maxProperties: 200,
    }),
    panels: Type.Object({ list: Type.Boolean(), context: Type.Boolean(), hostAgent: Type.Boolean() }, { additionalProperties: false }),
    statusLine: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type UiSettings = Static<typeof UiSettings>;
export const UiPatch = Type.Partial(
  Type.Object(
    {
      theme: UiSettings.properties.theme,
      animations: UiSettings.properties.animations,
      hotkeys: UiSettings.properties.hotkeys,
      panels: Type.Partial(UiSettings.properties.panels),
      statusLine: UiSettings.properties.statusLine,
    },
    { additionalProperties: false },
  ),
);
export const DEFAULT_UI: UiSettings = {
  theme: "claude",
  animations: "subtle",
  hotkeys: {},
  panels: { list: true, context: true, hostAgent: true },
  statusLine: true,
};
