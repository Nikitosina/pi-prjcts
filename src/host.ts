import { importHostShellEnvironment } from "./host-environment.ts";

process.umask(0o077);
// Load the shell before importing SDKs or modules that read environment variables at import time.
if (process.platform === "darwin") {
  const counts = await importHostShellEnvironment();
  process.stderr.write(JSON.stringify({ event: "host-shell-environment", ...counts }) + "\n");
}
await import("./host-server.ts");
