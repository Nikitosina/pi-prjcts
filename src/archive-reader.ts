import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { apply } from "@earendil-works/chord/delta";
import {
  readTranscriptImage,
  readTranscriptPage,
  readTranscriptText,
  type RawEntry,
  type TranscriptPage,
  type TranscriptSource,
} from "./transcript-reader.ts";

/**
 * Read-only view of an old host's chats and worker conversations. It opens each project's `durable.sqlite` with SQLite's read-only mode
 * and never goes through pi-durable's storage, so nothing is migrated, locked for writing or created. Point it at a copy when the old host may still run.
 */
export type ArchiveProject = { projectId: string; name: string; bytes: number };
export type ArchiveChat = { id: string; title: string; conversationId: number; createdAt: number; archived: boolean; main: boolean };
export type ArchiveWorker = {
  id: string;
  threadId: string;
  role: string;
  status: string;
  task: string;
  conversationId: number;
  chatConversationId: number | null;
  startedAt: number | null;
};
export type ArchiveProjectReader = {
  projectId: string;
  /** What could not be read (missing documents, unknown layouts); listing never throws for those. */
  warnings: string[];
  chats(): ArchiveChat[];
  workers(): ArchiveWorker[];
  /** Newest page first; pass the returned `before` for older ones. */
  page(conversationId: number, options?: { before?: number | null; limit?: number }): Promise<TranscriptPage>;
  text(conversationId: number, ref: string, range?: { offset?: number; limit?: number }): ReturnType<typeof readTranscriptText>;
  image(conversationId: number, ref: string): ReturnType<typeof readTranscriptImage>;
  close(): void;
};

const TASK_CHARS = 240;

/** Projects of an old home: every folder with a `durable.sqlite`. */
export function listArchiveProjects(home: string): ArchiveProject[] {
  return readdirSync(home, { withFileTypes: true }).flatMap((dir) => {
    const file = join(home, dir.name, "durable.sqlite");
    if (!dir.isDirectory() || !existsSync(file)) return [];
    let name = dir.name;
    try {
      const saved = JSON.parse(readFileSync(join(home, dir.name, "project.json"), "utf8")) as { name?: unknown };
      if (typeof saved.name === "string") name = saved.name;
    } catch {
      // A project without a readable project.json is still archived under its folder name.
    }
    return [{ projectId: dir.name, name, bytes: statSync(file).size }];
  });
}

export function openArchiveProject(home: string, projectId: string): ArchiveProjectReader {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(projectId)) throw new Error("Invalid archive project id");
  const file = join(home, projectId, "durable.sqlite");
  if (!existsSync(file)) throw new Error("Archive project has no durable.sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA query_only = 1");
  const warnings: string[] = [];
  const newest = db.prepare("SELECT record FROM entries WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?"),
    one = db.prepare("SELECT record FROM entries WHERE conversation_id = ? AND id = ?");
  const source: TranscriptSource = {
    newest: (conversationId, before, limit) =>
      newest
        .all(conversationId, before ?? Number.MAX_SAFE_INTEGER, limit)
        .map((row) => JSON.parse((row as { record: string }).record) as RawEntry),
    entry: (conversationId, entryId) => {
      const row = one.get(conversationId, entryId) as { record: string } | undefined;
      return row ? (JSON.parse(row.record) as RawEntry) : undefined;
    },
  };

  /** Latest value of a document: its newest base plus the deltas after it. Null when absent or unreadable. */
  const document = (kind: string): { owner: number; value: Record<string, unknown> } | null => {
    try {
      const doc = db.prepare("SELECT id, owner_id FROM documents WHERE kind = ? ORDER BY id DESC LIMIT 1").get(JSON.stringify(kind)) as
        { id: number; owner_id: number } | undefined;
      if (!doc) return null;
      const base = db
        .prepare("SELECT seq, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1")
        .get(doc.id) as { seq: number; content: string } | undefined;
      if (!base) throw new Error("no base revision");
      let value = JSON.parse(base.content) as never;
      for (const row of db
        .prepare("SELECT content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq")
        .iterate(doc.id, base.seq))
        value = apply(value, JSON.parse((row as { content: string }).content));
      return { owner: doc.owner_id, value: value as Record<string, unknown> };
    } catch (error) {
      warnings.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
  const num = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);

  // The archive never changes while open, so each listing is built once.
  const once = <T>(build: () => T): (() => T) => {
    let value: { done: T } | undefined;
    return () => (value ??= { done: build() }).done;
  };
  return {
    projectId,
    warnings,
    chats: once(() => {
      const doc = document("projects.chats");
      if (!doc) return [];
      const stored = Array.isArray(doc.value.chats) ? (doc.value.chats as Record<string, unknown>[]) : [];
      return [
        { id: "main", title: str(doc.value.mainTitle) || "Main", conversationId: doc.owner, createdAt: 0, archived: false, main: true },
        ...stored.flatMap((chat) => {
          const conversationId = num(chat.conversationId);
          return conversationId === null
            ? []
            : [
                {
                  id: str(chat.id),
                  title: str(chat.title, "Chat"),
                  conversationId,
                  createdAt: num(chat.createdAt) ?? 0,
                  archived: chat.archivedAt !== undefined,
                  main: false,
                },
              ];
        }),
      ];
    }),
    workers: once(() => {
      const planning = document("projects.durable-planning")?.value.work as Record<string, Record<string, unknown>> | undefined;
      if (planning && typeof planning === "object")
        return Object.values(planning).flatMap((item) => {
          const conversationId = num(item.conversationId);
          return conversationId === null
            ? []
            : [
                {
                  id: str(item.id),
                  threadId: str(item.threadId),
                  role: str(item.role, "worker"),
                  status: str(item.status),
                  task: str(item.text).slice(0, TASK_CHARS),
                  conversationId,
                  chatConversationId: num(item.chatConversationId),
                  startedAt: num(item.startedAt),
                },
              ];
        });
      // Older hosts kept only a name → conversation registry.
      const agents = document("projects.workers")?.value.agents as Record<string, { conversationId?: unknown }> | undefined;
      return Object.entries(agents ?? {}).flatMap(([name, agent]) => {
        const conversationId = num(agent.conversationId);
        return conversationId === null
          ? []
          : [{ id: name, threadId: name, role: "worker", status: "", task: "", conversationId, chatConversationId: null, startedAt: null }];
      });
    }),
    page: (conversationId, options) => readTranscriptPage(source, conversationId, options),
    text: (conversationId, ref, range) => readTranscriptText(source, conversationId, ref, range),
    image: (conversationId, ref) => readTranscriptImage(source, conversationId, ref),
    close: () => db.close(),
  };
}
