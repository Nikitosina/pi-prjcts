// E2E for the host notification feed (`notify-feed`, the source for Telegram): isolated host, fake model. The classic inbox's
// hidden-tab browser notifications were retired with it on 2026-11-04 (browser-notify-failures.md); the feed contracts stay.
import { kit } from "./notify-kit.mjs";

const k = await kit("browser-notify");
const { result, rpc, eventually } = k;
const feed = async () => (await rpc({ action: "notify-feed", after: 0 })).items;
const has = async (test) => (await feed()).some(test);
try {
  await k.startHost();
  const a = await k.setup("Alpha", k.gitRepo),
    b = await k.setup("Beta");
  const two = await rpc({ action: "chat-create", id: a, title: "Two" });

  // N2/N7: results from another chat and another project, a question, a Job's final report and a coordinator error, each once.
  await k.ask(a, two.id, "MARK-TWO result please");
  await k.ask(b, "main", "MARK-BETA other project");
  await k.ask(a, "main", "MARK-ASK a question");
  await k.ask(a, "main", "MARK-SHIP a job");
  // Main stays quiet while the Job runs (src/notify.ts); its final report is the event that ends that (browser-notify-failures.md).
  await eventually(async () => has((n) => n.kind === "result" && /MARK-JOB/.test(n.text)), "no Job final report notice", 300);
  const failed = await k.ask(a, two.id, "MARK-FAIL break");
  if (failed.state !== "failed") throw Error("Fixture turn did not fail: " + failed.state);
  await k.ask(a, "main", "MARK-LONG reply");
  await eventually(async () => has((n) => n.kind === "error" && n.chat === "Two"), "no error notice", 300);
  await eventually(async () => has((n) => n.text.includes("LONG-START")), "no long result notice", 300);
  const items = await feed();
  const one = (test, label) => {
    const found = items.filter(test);
    if (found.length !== 1) throw Error(`${label}: expected one notice, got ${found.length}: ${JSON.stringify(found).slice(0, 600)}`);
    return found[0];
  };
  const twoResult = one((n) => n.kind === "result" && n.text.includes("Done MARK-TWO."), "other chat result");
  const beta = one((n) => n.kind === "result" && n.text.includes("Done MARK-BETA."), "other project result");
  one((n) => n.kind === "question" && n.text.includes("MARK-Q Pick a colour"), "question");
  const shipped = one((n) => n.kind === "result" && /MARK-JOB/.test(n.text), "Job final report");
  one((n) => n.kind === "error" && n.chat === "Two", "coordinator error");
  if (twoResult.project !== "Alpha" || twoResult.chatId !== two.id || beta.project !== "Beta" || beta.projectId !== b)
    throw Error("Notices name the wrong project or chat: " + JSON.stringify({ twoResult, beta }));
  if (shipped.mergeable !== true || !shipped.jobId)
    throw Error("A Job's final notice lacks jobId and mergeable: " + JSON.stringify(shipped));
  const long = items.find((n) => n.text.includes("LONG-START"));
  if (!long?.text.includes("LONG-END")) throw Error("Result notice text clipped: " + long?.text.length);
  result.checks.push(
    "N2/N7 results from another chat and another project, a question, a Job's final report and a coordinator error are each in the feed once, named by project and chat, a long result whole",
  );

  // N3/N10/N14: a host restart re-emits nothing and keeps the address and token; a result after it is reported exactly once.
  const before = await feed();
  const urlBefore = (await rpc({ action: "web" })).url;
  await k.stopHost();
  await k.startHost();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const after = await feed();
  if (after.length !== before.length) throw Error(`Restart re-emitted notices: ${before.length} → ${after.length}`);
  if ((await rpc({ action: "web" })).url !== urlBefore) throw Error("Host address or token changed across restart");
  await k.ask(a, "main", "MARK-AFTER restart");
  await eventually(async () => has((n) => n.text.includes("Done MARK-AFTER.")), "no notice after restart", 300);
  const lastSeq = before.at(-1)?.seq ?? 0;
  const fresh = (await rpc({ action: "notify-feed", after: lastSeq })).items;
  if (fresh.filter((n) => n.text.includes("Done MARK-AFTER.")).length !== 1 || fresh.some((n) => n.seq <= lastSeq))
    throw Error("Cursor after restart wrong: " + JSON.stringify(fresh).slice(0, 600));
  result.checks.push(
    "N3/N10/N14 a host restart replays nothing and keeps the address and token; the next result is reported once after the cursor",
  );

  // N9: the feed is bounded.
  const bounded = await rpc({ action: "notify-feed", after: 0 });
  if (!Array.isArray(bounded.items) || bounded.items.length > 200 || typeof bounded.seq !== "number") throw Error("Feed shape wrong");
  result.checks.push("N9 the host feed is a bounded list with a sequence cursor");

  // N11: Follow PRs "Project is paused" error is cleared on resume.
  const c = await k.setup("Gamma");
  await rpc({ action: "automation-update", id: c, change: { follow: { enabled: true } } });
  await rpc({ action: "pause", id: c });
  await rpc({ action: "follow-poll", id: c }).then(
    () => {
      throw Error("Paused poll succeeded");
    },
    (error) => {
      if (!/paused/.test(error.message)) throw error;
    },
  );
  if (!/paused/.test((await rpc({ action: "automation-snapshot", id: c })).follow.lastError ?? ""))
    throw Error("Paused error not recorded");
  await rpc({ action: "resume", id: c });
  const resumed = (await rpc({ action: "automation-snapshot", id: c })).follow;
  if (/paused/.test(resumed.lastError ?? "")) throw Error("Paused error stayed after resume: " + resumed.lastError);
  result.checks.push('N11 Follow PRs "Project is paused" is cleared when the project resumes');
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = k.redact(error?.stack ?? error);
}
await k.finish(result.status);
