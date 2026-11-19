/** How far a group's delivery got: it reached the chat, was refused before it could, may or may not have reached it, or was not tried. */
export type Delivery = "submitted" | "refused" | "uncertain" | "held";
type Group = { provider?: string; count?: number; input?: { eventId: string }; attempt?: number; waiting?: Exclude<Delivery, "submitted"> };
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
 * id is not an `owner/name`, and to GitHub otherwise; when several providers name that id (`contested`) nobody's claim can be told apart, so
 * it stays untouched.
 */
export function priorRepo<R extends { provider?: string }>(
  repos: Record<string, R>,
  provider: string,
  repositoryId: string,
  contested = false,
): { record: R | undefined; superseded: string | null } {
  const own = (key: string): R | undefined => (Object.prototype.hasOwnProperty.call(repos, key) ? repos[key] : undefined);
  const bare = own(repositoryId);
  if (provider === "github")
    return { record: bare && (bare.provider === undefined || bare.provider === "github") ? bare : undefined, superseded: null };
  const current = own(repoKey(provider, repositoryId));
  if (current) return { record: current, superseded: null };
  if (!bare) return { record: undefined, superseded: null };
  const claims = bare.provider === provider || (bare.provider === undefined && !contested && !/^[^/]+\/[^/]+$/.test(repositoryId));
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

/**
 * What a scheduler answer for an event means. Only an intent that never called the chat (interrupted without a submission) is a proven
 * refusal; one that may have is uncertain and is never sent under another id.
 */
export function deliveryOf(intent: { status: string; submissionId: number | null }): Exclude<Delivery, "held"> {
  if (intent.submissionId !== null || intent.status === "submitted") return "submitted";
  return intent.status === "interrupted" ? "refused" : "uncertain";
}

/** The id a group's event is sent under: the frozen identity, plus the attempt once a refusal made a new one necessary. */
export const groupEventId = (group: { input: { eventId: string }; attempt?: number }): string =>
  group.attempt ? `${group.input.eventId}~${group.attempt}` : group.input.eventId;

/** Provider behind a notice key (`gh:` is GitHub's). */
const noticeProvider = (key: string): string => {
  const provider = key.slice(0, key.indexOf(":"));
  return provider === "gh" ? "github" : provider;
};

/**
 * What a delivery settled. `confirmed` groups reached the chat; the others `waiting` keep their frozen payload and chat (a refusal moves
 * them to the next attempt) with the records (`heldRepos`) and notices (`carry`) of their providers, which stay out of the saved state until
 * the last of the provider's groups is confirmed. A waiting legacy group holds every provider. Notices of a provider that is off and has
 * nothing waiting are dropped; the rest are `publish`ed.
 */
export function settle<G extends Group, N extends { key: string }>(
  batch: Batch<G, N>,
  outcomes: ReadonlyMap<G, Delivery>,
  off: readonly string[],
): { confirmed: G[]; waiting: G[]; heldRepos: string[]; heldAll: boolean; publish: N[]; carry: N[]; count: number } {
  const confirmed = batch.groups.filter((group) => outcomes.get(group) === "submitted");
  const waiting = batch.groups.flatMap((group): G[] => {
    const outcome = outcomes.get(group) ?? "held";
    if (outcome === "submitted") return [];
    return [{ ...group, waiting: outcome, ...(outcome === "refused" ? { attempt: (group.attempt ?? 0) + 1 } : {}) }];
  });
  const heldAll = waiting.some((group) => group.provider === undefined);
  const heldProviders = new Set(waiting.flatMap((group) => groupProviders(batch, group)));
  const carried = (notice: N) => heldAll || heldProviders.has(noticeProvider(notice.key));
  const tagged = batch.groups.every((group) => group.count !== undefined);
  return {
    confirmed,
    waiting,
    heldRepos: Object.entries(batch.repos ?? {}).flatMap(([key, repo]) =>
      heldAll || (repo.provider && heldProviders.has(repo.provider)) ? [key] : [],
    ),
    heldAll,
    publish: batch.notices.filter((notice) => !carried(notice) && !off.includes(noticeProvider(notice.key))),
    carry: batch.notices.filter(carried),
    count: tagged ? confirmed.reduce((sum, group) => sum + group.count!, 0) : waiting.length ? 0 : batch.count,
  };
}

/** Auto-fix attempts stored under a bare `<repository>#<number>` go to the provider's scoped name; a scoped list already there wins. `copy` leaves the bare list too. */
export function moveFixes<F>(fixes: Record<string, F[]>, repositoryId: string, provider: string, copy = false): void {
  for (const key of Object.keys(fixes)) {
    const found = /^(.+)#(\d+)$/.exec(key);
    if (found?.[1] !== repositoryId) continue;
    const scoped = prLabel(provider, repositoryId, found[2]);
    if (!Object.prototype.hasOwnProperty.call(fixes, scoped)) fixes[scoped] = JSON.parse(JSON.stringify(fixes[key]));
    if (!copy) delete fixes[key];
  }
}

/**
 * Moves records an older host stored under a bare repository id and tagged by a plugin provider to that provider's key, whether or not the
 * provider is connected, so GitHub's record for the same `owner/name` cannot replace them. Their attempts move too, or are copied when GitHub
 * follows the repository as well (`githubRepositories`) and the owner of an untagged list cannot be told. Returns whether anything changed.
 */
export function scopeBare<R extends { provider?: string; repositoryId?: string }, F>(
  repos: Record<string, R>,
  fixes: Record<string, F[]>,
  githubRepositories: readonly string[],
): boolean {
  let changed = false;
  for (const [key, repo] of Object.entries(repos)) {
    const provider = repo.provider;
    if (!provider || provider === "github" || key.startsWith(`${provider}::`)) continue;
    const scoped = repoKey(provider, key);
    if (!Object.prototype.hasOwnProperty.call(repos, scoped)) repos[scoped] = { ...repo, provider, repositoryId: key };
    delete repos[key];
    moveFixes(fixes, key, provider, githubRepositories.includes(key));
    changed = true;
  }
  return changed;
}
