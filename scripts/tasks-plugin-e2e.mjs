// E2E: the optional tasks plugin with the right-panel section, in the inbox at `/`. Fake model, private HOME, headless Chrome, desktop and mobile, two chats.
// A scripted Coordinator drives the real tools (`TASKS-STEPS [[tool,args],...]`). Failure cases written first: plugins/tasks/FAILURES.md (numbers in check labels).
import { join } from "node:path";
import { call, createKit, delay, say } from "./lib/e2e-kit.mjs";

const kit = await createKit("tasks-plugin", {
  env: { PI_PROJECTS_PLUGINS: join(process.cwd(), "plugins/tasks") },
  handler: ({ role, user, results }) => {
    const steps = /TASKS-STEPS (\[.*\])/s.exec(user)?.[1];
    if (role !== "coordinator" || user.startsWith("[Durable work") || !steps) return undefined;
    const plan = JSON.parse(steps);
    return results.length < plan.length ? call(...plan[results.length]) : say(`TASKS-DONE ${results.join(" ## ")}`);
  },
});

await kit.run(async () => {
  const { check, rpc, result } = kit;
  kit.initRepo();
  const alpha = await kit.createProject("Alpha");
  const one = (await rpc({ action: "chat-create", id: alpha, title: "Release chat" })).id;
  const two = (await rpc({ action: "chat-create", id: alpha, title: "Cleanup chat" })).id;
  const page = await kit.openPage(await kit.webUrl(alpha));
  await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready");

  const js = (value) => JSON.stringify(value);
  const shot = (label) => page.shot(label, { force: true });
  const select = (chatId) =>
    page.evaluate(`import("/state.js").then((bus) => bus.emit("select-request", { projectId: ${js(alpha)}, chatId: ${js(chatId)} }))`);
  const section = () =>
    page.evaluate(
      `(() => { const node = document.querySelector('#plugin-sections [data-plugin="tasks"]'); if (!node) return null; return { state: node.dataset.state, title: node.querySelector("h2").textContent, error: node.querySelector(".plugin-error").hidden ? "" : node.querySelector(".plugin-error").textContent, rows: [...node.querySelectorAll(".section-row")].map((row) => ({ title: row.querySelector(".section-text").textContent, label: row.querySelector(".section-status").textContent, tone: row.querySelector(".section-status").dataset.tone, line: row.innerText, links: [...row.querySelectorAll("a")].map((a) => a.href), details: [...row.querySelectorAll(".section-detail")].map((line) => line.textContent) })), empty: node.querySelector(".section-empty")?.textContent ?? "", footer: node.querySelector(".section-foot")?.textContent ?? "" }; })()`,
    );
  const rowsOf = async () => (await section())?.rows.map((row) => row.title).join("|");
  const waitUntil = async (description, test) => {
    for (let i = 0; i < 400; i++) {
      const value = await test();
      if (value) return value;
      await delay(50);
    }
    throw Error(`Timed out: ${description}`);
  };
  let marker = 0;
  // Run scripted tool calls as the Coordinator of one chat and return the tool results.
  const drive = async (chatId, steps) => {
    const tag = `TASKS-RUN-${++marker}`;
    await rpc({
      action: "message",
      id: alpha,
      ...(chatId === "main" ? {} : { chatId }),
      text: `${tag} TASKS-STEPS ${JSON.stringify(steps)}`,
    });
    await waitUntil(`${tag} done`, () =>
      result.calls.some((c) => c.role === "coordinator" && c.user.includes(tag) && c.results.length === steps.length),
    );
    return result.calls
      .findLast((c) => c.role === "coordinator" && c.user.includes(tag) && c.results.length === steps.length)
      .results.map((text) => {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      });
  };

  // ---- Empty first selection
  await waitUntil("section ready", async () => (await section())?.state === "ready");
  const empty = await section();
  check(
    "17 19 the section is titled Tasks and says so when the chat has no tasks",
    empty.title === "Tasks" && empty.empty === "No open tasks." && !empty.error,
    empty,
  );

  // ---- Main chat: a task without any Job or PR, one with a PR, a third finished
  const [added, second] = await drive("main", [
    ["tasks_add", { title: "Plan the <b>release</b>", note: "waiting for the owner" }],
    ["tasks_add", { title: "Fix login", stage: "in-progress" }],
  ]);
  await waitUntil("main rows", async () => (await rowsOf()) === "Plan the <b>release</b>|Fix login");
  const planned = await section();
  check(
    "8 17 20 refresh with no reload: a task without a PR shows its stage and 'no PR'; HTML in a title is text",
    planned.rows[0].label === "Planned" &&
      /no PR/.test(planned.rows[0].line) &&
      planned.rows[0].details.includes("waiting for the owner") &&
      planned.rows[1].label === "In progress" &&
      !(await page.evaluate(`!!document.querySelector("#plugin-sections .section-text b")`)),
    planned,
  );
  const [attached] = await drive("main", [
    [
      "tasks_attach_pr",
      { id: second.id, provider: "github", repository: "acme/mari", number: "12", url: "https://github.com/acme/mari/pull/12" },
    ],
    ["tasks_update", { id: second.id, stage: "in-review" }],
  ]);
  await waitUntil("pr row", async () => (await section())?.rows[1]?.links.length === 1);
  const withPr = await section();
  check(
    "12 13 17 the PR shows provider, repository and number with its link, and the stage follows the update",
    /github acme\/mari#12/.test(withPr.rows[1].line) &&
      withPr.rows[1].links[0] === "https://github.com/acme/mari/pull/12" &&
      withPr.rows[1].label === "In review" &&
      attached.pr.provider === "github",
    withPr,
  );
  await shot("01-desktop-main");

  // ---- Another chat has its own list; a task id of main is unknown there (1 5 10)
  const crossing = await drive(one, [
    ["tasks_add", { title: "Ship 2.1" }],
    ["tasks_update", { id: added.id, stage: "blocked" }],
    ["tasks_finish", { id: added.id }],
  ]);
  check(
    "1 10 a chat cannot change the task of another chat",
    /Unknown task/.test(String(crossing[1])) && /Unknown task/.test(String(crossing[2])),
    crossing,
  );
  check(
    "5 main's list is untouched by the other chat",
    (await rpc({ action: "plugin", plugin: "tasks", method: "list", id: alpha, params: { chatId: "main" } })).tasks
      .map((task) => task.stage)
      .join() === "planned,in-review",
  );
  check(
    "5 chat one holds only its own task",
    (await rpc({ action: "plugin", plugin: "tasks", method: "list", id: alpha, params: { chatId: one } })).tasks
      .map((task) => task.title)
      .join() === "Ship 2.1",
  );
  await select(one);
  await waitUntil("chat one rows", async () => (await rowsOf()) === "Ship 2.1");
  const chatOne = await section();
  check(
    "18 19 selecting the chat shows its own tasks only",
    chatOne.rows.length === 1 && !chatOne.rows[0].links.length && /no PR/.test(chatOne.rows[0].line),
    chatOne,
  );
  await shot("02-desktop-chat-one");

  // ---- Live refresh while a chat is selected: a tool call in another chat changes nothing here, in this chat changes this section
  await drive(two, [
    ["tasks_add", { title: "Cleanup A" }],
    ["tasks_add", { title: "Cleanup B", stage: "blocked", note: "needs a key" }],
  ]);
  await delay(3500);
  check("18 a tool call of another chat does not touch the selected chat's section", (await rowsOf()) === "Ship 2.1", await section());
  await drive(one, [["tasks_add", { title: "Ship docs", stage: "in-progress" }]]);
  await waitUntil("polled refresh", async () => (await rowsOf()) === "Ship 2.1|Ship docs");
  check("18 a task added by the Coordinator appears without selecting again", true);

  // ---- Finish removes it from the open list and counts it
  const finishing = await rpc({ action: "plugin", plugin: "tasks", method: "list", id: alpha, params: { chatId: one } });
  await drive(one, [["tasks_finish", { id: finishing.tasks[0].id, note: "released" }]]);
  await waitUntil("finished hidden", async () => (await rowsOf()) === "Ship docs");
  check("9 a finished task leaves the open list and is counted", /1 finished/.test((await section()).footer), await section());

  // ---- Unsafe writes are not offered to the owner's clients or the Host agent (3)
  const refused = await rpc({ action: "plugin", plugin: "tasks", method: "add", id: alpha, params: { chatId: "main", title: "x" } }).then(
    () => "accepted",
    (error) => String(error.message),
  );
  check(
    "3 the plugin offers no write RPC",
    refused !== "accepted" &&
      (await rpc({ action: "plugin", plugin: "tasks", method: "list", id: alpha, params: { chatId: "main" } })).tasks.length === 2,
    refused,
  );
  const badChat = await rpc({ action: "plugin", plugin: "tasks", method: "list", id: alpha, params: { chatId: "../../etc" } }).then(
    () => "accepted",
    (error) => String(error.message),
  );
  check("4 a malformed chat id is refused", badChat !== "accepted", badChat);

  // ---- Non-task PRs and merge controls stay (16)
  check(
    "16 Workers and Pull requests stay above the section, untouched",
    await page.evaluate(
      `(() => { const ids = [...document.querySelector("#context").children].map((node) => node.id || node.querySelector("[id]")?.id); return ids.join() === "workers-h,prs-h,plugin-sections" && !document.querySelector("#prs .section-row"); })()`,
    ),
  );

  // ---- Chat two, two chats side by side for the proof, then reload and restart (6 19)
  await select(two);
  await waitUntil("chat two rows", async () => (await rowsOf()) === "Cleanup A|Cleanup B");
  const chatTwo = await section();
  check(
    "11 parallel tasks keep their own stage and note",
    chatTwo.rows[1].label === "Blocked" &&
      chatTwo.rows[1].details.includes("needs a key") &&
      chatTwo.rows[1].tone === "needs" &&
      chatTwo.rows[0].label === "Planned",
    chatTwo,
  );
  await shot("03-desktop-chat-two");

  await page.viewport(390, 844, true);
  await waitUntil("mobile rows", async () => (await rowsOf()) === "Cleanup A|Cleanup B");
  await page.evaluate(`document.querySelector('[data-cmd="toggle-context"]').click()`);
  await page.waitFor(`document.querySelector("#app").dataset.sheet === "context"`, "context sheet");
  await delay(600);
  const mobile = await page.evaluate(
    `(() => { const box = document.querySelector("#plugin-sections").getBoundingClientRect(); const sheet = document.querySelector("#context").getBoundingClientRect(); const overflow = [...document.querySelectorAll("#plugin-sections *")].some((node) => node.getBoundingClientRect().right > sheet.right + 1); return { inside: box.right <= sheet.right + 1 && box.left >= sheet.left - 1, overflow }; })()`,
  );
  await shot("04-mobile-chat-two");
  check("21 the mobile sheet shows the tasks without overflow", mobile.inside && !mobile.overflow, mobile);
  await page.evaluate(`document.querySelector('[data-cmd="toggle-context"]').click()`);
  await select(one);
  await waitUntil("mobile chat one rows", async () => (await rowsOf()) === "Ship docs");
  await page.evaluate(`document.querySelector('[data-cmd="toggle-context"]').click()`);
  await delay(600);
  await shot("05-mobile-chat-one");
  await page.evaluate(`document.querySelector('[data-cmd="toggle-context"]').click()`);
  await page.viewport(1440, 1000);

  await kit.restartHost();
  await page.navigate(await kit.webUrl(alpha, two));
  await page.waitFor(`document.body.dataset.ready === "1"`, "inbox ready after restart");
  await waitUntil("rows after restart", async () => (await rowsOf()) === "Cleanup A|Cleanup B");
  check("6 19 after a host restart and a reload the chat shows its durable list", true);
  await select("main");
  await waitUntil("main rows after restart", async () => (await rowsOf()) === "Plan the <b>release</b>|Fix login");
  await shot("06-desktop-main-after-restart");
});
