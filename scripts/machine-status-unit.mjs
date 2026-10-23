// Unit checks for src/machine-status.ts parsers using fixture text; no dependence on the real system.
import assert from 'node:assert/strict';
import { parseVmStat, parsePmsetBattery, cpuPercent, sumCpuTimes, statfsPercent, roundGb, parseMeminfoUsedBytes } from '../src/machine-status.ts';

const vmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            400000.
Pages inactive:                          390000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                        200000.
Pages purgeable:                          20000.
"Translation faults":                 123456789.
Pages occupied by compressor:            100000.
Anonymous pages:                         320000.
File-backed pages:                       450000.
`;
// (320000 - 20000) app + 200000 wired + 100000 compressed = 600000 pages × 16384
assert.equal(parseVmStat(vmStat), 600000 * 16384);
assert.equal(roundGb(parseVmStat(vmStat)), 9.2);
assert.equal(parseVmStat('garbage'), null);
assert.equal(parseVmStat(vmStat.replace('Pages wired down:                        200000.\n', '')), null);
assert.equal(roundGb(16 * 1024 ** 3), 16);
assert.equal(roundGb(8.04 * 1024 ** 3), 8);
assert.equal(roundGb(8.05 * 1024 ** 3 + 1e6), 8.1);

const withBattery = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=1234567)\t87%; discharging; 4:12 remaining present: true
`;
const charging = `Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n`;
const desktop = `Now drawing from 'AC Power'\n`;
assert.equal(parsePmsetBattery(withBattery), 87);
assert.equal(parsePmsetBattery(charging), 100);
assert.equal(parsePmsetBattery(desktop), undefined);
assert.equal(parsePmsetBattery(`Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t(no estimate) present: true\n`), null);

const cpu = (user, sys, idle) => ({ times: { user, nice: 0, sys, idle, irq: 0 } });
const before = sumCpuTimes([cpu(100, 50, 850), cpu(200, 100, 700)]);
const after = sumCpuTimes([cpu(150, 70, 880), cpu(260, 110, 730)]);
// total delta 200, idle delta 60 -> 70%
assert.equal(cpuPercent(before, after), 70);
assert.equal(cpuPercent(before, before), null);
assert.equal(cpuPercent(after, before), null);

assert.equal(statfsPercent({ blocks: 1000, bfree: 400, bavail: 400 }), 60);
assert.equal(statfsPercent({ blocks: 1000, bfree: 450, bavail: 400 }), 58);
assert.equal(statfsPercent({ blocks: 0, bfree: 0, bavail: 0 }), null);

assert.equal(parseMeminfoUsedBytes('MemTotal:       16000000 kB\nMemAvailable:    4000000 kB\n'), 12000000 * 1024);
assert.equal(parseMeminfoUsedBytes('MemTotal: 1 kB\n'), null);
console.log('machine-status unit: all checks passed');
