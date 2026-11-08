// Working hours and the time that counts in them. A queue's SLA clock runs only in its working hours, in its time zone,
// and not on its holidays. Hours are written as `always`, `weekdays 09:00-18:00`, or day ranges with their times, such
// as `mon-fri 09:00-18:00, sat 10:00-14:00`. Times are wall-clock times in the zone, so a clock change moves them with
// the zone (the working day stays 09:00 to 18:00).

export interface Hours {
  /** Round the clock, every day: working time is just elapsed time. */
  always: boolean;
  /** Working intervals for Monday (0) to Sunday (6), in minutes after midnight, [start, end). */
  days: Array<Array<[number, number]>>;
  /** IANA time zone, such as Europe/Istanbul. */
  timeZone: string;
  /** Days off, YYYY-MM-DD in the zone. */
  holidays: string[];
}

const MINUTE = 60_000;
const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
/** At most this many days are walked through, about ten years: enough for any SLA, and a stop for a bad input. */
const MAX_DAYS = 3660;

/** True when the zone is one Intl knows. */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function clock(v: string, at: string): number {
  const m = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(v);
  const minutes = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  if (!m || minutes > 1440) throw new Error(`${at}: ${v} is not a time such as 09:00.`);
  return minutes;
}

/** Reads `always`, `weekdays 09:00-18:00` or `mon-fri 09:00-18:00, sat 10:00-14:00`. Throws with what to fix. */
export function parseHours(text: string, at: string): Hours["days"] | null {
  const s = text.trim().toLowerCase();
  if (s === "always" || s === "24/7") return null;
  const days: Hours["days"] = DAY_NAMES.map(() => []);
  const rule = `${at} is always, or days and times such as "weekdays 09:00-18:00" or "mon-fri 09:00-18:00, sat 10:00-14:00".`;
  for (const part of s.split(/\s*[,;]\s*/).filter(Boolean)) {
    const m = /^([a-z-]+(?:\s*\+\s*[a-z-]+)*)\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(part);
    if (!m) throw new Error(rule);
    const start = clock(m[2]!, at);
    const end = clock(m[3]!, at);
    if (end <= start) throw new Error(`${at}: ${m[2]}-${m[3]} ends before it starts; hours past midnight are two parts.`);
    const which = new Set<number>();
    for (const word of m[1]!.split(/\s*\+\s*/)) {
      if (word === "weekdays") [0, 1, 2, 3, 4].forEach((d) => which.add(d));
      else if (word === "weekend") [5, 6].forEach((d) => which.add(d));
      else if (word === "daily" || word === "everyday") [0, 1, 2, 3, 4, 5, 6].forEach((d) => which.add(d));
      else {
        const range = /^([a-z]{3})(?:-([a-z]{3}))?$/.exec(word);
        const a = range ? DAY_NAMES.indexOf(range[1]!) : -1;
        const b = range?.[2] ? DAY_NAMES.indexOf(range[2]) : a;
        if (a < 0 || b < 0) throw new Error(`${at}: ${word} is not a day; write mon to sun, weekdays, weekend or daily.`);
        for (let d = a; ; d = (d + 1) % 7) {
          which.add(d);
          if (d === b) break;
        }
      }
    }
    for (const d of which) days[d]!.push([start, end]);
  }
  for (const list of days) {
    list.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < list.length; i++) if (list[i]![0] < list[i - 1]![1]) throw new Error(`${at}: two parts of the same day overlap.`);
  }
  if (days.every((d) => d.length === 0)) throw new Error(rule);
  return days;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string) {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(tz, f);
  }
  return f;
}

/** The wall-clock date and time of an instant in a zone. */
export function wallClock(ms: number, tz: string) {
  const p: Record<string, number> = {};
  for (const part of format(tz).formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour! % 24, minute: p.minute!, second: p.second! };
}

/** How far the zone is ahead of UTC at an instant, in ms. */
function offset(ms: number, tz: string) {
  const w = wallClock(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall-clock time has in a zone; a time a clock change skips lands next to the change. */
export function fromWallClock(year: number, month: number, day: number, minutes: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, 0, minutes);
  const before = offset(guess, tz);
  const t = guess - before;
  const after = offset(t, tz);
  return after === before ? t : guess - after;
}

/** The date in the zone as YYYY-MM-DD, and Monday as 0. */
export function localDate(ms: number, tz: string) {
  const w = wallClock(ms, tz);
  return { year: w.year, month: w.month, day: w.day, weekday: (new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() + 6) % 7 };
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** The working intervals, as instants, of the days from the one `from` falls on, one day at a time. */
function* intervals(h: Hours, from: number): Generator<[number, number]> {
  const start = localDate(from, h.timeZone);
  const holidays = new Set(h.holidays);
  for (let i = 0; i < MAX_DAYS; i++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (holidays.has(iso(y, m, d))) continue;
    for (const [a, b] of h.days[(date.getUTCDay() + 6) % 7]!) yield [fromWallClock(y, m, d, a, h.timeZone), fromWallClock(y, m, d, b, h.timeZone)];
  }
}

/** Working time between two instants, in ms. */
export function workingBetween(h: Hours, from: number, to: number): number {
  if (to <= from) return 0;
  if (h.always) return to - from;
  let total = 0;
  for (const [a, b] of intervals(h, from)) {
    if (a >= to) break;
    if (b > from) total += Math.min(b, to) - Math.max(a, from);
  }
  return total;
}

/** The instant `ms` of working time after `from`. */
export function addWorking(h: Hours, from: number, ms: number): number {
  if (ms <= 0 || h.always) return from + Math.max(0, ms);
  let left = ms;
  for (const [a, b] of intervals(h, from)) {
    if (b <= from) continue;
    const start = Math.max(a, from);
    if (left <= b - start) return start + left;
    left -= b - start;
  }
  return from + MAX_DAYS * 86_400_000;
}

/** True when the instant is in working hours. */
export function isWorking(h: Hours, at: number): boolean {
  return h.always || workingBetween(h, at, at + MINUTE) > 0;
}

/** One working day, for durations written in days: the longest day's hours, or 24 hours round the clock. */
export function dayLength(h: Hours): number {
  if (h.always) return 86_400_000;
  return Math.max(...h.days.map((d) => d.reduce((s, [a, b]) => s + b - a, 0))) * MINUTE;
}

/** Hours as people read them: "Mon to Fri 09:00 to 18:00". Used in the settings page and the API. */
export function describeHours(h: Hours): string {
  if (h.always) return "always";
  const label = (list: Array<[number, number]>) => list.map(([a, b]) => `${hm(a)}-${hm(b)}`).join(", ");
  const groups: Array<{ from: number; to: number; text: string }> = [];
  h.days.forEach((list, d) => {
    if (!list.length) return;
    const text = label(list);
    const last = groups.at(-1);
    if (last && last.to === d - 1 && last.text === text) last.to = d;
    else groups.push({ from: d, to: d, text });
  });
  return groups.map((g) => `${DAY_NAMES[g.from]}${g.to > g.from ? `-${DAY_NAMES[g.to]}` : ""} ${g.text}`).join(", ");
}

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
