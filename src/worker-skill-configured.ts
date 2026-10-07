import { createHash } from "node:crypto";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { captureConfiguredSkillCandidate } from "./worker-skill-catalog.ts";
import { SKILL_CATALOG_LIMITS, type WorkerSkillCandidate } from "./worker-skill-types.ts";

type Source = { kind: "loaded"; loader: Pick<ResourceLoader, "getSkills"> } | { kind: "unavailable" };
type ProtectedFiles = Parameters<typeof captureConfiguredSkillCandidate>[0]["protectedFiles"];
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

export async function captureConfiguredSkillCatalog(input: { source: Source; protectedFiles: ProtectedFiles }): Promise<{ candidates: WorkerSkillCandidate[]; diagnostics: Array<{ source: "sdk" | "capture"; fingerprint: string }> }> {
  if (input.source.kind === "unavailable") throw new Error("Configured skill catalog is unavailable; an existing loaded SDK resource catalog is required. Projects will not resolve packages or reload resources for discovery");
  const loaded = input.source.loader.getSkills();
  if (loaded.skills.length > SKILL_CATALOG_LIMITS.candidates || loaded.diagnostics.length > SKILL_CATALOG_LIMITS.diagnostics) throw new Error("Configured skill catalog exceeds bounded capture limits");
  const snapshot = structuredClone(loaded);
  const candidates: WorkerSkillCandidate[] = [];
  const diagnostics: Array<{ source: "sdk" | "capture"; fingerprint: string }> = snapshot.diagnostics.map(item => ({ source: "sdk", fingerprint: fingerprint(JSON.stringify(item)) }));
  let bytes = 0;
  for (const skill of snapshot.skills) {
    let candidate: WorkerSkillCandidate;
    try { candidate = await captureConfiguredSkillCandidate({ skill, protectedFiles: input.protectedFiles }); }
    catch (error) {
      if (error instanceof AggregateError) throw error;
      diagnostics.push({ source: "capture", fingerprint: fingerprint(JSON.stringify({ file: skill.filePath, error: error instanceof Error ? error.message : String(error) })) });
      continue;
    }
    bytes += candidate.main.size;
    if (bytes > SKILL_CATALOG_LIMITS.bytes) throw new Error("Configured skill captured-document budget exceeded");
    if (candidates.some(item => item.catalogId === candidate.catalogId)) throw new Error("Configured SDK skill catalog contains duplicate candidate identities");
    candidates.push(candidate);
  }
  return { candidates, diagnostics };
}
