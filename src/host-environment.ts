import { spawn } from "node:child_process";

const timeoutMs = 10_000, maxBytes = 2 * 1024 * 1024;
const exportHeader = "pi-projects-env-v1\0";

/** Execute normal zsh startup; only the dedicated export pipe enters memory. Never include shell output in errors. */
export async function readShellEnvironment({ env, shell = "/bin/zsh", timeout = timeoutMs }: { env: NodeJS.ProcessEnv; shell?: string; timeout?: number }): Promise<NodeJS.ProcessEnv> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(shell, ["-ilc", "builtin printf 'pi-projects-env-v1\\0' >&3; exec /usr/bin/env -0 >&3"], { env, detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] }); }
    catch { reject(new Error("Shell environment import failed: could not start zsh")); return; }
    const pipe = child.stdio[3];
    let settled = false, closed = false, size = 0;
    const chunks: Buffer[] = [];
    const fail = (reason: string) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // Startup hooks may leave children holding the export pipe. Kill our whole group, not just zsh.
      if (!closed && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      pipe?.destroy(); child.unref(); chunks.length = 0;
      reject(new Error(`Shell environment import failed: ${reason}`));
    };
    const timer = setTimeout(() => fail("timeout"), timeout);
    child.on("error", () => fail("could not start zsh"));
    if (!pipe) { fail("export pipe unavailable"); return; }
    pipe.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) { fail("export size limit"); return; }
      chunks.push(chunk);
    });
    pipe.on("error", () => fail("export pipe error"));
    child.on("close", code => {
      closed = true;
      if (settled) return;
      if (code !== 0) { fail("zsh exited unsuccessfully"); return; }
      try {
        const result = parseExports(Buffer.concat(chunks));
        settled = true; clearTimeout(timer); chunks.length = 0;
        resolve(result);
      } catch { fail("invalid export data"); }
    });
  });
}

export function mergeHostEnvironment({ inherited, shell }: { inherited: NodeJS.ProcessEnv; shell: NodeJS.ProcessEnv }): NodeJS.ProcessEnv {
  const result = { ...shell };
  for (const name of new Set([...Object.keys(inherited), ...Object.keys(shell)])) {
    if (name.startsWith("PI_SUBAGENT") || name === "PI_SESSION_FILE") { delete result[name]; continue; }
    if (hostOwned(name)) {
      if (inherited[name] === undefined) delete result[name];
      else result[name] = inherited[name];
    }
  }
  return result;
}

export async function importHostShellEnvironment(): Promise<{ exportedCount: number; importedCount: number }> {
  const inherited = { ...process.env };
  const shell = await readShellEnvironment({ env: inherited });
  const merged = mergeHostEnvironment({ inherited, shell });
  // Apply only a complete successful capture. Shell unsets count too; host identity never comes from zsh.
  for (const name of Object.keys(process.env)) if (!Object.hasOwn(merged, name)) delete process.env[name];
  Object.assign(process.env, merged);
  return { exportedCount: Object.keys(shell).length, importedCount: Object.keys(merged).filter(name => merged[name] !== inherited[name]).length };
}

function hostOwned(name: string): boolean {
  return name.startsWith("PI_PROJECTS_") || [
    "HOME", "USER", "LOGNAME", "PWD", "OLDPWD", "SHLVL", "_", "TMPDIR", "TMP", "TEMP",
    "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_PACKAGE_DIR", "PI_ARTIFACTS_DIR",
    "NODE_OPTIONS", "NODE_PATH", "NODE_CHANNEL_FD", "NODE_UNIQUE_ID", "NODE_DEBUG", "NODE_DEBUG_NATIVE",
  ].includes(name);
}

function parseExports(bytes: Buffer): NodeJS.ProcessEnv {
  const header = Buffer.from(exportHeader);
  if (!bytes.subarray(0, header.length).equals(header) || bytes.at(-1) !== 0) throw new Error("Incomplete exports");
  const entries = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(header.length)).slice(0, -1).split("\0");
  const result = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) throw new Error("Invalid export");
    const name = entry.slice(0, separator);
    if (result.has(name)) throw new Error("Duplicate export");
    result.set(name, entry.slice(separator + 1));
  }
  return Object.fromEntries(result);
}
