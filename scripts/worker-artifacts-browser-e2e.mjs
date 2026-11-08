// Browser E2E: worker artifacts in the inbox at `/` (inline media in the worker view) and the per-worker listing. Isolated host, local fake model, headless Chrome.
// Failure modes (written first): scripts/worker-artifacts-browser-failures.md. Artifact: artifacts/worker-artifacts-browser-<stamp>/{result.json,*.png}.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kit, delay, randomUUID } from "./notify-kit.mjs";

let root;
const respond = async ({ coordinator, userText, results, tools, say, call }) => {
  if (coordinator) {
    if (/MARK-BROWSE\b/.test(userText)) {
      const steps = [
        { title: "BROWSE-A", brief: "BROWSE-A produce evidence" },
        { title: "BROWSE-B", brief: "BROWSE-B second worker" },
        { title: "BROWSE-C", brief: "BROWSE-C saves nothing" },
      ];
      if (results.length < steps.length)
        return call("agents", {
          action: "spawn",
          role: "worker",
          acceptance: ["done"],
          requestId: `browse-${results.length}`,
          ...steps[results.length],
        });
    }
    return undefined;
  }
  if (!tools.includes("bash")) return undefined;
  if (/BROWSE-A/.test(userText)) {
    if (results.length === 0)
      return call("bash", {
        command: [
          'echo "DIR=$PI_ARTIFACTS_DIR"',
          'cd "$PI_ARTIFACTS_DIR"',
          'mkdir -p docs data logs a/b/c "my notes"',
          `cp ${root}/shot.png shot.png`,
          `cp ${root}/tiny.png tiny.png`,
          `cp ${root}/demo.webm demo.webm`,
          `printf '# Report title\\n\\nSome **bold** text <script>window.__xss=1</script>\\n\\n- item one\\n' > docs/readme.md`,
          `printf '{"ok":true,"items":[1,2]}' > data/result.json`,
          `yes 'LOG-LINE-0123456789 padding padding padding' | head -c 700000 > logs/big.log && printf 'TAIL-MARKER-END\\n' >> logs/big.log`,
          "head -c 2000 /dev/urandom > blob.bin",
          `printf 'deep file' > a/b/c/deep.txt`,
          `printf 'unicode ok' > "my notes/résumé 日本.txt"`,
          `printf '<script>window.__xss=1</script><iframe src=x></iframe><h1>HTML-AS-TEXT</h1>' > xss.html`,
          `printf x > "<img src=x onerror=window.__xss=1>.txt"`,
          "sleep 1.2",
          `printf newest > zz-newest.txt`,
        ].join(" && "),
      });
    const thread = /DIR=\S*\/artifacts\/([0-9a-f-]{36})/.exec(results[0] ?? "")?.[1];
    return say(
      `BROWSE-DONE\n\n![Screenshot](artifact:${thread}/shot.png)\n\n![Tiny sunrise](artifact:${thread}/tiny.png)\n\nSummary: [readme](artifact:${thread}/docs/readme.md) and [deep](artifact:${thread}/a/b/c/deep.txt)`,
    );
  }
  if (/BROWSE-B/.test(userText)) {
    if (results.length === 0) return call("bash", { command: 'cd "$PI_ARTIFACTS_DIR" && printf second > second.txt' });
    return say("BROWSE-B-DONE");
  }
  return undefined;
};
const k = await kit("worker-artifacts-browser", {}, respond);
root = k.root;
const { rpc, result, eventually, evaluate, waitFor, shot, openPage, send } = k;
const check = (name, ok, detail) => {
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`);
  result.checks.push(name);
  process.stderr.write(`PASS ${name}\n`);
};
const q = (value) => JSON.stringify(value);
const click = (selector, s) => evaluate(`document.querySelector(${q(selector)}).click()`, s);
const viewport = (width, height, mobile, s) =>
  send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile }, s);

try {
  await k.startHost();
  const web = await rpc({ action: "web" }),
    base = new URL(web.url);
  const s = (k.lastSession = await openPage(`${base.origin}/`));
  await delay(800);
  const media = await evaluate(
    `(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 200; const g = c.getContext('2d');
    g.fillStyle = '#c2653a'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.font = '28px sans-serif'; g.fillText('ARTIFACT', 80, 110);
    const png = c.toDataURL('image/png').split(',')[1];
    // Genuinely small, recognizable 96x64 image: sky, sun, hills.
    const t = document.createElement('canvas'); t.width = 96; t.height = 64; const tg = t.getContext('2d');
    tg.fillStyle = '#7fb8e6'; tg.fillRect(0, 0, 96, 64); tg.fillStyle = '#ffd23f'; tg.beginPath(); tg.arc(68, 26, 12, 0, 7); tg.fill();
    tg.fillStyle = '#3f8f4f'; tg.beginPath(); tg.moveTo(0, 64); tg.lineTo(0, 44); tg.quadraticCurveTo(30, 24, 60, 48); tg.lineTo(96, 40); tg.lineTo(96, 64); tg.fill();
    const tiny = t.toDataURL('image/png').split(',')[1];
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' }); const parts = [];
    rec.ondataavailable = e => parts.push(e.data); const done = new Promise(ok => rec.onstop = ok); rec.start(100);
    for (let i = 0; i < 12; i++) { g.fillStyle = 'hsl(' + i * 30 + ',70%,50%)'; g.fillRect(i * 20, 0, 20, 200); await new Promise(ok => setTimeout(ok, 80)); }
    rec.stop(); await done;
    const buf = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer()); let bin = ''; for (const b of buf) bin += String.fromCharCode(b);
    return { png, tiny, webm: btoa(bin) };
  })()`,
    s,
  );
  writeFileSync(join(root, "shot.png"), Buffer.from(media.png, "base64"));
  writeFileSync(join(root, "tiny.png"), Buffer.from(media.tiny, "base64"));
  writeFileSync(join(root, "demo.webm"), Buffer.from(media.webm, "base64"));
  check("fixtures: browser-made PNG and webm", media.png.length > 100 && media.webm.length > 1000);

  const id = await k.setup("Browse", k.gitRepo);
  const snap = await rpc({ action: "owner-setup-snapshot", id });
  await rpc({ action: "workspace-quick-grant", id, confirm: id, expectedRevision: snap.workspaceRevision });
  await rpc({ action: "message", id, text: "MARK-BROWSE please produce evidence with three workers" });
  const agents = await eventually(
    async () => {
      const list = (await rpc({ action: "jobs-snapshot", id })).agents;
      return list.length >= 3 && list.every((agent) => agent.endedAt) && list;
    },
    "workers did not settle",
    1800,
  );
  const threadOf = (marker) => agents.find((agent) => agent.title === marker).id;
  const [threadA, threadB, threadC] = ["BROWSE-A", "BROWSE-B", "BROWSE-C"].map(threadOf);
  const listingA = await rpc({ action: "artifacts-list", id, threadId: threadA });
  const dirA = join(k.home, id, "artifacts", threadA);
  check(
    "setup: fake worker saved nested, unicode, large and hostile files",
    listingA.files.length === 12 &&
      listingA.files.some((f) => f.path === "a/b/c/deep.txt") &&
      listingA.files.some((f) => f.path === "my notes/résumé 日本.txt"),
    listingA.files.map((f) => f.path),
  );

  // The inbox at `/` has no artifact browser (classic three-column browser and image lightbox retired 2026-11-04). Worker A's files reach
  // the owner as inline media and artifact links in the worker view; the listing stays checked over `artifacts-list`.
  const url = new URL(web.url);
  url.searchParams.set("project", id);
  const origin = await evaluate("performance.timeOrigin", s);
  await send("Page.navigate", { url: url.toString() }, s);
  await waitFor(`performance.timeOrigin !== ${origin} && document.body?.dataset.ready === "1"`, s, "new document");
  const openWorker = async (thread) => {
    await waitFor(`!!document.querySelector('#workers [data-open-worker=${q(thread)}]')`, s, `worker ${thread} listed`);
    await click(`#workers [data-open-worker=${q(thread)}]`, s);
    await waitFor(`!!document.querySelector('#focus-view #worker-feed')`, s, "worker view");
  };
  await openWorker(threadA);
  await waitFor(`document.querySelector('#worker-feed img.media-img')?.naturalWidth === 320`, s, "inline image in the worker view");
  check("F10 the worker's inline image renders in the worker view", true);
  const refs = await evaluate(`[...document.querySelectorAll('#worker-feed [data-artifact-open]')].map(n => n.innerText)`, s);
  check("F10 the worker's artifact links show as open buttons", refs.includes("readme") && refs.includes("deep"), refs);
  check("F7 hostile file names and HTML never run", await evaluate(`!window.__xss`, s));
  await shot("01-worker-view-media", s);

  // F9: a file written later is listed after the worker's next commit; F11/F12: listings are per worker; an empty worker lists nothing.
  mkdirSync(join(dirA, "late"), { recursive: true });
  writeFileSync(join(dirA, "late", "new-late.txt"), "arrived later");
  await rpc({ action: "thread-send", id, threadId: threadA, requestId: randomUUID(), text: "MARK-LATE one more thing" });
  await eventually(
    async () => (await rpc({ action: "artifacts-list", id, threadId: threadA })).files.some((f) => f.path === "late/new-late.txt"),
    "late file not listed",
    600,
  );
  check("F9 a file written while the worker runs is listed", true);
  const listingB = await rpc({ action: "artifacts-list", id, threadId: threadB });
  check("F11 each worker lists only its own files", listingB.files.map((f) => f.path).join() === "second.txt", listingB.files);
  check("F12 a worker without artifacts lists none", (await rpc({ action: "artifacts-list", id, threadId: threadC })).files.length === 0);

  await click('#focus-view [data-cmd="leave-focus"]', s);
  await waitFor(`!document.querySelector('#focus-view #worker-feed')`, s, "Back closes the worker view");
  await viewport(390, 844, true, s);
  await openWorker(threadA);
  await waitFor(`document.querySelector('#worker-feed img.media-img')?.naturalWidth === 320`, s, "mobile inline image");
  await delay(300);
  check(
    "F13 390px: the worker view with its media fits the screen",
    await evaluate(
      `document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('#worker-feed img.media-img').getBoundingClientRect().right <= innerWidth + 1`,
      s,
    ),
  );
  await shot("02-mobile-worker-view", s);
  check("F15 no browser console or HTTP errors", result.errors.length === 0 && result.httpErrors.length === 0, {
    errors: result.errors,
    http: result.httpErrors,
  });
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = k.redact(error?.stack ?? error);
  try {
    result.diagnostic = await evaluate(`document.querySelector('#artifact-pane').innerText.slice(0, 1500)`, k.lastSession);
  } catch {}
}
writeFileSync(
  join(k.artifacts, "result.json"),
  JSON.stringify(
    {
      status: result.status,
      failure: result.failure,
      diagnostic: result.diagnostic,
      checks: result.checks,
      layout: result.layout,
      tree: result.tree,
      downloads: result.downloads,
    },
    null,
    2,
  ) + "\n",
);
await k.finish(result.status);
