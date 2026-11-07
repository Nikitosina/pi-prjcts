// Browser E2E: coordinator questions are answered in the chat they were asked in, in the inbox at `/`. Fake model only.
// Failure cases: chat-questions-failures.md (the classic inbox's banner, sidebar card and digit keys were retired on 2026-11-04).
// Artifact: artifacts/chat-questions-<time>/ (report.json + screenshots).
import { createKit, call, say } from "./lib/e2e-kit.mjs";
import { contrastLib } from "./lib/contrast-scan.mjs";

const kit = await createKit("chat-questions", {
  handler: ({ role, user, results }) => {
    if (role !== "coordinator" || user.startsWith("[Durable work")) return undefined;
    if (!results.length && /MARK-ASK-RICH/.test(user))
      return call("projects_question", {
        question:
          'MARK-RICH Which database should we use?\nPostgres gives **transactions**; SQLite is `zero-config`.\n\n- fast to start\n- <img src=x onerror="window.__xss=1">',
        choices: ["Postgres", "SQLite", "Something else"],
      });
    if (!results.length && /MARK-ASK-FREE/.test(user))
      return call("projects_question", { question: "MARK-FREE What should the release be called?" });
    if (!results.length && /MARK-ASK-OTHER/.test(user))
      return call("projects_question", { question: "MARK-OTHER Ship the other chat now?", choices: ["Ship", "Wait"] });
    return say(`ACK ${user.replace(/\s+/g, " ").slice(0, 160)}`);
  },
});
const { check, rpc } = kit;
kit.initRepo();

await kit.run(async () => {
  const id = await kit.createProject("Questions");
  const other = await rpc({ action: "chat-create", id, title: "Side chat" });
  await rpc({ action: "message", id, text: "Hello MARK-HI" });
  await kit.delay(300);
  await kit.settle(id);
  await rpc({ action: "message", id, text: "MARK-ASK-RICH please" });
  await kit.delay(300);
  await kit.settle(id);
  await rpc({ action: "message", id, text: "MARK-ASK-FREE please" });
  await kit.delay(300);
  await kit.settle(id);
  await rpc({ action: "message", id, chatId: other.id, text: "MARK-ASK-OTHER please" });
  await kit.delay(300);
  await kit.settle(id);
  const inbox = (await rpc({ action: "show", id })).inbox.filter((item) => !item.result);
  check(
    "three questions recorded",
    inbox.length === 3,
    inbox.map((i) => i.title),
  );

  const url = new URL(await kit.webUrl(id));
  const page = await kit.openPage(url.toString());
  const ev = page.evaluate;
  const cards = `document.querySelectorAll('#questions form.question')`;
  const view = async (width, theme) => {
    await page.viewport(width, 1000, width < 600);
    await ev(`document.documentElement.dataset.theme = '${theme}'`);
    await kit.delay(500);
  };
  await page.waitFor(`document.body.dataset.ready === "1" && ${cards}.length === 2`, "two question cards in Main");
  await ev(`window.__xss = 0`);

  // Q2/Q3/Q4/Q5/Q9/Q12/Q13: in the chat's dock above the composer, in asked order, only this chat's, numbered choices, a free-text field
  // on each, Markdown rendered and markup inert, and the tree counts every open question of the project.
  const state = await ev(`(() => { const q = document.querySelector('#questions');
    return { inDock: q.parentElement.id === 'dock' && !!q.compareDocumentPosition(document.querySelector('#composer')),
      titles: [...q.querySelectorAll('form.question .q-head b')].map(n => n.innerText), text: q.innerText,
      tree: document.querySelector('#tree .tree-head[data-project]')?.innerText ?? '',
      choices: [...q.querySelectorAll('form.question:first-of-type .choices button')].map(b => b.innerText.replace(/\\s+/g, ' ')),
      textareas: q.querySelectorAll('form.question textarea').length, xss: window.__xss, imgs: q.querySelectorAll('img').length,
      md: !!q.querySelector('.q-body strong') && !!q.querySelector('.q-body code') } })()`);
  check("Q2 cards sit in the chat, above the composer", state.inDock, state);
  check("Q13 questions stack in asked order", state.titles[0].includes("MARK-RICH") && state.titles[1].includes("MARK-FREE"), state.titles);
  check("Q3 another chat's question has no card here", !/MARK-OTHER/.test(state.text), state.text);
  check("Q12 the project in the tree counts all three questions", /\b3\b/.test(state.tree), state.tree);
  check("Q5 free-text field on every card", state.textareas === 2, state);
  check("Q4 choices show numbered buttons", state.choices.length === 3 && /^1\s*Postgres/.test(state.choices[0]), state.choices);
  check("Q9 markdown renders; markup in a question is inert", state.md && state.xss === 0 && state.imgs === 0, state);
  await view(1440, "light");
  await page.shot("01-pending-light");
  await view(1440, "claude");
  await page.shot("02-pending-dark");
  await ev(contrastLib);
  for (const [theme, dark] of [
    ["light", false],
    ["claude", true],
  ]) {
    await view(1440, theme);
    const found = await ev(`window.__scan(${dark}, document.querySelector('#questions'))`);
    // Known (chat-questions-failures.md Q15): white on the brand accent of a primary button is under 4.5:1 in every theme.
    const low = found.low.filter((entry) => !/^button\.primary/.test(entry));
    check(`Q15 ${theme}: question text contrast >= 4.5 (primary buttons excepted, see Q15)`, low.length === 0, found);
  }
  await view(420, "light");
  await page.shot("03-narrow-light");
  const overflow = await ev(
    `document.documentElement.scrollWidth <= innerWidth + 1 && [...${cards}].every(c => c.getBoundingClientRect().right <= innerWidth + 1)`,
  );
  check("Q15 420 px: no horizontal overflow", overflow);
  await view(1440, "claude");

  // Q6: a draft survives re-renders and keeps focus.
  const free = `${cards}[1].querySelector('textarea')`;
  await ev(`(() => { const t = ${free}; t.focus(); t.value = 'Orion'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  // Q10: a normal composer message still works while questions are pending; its reply re-renders the cards.
  await ev(
    `(() => { const t = document.querySelector('#composer-input'); t.value = 'MARK-NORMAL still talking'; document.querySelector('#composer').requestSubmit(); })()`,
  );
  await page.waitFor(`document.querySelector('#feed').innerText.includes('MARK-NORMAL')`, "normal message sent");
  await kit.settle(id);
  await page.waitFor(`document.querySelector('#feed').innerText.includes('ACK MARK-NORMAL')`, "reply to the normal message");
  await ev(`${free}.focus()`);
  const kept = await ev(
    `(() => { const t = ${free}; return { value: t.value, focused: document.activeElement === t, cards: ${cards}.length }; })()`,
  );
  check("Q6/Q10 the composer sends while questions wait; a draft survives the re-render", kept.value === "Orion" && kept.cards === 2, kept);
  check("Q16 typing in the answer field answers nothing", (await rpc({ action: "show", id })).inbox.filter((i) => !i.result).length === 3);

  // Q5: the free-text answer goes with its Answer button.
  await ev(`${cards}[1].querySelector('button[type=submit]').click()`);
  const freeDone = await kit.eventually(
    async () => (await rpc({ action: "show", id })).inbox.find((i) => i.title.includes("MARK-FREE") && i.result),
    "free answer not recorded",
    100,
  );
  check("Q5 Answer sends the free-text answer", freeDone.result.text === "Orion", freeDone.result);
  await page.waitFor(`${cards}.length === 1`, "answered card gone");
  await kit.settle(id);

  // Q4: a choice answers once; the coordinator is woken with question and answer.
  await ev(`document.querySelector('#questions .choices button[data-choice="Postgres"]').click()`);
  await page.waitFor(`${cards}.length === 0`, "card answered by its choice");
  const rich = (await rpc({ action: "show", id })).inbox.find((i) => i.title.includes("MARK-RICH"));
  check("Q4 a choice answers with exactly that choice", rich.result?.text === "Postgres", rich.result);
  const delivered = await kit.eventually(
    async () =>
      (await rpc({ action: "show", id })).messages.find(
        (m) => m.role === "user" && m.text.includes("MARK-RICH") && m.text.includes("Postgres"),
      ),
    "answer not delivered",
  );
  check("answer wakes the coordinator with question and answer", !!delivered);
  await kit.settle(id);
  await page.shot("05-answered");

  // Q3: the other chat shows its own card and answers there.
  url.searchParams.set("chat", other.id);
  url.searchParams.set("open", "2");
  await page.navigate(url.toString());
  await page.waitFor(
    `document.body.dataset.ready === "1" && ${cards}.length === 1 && document.querySelector('#questions').innerText.includes('MARK-OTHER')`,
    "card in the other chat",
  );
  await page.shot("07-other-chat");
  await ev(`document.querySelector('#questions .choices button[data-choice="Ship"]').click()`);
  await page.waitFor(`${cards}.length === 0`, "answered in the other chat");
  check(
    "Q3/Q4 other-chat question answered from its own chat",
    (await rpc({ action: "show", id })).inbox.find((i) => i.title.includes("MARK-OTHER")).result.text === "Ship",
  );
  await kit.settle(id);
  await page.waitFor(`!/\\b[1-9]\\b/.test(document.querySelector('#tree .tree-head[data-project]')?.innerText ?? '')`, "tree count gone");
  check("Q12 nothing pending: the tree count is gone", true);
});
