// A team-owned unit's own gate — a transcription of the 2.11.0 engine's `unitGateStatus`
// (aidlc-lib.ts), which the stop hook's `isHumanWaitStop` asks for the active stage and
// unit, at the gate scope `effectiveUnitGateRhythm` gives, before it looks at the
// Current Stage row. Under team ownership the global row never moves to `[?]` for a
// unit's gate, so without this reader a run parked at one read as nothing waiting.
//
// The rule: over the merged ledger ordered by (time, shard index, pos), each second's
// rows that bear on the gate — a `WORKFLOW_STARTED`, a `STAGE_JUMPED` that reaches the
// stage, or a gate row (`STAGE_AWAITING_APPROVAL`, `STAGE_REVISING`, `GATE_APPROVED`,
// `GATE_REJECTED`) naming the stage in `Gate Stages` (else `Stage`), the unit in `Unit`,
// the claim attempt (`eventMatchesClaimAttempt`, scan/claim-attempt.ts) and the scope in
// `Gate Scope` (default `per-stage`). One shard's rows are replayed in order; rows of
// several shards in one second are unordered, so a boundary among them resets to
// pending, else revising > awaiting > unanimous approved > pending.
//
// A gate row the claim filter cannot decide makes the answer `unknown`.

import type { AuditEvent } from "./audit";
import type { ClaimFilter } from "./claim-attempt";

export type UnitGateStatus = "pending" | "awaiting-approval" | "revising" | "approved";

const GATE_ROWS = new Set([
  "STAGE_AWAITING_APPROVAL",
  "STAGE_REVISING",
  "GATE_APPROVED",
  "GATE_REJECTED",
]);

/** `gateStagesFromBlock`: the `Gate Stages` list when given, else `Stage`. */
function gateStages(f: Record<string, string>): string[] {
  const explicit = f["Gate Stages"];
  if (explicit) {
    return explicit
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return f.Stage ? [f.Stage] : [];
}

/** `stageJumpReaches`: a jump to this stage, or to one at or before it in stage order. */
function jumpReaches(
  f: Record<string, string>,
  slug: string,
  stageIndex?: (s: string) => number,
): boolean {
  const name = f.Target;
  if (!name || name === slug) return true;
  try {
    const target = stageIndex?.(name) ?? -1;
    const at = stageIndex?.(slug) ?? -1;
    return target === -1 || at === -1 || at >= target;
  } catch {
    return true;
  }
}

const statusOf = (event: string): UnitGateStatus =>
  event === "GATE_APPROVED"
    ? "approved"
    : event === "GATE_REJECTED" || event === "STAGE_REVISING"
      ? "revising"
      : "awaiting-approval";

/** `unitGateStatus(projectDir, stage, unit, scope)` over the record's merged ledger. */
export function unitGateStatus(
  events: readonly AuditEvent[],
  stage: string,
  unit: string,
  scope: "per-stage" | "unit-end",
  claim: ClaimFilter,
  stageIndex?: (s: string) => number,
): UnitGateStatus | "unknown" {
  const rows = [...events].sort((a, b) =>
    a.ts !== b.ts
      ? a.ts < b.ts
        ? -1
        : 1
      : (a.shardIndex ?? 0) - (b.shardIndex ?? 0) || (a.pos ?? 0) - (b.pos ?? 0),
  );
  let unresolved = false;
  const bears = (e: AuditEvent): boolean => {
    if (e.event === "WORKFLOW_STARTED") return true;
    if (e.event === "STAGE_JUMPED") return jumpReaches(e.fields, stage, stageIndex);
    if (!GATE_ROWS.has(e.event)) return false;
    if (!gateStages(e.fields).includes(stage) || e.fields.Unit !== unit) return false;
    const pass = claim(e.fields, unit);
    if (pass === "unknown") {
      unresolved = true;
      return false;
    }
    return pass && (e.fields["Gate Scope"] ?? "per-stage") === scope;
  };

  let status: UnitGateStatus = "pending";
  for (let start = 0; start < rows.length; ) {
    let end = start + 1;
    while (end < rows.length && rows[end]?.ts === rows[start]?.ts) end++;
    const relevant = rows.slice(start, end).filter(bears);
    if (relevant.length > 0) {
      const shards = new Set(relevant.map((e) => e.shard));
      const boundary = relevant.some(
        (e) => e.event === "WORKFLOW_STARTED" || e.event === "STAGE_JUMPED",
      );
      if (shards.size > 1) {
        if (boundary) {
          status = "pending";
        } else {
          const seen = new Set(relevant.map((e) => statusOf(e.event)));
          status = seen.has("revising")
            ? "revising"
            : seen.has("awaiting-approval")
              ? "awaiting-approval"
              : seen.size === 1
                ? "approved"
                : "pending";
        }
      } else {
        for (const e of relevant) {
          status =
            e.event === "WORKFLOW_STARTED" || e.event === "STAGE_JUMPED"
              ? "pending"
              : statusOf(e.event);
        }
      }
    }
    start = end;
  }
  return unresolved ? "unknown" : status;
}
