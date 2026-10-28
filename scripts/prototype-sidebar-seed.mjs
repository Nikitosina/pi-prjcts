// PROTOTYPE tooling (web/PROTOTYPE-SIDEBAR-NOTES.md). Seeds a verify SCRATCH host through its web API (the calls the UI makes) with 3 projects, several chats, 2 archived. Refuses any run that is not a pi-verify scratch.
// Usage: node scripts/prototype-sidebar-seed.mjs <scratch>/run.json > ids.json
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; import { execFileSync, } from "node:child_process"; import { randomUUID } from "node:crypto";
const run = JSON.parse(readFileSync(process.argv[2], "utf8")); const web = new URL(run.webUrl); const token = new URLSearchParams(web.hash.slice(1)).get("token");
if (!run.scratch.includes("pi-verify-")) throw new Error("refusing: not a verify scratch run");
const api = async body => { const r = await fetch(web.origin + "/api", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); const j = await r.json(); if (j?.ok === false) throw new Error(`${body.action}: ${j.error}`); return j?.ok === true && "data" in j ? j.data : j; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const idle = async (id, chatId) => { for (let i = 0; i < 60; i++) { const s = await api({ action: "show", id, ...(chatId ? { chatId } : {}) }); if (!s.busy) return; await sleep(500); } };
const say = async (id, chatId, text) => { await api({ action: "message", id, text, ...(chatId && chatId !== "main" ? { chatId } : {}) }); await sleep(400); await idle(id, chatId); };
const chat = async (id, title) => (await api({ action: "chat-create", id, title })).id;
async function project(name, objective) {
  const dir = join(run.scratch, "ws-" + name.toLowerCase().replace(/\W+/g, "-")); mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOME: run.userHome, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...a) => execFileSync("/usr/bin/git", ["-C", dir, "-c", "commit.gpgsign=false", "-c", "user.email=verify@example.invalid", "-c", "user.name=Verify", ...a], { env });
  git("init", "-q", "-b", "main"); writeFileSync(join(dir, "README.md"), name + "\n"); git("add", "."); git("commit", "-qm", "seed");
  const p = await api({ action: "create", requestId: randomUUID(), name, cwd: dir, objective, model: "fake/fake-model" });
  const s = await api({ action: "settings-snapshot", id: p.id });
  await api({ action: "settings-update", id: p.id, confirm: p.id, expectedRevision: s.revision, changes: { models: { worker: "fake/fake-model", scout: "fake/fake-model", reviewer: "fake/fake-model" } } });
  return p.id;
}
const seed = run.projectId; // "Verify seed"
const out = { seed };
await say(seed, "main", "Wire OAuth refresh into the session store.");
out.release = await chat(seed, "Release 0.9 checklist"); await say(seed, out.release, "List what is left before tagging v0.9.0.");
out.flaky = await chat(seed, "Flaky e2e triage"); await say(seed, out.flaky, "Which e2e tests are flaky this week?");
out.q2 = await chat(seed, "Q2 dependency sweep"); await say(seed, out.q2, "Summarise the Q2 dependency sweep.");
await api({ action: "chat-update", id: seed, chatId: out.q2, archived: true });
out.billing = await project("Billing service", "Invoices, taxes and payment retries");
await say(out.billing, "main", "Invoice rounding: what changed this sprint?");
out.stripe = await chat(out.billing, "Stripe webhook retries"); await say(out.billing, out.stripe, "Are retries idempotent?");
out.tax = await chat(out.billing, "Tax table import"); await say(out.billing, out.tax, "Diff the EU tax table against last quarter.");
out.ledger = await chat(out.billing, "Old ledger spike"); await say(out.billing, out.ledger, "Wrap up the ledger spike.");
await api({ action: "chat-update", id: out.billing, chatId: out.ledger, archived: true });
out.docs = await project("Docs site", "Public documentation");
await say(out.docs, "main", "Is the docs build green?");
out.api = await chat(out.docs, "API reference regen"); await say(out.docs, out.api, "Regenerate the OpenAPI v3.2 pages.");
console.log(JSON.stringify(out));
