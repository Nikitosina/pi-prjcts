export type ProviderFailure = "quota_exceeded" | "rate_limited";

/** Exhausted allowance only; a bare 429 or overload is transient. */
export function providerFailure(reason: string): ProviderFailure | undefined {
  if (!reason.startsWith("model_error")) return undefined;
  if (
    /quota exceeded|exceeded your (?:current )?quota|insufficient_quota|usage.?limit (?:reached|exceeded)|hit your .{0,20}limit|session limit|(?:five_hour|seven_day|weekly|monthly|daily) limit|credit balance (?:is )?(?:too low|exhausted|depleted|insufficient)|insufficient (?:credits|balance)|(?:not enough|no remaining) credits|out of budget|exceeded .{0,30}available balance|billing (?:hard )?limit (?:reached|exceeded)|payment required/i.test(
      reason,
    )
  )
    return "quota_exceeded";
  if (/rate.?limit|too many requests|\b429\b|overloaded/i.test(reason)) return "rate_limited";
  return undefined;
}

/** A provider `model_error` settles with the provider's own text in `detail`; keep it so quota and throttling stay distinguishable. */
export function unansweredReason(answer: { reason: string; detail?: unknown }): string {
  return answer.reason === "model_error" && typeof answer.detail === "string" && answer.detail
    ? `model_error: ${answer.detail.slice(0, 2000)}`
    : answer.reason;
}

type TurnEntry = { readonly model?: readonly unknown[] };
type AssistantShape = { role?: string; content?: readonly { type: string; text?: string }[]; stopReason?: string; errorMessage?: string };

/**
 * A turn that ended done with an empty answer right after a quota or rate-limit error, as a `model_error` reason; else undefined.
 * A provider can answer Durable's retry of the failed request with nothing, which settles the turn instead of failing it.
 */
export function emptyAnswerFailure(entries: readonly TurnEntry[]): string | undefined {
  const [failed, answer] = entries.slice(-2).map((entry) => entry.model?.[0] as AssistantShape | undefined);
  if (
    answer?.role !== "assistant" ||
    answer.stopReason !== "stop" ||
    answer.content?.some((part) => part.type !== "text" || part.text?.trim())
  )
    return undefined;
  if (failed?.role !== "assistant" || failed.stopReason !== "error" || !failed.errorMessage) return undefined;
  const reason = `model_error: ${failed.errorMessage.slice(0, 2000)}`;
  return providerFailure(reason) ? reason : undefined;
}

export function transientNetworkFailure(reason: string): boolean {
  if (!reason.startsWith("model_error:") || providerFailure(reason)) return false;
  if (
    /\b4\d\d\b|authenticat|unauthori|forbidden|api.?key|context.{0,24}(?:length|window|overflow)|too many tokens|prompt.{0,16}too long|quota/i.test(
      reason,
    )
  )
    return false;
  return /fetch failed|\bterminated\b|websocket (?:error|closed|(?:connect|idle) timeout)|SSE response headers timed out|connection (?:error|refused|lost|reset)|\b(?:ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|ETIMEDOUT)\b|socket hang up/i.test(
    reason,
  );
}

export const networkRetryDelay = (attempt: number, base = Number(process.env.PI_PROJECTS_NETWORK_RETRY_BASE_MS) || 60_000) =>
  attempt >= 1 && attempt <= 6 ? Math.min(2 ** (attempt - 1), 8) * base : undefined;
export const NETWORK_CONTINUE = "The provider connection failed during your last turn. Continue where you left off.";

export const QUOTA_RETRY_LIMIT = 8;
export const QUOTA_RETRY_BASE_MS = 15 * 60_000;
export const quotaRetryDelay = (attempt: number, base: number) => Math.min(6 * 60 * 60_000, base * 2 ** Math.min(attempt - 1, 8));
