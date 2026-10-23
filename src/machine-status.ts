// Host-side machine readout for the bottom bar: RAM, CPU, SSD and battery. Parsers are pure so tests run on fixture text.
// A value that cannot be read is null (the browser shows —); a value that does not exist on this platform is left out (the browser hides it).
import { execFile } from "node:child_process";
import { cpus, platform, totalmem } from "node:os";
import { readFile, statfs } from "node:fs/promises";

export type MachineStatus = { ram?: { usedGb: number; totalGb: number } | null; cpu?: number | null; ssd?: number | null; battery?: number | null };
export type CpuTimes = { idle: number; total: number };

const GB = 1024 ** 3;
export const roundGb = (bytes: number): number => Math.round(bytes / GB * 10) / 10;

// Activity Monitor "Memory Used" = App Memory (anonymous - purgeable) + Wired + Compressed, in pages × page size.
export function parseVmStat(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (label: string): number | null => {
    const raw = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(text)?.[1];
    return raw === undefined ? null : Number(raw);
  };
  const anonymous = pages("Anonymous pages"), purgeable = pages("Pages purgeable"), wired = pages("Pages wired down"), compressed = pages("Pages occupied by compressor");
  if (!(pageSize > 0) || anonymous === null || purgeable === null || wired === null || compressed === null) return null;
  return (Math.max(0, anonymous - purgeable) + wired + compressed) * pageSize;
}

// Returns the charge percent, or undefined when the machine has no battery.
export function parsePmsetBattery(text: string): number | null | undefined {
  const line = text.split("\n").find(item => /InternalBattery/.test(item));
  if (!line) return undefined;
  const percent = /(\d+)%/.exec(line)?.[1];
  return percent === undefined ? null : Math.min(100, Number(percent));
}

export const sumCpuTimes = (list: { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]): CpuTimes =>
  list.reduce((sum, { times }) => ({ idle: sum.idle + times.idle, total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq }), { idle: 0, total: 0 });

export function cpuPercent(before: CpuTimes, after: CpuTimes): number | null {
  const total = after.total - before.total, idle = after.idle - before.idle;
  return total > 0 && idle >= 0 && idle <= total ? Math.round((1 - idle / total) * 100) : null;
}

export function statfsPercent(stats: { blocks: number; bfree: number; bavail: number }): number | null {
  const used = stats.blocks - stats.bfree, denominator = used + stats.bavail;
  return stats.blocks > 0 && denominator > 0 && used >= 0 ? Math.round(used / denominator * 100) : null;
}

export function parseMeminfoUsedBytes(text: string): number | null {
  const kb = (label: string) => { const raw = new RegExp(`^${label}:\\s+(\\d+) kB`, "m").exec(text)?.[1]; return raw === undefined ? null : Number(raw) * 1024; };
  const total = kb("MemTotal"), available = kb("MemAvailable");
  return total === null || available === null ? null : total - available;
}

const run = (file: string, args: string[]): Promise<string | null> =>
  new Promise(done => execFile(file, args, { timeout: 3000, maxBuffer: 1 << 20 }, (error, stdout) => done(error ? null : String(stdout))));
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

async function sampleCpu(): Promise<number | null> {
  const before = sumCpuTimes(cpus());
  await sleep(250);
  return cpuPercent(before, sumCpuTimes(cpus()));
}

async function sampleRam(os: string): Promise<MachineStatus["ram"]> {
  const totalGb = roundGb(totalmem());
  if (os === "darwin") {
    const used = parseVmStat(await run("vm_stat", []) ?? "");
    return used === null ? null : { usedGb: roundGb(used), totalGb };
  }
  if (os === "linux") {
    const used = parseMeminfoUsedBytes(await readFile("/proc/meminfo", "utf8").catch(() => ""));
    return used === null ? null : { usedGb: roundGb(used), totalGb };
  }
  return undefined;
}

async function sampleBattery(os: string): Promise<MachineStatus["battery"]> {
  if (os !== "darwin") return undefined;
  const text = await run("pmset", ["-g", "batt"]);
  return text === null ? null : parsePmsetBattery(text);
}

async function sampleDisk(os: string): Promise<number | null> {
  return statfsPercent(await statfs(os === "darwin" ? "/System/Volumes/Data" : "/").catch(() => ({ blocks: 0, bfree: 0, bavail: 0 })));
}

const CACHE_MS = 5000;
let cached: { at: number; value: Promise<MachineStatus> } | null = null;

export function machineStatus(now = Date.now()): Promise<MachineStatus> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const os = platform();
  const value = Promise.all([sampleRam(os), sampleCpu(), sampleDisk(os), sampleBattery(os)]).then(([ram, cpu, ssd, battery]) => {
    const status: MachineStatus = { cpu, ssd };
    if (ram !== undefined) status.ram = ram;
    if (battery !== undefined) status.battery = battery;
    return status;
  });
  cached = { at: now, value };
  return value;
}
