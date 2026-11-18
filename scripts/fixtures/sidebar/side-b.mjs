// A sidebar-only plugin without a Settings mount (3).
import { sidebarPlugin, slowRead } from "./fixture.mjs";

export default sidebarPlugin("side-b", "Side B", "side-b-ui.js", { rpc: { read: slowRead } });
