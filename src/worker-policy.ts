import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import { addNote, notes } from "./state.ts";
import { captureEvidence } from "./evidence.ts";
import { knowledgeContext } from "./knowledge.ts";
import { knowledgeTools } from "./knowledge-tools.ts";

export const workRules = `Work only in the assigned workspace. Edit and run verification as needed. Ask the coordinator about missing requirements or blocked actions. Leave publishing, commits, PR creation, deployment, and destructive operations to the human. Prefer E2E verification and return a repeatable command plus artifact paths. Save verification evidence (screenshots, videos, logs, reports) in your artifacts folder when you are given one, and list the saved files in your result. Use Arc rather than Git in Arcadia. Read applicable skills and project instructions. Read shared topic documents on demand with projects_knowledge_read. Save verified topic findings with projects_knowledge_write using the current revision, and leave index/preferences changes to the coordinator. projects_note records a short audit finding or artifact pointer, not the authoritative knowledge base. Shell command checks are guardrails, not a sandbox.`;

export function noteTools(pi: ExtensionAPI, dir: string, author: string): void {
  knowledgeTools(pi, dir, author);
  pi.registerTool({
    name: "projects_note", label: "Project note", description: "Save a verified finding, decision, or artifact pointer to this project's shared knowledge. Each note is immutable.",
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 4000 }) }),
    async execute(_id, input) {
      return { content: [{ type: "text", text: JSON.stringify(addNote(dir, author, input.text)) }], details: undefined };
    },
  });
  pi.registerTool({
    name: "projects_notes", label: "Project knowledge", description: "Read recent immutable audit notes on demand. Use projects_knowledge_read for maintained project knowledge.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: JSON.stringify(notes(dir).slice(-40)) }], details: undefined };
    },
  });
}

export function workerPolicy({ root, dir }: { root: string; dir: string }) {
  return (pi: ExtensionAPI) => {
    initTheme("light", false);
    noteTools(pi, dir, "worker");
    pi.registerTool({
      name: "projects_evidence", label: "Capture project evidence", description: "Attach a verification file from this workspace to the decision inbox. Saves an immutable copy, up to 10 MiB. Never attach credentials or private unrelated files.",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1, maxLength: 500 }) }),
      async execute(_id, input, _signal, _update, ctx) {
        const record = await captureEvidence({ root, dir, path: input.path, title: input.title, sessionFile: ctx.sessionManager.getSessionFile() ?? null });
        return { content: [{ type: "text", text: JSON.stringify(record) }], details: record };
      },
    });
    pi.on("before_agent_start", async event => ({ systemPrompt: event.systemPrompt + "\n" + workRules + "\nShared project knowledge:\n" + await knowledgeContext(dir) }));
    pi.on("before_provider_request", async (_event, ctx) => {
      try { await knowledgeContext(dir); }
      catch (error) { ctx.abort(); throw error; }
    });
    pi.on("tool_call", event => {
      if ((event.toolName === "write" || event.toolName === "edit") && typeof event.input.path === "string" && !within(root, event.input.path)) {
        return { block: true, reason: "File mutations must remain inside the assigned workspace, including symlink targets. Ask the coordinator." };
      }
      if (event.toolName === "bash" && typeof event.input.command === "string") {
        const command = event.input.command;
        if (/\b(?:sudo|shutdown|reboot)\b|\brm\b[^\n]*(?:-[a-zA-Z]*[rf]|--recursive|--force)|\b(?:git|arc)\b[^\n]*(?:\b(?:commit|push|reset|clean|rebase|checkout|switch|revert)\b)|\b(?:gh|ya\s+tool\s+arcanum)\b[^\n]*\b(?:create|merge|publish|update)\b|\b(?:kubectl|terraform)\b[^\n]*\b(?:apply|delete|destroy)\b|\b(?:deploy|publish)\b/i.test(command)) {
          return { block: true, reason: "Publishing or destructive commands require human approval outside the MVP. Ask the coordinator; do not bypass this check." };
        }
      }
    });
  };
}

function within(root: string, path: string): boolean {
  const target = resolve(root, path);
  let parent = target;
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
  const canonical = resolve(realpathSync(parent), relative(parent, target));
  const suffix = relative(realpathSync(root), canonical);
  return suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix);
}
