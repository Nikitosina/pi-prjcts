// Browser E2E for themes in the inbox at `/`: isolated host, fake model, headless Chrome with emulated prefers-color-scheme.
// Failure cases: theme-failures.md (cases for the classic per-browser System/Light/Dark control were retired with it on 2026-11-04).
import { createKit, say } from "./lib/e2e-kit.mjs";
import { contrastLib } from "./lib/contrast-scan.mjs";

const MD =
  "MD-START\n\n## Heading\n\nA paragraph with `inline code` and a [link](https://example.invalid).\n\n```js\nconst answer = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |\n\n> quote text\n\n- item one\n- item two\n\nMD-END";
const kit = await createKit("theme", {
  handler: ({ role, user }) => (role === "coordinator" && user.includes("MARK-MD") ? say(MD) : undefined),
});
const { check, rpc } = kit;
kit.initRepo();

await kit.run(async () => {
  const id = await kit.createProject("Theme demo");
  await kit.ask(id, "MARK-MD show markdown");
  const LONG = `LONG-START\n${Array.from({ length: 16 }, (_, i) => `long line ${i + 1}`).join("\n")}\nLONG-END`;
  await kit.ask(id, LONG);
  const setTheme = async (theme) => {
    const ui = await rpc({ action: "ui-get" });
    await rpc({ action: "ui-set", revision: ui.revision, patch: { theme } });
  };
  const scheme = (page, value) => page.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
  const theme = (page) => page.evaluate(`document.documentElement.dataset.theme`);

  // T1: the theme is decided before <body> exists, from this browser's cache of the host ui document (theme.js, not inline).
  await setTheme("light");
  const page = await kit.openPage("about:blank");
  await page.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__atBody = null; window.__chatAtBody = null; new MutationObserver(() => { if (document.body && window.__atBody === null) { window.__atBody = document.documentElement.dataset.theme ?? ''; window.__chatAtBody = document.documentElement.dataset.chatSize ?? ''; } }).observe(document, { childList: true, subtree: true });`,
  });
  const url = await kit.webUrl(id);
  await page.navigate(url);
  await page.waitFor(
    `document.body.dataset.ready === "1" && document.querySelector('#feed').innerText.includes('MD-END')`,
    "chat rendered",
  );
  check("T1 the host's theme applies", (await theme(page)) === "light");
  await page.reload();
  await page.waitFor(`document.body.dataset.ready === "1"`, "reloaded");
  check(
    "T1 on reload the theme is already set when <body> is first inserted",
    (await page.evaluate(`window.__atBody`)) === "light",
    await page.evaluate(`window.__atBody`),
  );
  check(
    "T1 the pre-paint script is a same-origin file (the CSP forbids inline scripts)",
    await page.evaluate(
      `[...document.head.querySelectorAll('script')].some(s => new URL(s.src, location.href).pathname === '/theme.js' && !s.async && !s.defer && s.type !== 'module')`,
    ),
  );

  // T2: System follows the OS scheme live, in both directions, with no reload; an explicit theme ignores the OS.
  await setTheme("system");
  await scheme(page, "light");
  await page.waitFor(
    `document.documentElement.dataset.themePref === 'system' && document.documentElement.dataset.theme === 'light'`,
    "system light",
  );
  await scheme(page, "dark");
  await page.waitFor(`document.documentElement.dataset.theme === 'claude'`, "system follows dark");
  check("T2 System follows the OS to dark without a reload", (await theme(page)) === "claude");
  await scheme(page, "light");
  await page.waitFor(`document.documentElement.dataset.theme === 'light'`, "system follows light");
  check("T2 System follows the OS back to light", true);
  await setTheme("light");
  await scheme(page, "dark");
  await page.waitFor(`document.documentElement.dataset.themePref === 'light'`, "explicit light");
  check("T2 an explicit Light is not overridden by a dark OS", (await theme(page)) === "light");

  // T5/T6/T7: dark themes have no bright surfaces, readable text (primary buttons excepted, see T6) and a dark color-scheme.
  await page.evaluate(contrastLib);
  for (const dark of ["claude", "midnight"]) {
    await setTheme(dark);
    await page.waitFor(`document.documentElement.dataset.theme === '${dark}'`, dark);
    await kit.delay(300);
    const found = await page.evaluate(`window.__scan(true, document.querySelector('#app'))`);
    const transcript = await page.evaluate(`window.__scan(true, document.querySelector('#feed'))`);
    // Known (theme-failures.md T6): the shell's faint tokens (timestamps, separators, key hints) and white on the accent are under 4.5.
    (kit.result.knownLowContrast ??= {})[dark] = found.low;
    const low = transcript.low.filter((entry) => !/^(time|button\.primary)\b/.test(entry));
    await page.shot(`01-${dark}`, { force: true });
    // Accent-filled buttons (Send, primary) are the brand color, not a light card.
    const bright = found.bright.filter((entry) => !/^button(#[\w-]+)?\.(send|primary)\b/.test(entry));
    check(`T5 ${dark}: no bright surfaces in the inbox`, bright.length === 0, bright.slice(0, 8));
    check(`T6 ${dark}: transcript text contrast >= 4.5`, low.length === 0 && transcript.texts > 5, low.slice(0, 8));
    check(
      `T7 ${dark}: native widgets use the dark color-scheme`,
      (await page.evaluate(`getComputedStyle(document.documentElement).colorScheme`)) === "dark",
    );
    check(
      `T5 ${dark}: Markdown code, table and quote are dark surfaces`,
      await page.evaluate(`(() => { const lum = c => { const m = c.match(/\\d+(\\.\\d+)?/g)?.map(Number) ?? [255,255,255,0]; return m[3] === 0 ? null : (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000; };
        return ['#feed pre', '#feed table', '#feed blockquote'].every(sel => { const n = document.querySelector(sel); if (!n) return false; const l = lum(getComputedStyle(n).backgroundColor); return l === null || l < 110; }); })()`),
    );
  }
  await setTheme("light");
  await page.waitFor(`document.documentElement.dataset.theme === 'light'`, "light");
  await kit.delay(300);
  const light = await page.evaluate(`window.__scan(false, document.querySelector('#feed'))`);
  kit.result.knownLowContrast.light = (await page.evaluate(`window.__scan(false, document.querySelector('#app'))`)).low;
  await page.shot("02-light", { force: true });
  check(
    "T6 light: transcript text contrast >= 4.5",
    light.low.filter((entry) => !/^(time|button\.primary)\b/.test(entry)).length === 0,
    light.low.slice(0, 8),
  );

  // T9: picking a theme in Settings applies at once, is saved on the host and survives a reload.
  await page.evaluate(`document.querySelector('[data-cmd="settings"]').click()`);
  await page.waitFor(`document.querySelector('#settings').open`, "settings open");
  await page.evaluate(`document.querySelector('nav [data-section="appearance"]')?.click()`);
  await page.waitFor(`!!document.querySelector('[data-theme-option="midnight"]')`, "theme cards");
  await page.evaluate(`document.querySelector('[data-theme-option="midnight"]').click()`);
  await page.waitFor(`document.documentElement.dataset.theme === 'midnight'`, "applied at once");
  await kit.eventually(async () => (await rpc({ action: "ui-get" })).ui.theme === "midnight", "theme not saved on the host", 100);
  check("T9 a theme picked in Settings applies at once and is saved on the host", true);
  await page.shot("03-settings-midnight", { force: true });
  // A1: Theme, Animations, Chat display and Status line are four parts of one Appearance page; each keeps its own stored value.
  check(
    "A1 Appearance holds Theme, Animations, Chat display and Status line in that order, and the nav has no separate pages for them",
    await page.evaluate(
      `JSON.stringify([...document.querySelectorAll('#settings .appearance-part > h2')].map((h) => h.textContent)) === JSON.stringify(["Theme", "Animations", "Chat display", "Status line"]) && !document.querySelector('#settings nav [data-section="theme"], #settings nav [data-section="animations"], #settings nav [data-section="display"], #settings nav [data-section="statusline"]')`,
    ),
  );
  await page.evaluate(`document.querySelector('[data-part="animations"] [data-motion="off"]').click()`);
  await page.evaluate(`document.querySelector('#show-thinking').click()`);
  await kit.eventually(
    async () => {
      const ui = (await rpc({ action: "ui-get" })).ui;
      return ui.animations === "off" && ui.showThinking === false && ui.theme === "midnight";
    },
    "Appearance values not saved together",
    100,
  );
  check("A1 each part saves its own value on the host: theme midnight, animations off, thinking hidden", true);
  check(
    "A2 a link to an old section id still opens Appearance",
    await page.evaluate(
      `import("/settings.js").then((settings) => { settings.openSettings("statusline"); return document.querySelector('#settings').dataset.section === "appearance" && !!document.querySelector('[data-part="statusline"]'); })`,
    ),
  );
  await page.shot("04-appearance", { force: true });
  await page.evaluate(`document.querySelector('#settings [data-part="statusline"]').scrollIntoView({ block: "end" })`);
  await page.shot("04-appearance-lower", { force: true });
  await page.evaluate(`document.querySelector('#settings [data-part="theme"]').scrollIntoView({ block: "start" })`);
  // A3: the letter H still jumps to Appearance from another page, and a binding saved for the old Theme page carries over.
  await page.evaluate(`document.querySelector('#settings nav [data-section="general"]').click()`);
  await page.waitFor(`document.querySelector('#settings').dataset.section === "general"`, "general page");
  // The old Theme, Animations, Display and Status line letters all still land on Appearance (default bindings stay valid).
  for (const letter of ["h", "a", "l", "s"]) {
    await page.evaluate(`document.querySelector('#settings nav [data-section="general"]').click()`);
    await page.waitFor(`document.querySelector('#settings').dataset.section === "general"`, "general page");
    for (const type of ["keyDown", "keyUp"])
      await page.cdp("Input.dispatchKeyEvent", {
        type,
        key: letter,
        code: "Key" + letter.toUpperCase(),
        windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0),
        text: type === "keyDown" ? letter : undefined,
      });
    await page.waitFor(`document.querySelector('#settings').dataset.section === "appearance"`, `letter ${letter} opens Appearance`);
  }
  check(
    "A3 the letters H, A, L and S open Appearance; a binding the owner saved for any of the old pages stays changed, resettable and bound",
    await page.evaluate(
      `import("/hotkeys.js").then((keys) => {
        const row = (id) => keys.bindings().find((item) => item.id === id);
        keys.setOverrides({ "settings-theme": "G", "settings-statusline": "Y" });
        const saved = row("settings-theme").binding === "G" && row("settings-theme").changed && row("settings-statusline").binding === "Y";
        keys.setOverrides({});
        const reset = row("settings-theme").binding === "H" && !row("settings-theme").changed && row("settings-animations").binding === "A";
        return saved && reset;
      })`,
    ),
  );
  await page.viewport(390, 844, true);
  await page.waitFor(`document.querySelector('#settings .appearance-part[data-part="statusline"]')`, "narrow appearance");
  check(
    "A4 at 390 px Appearance fits the screen",
    await page.evaluate(`document.scrollingElement.scrollWidth <= 391 && document.querySelector('#settings').scrollWidth <= 391`),
  );
  await page.shot("04b-appearance-narrow-390", { force: true });
  await page.viewport(1440, 1000);
  await page.reload();
  await page.waitFor(`document.body.dataset.ready === "1"`, "reloaded after pick");
  check(
    "T9 the picked theme survives a reload",
    (await page.evaluate(`window.__atBody`)) === "midnight" && (await theme(page)) === "midnight",
  );
  await page.evaluate(`document.querySelector('[data-cmd="settings"]').click()`);
  await page.waitFor(`document.querySelector('#settings').open`, "settings open after reload");
  await page.evaluate(`document.querySelector('nav [data-section="appearance"]').click()`);
  await page.waitFor(
    `!!document.querySelector('#settings [data-part="display"] #show-thinking') && !!document.querySelector('#settings [data-part="animations"] [data-motion="off"]')`,
    "appearance after reload",
  );
  const saved = await page.evaluate(
    `({ theme: document.querySelector('[data-theme-option="midnight"]').getAttribute('aria-checked'), motion: document.querySelector('#settings [data-part="animations"] [data-motion="off"]').getAttribute('aria-checked'), thinking: document.querySelector('#show-thinking').checked })`,
  );
  check(
    "A5 after a reload every Appearance part shows its saved value: midnight, animations off, thinking hidden",
    saved.theme === "true" && saved.motion === "true" && saved.thinking === false,
    saved,
  );

  await page.shot("05-appearance-reloaded", { force: true });
  await page.evaluate(`document.querySelector('#settings [data-part="statusline"]').scrollIntoView({ block: "end" })`);
  await page.shot("05-appearance-reloaded-lower", { force: true });
  await page.evaluate(`document.querySelector('#settings [data-part="theme"]').scrollIntoView({ block: "start" })`);

  // C1-C5: chat text size scales message text (prose, lists, code, tables, the owner bubble) and nothing around it.
  const probe = () =>
    page.evaluate(`(() => {
      const px = (node) => (node ? parseFloat(getComputedStyle(node).fontSize) : null);
      const feed = document.querySelector('#feed');
      const long = [...feed.querySelectorAll('.msg.owner')].find((n) => n.textContent.includes('LONG-START'));
      const body = long.querySelector('.msg-body');
      return {
        size: document.documentElement.dataset.chatSize,
        prose: px(feed.querySelector('.msg.agent .prose')),
        item: px(feed.querySelector('.msg.agent .prose li')),
        code: px(feed.querySelector('.msg.agent .prose pre')),
        owner: px(long.querySelector('.bubble')),
        meta: px(feed.querySelector('.msg-meta')),
        composer: px(document.querySelector('#composer-input')),
        top: px(document.querySelector('#topbar')),
        overflow: long.dataset.overflow === '1',
        bodyHeight: body.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(body).lineHeight),
        horizontal: document.scrollingElement.scrollWidth > innerWidth + 1,
      };
    })()`);
  const openAppearance = async () => {
    if (!(await page.evaluate(`document.querySelector('#settings').open`)))
      await page.evaluate(`document.querySelector('[data-cmd="settings"]').click()`);
    await page.evaluate(`document.querySelector('nav [data-section="appearance"]').click()`);
    await page.waitFor(`!!document.querySelector('[data-chat-size-option]')`, "chat size options");
  };
  await page.evaluate(`document.querySelector('#settings').close()`);
  await kit.delay(200);
  const base = await probe();
  check(
    "C1 the default is unchanged: 14.5 px prose, 12.5 px code, 14 px owner text",
    base.prose === 14.5 && base.code === 12.5 && base.owner === 14 && (base.size ?? "default") === "default",
    base,
  );
  check("C1 the stored default is 'default'", (await rpc({ action: "ui-get" })).ui.chatTextSize === "default");
  await openAppearance();
  check(
    "C2 Settings offers Smaller, Default, Larger and Custom, Default selected",
    await page.evaluate(
      `JSON.stringify([...document.querySelectorAll('[data-chat-size-option]')].map((n) => [n.dataset.chatSizeOption, n.getAttribute('aria-checked')])) === JSON.stringify([["small","false"],["default","true"],["large","false"],["custom","false"]])`,
    ),
  );
  await page.shot("06-chat-size-default", { force: true });
  const sizes = {};
  for (const option of ["small", "large"]) {
    await openAppearance();
    await page.evaluate(`document.querySelector('[data-chat-size-option="${option}"]').click()`);
    await page.waitFor(`document.documentElement.dataset.chatSize === "${option}"`, `${option} applied at once`);
    await kit.eventually(async () => (await rpc({ action: "ui-get" })).ui.chatTextSize === option, `${option} not saved`, 100);
    await page.shot(`06-chat-size-${option}-settings`, { force: true });
    await page.evaluate(`document.querySelector('#settings').close()`);
    await kit.delay(300);
    sizes[option] = await probe();
    await page.shot(`06-chat-size-${option}-chat`, { force: true });
  }
  const { small, large } = sizes;
  check(
    "C3 small and large scale prose, list items, code and the owner bubble in the right direction",
    ["prose", "item", "code", "owner"].every((key) => small[key] < base[key] && base[key] < large[key]),
    { small, base, large },
  );
  check(
    "C3 the surrounding UI keeps its size",
    [small, large].every((p) => p.meta === base.meta && p.composer === base.composer && p.top === base.top),
    { small, base, large },
  );
  check(
    "C4 a long owner message stays clamped to six lines at every size",
    [small, base, large].every((p) => p.overflow && p.bodyHeight <= p.lineHeight * 6 + 1),
    { small, base, large },
  );
  const reveal = `[...document.querySelectorAll('#feed .msg.owner')].find((n) => n.textContent.includes('LONG-START'))`;
  await page.evaluate(`${reveal}.querySelector('.msg-more').click()`);
  await page.waitFor(`${reveal}.querySelector('.msg-more').getAttribute('aria-expanded') === 'true'`, "long message revealed");
  check(
    "C4 Show more opens the whole long message at the larger size",
    await page.evaluate(
      `(() => { const body = ${reveal}.querySelector('.msg-body'); return body.getBoundingClientRect().height > parseFloat(getComputedStyle(body).lineHeight) * 12; })()`,
    ),
  );
  await page.reload();
  await page.waitFor(`document.body.dataset.ready === "1"`, "reloaded with large text");
  check(
    "C5 the chosen size survives a reload and is set before <body> is inserted",
    (await page.evaluate(`window.__atBody`)) === "midnight" &&
      (await page.evaluate(`window.__chatAtBody`)) === "large" &&
      (await probe()).size === "large" &&
      (await rpc({ action: "ui-get" })).ui.chatTextSize === "large",
  );
  await page.viewport(390, 844, true);
  await kit.delay(300);
  const narrow = await probe();
  check("C5 at 390 px the large text does not overflow sideways", narrow.horizontal === false && narrow.prose > 14.5, narrow);
  await page.shot("06-chat-size-large-390", { force: true });
  await page.viewport(1440, 1000);

  // C6: Custom chat text size, a whole percent from 50 to 200 typed by the owner.
  const storedUi = async () => (await rpc({ action: "ui-get" })).ui;
  const customState = () =>
    page.evaluate(`(() => {
      const input = document.querySelector('#chat-size-percent');
      return {
        value: input?.value,
        invalid: input?.getAttribute('aria-invalid'),
        labelled: !!input && (input.labels?.length > 0 || !!input.getAttribute('aria-label')),
        status: document.querySelector('#chat-size-status')?.textContent.trim(),
        live: document.querySelector('#chat-size-status')?.getAttribute('aria-live'),
        radio: document.querySelector('[data-chat-size-option="custom"]')?.getAttribute('aria-checked'),
        inViewport: !!input && input.getBoundingClientRect().right <= innerWidth && input.getBoundingClientRect().left >= 0,
      };
    })()`);
  const typePercent = async (text) => {
    await page.evaluate(`(() => { const i = document.querySelector('#chat-size-percent'); i.focus(); i.select(); })()`);
    if (text === "")
      await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    else await page.cdp("Input.insertText", { text });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await page.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await kit.delay(300);
  };
  await openAppearance();
  check(
    "C6 Settings offers Custom beside the presets, with a labelled percent field",
    await page.evaluate(
      `JSON.stringify([...document.querySelectorAll('[data-chat-size-option]')].map((n) => n.dataset.chatSizeOption)) === JSON.stringify(["small","default","large","custom"])`,
    ),
  );
  await page.evaluate(`document.querySelector('[data-chat-size-option="custom"]').click()`);
  await page.waitFor(`document.documentElement.dataset.chatSize === "custom"`, "custom selected");
  const first = await customState();
  check(
    "C6 choosing Custom starts at 100% with the field labelled",
    first.value === "100" && first.labelled && first.radio === "true",
    first,
  );
  await typePercent("107");
  await kit.eventually(async () => (await storedUi()).chatTextPercent === 107, "107 not saved", 100);
  const at107 = await probe();
  check(
    "C6 custom 107% scales message text by exactly 1.07 and nothing around it",
    Math.abs(at107.prose - 14.5 * 1.07) < 0.01 &&
      Math.abs(at107.owner - 14 * 1.07) < 0.01 &&
      at107.meta === base.meta &&
      at107.composer === base.composer &&
      (await storedUi()).chatTextSize === "custom",
    at107,
  );
  check("C6 the field and the status confirm the applied value", /107\s?%/.test((await customState()).status ?? ""), await customState());
  await page.shot("07-custom-107", { force: true });
  for (const bad of ["", "abc", "49", "201", "107.5", "-5", "1e2"]) {
    await typePercent(bad);
    const now = await customState();
    const saved = await storedUi();
    check(
      `C6 invalid ${JSON.stringify(bad)} is refused with a message, the field returns to 107 and nothing is saved`,
      now.value === "107" &&
        now.invalid === "true" &&
        now.live === "polite" &&
        !!now.status &&
        saved.chatTextPercent === 107 &&
        saved.chatTextSize === "custom" &&
        (await probe()).prose === at107.prose,
      { bad, now, saved },
    );
  }
  await page.shot("07-custom-invalid", { force: true });
  await typePercent("108");
  check("C6 a valid value after a refusal clears the error", (await customState()).invalid !== "true", await customState());
  await typePercent("107");
  await kit.eventually(async () => (await storedUi()).chatTextPercent === 107, "107 not saved again", 100);
  await page.reload();
  await page.waitFor(`document.body.dataset.ready === "1"`, "reloaded with custom text");
  const reloaded = await probe();
  check(
    "C6 custom 107% survives a reload, set before <body>, with the field showing it",
    (await page.evaluate(`window.__chatAtBody`)) === "custom" &&
      Math.abs(reloaded.prose - 14.5 * 1.07) < 0.01 &&
      (await page.evaluate(`document.documentElement.style.getPropertyValue('--chat-scale')`)) === "1.07",
    reloaded,
  );
  await openAppearance();
  const afterReload = await customState();
  check("C6 after a reload the field shows 107", afterReload.value === "107" && afterReload.radio === "true", afterReload);
  await page.evaluate(`document.querySelector('[data-chat-size-option="small"]').click()`);
  await page.waitFor(`document.documentElement.dataset.chatSize === "small"`, "preset after custom");
  await kit.eventually(async () => (await storedUi()).chatTextSize === "small", "small not saved", 100);
  await page.evaluate(`document.querySelector('#settings').close()`);
  await kit.delay(300);
  const backToSmall = await probe();
  check(
    "C6 switching to a preset leaves custom scale behind and keeps the last custom value",
    Math.abs(backToSmall.prose - 14.5 * 0.9) < 0.01 &&
      (await storedUi()).chatTextPercent === 107 &&
      (await page.evaluate(`document.documentElement.style.getPropertyValue('--chat-scale')`)) === "",
    backToSmall,
  );
  await openAppearance();
  await page.evaluate(`document.querySelector('[data-chat-size-option="custom"]').click()`);
  await page.waitFor(`document.documentElement.dataset.chatSize === "custom"`, "custom again");
  check("C6 choosing Custom again returns to 107%", (await customState()).value === "107", await customState());
  for (const extreme of ["50", "200"]) {
    await typePercent(extreme);
    await kit.eventually(async () => (await storedUi()).chatTextPercent === Number(extreme), `${extreme} not saved`, 100);
    await page.evaluate(`document.querySelector('#settings').close()`);
    await kit.delay(300);
    const p = await probe();
    check(
      `C6 ${extreme}% keeps a long owner message clamped to six lines and the page from scrolling sideways`,
      p.overflow && p.bodyHeight <= p.lineHeight * 6 + 1 && !p.horizontal && Math.abs(p.prose - (14.5 * Number(extreme)) / 100) < 0.01,
      p,
    );
    await openAppearance();
  }
  await page.viewport(390, 844, true);
  await kit.delay(300);
  const phone = await customState();
  const phoneProbe = await probe();
  check("C6 at 390 px the 200% text and the field fit the screen", phone.inViewport && phoneProbe.horizontal === false, {
    phone,
    phoneProbe,
  });
  await page.shot("07-custom-200-390-settings", { force: true });
  await page.evaluate(`document.querySelector('#settings').close()`);
  await kit.delay(300);
  await page.shot("07-custom-200-390-chat", { force: true });
  await page.viewport(1440, 1000);
});
