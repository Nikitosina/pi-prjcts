import { hostCheckout as root, readHostGit } from "./host-checkout.ts";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("host.ts", import.meta.url));
const git = (...args: string[]) =>
  readHostGit(...args)
    .toString()
    .trimEnd();
function cleanRevision(): string | null {
  try {
    if (git("status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none")) return null;
    const head = git("rev-parse", "HEAD");
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

export const hostBoot = {
  instance: randomUUID(),
  sha: cleanRevision(),
  previous: process.argv[2] === "--resume-instance" ? process.argv[3] : null,
};

export function assertRestartable() {
  if (
    !process.execve ||
    process.execArgv.length ||
    process.env.NODE_OPTIONS?.trim() ||
    realpathSync(process.argv[1]!) !== realpathSync(entry)
  )
    throw new Error("This host launch cannot be restarted in place.");
  if (!hostBoot.sha || cleanRevision() !== hostBoot.sha)
    throw new Error("Cannot verify the running version: the host checkout changed, is dirty or was not clean at startup.");
}

// An exec of host.ts by path alone could run changed code after the last checkout check. Pin the bytes Node actually compiles, including its entry.
function pinnedLoader(sha: string): string {
  const files = git("ls-tree", "-rz", sha, "--", "src", "plugins")
    .split("\0")
    .flatMap((line) => {
      const match = /^100(?:644|755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
      return match ? [[match[2], match[1]]] : [];
    });
  const script = `import {registerHooks} from 'node:module'; import {createHash} from 'node:crypto'; import {fileURLToPath} from 'node:url';
const root=${JSON.stringify(root)}, blobs=new Map(${JSON.stringify(files)});
function refuse(){process.stderr.write('Host restart refused: host source no longer matches the running revision.\\n');process.exit(0)}
let first=true;
registerHooks({load(url,context,next){
  const path=url.startsWith('file:') ? fileURLToPath(url) : '';
  if(first){first=false;if(path!==root+'src/host.ts')refuse()}
  const loaded=next(url,context);
  if(path.startsWith(root+'src/') || path.startsWith(root+'plugins/')){
    if(loaded.source==null)refuse();
    const bytes=Buffer.from(loaded.source);
    if(createHash('sha1').update('blob '+bytes.length+'\\0').update(bytes).digest('hex')!==blobs.get(path.slice(root.length)))refuse();
  }
  return loaded;
}});
process.execArgv.splice(0,2);`;
  return `data:text/javascript;base64,${Buffer.from(script).toString("base64")}`;
}

export function prepareReplacement() {
  assertRestartable();
  const sha = hostBoot.sha!;
  const preload = pinnedLoader(sha);
  return (home: string): never => {
    assertRestartable();
    return process.execve!(process.execPath, [process.execPath, "--import", preload, entry, "--resume-instance", hostBoot.instance, sha], {
      ...process.env,
      PI_PROJECTS_HOME: home,
    });
  };
}
