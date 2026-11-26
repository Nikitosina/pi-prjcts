import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { home, InboxHost, parse, readJson, saveJson } from "./state.ts";

const list = Type.Array(InboxHost);
let hosts: Static<typeof list> | undefined;
const path = () => join(home(), "inbox-hosts.json");
function validate(host: Static<typeof InboxHost>) {
  const origin = new URL(host.relayOrigin);
  if (origin.protocol !== "https:" || origin.origin !== host.relayOrigin || origin.hostname.includes("*"))
    throw Error("Expected an HTTPS relay origin");
  return host;
}
let unreadable = false;
export function inboxHosts() {
  if (!hosts) {
    try {
      hosts = existsSync(path()) ? parse(list, readJson(path())).map(validate) : [];
    } catch {
      unreadable = true;
      hosts = [];
      console.error("Invalid inbox-hosts.json. Remote hosts are disabled; repair the file and restart.");
    }
  }
  return hosts;
}
export function setInboxHost(id: string, host?: Static<typeof InboxHost>) {
  const next = inboxHosts().filter((entry) => entry.hostId !== id);
  if (unreadable) throw Error("Cannot change an unreadable inbox-hosts.json; repair the file and restart.");
  if (host) next.push(validate(host));
  saveJson(path(), next);
  hosts = next;
  return next;
}
