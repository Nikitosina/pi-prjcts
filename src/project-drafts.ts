import { Type } from "typebox";
import { Id, parse } from "./state.ts";
import type { FormDraft } from "./project-screen.ts";
import type { KnowledgeDraft } from "./project-knowledge-screen.ts";
import type { SettingsDraft } from "./project-settings-screen.ts";
import type { UploadDraft } from "./project-upload-screen.ts";

const text = Type.String({ maxLength: 32000 });
const key = Type.String({ minLength: 38, maxLength: 400, pattern: "^[a-f0-9-]{36}:.+$" });
const revision = Type.String({ pattern: "^[a-f0-9]{64}$" });
const revisionDraft = Type.Object({ key, text, expectedRevision: revision }, { additionalProperties: false });
const State = Type.Object({
  version: Type.Literal(1),
  coordinator: Type.Array(Type.Object({ projectId: Id, text }, { additionalProperties: false }), { maxItems: 256 }),
  forms: Type.Array(Type.Object({ key, text, requestId: Id, submittedText: Type.Union([text, Type.Null()]) }, { additionalProperties: false }), { maxItems: 256 }),
  knowledge: Type.Array(Type.Object({ key, text, expectedRevision: Type.Union([revision, Type.Null()]) }, { additionalProperties: false }), { maxItems: 256 }),
  knowledgePaths: Type.Optional(Type.Array(Type.Object({ projectId: Id, text }, { additionalProperties: false }), { maxItems: 256 })),
  settings: Type.Array(revisionDraft, { maxItems: 256 }),
  uploads: Type.Optional(Type.Array(Type.Object({ projectId: Id, importId: Id, filename: Type.String({ maxLength: 240 }), title: Type.String({ maxLength: 1000 }), encoding: Type.Union([Type.Literal("utf8"), Type.Literal("base64")]), text: Type.String({ maxLength: 43692 }), submittedFingerprint: Type.Union([revision, Type.Null()]) }, { additionalProperties: false }), { maxItems: 256 })),
}, { additionalProperties: false });
export type ProjectDrafts = {
  coordinator: Map<string, string>;
  forms: Map<string, FormDraft>;
  knowledge: Map<string, KnowledgeDraft>;
  knowledgePaths: Map<string, string>;
  settings: Map<string, SettingsDraft>;
  uploads: Map<string, UploadDraft>;
};
const limit = 1048576;
function bounded(value: unknown) {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > limit) throw new Error("Native draft snapshot exceeds 1 MiB; drafts remain in memory without truncation");
  return parse(State, value);
}
export function draftSnapshot(drafts: ProjectDrafts) {
  return bounded({ version: 1,
    coordinator: [...drafts.coordinator].map(([projectId, text]) => ({ projectId, text })),
    forms: [...drafts.forms].map(([key, draft]) => ({ key, ...draft })),
    knowledge: [...drafts.knowledge].map(([key, draft]) => ({ key, ...draft })),
    knowledgePaths: [...drafts.knowledgePaths].map(([projectId, text]) => ({ projectId, text })),
    settings: [...drafts.settings].map(([key, draft]) => ({ key, ...draft })),
    uploads: [...drafts.uploads.values()].map(draft => ({ ...draft })),
  });
}
export function restoreDrafts(drafts: ProjectDrafts, value: unknown) {
  const state = bounded(value);
  const unique = (keys: string[]) => { if (new Set(keys).size !== keys.length) throw new Error("Native draft snapshot contains duplicate keys"); };
  unique(state.coordinator.map(item => item.projectId)); unique(state.forms.map(item => item.key)); unique(state.knowledge.map(item => item.key)); unique(state.settings.map(item => item.key));
  unique((state.knowledgePaths ?? []).map(item => item.projectId));
  unique((state.uploads ?? []).map(item => item.importId));
  drafts.coordinator.clear(); drafts.forms.clear(); drafts.knowledge.clear(); drafts.knowledgePaths.clear(); drafts.settings.clear(); drafts.uploads.clear();
  for (const item of state.coordinator) drafts.coordinator.set(item.projectId, item.text);
  for (const { key, ...draft } of state.forms) drafts.forms.set(key, draft);
  for (const { key, ...draft } of state.knowledge) drafts.knowledge.set(key, draft);
  for (const item of state.knowledgePaths ?? []) drafts.knowledgePaths.set(item.projectId, item.text);
  for (const { key, ...draft } of state.settings) drafts.settings.set(key, draft);
  for (const draft of state.uploads ?? []) drafts.uploads.set(draft.importId, { ...draft });
}
