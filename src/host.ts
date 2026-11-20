import { hostBoot } from "./host-restart.ts";
import { importHostShellEnvironment } from "./host-environment.ts";

process.umask(0o077);
// Load the shell before importing SDKs or modules that read environment variables at import time.
if (hostBoot.previous && (!hostBoot.sha || hostBoot.sha !== process.argv[4])) {
  process.stderr.write("Host restart refused: checkout no longer matches the running version.\n");
  process.exit(0);
}
if (!hostBoot.previous && process.platform === "darwin") {
  const counts = await importHostShellEnvironment();
  process.stderr.write(JSON.stringify({ event: "host-shell-environment", ...counts }) + "\n");
}
await import("./host-server.ts");
