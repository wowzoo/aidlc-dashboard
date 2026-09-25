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
//   3. No thresholds are invented. The stop hook's give-up cap is run-mode-aware
//      and lives in the engine (hooks/aidlc-stop.ts), not in this repo, so the
//      stuck chip reports the measured count and does not grade it.
//
// A completed run shows the run chip alone: a past block or a past failed check is
// history, not a problem with the run. The one exception is an ask left unanswered,
// which stays reachable as a loose end (see buildStatus).

import type { DashboardModel } from "./types";

export type RunReading =
  | { state: "complete" }
  | { state: "unknown" }
  | {
      state: "running";
      stageDisplay: string;
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
  | { state: "blocked"; count: number; stage: string };

export interface HumanReading {
  /** Unanswered asks in the stage the engine is on — the ones stopping the run. */
  current: number;
  /** Longest wait among `current`, in seconds. */
  oldestWaitingSec?: number;
  /** Stage whose gate is open and awaiting approval, from the audit. */
  awaitingGate?: string;
  /** Unanswered asks parked in earlier stages — loose ends, not the reason it stopped. */
  earlier: number;
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
  "state" | "health" | "blockers" | "sensors" | "timing" | "provenance"
>;

/** The stage half of a `<stage>::<audit line count>` signature. */
function signatureStage(signature: string): string {
  const cut = signature.lastIndexOf("::");
  return cut < 0 ? signature : signature.slice(0, cut);
}

function readStuck(m: StatusInput): StuckReading {
  const guard = m.health.stopGuard;
  if (!guard) return { state: "no-record" };
  if (guard.count === 0) return { state: "clear" };
  const stage = signatureStage(guard.signature);
  const current = m.state.currentStage;
  if (current && stage && stage !== current) return { state: "earlier-stage", stage };
  return { state: "blocked", count: guard.count, stage };
}

function readHuman(m: StatusInput): HumanReading {
  const current = m.blockers.filter((b) => b.isCurrentStage);
  const waits = current
    .map((b) => b.waitingSec)
    .filter((w): w is number => w !== undefined && Number.isFinite(w));
  return {
    current: current.length,
    oldestWaitingSec: waits.length > 0 ? Math.max(...waits) : undefined,
    awaitingGate: m.timing.awaitingStage,
    earlier: m.blockers.length - current.length,
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
  const run: RunReading = m.state.currentStage
    ? {
        state: "running",
        stageDisplay: m.state.currentStageDisplay || m.state.currentStage,
        lastEventAgeSec: m.provenance.audit.ageSec,
      }
    : { state: "unknown" };
  return { run, stuck: readStuck(m), human: readHuman(m), checks: readChecks(m) };
}
