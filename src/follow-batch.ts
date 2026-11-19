type Group = { provider?: string; count?: number };
type Batch<G extends Group, N extends { key: string }> = {
  groups: G[];
  notices: N[];
  count: number;
  repos?: Record<string, { provider?: string }>;
};

/** A PR is told apart by provider, repository and number: two providers (or repositories) can both have a PR #7. */
export const ownerKey = (provider: string, repositoryId: string, number: number): string => `${provider}\0${repositoryId}#${number}`;

/** A PR's name in stored state (fixes) and in the notes of one poll: GitHub's stays `<repository>#<number>` as it always was, a provider plugin's is prefixed. */
export const prLabel = (provider: string, repositoryId: string, number: number | string): string =>
  provider === "github" ? `${repositoryId}#${number}` : `${provider}:${repositoryId}#${number}`;

/** Where a provider's repository record is stored: GitHub keeps the bare repository id, a plugin's key carries the plugin so two providers can share an id. */
export const repoKey = (provider: string, repositoryId: string): string =>
  provider === "github" ? repositoryId : `${provider}::${repositoryId}`;

/**
 * The record a provider continues from, and the old key it was found under (to be dropped once the new key is written). Records an older
 * host stored under the bare repository id are the provider's own only when tagged with it; an untagged one belongs to a plugin when its
 * id is not an `owner/name`, and to GitHub otherwise.
 */
export function priorRepo<R extends { provider?: string }>(
  repos: Record<string, R>,
  provider: string,
  repositoryId: string,
): { record: R | undefined; superseded: string | null } {
  const own = (key: string): R | undefined => (Object.prototype.hasOwnProperty.call(repos, key) ? repos[key] : undefined);
  const bare = own(repositoryId);
  if (provider === "github")
    return { record: bare && (bare.provider === undefined || bare.provider === "github") ? bare : undefined, superseded: null };
  const current = own(repoKey(provider, repositoryId));
  if (current) return { record: current, superseded: null };
  if (!bare) return { record: undefined, superseded: null };
  const claims = bare.provider === provider || (bare.provider === undefined && !/^[^/]+\/[^/]+$/.test(repositoryId));
  return claims ? { record: bare, superseded: repositoryId } : { record: undefined, superseded: null };
}

/** Providers a frozen group may carry events of: its own tag, or, for a group frozen before tags existed, every provider the batch recorded. */
export function groupProviders<G extends Group>(batch: Pick<Batch<G, { key: string }>, "repos">, group: G): string[] {
  if (group.provider !== undefined) return [group.provider];
  return [...new Set(Object.values(batch.repos ?? {}).flatMap((repo) => (repo.provider ? [repo.provider] : [])))];
}

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
