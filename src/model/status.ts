// The status strip: one line at the top of the page that answers "is this run
// moving, and is anything wrong?" without the reader opening a panel.
//
// Nothing here is new data. Every chip is a reading of a field the model already
// carries — state.md for the run, the stop hook's block-count for "stuck", the
// blockers for "waiting on you", the audit's sensor roll-up for checks — so no new
// SourceKind is minted. What this module adds is the READING, and three rules keep
// that reading honest:
//
//   1. There is no combined "all good" verdict. Four signals from four sources with
//      four freshnesses do not average into one word; each chip states its own.
//   2. A chip is only green when its signal was READ and is off. A source that is
//      missing reads as "no record" (muted), never as healthy — a run whose stop
//      hook never wrote block-count.json has not been shown to be unstuck.
//   3. No thresholds are invented — and the one the stuck chip uses is the engine's.
//      The stop hook (aidlc-continue-workflow.ts) writes `count` 1 on the first block
//      after progress (a changed signature), adds one per block with no progress,
//      resets to 0 only on done/notice/parked/handoff, and RELEASES the turn once the
//      count reaches its cap: 8 under autonomous Construction, 2 otherwise, unless
//      `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` overrides it — which a file on disk cannot
//      show, so the reading says which default it assumed. 1 is a nudge, not "stuck".
//
// A completed run shows the run chip alone: a past block or a past failed check is
// history, not a problem with the run. The one exception is an ask left unanswered,
// which stays reachable as a loose end (see buildStatus).

import type { DashboardModel } from "./types";
import type { Waits } from "./waits";

export type RunReading =
  | { state: "complete" }
  | { state: "unknown" }
  | {
      state: "running";
      stageDisplay: string;
      /** The unit the run is on, when the position names one. */
      unit?: string;
      /** False when the position fell back to a `Current Stage` that can lag. */
      verified: boolean;
      /** Age of the newest audit event — how long since the run last wrote anything. */
      lastEventAgeSec?: number;
    };

export type StuckReading =
  /** No block-count.json: the guard never recorded a block on this clone. */
  | { state: "no-record" }
  /** count 0 — the guard saw progress since its last block. */
  | { state: "clear" }
  /**
   * The recorded block belongs to an earlier stage. The file is only rewritten on a
   * block and its signature starts with the stage, so a signature naming a stage the
   * run has left means no block has happened since the move.
   */
  | { state: "earlier-stage"; stage: string }
  /**
   * The record names a state digest that is not the current state's. The hook writes 1
   * on its next block after any change, so no block has happened since — history.
   */
  | { state: "state-changed"; stage: string }
  /** count 1 — the hook pushed once since the last progress. Normal operation. */
  | { state: "nudged"; stage: string; cap: number }
  /** 2 ≤ count < cap — blocked again with no progress in between. */
  | { state: "blocked"; count: number; stage: string; cap: number }
  /** count ≥ cap — the hook gave up and let the turn end. */
  | { state: "released"; count: number; stage: string; cap: number };

export interface HumanReading {
  /** Unanswered asks in the stage the engine is on — the ones stopping the run. */
  current: number;
  /** Longest wait among `current`, in seconds. */
  oldestWaitingSec?: number;
  /** Stage whose gate is open and awaiting approval, from the audit. */
  awaitingGate?: string;
  /** Unanswered asks parked in earlier stages — loose ends, not the reason it stopped. */
  earlier: number;
  /** The run's other holds, read from the engine's own records — see model/waits.ts. */
  waits?: Waits;
}

export type ChecksReading =
  /** No sensor firing recorded for the current stage. */
  | { state: "none" }
  | { state: "in-flight"; pending: number; failed: number; passed: number }
  /**
   * At least one firing in this stage failed. The roll-up does not say whether a
   * later re-fire passed, so this is "failures recorded", not "failing now".
   */
  | { state: "failed"; failed: number; passed: number }
  | { state: "passed"; passed: number };

export interface StatusStrip {
  run: RunReading;
  /** Absent when the run is complete. */
  stuck?: StuckReading;
  /** On a complete run, present only when asks are left unanswered. */
  human?: HumanReading;
  /** Absent when the run is complete. */
  checks?: ChecksReading;
}

type StatusInput = Pick<
  DashboardModel,
  "state" | "health" | "blockers" | "sensors" | "timing" | "provenance" | "waits"
>;

/** The stop hook's default cap — see rule 3 in the header. */
export function defaultStopCap(autonomous: boolean): number {
  return autonomous ? 8 : 2;
}

/**
 * The stage part of a stop-guard signature — everything before the FIRST `::`.
 * The engine has written two shapes: `<stage>::<audit line count>` before 2.9 and
 * `<stage>::<state sha256>::<directive fingerprint>` in 2.10
 * (`hooks/aidlc-continue-workflow.ts`). Cutting at the last `::` read the 2.10 shape
 * as the stage `<stage>::<sha>`, which never equals the current stage, so a run
 * blocked right now drew as a green "cleared, last block in an earlier stage".
 * A stage slug never contains `::`, so the first separator is right for both.
 */
function signatureStage(signature: string): string {
  const cut = signature.indexOf("::");
  return cut < 0 ? signature : signature.slice(0, cut);
}

function readStuck(m: StatusInput): StuckReading {
  const guard = m.health.stopGuard;
  if (!guard) return { state: "no-record" };
  if (guard.count === 0) return { state: "clear" };
  const stage = signatureStage(guard.signature);
  const current = m.state.currentStage;
  if (current && stage && stage !== current) return { state: "earlier-stage", stage };
  if (m.waits.guardRecordStale) return { state: "state-changed", stage };
  const cap = defaultStopCap(m.waits.autonomous);
  if (guard.count >= cap) return { state: "released", count: guard.count, stage, cap };
  if (guard.count === 1) return { state: "nudged", stage, cap };
  return { state: "blocked", count: guard.count, stage, cap };
}

function readHuman(m: StatusInput): HumanReading {
  const current = m.blockers.filter((b) => b.isCurrentStage);
  const waits = current
    .map((b) => b.waitingSec)
    .filter((w): w is number => w !== undefined && Number.isFinite(w));
  return {
    current: current.length,
    oldestWaitingSec: waits.length > 0 ? Math.max(...waits) : undefined,
    awaitingGate: m.waits.gate?.stage,
    earlier: m.blockers.length - current.length,
    waits: m.waits,
  };
}

function readChecks(m: StatusInput): ChecksReading {
  const stage = m.state.currentStage;
  const row = stage ? m.sensors.stages.find((s) => s.stage === stage) : undefined;
  if (!row || row.fired === 0) return { state: "none" };
  if (row.pending > 0) {
    return { state: "in-flight", pending: row.pending, failed: row.failed, passed: row.passed };
  }
  if (row.failed > 0) return { state: "failed", failed: row.failed, passed: row.passed };
  return { state: "passed", passed: row.passed };
}

export function buildStatus(m: StatusInput): StatusStrip {
  if (m.state.complete) {
    // Blocks and failed checks on a finished run are history. An unanswered ask is
    // not: it is a loose end the run left behind, and since the asks list lives under
    // this chip, dropping the chip would leave it unreachable. It is reported as
    // parked — nothing is waiting on it for the run to proceed.
    if (m.blockers.length === 0) return { run: { state: "complete" } };
    return {
      run: { state: "complete" },
      human: { current: 0, earlier: m.blockers.length },
    };
  }
  const pos = m.waits.position;
  // The position's stage, not Current Stage, when the engine's own records name a
  // later one (unit-major) — and its display name only when it IS the Current Stage.
  const stage = pos.stage ?? m.state.currentStage;
  const run: RunReading = stage
    ? {
        state: "running",
        stageDisplay: stage === m.state.currentStage ? m.state.currentStageDisplay || stage : stage,
        unit: pos.unit,
        verified: pos.verified,
        lastEventAgeSec: m.provenance.audit.ageSec,
      }
    : { state: "unknown" };
  return { run, stuck: readStuck(m), human: readHuman(m), checks: readChecks(m) };
}
