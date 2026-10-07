import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join } from "node:path";

export async function protectedSkillBackingFiles(): Promise<Array<{ path: string; dev: string; ino: string }>> {
  if (process.env.NODE_OPTIONS || process.env.PI_PACKAGE_DIR) throw new Error("Skill catalog is unavailable with NODE_OPTIONS or PI_PACKAGE_DIR configured");
  const root = getAgentDir();
  const paths = ["auth.json", "models.json", "models-store.json", "settings.json"].map(name => join(root, name));
  const files: Array<{ path: string; dev: string; ino: string }> = [];
  for (const path of paths) {
    try {
      const value = statSync(path, { bigint: true });
      if (!value.isFile()) throw new Error("SDK backing path is not a regular file");
      files.push({ path, dev: value.dev.toString(), ino: value.ino.toString() });
    } catch (error) {
      if (path.endsWith("models.json") && error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return files;
}
