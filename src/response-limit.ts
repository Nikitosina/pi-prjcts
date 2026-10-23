/** A default tool response is at most this many bytes, its continuation metadata included. An explicit limit, offset or path argument reaches past it. */
export const RESPONSE_LIMIT = 8 * 1024;

export const bytes = (text: string): number => Buffer.byteLength(text);

/** The longest prefix of `text` that fits `room` bytes. Never ends inside a surrogate pair. */
export function fitPrefix(text: string, room: number): string {
  if (room <= 0) return "";
  if (bytes(text) <= room) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(text.slice(0, middle)) <= room) low = middle; else high = middle - 1;
  }
  return /[\ud800-\udbff]/.test(text[low - 1] ?? "") ? text.slice(0, low - 1) : text.slice(0, low);
}

/** `text` unchanged when it fits; otherwise whole lines that fit beside the note. `shown` is 0 when even the first line is cut. */
export function clipLines(text: string, note: (shown: number, total: number) => string, limit = RESPONSE_LIMIT): string {
  if (bytes(text) <= limit) return text;
  const lines = text.split("\n"), room = limit - bytes(note(lines.length, lines.length)) - 8;
  let used = 0, shown = 0;
  while (shown < lines.length && used + bytes(lines[shown]!) + 1 <= room) used += bytes(lines[shown++]!) + 1;
  return `${shown ? lines.slice(0, shown).join("\n") : fitPrefix(lines[0]!, room)}\n${note(shown, lines.length)}`;
}

/** `text` cut to `room` bytes, ending in "..." when it was longer. */
export function ellipsize(text: string, room: number): string {
  return bytes(text) <= room ? text : `${fitPrefix(text, room - 3)}...`;
}

/**
 * JSON text of at most `limit` bytes. `build(n)` renders the response with n units (rows or characters); the largest n from `min` to `max` that fits wins, so
 * `nextOffset` and the like must be derived from n inside `build`. When even `min` units are too large, `fallback()` renders a small metadata-only answer
 * that names what was left out and still advances the caller's offset.
 */
export function fitJson(max: number, build: (n: number) => unknown, options: { min?: number; limit?: number; fallback?: () => unknown } = {}): string {
  const { min = 1, limit = RESPONSE_LIMIT, fallback } = options, render = (n: number) => JSON.stringify(build(n));
  const whole = render(max);
  if (bytes(whole) <= limit) return whole;
  let low = Math.min(min, max), high = max - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(render(middle)) <= limit) low = middle; else high = middle - 1;
  }
  const best = render(low);
  return bytes(best) <= limit || !fallback ? best : JSON.stringify(fallback());
}
