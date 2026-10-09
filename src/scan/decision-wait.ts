// Is a stage holding an open DECISION — a question asked through the audit rather
// than through a blank `[Answer]:` tag?
//
// WHY. Some of the engine's asks never touch a questions file: the §13 learnings
// selection, "Anything to add?", a Construction Unit Approval, a Swarm Batch
// Approval. The engine opens each with `DECISION_RECORDED` and the stop hook lets
// the turn end while one is open (aidlc-continue-workflow.ts `isPendingDecisionStop`).
// A reader of questions files sees none of them, so a run parked on one read as
// waiting on nothing.
//
// TRANSCRIBED from 2.11 aidlc-lib.ts, in its two modes:
//
//   - `openDecisionBlock` (the ordinary case): after the stage's last main-workflow
//     `STAGE_STARTED` (a `single-stage:` one does not reset the window; with no such
//     start there is no window and nothing is open), every row of the stage in time
//     order, through `nextOpenDecision`.
//   - `hasPendingDecision(…, workflowAttempt)` (a stage running ahead of Current
//     Stage, and a team unit-major directive): after the last `WORKFLOW_STARTED` or
//     a `STAGE_JUMPED` that reaches the stage — skipping past every row of that
//     second when several shards wrote in it — rows of the stage (and unit, when
//     given) grouped by second; a group in which several shards wrote several kinds
//     of row is causally unordered and clears the decision.
//
// `nextOpenDecision` / `decisionAnsweredBy`: `DECISION_RECORDED` opens; any of
// QUESTION_ANSWERED, SUMMARY_CONFIRMATION_RECORDED, VERIFICATION_COMMAND_RECORDED,
// CONSTRUCTION_POLICY_RECORDED, PLAN_APPROVAL_RECORDED closes; and a
// GATE_APPROVED/GATE_REJECTED closes only the two gate-answered checkpoints, and
// only when it carries that checkpoint's gate name, the same key (Batch number /
// Unit), the matching Kind, and the same Fingerprint when one was recorded.
//
// 2.10 closed a decision on QUESTION_ANSWERED alone; reading the wider 2.11 set on a
// 2.10 tree closes waits the 2.10 engine itself would have kept open after one of
// those receipts — an engine defect this reader does not reproduce.
//
// Fields are read from the block's own `**Field**:` lines, as the engine reads them.

import type { AuditEvent } from "./audit";

const CLOSING = new Set([
  "QUESTION_ANSWERED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "VERIFICATION_COMMAND_RECORDED",
  "CONSTRUCTION_POLICY_RECORDED",
  "PLAN_APPROVAL_RECORDED",
]);
const GATE_ANSWER = new Set(["GATE_APPROVED", "GATE_REJECTED"]);
const GATE_ANSWERED: Record<string, { gates: string[]; key: string }> = {
  "Swarm Batch Approval": { gates: ["swarm-batch"], key: "Batch number" },
  "Construction Unit Approval": { gates: ["construction-unit", "walking-skeleton"], key: "Unit" },
};
const PAIRING = new Set(["DECISION_RECORDED", ...CLOSING, ...GATE_ANSWER]);

/** The open decision's own fields — what was asked, and under which checkpoint. */
export interface OpenDecision {
  stage: string;
  checkpoint?: string;
  /** The `Decision` field: the question as the engine recorded it. */
  decision?: string;
  since: string;
}

function answeredBy(open: AuditEvent | undefined, e: AuditEvent): boolean {
  if (CLOSING.has(e.event)) return true;
  if (!open || !GATE_ANSWER.has(e.event)) return false;
  const checkpoint = open.fields.Checkpoint ?? "";
  const rule = Object.hasOwn(GATE_ANSWERED, checkpoint) ? GATE_ANSWERED[checkpoint] : undefined;
  if (!rule) return false;
  const gate = e.fields.Checkpoint;
  if (gate === undefined || !rule.gates.includes(gate)) return false;
  const want = open.fields[rule.key];
  if (want === undefined || want !== e.fields[rule.key]) return false;
  if (checkpoint === "Construction Unit Approval") {
    const kind = open.fields.Kind;
    const expected =
      kind === "unit" ? "construction-unit" : kind === "skeleton" ? "walking-skeleton" : null;
    if (kind !== undefined && gate !== expected) return false;
  }
  const fingerprint = open.fields.Fingerprint;
  return fingerprint === undefined || fingerprint === e.fields.Fingerprint;
}

function next(open: AuditEvent | undefined, e: AuditEvent): AuditEvent | undefined {
  if (e.event === "DECISION_RECORDED") return e;
  return answeredBy(open, e) ? undefined : open;
}

function asOpen(e: AuditEvent | undefined): OpenDecision | undefined {
  if (!e) return undefined;
  return {
    stage: e.fields.Stage ?? "",
    checkpoint: e.fields.Checkpoint,
    decision: e.fields.Decision,
    since: e.ts,
  };
}

/** `openDecisionBlock(…, "STAGE_STARTED")`. `events` ascending by time. */
export function openDecision(events: AuditEvent[], stage: string): OpenDecision | undefined {
  const rows = events.filter((e) => PAIRING.has(e.event) || e.event === "STAGE_STARTED");
  const boundary = rows.findLastIndex(
    (e) =>
      e.event === "STAGE_STARTED" &&
      e.fields.Stage === stage &&
      !(e.fields.Workflow ?? "").startsWith("single-stage:"),
  );
  if (boundary < 0) return undefined;
  let open: AuditEvent | undefined;
  for (const e of rows.slice(boundary + 1)) {
    if (e.fields.Stage !== stage || e.event === "STAGE_STARTED") continue;
    open = next(open, e);
  }
  return asOpen(open);
}

/**
 * `hasPendingDecision(…, workflowAttempt = true)`. `stageIndex` is the catalogue's
 * stage order, for `stageJumpReaches`; without one every jump reaches, as the engine's
 * own fallback for an unknown slug does.
 */
export function openDecisionInAttempt(
  events: AuditEvent[],
  stage: string,
  unit?: string,
  stageIndex?: (slug: string) => number,
): OpenDecision | undefined {
  const rows = events.filter(
    (e) => PAIRING.has(e.event) || e.event === "WORKFLOW_STARTED" || e.event === "STAGE_JUMPED",
  );
  if (rows.length === 0) return undefined;
  const reaches = (e: AuditEvent): boolean => {
    const target = e.fields.Target;
    if (!target || target === stage) return true;
    const t = stageIndex?.(target) ?? -1;
    const at = stageIndex?.(stage) ?? -1;
    return t === -1 || at === -1 || at >= t;
  };
  const boundary = rows.findLastIndex(
    (e) => e.event === "WORKFLOW_STARTED" || (e.event === "STAGE_JUMPED" && reaches(e)),
  );
  let start = 0;
  if (boundary >= 0) {
    const ts = rows[boundary]?.ts;
    const shards = new Set(rows.filter((e) => e.ts === ts).map((e) => e.shard));
    start = shards.size > 1 ? rows.findLastIndex((e) => e.ts === ts) + 1 : boundary + 1;
  }
  let open: AuditEvent | undefined;
  for (let g = start; g < rows.length; ) {
    let end = g + 1;
    while (end < rows.length && rows[end]?.ts === rows[g]?.ts) end++;
    const matching = rows
      .slice(g, end)
      .filter(
        (e) =>
          e.fields.Stage === stage &&
          (unit === undefined || e.fields.Unit === unit) &&
          (e.event === "DECISION_RECORDED" || answeredBy(open, e)),
      );
    const shards = new Set(matching.map((e) => e.shard));
    const kinds = new Set(matching.map((e) => e.event));
    if (shards.size > 1 && kinds.size > 1) open = undefined;
    else for (const e of matching) open = next(open, e);
    g = end;
  }
  return asOpen(open);
}
