// E2E: the live trial launcher `npm run ui2` (scripts/ui2-trial.mjs), cases X1-X4 in scripts/ui2-backend-failures.md, and the
// serving rules S1-S11 of the inbox at `/` in scripts/ui2-web-failures.md.
// HOME is a temp directory, so `~/.pi/agent/projects-ui2` resolves inside it; no real home or provider is touched.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const root = mkdtempSync(join(tmpdir(), "ui2-trial-"));
const decoy = join(root, "decoy-home");
const env = { ...process.env, HOME: root, ZDOTDIR: root, PI_OFFLINE: "1", PI_PROJECTS_HOME: decoy };
for (const key of Object.keys(env))
  if (key === "PI_CODING_AGENT_DIR" || key.startsWith("PI_SUBAGENT") || key === "PI_SESSION_FILE") delete env[key];
const launcher = new URL("./ui2-trial.mjs", import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [launcher, ...args], { env, encoding: "utf8", timeout: 120000 });
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail ?? null).slice(0, 600)}`}`);
  if (!ok) failures.push(name);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const home = join(root, ".pi", "agent", "projects-ui2");
let pid = 0;
try {
  const started = run();
  check("X2 the launcher starts", started.status === 0, { status: started.status, out: started.stdout, err: started.stderr.slice(-2000) });
  const url = /(http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64})/.exec(started.stdout)?.[1];
  check("X2/S8 it prints the root URL with the token", !!url, started.stdout);
  check("X2 it prints a stop command", /npm run ui2 -- stop/.test(started.stdout), started.stdout);
  check("X1 the dedicated home exists with mode 0700", existsSync(home) && (statSync(home).mode & 0o777) === 0o700);
  check("X1 the caller's PI_PROJECTS_HOME is ignored", !existsSync(decoy));
  check(
    "X1 no other home is created",
    readdirSync(join(root, ".pi", "agent"))
      .filter((name) => name.startsWith("projects"))
      .join() === "projects-ui2",
    readdirSync(join(root, ".pi", "agent")),
  );
  pid = Number(readFileSync(join(home, "host.lock"), "utf8"));
  // The host's own launch link, so the serving rules run even when the printed one is wrong.
  const saved = JSON.parse(readFileSync(join(home, "web.json"), "utf8")).url;
  check("S8 web.json holds the root launch link and the launcher prints it", new URL(saved).pathname === "/" && saved === url, {
    saved,
    url,
  });
  {
    const origin = new URL(saved).origin;
    const index = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
    const page = await fetch(`${origin}/`);
    const html = await page.text();
    check("X2/S1 the URL serves the inbox", page.status === 200 && html === index, page.status);
    check(
      "S1 / has the CSP, nosniff, no-cache and an ETag",
      /script-src 'self'/.test(page.headers.get("content-security-policy") ?? "") &&
        page.headers.get("x-content-type-options") === "nosniff" &&
        page.headers.get("cache-control") === "no-cache" &&
        /^"[a-f0-9]{64}"$/.test(page.headers.get("etag") ?? ""),
      Object.fromEntries(page.headers),
    );
    const cached = await fetch(`${origin}/`, { headers: { "if-none-match": page.headers.get("etag") ?? "" } });
    check("S1 / revalidates with 304", cached.status === 304, cached.status);
    for (const [path, mime] of [
      ["/theme.js", "text/javascript"],
      ["/app.js", "text/javascript"],
      ["/chat.js", "text/javascript"],
      ["/styles.css", "text/css"],
      ["/jetbrains-mono-latin-wght-normal.woff2", "font/woff2"],
    ]) {
      const asset = await fetch(origin + path);
      await asset.arrayBuffer();
      check(`S2 ${path} is served as ${mime}`, asset.status === 200 && (asset.headers.get("content-type") ?? "").startsWith(mime), {
        status: asset.status,
        type: asset.headers.get("content-type"),
      });
    }
    check("S2 index.html loads root assets only", /src="\/theme\.js"/.test(html) && !html.includes("/ui2/"), html.slice(0, 400));
    for (const path of ["/app/chat.js", "/vendor/mermaid.min.js", "/index.html", "/boot.js"]) {
      const gone = await fetch(origin + path);
      await gone.arrayBuffer();
      check(`S3 ${path} is not served`, gone.status === 404 || gone.status === 401, gone.status);
    }
    for (const path of ["/%2e%2e/package.json", "/..%2fpackage.json", "/.env", "/package.json", "/sub/app.js", "/src/web.ts"]) {
      const probe = await fetch(origin + path, { redirect: "manual" });
      const text = await probe.text();
      check(`S4 ${path} reads nothing outside web/`, probe.status >= 400 && !text.includes('"name"') && !text.includes("import "), {
        status: probe.status,
        text: text.slice(0, 120),
      });
    }
    const redirect = async (path) => {
      const answer = await fetch(origin + path, { redirect: "manual" });
      await answer.arrayBuffer();
      return { status: answer.status, location: answer.headers.get("location") };
    };
    const query = "?project=00000000-0000-4000-8000-000000000000&chat=main";
    for (const [path, location] of [
      ["/ui2", "/"],
      ["/ui2/", "/"],
      [`/ui2/${query}`, `/${query}`],
      [`/ui2${query}`, `/${query}`],
      ["/ui2/app.js", "/app.js"],
      ["/ui2/styles.css", "/styles.css"],
      ["/ui2/boot.js", "/theme.js"],
    ]) {
      const got = await redirect(path);
      check(`S5/S6 ${path} redirects to ${location}`, got.status === 308 && got.location === location, got);
    }
    for (const path of ["/ui2//evil.example/", "/ui2/missing.js", "/ui2/sub/app.js", "/ui2/%2e%2e/package.json", "/ui2/.env"]) {
      const got = await redirect(path);
      // Dot segments normalize away before the request, then the token rule answers 401.
      check(`S5/S6 ${path} is refused and not an open redirect`, (got.status === 404 || got.status === 401) && !got.location, got);
    }
    const api = await fetch(`${origin}/api`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"action":"list"}',
    });
    check("S7 /api refuses without the token", api.status === 401, api.status);
    const token = new URL(saved).hash.slice("#token=".length);
    const listed = await fetch(`${origin}/api`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: '{"action":"list"}',
    });
    check("S7 /api answers with the launch token", listed.status === 200 && (await listed.json()).ok === true, listed.status);
    const auth = { authorization: `Bearer ${token}` };
    const deep = await fetch(`${origin}/?project=${randomUUID()}&chat=${randomUUID()}`);
    check("S9 a deep link serves the same page", deep.status === 200 && (await deep.text()) === index, deep.status);
    for (const path of ["/projects/x", "/settings", "/index.html", "/chat", "/app"]) {
      const bare = await fetch(`${origin}${path}`, { redirect: "manual" });
      const signed = await fetch(`${origin}${path}`, { redirect: "manual", headers: auth });
      const body = await signed.text();
      check(
        `S9 ${path} is refused, not the page`,
        bare.status === 401 && signed.status === 404 && !body.includes("<html") && !bare.headers.get("location"),
        { bare: bare.status, signed: signed.status },
      );
    }
    const ghost = randomUUID();
    for (const path of [`/artifacts/${ghost}/${randomUUID()}/a.png`, `/uploads/${ghost}/x`, `/evidence/${ghost}/x`, "/live", "/changes"]) {
      const bare = await fetch(`${origin}${path}`);
      check(`S10 ${path.split("/")[1]} needs the token`, bare.status === 401, bare.status);
    }
    for (const path of [
      `/artifacts/${ghost}/${randomUUID()}/a.png`,
      `/artifacts/${ghost}/${randomUUID()}/..%2f..%2fpackage.json`,
      `/uploads/${ghost}/x`,
      `/evidence/${ghost}/x`,
    ]) {
      const signed = await fetch(`${origin}${path}`, { headers: auth });
      const body = await signed.text();
      check(
        `S10 ${path.replace(/[a-f0-9-]{36}/g, "<id>")} serves nothing`,
        signed.status >= 400 && !/"name"|<html/.test(body),
        signed.status,
      );
    }
    const cli = (...args) =>
      // The host is running, so the CLI talks to it and starts nothing.
      spawnSync(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname, ...args], {
        env: { ...env, PI_PROJECTS_HOME: home },
        encoding: "utf8",
        timeout: 60000,
      });
    const project = randomUUID();
    for (const [label, printed] of [
      ["ui-url", cli("ui-url").stdout.trim()],
      ["ui-url <project>", cli("ui-url", project).stdout.trim()],
    ]) {
      let link = null;
      try {
        link = new URL(/https?:\/\/\S+/.exec(printed)?.[0] ?? "");
      } catch {}
      check(
        `S11 projects ${label} prints this host's root with the token`,
        !!link &&
          link.origin === origin &&
          link.pathname === "/" &&
          link.hash === `#token=${token}` &&
          (label === "ui-url" ? !link.search : link.searchParams.get("project") === project),
        printed.replace(/token=[a-f0-9]+/, "token=[redacted]"),
      );
    }
  }
  const second = run();
  check("X3 a second start refuses", second.status !== 0 && /already/i.test(second.stderr + second.stdout), second.stderr);
  check("X3 the running host is left alone", alive(pid));
  const stopped = run("stop");
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) {
    gone = !alive(pid);
    if (!gone) await delay(100);
  }
  check("X4 the stop command stops that host", stopped.status === 0 && gone, { out: stopped.stdout, err: stopped.stderr });
} finally {
  if (pid && alive(pid)) process.kill(pid, "SIGTERM");
  rmSync(root, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("ui2-trial-e2e passed");
