export type CalendarRule = { timezone: string; time: string } & ({ kind: "daily" } | { kind: "weekly"; days: number[] });
type Civil = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const dayMs = 86400000;

function formatter(rule: CalendarRule) {
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(rule.time)) throw new Error("Calendar time must be HH:mm");
  if (rule.kind === "weekly" && (!rule.days.length || rule.days.length > 7 || new Set(rule.days).size !== rule.days.length || rule.days.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error("Calendar weekdays must be unique integers from Sunday 0 to Saturday 6");
  return new Intl.DateTimeFormat("en-US", { timeZone: rule.timezone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function civil(format: Intl.DateTimeFormat, atMs: number): Civil {
  const parts = format.formatToParts(new Date(atMs));
  const value = (name: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find(item => item.type === name);
    if (!part) throw new Error("Calendar formatter omitted a date component");
    return Number(part.value);
  };
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), second: value("second") };
}
function civilMs(date: Civil): number {
  const value = new Date(0);
  value.setUTCFullYear(date.year, date.month - 1, date.day);
  value.setUTCHours(date.hour, date.minute, date.second, 0);
  return value.getTime();
}
function same(left: Civil, right: Civil) {
  return left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}
function instants(format: Intl.DateTimeFormat, target: Civil): number[] {
  const nominal = civilMs(target), offsets = new Set<number>();
  for (let hour = -48; hour <= 48; hour += 3) {
    const sample = nominal + hour * 3600000;
    offsets.add(civilMs(civil(format, sample)) - sample);
  }
  return [...offsets].map(offset => nominal - offset).filter(atMs => same(civil(format, atMs), target)).sort((a, b) => a - b);
}
function occurrence(rule: CalendarRule, boundary: number, direction: 1 | -1): number {
  if (!Number.isSafeInteger(boundary) || Math.abs(boundary) > 8640000000000000) throw new Error("Calendar boundary is outside the supported date range");
  const format = formatter(rule), local = civil(format, boundary);
  const midnight = civilMs({ ...local, hour: 0, minute: 0, second: 0 });
  const [hour, minute] = rule.time.split(":").map(Number);
  for (let offset = 0; offset <= 15; offset++) {
    const date = new Date(midnight + direction * offset * dayMs);
    if (rule.kind === "weekly" && !rule.days.includes(date.getUTCDay())) continue;
    const target = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute, second: 0 };
    const earlier = instants(format, target)[0];
    if (earlier !== undefined && (direction === 1 ? earlier > boundary : earlier <= boundary)) return earlier;
  }
  throw new Error("Calendar has no occurrence within the bounded search window");
}
export function nextCalendarOccurrence(rule: CalendarRule, afterMs: number): number { return occurrence(rule, afterMs, 1); }
export function latestCalendarOccurrence(rule: CalendarRule, atMs: number): number { return occurrence(rule, atMs, -1); }
export function copyCalendarRule(rule: CalendarRule): CalendarRule {
  return rule.kind === "daily" ? { kind: "daily", timezone: rule.timezone, time: rule.time } : { kind: "weekly", timezone: rule.timezone, time: rule.time, days: [...rule.days] };
}
