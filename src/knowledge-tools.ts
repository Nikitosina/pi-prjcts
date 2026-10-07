import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { historyKnowledge, knowledgeContext, listKnowledge, readKnowledge, writeKnowledge } from "./knowledge.ts";

const path = Type.String({ minLength: 1, maxLength: 240 });
const offset = Type.Optional(Type.Integer({ minimum: 0 }));

export function knowledgeTools(pi: ExtensionAPI, dir: string, author: string): void {
  pi.registerTool({
    name: "projects_knowledge_list", label: "List project knowledge", description: "Find shared Markdown knowledge by path. Read only the documents needed for this task. Returns a bounded page of metadata, not file contents.",
    parameters: Type.Object({ prefix: Type.Optional(Type.String({ maxLength: 240 })), offset, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    async execute(_id, input) {
      const files = (await listKnowledge(dir)).filter(file => !input.prefix || file.path.startsWith(input.prefix));
      const start = input.offset ?? 0;
      const end = start + (input.limit ?? 40);
      return result({ files: files.slice(start, end), nextOffset: end < files.length ? end : null });
    },
  });
  pi.registerTool({
    name: "projects_knowledge_read", label: "Read project knowledge", description: "Read a shared Markdown document on demand. The revision is required to update it safely. Use offset and limit to page through longer documents; offsets count Unicode characters.",
    parameters: Type.Object({ path, offset, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })) }),
    async execute(_id, input) {
      if (input.path === "MEMORY.md") await knowledgeContext(dir);
      const file = await readKnowledge(dir, input.path);
      const chars = [...file.text];
      if (input.path === "MEMORY.md" && chars.length > 3000) throw new Error("MEMORY.md exceeds the 3000 Unicode character limit; ask the owner to repair it.");
      const start = input.offset ?? 0;
      const end = start + (input.limit ?? 4000);
      return result({ path: file.path, revision: file.revision, text: chars.slice(start, end).join(""), nextOffset: end < chars.length ? end : null });
    },
  });
  pi.registerTool({
    name: "projects_knowledge_write", label: "Update project knowledge", description: "Save verified findings in a shared Markdown file. Read its current revision first; expectedRevision=null only creates a new file. Stale revisions fail instead of overwriting another agent or owner. The master curates MEMORY.md and preferences.md; workers update topic files.",
    parameters: Type.Object({ path, text: Type.String({ maxLength: 32000 }), expectedRevision: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]) }),
    async execute(_id, input) {
      if (author === "worker" && ["MEMORY.md", "preferences.md"].includes(input.path)) throw new Error("The master curates the memory index and preferences. Report the proposed change to the coordinator.");
      const file = await writeKnowledge({ dir, author, ...input });
      return result({ path: file.path, revision: file.revision });
    },
  });
  pi.registerTool({
    name: "projects_knowledge_history", label: "Project knowledge history", description: "Inspect document revisions and authors on demand. Returns a bounded page of revision metadata.",
    parameters: Type.Object({ path, offset }),
    async execute(_id, input) {
      const revisions = (await historyKnowledge(dir, input.path)).toReversed().map(({ text, priorText, ...revision }) => revision);
      const start = input.offset ?? 0;
      return result({ revisions: revisions.slice(start, start + 20), nextOffset: start + 20 < revisions.length ? start + 20 : null });
    },
  });
}

function result(value: unknown): { content: { type: "text"; text: string }[]; details: undefined } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: undefined };
}
