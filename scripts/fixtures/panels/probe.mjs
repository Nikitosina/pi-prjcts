// A working panel that records its lifecycle (11-16): RPC methods for the panel, an authenticated route and a stylesheet.
import { fileURLToPath } from "node:url";

const counts = { who: 0, click: 0 };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default {
  name: "panel-probe",
  version: "0.2.0",
  register(api) {
    api.provide({
      rpc: {
        who: async ({ projectId, params }) => {
          counts.who++;
          if (params?.slow) await wait(1500);
          return { projectId };
        },
        click: async ({ projectId }) => ({ projectId, clicks: ++counts.click }),
        stats: async () => ({ ...counts }),
      },
      rpcPolicy: { who: "read", click: "write", stats: "read" },
      web: {
        script: fileURLToPath(new URL("probe-ui.js", import.meta.url)),
        style: fileURLToPath(new URL("probe-ui.css", import.meta.url)),
        routes: {
          echo: async ({ projectId, query }) => ({ mime: "text/plain", bytes: new TextEncoder().encode(`${projectId}:${query.get("q")}`) }),
        },
      },
    });
  },
};
