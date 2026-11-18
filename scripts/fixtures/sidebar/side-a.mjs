// A plugin with a Settings panel and a sidebar section; the section reads per chat, slowly for one chat (5-9, 13).
import { sidebarPlugin, slowRead } from "./fixture.mjs";

let pings = 0;

export default sidebarPlugin("side-a", "Side A <i>one</i>", "side-a-ui.js", {
  rpc: { read: slowRead, ping: async ({ projectId }) => ({ projectId, pings: ++pings }), stats: async () => ({ pings }) },
  routes: {
    echo: async ({ projectId, query }) => ({ mime: "text/plain", bytes: new TextEncoder().encode(`${projectId}:${query.get("chat")}`) }),
  },
});
