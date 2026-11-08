import { describe, expect, it } from "vitest";
import { addWorking, dayLength, describeHours, fromWallClock, isWorking, parseHours, workingBetween, type Hours } from "./hours.ts";

const H = 3_600_000;
const office = (tz = "Europe/Istanbul", holidays: string[] = []): Hours => ({
  always: false,
  days: parseHours("weekdays 09:00-18:00", "hours")!,
  timeZone: tz,
  holidays,
});
const at = (s: string) => Date.parse(s);

describe("working hours", () => {
  it("reads always, weekdays and day ranges", () => {
    expect(parseHours("always", "h")).toBeNull();
    const d = parseHours("mon-fri 09:00-12:00, mon-fri 13:00-18:00, sat 10:00-14:00", "h")!;
    expect(d[0]).toEqual([
      [540, 720],
      [780, 1080],
    ]);
    expect(d[5]).toEqual([[600, 840]]);
    expect(d[6]).toEqual([]);
    expect(parseHours("fri-mon 08:00-10:00", "h")!.map((x) => x.length)).toEqual([1, 0, 0, 0, 1, 1, 1]);
    expect(describeHours({ always: false, days: d, timeZone: "UTC", holidays: [] })).toBe("mon-fri 09:00-12:00, 13:00-18:00, sat 10:00-14:00");
  });

  it("says what is wrong with hours it cannot read", () => {
    expect(() => parseHours("weekdays 18:00-09:00", "queues.x.hours")).toThrow(/ends before it starts/);
    expect(() => parseHours("someday 09:00-10:00", "queues.x.hours")).toThrow(/not a day/);
    expect(() => parseHours("mon 09:00-12:00, mon 11:00-13:00", "queues.x.hours")).toThrow(/overlap/);
    expect(() => parseHours("9 to 5", "queues.x.hours")).toThrow(/always, or days and times/);
    expect(() => parseHours("mon 25:00-26:00", "q")).toThrow(/not a time/);
  });

  it("counts only the time inside the hours, in the queue's time zone", () => {
    const h = office();
    // Monday 15:00 to 21:00 in Istanbul (12:00 to 18:00 UTC): three working hours.
    expect(workingBetween(h, at("2026-11-02T12:00:00Z"), at("2026-11-02T18:00:00Z"))).toBe(3 * H);
    // Friday 17:00 to Monday 10:00: one hour on Friday and one on Monday.
    expect(workingBetween(h, at("2026-11-06T14:00:00Z"), at("2026-11-09T07:00:00Z"))).toBe(2 * H);
    expect(isWorking(h, at("2026-11-07T09:00:00Z"))).toBe(false);
    expect(isWorking(h, at("2026-11-06T09:00:00Z"))).toBe(true);
  });

  it("finds when an amount of working time ends", () => {
    const h = office();
    // Monday 15:00 plus 4 working hours: 3 on Monday, 1 on Tuesday, so Tuesday 10:00 (07:00 UTC).
    expect(new Date(addWorking(h, at("2026-11-02T12:00:00Z"), 4 * H)).toISOString()).toBe("2026-11-03T07:00:00.000Z");
    // Friday 17:30 plus 1 hour: Monday 09:30.
    expect(new Date(addWorking(h, at("2026-11-06T14:30:00Z"), H)).toISOString()).toBe("2026-11-09T06:30:00.000Z");
    // Started on a Saturday: the clock waits for Monday 09:00.
    expect(new Date(addWorking(h, at("2026-11-07T10:00:00Z"), 30 * 60_000)).toISOString()).toBe("2026-11-09T06:30:00.000Z");
    expect(addWorking(h, 1000, 0)).toBe(1000);
  });

  it("skips holidays", () => {
    const h = office("Europe/Istanbul", ["2026-11-03"]);
    expect(new Date(addWorking(h, at("2026-11-02T12:00:00Z"), 4 * H)).toISOString()).toBe("2026-11-04T07:00:00.000Z");
    expect(workingBetween(h, at("2026-11-03T00:00:00Z"), at("2026-11-04T00:00:00Z"))).toBe(0);
  });

  it("keeps wall-clock hours across a clock change", () => {
    const h = office("Europe/Berlin");
    // 09:00 in Berlin is 07:00 UTC in summer time, and 08:00 UTC after the clocks go back on 25 October 2026.
    expect(new Date(fromWallClock(2026, 10, 23, 540, "Europe/Berlin")).toISOString()).toBe("2026-10-23T07:00:00.000Z");
    expect(new Date(fromWallClock(2026, 10, 26, 540, "Europe/Berlin")).toISOString()).toBe("2026-10-26T08:00:00.000Z");
    // Friday 17:00 (summer time) plus 2 working hours ends Monday 10:00 (winter time).
    expect(new Date(addWorking(h, at("2026-10-23T15:00:00Z"), 2 * H)).toISOString()).toBe("2026-10-26T09:00:00.000Z");
  });

  it("is plain elapsed time round the clock", () => {
    const h: Hours = { always: true, days: [[], [], [], [], [], [], []], timeZone: "UTC", holidays: [] };
    expect(workingBetween(h, 0, 5 * H)).toBe(5 * H);
    expect(addWorking(h, 0, 5 * H)).toBe(5 * H);
    expect(dayLength(h)).toBe(24 * H);
    expect(dayLength(office())).toBe(9 * H);
  });
});
