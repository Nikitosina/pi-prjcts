// A PR provider without parseRefs: refused at load.
export default { name: 'bad-provider', register(api) { api.provide({ prs: { id: 'broken', label: 'Broken', watchDocKind: 'projects.broken', applies: () => true, list: async () => ({}), detail: async () => ({}), status: async () => ({}), published: async () => [], url: () => '' } }); } };
