// 20: a working panel whose declared stylesheet is a directory, so the host cannot serve it.
import { fileURLToPath } from "node:url";

export default {
  name: "panel-no-style",
  version: "0.1.0",
  register(api) {
    api.provide({
      web: { script: fileURLToPath(new URL("no-style-ui.js", import.meta.url)), style: fileURLToPath(new URL(".", import.meta.url)) },
    });
  },
};
