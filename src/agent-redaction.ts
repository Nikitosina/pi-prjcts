/**
 * Secrets an agent must never see in a tool result or approval outcome: a webhook secret, a Telegram pairing code, a token.
 * Only agent-facing copies are redacted; the owner's browser gets the real values from the same request.
 */
const REDACTED = "[redacted]";
const secretKey = (key: string, parent: string | undefined) =>
  key === "secret" || key === "token" || key === "apiKey" || key === "password" || (key === "code" && parent === "pairing");

function redact(value: unknown, parent?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, parent));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, typeof item === "string" && secretKey(key, parent) ? REDACTED : redact(item, key)]),
  );
}

/** `action` names where the value came from; every action goes through the same rules, so a new secret-bearing result is covered by its key. */
export function redactForAgent<T>(_action: string, value: T): T {
  return redact(value) as T;
}
