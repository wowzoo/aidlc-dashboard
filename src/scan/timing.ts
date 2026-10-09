// Where the run's wall-clock actually went.
//
// PORTED from v2-patches/scripts/harness_timing_report.py (classify_gaps +
// stage_table). That reader was corrected against three real runs, so the rules
// below are transcribed rather than re-derived — including the two defects its
// comments record, both of which a fresh implementation walks straight into:
//
//   1. Bootstrap stages (workspace-scaffold / workspace-detection / state-init)
//      emit STARTED and COMPLETED in the SAME second. Filtering on `elapsed > 0`
//      would mark completed stages as unfinished. Zero-second stages count.
//   2. Measuring only COMPLETED stages hides the stage you most want to see —
//      the one sitting at its approval gate. Its STARTED→AWAITING_APPROVAL span
//      is already-settled work. So the end point is chosen
//      COMPLETED > AWAITING_APPROVAL > last event in the ledger.
//
// WHY GAPS ARE CLASSIFIED AT ALL. Wall-clock is not a measure of the engine:
// most of it is the engine waiting for a human at an approval gate (measured on
// one run: 58 of 79 minutes). So each gap between consecutive events is sorted:
//
//   HUMAN  a gate-opening event followed by one of the engine's answer receipts
//          (GATE_CLOSE — HUMAN_TURN is only one of eight).
//   PARKED every clone PRESENT at that moment is between WORKFLOW_PARKED and
//          WORKFLOW_UNPARKED, plus an inferred session break when an old ledger has
//          no balanced park pair.
//   ACTIVE event-dense time (<5 minutes) and delegation windows.
//   CONV   one clone's HUMAN_TURN straight to its own next HUMAN_TURN.
//   UNKNOWN a 5-minute+ gap with no trustworthy semantic marker.
//
// ACTIVE is deliberately called "observed", not "actual execution": the ledger
// records event boundaries, not CPU/model activity. UNKNOWN stays separate
// instead of being presented as execution.
//
// READ THIS BEFORE TUNING THE TWO CONSTANTS BELOW. `observedSec + unknownSec` is
// invariant under `SUSPECT_SEC` to three decimals — measured 55.689h across the
// whole sweep 60s…∞ on one run. So the pair is one real quantity ("time no marker
// explains") cut at an arbitrary point, and moving the cut moves UNKNOWN between
// 38% and 0% of the wall clock without learning anything. Likewise `IDLE_FLOOR_SEC`
// only trades humanWait against observed. Neither constant can create information;
// what does is a rule that reads a marker the ledger actually carries — which is why
// the park, gate-close and delegation rules were widened instead.
//
// CONVERSATION IS THE ONE THING THAT STRADDLED THAT ARBITRARY CUT. `HUMAN_TURN` →
// the same clone's next `HUMAN_TURN`, nothing in between, measured 58 gaps / 4.72h on
// one run and **same-shard in all 58**. It is one phenomenon that the 300s cut split
// into 2.95h of UNKNOWN and 1.77h of OBSERVED, so naming it does not move the cut —
// it removes a split the cut had invented, which is why it earns a bucket where a
// constant tweak would not. What it must NOT do is pick a side: the span holds the
// engine's chat reply (which emits no audit event) and the human reading and typing,
// and the ledger draws no boundary between them. So it is neither idle nor work, and
// it is excluded from `idleSec` and `workSec` both.

import type { AuditEvent, AuditLedger } from "./audit";

/** Events that open a human wait: after one of these, a gap to a receipt is IDLE. */
const GATE_OPEN = new Set(["DECISION_RECORDED", "QUESTION_ASKED", "STAGE_AWAITING_APPROVAL"]);

/**
 * Events that CLOSE a human wait — the engine's documented answer receipts. Every one
 * of them requires a human to have acted, per `knowledge/aidlc-shared/audit-format.md`,
 * which lists them among the "authority-bearing receipts" only their owning tool may
 * emit. Reading only `HUMAN_TURN` here left three real waits in UNKNOWN:
 *
 *   STAGE_AWAITING_APPROVAL → GATE_APPROVED    a gate opened and a human approved it.
 *                                             The most unambiguous wait the engine has,
 *                                             and it was filed as 미분류.
 *   DECISION_RECORDED → SUMMARY_CONFIRMATION_RECORDED
 *                                             audit-format: the summary choice is
 *                                             "recorded after the matching prompt AND A
 *                                             FRESH HUMAN TURN", so the span contains a
 *                                             human decision by definition.
 *   DECISION_RECORDED → QUESTION_ANSWERED     the documented authorization triple is
 *                                             `DECISION_RECORDED → HUMAN_TURN →
 *                                             QUESTION_ANSWERED`; HUMAN_TURN is
 *                                             "omitted when the driver declares
 *                                             AIDLC_UNATTENDED=1", and the pair then
 *                                             collapses to these two.
 *
 * Measured on one real run: UNKNOWN 6.78h → 5.90h, 사용자 대기 2.17h → 3.20h (+47%),
 * with only 0.16h traded out of `observed`. The gate-open precondition stays — this
 * widens WHAT CLOSES a wait, never what opens one.
 *
 * The set is the engine's `GATE_RESOLUTION_EVENTS` (`tools/aidlc-lib.ts`, 2.11.0) plus
 * `HUMAN_TURN`: the three recorded answers it adds — verification command,
 * construction policy, plan approval — are each written after a person chose.
 */
const GATE_CLOSE = new Set([
  "HUMAN_TURN",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "QUESTION_ANSWERED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "VERIFICATION_COMMAND_RECORDED",
  "CONSTRUCTION_POLICY_RECORDED",
  "PLAN_APPROVAL_RECORDED",
]);

/**
 * Session-resume markers. A gap ENDING in one of these was the human being away,
 * even with no gate event in front of it — measured on two runs where a 38- and a
 * 43-minute gap ran SENSOR_PASSED → GUARDRAIL_LOADED and was followed by a human.
 *
 * `SESSION_RESUMED` is the taxonomy's own resume event — *"Existing Claude Code session
 * resumed (source=resume)"*, emitted by `hooks/aidlc-session-start.ts` — and it was
 * missing while its sibling `SESSION_STARTED` was present. A 40-minute gap closed by it
 * therefore landed in 미분류 instead of 일시중지, which is the one event name where that
 * misfiling is unambiguous.
 */
const SESSION_RESUME = new Set([
  "GUARDRAIL_LOADED",
  "HEALTH_CHECKED",
  "SESSION_STARTED",
  "SESSION_RESUMED",
]);

/** Merge-dispatch terminals: the agent returned, or the engine fell back to defaults. */
const MERGE_DISPATCH_END = new Set(["MERGE_DISPATCH_RETURNED", "MERGE_DISPATCH_FALLBACK"]);

/** Gaps shorter than this are not classified as waiting — they are just work. */
const IDLE_FLOOR_SEC = 60;
/** Unclassified gaps at or above this are surfaced for human judgement. */
const SUSPECT_SEC = 300;

/** Width of one time bin in `TimingReport.bins`. */
export const BIN_SEC = 6 * 3600;

/** Which bucket `classifyGaps` put one gap in. Delegated time is `observed`. */
export type GapBucket = "humanWait" | "parked" | "observed" | "conversation" | "unknown";

/**
 * One fixed-width slice of the run window, holding the part of every classified gap
 * that falls inside it. Bins are a RE-CUT of `TimingReport.total`, not a second
 * classification: each gap keeps the bucket `classifyGaps` gave it and is split
 * across bins by overlap, so a bucket summed over the bins equals that bucket in
 * `total`.
 */
export interface TimeBin {
  /** Bin start, ISO. The first bin starts on a local 00/06/12/18 boundary, the rest
   *  follow in fixed `BIN_SEC` steps. */
  start: string;
  humanWaitSec: number;
  parkedSec: number;
  observedSec: number;
  conversationSec: number;
  unknownSec: number;
}

/** Per-stage workload tally — what the stage actually produced. */
export interface Workload {
  /** ARTIFACT_CREATED + ARTIFACT_UPDATED. */
  artifacts: number;
  /** SENSOR_FIRED. */
  sensors: number;
  /** SENSOR_FAILED. */
  sensorFailures: number;
  /**
   * REVIEW_COMPLETED on this stage. It used to be SUBAGENT_COMPLETED, which in 2.11 carries
   * `Agent Type` and no stage (`hooks/aidlc-log-subagent.ts`), so the by-stage count read 0
   * everywhere — and counting it by time span instead put 160 on one unit-major stage
   * of run E, whose span covers every later stage the units walked. A review names its
   * stage; a subagent does not.
   */
  delegations: number;
  /** HUMAN_TURN (no stage field, so counted within the span). */
  humanTurns: number;
}

/** A long gap we refuse to classify confidently. */
export interface SuspectSpan {
  seconds: number;
  fromEvent: string;
  toEvent: string;
  at: string;
}

export interface GapSplit {
  /** A prompt/approval marker followed by the user's turn. */
  humanWaitSec: number;
  /** Explicit workflow park time, plus conservative inferred session breaks. */
  parkedSec: number;
  /** Park time inferred only from a session-resume marker. Subset of parkedSec. */
  inferredParkSec: number;
  /** Event-dense time and explicit delegation spans. */
  observedSec: number;
  /**
   * Chat exchange — one clone's `HUMAN_TURN` straight to its own next `HUMAN_TURN`,
   * with no engine event in between. See the CONVERSATION note above `classifyGaps`.
   * Deliberately outside both `idleSec` and `workSec`: it holds the engine's unaudited
   * reply AND the human reading it, and the ledger records no boundary between them.
   */
  conversationSec: number;
  /** Long gaps with no trustworthy semantic classification. */
  unknownSec: number;
  /** Delegated time. Subset of observedSec. */
  delegatedSec: number;
  /** Unbalanced/repeated park markers encountered while classifying. */
  parkAnomalies: number;
  /** Long gaps kept visible instead of silently called execution. */
  unknown: SuspectSpan[];
  /** Compatibility aggregate: humanWaitSec + parkedSec. */
  idleSec: number;
  /** Compatibility alias for delegatedSec. */
  agentSec: number;
  /** Compatibility aggregate: observedSec + unknownSec. */
  workSec: number;
  /** Compatibility alias for unknown. */
  suspect: SuspectSpan[];
}

/** How a stage's span was closed. */
/**
 * How a stage segment ended. `superseded` exists because a re-entry is not a state:
 * when `STAGE_STARTED` arrives for a stage that is already open, the earlier segment
 * is over and was replaced. Calling it `in-flight` (which it was, before this) left
 * blue "진행중" bars sitting five days in the past on a real run — two of them — while
 * the legend told the reader blue meant running now. Calling it `awaiting-approval`
 * would be no better: the submission it refers to was rejected, and the rework block
 * is where that belongs.
 */
export type StageEndKind =
  | "completed"
  | "skipped"
  | "awaiting-approval"
  | "in-flight"
  | "superseded";

export interface StageSegment extends GapSplit {
  startedAt: string;
  endedAt: string;
  endKind: StageEndKind;
  elapsedSec: number;
}

export interface StageSpan extends GapSplit {
  stage: string;
  /** First segment start and last segment end, for the run-position track. */
  startedAt: string;
  endedAt: string;
  endKind: StageEndKind;
  /** Sum of entered segments, not first-start → last-end wall time. */
  elapsedSec: number;
  /** Separate entries after a backward jump; gaps between entries are excluded. */
  segments: StageSegment[];
  workload: Workload;
}

/**
 * One audit shard's own timeline — i.e. one clone, which in practice means one
 * developer's machine.
 *
 * WHY THIS EXISTS. The gap rules above read a SINGLE sequence of events: a gap is
 * idle because nothing happened in it. Merge four developers' shards into one
 * sequence and that premise breaks — while A waits at a gate, B is working, so
 * A's wait gets filled by B's events and is misread as work. Measured on a real
 * 4-developer run: merged idle 818.7 min vs per-shard idle 2,631.5 min, so the
 * merged view loses 69% of the waiting.
 *
 * That mechanism needs OVERLAPPING clones, and it is worth knowing how rare that
 * is. On a 3-shard run whose windows overlap by 0.00h, only 2 of 4,629 adjacent
 * pairs crossed shards and `humanWaitSec` came out identical in both views — the
 * merged/per-shard delta there was not interleaving at all but the park bug (see
 * `presentAt` in classifyGaps). After that fix the merged figure is the LARGER one,
 * by the handover gaps: they stop the team but belong to no individual.
 *
 * So gaps are ALSO classified per shard, and that is the number to trust for
 * "how long did people actually wait" — while merged answers "how long was the team
 * not moving". Neither is a correction of the other.
 */
export interface WorkerSpan {
  /** Shard basename, e.g. "jiho-kim-c02dw4rrmd6r-0c1b20ca004a.md". */
  shard: string;
  /** Human-ish label: the shard name minus the host/clone-id suffix. */
  label: string;
  /**
   * The 12-hex clone id the shard name ends with. Two shards can share it — measured
   * on a real run, `lottes-macbook-pro-local-74726ff984d7` and
   * `80a997205078-74726ff984d7` are the SAME working copy reached under two host
   * identities. `label` throws the id away, so without this the panel counted 3
   * clones (and called them "parallel development") where there were 2 developers.
   */
  cloneId?: string;
  /** True when the shard's last park marker was never closed — it left parked. */
  endedParked: boolean;
  events: number;
  firstTs: string;
  lastTs: string;
  /** First → last event for THIS shard. */
  elapsedSec: number;
  humanWaitSec: number;
  parkedSec: number;
  observedSec: number;
  /**
   * Must be carried here too, or the row does not add up. `classifyGaps` already
   * computes it per shard; dropping it left `사용자 대기 + 중지 + 관측 + 미분류` short of
   * the row's own 구간 by exactly the conversation total — measured 4.72h of 28.38h on
   * one shard, an unexplained hole in a table whose whole point is accounting.
   */
  conversationSec: number;
  unknownSec: number;
  delegatedSec: number;
  /** Compatibility aggregates. */
  idleSec: number;
  agentSec: number;
  workSec: number;
  /** GATE_APPROVED count — identifies who drove the workflow. */
  gatesApproved: number;
  /** STAGE_COMPLETED count. */
  stagesCompleted: number;
  /** Stages this shard touched, most active first. */
  stages: string[];
  /** Units this shard touched (often empty — see the note in model/types.ts). */
  units: string[];
}

export interface TimingReport {
  /** Stages in first-seen (run) order. */
  stages: StageSpan[];
  /**
   * Gap split over the MERGED timeline. Correct for a single-clone run; for a
   * parallel one it under-reports idle (see WorkerSpan). `parallel` below says
   * which case this is.
   */
  total: GapSplit;
  firstTs?: string;
  /**
   * End of the analysed window. For a run with a `WORKFLOW_COMPLETED` this is the
   * last event; for one still open it is the read clock, NOT the last event — see
   * `lastEventTs`.
   */
  lastTs?: string;
  /**
   * Timestamp of the last real event. Distinct from `lastTs` on purpose: an open
   * run's window ends now, so `lastTs` advances on every refresh while nothing
   * happens. A tree copied out of a run mid-flight (or one simply parked) shows
   * exactly that, and reporting only `lastTs` would put a moving date on a record
   * whose last activity is fixed.
   */
  lastEventTs?: string;
  /**
   * `lastTs − lastEventTs`: the stretch with no audit record at all. It is inside
   * `elapsedSec` and outside every `GapSplit` bucket, so `total` + this = the window.
   *
   * That was NOT true when this field was introduced, and the bug is worth keeping
   * on the record: a synthetic `ANALYSIS_NOW` event extended the list handed to
   * `classifyGaps`, so the silence was charged to a bucket second for second —
   * `unknownSec` measured 41.15h at the read and 473.15h eighteen days later, on a
   * ledger that had not changed. The comment here claimed the opposite, and the test
   * that was supposed to protect it passed because its fixture had a single shard,
   * which sent the trailing gap to `parkedSec` instead of the `unknownSec` it
   * asserted on. Classification now runs on real events only.
   */
  sinceLastEventSec: number;
  /** Team wall-clock: first → last event across every shard. */
  elapsedSec: number;
  /**
   * `total` re-cut into `BIN_SEC` slices from the first event to the LAST EVENT, for
   * the time chart. Merged timeline, like `total` and the stage spans — see TimeBin.
   * The silence after the last event gets no bins: it is in no bucket, so every bin
   * there would read zero, and a tree opened months after its last event (the
   * reference fixture: 1,073 bins against 6 recorded) would squeeze the whole run into
   * one edge of the chart. `sinceLastEventSec` carries that stretch instead.
   */
  bins: TimeBin[];
  /** Per-shard timelines, busiest first. One entry for a single-clone run. */
  workers: WorkerSpan[];
  /** True when more than one shard carries events. Says nothing about concurrency. */
  parallel: boolean;
  /**
   * Distinct clone ids among the shards — the count of working copies, which is the
   * closest thing the ledger has to "how many developers". Can be lower than
   * `workers.length` (see `WorkerSpan.cloneId`).
   */
  clones: number;
  /**
   * Σ pairwise overlap of the worker windows. **0 means the clones never worked at
   * the same time** — the run was a sequential handover, not parallel development.
   * Measured on a real 3-shard run: all three pairwise overlaps were 0.00h, while
   * the panel called it 병렬 개발 and reported `parallelism` 0.985 as if the clones
   * had been near-perfectly concurrent.
   */
  overlapSec: number;
  /** Wall-clock inside the window that no shard covers — the handover gaps. */
  handoverSec: number;
  /** Σ per-worker idle. The trustworthy waiting figure. */
  personIdleSec: number;
  /** Σ per-worker work. */
  personWorkSec: number;
  personHumanWaitSec: number;
  personParkedSec: number;
  personObservedSec: number;
  personConversationSec: number;
  personUnknownSec: number;
  /** Σ per-worker elapsed — person-time, not wall-clock. */
  personElapsedSec: number;
  /**
   * personElapsedSec / elapsedSec. Reported ONLY when `overlapSec > 0`, because
   * without overlap it measures nothing about concurrency: with non-overlapping
   * windows it reduces to `1 − handoverSec / elapsedSec`, i.e. how much of the
   * window the shards happen to tile. Measured on a run with zero overlap it read
   * 0.985 — and fell to 0.228 when the same unchanged ledger was read 18 days later,
   * because only the denominator follows the clock.
   */
  parallelism?: number;
}

function secs(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 1000;
}

/**
 * Indices `g` of the gaps `events[g] → events[g + 1]` that lie inside a delegation.
 *
 * DELEGATION IS A WINDOW, NOT AN ADJACENT PAIR. `REVIEW_REQUESTED` is followed by the
 * artifacts the reviewer writes, so the close is several events later: measured, 52 of
 * 61 delegation gaps closed on `ARTIFACT_UPDATED`, leaving an adjacency test to
 * recognise 0.31h of a real 14.4h. So each open is paired with ITS close and every gap
 * in between is marked. An unclosed open marks nothing, so a dangling request cannot
 * swallow the rest of the run.
 *
 * WHAT PAIRS WITH WHAT is the engine's own correlation, because "the next close in the
 * shard" was not one. The 2.11.0 ledger has two delegations:
 *
 *   REVIEW_REQUESTED → REVIEW_COMPLETED   by `Request Id` — the completion must echo it
 *                                         (`completionCarriesVerifiedReview`). A retry
 *                                         re-sends the SAME id and a replacement mints a
 *                                         new one, so the window opens at the LAST request
 *                                         the completion answers: what ran before a retry
 *                                         is not known to have been the reviewer.
 *   MERGE_DISPATCH_INVOKED → _RETURNED | _FALLBACK
 *                                         by `Bolt slug`, the first unconsumed terminal at
 *                                         or after it — the doctor's pairing; the format
 *                                         documents no correlation tag.
 *
 * `SUBAGENT_COMPLETED` closed windows before this, and `SUBAGENT_DISPATCHED`, bare
 * `MERGE_DISPATCH` and `GATE_OPENED` were read as opens — none of the three exists in the
 * 2.11.0 engine, and a subagent completion carries no request it answers. On a run whose
 * Claude Code hook writes one per subagent, the first of them closed a review window
 * long before its `REVIEW_COMPLETED`.
 *
 * Same shard, as before: the reviewer writes in the clone that asked.
 */
function delegationGaps(events: readonly AuditEvent[]): Set<number> {
  const marked = new Set<number>();
  const mark = (from: number, to: number): void => {
    for (let g = from; g < to; g++) marked.add(g);
  };
  const reviews = new Map<string, number>(); // shard \0 request id → last request index
  const merges = new Map<string, number[]>(); // shard \0 bolt slug → open invocations
  events.forEach((e, i) => {
    if (e.event === "REVIEW_REQUESTED" || e.event === "REVIEW_COMPLETED") {
      const id = e.fields["Request Id"];
      if (!id) return;
      const key = `${e.shard}\0${id}`;
      if (e.event === "REVIEW_REQUESTED") reviews.set(key, i);
      else {
        const from = reviews.get(key);
        if (from === undefined) return;
        mark(from, i);
        reviews.delete(key);
      }
    } else if (e.event === "MERGE_DISPATCH_INVOKED" || MERGE_DISPATCH_END.has(e.event)) {
      const slug = e.fields["Bolt slug"];
      if (!slug) return;
      const key = `${e.shard}\0${slug}`;
      const open = merges.get(key) ?? [];
      if (e.event === "MERGE_DISPATCH_INVOKED") merges.set(key, [...open, i]);
      else {
        const from = open.shift();
        if (from !== undefined) mark(from, i);
      }
    }
  });
  return marked;
}

/**
 * Classify the gaps between consecutive events. Exported for tests: the whole
 * IDLE/AGENT/WORK rule is here and checkable from a synthetic event list.
 *
 * `onGap`, when given, is told the bucket of every gap it counts — the one place the
 * time bins read from, so they cannot drift from this rule.
 */
export function classifyGaps(
  events: AuditEvent[],
  onGap?: (from: string, to: string, bucket: GapBucket) => void,
): GapSplit {
  let humanWaitSec = 0;
  let parkedSec = 0;
  let inferredParkSec = 0;
  let observedSec = 0;
  let conversationSec = 0;
  let unknownSec = 0;
  let delegatedSec = 0;
  let parkAnomalies = 0;
  const parkedShards = new Set<string>();
  const unknown: SuspectSpan[] = [];

  // WHICH SHARDS ARE PRESENT AT A GIVEN GAP. A shard's own window spans the gap
  // when it has already written an event and has not yet written its last. A shard
  // that has not started, or has already gone quiet, is ABSENT — not working.
  //
  // Treating absent as working is what broke the park rule. Comparing against the
  // whole ledger's shard set made "every clone is parked" unreachable on a
  // sequential handover: measured on a real 3-shard run whose windows do not
  // overlap at all, the all-parked branch fired for 0 gaps and claimed 0.00h, so
  // the 80.31h the ledger explicitly marks as parked was discarded and the panel
  // instead showed 67.05h inferred from 20 session markers. With presence, the
  // explicit park is counted and a genuinely parallel run still needs every
  // present clone parked before the team counts as stopped.
  const firstIdx = new Map<string, number>();
  const lastIdx = new Map<string, number>();
  events.forEach((event, i) => {
    if (!firstIdx.has(event.shard)) firstIdx.set(event.shard, i);
    lastIdx.set(event.shard, i);
  });
  const presentAt = (i: number): string[] => {
    const out: string[] = [];
    for (const [shard, first] of firstIdx) {
      if (first <= i && (lastIdx.get(shard) ?? -1) >= i + 1) out.push(shard);
    }
    return out;
  };

  const delegatedGaps = delegationGaps(events);

  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i]!;
    const b = events[i + 1]!;
    const gap = secs(a.ts, b.ts);
    if (!Number.isFinite(gap) || gap <= 0) continue;

    if (a.event === "WORKFLOW_PARKED") {
      if (parkedShards.has(a.shard)) parkAnomalies++;
      parkedShards.add(a.shard);
    } else if (a.event === "WORKFLOW_UNPARKED") {
      if (!parkedShards.has(a.shard)) parkAnomalies++;
      parkedShards.delete(a.shard);
    }

    // One parked clone does not mean the team stopped — but every PRESENT clone
    // being parked does.
    const present = presentAt(i);
    const parkedPresent = present.filter((shard) => parkedShards.has(shard));
    let bucket: GapBucket;
    if (present.length > 0 && parkedPresent.length === present.length) {
      parkedSec += gap;
      bucket = "parked";
    } else if (GATE_OPEN.has(a.event) && GATE_CLOSE.has(b.event) && gap >= IDLE_FLOOR_SEC) {
      humanWaitSec += gap;
      bucket = "humanWait";
    } else if (SESSION_RESUME.has(b.event) && gap >= IDLE_FLOOR_SEC) {
      // Old ledgers do not always carry balanced park markers. Keep this
      // conservative fallback visible as inferred pause time.
      parkedSec += gap;
      inferredParkSec += gap;
      bucket = "parked";
    } else if (delegatedGaps.has(i)) {
      delegatedSec += gap;
      observedSec += gap;
      bucket = "observed";
    } else if (a.event === "HUMAN_TURN" && b.event === "HUMAN_TURN" && a.shard === b.shard) {
      // A chat exchange. Same shard is load-bearing: two clones' human turns next to
      // each other in the merged ledger are two developers, not one conversation.
      // No duration floor either — the classification reads the marker, not the clock,
      // so a 3-second exchange is the same phenomenon as a 40-minute one.
      conversationSec += gap;
      bucket = "conversation";
    } else if (gap >= SUSPECT_SEC) {
      unknownSec += gap;
      unknown.push({ seconds: gap, fromEvent: a.event, toEvent: b.event, at: a.ts });
      bucket = "unknown";
    } else {
      observedSec += gap;
      bucket = "observed";
    }
    onGap?.(a.ts, b.ts, bucket);
  }

  const idleSec = humanWaitSec + parkedSec;
  const workSec = observedSec + unknownSec;
  return {
    humanWaitSec,
    parkedSec,
    inferredParkSec,
    observedSec,
    conversationSec,
    unknownSec,
    delegatedSec,
    parkAnomalies,
    unknown,
    idleSec,
    agentSec: delegatedSec,
    workSec,
    suspect: unknown,
  };
}

function emptyWorkload(): Workload {
  return { artifacts: 0, sensors: 0, sensorFailures: 0, delegations: 0, humanTurns: 0 };
}

/**
 * Strip the host and clone-id suffix off a shard filename to get something
 * readable. Shards are named `<host-slug>-<clone12hex>.md`, and the host slug
 * itself usually carries the developer's name (`jiho-kim-c02dw4rrmd6r`), so
 * dropping the trailing two dash-separated tokens leaves the useful part.
 * A name that does not match keeps its basename.
 */
export function shardLabel(shard: string): string {
  const base = shard.endsWith(".md") ? shard.slice(0, -3) : shard;
  // Trailing 12-hex clone id.
  const noClone = base.replace(/-[0-9a-f]{12}$/i, "");
  // Trailing host token, only when it looks like a machine id rather than a name
  // (mixed letters+digits, e.g. "c02dw4rrmd6r"), so "macbook-pro-8-local" stays.
  return noClone.replace(/-(?=[a-z]*\d)[a-z0-9]{8,}$/i, "");
}

/** Rank map entries by count, descending, returning the keys. */
function topKeys(counts: Map<string, number>, limit: number): string[] {
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

/**
 * Classify each shard's events on their OWN timeline. This is the correct way to
 * measure waiting on a parallel run — see WorkerSpan for the measured evidence
 * that the merged view loses most of it.
 */
export function buildWorkers(events: AuditEvent[]): WorkerSpan[] {
  const byShard = new Map<string, AuditEvent[]>();
  for (const e of events) {
    const list = byShard.get(e.shard);
    if (list) list.push(e);
    else byShard.set(e.shard, [e]);
  }

  const out: WorkerSpan[] = [];
  for (const [shard, evs] of byShard) {
    // `events` arrives time-ordered, so each shard's slice is too.
    const split = classifyGaps(evs);
    const stages = new Map<string, number>();
    const units = new Map<string, number>();
    let gatesApproved = 0;
    let stagesCompleted = 0;
    let endedParked = false;
    for (const e of evs) {
      if (e.stage) stages.set(e.stage, (stages.get(e.stage) ?? 0) + 1);
      if (e.unit) units.set(e.unit, (units.get(e.unit) ?? 0) + 1);
      if (e.event === "GATE_APPROVED") gatesApproved++;
      else if (e.event === "STAGE_COMPLETED") stagesCompleted++;
      else if (e.event === "WORKFLOW_PARKED") endedParked = true;
      else if (e.event === "WORKFLOW_UNPARKED") endedParked = false;
    }
    const firstTs = evs[0]!.ts;
    const lastTs = evs[evs.length - 1]!.ts;
    out.push({
      shard,
      label: shardLabel(shard),
      cloneId: /-([0-9a-f]{12})\.md$/.exec(shard)?.[1],
      endedParked,
      events: evs.length,
      firstTs,
      lastTs,
      elapsedSec: secs(firstTs, lastTs),
      humanWaitSec: split.humanWaitSec,
      parkedSec: split.parkedSec,
      observedSec: split.observedSec,
      conversationSec: split.conversationSec,
      unknownSec: split.unknownSec,
      delegatedSec: split.delegatedSec,
      idleSec: split.idleSec,
      agentSec: split.agentSec,
      workSec: split.workSec,
      gatesApproved,
      stagesCompleted,
      stages: topKeys(stages, 4),
      units: topKeys(units, 12),
    });
  }

  return out.sort((a, b) => b.events - a.events);
}

/** The local 00/06/12/18 boundary at or before `ms`. */
function binFloor(ms: number): number {
  const d = new Date(ms);
  d.setHours(d.getHours() - (d.getHours() % (BIN_SEC / 3600)), 0, 0, 0);
  return d.getTime();
}

const BUCKET_FIELD: Record<GapBucket, keyof Omit<TimeBin, "start">> = {
  humanWait: "humanWaitSec",
  parked: "parkedSec",
  observed: "observedSec",
  conversation: "conversationSec",
  unknown: "unknownSec",
};

/**
 * Lay classified gaps onto `BIN_SEC` bins covering `firstTs`…`endTs`. A gap crossing a
 * bin edge is split by overlap — never assigned whole to the bin it starts in, which
 * would pile a 30-hour park into one bar.
 */
export function buildBins(
  gaps: { from: string; to: string; bucket: GapBucket }[],
  firstTs: string,
  endTs: string,
): TimeBin[] {
  const start = binFloor(Date.parse(firstTs));
  const end = Date.parse(endTs);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const width = BIN_SEC * 1000;
  const bins: TimeBin[] = [];
  // Fixed-width steps from a local boundary: a DST change shifts later labels by an
  // hour instead of producing a 5h or 7h bin, which would skew the bars it holds.
  for (let at = start; at < end || bins.length === 0; at += width) {
    bins.push({
      start: new Date(at).toISOString(),
      humanWaitSec: 0,
      parkedSec: 0,
      observedSec: 0,
      conversationSec: 0,
      unknownSec: 0,
    });
  }
  for (const g of gaps) {
    const from = Date.parse(g.from);
    const to = Date.parse(g.to);
    const field = BUCKET_FIELD[g.bucket];
    const first = Math.max(0, Math.floor((from - start) / width));
    for (let k = first; k < bins.length; k++) {
      const lo = Math.max(from, start + k * width);
      const hi = Math.min(to, start + (k + 1) * width);
      if (hi <= lo) break;
      (bins[k] as TimeBin)[field] += (hi - lo) / 1000;
    }
  }
  return bins;
}

/**
 * Derive per-stage spans and the whole-run split from the ledger.
 *
 * A stage's start is its FIRST STAGE_STARTED (a backward jump re-enters a stage;
 * keeping the first start means the span covers the rework rather than hiding
 * it). Its end is the LAST COMPLETED, else the last AWAITING_APPROVAL, else the
 * ledger's final event for a stage still running.
 */
export function buildTiming(ledger: AuditLedger, nowTs?: string): TimingReport {
  if (ledger.events.length === 0) {
    return {
      stages: [],
      total: classifyGaps([]),
      sinceLastEventSec: 0,
      elapsedSec: 0,
      bins: [],
      workers: [],
      parallel: false,
      clones: 0,
      overlapSec: 0,
      handoverSec: 0,
      personIdleSec: 0,
      personWorkSec: 0,
      personHumanWaitSec: 0,
      personParkedSec: 0,
      personObservedSec: 0,
      personConversationSec: 0,
      personUnknownSec: 0,
      personElapsedSec: 0,
    };
  }

  const all = ledger.events;
  const startIndex = all.findIndex((e) => e.event === "WORKFLOW_STARTED");
  const from = startIndex >= 0 ? startIndex : 0;
  const completedIndex = all.findLastIndex((e, i) => i >= from && e.event === "WORKFLOW_COMPLETED");
  const actual = all.slice(from, completedIndex >= 0 ? completedIndex + 1 : undefined);
  const firstTs = actual[0]!.ts;
  const lastActualTs = actual[actual.length - 1]!.ts;
  const requestedEnd = completedIndex >= 0 ? lastActualTs : (nowTs ?? lastActualTs);
  // The WINDOW may end at the read clock, but nothing is CLASSIFIED past the last
  // event. A synthetic `ANALYSIS_NOW` event used to be appended here and handed to
  // `classifyGaps`, which charged the silence since the last event to a bucket at
  // one second per second — measured, `unknownSec` grew from 41.15h to 473.15h over
  // 18 days of not reading, and the synthetic event name leaked into the on-screen
  // suspect list as `HUMAN_TURN → ANALYSIS_NOW`. Every classification below now runs
  // on `actual`, and the trailing silence is reported once, as `sinceLastEventSec`.
  const endTs = Date.parse(requestedEnd) >= Date.parse(lastActualTs) ? requestedEnd : lastActualTs;

  interface OpenStage {
    startedAt: string;
    awaiting: boolean;
  }
  interface RawSegment {
    startedAt: string;
    endedAt: string;
    endKind: StageEndKind;
  }

  const open = new Map<string, OpenStage>();
  const raw = new Map<string, RawSegment[]>();
  const finalKind = new Map<string, StageEndKind>();
  const order: string[] = [];

  const close = (stage: string, endedAt: string, endKind: StageEndKind): void => {
    const current = open.get(stage);
    if (!current) return;
    const list = raw.get(stage) ?? [];
    list.push({ startedAt: current.startedAt, endedAt, endKind });
    raw.set(stage, list);
    open.delete(stage);
    finalKind.set(stage, endKind);
  };

  for (const e of actual) {
    const stage = e.stage;
    if (!stage) continue;
    if (!order.includes(stage)) order.push(stage);

    if (e.event === "STAGE_STARTED") {
      // A repeated start is a real re-entry. Close the still-open entry at the new
      // boundary rather than stretching one bar across unrelated work — and mark it
      // superseded, because whatever state it was in, it is over.
      close(stage, e.ts, "superseded");
      open.set(stage, { startedAt: e.ts, awaiting: false });
    } else if (e.event === "STAGE_COMPLETED") {
      close(stage, e.ts, "completed");
    } else if (e.event === "STAGE_SKIPPED") {
      close(stage, e.ts, "skipped");
    } else if (e.event === "STAGE_AWAITING_APPROVAL") {
      const current = open.get(stage);
      if (current) current.awaiting = true;
    }
  }

  for (const [stage, current] of open) {
    // An unfinished stage ends at its last event, NOT at the read clock: otherwise its
    // bar and elapsed grow every poll while nothing happens (and the growth used to
    // land in its `unknownSec`, measured 7,620s → 94,020s over 24h of not reading).
    close(stage, lastActualTs, current.awaiting ? "awaiting-approval" : "in-flight");
  }

  const stages: StageSpan[] = [];

  for (const stage of order) {
    const stageSegments = raw.get(stage);
    if (!stageSegments?.length) continue;

    const segments: StageSegment[] = stageSegments.map((segment) => {
      const within = actual.filter((e) => e.ts >= segment.startedAt && e.ts <= segment.endedAt);
      const split = classifyGaps(within);
      return {
        ...segment,
        ...split,
        elapsedSec: secs(segment.startedAt, segment.endedAt),
      };
    });
    const sum = (pick: (segment: StageSegment) => number): number =>
      segments.reduce((n, segment) => n + pick(segment), 0);

    const workload = emptyWorkload();
    for (const e of actual) {
      if (e.stage !== stage) continue;
      if (e.event === "ARTIFACT_CREATED" || e.event === "ARTIFACT_UPDATED") workload.artifacts++;
      else if (e.event === "SENSOR_FIRED") workload.sensors++;
      else if (e.event === "SENSOR_FAILED") workload.sensorFailures++;
      else if (e.event === "REVIEW_COMPLETED") workload.delegations++;
    }
    for (const segment of stageSegments) {
      workload.humanTurns += actual.filter(
        (e) => e.event === "HUMAN_TURN" && e.ts >= segment.startedAt && e.ts <= segment.endedAt,
      ).length;
    }

    const humanWaitSec = sum((s) => s.humanWaitSec);
    const parkedSec = sum((s) => s.parkedSec);
    const observedSec = sum((s) => s.observedSec);
    const conversationSec = sum((s) => s.conversationSec);
    const unknownSec = sum((s) => s.unknownSec);
    const delegatedSec = sum((s) => s.delegatedSec);
    const unknown = segments.flatMap((s) => s.unknown);
    const idleSec = humanWaitSec + parkedSec;
    const workSec = observedSec + unknownSec;

    stages.push({
      stage,
      startedAt: segments[0]!.startedAt,
      endedAt: segments[segments.length - 1]!.endedAt,
      endKind: finalKind.get(stage) ?? "in-flight",
      elapsedSec: sum((s) => s.elapsedSec),
      segments,
      humanWaitSec,
      parkedSec,
      inferredParkSec: sum((s) => s.inferredParkSec),
      observedSec,
      conversationSec,
      unknownSec,
      delegatedSec,
      parkAnomalies: sum((s) => s.parkAnomalies),
      unknown,
      idleSec,
      agentSec: delegatedSec,
      workSec,
      suspect: unknown,
      workload,
    });
  }

  const workers = buildWorkers(actual);
  const elapsedSec = secs(firstTs, endTs);
  const personElapsedSec = workers.reduce((n, w) => n + w.elapsedSec, 0);

  // Did the clones ever work at the same time? Σ pairwise overlap answers it from
  // the windows alone; the union answers how much of the run any clone covered, and
  // what is left over is handover.
  let overlapSec = 0;
  for (let i = 0; i < workers.length; i++) {
    for (let j = i + 1; j < workers.length; j++) {
      const a = workers[i]!;
      const b = workers[j]!;
      const from = Math.max(Date.parse(a.firstTs), Date.parse(b.firstTs));
      const to = Math.min(Date.parse(a.lastTs), Date.parse(b.lastTs));
      if (to > from) overlapSec += (to - from) / 1000;
    }
  }
  const spans = workers
    .map((w) => ({ from: Date.parse(w.firstTs), to: Date.parse(w.lastTs) }))
    .sort((a, b) => a.from - b.from);
  let coveredSec = 0;
  let cursor = Number.NEGATIVE_INFINITY;
  for (const s of spans) {
    const from = Math.max(s.from, cursor);
    if (s.to > from) {
      coveredSec += (s.to - from) / 1000;
      cursor = s.to;
    }
  }
  const lastEventSpanSec = secs(firstTs, lastActualTs);
  const handoverSec = Math.max(0, lastEventSpanSec - coveredSec);

  const gaps: { from: string; to: string; bucket: GapBucket }[] = [];
  const total = classifyGaps(actual, (from, to, bucket) => gaps.push({ from, to, bucket }));

  return {
    stages,
    total,
    firstTs,
    lastTs: endTs,
    lastEventTs: lastActualTs,
    sinceLastEventSec: Math.max(0, secs(lastActualTs, endTs)),
    elapsedSec,
    bins: buildBins(gaps, firstTs, lastActualTs),
    workers,
    parallel: workers.length > 1,
    clones: new Set(workers.map((w) => w.cloneId ?? w.shard)).size,
    overlapSec,
    handoverSec,
    personIdleSec: workers.reduce((n, w) => n + w.idleSec, 0),
    personWorkSec: workers.reduce((n, w) => n + w.workSec, 0),
    personHumanWaitSec: workers.reduce((n, w) => n + w.humanWaitSec, 0),
    personParkedSec: workers.reduce((n, w) => n + w.parkedSec, 0),
    personObservedSec: workers.reduce((n, w) => n + w.observedSec, 0),
    personConversationSec: workers.reduce((n, w) => n + w.conversationSec, 0),
    personUnknownSec: workers.reduce((n, w) => n + w.unknownSec, 0),
    personElapsedSec,
    // Only meaningful when the clones actually overlap — see the field's doc.
    parallelism: elapsedSec > 0 && overlapSec > 0 ? personElapsedSec / elapsedSec : undefined,
  };
}
