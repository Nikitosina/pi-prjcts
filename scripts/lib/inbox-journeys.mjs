import assert from "node:assert/strict";

const field = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
export async function typeAndSend(page, selector, text) {
  const input = field(selector);
  await page.waitFor(`!!${input} && !${input}.disabled`, selector);
  await page.waitFor(
    `(()=>{const box=${input}; const r=box.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===box;})()`,
    `visible ${selector}`,
  );
  await page.evaluate(`${input}.focus()`);
  await page.waitFor(`document.activeElement === ${input}`, `focus in ${selector}`);
  await page.cdp("Input.insertText", { text });
  assert.equal(await page.evaluate(`${input}.value`), text, `typed into ${selector}`);
  await page.evaluate(`${input}.form.requestSubmit()`);
}

/** Settings → Remote access → Add host with `link`, clicked like the owner does; the page reloads into the inbox on success. */
export async function pairHost(page, link) {
  await page.evaluate(
    `document.querySelector('#topbar [data-cmd="settings"]').click(); document.querySelector('nav [data-section="remote"]').click()`,
  );
  await page.waitFor(`!!document.querySelector('[aria-label="Host pairing link"]')`, "Add host from link");
  await page.evaluate(`document.querySelector('[aria-label="Host pairing link"]').focus()`);
  await page.cdp("Input.insertText", { text: link });
  const { x, y } = await page.evaluate(
    `(() => {const r = document.querySelector('[data-add-host]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await page.cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}

export async function switchPanels(page, id) {
  const click = (selector) => page.evaluate(`${field(selector)}.click()`);
  async function switchTo(selector, host) {
    const select = field(`${selector} select`);
    await page.waitFor(`!!${select}`, selector);
    await page.evaluate(`${select}.value=${JSON.stringify(host)}; ${select}.dispatchEvent(new Event('change'))`);
    await page.waitFor(
      `(new URL(location).searchParams.get('host') || '') === ${JSON.stringify(host)} && document.body.dataset.ready === '1'`,
      "switched host",
    );
  }
  await page.evaluate(`document.querySelector('[data-host-menu="${id}"]').click()`);
  await page.evaluate(`[...document.querySelectorAll('.host-menu button')].find((b) => b.textContent === 'Settings').click()`);
  await page.waitFor(`document.body.dataset.ready === '1' && ${field("#settings")}.open`, "remote Settings opened from the group menu");
  await click("nav [data-section=remote]");
  await page.waitFor(`${field("#remote-access")}?.innerText.includes(${JSON.stringify(id)})`, "remote settings");
  assert.equal(
    await page.evaluate(`!!document.querySelector('[data-remote-pair], [data-add-host], [data-remote-revoke], [data-remote-rename]')`),
    false,
  );
  await click("nav [data-section=appearance]");
  await page.waitFor(`!!document.querySelector('[data-theme-option=midnight]')`, "appearance loaded");
  await click("[data-theme-option=midnight]");
  await page.waitFor(`document.querySelector('.settings-status').innerText.includes('Theme:')`, "remote theme saved");
  await switchTo("#settings", "");
  await click("nav [data-section=remote]");
  await page.waitFor(`!!document.querySelector('[data-add-host]')`, "local settings");
  await click("#settings [data-cmd=settings]");
  await click("#topbar [data-cmd=host-agent]");
  async function exchange(prompt, reply) {
    await page.waitFor(
      `document.querySelector('#host-agent').dataset.open === '1' && document.querySelector('#host-agent').dataset.available === '1'`,
      "Host agent available",
    );
    await typeAndSend(page, "#ha-composer textarea", prompt);
    await page.waitFor(`document.querySelector('.ha-body').innerText.includes(${JSON.stringify(reply)})`, reply).catch(async (error) => {
      await page.shot("host-agent-failure", { force: true });
      throw Error(
        `${error.message}: ${await page.evaluate(`document.querySelector('#host-agent').innerText + document.querySelector('#toasts').innerText`)}`,
      );
    });
  }
  await exchange("Work agent check", "Work Mac replies");
  await switchTo("#agent-host", id);
  await exchange("Home agent check", "Home Mac replies");
  assert.ok(!(await page.evaluate(`document.querySelector('.ha-body').innerText.includes('Work Mac replies')`)));
  await page.shot("remote-agent", { force: true });
  await click("#host-agent [data-cmd=host-agent]");
}

export async function forgetAcrossViews(page, id) {
  const key = JSON.stringify(`inbox-device:${id}`);
  const getKey = `(await import('/inbox-wire/store.js')).get(${key})`;
  assert.equal(await page.evaluate(`(async()=> (await ${getKey}).privateKey.extractable)()`), false);
  const sibling = await page.newTab(await page.evaluate("location.href"));
  try {
    await sibling.waitFor(`document.querySelector('[data-host-group="${id}"]')?.dataset.state === 'online'`, "second active view");
    await sibling.evaluate(`window.confirm=()=>true; document.querySelector('[data-host-menu="${id}"]').click()`);
    await sibling.evaluate(`[...document.querySelectorAll('.host-menu button')].find((b) => b.textContent.startsWith('Forget host')).click()`);
    const local = `!new URL(location).searchParams.has('host') && document.body?.dataset.ready==='1'`;
    await sibling.waitFor(local, "Forget returned to local inbox");
  } finally {
    await sibling.close();
  }
  // Chrome allows six HTTP/1.1 connections per origin and each view of a local project keeps three streams: the observer waits for the sibling to close.
  await page.cdp("Page.bringToFront");
  await page.waitFor(`!new URL(location).searchParams.has('host') && document.body?.dataset.ready==='1'`, "Forget closed observing view");
  assert.ok(!(await page.evaluate(`(async()=>!!await ${getKey})()`)));
  assert.ok(!(await page.evaluate(`document.querySelector('[data-host-group="${id}"]')`)));
}
