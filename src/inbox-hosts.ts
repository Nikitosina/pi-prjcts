import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { home, InboxHost, parse, readJson, saveJson } from "./state.ts";

const list = Type.Array(InboxHost);
let hosts: Static<typeof list> | undefined;
const path = () => join(home(), "inbox-hosts.json");
export function relayOrigin(value: string) {
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.origin !== value || origin.hostname.includes("*"))
    throw Error("Expected an HTTPS relay origin");
  return origin;
}
function validate(host: Static<typeof InboxHost>) {
  relayOrigin(host.relayOrigin);
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
  if (host) {
    if (next.length !== inboxHosts().length) throw Error("Host is already paired. Forget it before pairing again.");
    next.push(validate(host));
  }
  saveJson(path(), next);
  hosts = next;
  return next;
}
