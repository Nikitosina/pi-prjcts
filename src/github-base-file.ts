import { createHash } from "node:crypto";
import { Type } from "typebox";
import { parse } from "./state.ts";
import { githubRead } from "./github-authorization.ts";

const Sha = Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" });
const Commit = Type.Object({ sha: Sha, tree: Type.Object({ sha: Sha }) });
const Entry = Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }), mode: Type.String({ maxLength: 16 }), type: Type.String({ maxLength: 16 }), sha: Sha });
const Tree = Type.Object({ sha: Sha, truncated: Type.Boolean(), tree: Type.Array(Entry, { maxItems: 10000 }) });
const Blob = Type.Object({ sha: Sha, size: Type.Integer({ minimum: 0, maximum: 65536 }), encoding: Type.Literal("base64"), content: Type.String({ maxLength: 100000 }) });
const Pr = Type.Object({ number: Type.Integer({ minimum: 1 }), head: Type.Object({ sha: Sha }), base: Type.Object({ sha: Sha, repo: Type.Object({ id: Type.Integer({ minimum: 1 }), full_name: Type.String() }) }) });

type BaseFile = { untrusted: true; path: string; base: string; size: number } & (
  { state: "absent"; blob: null; contentSha256: null } |
  { state: "present"; blob: string; contentSha256: string; mode: "100644" | "100755"; content: string }
);

export async function readGithubBaseFile(input: { repositoryId: string; numericId: number; pullRequest: number; expectedHead: string; expectedBase: string; path: string; allowedPaths?: readonly string[] }, signal: AbortSignal): Promise<BaseFile> {
  if (input.allowedPaths && !input.allowedPaths.includes(input.path)) throw new Error("Upstream file read is outside the assigned ownership paths");
  const parts = input.path.split("/");
  if (parts.length > 32 || input.path.includes("\\") || parts.some(part => !part || part === "." || part === ".." || part === ".git")) throw new Error("Invalid assigned upstream file path");
  const path = `repos/${input.repositoryId}`;
  async function currentPr() {
    const pr = parse(Pr, await githubRead(`${path}/pulls/${input.pullRequest}`, signal));
    if (pr.number !== input.pullRequest || pr.head.sha !== input.expectedHead || pr.base.sha !== input.expectedBase || pr.base.repo.id !== input.numericId || pr.base.repo.full_name !== input.repositoryId) throw new Error("PR head, base or repository changed during upstream file inspection");
  }
  await currentPr();
  const commit = parse(Commit, await githubRead(`${path}/git/commits/${input.expectedBase}`, signal));
  if (commit.sha !== input.expectedBase) throw new Error("Upstream commit identity changed");
  let treeSha = commit.tree.sha;
  for (let index = 0; index < parts.length; index++) {
    signal.throwIfAborted();
    const tree = parse(Tree, await githubRead(`${path}/git/trees/${treeSha}`, signal));
    if (tree.sha !== treeSha || tree.truncated) throw new Error("Upstream tree is incomplete or has a different identity");
    const entry = tree.tree.find(item => item.path === parts[index]);
    if (!entry) {
      await currentPr();
      return { state: "absent", untrusted: true, path: input.path, base: input.expectedBase, blob: null, contentSha256: null, size: 0 };
    }
    if (index < parts.length - 1) {
      if (entry.type !== "tree" || entry.mode !== "040000") throw new Error("Upstream path traverses a symlink, submodule or non-directory");
      treeSha = entry.sha;
      continue;
    }
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) throw new Error("Upstream file is a symlink, submodule or unsupported file mode");
    const blob = parse(Blob, await githubRead(`${path}/git/blobs/${entry.sha}`, signal));
    const encoded = blob.content.replace(/\r?\n/g, ""), bytes = Buffer.from(encoded, "base64");
    if (blob.sha !== entry.sha || bytes.length !== blob.size || bytes.toString("base64") !== encoded) throw new Error("Upstream blob encoding, size or identity changed");
    const objectHash = createHash(entry.sha.length === 40 ? "sha1" : "sha256").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (objectHash !== entry.sha) throw new Error("Upstream Git blob hash does not match its content");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    await currentPr();
    return { state: "present", untrusted: true, path: input.path, base: input.expectedBase, blob: entry.sha, contentSha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mode: entry.mode, content };
  }
  throw new Error("Upstream path has no file component");
}
