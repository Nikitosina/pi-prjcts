import type { CommitPublication } from "@earendil-works/pi-durable";

/** What a browser refetches: one topic per read model. `chat` and `jobs` carry the chat id or agent id they concern so a view can ignore the rest. */
export type Topic = "chat" | "jobs" | "knowledge" | "settings";
/** Host-level read models, published under HOST_FEED (docs/ui2-contract.md). */
export type HostTopic = "ui" | "tiers" | "projects" | "host-agent" | "approvals";
export type FeedEvent = { topic: Topic | HostTopic; chat?: string; thread?: string };
/** The reserved feed key of host topics; never a project id (those are UUIDs). */
export const HOST_FEED = "host";
export const publishHost = (topic: HostTopic): void => feed.publish(HOST_FEED, { topic });
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
export function topicsOfCommit(publication: CommitPublication, map: TopicMap): FeedEvent[] {
  const seen = new Map<string, FeedEvent>();
  const add = (event: FeedEvent) => seen.set(`${event.topic}:${event.chat ?? ""}:${event.thread ?? ""}`, event);
  const conversation = (id: number) => {
    const chat = id === map.rootId ? "main" : map.chats.get(id),
      agent = map.agents.get(id);
    if (chat) add({ topic: "chat", chat });
    else if (agent) add({ topic: "jobs", thread: agent });
  };
  for (const change of publication.changes) {
    if (change.type === "entry" || change.type === "submission") conversation(Number(change.value.conversationId));
    else if (change.type === "document") {
      if (change.record.kind === CHATS_KIND) add({ topic: "chat", chat: "*" });
      else if (change.record.kind === JOBS_KIND) add({ topic: "jobs" });
    }
  }
  return [...seen.values()];
}
