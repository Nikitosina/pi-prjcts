// E2E: MCP servers per profile (saved profiles, unrestricted gateway tools, pool resilience, recovery). The classic Settings picker was
// retired on 2026-11-04; profiles are saved through settings-update as it did. Fakes only:
// fake stdio MCP server, temp mcp.json via PI_PROJECTS_MCP_CONFIG, fake model, private HOME. Failure cases: mcp-failures.md.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createKit, call, say, randomUUID, delay } from "./lib/e2e-kit.mjs";

const handler = ({ role, user, results }) => {
  if (user.startsWith("[Durable work")) return say("Noted report.");
  if (role === "coordinator" && results.length === 0) {
    const w = /MARK-W (.+)$/m.exec(user)?.[1],
      s = /MARK-S (.+)$/m.exec(user)?.[1];
    if (w) return call("projects_delegate", { role: "worker", task: `W-TASK ${w}` });
    if (s) return call("projects_delegate", { role: "scout", task: `S-TASK ${s}` });
  }
  if (role === "coordinator" && results.length > 0 && /MARK-[WS]/.test(user)) return say("Noted.");
  if (results.length > 0) return undefined;
  const script = /MCP-CODE (\S+) (\S+)/.exec(user);
  if (script)
    return call("codemode", {
      code: `let value, error;
try { value = await tools.projects_mcp_call(${JSON.stringify({ server: script[1], tool: script[2] })}); } catch (e) { error = String(e.message ?? e); }
console.log(JSON.stringify({ type: typeof value, value, error }));`,
    });
  const run = /MCP-CALL (\S+) (\S+)(?: (\{[^\n]*\}))?/.exec(user);
  if (run) return call("projects_mcp_call", { server: run[1], tool: run[2], arguments: run[3] ? JSON.parse(run[3]) : {} });
  const list = /MCP-TOOLS(?: ([A-Za-z][\w-]*))?(?: (\w+))?/.exec(user);
  if (list) return call("projects_mcp_tools", list[1] ? { server: list[1], ...(list[2] ? { tool: list[2] } : {}) } : {});
  return undefined;
};
const kit = await createKit("mcp", { handler });
const { root, check, rpc, result } = kit;
const calls = join(root, "mcp-calls.jsonl"),
  SECRET = "SECRET-xyzzy-123";
const server = (tag) => ({
  command: process.execPath,
  args: [join(kit.repo, "scripts/fake-mcp-server.mjs")],
  env: { FAKE_MCP_TAG: tag, FAKE_MCP_CALLS: calls, FAKE_MCP_SECRET: SECRET, FAKE_MCP_CACHE: "${PI_WORKSPACE_CACHE}/DerivedData" },
  timeout: 2,
  description: `Fake ${tag} server`,
});
// Real HTTP transport and Pi credential format; no external OAuth endpoints or tools.
let refreshes = 0;
const oauthHeaders = [];
const oauth = createServer(async (req, res) => {
  const input = [];
  for await (const chunk of req) input.push(chunk);
  const text = Buffer.concat(input).toString();
  const json = (value, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.url === "/token") {
    refreshes++;
    const form = new URLSearchParams(text);
    return json(
      form.get("refresh_token") === "refresh-secret"
        ? { access_token: "fresh-secret", refresh_token: "rotated-secret", token_type: "Bearer", expires_in: 3600 }
        : { error: "invalid_grant", error_description: "refresh-secret must not escape" },
      form.get("refresh_token") === "refresh-secret" ? 200 : 400,
    );
  }
  oauthHeaders.push(req.headers.authorization);
  if (!["Bearer fresh-secret", "Bearer static-secret"].includes(req.headers.authorization)) {
    res.setHeader("www-authenticate", 'Bearer error="invalid_token"');
    return json({ error: "fresh-secret must not escape" }, 401);
  }
  if (req.method === "GET") {
    res.writeHead(405);
    return res.end();
  }
  const msg = JSON.parse(text);
  if (!msg.id) {
    res.writeHead(202);
    return res.end();
  }
  json({
    jsonrpc: "2.0",
    id: msg.id,
    result:
      msg.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-oauth", version: "1" } }
        : { tools: [{ name: "read_info", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] },
  });
});
await new Promise((resolve) => oauth.listen(0, "127.0.0.1", resolve));
const oauthUrl = `http://127.0.0.1:${oauth.address().port}/mcp`;
const configPath = join(root, "fake-mcp.json");
const config = {
  mcpServers: {
    "fake-ci": server("ci"),
    "fake-tracker": server("tracker"),
    "fake-xcode": server("xcode"),
    "fake-off": { ...server("off"), enabled: false },
    "fake-oauth": { url: oauthUrl, oauth: {}, description: "Needs a browser sign-in" },
  },
};
writeFileSync(configPath, JSON.stringify(config));
writeFileSync(calls, "");
Object.assign(kit.hostEnv, { PI_PROJECTS_MCP_CONFIG: configPath });
// A decoy "real" config in the private HOME: it must never be read.
mkdirSync(join(kit.agentDir), { recursive: true });
writeFileSync(join(kit.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "decoy-real": { command: "/bin/false" } } }));
kit.initRepo();
const serverLog = () =>
  readFileSync(calls, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

await kit.run(async () => {
  const id = await kit.createProject("MCP");
  const ask = (text) => kit.ask(id, text);
  let n = 0;
  const coord = async (text, marker = `#${++n}`) => {
    await ask(`${text} ${marker}`);
    return kit.toolResult("coordinator", marker);
  };
  const worker = async (text) => {
    const marker = `#${++n}`;
    await ask(`MARK-W ${marker} ${text}`);
    return kit.toolResult("worker", `W-TASK ${marker}`);
  };
  const scout = async (text) => {
    const marker = `#${++n}`;
    await ask(`MARK-S ${marker} ${text}`);
    return kit.toolResult("scout", `S-TASK ${marker}`);
  };

  // Catalog: config path override, statuses, no secrets.
  const catalog = await rpc({ action: "mcp-catalog", id });
  const status = Object.fromEntries(catalog.servers.map((item) => [item.name, item.status]));
  check(
    "F1 the catalog reads only the overridden config (decoy ignored)",
    catalog.path === configPath && !("decoy-real" in status),
    catalog,
  );
  check(
    "F5 statuses: ready / disabled / needs-sign-in",
    status["fake-ci"] === "ready" &&
      status["fake-off"] === "disabled" &&
      status["fake-oauth"] === "needs-sign-in" &&
      catalog.servers.length === 5,
    status,
  );
  check("F14 the catalog never carries env values", !JSON.stringify(catalog).includes(SECRET));
  const snapshot = await rpc({ action: "settings-snapshot", id });
  check("F16 a project without MCP settings reports mcp = null", snapshot.values.mcp === null, snapshot.values.mcp);

  // Default: every ready server is on for every profile; unavailable ones are never offered.
  const dflt = await coord("MCP-TOOLS");
  check(
    "F3 by default every ready server is offered, unavailable ones are not",
    /fake-ci/.test(dflt) && /fake-tracker/.test(dflt) && /fake-xcode/.test(dflt) && !/fake-off/.test(dflt) && !/fake-oauth/.test(dflt),
    dflt,
  );
  const okDefault = await coord('MCP-CALL fake-ci launch_status {"id":"L0"}');
  check("F3 by default a call goes through", /launch L0: PASSED/.test(okDefault), okDefault);
  const writeDefault = await coord('MCP-CALL fake-tracker ChangeIssueStatus {"key":"K-0","status":"Closed"}');
  check(
    "F7 an enabled server allows every tool without a write setting",
    /ChangeIssueStatus ok/.test(writeDefault) &&
      serverLog().some((entry) => entry.tool === "ChangeIssueStatus" && entry.args?.key === "K-0"),
    writeDefault,
  );
  check(
    "F22 the coordinator prompt carries the MCP note, not tool schemas",
    /projects_mcp_tools/.test(kit.lastCall("coordinator", "#1").system) && !/launch_status/.test(kit.lastCall("coordinator", "#1").system),
  );

  // Profiles: the classic inbox's MCP picker was retired on 2026-11-04 (docs/classic-retirement.md); it saved exactly this change.
  const off = {
    all: [],
    coordinator: ["fake-xcode"],
    worker: ["fake-ci", "fake-tracker"],
    scout: ["fake-ci", "fake-tracker", "fake-xcode"],
    reviewer: [],
  };
  await kit.updateSettings(id, { mcp: { off } });
  await kit.eventually(async () => (await rpc({ action: "settings-snapshot", id })).values.mcp !== null, "mcp settings not saved", 100);
  const saved = (await rpc({ action: "settings-snapshot", id })).values.mcp;
  check(
    "F21 saved profiles persist exactly",
    JSON.stringify(saved) ===
      JSON.stringify({
        off: {
          all: [],
          coordinator: ["fake-xcode"],
          worker: ["fake-ci", "fake-tracker"],
          scout: ["fake-ci", "fake-tracker", "fake-xcode"],
          reviewer: [],
        },
      }),
    saved,
  );
  check(
    "F4 an MCP-only change needed no reopen (project still open and idle)",
    (await rpc({ action: "show", id })).chats.every((chat) => !chat.busy),
  );

  // Role scoping.
  const listed = await coord("MCP-TOOLS");
  check(
    "F2 the coordinator sees exactly its servers",
    /fake-ci/.test(listed) && /fake-tracker/.test(listed) && !/fake-xcode/.test(listed),
    listed,
  );
  check(
    "F14 no secret in listings or any prompt so far",
    !listed.includes(SECRET) &&
      !result.calls.some((c) => c.system.includes(SECRET) || c.user.includes(SECRET) || c.results.some((r) => r.includes(SECRET))),
  );
  const tools = await coord("MCP-TOOLS fake-tracker");
  const toolInfo = JSON.parse(tools);
  check(
    "F8 tool listings carry no obsolete write classification",
    toolInfo.tools.every((item) => item.write === undefined),
    toolInfo.tools.map((item) => [item.name, item.write]),
  );
  const schema = JSON.parse(await coord("MCP-TOOLS fake-tracker launch_status"));
  check(
    "F22 the listing omits input schemas; one tool carries its schema on demand",
    toolInfo.tools.every((item) => item.inputSchema === undefined) && schema.tool.inputSchema?.type === "object",
    schema,
  );
  const scripted = async (tool, server = "fake-ci") =>
    JSON.parse((await coord(`MCP-CODE ${server} ${tool}`)).split("\n").find((line) => line.startsWith("{")) ?? "null");
  const structured = await scripted("launches"),
    failed = await scripted("launch_failed"),
    shown = await coord("MCP-CALL fake-ci launches");
  check(
    "N12 a script gets structuredContent as an object, the model sees its JSON instead of (no output)",
    structured?.type === "object" &&
      structured.value.structuredContent?.launches?.[0]?.id === "L9" &&
      /"L9"/.test(shown) &&
      !/no output/.test(shown),
    { structured, shown },
  );
  check(
    "N12 a server error resolves with isError and its structuredContent",
    failed?.value?.isError === true && failed.value.structuredContent?.code === "E1" && /launch broke/.test(failed.value.text),
    { failed },
  );
  const ok = await coord('MCP-CALL fake-ci launch_status {"id":"L1"}');
  check("coordinator reads through fake-ci", /launch L1: PASSED/.test(ok), ok);
  const deniedX = await coord("MCP-CALL fake-xcode whoami");
  check(
    "F2 the coordinator cannot call a worker-only server",
    /not enabled for your role/i.test(deniedX) && !serverLog().some((entry) => entry.tag === "xcode" && entry.event === "call"),
    deniedX,
  );
  const whoami = await worker("MCP-CALL fake-xcode whoami");
  const cwd = /cwd=(\S+)/.exec(whoami)?.[1] ?? "";
  check(
    "F10 a worker call runs the server in the worker worktree",
    cwd.includes("/worktrees/") && cwd.startsWith(root) && cwd !== kit.workspace,
    { whoami },
  );
  const workerCache = /cache=(\S+)/.exec(whoami)?.[1] ?? "";
  const coordinatorCache = /cache=(\S+)/.exec(await coord("MCP-CALL fake-ci whoami"))?.[1] ?? "";
  check(
    "C4 each workspace's server gets its own cache folder in ${PI_WORKSPACE_CACHE}",
    /\/workspace-cache\/[0-9a-f-]{36}\/DerivedData$/.test(workerCache) &&
      /\/workspace-cache\/[0-9a-f-]{36}\/DerivedData$/.test(coordinatorCache) &&
      workerCache !== coordinatorCache,
    { workerCache, coordinatorCache },
  );
  const workerList = await worker("MCP-TOOLS");
  check("F2 the worker lists only its own server", /fake-xcode/.test(workerList) && !/fake-ci/.test(workerList), workerList);
  check(
    "F2 the worker cannot call the coordinator server",
    /not enabled for your role/i.test(await worker('MCP-CALL fake-ci launch_status {"id":"L2"}')),
  );
  check(
    "F2 a scout has no servers",
    /no MCP servers/i.test(await scout("MCP-TOOLS")) && /not enabled for your role/i.test(await scout("MCP-CALL fake-xcode whoami")),
  );

  // Enabled means full access, as in Pi; legacy writes settings are irrelevant.
  const before = serverLog().length;
  const writes = [
    await coord('MCP-CALL fake-tracker ChangeIssueStatus {"key":"K-1","status":"Closed"}'),
    await coord('MCP-CALL fake-tracker start_launch {"id":"L3"}'),
    await coord("MCP-CALL fake-tracker purge"),
    await coord('MCP-CALL fake-ci ChangeIssueStatus {"key":"K-1","status":"Closed"}'),
  ];
  check(
    "F7/F9 mutating tools pass on every enabled server without a write grant",
    writes.every((text) => / ok/.test(text)) &&
      serverLog()
        .slice(before)
        .filter((entry) => entry.event === "call")
        .map((entry) => entry.tool)
        .join(",") === "ChangeIssueStatus,start_launch,purge,ChangeIssueStatus",
    writes,
  );
  check(
    "F7 reads pass: unannotated get_settings and readOnlyHint list_hints",
    /get_settings ok/.test(await coord("MCP-CALL fake-tracker get_settings")) &&
      /list_hints ok/.test(await coord("MCP-CALL fake-tracker list_hints")),
  );
  // Resilience.
  const pidOf = (text) => /pid=(\d+)/.exec(text)?.[1];
  const pid1 = pidOf(await coord("MCP-CALL fake-ci whoami"));
  const slow = await coord('MCP-CALL fake-ci slow {"ms":8000}');
  check("F11 a slow call times out with a clear error", /timed out|timeout/i.test(slow), slow);
  const pid2 = pidOf(await coord("MCP-CALL fake-ci whoami"));
  check("F11 the next call after a timeout works on a fresh connection", pid1 && pid2 && pid1 !== pid2, { pid1, pid2 });
  const crashed = await coord("MCP-CALL fake-ci crash");
  const pid3 = pidOf(await coord("MCP-CALL fake-ci whoami"));
  check("F12 a crash is reported and the next call reconnects", /error|closed|exit|failed/i.test(crashed) && pid3 && pid3 !== pid2, {
    crashed,
    pid3,
  });
  await coord("MCP-CALL fake-ci big", "#big");
  const bigLength = kit.lastCall("coordinator", "#big").resultLengths.at(-1);
  check("F13 oversized output is capped near 64 KiB", bigLength > 40_000 && bigLength < 70_000, bigLength);
  check(
    "F1/F10 every server ran under the temp root",
    serverLog()
      .filter((entry) => entry.event === "start")
      .every((entry) => entry.cwd.startsWith(root)) && serverLog().some((entry) => entry.event === "start"),
  );
  check(
    "F19 no cold-start duplicates: one start per connection",
    new Set(
      serverLog()
        .filter((entry) => entry.event === "start")
        .map((entry) => entry.pid),
    ).size === serverLog().filter((entry) => entry.event === "start").length,
  );

  // Live settings change, unavailable servers, invalid settings.
  await kit.updateSettings(id, {
    mcp: {
      off: {
        coordinator: ["fake-ci", "fake-xcode"],
        worker: ["fake-ci", "fake-tracker"],
        scout: ["fake-ci", "fake-tracker", "fake-xcode"],
      },
    },
  });
  check(
    "F4 removing a server applies to the very next call",
    /not enabled for your role/i.test(await coord('MCP-CALL fake-ci launch_status {"id":"L4"}')),
  );
  await kit.updateSettings(id, { mcp: { off: { all: ["ghost"] } } });
  const unavailable = await coord("MCP-TOOLS");
  check(
    "F5/F6 unavailable servers and stale opt-out names are never offered",
    !/fake-off/.test(unavailable) && !/fake-oauth/.test(unavailable) && !/ghost/.test(unavailable) && /fake-ci/.test(unavailable),
    unavailable,
  );
  check("F5 a call to a disabled server is refused", /not enabled|disabled/i.test(await coord("MCP-CALL fake-off whoami")));
  check("F5 a call to a sign-in server is refused", /not enabled|sign-in/i.test(await coord("MCP-CALL fake-oauth whoami")));
  check("F6 a call to a removed server says so", /not enabled|unknown|unavailable/i.test(await coord("MCP-CALL ghost whoami")));
  const settings = await rpc({ action: "settings-snapshot", id });
  check(
    "F17 unknown role rejected",
    (await kit.rejects({
      action: "settings-update",
      id,
      confirm: id,
      expectedRevision: settings.revision,
      changes: { mcp: { off: { admin: [] } } },
    })) !== null,
  );
  check(
    "F17 non-string names rejected",
    (await kit.rejects({
      action: "settings-update",
      id,
      confirm: id,
      expectedRevision: settings.revision,
      changes: { mcp: { off: { all: [42] } } },
    })) !== null,
  );
  await kit.updateSettings(id, {
    mcp: {
      off: {
        coordinator: ["fake-tracker", "fake-xcode"],
        worker: ["fake-ci", "fake-tracker"],
        scout: ["fake-ci", "fake-tracker", "fake-xcode"],
      },
    },
  });

  // Probe action.
  const probe = await rpc({ action: "mcp-probe", id, server: "fake-ci" });
  check("probe reports the tool count", probe.ok === true && probe.tools === 12, probe);
  check("probe refuses unavailable servers", (await rpc({ action: "mcp-probe", id, server: "fake-oauth" })).ok === false);

  // Saved OAuth is shared with Pi, refreshed once, and never used for another named server.
  const authPath = join(kit.agentDir, "mcp-auth.json");
  const state = {
    serverUrl: oauthUrl,
    clientInformation: { client_id: "fake-client", redirect_uris: ["http://127.0.0.1/callback"] },
    tokens: { access_token: "old-secret", refresh_token: "refresh-secret", token_type: "Bearer", expires_in: 1 },
    tokensExpireAt: 0,
    discovery: {
      authorizationServerUrl: new URL(oauthUrl).origin,
      authorizationServerMetadata: {
        issuer: new URL(oauthUrl).origin,
        authorization_endpoint: new URL("/authorize", oauthUrl).href,
        token_endpoint: new URL("/token", oauthUrl).href,
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
      },
    },
  };
  writeFileSync(authPath, JSON.stringify({ [`mcp__another|${oauthUrl}`]: state }), { mode: 0o600 });
  const wrongIdentity = await rpc({ action: "mcp-probe", id, server: "fake-oauth" });
  check("OAuth never borrows a different server's credentials", !wrongIdentity.ok && refreshes === 0, wrongIdentity);
  writeFileSync(authPath, JSON.stringify({ [`mcp__fake_oauth|${oauthUrl}`]: state }), { mode: 0o600 });
  const authProbe = await rpc({ action: "mcp-probe", id, server: "fake-oauth" });
  check(
    "saved Pi OAuth refreshes and lists tools without browser login",
    authProbe.ok && authProbe.tools === 1 && refreshes === 1,
    authProbe,
  );
  const stored = JSON.parse(readFileSync(authPath, "utf8"));
  check("SDK persists rotated credentials", stored[`mcp__fake_oauth|${oauthUrl}`].tokens.refresh_token === "rotated-secret");
  check(
    "authenticated server is available in the catalog",
    (await rpc({ action: "mcp-catalog", id })).servers.find((s) => s.name === "fake-oauth").status === "ready",
  );
  delete config.mcpServers["fake-oauth"].oauth;
  config.mcpServers["fake-oauth"].headers = { aUtHoRiZaTiOn: "Bearer static-secret" };
  writeFileSync(configPath, JSON.stringify(config));
  await kit.restartHost();
  check(
    "explicit Authorization retains priority over stored OAuth",
    (await rpc({ action: "mcp-probe", id, server: "fake-oauth" })).ok && oauthHeaders.at(-1) === "Bearer static-secret",
  );
  delete config.mcpServers["fake-oauth"].headers;
  writeFileSync(configPath, JSON.stringify(config));
  await kit.restartHost();
  check("implicit OAuth works without an oauth config block", (await rpc({ action: "mcp-probe", id, server: "fake-oauth" })).ok);
  const revoked = structuredClone(state);
  revoked.tokens.refresh_token = "revoked-secret";
  writeFileSync(authPath, JSON.stringify({ [`mcp__fake_oauth|${oauthUrl}`]: revoked }), { mode: 0o600 });
  await kit.restartHost();
  const rejectedAuth = await rpc({ action: "mcp-probe", id, server: "fake-oauth" });
  check(
    "revoked auth reports login instructions without tokens or remote payload",
    !rejectedAuth.ok && /pi mcp login fake-oauth/.test(rejectedAuth.error) && !/secret/.test(JSON.stringify(rejectedAuth)),
    rejectedAuth,
  );

  // Chats and recovery.
  const chat = await rpc({ action: "chat-create", id, title: "Second" });
  const chatId = chat.id ?? chat.chat?.id ?? chat.chatId;
  const job = await rpc({ action: "message", id, chatId, text: `MCP-CALL fake-ci launch_status {"id":"L5"} #chat` });
  await kit.eventually(
    async () => (await rpc({ action: "show", id, chatId })).jobs.find((j) => j.id === job.id)?.state === "done",
    "chat job did not finish",
    600,
  );
  check(
    "a second chat has the gateway too",
    /launch L5: PASSED/.test(kit.toolResult("coordinator", "#chat")),
    kit.toolResult("coordinator", "#chat"),
  );
  await kit.restartHost();
  const afterRestart = await coord('MCP-CALL fake-ci launch_status {"id":"L6"}');
  check("F15 after a host restart the coordinator still has the gateway", /launch L6: PASSED/.test(afterRestart), afterRestart);
  check("F15 and a worker too", /cwd=/.test(await worker("MCP-CALL fake-xcode whoami")));

  result.serverStarts = serverLog().filter((entry) => entry.event === "start").length;
  result.pids = [...new Set(serverLog().map((entry) => entry.pid))];
  kit.pids = result.pids;
});
await new Promise((resolve) => oauth.close(resolve));
if (kit.pids) {
  await delay(1500);
  const alive = kit.pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  result.orphans = alive;
  if (alive.length) {
    console.error("F20 orphan MCP servers after host stop", alive);
    process.exitCode = 1;
  } else console.log("F20 ok: no orphan MCP servers after host stop");
  kit.save();
}
