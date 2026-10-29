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

export const QUOTA_RETRY_LIMIT = 8;
export const QUOTA_RETRY_BASE_MS = 15 * 60_000;
export const quotaRetryDelay = (attempt: number, base: number) => Math.min(6 * 60 * 60_000, base * 2 ** Math.min(attempt - 1, 8));
