import type { PromptFrame } from "./prompt-blocks.ts";

/** One part of an agent's assembled prompt, as `prompt-render` shows it (docs/ui2-contract.md). */
export type PromptSectionId = "host" | "instance" | "repository" | "project" | "role" | "preferences" | "skills";
export type PromptSection = { id: PromptSectionId; label: string; source: string; editable: boolean; text: string };
/** The instruction sections an agent is configured with; instance instructions and preferences are rendered by Durable sections. */
export type InstructionSections = Record<"host" | "repository" | "project" | "role" | "skills", PromptSection>;

const ESTIMATE = "tokens are an estimate (chars/4)";
export const promptSection = (id: PromptSectionId, label: string, source: string, editable: boolean, text: string): PromptSection => ({
  id,
  label,
  source: `${source}; ${ESTIMATE}`,
  editable,
  text,
});
export const ORDER: readonly PromptSectionId[] = ["host", "instance", "repository", "project", "role", "preferences", "skills"];
/** The configured instructions text: the non-empty instruction sections in contract order. */
export const joinInstructions = (sections: InstructionSections): string =>
  ORDER.flatMap((id) => (id in sections ? [sections[id as keyof InstructionSections].text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
/** The frame around the role section: what joinInstructions puts before and after it, so composePrompt gives the same text. */
export const sectionsFrame = (sections: InstructionSections, suffix: string): PromptFrame => {
  const skills = sections.skills.text.trim();
  return {
    before: joinInstructions({ ...sections, role: { ...sections.role, text: "" }, skills: { ...sections.skills, text: "" } }),
    lead: "\n\n",
    after: `${skills ? `\n\n${skills}` : ""}${suffix}`,
  };
};
