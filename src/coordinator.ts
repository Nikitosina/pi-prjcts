import {
  createAgentSession, createEventBus, DefaultResourceLoader, getAgentDir,
  SessionManager, SettingsManager, type AgentSession, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { registerAgentViaEvents } from "pi-subagents/agents";
import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";
import { existsSync, appendFileSync, copyFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Role, errorText, jobs, notes, parse, projectDir, readJson, saveJob, saveJson, saveProject, Project } from "./state.ts";
import { noteTools } from "./worker-policy.ts";
import { coordinatorPrompt, coordinatorTools } from "./coordinator-prompt.ts";
import { addQuestion, addReview, inbox, recoverInbox } from "./inbox.ts";
import { evidence } from "./evidence.ts";
import { knowledgeContext } from "./knowledge.ts";

const RpcReply = Type.Union([
  Type.Object({ success: Type.Literal(true), data: Type.Unknown() }),
  Type.Object({ success: Type.Literal(false), error: Type.Object({ message: Type.String() }) }),
]);
const Launch = Type.Object({ details: Type.Object({ asyncId: Project.properties.id, asyncDir: Type.String() }) });
const Status = Type.Object({ state: Type.String(), sessionFile: Type.Optional(Type.String()), steps: Type.Optional(Type.Array(Type.Object({ recentOutput: Type.Optional(Type.Array(Type.String())) }))) });
export type Runtime = Awaited<ReturnType<typeof openCoordinator>>;
export async function loadProjectResourceLoader(project: Project): Promise<DefaultResourceLoader> {
  const settingsManager = SettingsManager.create(project.cwd, getAgentDir());
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({ cwd: project.cwd, agentDir: getAgentDir(), settingsManager, eventBus: createEventBus() });
  await resourceLoader.reload();
  const failures = resourceLoader.getExtensions().errors;
  if (failures.length) throw new Error(failures.map(error => `${error.path}: ${error.error}`).join("\\n"));
  return resourceLoader;
}
const launchingWriters = new Set<string>();

export async function openCoordinator(project: Project, allProjects: () => Project[]) {
  const dir = projectDir(project.id);
  recoverInbox(dir, project.id);
  if (project.problem && !inbox(dir).some(item => item.kind === "question" && item.question === project.problem)) addQuestion(dir, project.problem.slice(0, 32000));
  const bus = createEventBus();
  let pumping = false;
  let session: AgentSession;
  const registrations: { dispose(): void }[] = [];
  const rpc = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => { off(); reject(new Error(`Subagent ${method} did not respond within 60 seconds`)); }, 60000);
    const off = bus.on(`subagents:rpc:v1:reply:${requestId}`, value => {
      clearTimeout(timer); off();
      try {
        const reply = parse(RpcReply, value);
        if (reply.success) resolve(reply.data);
        else reject(new Error(reply.error.message));
      } catch (error) { reject(error); }
    });
    bus.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params });
  });

  const delegate = async (role: Role, task: string) => {
    await knowledgeContext(dir);
    const pending = join(dir, "writer-launch.json");
    if (role === "worker") {
      const peers = allProjects().filter(p => p.cwd === project.cwd);
      const occupied = peers.flatMap(p => p.runs).find(run => run.role === "worker" && runIsActive(run));
      if (occupied) throw new Error(`Workspace already has writer ${occupied.id}. Wait for it or stop it first.`);
      if (launchingWriters.has(project.cwd) || peers.some(p => existsSync(join(projectDir(p.id), "writer-launch.json")))) throw new Error("Workspace has an unfinished writer launch. Inspect project workers and writer-launch.json before clearing that record.");
      launchingWriters.add(project.cwd);
      saveJson(pending, { task, at: new Date().toISOString() });
    }
    try {
      const data = parse(Launch, await rpc("spawn", { agent: `projects-${role}`, task, cwd: project.cwd, context: "fresh", async: true }));
      project.runs.push({ id: data.details.asyncId, dir: data.details.asyncDir, role, task, createdAt: new Date().toISOString(), receipt: null });
      saveProject(project);
      if (role === "worker") unlinkSync(pending);
      return { runId: data.details.asyncId, role, dir: data.details.asyncDir };
    } finally {
      if (role === "worker") launchingWriters.delete(project.cwd);
    }
  };

  const factory: ExtensionFactory = pi => {
    noteTools(pi, dir, "coordinator");
    pi.registerTool({
      name: "projects_delegate", label: "Delegate project work", description: "Start a background worker, scout, or reviewer in this project's workspace. One writer at a time. Returns a run ID for inspection and control. Work completion wakes this coordinator automatically.",
      parameters: Type.Object({ role: Role, task: Type.String({ minLength: 1, maxLength: 32000 }) }),
      async execute(_id, input) {
        const receipt = await delegate(input.role, input.task);
        return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
      },
    });
    pi.registerTool({
      name: "projects_workers", label: "Project workers", description: "Inspect this project's delegated runs. Supply a run ID to read its transcript and result.",
      parameters: Type.Object({ run: Type.Optional(Type.String()) }),
      async execute(_id, input) {
        const data = await inspect(input.run);
        const status = parse(Type.Object({ text: Type.String() }), data);
        return { content: [{ type: "text", text: status.text }], details: data };
      },
    });
    pi.registerTool({
      name: "projects_control", label: "Control project worker", description: "Steer or stop a run belonging to this project.",
      parameters: Type.Object({ run: Type.String(), operation: Type.Union([Type.Literal("steer"), Type.Literal("stop")]), message: Type.Optional(Type.String()) }),
      async execute(_id, input) {
        ownRun(input.run);
        const data = await rpc(input.operation, { id: input.run, message: input.message });
        return { content: [{ type: "text", text: JSON.stringify(data) }], details: undefined };
      },
    });
    pi.registerTool({
      name: "projects_question", label: "Ask project owner", description: "Record a question requiring the human's decision, then stop this turn. The human answers with another project message.",
      parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 4000 }), choices: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 4 })) }),
      async execute(_id, input) {
        const entry = question(input.question, "", input.choices ?? []);
        return { content: [{ type: "text", text: JSON.stringify(entry) }], details: entry, terminate: true };
      },
    });
    pi.on("before_agent_start", async event => {
      pi.setActiveTools(coordinatorTools);
      return { systemPrompt: event.systemPrompt + coordinatorPrompt({ project, memory: await knowledgeContext(dir) }) };
    });
    pi.on("tool_call", event => {
      if (!coordinatorTools.includes(event.toolName)) return { block: true, reason: "The project master can only plan, inspect, delegate, and control workers. Execution belongs to subagents; goal integration is deferred." };
    });
    pi.on("session_start", (_event, ctx) => {
      for (const role of ["worker", "scout", "reviewer"] satisfies Role[]) {
        registrations.push(registerAgentViaEvents({ pi, name: `projects-${role}`, definition: {
          description: `Project ${role}`, systemPrompt: role === "worker" ? "Implement the assigned task and verify it." : "Inspect the assigned task and return evidence. You are read-only.",
          model: project.models[role], thinking: "medium", defaultAsync: true,
          tools: role === "worker" ? ["read", "bash", "edit", "write", "grep", "find", "ls", "projects_note", "projects_notes", "projects_evidence", "projects_knowledge_list", "projects_knowledge_read", "projects_knowledge_write", "projects_knowledge_history"] : ["read", "grep", "find", "ls", "projects_note", "projects_notes", "projects_knowledge_list", "projects_knowledge_read", "projects_knowledge_write", "projects_knowledge_history"],
          inheritProjectContext: true, inheritGlobalContext: true, inheritSkills: true, systemPromptMode: "append",
        } }));
      }
      registrations.push(registerRequiredChildExtensions({ sessionId: ctx.sessionManager.getSessionId(), extensions: [{ id: "projects-worker-policy", path: join(dir, "worker-policy.ts") }] }));
    });
    pi.on("session_shutdown", () => { for (const registration of registrations.splice(0)) registration.dispose(); });
  };

  const policyPath = fileURLToPath(new URL("./worker-policy.ts", import.meta.url));
  const policy = `import { workerPolicy } from ${JSON.stringify(policyPath)};\nexport default workerPolicy(${JSON.stringify({ root: project.cwd, dir })});\n`;
  writeFileSync(join(dir, "worker-policy.ts"), policy, { mode: 0o600 });
  const settingsManager = SettingsManager.create(project.cwd, getAgentDir());
  // Project creation approves this workspace's resources, not any other workspace.
  settingsManager.setProjectTrusted(true);
  const resourceLoader = new DefaultResourceLoader({
    cwd: project.cwd, agentDir: getAgentDir(), settingsManager, eventBus: bus, extensionFactories: [factory],
    extensionsOverride: base => ({ ...base, extensions: base.extensions.filter(extension => !extension.tools.has("create_goal")) }),
  });
  await resourceLoader.reload();
  const failures = resourceLoader.getExtensions().errors;
  if (failures.length) throw new Error(failures.map(e => `${e.path}: ${e.error}`).join("\n"));
  const manager = project.sessionFile ? SessionManager.open(project.sessionFile, undefined, project.cwd) : SessionManager.create(project.cwd, join(dir, "sessions"));
  ({ session } = await createAgentSession({
    cwd: project.cwd, agentDir: getAgentDir(), resourceLoader, settingsManager, sessionManager: manager,
    tools: coordinatorTools,
    thinkingLevel: "medium",
  }));
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = async (...args) => {
    await knowledgeContext(dir);
    return stream(...args);
  };
  // A persistent host owns completion delivery, unlike one-shot headless runs.
  const ui = session.extensionRunner.getUIContext();
  function question(title: string, detail = "", choices: string[] = []) {
    project.problem = [title, detail].filter(Boolean).join("\n").slice(0, 32000);
    const entry = addQuestion(dir, project.problem, choices);
    saveProject(project);
    log("question", entry);
    return entry;
  }
  function phase() { return project.problem || inbox(dir).some(entry => !entry.result) ? "attention" : "ready"; }
  await session.bindExtensions({ mode: "rpc", uiContext: {
    ...ui,
    notify: (message, type) => log("notification", { message, type }),
    confirm: async (title, message) => { question(title, message); return false; },
    select: async (title, options) => { question(title, options.join("\n"), options.slice(0, 4)); return undefined; },
    input: async (title, placeholder) => { question(title, placeholder); return undefined; },
    editor: async (title) => { question(title); return undefined; },
  }, onError: error => log("extension-error", error) });
  const slash = project.model.indexOf("/");
  const model = session.modelRuntime.getModel(project.model.slice(0, slash), project.model.slice(slash + 1));
  if (!model) { session.dispose(); throw new Error(`Coordinator model unavailable: ${project.model}`); }
  await session.setModel(model, { persist: false });
  project.sessionFile = session.sessionFile ?? null;
  if (project.phase === "busy") { project.phase = "attention"; project.problem = "Host stopped during coordinator work. Interrupted prompts were not replayed. Inspect workers before continuing."; }
  for (const job of jobs(project.id)) {
    if (job.state === "running") { job.state = "interrupted"; job.error = "Host stopped. Send a new instruction to continue; this request was not replayed."; saveJob(project.id, job); }
  }
  saveProject(project);
  session.subscribe(event => {
    if (["agent_start", "agent_settled", "message_end", "tool_execution_start", "tool_execution_end"].includes(event.type)) log(event.type, event);
    if (event.type === "agent_start") { project.phase = "busy"; saveProject(project); }
    if (event.type === "agent_settled") { archiveRuns(); project.phase = phase(); saveProject(project); }
  });
  await rpc("ping");

  function ownRun(id: string) {
    const run = project.runs.find(run => run.id === id);
    if (!run) throw new Error("Run does not belong to this project");
    return run;
  }
  function archiveRuns() {
    for (const run of project.runs.filter(run => !run.receipt && !runIsActive(run))) {
      const receipt = join(dir, "runs", run.id);
      saveJson(join(receipt, "status.json"), readJson(join(run.dir, "status.json")));
      const output = join(run.dir, "output-0.log");
      if (existsSync(output)) copyFileSync(output, join(receipt, "output.log"));
      run.receipt = receipt;
      saveProject(project);
    }
    for (const run of project.runs.filter(run => !runIsActive(run))) addReview(dir, run, runState(run).state);
  }
  async function inspect(id?: string) {
    archiveRuns();
    if (!id) return rpc("status");
    const run = ownRun(id);
    if (!existsSync(join(run.dir, "status.json")) && run.receipt) {
      const output = join(run.receipt, "output.log");
      return { archived: true, status: readJson(join(run.receipt, "status.json")), text: existsSync(output) ? readFileSync(output, "utf8").slice(-32000) : "Transcript is in the archived status sessionFile." };
    }
    return rpc("status", { id, view: "transcript", lines: 100 });
  }
  function log(type: string, data: unknown) {
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), type, data }) + "\n", { mode: 0o600 });
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (const job of jobs(project.id).filter(job => job.state === "queued")) {
        await session.waitForIdle();
        job.state = "running"; saveJob(project.id, job);
        project.problem = null; project.phase = "busy"; saveProject(project);
        try {
          await knowledgeContext(dir);
          await session.prompt(job.text, { source: "rpc", expandPromptTemplates: false });
          await session.waitForIdle();
          const last = session.messages.findLast(m => m.role === "assistant");
          if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) throw new Error(last.errorMessage ?? last.stopReason);
          job.state = "done";
        } catch (error) { job.state = "failed"; job.error = errorText(error); project.problem = job.error; }
        saveJob(project.id, job);
        project.phase = phase(); saveProject(project);
      }
    } finally {
      pumping = false;
      if (jobs(project.id).some(job => job.state === "queued")) void pump().catch(error => log("pump-error", errorText(error)));
    }
  }

  return {
    project, session, rpc,
    pump: () => { void pump().catch(error => log("pump-error", errorText(error))); },
    ownRun, inspect, delegate,
    snapshot: () => {
      archiveRuns();
      return {
        project, busy: !session.isIdle || pumping, jobs: jobs(project.id),
        messages: session.messages.filter(m => m.role === "assistant" || m.role === "user" || m.role === "custom").slice(-30).map(m => ({
          role: m.role, at: m.timestamp,
          text: typeof m.content === "string" ? m.content : m.content.flatMap(b => b.type === "text" ? [b.text] : []).join("\n"),
        })),
        activeRuns: project.runs.filter(run => runIsActive(run)),
        inbox: inbox(dir), notes: notes(dir), evidence: evidence(dir), runStates: project.runs.map(runState),
      };
    },
  };
}

function runState(run: Project["runs"][number]) {
  try {
    const status = parse(Status, readJson(join(run.receipt ?? run.dir, "status.json")));
    return { id: run.id, state: status.state, summary: (status.steps ?? []).flatMap(step => step.recentOutput ?? []).slice(-10).join("\n").slice(-8000), sessionFile: status.sessionFile ?? null };
  } catch (error) { return { id: run.id, state: "unknown", summary: errorText(error), sessionFile: null }; }
}

export function runIsActive(run: Project["runs"][number]): boolean {
  if (run.receipt) return false;
  const path = join(run.dir, "status.json");
  if (!existsSync(path)) return true;
  try {
    const status = parse(Status, readJson(path));
    return !["complete", "failed", "stopped"].includes(status.state);
  } catch { return true; }
}
