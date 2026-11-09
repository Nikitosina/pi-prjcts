import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, type AgentChange, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type, type Static } from "typebox";
import { liveModelRuntime } from "./live-models.ts";
import { durableGuardedStream } from "./model-guard.ts";
import { liveFrame, type DurableLiveFrame } from "./durable-runtime.ts";
import { readTranscriptPage, storageSource, type TranscriptPage } from "./transcript-reader.ts";
import { normalizePromptBlocks, PromptBlockList, resolvePromptBlocks, type PromptBlock } from "./prompt-blocks.ts";
import { configureWhenIdle } from "./durable-idle-configure.ts";
import { agentActions, hostAgentTools, type HostToolDeps } from "./host-agent-tools.ts";
import { HostAgentSettingsPatch, ThinkingLevel, errorText, home, listProjects, parse, saveJson } from "./state.ts";
import type { FeedEvent } from "./change-feed.ts";
import { readTiers } from "./host-documents.ts";

const context = BACKGROUND_CONTEXT;
const EXTENSION = "projects.host-agent";

const Settings = Type.Object({
  revision: Type.Integer({ minimum: 0 }),
  model: Type.Optional(Type.String()),
  tier: Type.Optional(Type.String()),
  thinking: ThinkingLevel,
  disabledTools: Type.Array(Type.String()),
  /** The Host agent's own behavior blocks; absent = the built-in prompt. */
  promptBlocks: Type.Optional(PromptBlockList),
});
type Settings = Static<typeof Settings>;
export type HostAgentSettingsView = {
  revision: number;
  tier: string | null;
  model: string | null;
  thinking: Settings["thinking"];
  disabledTools: string[];
  /** The model the next turn uses, or null when none is set and no project names one. */
  effectiveModel: string | null;
  tools: { name: string; description: string; dangerous: boolean }[];
  /** Host actions behind host_call; dangerous ones become owner approvals. */
  actions: { name: string; description: string; dangerous: boolean }[];
};

export type HostAgentPrompt = {
  revision: number;
  saved: PromptBlock[] | undefined;
  configured: string;
  active: string;
  /** Saved instructions the conversation has not adopted yet: it was working when they were saved. */
  pending: boolean;
};

export type HostAgent = {
  send(requestId: string, text: string): Promise<{ accepted: true }>;
  stop(): Promise<{ stopped: boolean }>;
  reset(): Promise<{ ok: true }>;
  history(before?: number): Promise<TranscriptPage>;
  settings(revision?: number, patch?: Static<typeof HostAgentSettingsPatch>): Promise<HostAgentSettingsView>;
  /** Its saved behavior blocks, the settings revision they share, and whether the running conversation still has other instructions. */
  prompt(): Promise<HostAgentPrompt>;
  /** Replaces its behavior blocks (null: the built-in prompt). A running turn keeps its instructions; the next one gets these. */
  setPrompt(revision: number, blocks: PromptBlock[] | null): Promise<HostAgentPrompt>;
  /** Internal input after the current turn (approval outcomes); `requestId` keeps it once across retries and restarts. */
  followUp(text: string, requestId: string): Promise<void>;
  watchLive(onFrame: (frame: DurableLiveFrame) => void, onEnd: () => void): Promise<() => void>;
  close(): Promise<void>;
};

function modelRef(value: string): { provider: string; modelId: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error(`Invalid model: ${value}`);
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/**
 * The Host agent: one Pi Durable root conversation in `<home>/host-agent/`, owned by the host process like a project's storage.
 * Its tools call the host's own dispatch (host-agent-tools.ts); it has no workspace and no project.
 */
export async function openHostAgent(input: {
  tools: HostToolDeps;
  publish(event: FeedEvent): void;
  report(detail: string): void;
}): Promise<HostAgent> {
  const dir = join(home(), "host-agent");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settingsPath = join(dir, "settings.json");
  const owner = new DatabaseSync(join(dir, "durable-owner.sqlite"));
  try {
    owner.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  } catch (error) {
    owner.close();
    throw new Error("Host agent storage is already owned by another process", { cause: error });
  }
  const release = () => {
    try {
      owner.exec("ROLLBACK");
    } catch {}
    owner.close();
  };
  let harness: Harness | undefined;
  try {
    let settings: Settings = existsSync(settingsPath)
      ? parse(Settings, JSON.parse(readFileSync(settingsPath, "utf8")))
      : { revision: 0, thinking: "medium", disabledTools: [] };
    const { models } = await liveModelRuntime();
    const dispatch = models.streamSimple.bind(models);
    models.streamSimple = (model, request, options) => {
      const first = request.messages[0];
      const sessionId =
        options?.sessionId ??
        (first ? `pi-projects-host-agent-${createHash("sha256").update(JSON.stringify(first)).digest("hex").slice(0, 32)}` : undefined);
      return durableGuardedStream(dispatch, model, request, { ...options, ...(sessionId ? { sessionId } : {}) });
    };
    const known = (ref: string) => {
      const { provider, modelId } = modelRef(ref);
      return models.getModel(provider, modelId) !== undefined;
    };
    // Same rule as project profiles: a tier resolves to its first model that is installed and has credentials.
    const tierModel = (tier: string): string | undefined =>
      readTiers()
        .tiers.find((item) => item.id === tier)
        ?.models.find((ref) => known(ref) && models.getProviderAuthStatus(modelRef(ref).provider).configured);
    // A set model wins; then the tier's first model; then the newest active project's model, so a fresh host can talk at once.
    const effectiveModel = (current: Settings): string | null => {
      const fromTier = current.tier ? tierModel(current.tier) : undefined;
      if (current.model) return current.model;
      if (fromTier) return fromTier;
      const newest = listProjects()
        .filter((project) => !project.deleted && !project.archived)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return newest?.model ?? null;
    };

    const tools = hostAgentTools(input.tools);
    const extension = defineExtension({ name: EXTENSION, tools });
    const registry = createRegistry();
    registry.install(extension);
    const desired = (current: Settings): AgentChange => {
      const model = effectiveModel(current);
      return {
        model: model ? modelRef(model) : null,
        thinkingLevel: current.thinking,
        cwd: dir,
        instructions: resolvePromptBlocks("host", current.promptBlocks).text,
        extensions: [extension],
        tools: tools.filter((tool) => !current.disabledTools.includes(tool.name)),
      };
    };
    const storage = await openNodeSqliteStorage(join(dir, "durable.sqlite"));
    const opened = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: { stream: { timeoutMs: 300_000 }, retry: { maxRetries: 3 }, followUpMode: "all", afterFailedRun: "continue" },
        onReport: (error) => input.report(errorText(error)),
      },
      context,
    );
    harness = opened;
    const root: Conversation = await opened.root(context, { agent: desired(settings) });
    const agentKey = (agent: Awaited<ReturnType<Conversation["agent"]>>) =>
      JSON.stringify([
        agent.model?.provider,
        agent.model?.modelId,
        agent.thinkingLevel,
        agent.tools.map((tool) => tool.name).sort(),
        agent.extensions.map((item) => item.name),
      ]);
    const apply = async (current: Settings) => {
      const change = desired(current);
      const expected = JSON.stringify([
        change.model?.provider,
        change.model?.modelId,
        change.thinkingLevel,
        (change.tools as typeof tools).map((tool) => tool.name).sort(),
        [EXTENSION],
      ]);
      const agent = await root.agent(context);
      if (agentKey(agent) !== expected) await root.configure({ ...change, instructions: undefined }, context);
      // Instructions change only between turns, so a self-edit through host_call never rewrites the turn that made it.
      if ((agent.instructions ?? "") === change.instructions) return;
      try {
        await configureWhenIdle(root, root, { instructions: change.instructions }, context, "changing its prompt");
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("wait for it to finish"))) throw error;
      }
    };
    const prompt = async (): Promise<HostAgentPrompt> => {
      const configured = desired(settings).instructions as string,
        active = (await root.agent(context)).instructions ?? "";
      return { revision: settings.revision, saved: settings.promptBlocks, configured, active, pending: active !== configured };
    };
    await apply(settings);

    // The browser refetches history when a turn adds entries or finishes; streaming deltas alone are left to /live.
    const view = await root.viewState(context);
    let seen = "";
    const unsubscribe = view.subscribe((value) => {
      const frame = liveFrame(value),
        key = `${frame.entries}:${frame.running}`;
      if (key === seen) return;
      seen = key;
      if (!frame.running)
        void apply(settings).catch((error) => input.report(`The Host agent could not adopt its saved prompt: ${errorText(error)}`));
      input.publish({ topic: "host-agent" });
    });
    const liveWatchers = new Set<() => void>();
    let closed = false,
      closing: Promise<void> | undefined;
    const assertOpen = () => {
      if (closed) throw new Error("Host agent is closed");
    };
    const settingsView = (): HostAgentSettingsView => ({
      revision: settings.revision,
      tier: settings.tier ?? null,
      model: settings.model ?? null,
      thinking: settings.thinking,
      disabledTools: settings.disabledTools,
      effectiveModel: effectiveModel(settings),
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, dangerous: false })),
      actions: agentActions().map(({ name, description, dangerous }) => ({ name, description, dangerous })),
    });
    opened.resume();

    return {
      async send(requestId, text) {
        assertOpen();
        const model = effectiveModel(settings);
        if (!model) throw new Error("The Host agent has no model; choose one in its settings");
        if (!known(model)) throw new Error(`The Host agent's model ${model} is not in the model catalog; choose another in its settings`);
        await apply(settings);
        await root.submit({ type: "input", content: text, entry: { kind: "projects.owner-input" }, requestId, whenBusy: "steer" }, context);
        return { accepted: true };
      },
      async stop() {
        assertOpen();
        const running = liveFrame(view.value).running;
        await root.abort(context);
        return { stopped: running };
      },
      async reset() {
        assertOpen();
        await root.reset(undefined, context);
        input.publish({ topic: "host-agent" });
        return { ok: true };
      },
      async history(before) {
        assertOpen();
        return readTranscriptPage(storageSource(storage, context), Number(root.id), { before, messageText: "full" });
      },
      async settings(revision, patch) {
        assertOpen();
        if (!patch) return settingsView();
        if (revision !== settings.revision) throw new Error("Host agent settings changed (stale revision); reload and retry");
        const next: Settings = { ...settings, revision: settings.revision + 1 };
        if (patch.model === null) delete next.model;
        else if (patch.model !== undefined) {
          if (!known(patch.model)) throw new Error(`Unknown model ${patch.model}: it is not in the model catalog`);
          next.model = patch.model;
        }
        if (patch.tier === null) delete next.tier;
        else if (patch.tier !== undefined) {
          if (!readTiers().tiers.some((item) => item.id === patch.tier)) throw new Error(`Unknown tier ${patch.tier}`);
          if (!tierModel(patch.tier)) throw new Error(`Tier ${patch.tier} has no model with configured credentials`);
          next.tier = patch.tier;
          // Choosing a tier means "use the tier": a pin left over would silently win over it.
          if (patch.model === undefined) delete next.model;
        }
        if (patch.thinking) next.thinking = patch.thinking;
        if (patch.disabledTools) {
          const names = new Set(tools.map((tool) => tool.name));
          const unknown = patch.disabledTools.filter((name) => !names.has(name));
          if (unknown.length) throw new Error(`Unknown Host agent tools: ${unknown.join(", ")}`);
          next.disabledTools = [...new Set(patch.disabledTools)];
        }
        // Durable pins the model of a request in flight; the change applies from the next one.
        await apply(next);
        saveJson(settingsPath, next);
        settings = next;
        input.publish({ topic: "host-agent" });
        return settingsView();
      },
      async prompt() {
        assertOpen();
        return prompt();
      },
      async setPrompt(revision, blocks) {
        assertOpen();
        if (revision !== settings.revision) throw new Error("Host agent settings changed (stale revision); reload and retry");
        const next: Settings = { ...settings, revision: settings.revision + 1 };
        const list = blocks === null ? undefined : normalizePromptBlocks("host", blocks);
        if (list) next.promptBlocks = list;
        else delete next.promptBlocks;
        await apply(next);
        saveJson(settingsPath, next);
        settings = next;
        input.publish({ topic: "host-agent" });
        return prompt();
      },
      async followUp(text, requestId) {
        assertOpen();
        await root.submit(
          { type: "input", content: text, entry: { kind: "projects.internal-input" }, requestId, whenBusy: "followUp" },
          context,
        );
      },
      async watchLive(onFrame, onEnd) {
        assertOpen();
        const live = await root.viewState(context);
        let last = "",
          ended = false;
        const push = (value: typeof live.value) => {
          const frame = liveFrame(value),
            key = JSON.stringify(frame);
          if (key === last) return;
          last = key;
          onFrame(frame);
        };
        const stopWatching = live.subscribe(push);
        const stop = () => {
          if (ended) return;
          ended = true;
          liveWatchers.delete(stop);
          stopWatching();
          live.dispose();
          onEnd();
        };
        liveWatchers.add(stop);
        push(live.value);
        return stop;
      },
      close() {
        closing ??= (async () => {
          closed = true;
          for (const stop of [...liveWatchers]) stop();
          unsubscribe();
          view.dispose();
          await opened.close(context);
          release();
        })();
        return closing;
      },
    };
  } catch (error) {
    await harness?.close(context).catch(() => {});
    release();
    throw error;
  }
}
