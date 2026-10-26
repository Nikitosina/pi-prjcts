/**
 * Machine-wide resources other workers may be using. The verifier's shell is the worker's shell, so nothing here confines it; this is the lease
 * rule workers already follow (projects_lease_acquire on the host's lease table), applied to the commands a verifier runs.
 */
const SHARED: readonly { name: string; uses: RegExp; lease: RegExp; hint: string }[] = [
  { name: "simulator", uses: /\b(simctl|xcodebuild)\b/, lease: /simulator|device|ios|xcode/i, hint: "a lease named for the simulator or device, e.g. ios-simulator" },
  { name: "container runtime", uses: /\b(docker|docker-compose|podman)\b/, lease: /docker|container|podman/i, hint: "a lease named for the container runtime, e.g. docker" },
  { name: "fixed browser debugging port", uses: /--remote-debugging-port=(?!0\b)\d+/, lease: /browser|chrome|port/i, hint: "a lease named for the browser or port, e.g. chrome-9222" },
  { name: "desktop session", uses: /\b(osascript|screencapture)\b|\bopen\s+-[a-zA-Z]*a\b/, lease: /screen|display|desktop|gui/i, hint: "a lease named for the desktop session, e.g. desktop" },
];

/**
 * The shared resource a command names that the holder has no lease for, or null. It reads the command text: it keeps workers that follow the
 * lease rule from colliding and is not an access control (a shell can name a resource in ways it does not match).
 */
export function missingLease(command: string, held: readonly string[]): { resource: string; hint: string } | null {
  for (const item of SHARED) if (item.uses.test(command) && !held.some(name => item.lease.test(name))) return { resource: item.name, hint: item.hint };
  return null;
}
