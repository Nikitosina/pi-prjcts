// E2E: Follow PRs event delivery on a real host with a fake model, fake gh and two synthetic provider plugins (alpha, beta); failure cases are
// numbers 48-53 in plugin-enable-failures.md. A holder plugin blocks or delays the host's admission check. Private HOME; no real provider.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createKit, delay } from "./lib/e2e-kit.mjs";

const here = new URL(".", import.meta.url).pathname;
const aux = join(tmpdir(), `follow-delivery-e2e-${process.pid}`);
mkdirSync(aux, { recursive: true });
const sha = (n) => createHash("sha1").update(String(n)).digest("hex");
const file = (name) => join(aux, name);
const bare = file("remote.git"),
  fakeGh = file("fake-gh"),
  ghState = file("gh-state.json"),
  alphaData = file("alpha.json"),
  betaData = file("beta.json"),
  holderControl = file("holder.json");
writeFileSync(fakeGh, `#!/bin/sh\nexec "${process.execPath}" "${join(here, "fake-gh.mjs")}" "$@"\n`);
chmodSync(fakeGh, 0o755);
const jread = (path) => JSON.parse(readFileSync(path, "utf8"));
const jset = (path, change) => {
  const value = jread(path);
  change(value);
  writeFileSync(path, JSON.stringify(value));
};
const ghSet = (change) => jset(ghState, change);
writeFileSync(
  ghState,
  JSON.stringify({ repo: { id: 4242, full_name: "acme/mari", default_branch: "main" }, issues: [], checks: {}, pulls: [] }),
);
writeFileSync(file("gh-calls.jsonl"), "");
writeFileSync(alphaData, JSON.stringify({ repositoryId: "alpha/repo", prs: [], published: [] }));
writeFileSync(betaData, JSON.stringify({ repositoryId: "beta/repo", prs: [], published: [] }));
writeFileSync(holderControl, JSON.stringify({}));
const holderStatus = () => (existsSync(`${holderControl}.status`) ? jread(`${holderControl}.status`) : null);
const hold = (change) => jset(holderControl, (control) => Object.assign(control, change));

const kit = await createKit("follow-delivery", {
  env: {
    PI_PROJECTS_PLUGINS: ["alpha", "beta", "holder"].map((name) => join(here, "fixtures/follow-twins", `${name}.mjs`)).join(":"),
    TWIN_ALPHA_DATA: alphaData,
    TWIN_BETA_DATA: betaData,
    HOLDER_CONTROL: holderControl,
    PI_PROJECTS_GH_CLI: fakeGh,
    FAKE_GH_STATE: ghState,
    FAKE_GH_BARE: bare,
    FAKE_GH_CALLS: file("gh-calls.jsonl"),
    PI_PROJECTS_FOLLOW_TICK_MS: "3600000",
  },
  handler: ({ role, user, results, tools }) => {
    if (role === "coordinator" && /^MARK-PUBLISH/.test(user) && !results.length)
      return kit.call("projects_delegate", { role: "worker", task: "MARK-PUBLISH-FIX make the change and open a draft PR" });
    if (role === "coordinator" && /^MARK-JOB/.test(user) && !results.length)
      return kit.call("projects_delegate", { role: "worker", task: `MARK-NOOP ${user}` });
    if (role === "worker" && /MARK-PUBLISH-FIX/.test(user) && results.length === 0)
      return kit.call("bash", {
        command:
          "printf 'fix %s\\n' \"$$\" > login.txt && git add -A && git commit -qm 'Fix login copy' && git push -q -u origin HEAD && git rev-parse HEAD",
      });
    if (role === "worker" && /MARK-PUBLISH-FIX/.test(user) && results.length === 1)
      return kit.call(
        tools.find((tool) => tool.endsWith("_open_draft_pr")),
        { expectedHead: /[a-f0-9]{40}/.exec(results[0])?.[0], title: "Fix login copy", body: "Fixes the login copy." },
      );
    return undefined;
  },
});

await kit.run(async () => {
  const { rpc } = kit;
  const check = (label, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` :: ${JSON.stringify(detail).slice(0, 600)}`}`);
    kit.check(label, ok, detail);
  };
  process.once("exit", () => hold({ hold: false }));
  execFileSync("/usr/bin/git", ["init", "--bare", "-b", "main", bare], { stdio: "ignore" });
  kit.initRepo();
  const ws = kit.workspace;
  kit.git(ws, "remote", "add", "origin", "https://github.com/acme/mari.git");
  kit.git(ws, "config", "remote.origin.pushurl", bare);
  kit.git(ws, "push", "-q", "origin", "main");
  kit.git(ws, "branch", "-q", "--set-upstream-to=origin/main", "main");

  const chatArg = (chatId) => (chatId && chatId !== "main" ? { chatId } : {});
  const events = async (id, chatId) =>
    (await rpc({ action: "show", id, ...chatArg(chatId) })).messages
      .filter((m) => m.text?.startsWith("[Owner-local event"))
      .map((m) => m.text);
  const idle = (id) =>
    kit.eventually(
      async () =>
        !(await rpc({ action: "show", id })).chats.some((c) => c.busy) && !(await kit.jobs(id)).some((job) => job.status === "running"),
      "project did not go idle",
      1200,
    );
  const within = (promise, ms) =>
    Promise.race([
      promise.then(
        (value) => ({ done: true, value }),
        (error) => ({ done: true, error: error.message }),
      ),
      delay(ms).then(() => ({ done: false })),
    ]);
  const count = (list, needle) => list.filter((text) => text.includes(needle)).length;
  const allChats = async (id, chats) =>
    Object.fromEntries(await Promise.all(Object.entries(chats).map(async ([title, chatId]) => [title, await events(id, chatId)])));

  // Project with chats A, B and Alerts; GitHub #7 owned by a Job in A, alpha #7 by a Job in B, beta #7 unowned. Baseline taken, CI passed, no delivery poll yet.
  const mixed = async (title) => {
    const id = await kit.createProject(title);
    const chatA = await rpc({ action: "chat-create", id, title: "Chat A" });
    const chatB = await rpc({ action: "chat-create", id, title: "Chat B" });
    const alerts = await rpc({ action: "chat-create", id, title: "Alerts" });
    const before = ghState && jread(ghState).pulls.length;
    await rpc({ action: "message", id, chatId: chatA.id, text: "MARK-PUBLISH open the login fix" });
    await kit.eventually(async () => jread(ghState).pulls.length === before + 1, "github PR not published", 1200);
    await idle(id);
    await rpc({ action: "message", id, chatId: chatB.id, text: "MARK-JOB-B do something" });
    await kit.eventually(async () => (await kit.jobs(id)).length === 2, "job B not started", 1200);
    await idle(id);
    const jobB = (await kit.jobs(id)).find((job) => Number(job.chat) === chatB.conversationId);
    const number = jread(ghState).pulls.at(-1).number,
      S = sha(`S${title}`);
    ghSet((state) => {
      Object.assign(
        state.pulls.find((pull) => pull.number === number),
        { sha: S, user: "pi-bot" },
      );
      state.checks[S] = [{ name: "lint", status: "in_progress" }];
    });
    jset(alphaData, (data) => {
      data.prs = [{ number: 7, title: "Alpha seven", head: sha(`HA${title}`), ci: null }];
      data.published = [{ number: 7, conversationId: Number(jobB.workerConversation) }];
    });
    jset(betaData, (data) => (data.prs = [{ number: 7, title: "Beta seven", head: sha(`HB${title}`), ci: null }]));
    await rpc({ action: "automation-update", id, change: { eventChat: alerts.id, follow: { enabled: true, autoFix: false } } });
    await rpc({ action: "follow-poll", id });
    ghSet((state) => (state.checks[S] = [{ name: "lint", conclusion: "success" }]));
    jset(alphaData, (data) => (data.prs[0].ci = "passed"));
    jset(betaData, (data) => (data.prs[0].ci = "passed"));
    return { id, chats: { main: "main", "Chat A": chatA.id, "Chat B": chatB.id, Alerts: alerts.id } };
  };

  // 48 + 50: three providers with PR #7 in two owner chats and the event chat; restart with the batch pending; nothing is delivered twice.
  {
    const { id, chats } = await mixed("Mixed");
    hold({ uncertain: true });
    const blocked = await rpc({ action: "follow-poll", id }).then(
      () => "",
      (error) => error.message,
    );
    check("50 admission blocked: the batch stays pending", /uncertain effect/.test(blocked), blocked);
    await kit.restartHost();
    await rpc({ action: "show", id });
    hold({ uncertain: false });
    await rpc({ action: "follow-poll", id });
    await idle(id);
    const got = await allChats(id, chats);
    check(
      "50 each event reached its own chat once after the restart",
      count(got["Chat A"], "Fix login copy") === 1 && count(got["Chat B"], "[alpha]") === 1 && count(got.Alerts, "[beta]") === 1,
      got,
    );
    check(
      "50 and no chat got another provider's event",
      !count(got["Chat A"], "[alpha]") && !count(got["Chat B"], "Fix login copy") && !count(got["Chat B"], "[beta]") && !got.main.length,
      got,
    );
    await rpc({ action: "follow-poll", id });
    await idle(id);
    const later = await allChats(id, chats);
    check(
      "50 another poll delivers nothing more",
      JSON.stringify(Object.values(later).map((list) => list.length)) === JSON.stringify(Object.values(got).map((list) => list.length)),
      later,
    );
  }

  // 61: the host's admission turns uncertain between recording an event and submitting it, so its intent is interrupted before the chat; the
  // poll fails, the host restarts, and the event still arrives once in its chat as a new attempt, with every other event once.
  {
    const { id, chats } = await mixed("Refused");
    hold({ armed: true, skip: 1, hold: true });
    const polling = rpc({ action: "follow-poll", id }).then(
      () => "",
      (error) => error.message,
    );
    await kit.eventually(async () => holderStatus()?.holding, "the admission hold was not reached", 200);
    hold({ hold: false, afterHold: true });
    const failed = await polling;
    check("61 the blocked admission fails the poll and keeps the batch", /uncertain effect/.test(failed), failed);
    hold({ afterHold: false });
    const before = await allChats(id, chats);
    check("61 the refused event reached no chat yet", count(before["Chat A"], "Fix login copy") === 0, before);
    await kit.restartHost();
    await rpc({ action: "show", id });
    await rpc({ action: "follow-poll", id });
    await idle(id);
    const got = await allChats(id, chats);
    check(
      "61 after the restart each event reached its own chat once",
      count(got["Chat A"], "Fix login copy") === 1 && count(got["Chat B"], "[alpha]") === 1 && count(got.Alerts, "[beta]") === 1,
      got,
    );
    check(
      "61 and no chat got another provider's event",
      !count(got["Chat A"], "[alpha]") && !count(got["Chat B"], "Fix login copy") && !got.main.length,
      got,
    );
    const snapshot = (await rpc({ action: "automation-snapshot", id })).follow;
    check("61 nothing stays undelivered and no error shows", snapshot.undelivered.length === 0 && !snapshot.lastError, snapshot);
    await rpc({ action: "follow-poll", id });
    await idle(id);
    const later = await allChats(id, chats);
    check("61 another poll delivers nothing more", JSON.stringify(later) === JSON.stringify(got), later);
  }

  // 63: alpha is switched off while its event waits in a frozen batch; the other providers go on, the event is not lost across a restart, and the
  // enable delivers it once to its own chat.
  {
    const { id, chats } = await mixed("Reenable");
    hold({ uncertain: true });
    await rpc({ action: "follow-poll", id }).catch(() => {});
    await rpc({ action: "project-plugin", id, plugin: "alpha", enabled: false });
    hold({ uncertain: false });
    await rpc({ action: "follow-poll", id });
    await idle(id);
    const first = await allChats(id, chats);
    check(
      "63 the other providers' events arrived while alpha was off",
      count(first["Chat A"], "Fix login copy") === 1 && count(first.Alerts, "[beta]") === 1 && count(first["Chat B"], "[alpha]") === 0,
      first,
    );
    const waiting = (await rpc({ action: "automation-snapshot", id })).follow.undelivered;
    check(
      "63 alpha's event is shown as undelivered",
      waiting.length === 1 && waiting[0].provider === "alpha" && waiting[0].state === "held",
      waiting,
    );
    await kit.restartHost();
    await rpc({ action: "show", id });
    await rpc({ action: "project-plugin", id, plugin: "alpha", enabled: true });
    await rpc({ action: "follow-poll", id });
    await idle(id);
    const got = await allChats(id, chats);
    check(
      "63 the enable delivered alpha's event once to its chat, and nothing was repeated",
      count(got["Chat B"], "[alpha]") === 1 &&
        count(got["Chat A"], "Fix login copy") === 1 &&
        count(got.Alerts, "[beta]") === 1 &&
        count(got.Alerts, "[alpha]") === 0,
      got,
    );
    check("63 nothing stays undelivered", (await rpc({ action: "automation-snapshot", id })).follow.undelivered.length === 0);
    await rpc({ action: "follow-poll", id });
    await idle(id);
    check("63 another poll delivers nothing more", JSON.stringify(await allChats(id, chats)) === JSON.stringify(got));
  }

  // 51 + 53: a disable that arrives while a delivery is held in the host's admission is refused, and the event arrives once.
  {
    const { id, chats } = await mixed("Race");
    hold({ armed: true, skip: 3, hold: true });
    const polling = rpc({ action: "follow-poll", id }).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error: error.message }),
    );
    await kit.eventually(async () => holderStatus()?.holding, "the admission hold was not reached", 200);
    const disabled = await within(rpc({ action: "project-plugin", id, plugin: "alpha", enabled: false }), 5000);
    check(
      "51 the disable answers during the hold, refused for active work",
      disabled.done && /active work/.test(disabled.error ?? ""),
      disabled,
    );
    hold({ hold: false });
    const finished = await polling;
    await idle(id);
    const got = await allChats(id, chats);
    check("51 the poll succeeded", finished.ok, finished);
    check("51 alpha stayed on", (await rpc({ action: "plugins", id })).plugins.find((p) => p.name === "alpha").enabled);
    check("51 alpha's event reached Chat B exactly once", count(got["Chat B"], "[alpha]") === 1, got["Chat B"]);
    check(
      "51 GitHub's and beta's reached theirs once",
      count(got["Chat A"], "Fix login copy") === 1 && count(got.Alerts, "[beta]") === 1,
      got,
    );
    const off = await rpc({ action: "project-plugin", id, plugin: "alpha", enabled: false });
    check(
      "51 after the delivery the disable goes through",
      off && (await rpc({ action: "plugins", id })).plugins.find((p) => p.name === "alpha").enabled === false,
    );
  }

  // 49 + 52: a provider reporting the same repository id as the GitHub repository, same PR and head: both events arrive, the poll does not fail, and a
  // replay announces nothing again.
  {
    ghSet((state) => (state.pulls = []));
    const id = await kit.createProject("Shared id");
    const alerts = await rpc({ action: "chat-create", id, title: "Alerts" });
    const S = sha("shared");
    ghSet((state) => {
      state.pulls.push({ number: 7, title: "Shared seven", head: "alice/x", base: "main", sha: S, state: "open", user: "alice" });
      state.checks[S] = [{ name: "lint", status: "in_progress" }];
    });
    jset(
      alphaData,
      (data) =>
        (data.repositoryId = "acme/mari") &&
        (data.prs = [{ number: 7, title: "Shared seven", head: S, ci: null }]) &&
        (data.published = []),
    );
    jset(betaData, (data) => (data.prs = []));
    await rpc({ action: "automation-update", id, change: { eventChat: alerts.id, follow: { enabled: true, autoFix: false } } });
    await rpc({ action: "follow-poll", id });
    ghSet((state) => (state.checks[S] = [{ name: "lint", conclusion: "success" }]));
    jset(alphaData, (data) => (data.prs[0].ci = "passed"));
    const polled = await rpc({ action: "follow-poll", id }).then(
      () => "",
      (error) => error.message,
    );
    await idle(id);
    const got = await events(id, alerts.id);
    check("49 the delivery poll did not fail", polled === "", polled);
    check(
      "49 both providers' events reached the event chat once",
      count(got, "GitHub activity") === 1 && count(got, "Twin alpha activity") === 1,
      got,
    );
    check("49 the Follow card shows no error", !(await rpc({ action: "automation-snapshot", id })).follow.lastError);
    check(
      "49 each provider keeps its own record",
      (await rpc({ action: "automation-snapshot", id })).follow.repos.filter((repo) => repo.repositoryId === "acme/mari").length === 2,
      (await rpc({ action: "automation-snapshot", id })).follow.repos,
    );
    await rpc({ action: "follow-poll", id });
    await idle(id);
    check("52 a replay poll announces nothing again", (await events(id, alerts.id)).length === got.length);
  }
});
