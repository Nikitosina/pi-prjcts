import type { ToolDiagnostic } from "@earendil-works/pi-durable";

/** Longer tokens without these separators are words run together; calibrated with the owner on 1186 real messages (2026-11-09). */
const LIMIT = 50;
const SEPARATORS = /[/_.:=]/;
const TRAILING = /[\p{P}]+$/u;
const HEX = /^[0-9a-f]+$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOWN = 5,
  CLIP = 60;

/** Prose of a message: fenced and inline code removed, since code is legitimately unspaced. */
const prose = (text: string) => text.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, " ").replace(/`[^`\n]*`/g, " ");

/** Tokens of `text` that look like words glued together, in order. */
export function gluedWords(text: string): string[] {
  return prose(text)
    .split(/\s+/)
    .filter((token) => {
      if ([...token].length <= LIMIT) return false;
      // Sentence punctuation after a glued run does not make it a path or a hash.
      const bare = token.replace(TRAILING, "");
      return !SEPARATORS.test(bare) && !HEX.test(bare) && !UUID.test(bare);
    });
}

const clip = (token: string) => {
  const chars = [...token];
  return chars.length > CLIP ? `${chars.slice(0, CLIP).join("")}…` : token;
};

/** The sender's warning for a delivered message with glued words; null when it has none. */
export function gluedWordsWarning(text: string): string | null {
  const found = gluedWords(text);
  if (!found.length) return null;
  const shown = found.slice(0, SHOWN).map((token) => `"${clip(token)}"`);
  const more = found.length > SHOWN ? ` and ${found.length - SHOWN} more` : "";
  return `${found.length === 1 ? "A word looks" : "Words look"} glued together: ${shown.join(", ")}${more}. Use normal spacing between words next time.`;
}

/** The warning as a model-visible tool diagnostic. */
export function gluedWordsDiagnostic(text: string): ToolDiagnostic | null {
  const message = gluedWordsWarning(text);
  return message === null ? null : { severity: "warn", code: "projects.glued-words", message };
}
