/** A PR event worth a host notice (browser and Telegram): CI failed or recovered, merged, conflicts, review changes. `key` is unique per (PR, diff-set or head, transition), so a notice is raised once. */
export type PrNoticeKind = "ci-failed" | "merged" | "ci-recovered" | "conflicts" | "changes-requested" | "approved" | "review-comments";
export type PrNotice = { key: string; kind: PrNoticeKind; text: string; at: number };
const NOTICES = 50;
const short = (text: string, max: number) => { const value = text.replace(/\s+/g, " ").trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
/** Short, glanceable text: "✕ CI failed · PR #123 summary · check" / "✓ Merged · PR #123 summary". */
export const PR_NOTICE_TITLE: Record<PrNoticeKind, string> = { "ci-failed": "CI failed", merged: "Merged", "ci-recovered": "CI recovered", conflicts: "Merge conflicts", "changes-requested": "Changes requested", approved: "Approved", "review-comments": "New review comments" };
const MARK: Record<PrNoticeKind, string> = { "ci-failed": "✕", merged: "✓", "ci-recovered": "✓", conflicts: "✕", "changes-requested": "✕", approved: "✓", "review-comments": "●" };
export const prNoticeText = (kind: PrNoticeKind, id: number | string, summary: string, check?: string) => `${MARK[kind]} ${PR_NOTICE_TITLE[kind]} · PR #${id} ${short(summary, 100)}${check ? ` · ${short(check, 80)}` : ""}`;
/** Appends new notices to a doc's bounded list; a known key is ignored. */
export function pushNotices(doc: { notices?: PrNotice[] }, fresh: PrNotice[]): void {
  const known = new Set((doc.notices ?? []).map(item => item.key));
  doc.notices = [...(doc.notices ?? []), ...fresh.filter(item => !known.has(item.key))].slice(-NOTICES);
}
