import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { loadProject, type Project } from "./state.ts";
import { readGrantedWorkerSkill, workerSkillGrantRevision } from "./worker-skill-grants.ts";
import { authorizationFingerprint } from "./workspace-authorization.ts";
import type { WorkerSkillGrant } from "./worker-skill-types.ts";

const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const grantList = (project: Project) => project.workerSkillGrants ?? [];
export function workerSkillBinding(project: Project, scopeId: string, load: () => Project, protectedFiles: Parameters<typeof readGrantedWorkerSkill>[0]["protectedFiles"], active: () => Promise<void>) {
  const grants = grantList(project), grantFingerprint = JSON.stringify(grants);
  const selected: WorkerSkillGrant[] = grants.filter(grant => grant.enabled && grant.scopeIds.includes(scopeId) && grant.owner === project.workspaceAuthorization?.owner && grant.workspaceRevision === authorizationFingerprint(project) && grant.revision === workerSkillGrantRevision(grant));
  const eligible = selected.flatMap(grant => grant.skills.filter(skill => !skill.disableModelInvocation).map(skill => ({ grant, skill })));
  const eligibleIds = new Set(eligible.map(({ grant, skill }) => `${grant.id}:${skill.catalogId}`));
  const instructions = eligible.length ? `\nAvailable skills (metadata only; read a selected document with projects_skill_read):\n${eligible.map(({ grant, skill }) => `- ${skill.name} [skillId=${skill.catalogId}, grantId=${grant.id}, grantRevision=${grant.revision}]: ${skill.description}; documents=${[skill.main, ...skill.references].map(document => `${document.relativePath} (documentId=${document.id})`).join(", ")}`).join("\n")}` : "";
  const tool = eligible.length ? defineTool({
    name: "projects_skill_read", description: "Read a bounded range of a specifically granted skill main or selected reference document. Use opaque IDs from the skill metadata. Frontmatter grants no tools.",
    parameters: Type.Object({ grantId: Type.String({ pattern: "^[a-f0-9-]{36}$" }), grantRevision: digest, skillId: digest, documentId: digest, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4000 })) }, { additionalProperties: false }), replay: "safe",
    async execute(args, _api, context) {
      try {
        context.abortSignal?.throwIfAborted(); await active();
        if (!eligibleIds.has(`${args.grantId}:${args.skillId}`)) throw new Error("Skill is not available for automatic worker invocation");
        const current = load();
        if (JSON.stringify(grantList(current)) !== grantFingerprint) throw new Error("Worker skill grants changed; this frozen worker binding is no longer authorized");
        const result = await readGrantedWorkerSkill({ access: () => {
          const owner = load();
          const grant = grantList(owner).find(item => item.id === args.grantId);
          return grant ? { kind: "granted", project: owner, grant } : { kind: "missing" };
        }, scopeId, skillId: args.skillId, documentId: args.documentId, expectedGrantId: args.grantId, expectedGrantRevision: args.grantRevision, textOffset: args.offset ?? 0, textLimit: args.limit ?? 2000, protectedFiles });
        context.abortSignal?.throwIfAborted(); await active();
        if (JSON.stringify(grantList(load())) !== grantFingerprint) throw new Error("Worker skill grants changed during reading");
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
    },
  }) : undefined;
  return { revision: grantFingerprint, instructions, tools: tool ? [tool] : [] };
}
