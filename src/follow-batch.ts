type Group = { provider?: string; count?: number };
type Batch<G extends Group, N extends { key: string }> = { groups: G[]; notices: N[]; count: number };

/**
 * What of a frozen Follow batch may still be delivered: a plugin the project turned off after the batch was frozen delivers no event
 * or notice. Other providers' groups and the saved repository records stay. A group frozen before provider tags existed is delivered whole.
 */
export function deliverable<G extends Group, N extends { key: string }>(
  batch: Batch<G, N>,
  off: readonly string[],
): { groups: G[]; notices: N[]; count: number } {
  const dropped = batch.groups.filter((group) => group.provider !== undefined && off.includes(group.provider));
  if (!dropped.length && !off.length) return { groups: batch.groups, notices: batch.notices, count: batch.count };
  const groups = batch.groups.filter((group) => !dropped.includes(group));
  const tagged = batch.groups.every((group) => group.count !== undefined);
  return {
    groups,
    notices: batch.notices.filter((notice) => !off.some((provider) => notice.key.startsWith(`${provider}:`))),
    count: tagged ? groups.reduce((sum, group) => sum + group.count!, 0) : batch.count,
  };
}
