// RPC methods with and without a declared agent policy (host-agent-e2e G4): a read, a per-params policy and an unclassified write.
const calls = [];
export default {
  name: "policy",
  register(api) {
    api.provide({
      rpc: {
        peek: async () => ({ calls }),
        act: async ({ params }) => (calls.push(`act:${params.op}`), { done: params.op }),
        poke: async () => (calls.push("poke"), { poked: true }),
      },
      rpcPolicy: { peek: "read", act: (params) => (params?.op === "wipe" ? "dangerous" : "write") },
    });
  },
};
