// Every host this inbox shows (REMOTE_SPEC.md, Multi-host inbox): the local host first, then each remote host saved in the local home.
// A host group owns that host's project list, pending approvals and one host change stream; the tree, the Decision inbox and the status
// pill read the groups. `projectHost` is the client of project views: each request goes to the host that listed its project.
import { forgetHost, localHost, remoteHost } from "./api.js";
import { emit, fail, state } from "./state.js";

export const HostState = Object.freeze({
  Connecting: "connecting",
  Online: "online",
  Offline: "offline",
  NeedsUpdate: "needs update",
  Revoked: "revoked",
  NotPaired: "not paired",
  Forgotten: "forgotten",
});

/** `{ key, name, client, entry, state, projects, approvals }`; `client` is null while a remote host makes its first connection. */
export const groups = [
  { key: "local", name: "This machine", client: localHost, entry: null, state: HostState.Online, projects: [], approvals: [] },
];
const frameHandlers = new Set();
const streams = new Map(); // group → host change stream
const loads = new Map(); // group → its list read in flight

export const remoteGroups = () => groups.length > 1;
export const groupOf = (client) => groups.find((group) => group.client === client) ?? null;
export const online = (group) => group.state === HostState.Online;
/** The host listing a project; with a copied home two hosts may list one id, so `preferred` wins when it lists it. */
export function hostOf(projectId, preferred = null) {
  const lists = (group) => group.projects.some((item) => item.id === projectId);
  return (groups.find((group) => group.client === preferred && lists(group)) ?? groups.find(lists))?.client ?? null;
}
/** Host frames of `/changes?project=host` other than the list and approval topics the groups follow themselves. */
export function onHostFrame(handler) {
  frameHandlers.add(handler);
  return () => frameHandlers.delete(handler);
}

function publish() {
  state.projects = groups.flatMap((group) => (online(group) ? group.projects : []));
  emit("projects", state.projects);
}

/** One list read per host at a time; a request during a read runs once more after it, so the newest change is always read. */
export function loadProjects(group = groupOf(state.host) ?? groups[0]) {
  if (!group.client || !online(group)) return Promise.resolve();
  const running = loads.get(group);
  if (running) {
    running.again = true;
    return running.done;
  }
  const read = { again: false, done: null };
  loads.set(group, read);
  read.done = (async () => {
    try {
      do {
        read.again = false;
        const projects = await group.client.call("list");
        if (!groups.includes(group)) return;
        group.projects = projects.filter((item) => !item.archived && !item.deleted);
        publish();
      } while (read.again && online(group));
    } catch (error) {
      if (group.client.local) fail(error);
      else console.warn(group.name, error);
    } finally {
      loads.delete(group);
    }
  })();
  return read.done;
}
export const loadAllProjects = () => Promise.all(groups.map((group) => loadProjects(group)));

async function loadApprovals(group) {
  const result = await group.client.call("approvals-list").catch(() => null);
  if (!Array.isArray(result?.approvals) || !groups.includes(group)) return;
  group.approvals = result.approvals.filter((item) => item.state === "pending");
  emit("decisions", group);
}

function watch(group) {
  streams.get(group)?.stop();
  const stream = group.client.stream("/changes?project=host", (change) => {
    if (change.t === "sync") {
      void loadProjects(group);
      void loadApprovals(group);
    } else if (change.t === "notices") void loadProjects(group);
    else if (change.t === "topic" && change.topic === "projects") void loadProjects(group);
    else if (change.t === "topic" && change.topic === "approvals") void loadApprovals(group);
    for (const handler of frameHandlers) handler(group, change);
  });
  streams.set(group, stream);
}

function drop(group) {
  if (!groups.includes(group)) return;
  streams.get(group)?.stop();
  streams.delete(group);
  groups.splice(groups.indexOf(group), 1);
  publish();
  emit("hosts", group);
}
/** Forget host: the local list entry, the device key and every open view of that host go; other tabs drop it on the broadcast. */
export async function forgetGroup(group) {
  await forgetHost(group.entry.hostId);
  group.client?.close(HostState.Forgotten);
  drop(group);
}

function follow(group) {
  const next = group.client.state ?? HostState.Online;
  if (next === HostState.Forgotten) return drop(group);
  const was = group.state;
  group.state = next;
  if (next === HostState.Online && was !== HostState.Online) watch(group);
  if (next !== HostState.Online) {
    streams.get(group)?.stop();
    streams.delete(group);
    group.approvals = [];
  }
  publish();
  emit("hosts", group);
  if (next === HostState.Online && was !== HostState.Online) emit("host-online", group);
}

/** Local first; remote hosts connect in parallel and never hold back the local group. `entries` is the saved `inbox-hosts` list.
 * Resolves once every remote host has made its first connection and, when online, read its projects. */
export function startHosts(entries) {
  watch(groups[0]);
  const first = entries.map((entry) => {
    const group = { key: entry.hostId, name: entry.name, client: null, entry, state: HostState.Connecting, projects: [], approvals: [] };
    groups.push(group);
    return remoteHost(entry).then(
      async (client) => {
        if (!groups.includes(group)) return;
        group.client = client;
        client.addEventListener("statechange", () => groups.includes(group) && follow(group));
        follow(group);
        await loadProjects(group);
      },
      (error) => {
        console.warn(entry.name, error);
        group.state = HostState.Offline;
        emit("hosts", group);
      },
    );
  });
  emit("hosts");
  return Promise.all(first);
}

function routed(id) {
  return (typeof id === "string" && hostOf(id, state.host)) || state.host || localHost;
}
const pathProject = (path) =>
  new URL(path, location.origin).searchParams.get("project") ?? /^\/artifacts\/([^/]+)\//.exec(path)?.[1] ?? undefined;
/** The client of project views. A project id in the input or path picks its host; anything else goes to the selected project's host. */
export const projectHost = {
  call: (action, input, signal) => routed(input?.projectId ?? input?.id).call(action, input, signal),
  stream: (path, onFrame, onState) => routed(pathProject(path)).stream(path, onFrame, onState),
  url: (path, options) => routed(pathProject(path)).url(path, options),
  authorizedFetch: (path, init) => routed(pathProject(path)).authorizedFetch(path, init),
  /** The client of the host with storage prefix `prefix`: a send names its owner, whatever host is selected when it is retried. */
  owning(prefix) {
    return groups.find((group) => group.client?.storagePrefix === prefix)?.client ?? (prefix === "" ? localHost : this);
  },
  get local() {
    return routed().local;
  },
  get storagePrefix() {
    return routed().storagePrefix;
  },
};
