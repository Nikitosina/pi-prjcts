// Browser E2E: a file URL dropped or pasted into the composer becomes a plain path at the caret; a bare File gets an honest fallback.
// Chrome cannot be handed a real Finder drag, so every transfer here is a synthetic DataTransfer; what Finder really supplies is a manual check.
// Failure cases: composer-paths-failures.md. Artifact: artifacts/composer-paths-<time>/ (screenshots with E2E_SHOTS=1).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createKit, say } from "./lib/e2e-kit.mjs";

const kit = await createKit("composer-paths", { handler: ({ user }) => say(`ACK ${user.slice(0, 80)}`) });
const { check, rpc } = kit;
kit.initRepo();

const folder = join(mkdtempSync(join(tmpdir(), "composer-paths-")), "Мои файлы #1");
mkdirSync(folder, { recursive: true });
const target = join(folder, "отчёт 100%.txt");
writeFileSync(target, "private contents never read by the page");
const targetUrl = pathToFileURL(target).href;

await kit.run(async () => {
  const id = await kit.createProject("Paths");
  const page = await kit.openPage(await kit.webUrl(id));
  const ev = page.evaluate;
  await page.waitFor(`document.body.dataset.ready === "1" && !!document.querySelector('#composer-input')`, "composer");
  await ev(`(() => {
    window.__reads = [];
    for (const name of ["text", "arrayBuffer", "stream", "slice"]) {
      const original = Blob.prototype[name];
      Blob.prototype[name] = function (...args) { window.__reads.push(name); return original.apply(this, args); };
    }
    const reader = FileReader.prototype.readAsText;
    for (const name of ["readAsText", "readAsArrayBuffer", "readAsDataURL", "readAsBinaryString"]) {
      const original = FileReader.prototype[name];
      FileReader.prototype[name] = function (...args) { window.__reads.push(name); return original.apply(this, args); };
    }
    window.__send = (kind, data, name) => {
      const box = document.querySelector('#composer-input');
      const dt = new DataTransfer();
      for (const [type, value] of Object.entries(data)) dt.setData(type, value);
      if (name) dt.items.add(new File(["secret"], name, { type: "text/plain" }));
      const event = kind === "paste" ? new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
        : new DragEvent(kind, { dataTransfer: dt, bubbles: true, cancelable: true });
      box.dispatchEvent(event);
      return { prevented: event.defaultPrevented, value: box.value, start: box.selectionStart, end: box.selectionEnd };
    };
    window.__draft = (value, start, end = start) => {
      const box = document.querySelector('#composer-input');
      box.focus(); box.value = value; box.dispatchEvent(new Event('input')); box.setSelectionRange(start, end);
    };
    window.__toast = () => [...document.querySelectorAll('#toasts .toast')].map((n) => n.innerText).join('|');
  })()`);
  const messagesBefore = (await rpc({ action: "show", id })).messages.length;

  await ev(`__draft("before  after", 7)`);
  const dropped = await ev(`__send("drop", { "text/uri-list": ${JSON.stringify(targetUrl)} })`);
  check("P1/P2/P7 drop inserts the decoded plain path at the caret", dropped.value === `before ${target} after`, dropped);
  check("P7 caret ends after the inserted path", dropped.start === 7 + target.length && dropped.end === dropped.start, dropped);
  check("P4 the drop is handled (no navigation to the file)", dropped.prevented);
  await page.shot("01-drop-path");

  await ev(`__draft("keep this draft", 4, 9)`);
  const pasted = await ev(`__send("paste", { "text/uri-list": ${JSON.stringify(targetUrl)}, "text/plain": "отчёт 100%.txt" })`);
  check("P5/P7 paste replaces the selection with the path, not the basename", pasted.value === `keep${target} draft`, pasted);

  await ev(`__draft("two files: ", 11)`);
  const many = await ev(`__send("drop", { "text/uri-list": ${JSON.stringify(`${targetUrl}\r\nfile:///tmp/second%20file.txt\r\n`)} })`);
  check("P11 several files go on their own lines", many.value === `two files: ${target}\n/tmp/second file.txt`, many);

  await ev(`__draft("draft stays", 5)`);
  const fileOnly = await ev(`__send("drop", {}, "отчёт 100%.txt")`);
  check(
    "P4 a bare File leaves the draft and caret alone",
    fileOnly.value === "draft stays" && fileOnly.start === 5 && fileOnly.prevented,
    fileOnly,
  );
  const note = await ev(`__toast()`);
  check("P4 the fallback names Copy as Pathname and invents no path", /Copy as Pathname/.test(note) && !note.includes("/"), note);
  await page.shot("02-file-only-fallback");

  await ev(`__draft("paste stays", 4)`);
  const nameOnly = await ev(`__send("paste", { "text/plain": "отчёт 100%.txt" }, "отчёт 100%.txt")`);
  check("P5 a Finder-copied file inserts no basename", nameOnly.value === "paste stays" && nameOnly.prevented, nameOnly);

  await ev(`__draft("plain ", 6)`);
  const plain = await ev(`__send("paste", { "text/plain": ${JSON.stringify(target)} })`);
  check("P6 plain-text paste is left to the browser", !plain.prevented && plain.value === "plain ", plain);

  const link = await ev(`__send("drop", { "text/uri-list": "https://example.com/a" })`);
  check("P3 a web link is not turned into a path", !link.prevented && !link.value.includes("example.com"), link);

  await ev(`__draft("x".repeat(23990), 23990)`);
  const long = await ev(`__send("drop", { "text/uri-list": ${JSON.stringify(targetUrl)} })`);
  check("P12 an over-long insertion is refused, not cut", long.value.length === 23990, long.value.length);

  check("P9 no file contents were read", (await ev(`window.__reads`)).length === 0, await ev(`window.__reads`));
  check("P8 nothing was sent", (await rpc({ action: "show", id })).messages.length === messagesBefore);
  check(
    "P10 the Host agent composer ignores drops",
    await ev(`(() => { const box = document.querySelector('#ha-composer textarea'); if (!box) return true;
    const dt = new DataTransfer(); dt.setData('text/uri-list', ${JSON.stringify(targetUrl)});
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return box.value === ''; })()`),
  );
});
