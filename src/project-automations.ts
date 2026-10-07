import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { AutomationChange, parse, projectDir, saveJson } from "./state.ts";

/** Owner opt-ins for events from outside: Follow PRs and the generic webhook. Kept beside project.json (0600), read on every poll and delivery. */
export const AutomationConfig = Type.Object({
  version: Type.Literal(1),
  /** Chat that receives automation events; an archived or unknown chat falls back to Main. */
  eventChat: Type.String({ pattern: "^(main|[a-f0-9-]{36})$" }),
  follow: Type.Object({ enabled: Type.Boolean(), everyMs: Type.Integer({ minimum: 60_000, maximum: 86_400_000 }), autoFix: Type.Boolean(), fixCap: Type.Integer({ minimum: 0, maximum: 10 }) }, { additionalProperties: false }),
  webhook: Type.Object({ enabled: Type.Boolean(), secret: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
  /** Merge project-published PRs once CI (all required checks) is green and a reviewer approved the exact head. Absent (pre-feature files) means off. */
  autoMerge: Type.Optional(Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false })),
}, { additionalProperties: false });
export type AutomationConfig = Static<typeof AutomationConfig> & { autoMerge: { enabled: boolean } };

const file = (id: string) => join(projectDir(id), "automations.json");
const secret = () => randomBytes(32).toString("hex");
export function loadAutomations(id: string): AutomationConfig {
  const path = file(id);
  if (!existsSync(path)) {
    // Persisted on first read so the shown secret is stable.
    const initial: AutomationConfig = { version: 1, eventChat: "main", follow: { enabled: false, everyMs: 300_000, autoFix: true, fixCap: 3 }, webhook: { enabled: false, secret: secret() }, autoMerge: { enabled: false } };
    saveJson(path, initial);
    return initial;
  }
  const config = parse(AutomationConfig, JSON.parse(readFileSync(path, "utf8")));
  return { ...config, autoMerge: config.autoMerge ?? { enabled: false } };
}
export function updateAutomations(id: string, change: Static<typeof AutomationChange>): AutomationConfig {
  const current = loadAutomations(id);
  const next = parse(AutomationConfig, { ...current, eventChat: change.eventChat ?? current.eventChat, follow: { ...current.follow, ...change.follow }, webhook: { ...current.webhook, ...change.webhook }, autoMerge: { ...current.autoMerge, ...change.autoMerge } }) as AutomationConfig;
  saveJson(file(id), next);
  return next;
}
export function rotateWebhookSecret(id: string): AutomationConfig {
  const next = { ...loadAutomations(id) };
  next.webhook = { ...next.webhook, secret: secret() };
  saveJson(file(id), next);
  return next;
}
