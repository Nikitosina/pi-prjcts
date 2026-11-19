type Group = { provider?: string; count?: number };
type Batch<G extends Group, N extends { key: string }> = {
  groups: G[];
  notices: N[];
  count: number;
  repos?: Record<string, { provider?: string }>;
};

/** A PR is told apart by provider, repository and number: two providers (or repositories) can both have a PR #7. */
export const ownerKey = (provider: string, repositoryId: string, number: number): string => `${provider}\0${repositoryId}#${number}`;

/** Repository and PR number of an item id (`<repository>#<number>` followed by `:` or the end), or null. */
export function prRef(id: string): { repositoryId: string; number: number } | null {
  const found = /^(.+?)#(\d+)(?::|$)/.exec(id);
  return found ? { repositoryId: found[1], number: Number(found[2]) } : null;
}

/**
 * What of a frozen Follow batch may still be delivered: a plugin the project turned off after the batch was frozen delivers no event
 * or notice. Other providers' groups and the saved repository records stay. A group frozen before provider tags existed grouped providers
 * together, so it is delivered whole only while no provider the batch recorded is off; otherwise it is held back (conservative).
 */
export function deliverable<G extends Group, N extends { key: string }>(
  batch: Batch<G, N>,
  off: readonly string[],
): { groups: G[]; notices: N[]; count: number } {
  const recorded = new Set(Object.values(batch.repos ?? {}).flatMap((repo) => (repo.provider ? [repo.provider] : [])));
  const ambiguous = off.some((provider) => recorded.has(provider));
  const dropped = batch.groups.filter((group) => (group.provider === undefined ? ambiguous : off.includes(group.provider)));
  if (!dropped.length && !off.length) return { groups: batch.groups, notices: batch.notices, count: batch.count };
  const groups = batch.groups.filter((group) => !dropped.includes(group));
  const tagged = batch.groups.every((group) => group.count !== undefined);
  return {
    groups,
    notices: batch.notices.filter((notice) => !off.some((provider) => notice.key.startsWith(`${provider}:`))),
    count: tagged ? groups.reduce((sum, group) => sum + group.count!, 0) : dropped.length ? 0 : batch.count,
  };
}
