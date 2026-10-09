// How much of the run was doing work over again.
//
// WHY THIS IS ITS OWN READER. The audit's richest signal is not what got produced,
// it is what got sent back. Measured on one real run: 26 gate submissions against 17
// approvals, **11 rejections**, 11 revisions and 2 backward jumps — and the time
// between a stage's first rejection and its final approval came to **18.94h, 14.6% of
// the whole wall clock**. None of that reached the screen: `GateSummary` counted the
// events and no render module read it, while the timing panel showed a stage's rework
// only as a second bar with no indication of why it was re-entered.
//
// WHAT A REJECTION CARRIES. `GATE_REJECTED` and `STAGE_REVISING` are emitted in the
// same second and both hold a `**Feedback**` field with the human's reason in full
// prose (measured: 22 Feedback fields across the 22 events). That text is the highest
// information density in the ledger, so it is surfaced rather than counted.
//
// WHAT "REWORK TIME" MEANS HERE, exactly: from a stage's FIRST `GATE_REJECTED` to the
// LAST `GATE_APPROVED` that follows it. A stage rejected twice therefore counts the
// whole stretch including the approval in between — it is "time this stage spent not
// yet accepted", not a sum of individual revision spans, which the ledger cannot give
// because a revision has no close marker of its own. When no approval follows the
// last rejection the rework is still open: `settled` is false and the span is measured
// to the stage's last event, which the screen marks provisional rather than dropping.
//
// "AFTER" IS LEDGER ORDER, NOT A LATER TIMESTAMP. The approve-time revision backstop
// writes `GATE_REJECTED` (`Recovered: true`), `STAGE_REVISING` and the re-entered
// `STAGE_AWAITING_APPROVAL` in the same second as the `GATE_APPROVED` that follows
// (`tools/aidlc-state.ts approve`), so a strict `ts >` comparison left every backfilled
// rejection unsettled for good.
//
// A UNIT GATE IS ITS OWN RECORD. Unit-end and team gate rows carry `Unit`; keyed by
// stage alone, unit A's rejection was "settled" by unit B's approval.
//
// A REOPEN IS NOT A REJECTION. 2.11 writes `GATE_REJECTED` with `Reopen: jump|redo|change`
// when the person re-enters a per-unit stage (`tools/aidlc-jump.ts`): `jump` is
// `/aidlc --stage`, `redo` the Redo answer on re-entry, `change` a Request Changes at
// the late question. Only `change` judges the content — its Feedback holds the person's
// words — so `jump`/`redo` are counted as reopens, apart from rejections, and their
// engine-written Feedback is not offered as a human's reason.
//
// Node-free and never throws: it reads the already-parsed ledger.

import type { AuditEvent, AuditLedger } from "./audit";

/** One stage's rework record. Only stages that were actually sent back appear. */
export interface StageRework {
  stage: string;
  /** Set when the gate rows were unit-scoped (they carry `Unit`). */
  unit?: string;
  /** `STAGE_AWAITING_APPROVAL` — how many times it was submitted for approval. */
  submissions: number;
  rejections: number;
  /** `STAGE_REVISING` events, i.e. how many revision rounds were opened. */
  revisions: number;
  /** Highest `Revision count` field seen on this stage's revisions, when present. */
  revisionHigh?: number;
  firstRejectedAt: string;
  /** First rejection → last approval after it (or to the last event when unsettled). */
  reworkSec: number;
  /** False when no approval followed the last rejection — still being reworked. */
  settled: boolean;
  /** Rejection reasons, newest first. */
  feedback: { at: string; text: string }[];
}

export interface ReworkReport {
  /** Stages that were sent back, costliest first. */
  stages: StageRework[];
  approved: number;
  /** Rejections, reopens excluded. */
  rejected: number;
  /** `GATE_REJECTED` rows with `Reopen: jump|redo` — a unit re-entered on request. */
  reopened: number;
  revisions: number;
  jumps: number;
  /** `REVIEW_FREEZE_BLOCKED` — an edit refused because a review was in progress. */
  freezeBlocked: number;
  /** Σ per-stage rework time. */
  reworkSec: number;
  /** True when at least one stage's rework has not closed yet. */
  provisional: boolean;
}

const MAX_FEEDBACK = 6;

/**
 * Build the rework report from a merged ledger. Pure over the events, so a test can
 * drive it from a synthetic list.
 */
export function buildRework(ledger: AuditLedger): ReworkReport {
  const submissions = new Map<string, number>();
  const rejections = new Map<string, { at: string; index: number }[]>();
  const revisions = new Map<string, number>();
  const revisionHigh = new Map<string, number>();
  const approvals = new Map<string, number[]>(); // key → approval ledger indices
  const feedback = new Map<string, { at: string; text: string }[]>();
  const lastSeen = new Map<string, string>(); // key → last timestamp of any event
  const units = new Map<string, { stage: string; unit?: string }>();
  let reopened = 0;
  const bump = (m: Map<string, number>, k: string): void => {
    m.set(k, (m.get(k) ?? 0) + 1);
  };
  const addFeedback = (k: string, at: string, text: string): void => {
    const list = feedback.get(k) ?? [];
    list.push({ at, text });
    feedback.set(k, list);
  };

  const isReopen = (e: AuditEvent): boolean =>
    e.event === "GATE_REJECTED" && e.fields.Reopen !== undefined && e.fields.Reopen !== "change";

  ledger.events.forEach((e, index) => {
    if (isReopen(e)) {
      reopened++;
      return;
    }
    const stage = e.stage;
    if (!stage) return;
    const unit = e.fields.Unit || undefined;
    const key = unit === undefined ? stage : `${stage}\0${unit}`;
    if (!units.has(key)) units.set(key, { stage, unit });
    lastSeen.set(key, e.ts);
    if (unit !== undefined) lastSeen.set(stage, e.ts);
    if (e.event === "STAGE_AWAITING_APPROVAL") bump(submissions, key);
    else if (e.event === "GATE_APPROVED") {
      const list = approvals.get(key);
      if (list) list.push(index);
      else approvals.set(key, [index]);
    } else if (e.event === "GATE_REJECTED") {
      const list = rejections.get(key);
      if (list) list.push({ at: e.ts, index });
      else rejections.set(key, [{ at: e.ts, index }]);
      const text = e.fields.Feedback?.trim();
      if (text) addFeedback(key, e.ts, text);
    } else if (e.event === "STAGE_REVISING") {
      bump(revisions, key);
      const raw = e.fields["Revision count"];
      if (raw && /^\d+$/.test(raw.trim())) {
        const n = Number(raw.trim());
        if (n > (revisionHigh.get(key) ?? 0)) revisionHigh.set(key, n);
      }
      // Only used when the rejection itself carried no reason.
      const text = e.fields.Feedback?.trim();
      if (text && !(feedback.get(key) ?? []).some((f) => f.text === text))
        addFeedback(key, e.ts, text);
    }
  });

  const stages: StageRework[] = [];
  for (const [key, rejected] of rejections) {
    const { stage, unit } = units.get(key)!;
    const first = rejected[0]!.at;
    const last = rejected[rejected.length - 1]!;
    const after = (approvals.get(key) ?? []).filter((index) => index > last.index);
    const settled = after.length > 0;
    const end = settled
      ? ledger.events[after[after.length - 1]!]!.ts
      : (lastSeen.get(key) ?? last.at);
    const reworkSec = Math.max(0, (Date.parse(end) - Date.parse(first)) / 1000);
    const high = revisionHigh.get(key);
    stages.push({
      stage,
      ...(unit === undefined ? {} : { unit }),
      submissions: submissions.get(key) ?? 0,
      rejections: rejected.length,
      revisions: revisions.get(key) ?? 0,
      ...(high === undefined ? {} : { revisionHigh: high }),
      firstRejectedAt: first,
      reworkSec: Number.isFinite(reworkSec) ? reworkSec : 0,
      settled,
      feedback: (feedback.get(key) ?? []).slice().reverse().slice(0, MAX_FEEDBACK),
    });
  }
  stages.sort((a, b) => b.reworkSec - a.reworkSec);

  const n = (k: string): number => ledger.counts.get(k) ?? 0;
  return {
    stages,
    approved: n("GATE_APPROVED"),
    rejected: n("GATE_REJECTED") - reopened,
    reopened,
    revisions: n("STAGE_REVISING"),
    jumps: n("STAGE_JUMPED"),
    freezeBlocked: n("REVIEW_FREEZE_BLOCKED"),
    reworkSec: stages.reduce((sum, s) => sum + s.reworkSec, 0),
    provisional: stages.some((s) => !s.settled),
  };
}
