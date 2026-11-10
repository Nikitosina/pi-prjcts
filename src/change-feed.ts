import type { CommitPublication } from "@earendil-works/pi-durable";

/** What a browser refetches: one topic per read model. `chat` and `jobs` carry the chat id or agent id they concern so a view can ignore the rest. */
export type Topic = "chat" | "jobs" | "knowledge" | "settings";
/** Topics published under the reserved key `HOST_FEED`: host-wide read models, not one project's. */
/** `limits` is the saved provider visibility only; readings never publish (a refresh answers the page that asked). `telegram` is the
 * bot and pairing state (never the token). */
export type HostTopic = "ui" | "tiers" | "host-agent" | "approvals" | "projects" | "limits" | "telegram" | "remote";
/** Where the Host agent asks the browser to look (`ui_focus`). */
export type FocusTarget = { view: string; projectId?: string; chatId?: string; section?: string };
export type ProjectEvent = { topic: Topic; chat?: string; thread?: string };
export type FeedEvent =
  | ProjectEvent
  | { topic: Exclude<HostTopic, "host-agent"> }
  | { topic: "host-agent"; type?: "changed" }
  | ({ topic: "host-agent"; type: "focus" } & FocusTarget);
/** Feed key of host topics; project ids are UUIDs, so it never collides. */
export const HOST_FEED = "host";
/** A host-wide read model changed; the Host agent's focus frames go through `feed.publish` with their target. */
export const publishHost = (topic: HostTopic): void =>
  // Two branches so each narrows to its own FeedEvent member.
  feed.publish(HOST_FEED, topic === "host-agent" ? { topic } : { topic });
type Listener = (event: FeedEvent) => void;

const listeners = new Map<string, Set<Listener>>();
/** In-process pub/sub keyed by project id; listeners must not throw and do their own batching. */
export const feed = {
  publish(projectId: string, event: FeedEvent): void {
    for (const listener of listeners.get(projectId) ?? []) listener(event);
  },
  subscribe(projectId: string, listener: Listener): () => void {
    const set = listeners.get(projectId) ?? new Set<Listener>();
    listeners.set(projectId, set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size && listeners.get(projectId) === set) listeners.delete(projectId);
    };
  },
};

/** Which conversations belong to what; kept by the runtime from the documents themselves, so classifying a commit needs no storage read. */
export type TopicMap = {
  rootId: number;
  chats: Map<number, string>;
  agents: Map<number, string>;
};
export const CHATS_KIND = "projects.chats";
export const JOBS_KIND = "projects.jobs";

/**
 * The feed events of one Pi Durable commit. Committed entries and submission changes of a chat conversation are `chat`; of an agent (or a subagent it started) `jobs`.
 * The chat list and the Jobs document are `chat` and `jobs` too. Streaming deltas live in `pi.live`, which is ignored, so a token stream costs nothing here.
 */
export function topicsOfCommit(publication: CommitPublication, map: TopicMap): ProjectEvent[] {
  const seen = new Map<string, ProjectEvent>();
  const add = (event: ProjectEvent | undefined) => event && seen.set(`${event.topic}:${event.chat ?? ""}:${event.thread ?? ""}`, event);
  for (const change of publication.changes) {
    if (change.type === "entry" || change.type === "submission") add(topicOfConversation(Number(change.value.conversationId), map));
    else if (change.type === "document") {
      if (change.record.kind === CHATS_KIND) add({ topic: "chat", chat: "*" });
      else if (change.record.kind === JOBS_KIND) add({ topic: "jobs" });
    }
  }
  return [...seen.values()];
}

/** The read model a conversation's transcript belongs to: its chat, or the agent that owns it. */
export function topicOfConversation(id: number, map: TopicMap): ProjectEvent | undefined {
  const chat = id === map.rootId ? "main" : map.chats.get(id),
    agent = map.agents.get(id);
  if (chat) return { topic: "chat", chat };
  if (agent) return { topic: "jobs", thread: agent };
  return undefined;
}
