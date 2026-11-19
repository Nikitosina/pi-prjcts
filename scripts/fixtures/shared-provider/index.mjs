// One object serves as both the PR provider and the follow provider; globalThis.sharedCalls counts what reaches it.
const calls = (globalThis.sharedCalls = []);
const note = (name, value) => () => (calls.push(name), value);
const shared = {
  id: "shared",
  label: "Shared",
  eventKind: "shared.event",
  watchDocKind: "projects.shared-pr-watch",
  applies: note("applies", true),
  list: note("list", { prs: [], fetchedAtMs: 0, error: null, rateLimitedUntilMs: null }),
  detail: note("detail", {}),
  parseRefs: () => [],
  status: note("status", {}),
  published: note("published", []),
  url: (id) => `https://shared.invalid/${id}`,
  repository: note("repository", "owner/repo"),
  observe: note("observe", {}),
};
export default {
  name: "shared",
  register(api) {
    api.provide({ prs: shared, follow: shared });
  },
};
