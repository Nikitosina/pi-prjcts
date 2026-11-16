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
    source: `window.__atBody = null; new MutationObserver(() => { if (document.body && window.__atBody === null) window.__atBody = document.documentElement.dataset.theme ?? ''; }).observe(document, { childList: true, subtree: true });`,
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
  for (const type of ["keyDown", "keyUp"])
    await page.cdp("Input.dispatchKeyEvent", {
      type,
      key: "h",
      code: "KeyH",
      windowsVirtualKeyCode: 72,
      text: type === "keyDown" ? "h" : undefined,
    });
  await page.waitFor(`document.querySelector('#settings').dataset.section === "appearance"`, "letter H opens Appearance");
  check(
    "A3 the letter H opens Appearance; a binding saved for the old Theme page binds Appearance",
    await page.evaluate(
      `import("/hotkeys.js").then((keys) => { keys.setOverrides({ "settings-theme": "G" }); const carried = keys.binding("settings-appearance") === "G"; keys.setOverrides({}); return carried; })`,
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
});
