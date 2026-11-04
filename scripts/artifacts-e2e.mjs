// Browser E2E: per-thread worker artifacts folder, coordinator list/read tools, authenticated route, inline images and download buttons in the inbox at `/`.
// Isolated host, local fake model, headless Chrome. Failure cases: scripts/artifacts-failures.md.
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kit, delay, randomUUID } from "./notify-kit.mjs";

const brain = { workerSystem: [], workerResults: [], coordResults: [], report: "", thread: null, child: null, final: "" };
let root;
const respond = async ({ coordinator, userText, results, tools, say, call, msgs }) => {
  const system = msgs.find((m) => m.role === "system")?.content ?? "";
  if (coordinator) {
    if (/MARK-ART\b/.test(userText) && results.length === 0)
      return call("agents", {
        action: "spawn",
        role: "worker",
        title: "ART-WORKER",
        brief: "ART-WORKER capture evidence of the feature",
        acceptance: ["evidence saved"],
        requestId: "art-1",
      });
    if (userText.startsWith("[worker ") && /ART-WORKER/.test(userText)) {
      brain.report = userText;
      brain.coordResults = results;
      const thread = (brain.thread = /^\[worker ([0-9a-f-]{36}) /.exec(userText)?.[1] ?? brain.thread);
      const steps = [
        ["projects_artifacts_list", { threadId: thread }],
        ["projects_artifacts_list", {}],
        ["projects_artifact_read", { threadId: thread, path: "logs/run.log" }],
        ["projects_artifact_read", { threadId: thread, path: "../../project.json" }],
        ["projects_artifact_read", { threadId: thread, path: "leak.txt" }],
        ["projects_artifact_read", { threadId: thread, path: "shot.png" }],
        ["projects_artifact_read", { threadId: randomUUID(), path: "shot.png" }],
        ["projects_artifacts_list", { threadId: thread, path: "logs" }],
        ["projects_artifacts_list", { threadId: thread, kind: "image" }],
        ["projects_artifacts_list", { threadId: thread, offset: JSON.parse(results[0] ?? "{}").nextOffset ?? 0 }],
        ["projects_artifacts_list", { threadId: thread, limit: 200 }],
      ];
      if (results.length < steps.length) return call(...steps[results.length]);
      brain.final = `ART-FINAL Verified.\n\n![Screenshot](artifact:${thread}/shot.png)\n\n![Demo video](artifact:${thread}/demo.webm)\n\nLog: [run log](artifact:${thread}/logs/run.log)\n\n![Gone](artifact:${thread}/nope.png)\n\n[bad](javascript:alert(1))`;
      return say(brain.final);
    }
    return undefined;
  }
  if (!tools.includes("bash")) return undefined;
  if (/ART-WORKER/.test(userText)) {
    brain.workerSystem.push(String(typeof system === "string" ? system : JSON.stringify(system)));
    if (results.length === 0)
      return call("bash", {
        command: [
          'echo "DIR=$PI_ARTIFACTS_DIR"',
          'echo "PWD=$(pwd)"',
          'cd "$PI_ARTIFACTS_DIR"',
          "mkdir -p logs",
          `cp ${root}/shot.png shot.png`,
          `cp ${root}/demo.webm demo.webm`,
          'printf "line1\\nRUN-LOG-OK\\n" > logs/run.log',
          `ln -s ${root}/secret.txt leak.txt`,
          `ln -s ${root} linkdir`,
          'printf x > "<img src=x onerror=window.__xss=1>.txt"',
          "dd if=/dev/zero of=big.bin bs=1 count=0 seek=600m 2>/dev/null",
          "mkdir -p zz-many && for i in $(seq 100 499); do printf x > zz-many/f$i.txt; done",
          "ls -la",
        ].join(" && "),
      });
    if (results.length === 1) {
      brain.workerResults = results;
      return say("ART-PARENT-DONE Saved shot.png, demo.webm, logs/run.log in my artifacts folder.");
    }
    return undefined;
  }
  return undefined;
};
const k = await kit("artifacts", {}, respond);
root = k.root;
const { rpc, result, eventually, evaluate, waitFor, shot, openPage, send } = k;
const check = (name, ok, detail) => {
  if (!ok) throw Error(`${name}: ${JSON.stringify(detail ?? null).slice(0, 3000)}`);
  result.checks.push(name);
  process.stderr.write(`PASS ${name}\n`);
};
writeFileSync(join(root, "secret.txt"), "TOP-SECRET-ARTIFACT-LEAK\n");

try {
  await k.startHost();
  const web = await rpc({ action: "web" }),
    base = new URL(web.url),
    token = new URLSearchParams(base.hash.slice(1)).get("token");
  // Media fixtures produced by the browser itself: a PNG and a short webm (MediaRecorder from a canvas).
  const s = await openPage(`${base.origin}/`);
  await delay(800);
  const media = await evaluate(
    `(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 200; const g = c.getContext('2d');
    g.fillStyle = '#c2653a'; g.fillRect(0, 0, 320, 200); g.fillStyle = '#fff'; g.font = '28px sans-serif'; g.fillText('ARTIFACT', 80, 110);
    const png = c.toDataURL('image/png').split(',')[1];
    const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' }); const parts = [];
    rec.ondataavailable = e => parts.push(e.data); const done = new Promise(ok => rec.onstop = ok); rec.start(100);
    for (let i = 0; i < 12; i++) { g.fillStyle = 'hsl(' + i * 30 + ',70%,50%)'; g.fillRect(i * 20, 0, 20, 200); await new Promise(ok => setTimeout(ok, 80)); }
    rec.stop(); await done;
    const buf = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer()); let bin = ''; for (const b of buf) bin += String.fromCharCode(b);
    return { png, webm: btoa(bin) };
  })()`,
    s,
  );
  writeFileSync(join(root, "shot.png"), Buffer.from(media.png, "base64"));
  writeFileSync(join(root, "demo.webm"), Buffer.from(media.webm, "base64"));
  check("fixtures: browser-made PNG and webm", media.png.length > 100 && media.webm.length > 1000, {
    png: media.png.length,
    webm: media.webm.length,
  });

  const id = await k.setup("Art", k.gitRepo),
    other = await k.setup("Other");
  const snap = await rpc({ action: "owner-setup-snapshot", id });
  await rpc({ action: "workspace-quick-grant", id, confirm: id, expectedRevision: snap.workspaceRevision });
  await rpc({ action: "message", id, text: "MARK-ART please verify the feature with evidence" });
  await eventually(() => brain.final, "coordinator never wrote the final answer", 1200);
  const view = await eventually(
    async () => {
      const v = await rpc({ action: "show", id });
      return v.messages?.some((m) => /ART-FINAL/.test(m.text ?? "")) && v;
    },
    "final answer not in Main",
    300,
  );
  const thread = brain.thread;
  const dir = join(k.home, id, "artifacts", thread);
  const bashOut = brain.workerResults[0] ?? "";
  const workerDir = /DIR=(\S+)/.exec(bashOut)?.[1] ?? "",
    workerPwd = /PWD=(\S+)/.exec(bashOut)?.[1] ?? "";
  result.paths = { workerDir, workerPwd, expected: dir };
  check(
    "A1 the worker folder lives in the project home, outside the worktree",
    workerDir.endsWith(`/artifacts/${thread}`) &&
      workerDir.startsWith(k.home) &&
      !workerDir.startsWith(workerPwd) &&
      existsSync(join(workerDir, "shot.png")),
    result.paths,
  );
  check("A1 folder is private (0700)", (lstatSync(workerDir).mode & 0o777) === 0o700);
  const system = brain.workerSystem[0] ?? "";
  check(
    "A2 the path and $PI_ARTIFACTS_DIR are in the worker instructions",
    system.includes(workerDir) && system.includes("PI_ARTIFACTS_DIR"),
    system.slice(-1500),
  );
  check(
    "A5/A6 no dangling projects_evidence instruction; workers told to list each saved file as a ref",
    !/projects_evidence/.test(system) && /list each file in your answer as a ref/i.test(system),
  );
  const [list, overview, log, traversal, leak, image, foreign, logsOnly, imagesOnly, nextPage, expanded] = brain.coordResults;
  result.coordResults = brain.coordResults.map((r) => r.slice(0, 1500));
  check(
    "A8 coordinator lists the thread's files with sizes",
    /shot\.png/.test(list) && /logs\/run\.log/.test(list) && /demo\.webm/.test(list) && /"size"/.test(list),
    list?.slice(0, 1500),
  );
  check("A8 the overview names each thread with its first task, file count and total", /"task":"ART-WORKER/.test(overview), overview);
  check(
    "A9 the planted symlinks are skipped, never listed as files",
    (() => {
      const parsed = JSON.parse(list);
      return (
        !parsed.files.some((f) => /leak|linkdir/.test(f.path)) &&
        parsed.skipped.some((f) => f.path === "leak.txt") &&
        parsed.skipped.some((f) => f.path === "linkdir")
      );
    })() && !/TOP-SECRET/.test(list),
    list,
  );
  check(
    "A14 the listing reports the 500 MB soft cap as exceeded; nothing is deleted",
    /"overCap":true/.test(list) && existsSync(join(workerDir, "big.bin")),
  );
  {
    const first = JSON.parse(list),
      next = JSON.parse(nextPage),
      wide = JSON.parse(expanded);
    check(
      "A23 a thread listing is at most 8 KiB, counts every file by kind and folder, and nextOffset continues it",
      Buffer.byteLength(list) <= 8192 &&
        first.matched === first.totalFiles &&
        first.totalFiles >= 405 &&
        first.folders["zz-many"] === 400 &&
        first.kinds.image >= 1 &&
        first.nextOffset === first.files.length &&
        next.files[0].path !== first.files.at(-1).path &&
        next.offset === first.nextOffset,
      { bytes: Buffer.byteLength(list), first: list.slice(0, 600), next: nextPage.slice(0, 300) },
    );
    check(
      "A23 path and kind filter the listing; an explicit limit stays within 16 KiB",
      JSON.parse(logsOnly)
        .files.map((f) => f.path)
        .join() === "logs/run.log" &&
        JSON.parse(imagesOnly).files.every((f) => f.kind === "image") &&
        JSON.parse(imagesOnly).files.some((f) => f.ref === `artifact:${thread}/shot.png`) &&
        Buffer.byteLength(expanded) <= 16384 &&
        wide.files.length > first.files.length,
      { logsOnly, imagesOnly: imagesOnly.slice(0, 600), expanded: Buffer.byteLength(expanded) },
    );
  }
  check("A8 coordinator reads a text artifact", /RUN-LOG-OK/.test(log), log);
  check("A10 traversal is refused", /refused|outside|invalid|not allowed/i.test(traversal) && !/"id"/.test(traversal), traversal);
  check("A9 reading the symlink is refused", /symlink|refused|not a regular/i.test(leak) && !/TOP-SECRET/.test(leak), leak);
  check("A8 an image artifact is readable by the coordinator", /shot\.png|image/i.test(image), image);
  check("A11 an unknown thread is refused", /unknown|not a thread|refused/i.test(foreign), foreign);

  // HTTP route.
  const get = (path, auth = true) => fetch(`${base.origin}${path}`, { headers: auth ? { authorization: `Bearer ${token}` } : {} });
  const ok = await get(`/artifacts/${id}/${thread}/shot.png`);
  const csp = ok.headers.get("content-security-policy") ?? "";
  check(
    "A12 the route serves the image with the token",
    ok.status === 200 &&
      ok.headers.get("content-type") === "image/png" &&
      Buffer.from(await ok.arrayBuffer()).length === Buffer.from(media.png, "base64").length,
  );
  check("A17 CSP allows blob media", /media-src[^;]*blob:/.test(csp), csp);
  check("A12 no token: 401", (await get(`/artifacts/${id}/${thread}/shot.png`, false)).status === 401);
  const statuses = {};
  for (const [label, path] of Object.entries({
    dotdot: `/artifacts/${id}/${thread}/..%2f..%2fproject.json`,
    encoded: `/artifacts/${id}/${thread}/%2e%2e/%2e%2e/project.json`,
    symlink: `/artifacts/${id}/${thread}/leak.txt`,
    symdir: `/artifacts/${id}/${thread}/linkdir/secret.txt`,
    nul: `/artifacts/${id}/${thread}/shot.png%00`,
    otherProject: `/artifacts/${other}/${thread}/shot.png`,
    badThread: `/artifacts/${id}/not-a-uuid/shot.png`,
  })) {
    const response = await get(path);
    const body = await response.text();
    statuses[label] = response.status;
    if (body.includes("TOP-SECRET") || response.status === 200) throw Error(`A9/A10/A11 ${label} leaked: ${response.status}`);
  }
  result.httpRefusals = statuses;
  check(
    "A9/A10/A11 traversal, encoded traversal, symlinks, NUL, other project and bad thread are refused over HTTP",
    Object.values(statuses).every((code) => code >= 400),
    statuses,
  );

  // Chat rendering in the inbox at `/`: images are inline slots, every other artifact is a download button fetched only on click.
  const chatUrl = new URL(web.url);
  chatUrl.searchParams.set("project", id);
  await send("Page.navigate", { url: chatUrl.toString() }, s);
  await waitFor(`[...document.querySelectorAll('#feed .media-img')].some(i => i.complete && i.naturalWidth === 320)`, s, "inline image");
  check("A16 the image renders inline (320 px wide)", true);
  check(
    "A16 the video and the log are buttons, fetched only on click",
    await evaluate(
      `(() => { const names = [...document.querySelectorAll('#feed [data-artifact-open]')].map(b => b.textContent); return names.includes('Demo video') && names.includes('run log') && !performance.getEntriesByType('resource').some(e => /run\\.log|demo\\.webm/.test(e.name)); })()`,
      s,
    ),
  );
  await waitFor(
    `[...document.querySelectorAll('#feed [data-media][data-state=missing]')].some(n => /missing file/.test(n.textContent))`,
    s,
    "missing artifact",
  );
  check('A18 a missing file shows "missing file"', true);
  check(
    "A20 javascript: links are not rendered as links",
    await evaluate(`![...document.querySelectorAll('#feed a')].some(a => /^javascript:/i.test(a.getAttribute('href') ?? ''))`, s),
  );
  await delay(300);
  await shot("01-chat-inline-media", s);
  const fetches = () => evaluate(`performance.getEntriesByType('resource').filter(e => e.name.includes('/shot.png')).length`, s);
  const before = await fetches();
  await k.ask(id, "main", "MARK-PING re-render the transcript");
  await delay(1500);
  check("A19 re-rendering does not refetch the image (blob cache)", (await fetches()) === before && before >= 1, {
    before,
    after: await fetches(),
  });
  // The log button downloads through the authenticated route (one fetch, on click).
  await evaluate(
    `(() => { window.__saved = []; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__saved.push(this.download); return; } return orig.call(this); }; [...document.querySelectorAll('#feed [data-artifact-open]')].find(b => b.textContent === 'run log').click(); })()`,
    s,
  );
  await waitFor(`window.__saved?.includes('run.log')`, s, "log download");
  check(
    "A16 clicking the log downloads it once through the authenticated route",
    await evaluate(`performance.getEntriesByType('resource').filter(e => /\\/artifacts\\/.*run\\.log$/.test(e.name)).length === 1`, s),
  );
  // Owner browsing: the classic Activity artifact browser (A21) was retired with the classic inbox; the listing it showed stays.
  const listing = await rpc({ action: "artifacts-list", id, threadId: thread });
  check(
    "A21 the artifacts-list call gives files with sizes, the cap warning and skipped symlinks",
    listing.files.some((f) => f.path === "logs/run.log" && f.size > 0) && listing.overCap === true && listing.skipped?.length >= 2,
    { overCap: listing.overCap, skipped: listing.skipped, total: listing.totalFiles },
  );
  check(
    "A22 artifacts of a completed thread stay visible",
    (await rpc({ action: "artifacts-list", id, threadId: thread })).files.length >= 5,
  );
  check(
    "A11 artifacts-list refuses another project's thread",
    await rpc({ action: "artifacts-list", id: other, threadId: thread }).then(
      () => false,
      (error) => /unknown thread/i.test(error.message),
    ),
  );
  await delay(300);
  await shot("02-thread-artifacts", s);
  // Expected refusals in this test: the missing artifact (404) issued by the chat.
  result.httpErrors = result.httpErrors.filter((e) => !(e.url.includes("/artifacts/") && /nope\.png$/.test(e.url)));
  void view;
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = k.redact(error?.stack ?? error);
}
await k.finish(result.status);
