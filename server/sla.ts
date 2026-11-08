// A ticket's two SLA clocks: first reply and solution. Both count working time in the queue's hours and run together
// from the moment the ticket is opened; they pause while the ticket waits on the customer and run again when the
// customer answers. The first-reply clock stops at the first reply from the support address; the solution clock stops
// when the ticket is solved, and runs on from where it was if the customer reopens it. A clock that passed its target is
// missed and stays missed. The time each clock counted is kept in ms (`*_elapsed`); `run_since` is when they last
// started running, so the time since then is added on reading.
import { addWorking, workingBetween, type Hours } from "./hours.ts";

export interface ClockRow {
  fr_target: number | null;
  fr_elapsed: number;
  fr_done_at: string | null;
  fr_breached_at: string | null;
  sol_target: number | null;
  sol_elapsed: number;
  sol_done_at: string | null;
  sol_breached_at: string | null;
  run_since: string | null;
}

export type ClockState = "running" | "paused" | "met" | "missed";

export interface ClockView {
  /** The target in working time, ms. */
  target: number;
  state: ClockState;
  /** Working time counted so far, ms. */
  elapsed: number;
  /** Working time left, ms; below zero once missed. */
  remaining: number;
  /** While running, when it runs out (or ran out); null while paused or stopped. */
  dueAt: string | null;
  /** When it was missed. */
  missedAt: string | null;
  /** When it stopped: the first reply, or the solution. */
  doneAt: string | null;
}

const PREFIX = { firstReply: "fr", solution: "sol" } as const;
type Which = keyof typeof PREFIX;
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string) => Date.parse(s);

/** Adds the time since `run_since` to each clock that is not stopped, noting when one passes its target. */
export function settle(row: ClockRow, hours: Hours, now: number, then: "run" | "pause"): Partial<ClockRow> {
  const out: Partial<ClockRow> = {};
  if (row.run_since) {
    const since = ms(row.run_since);
    const delta = workingBetween(hours, since, now);
    for (const which of ["firstReply", "solution"] as const) {
      const p = PREFIX[which];
      if (row[`${p}_done_at`]) continue;
      const elapsed = row[`${p}_elapsed`];
      const target = row[`${p}_target`];
      if (target !== null && !row[`${p}_breached_at`] && elapsed + delta > target) out[`${p}_breached_at`] = iso(addWorking(hours, since, target - elapsed));
      out[`${p}_elapsed`] = elapsed + delta;
    }
  }
  out.run_since = then === "run" ? iso(now) : null;
  return out;
}

/** Stops one clock now: the first reply was sent, or the ticket was solved. Call settle first. */
export function stop(row: ClockRow, which: Which, now: number): Partial<ClockRow> {
  const p = PREFIX[which];
  return row[`${p}_done_at`] ? {} : { [`${p}_done_at`]: iso(now) };
}

/** Starts one clock again after the ticket was reopened. */
export function restart(which: Which): Partial<ClockRow> {
  return { [`${PREFIX[which]}_done_at`]: null };
}

/**
 * New targets after a move to another queue: a clock that is stopped or missed keeps its result; the others start over
 * with the new queue's target.
 */
export function retarget(row: ClockRow, targets: { firstReply: number | null; solution: number | null }): Partial<ClockRow> {
  const out: Partial<ClockRow> = {};
  for (const which of ["firstReply", "solution"] as const) {
    const p = PREFIX[which];
    if (row[`${p}_done_at`] || row[`${p}_breached_at`]) continue;
    out[`${p}_target`] = targets[which];
    out[`${p}_elapsed`] = 0;
  }
  return out;
}

/** One clock as it stands at `now`, or null when its queue sets no target for it. */
export function clock(row: ClockRow, which: Which, hours: Hours, now: number): ClockView | null {
  const p = PREFIX[which];
  const target = row[`${p}_target`];
  if (target === null) return null;
  const done = row[`${p}_done_at`];
  const running = !done && row.run_since !== null;
  const since = row.run_since ? ms(row.run_since) : now;
  const elapsed = row[`${p}_elapsed`] + (running ? workingBetween(hours, since, now) : 0);
  let missedAt = row[`${p}_breached_at`];
  if (!missedAt && !done && running && elapsed > target) missedAt = iso(addWorking(hours, since, target - row[`${p}_elapsed`]));
  const state: ClockState = missedAt ? "missed" : done ? "met" : running ? "running" : "paused";
  const dueAt = running ? (missedAt ?? iso(addWorking(hours, now, target - elapsed))) : null;
  return { target, state, elapsed, remaining: target - elapsed, dueAt, missedAt, doneAt: done };
}

/** The clock that matters now: the first reply until it is sent, then the solution. */
export function current(row: ClockRow, hours: Hours, now: number): (ClockView & { which: Which }) | null {
  const fr = clock(row, "firstReply", hours, now);
  if (fr && !fr.doneAt) return { ...fr, which: "firstReply" };
  const sol = clock(row, "solution", hours, now);
  return sol ? { ...sol, which: "solution" } : fr && fr.state === "missed" ? { ...fr, which: "firstReply" } : null;
}
