import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { request, openInbox } from "./client.ts";
import { Project, Role, Snapshot, Request, errorText, parse } from "./state.ts";
import { clean, Layout, layouts } from "./project-items.ts";
import { draftSnapshot, restoreDrafts } from "./project-drafts.ts";
import { ProjectsScreen, type FormDraft } from "./project-screen.ts";
import { NativePlan } from "./project-native-data.ts";
import type { KnowledgeDraft } from "./project-knowledge-screen.ts";
import type { SettingsDraft } from "./project-settings-screen.ts";
import type { UploadDraft } from "./project-upload-screen.ts";

export default function projects(pi: ExtensionAPI) {
  if (process.env.PI_PROJECTS_HOST === "1") return;
  let selected: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling: number | undefined;
  let generation = 0;
  const seen = new Set<string>();
  let screen: ProjectsScreen | undefined;
  let screenOpen = false;
  let layout: Layout = "inbox";
  const drafts = new Map<string, string>();
  const formDrafts = new Map<string, FormDraft>();
  const knowledgeDrafts = new Map<string, KnowledgeDraft>();
  const knowledgePathDrafts = new Map<string, string>();
  const settingsDrafts = new Map<string, SettingsDraft>();
  const uploadDrafts = new Map<string, UploadDraft>();
  const draftStore = { coordinator: drafts, forms: formDrafts, knowledge: knowledgeDrafts, knowledgePaths: knowledgePathDrafts, settings: settingsDrafts, uploads: uploadDrafts };
  let lastDraftState = "";
  let lastDraftFailure: string | null = null;

  function output(content: string) {
    pi.sendMessage({ customType: "projects", content, display: true });
  }
  function detach(ctx: ExtensionContext) {
    generation++;
    if (timer) clearInterval(timer);
    timer = undefined; selected = null; seen.clear();
    ctx.ui.setStatus("projects", undefined);
    ctx.ui.setWidget("projects-question", undefined);
  }
  async function refresh(ctx: ExtensionContext, initial = false) {
    if (!selected || polling === generation) return;
    const token = generation, id = selected;
    polling = token;
    try {
      const snapshot = parse(Snapshot, await request({ action: "show", id }, initial));
      if (token !== generation) return;
      if (snapshot.project.id !== id) throw new Error("Project snapshot differs from the selected owned UUID");
      applySnapshot(ctx, snapshot, initial);
      return snapshot;
    } catch (error) {
      if (token === generation) ctx.ui.setStatus("projects", `Projects disconnected: ${errorText(error).slice(0, 100)}`);
      if (initial) throw error;
    } finally { if (polling === token) polling = undefined; }
  }
  function applySnapshot(ctx: ExtensionContext, snapshot: Snapshot, initial: boolean) {
    ctx.ui.setStatus("projects", `Project ${snapshot.project.name}: ${snapshot.busy ? "coordinating" : snapshot.project.phase} · ${snapshot.project.runtime === "durable" ? "Durable threads in Projects" : `${snapshot.activeRuns.length} legacy workers`}`);
    if (snapshot.project.problem) ctx.ui.setWidget("projects-question", [snapshot.project.problem]);
    else ctx.ui.setWidget("projects-question", undefined);
    for (const message of snapshot.messages) {
      const key = JSON.stringify(message);
      if (seen.has(key) || !message.text) continue;
      seen.add(key);
      if (!screenOpen) output(`[${snapshot.project.name} / ${message.role}]\n${message.text}`);
    }
    const currentMessages = new Set(snapshot.messages.map(message => JSON.stringify(message)));
    for (const key of seen) if (!currentMessages.has(key)) seen.delete(key);
    if (!screenOpen && initial && snapshot.messages.length === 0) output(`Opened ${snapshot.project.name}. Plain messages now go to its persistent coordinator. /project-close returns to local Pi.`);
  }
  async function attach(id: string, ctx: ExtensionContext) {
    const token = generation;
    const snapshot = parse(Snapshot, await request({ action: "show", id }, true));
    if (token !== generation) throw new Error("Project selection was superseded; no screen switch applied");
    if (snapshot.project.id !== id) throw new Error("Project snapshot differs from the selected owned UUID");
    pi.appendEntry("projects-selection", { id });
    detach(ctx); selected = id;
    applySnapshot(ctx, snapshot, true);
    timer = setInterval(() => { void refresh(ctx); }, 1500);
    timer.unref();
    return snapshot;
  }
  function current(): string {
    if (!selected) throw new Error("Open a project with /projects or /project-open first");
    return selected;
  }
  const command = (name: string, description: string, handler: (args: string, ctx: ExtensionContext) => Promise<void>) => {
    pi.registerCommand(name, { description, handler: async (args, ctx) => {
      try { await handler(args.trim(), ctx); } catch (error) { ctx.ui.notify(errorText(error), "error"); }
    } });
  };
  command("project-migration-help", "Show copy-only legacy maintenance limits", async (_args, ctx) => {
    ctx.ui.notify("Copy-only maintenance is standalone: run projects --no-start copy-root-init <new-root>, then copy only an already-authorized inactive project into that root. Use copy-inspect/archive/switch/rollback with absolute canonical paths and --confirm <same-project-uuid>. It never starts a host. Production migration, opening the copy, history replay, active/unknown-run reconciliation and original SQLite access are unsupported. See DURABLE.md.", "info");
  });
  async function create(name: string, ctx: ExtensionContext) {
    if (!ctx.hasUI) throw new Error("Create projects through the CLI in headless mode");
    const token = generation, cwd = ctx.cwd;
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const title = name || await ctx.ui.input("Project name");
    if (!title?.trim()) return;
    if (!(await ctx.ui.confirm("Create local project?", `Workspace: ${cwd}\nThis creates a Durable coordinator and allows loading this trusted workspace's Pi resources. Worker workspace/tools and provider publication need separate explicit grants. Merge, deployment and destructive effects require exact executable approval. The host keeps running after you close Pi.`))) return;
    const objective = await ctx.ui.input("Project objective", "Optional; submit blank to omit, Escape cancels creation");
    if (objective === undefined) return;
    if (token !== generation) throw new Error("Project selection changed during creation prompts; no creation request sent");
    const input = { action: "create", requestId: randomUUID(), name: title, cwd, objective, ...(model ? { model } : {}) } satisfies Extract<Request, { action: "create" }>;
    pi.appendEntry("projects-creation-request", input);
    await submitCreation(input, ctx, token);
  }
  async function submitCreation(input: Extract<Request, { action: "create" }>, ctx: ExtensionContext, token: number) {
    const id = parse(Project.properties.id, input.requestId);
    let project: Project;
    try { project = parse(Project, await request(input)); }
    catch (error) { throw new Error(`Creation request ${id} has an unconfirmed response: ${errorText(error)}. Inspect its known UUID or explicitly retry /project-create-retry ${id}; do not start a replacement creation.`); }
    if (project.id !== id) throw new Error(`Creation response differs from request/project UUID ${id}; inspect the original request without creating a replacement`);
    output(`Creation request ${id} returned its owned project. It may reuse retained metadata; no restore or resume was requested.`);
    if (token !== generation) return;
    try { await attach(project.id, ctx); }
    catch (error) { throw new Error(`Project ${project.id} exists, but attachment failed: ${errorText(error)}. Open its known UUID; do not recreate it.`); }
  }
  async function retryCreation(args: string, ctx: ExtensionContext) {
    if (!ctx.hasUI) throw new Error("Creation retries require explicit interactive confirmation");
    const id = parse(Project.properties.id, args);
    let input: Extract<Request, { action: "create" }> | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "projects-creation-request") continue;
      const candidate = parse(Request, entry.data);
      if (candidate.action !== "create" || candidate.requestId !== id) continue;
      if (input && JSON.stringify(input) !== JSON.stringify(candidate)) throw new Error("Current session branch contains conflicting creation requests; no retry sent");
      input = candidate;
    }
    if (!input) throw new Error("No exact bound creation request in the current session branch; old unbound requests cannot be adopted");
    const token = generation;
    if (!(await ctx.ui.confirm("Retry this exact creation request?", `${JSON.stringify(input, null, 2)}\nThis reuses the same request/project UUID without replacing settings or restoring/resuming retained state.`))) return;
    if (token !== generation) throw new Error("Project selection changed during retry confirmation; no request sent");
    await submitCreation(input, ctx, token);
  }
  async function show(input: Request) {
    output(JSON.stringify(await request(input), null, 2));
  }

  async function browse(ctx: ExtensionContext) {
    const projects = parse(Type.Array(Project), await request({ action: "list" }));
    if (!ctx.hasUI) { output(JSON.stringify(projects, null, 2)); return; }
    const options = projects.map(p => `${p.name} · ${p.cwd} · ${p.id}`);
    const picked = await ctx.ui.select("Projects", ["Create new project", "Open known retained project UUID", ...options]);
    if (picked === "Create new project") await create("", ctx);
    else if (picked === "Open known retained project UUID") {
      const id = await ctx.ui.input("Known owned project UUID", "Inspection/attachment only; restore and resume remain separate");
      if (id?.trim()) await attach(parse(Project.properties.id, id.trim()), ctx);
    }
    else if (picked) {
      const index = options.indexOf(picked);
      const project = projects[index];
      if (project) await attach(project.id, ctx);
    }
  }
  async function view(next: Layout, ctx: ExtensionContext) {
    if (ctx.mode !== "tui") throw new Error("Projects layouts require interactive Pi. Use /project-status in RPC or print mode.");
    if (screenOpen) throw new Error("A Projects screen is already open");
    screenOpen = true;
    try {
      if (!selected) await browse(ctx);
      if (!selected) return;
      const snapshot = parse(Snapshot, await request({ action: "show", id: current() }));
      layout = next;
      pi.appendEntry("projects-layout", { layout });
      await ctx.ui.custom<void>((tui, theme, keys, done) => {
        screen = new ProjectsScreen({ tui, theme, keys, done, snapshot, layout, drafts, formDrafts, knowledgeDrafts, knowledgePathDrafts, settingsDrafts, uploadDrafts,
          saveDrafts: () => {
            try {
              const state = draftSnapshot(draftStore), serialized = JSON.stringify(state);
              if (serialized === lastDraftState) { lastDraftFailure = null; return; }
              pi.appendEntry("projects-drafts", state); lastDraftState = serialized; lastDraftFailure = null;
            } catch (error) {
              const failure = clean(`Native draft persistence failed: ${errorText(error)}`);
              if (failure !== lastDraftFailure) ctx.ui.notify(failure, "error");
              lastDraftFailure = failure; throw error;
            }
          },
          selectProject: id => attach(id, ctx),
          saveLayout: next => { layout = next; pi.appendEntry("projects-layout", { layout }); },
        });
        return screen;
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
    } finally { screen?.dispose(); screen = undefined; screenOpen = false; }
  }
  command("projects", "Browse projects and open the native Projects screen", async (_args, ctx) => {
    await browse(ctx);
    if (selected && ctx.mode === "tui") await view(layout, ctx);
  });
  command("projects-view", "Open a native Projects layout: desk, board, or inbox", async (args, ctx) => { await view(args ? parse(Layout, args) : layout, ctx); });
  for (const name of layouts) command(`projects-${name}`, `Open the native Projects ${name} layout`, async (_args, ctx) => { await view(name, ctx); });
  command("projects-ui", "Open the live decision inbox in your browser", async (id, ctx) => {
    await openInbox(id || selected || undefined);
    ctx.ui.notify("Opened the live Projects decision inbox.", "info");
  });
  command("project-create", "Create a project in the current workspace", create);
  command("project-create-retry", "Confirm an exact creation retry from the current session branch: <request UUID>", retryCreation);
  command("project-open", "Attach to a project by ID", async (id, ctx) => { await attach(id, ctx); });
  command("project-close", "Detach from the project; leave its host and workers running", async (_args, ctx) => {
    detach(ctx); pi.appendEntry("projects-selection", { id: null });
    ctx.ui.notify("Detached. Project work continues on your Mac.", "info");
  });
  command("project-status", "Show coordinator state, requests, and recent messages", async () => { await show({ action: "show", id: current() }); });
  command("project-submit-scoped", "Submit authorized Durable worker work: <scope-id> <thread-id> <request-id> <task>", async args => {
    const matched = /^(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(args);
    if (!matched) throw new Error("Usage: /project-submit-scoped <scope-id> <thread-id> <request-id> <task>");
    const input = parse(Request, { action: "work-submit", id: current(), workspaceScopeId: matched[1], threadId: matched[2], requestId: matched[3], text: matched[4] });
    if (input.action !== "work-submit") throw new Error("Invalid scoped submission");
    pi.appendEntry("projects-scoped-request", input);
    try { await show(input); }
    catch (error) { throw new Error(`Thread ${input.threadId}, request ${input.requestId} has an unconfirmed response: ${errorText(error)}. Inspect the owned plan/history or retry exactly the same IDs, scope and text.`); }
  });
  command("project-delegate", "Assign a bounded legacy task directly: <worker|scout|reviewer> <task>", async args => {
    const space = args.indexOf(" ");
    if (space < 0) throw new Error("Usage: /project-delegate <worker|scout|reviewer> <task>");
    await show({ action: "delegate", id: current(), role: parse(Role, args.slice(0, space)), task: args.slice(space + 1) });
  });
  command("project-workers", "List work or inspect an owned worker thread", async run => {
    const id = current(), snapshot = parse(Snapshot, await request({ action: "show", id }));
    if (snapshot.project.runtime === "durable") {
      if (run) await show({ action: "thread-history", id, threadId: run });
      else output(JSON.stringify(parse(NativePlan, await request({ action: "plan-snapshot", id })), null, 2));
    } else await show({ action: "workers", id, ...(run ? { run } : {}) });
  });
  command("project-notes", "Read shared project knowledge", async () => { await show({ action: "notes", id: current() }); });
  command("project-steer", "Steer a worker: <run-id> <message>", async args => {
    const space = args.indexOf(" ");
    if (space < 0) throw new Error("Usage: /project-steer <run-id> <message>");
    await show({ action: "control", id: current(), run: args.slice(0, space), operation: "steer", message: args.slice(space + 1) });
  });
  command("project-stop", "Stop a worker by run ID", async run => { await show({ action: "control", id: current(), run, operation: "stop" }); });
  command("project-host-stop", "Stop the local project host, leaving detached workers recoverable", async (_args, ctx) => {
    if (!ctx.hasUI || !(await ctx.ui.confirm("Stop Projects host?", "All coordinators disconnect. Detached workers may continue. Reopening a project restores its session and worker controls."))) return;
    await request({ action: "shutdown" }, false);
    detach(ctx);
  });
  pi.on("input", async (event, ctx) => {
    if (!selected || event.text.startsWith("/") || event.text.startsWith("!")) return { action: "continue" };
    try {
      if (event.images?.length) throw new Error("Project image messages are not supported in this MVP");
      await request({ action: "message", id: selected, text: event.text });
      ctx.ui.notify("Sent to project coordinator", "info");
    } catch (error) { ctx.ui.notify(`Not sent: ${errorText(error)}`, "error"); }
    return { action: "handled" };
  });
  pi.on("session_start", async (_event, ctx) => {
    const savedDrafts = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "projects-drafts");
    try {
      restoreDrafts(draftStore, savedDrafts?.type === "custom" ? savedDrafts.data : { version: 1, coordinator: [], forms: [], knowledge: [], settings: [] });
      lastDraftState = JSON.stringify(draftSnapshot(draftStore));
    } catch (error) { ctx.ui.notify(clean(`Native drafts not restored: ${errorText(error)}`), "warning"); }
    const savedLayout = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "projects-layout");
    if (savedLayout?.type === "custom") layout = parse(Type.Object({ layout: Layout }), savedLayout.data).layout;
    const Selection = Type.Object({ id: Type.Union([Type.String(), Type.Null()]) });
    const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "projects-selection");
    if (entry?.type === "custom") {
      const selection = parse(Selection, entry.data);
      if (selection.id) {
        try { await attach(selection.id, ctx); } catch (error) { ctx.ui.notify(errorText(error), "warning"); }
      }
    }
  });
  pi.on("session_shutdown", (_event, ctx) => { screen?.close(); detach(ctx); });
}
