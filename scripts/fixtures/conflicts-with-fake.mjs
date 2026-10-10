// Claims the vcs kind "fake" that the fake plugin already provides: must fail, the first keeps working.
export default { name: 'dupe', register(api) { api.provide({ vcs: { kind: 'fake', readHeadMarker: '.x', isRoot: () => false, changedFiles: async () => [], codeDiff: async () => ({}), workerState: async () => ({}), readHeads: () => ({}), resolveContinuation: async () => ({}) } }); } };
