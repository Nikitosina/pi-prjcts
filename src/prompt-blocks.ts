import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { DEFAULT_ROLE_PROMPTS, HOST_AGENT_PROMPT, TASK_HELPER_PROMPT } from "./role-prompts.ts";
import { estimateTokens } from "./prompt-sections.ts";
import type { Project } from "./state.ts";

/**
 * Prompt blocks: the editable behavior part of an agent's prompt, as ordered named blocks (docs/prompt-blocks.md).
 * Built-in blocks are the lines of today's role prompts; custom blocks are the owner's. Generated context (host contract,
 * repository and instance instructions, skills, memory, workspace bindings) frames the behavior and is never a block.
 */
export const PROMPT_TARGETS = ["coordinator", "worker", "taskHelper", "scout", "reviewer", "host"] as const;
export type PromptTarget = (typeof PROMPT_TARGETS)[number];
export const PROJECT_PROMPT_TARGETS = ["coordinator", "worker", "taskHelper", "scout", "reviewer"] as const;
export type ProjectPromptTarget = (typeof PROJECT_PROMPT_TARGETS)[number];
type LegacyRole = Exclude<ProjectPromptTarget, "taskHelper">;

export const PROMPT_BLOCK_LIMITS = {
  maxBlocks: 32,
  maxCustom: 16,
  maxBlockChars: 12_000,
  maxTotalChars: 24_000,
  maxNameChars: 80,
} as const;
const CUSTOM_ID = /^custom:[a-z0-9][a-z0-9-]{0,47}$/;
const LEGACY_ID = "custom:legacy";

export const PromptBlock = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64 }),
    /** Custom blocks only. */
    name: Type.Optional(Type.String({ minLength: 1, maxLength: PROMPT_BLOCK_LIMITS.maxNameChars })),
    enabled: Type.Boolean(),
    /** A custom block's text, or a built-in's edited text; an absent built-in text is its default. */
    text: Type.Optional(Type.String({ minLength: 1, maxLength: PROMPT_BLOCK_LIMITS.maxBlockChars })),
  },
  { additionalProperties: false },
);
export type PromptBlock = Static<typeof PromptBlock>;
export const PromptBlockList = Type.Array(PromptBlock, { maxItems: PROMPT_BLOCK_LIMITS.maxBlocks });
export const ProjectPromptBlocks = Type.Object(
  Object.fromEntries(PROJECT_PROMPT_TARGETS.map((target) => [target, Type.Optional(PromptBlockList)])) as Record<
    ProjectPromptTarget,
    Type.TOptional<typeof PromptBlockList>
  >,
  { additionalProperties: false },
);
export type ProjectPromptBlocks = Static<typeof ProjectPromptBlocks>;

type Builtin = { id: string; name: string; text: string };
/** Names each line of a built-in prompt; the lines joined with "\n" are the prompt, so the defaults stay byte-identical. */
const named = (text: string, names: readonly (readonly [string, string])[]): readonly Builtin[] => {
  const lines = text.split("\n");
  if (lines.length !== names.length) throw new Error(`Built-in prompt has ${lines.length} lines for ${names.length} block names`);
  return names.map(([id, name], index) => ({ id, name, text: lines[index]! }));
};
export const BUILTIN_PROMPT_BLOCKS: Record<PromptTarget, readonly Builtin[]> = {
  coordinator: named(DEFAULT_ROLE_PROMPTS.coordinator, [
    ["delivery", "Delivery and direct work"],
    ["delegation", "Delegation and workspaces"],
    ["task-helpers", "Task helper results"],
    ["reporting", "Reports to the owner"],
    ["memory", "Memory and agent lifecycle"],
  ]),
  worker: named(DEFAULT_ROLE_PROMPTS.worker, [
    ["job", "Plan and build"],
    ["proof", "Prove the candidate"],
    ["review", "Independent review"],
    ["report", "Ready report"],
  ]),
  taskHelper: named(TASK_HELPER_PROMPT, [
    ["workspace", "Prepared workspace"],
    ["handback-rules", "Return, not Ready"],
    ["handback", "Handback contents"],
    ["integration", "Coordinator owns delivery"],
  ]),
  scout: named(DEFAULT_ROLE_PROMPTS.scout, [["answer", "Read-only answers"]]),
  reviewer: named(DEFAULT_ROLE_PROMPTS.reviewer, [["review", "Findings"]]),
  host: named(HOST_AGENT_PROMPT, [
    ["identity", "Role and scope"],
    ["actions", "Actions and approvals"],
    ["reporting", "Reporting and focus"],
  ]),
};

export type ResolvedPromptBlock = {
  id: string;
  name: string;
  kind: "builtin" | "custom";
  enabled: boolean;
  text: string;
  /** A built-in's default text; null for custom blocks. */
  defaultText: string | null;
  edited: boolean;
};
export type ResolvedPromptBlocks = {
  target: PromptTarget;
  /** A saved list or a legacy override applies. */
  customized: boolean;
  /** The text comes from the retired `project.prompts[role]` override. */
  legacy: boolean;
  blocks: ResolvedPromptBlock[];
  /** The enabled blocks' text in order, one block per line: what the agent's behavior section carries. */
  text: string;
};

const refuse = (detail: string): never => {
  throw new Error(`Prompt blocks: ${detail}`);
};
const joinBlocks = (blocks: readonly ResolvedPromptBlock[]) =>
  blocks
    .filter((block) => block.enabled)
    .map((block) => block.text)
    .join("\n");

/**
 * Validates a whole ordered list for a target and drops what restates a default. Returns undefined for the default list
 * (every built-in, in order, enabled, unedited, nothing custom), so saving the defaults stores nothing.
 */
export function normalizePromptBlocks(target: PromptTarget, input: readonly PromptBlock[]): PromptBlock[] | undefined {
  const builtins = new Map(BUILTIN_PROMPT_BLOCKS[target].map((block) => [block.id, block]));
  const seen = new Set<string>();
  if (input.length > PROMPT_BLOCK_LIMITS.maxBlocks) refuse(`at most ${PROMPT_BLOCK_LIMITS.maxBlocks} blocks`);
  const list = input.map((block): PromptBlock => {
    if (seen.has(block.id)) refuse(`duplicate block id ${block.id}`);
    seen.add(block.id);
    if (block.text !== undefined && block.text.length > PROMPT_BLOCK_LIMITS.maxBlockChars)
      refuse(`block ${block.id} is over ${PROMPT_BLOCK_LIMITS.maxBlockChars} characters`);
    const builtin = builtins.get(block.id);
    if (builtin) {
      if (block.name !== undefined) refuse(`built-in block ${block.id} keeps its name`);
      return block.text === undefined || block.text === builtin.text
        ? { id: block.id, enabled: block.enabled }
        : { id: block.id, enabled: block.enabled, text: block.text };
    }
    if (!block.id.startsWith("custom:")) refuse(`unknown built-in block ${block.id} for ${target}`);
    if (!CUSTOM_ID.test(block.id)) refuse(`custom block id ${block.id} must be custom:<lowercase letters, digits and dashes>`);
    const name = block.name?.trim();
    if (!name || name.length > PROMPT_BLOCK_LIMITS.maxNameChars)
      refuse(`custom block ${block.id} needs a name of 1-${PROMPT_BLOCK_LIMITS.maxNameChars} characters`);
    if (!block.text?.trim()) refuse(`custom block ${block.id} needs text`);
    return { id: block.id, name, enabled: block.enabled, text: block.text };
  });
  const missing = [...builtins.keys()].filter((id) => !seen.has(id));
  if (missing.length) refuse(`missing built-in blocks ${missing.join(", ")}; turn a block off instead of removing it`);
  if (list.filter((block) => !builtins.has(block.id)).length > PROMPT_BLOCK_LIMITS.maxCustom)
    refuse(`at most ${PROMPT_BLOCK_LIMITS.maxCustom} custom blocks`);
  const total = resolvePromptBlocks(target, list).text.length;
  if (total > PROMPT_BLOCK_LIMITS.maxTotalChars)
    refuse(`enabled blocks total ${total} characters, over ${PROMPT_BLOCK_LIMITS.maxTotalChars}`);
  const isDefault =
    list.length === builtins.size &&
    list.every((block, index) => block.id === BUILTIN_PROMPT_BLOCKS[target][index]!.id && block.enabled && !block.text);
  return isDefault ? undefined : list;
}

/** The one resolver: a saved list, else a legacy override, else the built-ins. Tolerates lists saved by other versions. */
export function resolvePromptBlocks(target: PromptTarget, saved?: readonly PromptBlock[], legacy?: string): ResolvedPromptBlocks {
  const defaults = BUILTIN_PROMPT_BLOCKS[target];
  const builtin = (block: Builtin, enabled: boolean, text?: string): ResolvedPromptBlock => ({
    id: block.id,
    name: block.name,
    kind: "builtin",
    enabled,
    text: text ?? block.text,
    defaultText: block.text,
    edited: text !== undefined && text !== block.text,
  });
  const custom = (id: string, name: string, enabled: boolean, text: string): ResolvedPromptBlock => ({
    id,
    name,
    kind: "custom",
    enabled,
    text,
    defaultText: null,
    edited: false,
  });
  let blocks: ResolvedPromptBlock[];
  if (saved) {
    const byId = new Map(defaults.map((block) => [block.id, block]));
    const seen = new Set<string>();
    blocks = [];
    for (const block of saved) {
      if (seen.has(block.id)) continue;
      seen.add(block.id);
      const known = byId.get(block.id);
      if (known) blocks.push(builtin(known, block.enabled, block.text));
      else if (block.id.startsWith("custom:") && block.text)
        blocks.push(custom(block.id, block.name ?? block.id, block.enabled, block.text));
    }
    // A built-in added after the list was saved joins enabled, after the built-in that precedes it by default.
    defaults.forEach((block, index) => {
      if (seen.has(block.id)) return;
      const previous = defaults
        .slice(0, index)
        .reverse()
        .find((item) => seen.has(item.id));
      const at = previous ? blocks.findIndex((item) => item.id === previous.id) + 1 : 0;
      blocks.splice(at, 0, builtin(block, true));
      seen.add(block.id);
    });
  } else if (legacy !== undefined) {
    blocks = [custom(LEGACY_ID, "Earlier owner instructions", true, legacy), ...defaults.map((block) => builtin(block, false))];
  } else blocks = defaults.map((block) => builtin(block, true));
  return {
    target,
    customized: saved !== undefined || legacy !== undefined,
    legacy: !saved && legacy !== undefined,
    blocks,
    text: joinBlocks(blocks),
  };
}

type PromptConfig = Pick<Project, "prompts" | "promptBlocks">;
const legacyOverride = (project: PromptConfig, target: ProjectPromptTarget) =>
  target === "taskHelper" ? undefined : project.prompts?.[target as LegacyRole];
/** A project's behavior for one target: its saved blocks, else its legacy override, else the built-ins. */
export const projectBehavior = (project: PromptConfig, target: ProjectPromptTarget): ResolvedPromptBlocks =>
  resolvePromptBlocks(target, project.promptBlocks?.[target], legacyOverride(project, target));

/** A task helper's behavior: the owner's own worker blocks, then the helper contract blocks (the helper replaces the Job workflow). */
export function taskHelperBehavior(project: PromptConfig): string {
  const owner = projectBehavior(project, "worker")
    .blocks.filter((block) => block.kind === "custom" && block.enabled)
    .map((block) => block.text)
    .join("\n");
  return [owner ? `Owner worker instructions:\n${owner}` : "", projectBehavior(project, "taskHelper").text].filter(Boolean).join("\n\n");
}

/**
 * Behavior texts an agent prepared before frames existed could have started with: the built-ins, the legacy override, the
 * text of a kept `custom:legacy` block, or the current behavior. Used only to prove a rebuilt frame by exact equality.
 */
export function legacyBehaviors(project: PromptConfig, target: ProjectPromptTarget): string[] {
  const earlier = (role: LegacyRole) => [
    project.prompts?.[role],
    project.promptBlocks?.[role]?.find((block) => block.id === LEGACY_ID)?.text,
  ];
  const texts =
    target === "taskHelper"
      ? [
          taskHelperBehavior(project),
          ...["", ...earlier("worker")].flatMap((owner) =>
            [projectBehavior(project, "taskHelper").text, resolvePromptBlocks("taskHelper").text].map((helper) =>
              owner === undefined ? undefined : [owner ? `Owner worker instructions:\n${owner}` : "", helper].filter(Boolean).join("\n\n"),
            ),
          ),
        ]
      : [projectBehavior(project, target).text, resolvePromptBlocks(target).text, ...earlier(target)];
  return [...new Set(texts.filter((text): text is string => text !== undefined))];
}

/**
 * The frozen part of an agent's prompt around its behavior: generated context before (host contract, repository and project
 * instructions), `lead` between, then skills, authority rules and workspace bindings after. Stored per agent conversation,
 * so behavior can change on a later turn while the frame stays as the agent first got it.
 */
export type PromptFrame = { before: string; lead: string; after: string };
export const composePrompt = (frame: PromptFrame, behavior: string): string => {
  const text = behavior.trim();
  return `${frame.before}${text ? `${frame.lead}${text}` : ""}${frame.after}`;
};
/** Short, stable identity of behavior text, recorded when an agent adopts it. */
export const behaviorKey = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** When saved blocks reach running agents: coordinator chats before their next message, agents per instance (jobs-snapshot `prompt`), the Host agent from its next turn. */
export type PromptApplication = { adopts: "next-message" } | { adopts: "next-turn-per-agent" } | { adopts: "next-turn"; pending: boolean };
/** What `prompt-blocks-get` and `prompt-blocks-set` answer (docs/ui2-contract.md). */
export function promptBlocksView(input: {
  projectId: string | null;
  revision: string;
  resolved: ResolvedPromptBlocks;
  application: PromptApplication;
}) {
  const { resolved } = input;
  return {
    scope: input.projectId ? ("project" as const) : ("host" as const),
    projectId: input.projectId,
    target: resolved.target,
    revision: input.revision,
    customized: resolved.customized,
    legacy: resolved.legacy,
    blocks: resolved.blocks.map((block) => ({ ...block, tokens: estimateTokens(block.text) })),
    text: resolved.text,
    tokens: estimateTokens(resolved.text),
    limits: PROMPT_BLOCK_LIMITS,
    application: input.application,
  };
}
