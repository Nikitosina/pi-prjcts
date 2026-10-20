import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "typebox";
import type { HostPluginApi } from "../../src/plugin-types.ts";

/** Clones one project may own at once (for example an iPhone and an iPad). */
export const MAX_OWNED = 4;
export const simulatorResource = (udid: string) => `simulator:${udid.toUpperCase()}`;
/** Bare clone UUIDs and `simulator:<uuid>` in any case name one lease. */
export const leaseName = (resource: string) => { const uuid = /^(?:simulator:)?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(resource)?.[1]; return uuid ? simulatorResource(uuid) : undefined; };
export type Simulators = ReturnType<typeof createSimulators>;
type Frame = { bytes: Buffer; mime: "image/jpeg" | "image/png"; capturedAt: number };
export type SimulatorTarget = { udid?: string; sourceUdid?: string };
function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

/** Ownership, lifecycle and screenshots of each project's simulator clones. State: `<project dir>/simulator.json`. */
export function createSimulators(api: HostPluginApi) {
  const { Type } = api.lib.typebox, { Value } = api.lib.value;
  const loadProject = api.projects.load, projectDir = api.projects.dir;
  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
  function parse<T extends TSchema>(schema: T, value: unknown): Static<T> {
    if (!Value.Check(schema, value)) throw new Error(`Invalid data: ${[...Value.Errors(schema, value)].map(e => `${e.instancePath}: ${e.message}`).join("; ").slice(0, 1500)}`);
    return value;
  }
  const SimulatorAction = Type.Union([Type.Literal("create"), Type.Literal("boot"), Type.Literal("shutdown"), Type.Literal("reset"), Type.Literal("delete")]);
  type SimulatorAction = Static<typeof SimulatorAction>;
const Orientation = Type.Union([Type.Literal("portrait"), Type.Literal("portrait-upside-down"), Type.Literal("landscape-left"), Type.Literal("landscape-right")]);
type Orientation = Static<typeof Orientation>;
  const Uuid = Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" });
  const Device = Type.Object({ udid: Uuid, name: Type.String(), state: Type.String(), osVersion: Type.String(), set: Type.String() });
  const Slim = Type.Object({ managedDisabled: Type.Integer(), managedTotal: Type.Integer(), booted: Type.Boolean(), persistent: Type.Boolean(), verdict: Type.String() });
  const Owned = Type.Object({ udid: Uuid, name: Type.String(), sourceUdid: Uuid, directory: Type.String(), device: Type.Number(), inode: Type.Number(), born: Type.Number() }, { additionalProperties: false });
  const Receipt = Type.Object({ fingerprint: Type.String(), status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("uncertain")]) }, { additionalProperties: false });
  const Pending = Type.Object({ requestId: Uuid, operation: SimulatorAction, udid: Type.Union([Uuid, Type.Null()]), sourceUdid: Type.Union([Uuid, Type.Null()]) }, { additionalProperties: false });
  const Store = Type.Object({ version: Type.Literal(2), projectId: Uuid, enabled: Type.Boolean(), sourceUdid: Type.Union([Uuid, Type.Null()]), owned: Type.Array(Owned, { maxItems: MAX_OWNED }), pending: Type.Union([Pending, Type.Null()]), uncertain: Type.Union([Type.String(), Type.Null()]), receipts: Type.Record(Type.String(), Receipt) }, { additionalProperties: false });
  const StoreV1 = Type.Object({ version: Type.Literal(1), projectId: Uuid, enabled: Type.Boolean(), sourceUdid: Type.Union([Uuid, Type.Null()]), owned: Type.Union([Owned, Type.Null()]), pending: Type.Union([Type.Object({ requestId: Uuid, operation: SimulatorAction }, { additionalProperties: false }), Type.Null()]), uncertain: Type.Union([Type.String(), Type.Null()]), receipts: Type.Record(Type.String(), Receipt) }, { additionalProperties: false });
  type Store = Static<typeof Store>;
  type Device = Static<typeof Device>;
  type Owned = Static<typeof Owned>;
  const tasks = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  const locks = new Map<string, Promise<void>>();
  const frames = new Map<string, Frame>();
  const captures = new Map<string, Promise<Frame>>();
  const captureControllers = new Set<AbortController>();
  const transitions = new Set<string>();
  function pauseSimulatorManagement(id: string): () => void {
    if (tasks.has(id) || locks.has(id)) throw Error("Wait for simulator management to finish before changing project lifecycle");
    transitions.add(id);
    return () => { transitions.delete(id); };
  }
  let stopping = false;
  const simslim = () => process.env.PI_PROJECTS_SIMSLIM || "/opt/homebrew/bin/simslim";
  const xcode = () => process.env.PI_PROJECTS_XCODEBUILDMCP || "/opt/homebrew/bin/xcodebuildmcp";
  const deviceRoot = () => join(homedir(), "Library/Developer/CoreSimulator/Devices");
  const simulatorEnabled = (id: string) => readStore(id).enabled;

  /** Management is on by default; the owner may turn it off (keeping the clones and all their data) or pin the default clone source. */
  async function configureSimulator(id: string, input: { enabled: boolean; sourceUdid?: string; requestId: string }) {
    await locked(id, async () => {
      activeProject(id);
      const store = readStore(id), fingerprint = JSON.stringify({ enabled: input.enabled, sourceUdid: input.sourceUdid?.toUpperCase() ?? null });
      if (repeated(store, input.requestId, fingerprint)) return;
      if (store.pending || tasks.has(id)) throw Error("Simulator operation is still running or unresolved");
      if (input.sourceUdid) {
        const source = (await inventory()).find(device => device.udid === input.sourceUdid?.toUpperCase() && device.set === "default");
        if (!source) throw Error("Choose an available iOS simulator in the default device set");
        store.sourceUdid = source.udid;
      }
      store.enabled = input.enabled;
      store.receipts[input.requestId] = { fingerprint, status: "done" };
      writeStore(id, store);
      dropFrames(id);
    });
    return simulatorSnapshot(id);
  }

  /** Owner acknowledgement never replays an effect or adopts an unrecorded device. */
  async function recoverSimulator(id: string, input: { confirm: string; requestId: string }) {
    await locked(id, async () => {
      activeProject(id);
      if (input.confirm !== id) throw Error("Simulator recovery requires confirmation matching the project ID");
      if (tasks.has(id)) throw Error("Wait for simulator management to finish before acknowledging its outcome");
      const store = readStore(id), fingerprint = JSON.stringify({ recover: true, confirm: id });
      if (repeated(store, input.requestId, fingerprint)) return;
      if (!store.uncertain) throw Error("There is no uncertain simulator outcome to acknowledge");
      const devices = await inventory();
      saveJson(join(projectDir(id), `simulator-recovery-${input.requestId}.json`), store);
      const kept: Owned[] = [];
      for (const owned of store.owned) { try { await ownedDevice(owned, devices); kept.push(owned); } catch { /* released; the receipt above keeps it for inspection */ } }
      store.owned = kept;
      if (store.pending) store.receipts[store.pending.requestId].status = "uncertain";
      store.pending = null;
      store.uncertain = null;
      store.receipts[input.requestId] = { fingerprint, status: "done" };
      writeStore(id, store);
      dropFrames(id);
    });
    return simulatorSnapshot(id);
  }

  /** Accept once, persist the intent, then run outside the host request. Unknown outcomes never replay. */
  async function actOnSimulator(id: string, operation: SimulatorAction, requestId: string, target: SimulatorTarget = {}) {
    await locked(id, async () => {
      activeProject(id);
      const store = readStore(id), wanted = { udid: target.udid?.toUpperCase() ?? null, sourceUdid: target.sourceUdid?.toUpperCase() ?? null };
      const fingerprint = JSON.stringify({ operation, ...(wanted.udid || wanted.sourceUdid ? wanted : {}) });
      if (repeated(store, requestId, fingerprint)) return;
      if (!store.enabled) throw Error("Simulator management was turned off by the owner");
      if (store.uncertain) throw Error(store.uncertain);
      if (store.pending || tasks.has(id)) throw Error("A simulator operation is already running");
      const devices = await inventory();
      let udid: string | null = null, sourceUdid: string | null = null, resource: string;
      if (operation === "create") {
        if (store.owned.length >= MAX_OWNED) throw Error(`This project already owns ${MAX_OWNED} simulators; delete one first`);
        // An explicit source, else the owner's pin, else the newest shut-down iPhone. The source itself is never changed.
        sourceUdid = wanted.sourceUdid ?? store.sourceUdid ?? defaultSource(devices)?.udid ?? null;
        const source = devices.find(device => device.udid === sourceUdid && device.set === "default");
        if (!source) throw Error("Choose a source from the default device set (sources in projects_simulator_status)");
        if (store.owned.some(owned => owned.udid === source.udid)) throw Error("Clone a source simulator, not one of this project's clones");
        if (source.state !== "Shutdown") throw Error(`Source ${source.name} must be shut down; it will not be changed automatically`);
        resource = `simulator-create:${id}`;
      } else {
        const owned = targetOf(store, wanted.udid);
        await ownedDevice(owned, devices);
        const held = aliasesHeld(owned);
        if (held.length) throw Error(`Simulator ${owned.udid} is leased by thread ${held[0].threadId}; ask that worker to release it, or wait`);
        udid = owned.udid; resource = simulatorResource(owned.udid);
      }
      const holder = { projectId: id, owner: `maintenance:${requestId}` };
      const lease = await api.leases.acquire(resource, holder, 30 * 60_000);
      if (!lease.acquired) throw Error(`Simulator is leased by thread ${lease.heldBy.threadId}`);
      const abort = new AbortController();
      try {
        store.pending = { requestId, operation, udid, sourceUdid };
        store.receipts[requestId] = { fingerprint, status: "running" };
        writeStore(id, store);
        dropFrames(id);
      } catch (error) { api.leases.release(resource, holder); throw error; }
      const promise = perform(id, store, abort.signal).finally(() => {
        api.leases.release(resource, holder);
        tasks.delete(id);
      });
      tasks.set(id, { promise, abort });
      void promise.catch(error => process.stderr.write(JSON.stringify({ event: "simulator-operation-failed", projectId: id, error: message(error) }) + "\n"));
    });
    return simulatorSnapshot(id);
  }

  async function simulatorSnapshot(id: string) {
    loadProject(id);
    const store = readStore(id);
    let devices: Device[] = [], error = store.uncertain;
    try { devices = await inventory(); } catch (failure) { error ??= message(failure); }
    const owned = await Promise.all(store.owned.map(async item => {
      try {
        const actual = await ownedDevice(item, devices);
        const busy = store.pending?.udid === item.udid;
        const slim = actual.state === "Booted" && !busy ? parse(Slim, JSON.parse(await command(simslim(), ["status", actual.udid, "--json"]))) : null;
        return { ...actual, sourceUdid: item.sourceUdid, resource: simulatorResource(item.udid), slim, lease: aliasesHeld(item)[0] ?? null, capturedAt: frames.get(frameKey(id, item.udid))?.capturedAt ?? null, problem: null };
      } catch (failure) { return { udid: item.udid, name: item.name, state: "Unknown", osVersion: "", set: "default", sourceUdid: item.sourceUdid, resource: simulatorResource(item.udid), slim: null, lease: aliasesHeld(item)[0] ?? null, capturedAt: null, problem: message(failure) }; }
    }));
    const pending = store.pending?.operation ?? null;
    const status = store.uncertain ? "uncertain" : pending === "create" ? "creating" : pending === "boot" ? "preparing" : pending ? "working" : error ? "error" : owned.length ? "ready" : "none";
    const mine = new Set(store.owned.map(item => item.udid));
    return { enabled: store.enabled, sourceUdid: store.sourceUdid, defaultSourceUdid: store.sourceUdid ?? defaultSource(devices)?.udid ?? null, maxOwned: MAX_OWNED, status, devices: owned, sources: devices.filter(item => item.set === "default" && !mine.has(item.udid)), operation: store.pending, error };
  }

  async function simulatorFrame(id: string, udid?: string): Promise<Frame> {
    activeProject(id);
    const store = readStore(id);
    if (!store.enabled || store.uncertain) throw Error("No enabled, settled simulator is available");
    const owned = targetOf(store, udid?.toUpperCase() ?? null, true);
    if (store.pending?.udid === owned.udid || store.pending?.operation === "create") throw Error("Simulator operation is running");
    const device = await ownedDevice(owned, await inventory());
    if (device.state !== "Booted") throw Error("Project simulator is not booted");
    const key = frameKey(id, owned.udid), cached = frames.get(key);
    if (cached && Date.now() - cached.capturedAt < 4000) return cached;
    const existing = captures.get(key);
    if (existing) return existing;
    const abort = new AbortController();
    captureControllers.add(abort);
    const pending = capture(id, device.udid, abort.signal).finally(() => { captures.delete(key); captureControllers.delete(abort); });
    captures.set(key, pending);
    return pending;
  }

  /** Rotates a booted owned clone. `allow` sees the resolved UDID first and throws to refuse (lease rules live with the tools). */
  async function rotateSimulator(id: string, udid: string | undefined, orientation: Orientation, allow: (udid: string) => void) {
    activeProject(id);
    const store = readStore(id);
    if (!store.enabled || store.uncertain) throw Error("No enabled, settled simulator is available");
    const owned = targetOf(store, udid?.toUpperCase() ?? null, true);
    if (store.pending?.udid === owned.udid || store.pending?.operation === "create") throw Error("Simulator operation is running");
    allow(owned.udid);
    const device = await ownedDevice(owned, await inventory());
    if (device.state !== "Booted") throw Error("Project simulator is not booted");
    const abort = new AbortController();
    captureControllers.add(abort);
    try { await command(await rotateHelper(), [device.udid, orientation], abort.signal, 15000); }
    finally { captureControllers.delete(abort); }
    frames.delete(frameKey(id, owned.udid));
    return { udid: owned.udid, orientation };
  }
  let helper: Promise<string> | undefined;
  /** Compiles rotate.swift once per source version into .build/; a failed build is retried on the next call. */
  function rotateHelper(): Promise<string> {
    helper ??= (async () => {
      const source = fileURLToPath(new URL("rotate.swift", import.meta.url));
      const binary = join(dirname(source), ".build", `rotate-${createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12)}`);
      if (existsSync(binary)) return binary;
      mkdirSync(dirname(binary), { recursive: true, mode: 0o700 });
      const temp = `${binary}.${randomUUID()}.tmp`;
      try { await command("/usr/bin/xcrun", ["swiftc", "-O", "-o", temp, source], undefined, 300000); renameSync(temp, binary); }
      finally { rmSync(temp, { force: true }); }
      return binary;
    })().catch(error => { helper = undefined; throw error; });
    return helper;
  }

  async function closeSimulators(): Promise<void> {
    stopping = true;
    for (const { abort } of tasks.values()) abort.abort();
    for (const abort of captureControllers) abort.abort();
    await Promise.allSettled([...tasks.values()].map(task => task.promise).concat([...captures.values()].map(promise => promise.then(() => {}))));
    frames.clear();
  }

  async function perform(id: string, store: Store, signal: AbortSignal): Promise<void> {
    const pending = store.pending;
    if (!pending) return;
    let createdResource: string | null = null;
    const holder = { projectId: id, owner: `maintenance:${pending.requestId}` };
    try {
      const operation = pending.operation;
      if (operation === "create") {
        const source = pending.sourceUdid ?? "";
        const name = `pi-projects ${id.slice(0, 8)} ${pending.requestId}`;
        const receipt = parse(Type.Object({ action: Type.Literal("clone"), udid: Uuid, sourceUdid: Uuid, name: Type.String() }), JSON.parse(await command(simslim(), ["clone", source, name, "--json"], signal, 180000)));
        if (receipt.sourceUdid.toUpperCase() !== source || receipt.name !== name || receipt.udid.toUpperCase() === source) throw Error("Clone returned a different identity");
        const udid = receipt.udid.toUpperCase(), physical = physicalDevice(udid);
        const lease = await api.leases.acquire(simulatorResource(udid), holder, 30 * 60_000);
        if (!lease.acquired) throw Error("New clone is already leased; creation outcome requires inspection");
        createdResource = simulatorResource(udid);
        const owned = { udid, name, sourceUdid: source, ...physical };
        store.owned.push(owned);
        writeStore(id, store);
        await ownedDevice(owned, await inventory(signal));
        await command(simslim(), ["on", udid], signal, 660000);
        await confirmedSlim(udid, signal);
      } else {
        const owned = targetOf(store, pending.udid);
        const device = await ownedDevice(owned, await inventory(signal));
        switch (operation) {
          case "boot": await command(simslim(), ["on", device.udid], signal, 660000); await confirmedSlim(device.udid, signal); break;
          case "shutdown":
            if (device.state !== "Shutdown") await command(simslim(), ["shutdown", device.udid, "--json"], signal, 120000);
            if ((await ownedDevice(owned, await inventory(signal))).state !== "Shutdown") throw Error("Shutdown was not confirmed");
            break;
          case "reset":
            if (device.state !== "Shutdown") await command(simslim(), ["shutdown", device.udid, "--json"], signal, 120000);
            await ownedDevice(owned, await inventory(signal));
            await command(simslim(), ["erase", device.udid, "--json"], signal, 180000);
            await ownedDevice(owned, await inventory(signal));
            await command(simslim(), ["on", device.udid], signal, 660000);
            await confirmedSlim(device.udid, signal);
            break;
          case "delete":
            if (device.state !== "Shutdown") await command(simslim(), ["shutdown", device.udid, "--json"], signal, 120000);
            await ownedDevice(owned, await inventory(signal));
            await command(simslim(), ["delete", device.udid, "--json"], signal, 120000);
            if ((await inventory(signal)).some(item => item.udid === device.udid) || existsSync(owned.directory)) throw Error("Simulator deletion was not confirmed");
            store.owned = store.owned.filter(item => item.udid !== owned.udid);
            break;
          default: { const exhaustive: never = operation; throw Error(String(exhaustive)); }
        }
      }
      store.receipts[pending.requestId].status = "done";
      store.pending = null;
      writeStore(id, store);
    } catch (error) {
      store.uncertain = `Simulator ${pending.operation} outcome is unknown. Inspect the owned device before recovery: ${message(error)}`;
      store.receipts[pending.requestId].status = "uncertain";
      writeStore(id, store);
    } finally {
      if (createdResource) api.leases.release(createdResource, holder);
    }
  }
  async function capture(id: string, udid: string, signal: AbortSignal): Promise<Frame> {
    const result = parse(Type.Object({ didError: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]), data: Type.Optional(Type.Object({ artifacts: Type.Object({ simulatorId: Uuid, screenshotPath: Type.Optional(Type.String()) }), capture: Type.Optional(Type.Object({ format: Type.String() })) })) }), JSON.parse(await command(xcode(), ["ui-automation", "screenshot", "--simulator-id", udid, "--return-format", "path", "--output", "json"], signal, 60000)));
    const path = result.data?.artifacts.screenshotPath;
    if (result.didError || !path || result.data?.artifacts.simulatorId.toUpperCase() !== udid) throw Error(result.error ?? "Capture returned no project simulator image");
    // XcodeBuildMCP owns this temporary file. Never accept an arbitrary file from the request.
    if (!/^screenshot_(?:optimized_)?[a-f0-9-]+\.(?:png|jpg)$/.test(basename(path))) throw Error("Unexpected capture filename");
    let bytes: Buffer;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1024 * 1024) throw Error("Invalid screenshot file");
      bytes = await readFile(path);
    } finally { await unlink(path); }
    activeProject(id);
    const store = readStore(id);
    const owned = store.owned.find(item => item.udid === udid);
    if (!store.enabled || store.pending?.udid === udid || store.uncertain || !owned) throw Error("Simulator changed during capture");
    await ownedDevice(owned, await inventory());
    const mime = result.data?.capture?.format;
    if (mime !== "image/jpeg" && mime !== "image/png") throw Error("Unsupported screenshot format");
    const frame: Frame = { bytes, mime, capturedAt: Date.now() };
    frames.set(frameKey(id, udid), frame);
    return frame;
  }
  async function confirmedSlim(udid: string, signal: AbortSignal) {
    const slim = parse(Slim, JSON.parse(await command(simslim(), ["status", udid, "--json"], signal)));
    if (!slim.booted || slim.verdict !== "slim") throw Error("simslim did not confirm a booted slim simulator");
  }
  async function inventory(signal?: AbortSignal): Promise<Device[]> {
    const devices = parse(Type.Array(Device), JSON.parse(await command(simslim(), ["list", "--json"], signal)));
    return devices.map(item => ({ ...item, udid: item.udid.toUpperCase() }));
  }
  function defaultSource(devices: Device[]): Device | undefined {
    const version = (device: Device) => device.osVersion.split(".").map(Number);
    return devices.filter(device => device.set === "default" && device.state === "Shutdown" && device.name.startsWith("iPhone"))
      .sort((a, b) => { const [x, y] = [version(a), version(b)]; return (y[0] - x[0]) || ((y[1] ?? 0) - (x[1] ?? 0)) || a.name.localeCompare(b.name); })[0];
  }
  /** The clone an action names; without a UDID only when the project owns exactly one. */
  function targetOf(store: Store, udid: string | null, preferBooted = false): Owned {
    if (udid) {
      const found = store.owned.find(item => item.udid === udid);
      if (!found) throw Error(`Simulator ${udid} is not one of this project's clones`);
      return found;
    }
    if (store.owned.length === 1 || (preferBooted && store.owned.length)) return store.owned[0];
    throw Error(store.owned.length ? "This project owns several simulators; pass the udid" : "This project has no owned simulator");
  }
  const frameKey = (id: string, udid: string) => `${id}:${udid}`;
  function dropFrames(id: string) { for (const key of frames.keys()) if (key.startsWith(`${id}:`)) frames.delete(key); }
  async function ownedDevice(owned: Owned, devices: Device[]): Promise<Device> {
    const actual = devices.find(item => item.udid === owned.udid && item.name === owned.name && item.set === "default");
    const physical = physicalDevice(owned.udid);
    if (!actual || JSON.stringify(physical) !== JSON.stringify({ directory: owned.directory, device: owned.device, inode: owned.inode, born: owned.born })) throw Error("Owned simulator identity changed; refusing simulator access");
    return actual;
  }
  function physicalDevice(udid: string) {
    const path = join(deviceRoot(), udid), info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw Error("Simulator directory is not owner-controlled");
    return { directory: realpathSync(path), device: info.dev, inode: info.ino, born: info.birthtimeMs };
  }
  function aliasesHeld(owned: Owned) {
    const keys = new Set([simulatorResource(owned.udid).toLowerCase(), owned.udid.toLowerCase(), owned.name.toLowerCase()]);
    return api.leases.held().filter(lease => keys.has(lease.resource.toLowerCase()));
  }
  function activeProject(id: string) {
    if (stopping) throw Error("Host is stopping");
    if (transitions.has(id)) throw Error("Project lifecycle is changing");
    const project = loadProject(id);
    if (project.deleted || project.archived) throw Error("Inactive project cannot manage its simulator");
    return project;
  }
  function statePath(id: string) {
    const dir = projectDir(id);
    if (lstatSync(dir).isSymbolicLink()) throw Error("Project state directory must not be a symlink");
    const path = join(dir, "simulator.json");
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error("Simulator state must not be a symlink");
    return path;
  }
  function readStore(id: string): Store {
    const path = statePath(id);
    const raw = existsSync(path) ? readJson(path) as { version?: number } : null;
    const store: Store = !raw ? { version: 2, projectId: id, enabled: true, sourceUdid: null, owned: [], pending: null, uncertain: null, receipts: {} } : raw.version === 1 ? migrate(parse(StoreV1, raw)) : parse(Store, raw);
    if (store.projectId !== id) throw Error("Simulator ownership belongs to another project");
    if (store.owned.some(owned => owned.udid === owned.sourceUdid)) throw Error("Invalid simulator ownership receipt");
    if (store.pending && !tasks.has(id)) {
      store.uncertain ??= `Simulator ${store.pending.operation} was interrupted. Its outcome must be inspected before recovery.`;
    }
    return store;
  }
  function migrate(old: Static<typeof StoreV1>): Store {
    return { ...old, version: 2, owned: old.owned ? [old.owned] : [], pending: old.pending ? { ...old.pending, udid: old.pending.operation === "create" ? null : old.owned?.udid ?? null, sourceUdid: old.pending.operation === "create" ? old.sourceUdid : null } : null };
  }
  function writeStore(id: string, store: Store) { saveJson(statePath(id), parse(Store, store)); }
  function repeated(store: Store, requestId: string, fingerprint: string): boolean {
    parse(Uuid, requestId);
    const prior = store.receipts[requestId];
    if (!prior) {
      if (Object.keys(store.receipts).length >= 4096) throw Error("Simulator request ledger is full; retain it and inspect before further changes");
      return false;
    }
    if (prior.fingerprint !== fingerprint) throw Error("Simulator request ID was already used for another intent");
    return true;
  }
  async function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>(resolve => { release = resolve; });
    locks.set(id, current);
    await previous;
    try { return await fn(); } finally { release(); if (locks.get(id) === current) locks.delete(id); }
  }
  function command(file: string, args: string[], signal?: AbortSignal, timeout = 30000): Promise<string> {
    return new Promise((resolve, reject) => execFile(file, args, { encoding: "utf8", timeout, signal, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Error(`${basename(file)} failed: ${(stderr || error.message).trim().slice(0, 1000)}`));
      else resolve(stdout);
    }));
  }
  function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
  return { SimulatorAction, Orientation, MAX_OWNED, rotate: rotateSimulator, enabled: simulatorEnabled, configure: configureSimulator, recover: recoverSimulator, act: actOnSimulator, snapshot: simulatorSnapshot, frame: simulatorFrame, pause: pauseSimulatorManagement, close: closeSimulators };
}
