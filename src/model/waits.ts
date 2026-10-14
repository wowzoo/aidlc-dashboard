// What the run is held on besides an unanswered question — and where it is.
//
// The status strip used to answer "is anything waiting on you" from two things:
// blank `[Answer]:` tags in the stage `Current Stage` names, and an approval the
// audit had seen asked but not yet seen the stage move past. Both were read against
// the wrong stage under unit-major (see scan/run-position.ts), the gate stayed
// "awaiting" after it was answered, and four other ways the engine holds a run for a
// person were not read at all. Each reading below names the engine source it
// mirrors, because "waiting on you" is a claim the page makes on the engine's
// behalf.
//
//   - GATE: the engine treats the run as waiting on a person when the Current Stage
//     row is `[?]` (aidlc-continue-workflow.ts `isHumanWaitStop`). The row is the
//     authority; the audit (`pendingOrganicGate`, scan/gate-wait.ts) only says since
//     when. An audit-open gate on a row that is not `[?]` is a stale stamp.
//   - TEAM UNIT GATE: under team ownership the engine reads a unit's gate from the
//     audit by unit, gate scope and CLAIM ATTEMPT (`unitGateStatus`) and never moves
//     the global row to `[?]`; `isHumanWaitStop` asks it first, for the active stage
//     and unit at `effectiveUnitGateRhythm`'s scope. Read here the same way
//     (scan/team-gate.ts, the claim filter in scan/claim-attempt.ts): an open one
//     counts like the stage gate, a revising one is shown like `[R]`. Where the claim
//     attempt cannot be resolved (an intent registry the engine would throw on) it is
//     said to be unread, never an absent `[?]` read as "nothing waiting". The active
//     stage and unit are the hook's own probe, so the scope follows the decision's.
//   - REVISING: a `[R]` row — the person rejected the gate. The hook's own comment
//     says the row covers both asking the person what to change and the rework, so it
//     is shown, not counted, and the copy does not say whose move it is.
//   - PARKED: `Parked` + `Parked At Stage` in `## Runtime State`, valid only while
//     `Parked At Stage` is still the Current Stage — a park the run has moved past
//     is a leftover. `Parked By: person` (2.11) marks one a person set.
//     A current marker of kind `parked` is the engine's own park directive and counts
//     too — it covers the checkout-local park (`aidlc/.aidlc-unit-parked`), which the
//     state does not record. That file alone is shown but not counted: whether it
//     applies to this intent is decided by a scope stamp this reader does not check.
//   - UNIT PAUSED: `Unit State: paused`, with the engine's own reason and next action.
//     The engine's hold on it is its `unit-paused` ask, which only the per-unit routers
//     issue — each after its stage-level return (aidlc-orchestrate.ts) — so at stage
//     level a paused unit holds nothing: it is a leftover of an earlier plan, said as
//     one (`unitCacheLeftover`) and not counted.
//   - ENGINE ASK: a current `active-directive.json` of kind `ask` — 2.11 holds ten
//     kinds of question there and writes a questions file for only one of them
//     (plan approval), so without the marker nine of them are invisible. A current
//     marker is not proof the ask is still open, so two answered shapes are dropped:
//     a plan approval whose questions file already holds the section (the blocker
//     list reads it, answered or not), and a guard-recovery ask whose response is
//     `ready`. `delivery` is not read as "shown to the person" — ordinary publication
//     leaves `issued`.
//   - ENGINE-ONLY BLANK: the stop hook's raw test (`rawBlank`) on the active stage's
//     own questions files, when no ask this dashboard reads explains it — a fenced
//     example, a placeholder answered elsewhere. A diagnostic, not a count: what it
//     proves is that the hook may let the turn end there, not that a person owes an
//     answer. The hook reads them only while the Current Stage row is `[-]` — except
//     for a team unit-major directive, where it skips that row check.
//   - OPEN DECISION: an ask opened through the audit (`DECISION_RECORDED`) that no
//     receipt has closed — learnings, "Anything to add?", a Construction Unit or
//     Swarm Batch Approval (scan/decision-wait.ts). Read under the stop hook's own
//     preconditions (`isPendingDecisionStop`): not under autonomy; the Current Stage
//     row `[-]` unless a team unit-major directive; a stage running ahead of Current
//     Stage read in attempt mode first.
//   - COMPOSE: `aidlc/.aidlc-compose-pending` younger than 24 hours, not under
//     autonomy (`isPendingComposeStop`) — the composer's approve/edit/reject gate,
//     which has no checkbox of its own.
//   - TURN ENDED: `.aidlc-engine/turn-end` newer than `human-turn` (`turnEndIsOpen`,
//     2.11): the engine's last word was a question or a print the agent stops after.
//     Shown, not counted — it says the next message is the person's, not that a
//     question is owed; the question, when there is one, is the engine ask above.
//   - HOOKS: the newest hook heartbeat against the newest STAGE_/GATE_ row
//     (`hookLiveness`): more than five minutes behind is stale, none at all is never
//     fired. 2.11 refuses a plan approval in that state, so it is said next to the
//     asks, not counted among them.
//
// Read-only, never throws.

import type { AuditEvent } from "../scan/audit";
import type { ClaimFilter } from "../scan/claim-attempt";
import { type OpenDecision, openDecision, openDecisionInAttempt } from "../scan/decision-wait";
import { pendingGate } from "../scan/gate-wait";
import type { AidlcState } from "../scan/parser";
import type { QuestionsReport } from "../scan/questions";
import type { DirectiveMarker, MarkerMiss, RunPosition } from "../scan/run-position";
import { unitGateStatus } from "../scan/team-gate";
import type { Blocker } from "./types";

export interface Waits {
  position: RunPosition;
  /** The Current Stage's gate is open (row `[?]`); `since` from the audit when it says. */
  gate?: { stage: string; since?: string };
  /** The Current Stage row is `[R]`. */
  revising?: string;
  parked?: { stage: string; since: string; byPerson: boolean };
  unitPaused?: { unit: string; stage?: string; reason: string; nextAction: string };
  /**
   * At stage level, the unit cache the state still carries. The engine writes none in
   * this mode and asks about none, so it is shown as a leftover and never counted.
   */
  unitCacheLeftover?: { unit: string; stage?: string; paused: boolean };
  /** `askType` absent = a marker that carried none (2.11 always writes one). */
  engineAsk?: { askType?: string; stage: string; unit?: string };
  /** `aidlc/.aidlc-unit-parked` exists in this checkout — applicability unchecked. */
  checkoutPark: boolean;
  /**
   * Team ownership: the active unit's own gate (`unitGateStatus`), as the stop hook reads it
   * before the state row — only an open (`awaiting-approval`) or `revising` one is carried.
   * `scopeVerified` as on `decision`: the stage and unit came from a current marker.
   */
  teamGate?: {
    stage: string;
    unit: string;
    status: "awaiting-approval" | "revising";
    scopeVerified: boolean;
  };
  /** Team ownership with a unit position whose gate this reader could not decide. */
  teamGateUnread: boolean;
  /**
   * The stop-hook record names the state it blocked on (the signature's digest) and that
   * state is not the current one — the count is history, whatever its size.
   */
  guardRecordStale: boolean;
  /** Record-relative paths — see ENGINE-ONLY BLANK above. */
  engineOnly: string[];
  /** `Construction Autonomy Mode: autonomous` — the stop hook's cap and rules differ. */
  autonomous: boolean;
  decision?: OpenDecision;
  /** The compose marker's mtime, when it is fresh. */
  compose?: { since: string };
  turnEnded: boolean;
  hooks: HookLiveness;
}

/** `hookLiveness`, reduced to the verdict and the two times it compares. */
export type HookLiveness =
  | { state: "live" | "unknown" }
  | { state: "stale"; heartbeat: string; event: string }
  | { state: "never"; event: string };

export interface WaitsInput {
  state: AidlcState;
  position: RunPosition;
  /**
   * Under team ownership (`isTeamUnitOwnership`): the checkout's claim filter and the gate
   * scope `effectiveUnitGateRhythm` gives (`unknown` when the stamp's applicability cannot
   * be read). Absent outside team ownership.
   */
  teamGate?: { claim: ClaimFilter; scope: "per-stage" | "unit-end" | "unknown" };
  marker: { marker: DirectiveMarker } | { miss: MarkerMiss };
  events: AuditEvent[];
  questions: QuestionsReport;
  /** The blocker list, already classified current/earlier — for the plan-approval dedup. */
  blockers: Blocker[];
  checkoutParkFile: boolean;
  /** The block-count signature, and the digest of the current state. */
  guard?: { signature: string; stateDigest: string };
  /** Every `*.last` file, as `hookLiveness` reads them (scan/hooks-health.ts). */
  hookHeartbeats: { present: boolean; stamps: string[] };
  /** mtimes (ms) of the engine's turn markers and the compose marker, when present. */
  marks: { turnEnd?: number; humanTurn?: number; compose?: number };
  /** The read clock, ISO. */
  now: string;
  /** Catalogue stage order, for `stageJumpReaches`. */
  stageIndex?: (slug: string) => number;
  /**
   * The plan runs per-unit stages at stage level (scan/unit-artifact-mode.ts): there is
   * no unit to pause, gate or scope a decision by.
   */
  stageLevel?: boolean;
}

/** The engine's `PLAN_APPROVAL_CHECKPOINT` (aidlc-testing-posture.ts), matched exactly. */
const PLAN_APPROVAL_CHECKPOINT = "Code Generation Plan Approval";
/** The engine's `HOOK_HEARTBEAT_STALE_SLACK_MS`. */
const HOOK_STALE_MS = 5 * 60 * 1000;
/** The engine's `COMPOSE_MARKER_TTL_MS`. */
const COMPOSE_TTL_MS = 24 * 60 * 60 * 1000;

function hookLiveness(
  heartbeats: { present: boolean; stamps: string[] },
  events: AuditEvent[],
): HookLiveness {
  const newest = (xs: string[]) =>
    xs.reduce<string | undefined>(
      (m, x) => (m === undefined || Date.parse(x) > Date.parse(m) ? x : m),
      undefined,
    );
  const event = newest(
    events
      .filter(
        (e) =>
          (e.event.startsWith("STAGE_") || e.event.startsWith("GATE_")) &&
          Number.isFinite(Date.parse(e.ts)),
      )
      .map((e) => e.ts),
  );
  if (!event) return { state: "unknown" };
  // The engine's `neverFired`: no `.last` file at all — an empty one still counts.
  if (!heartbeats.present) return { state: "never", event };
  const heartbeat = newest(heartbeats.stamps);
  if (!heartbeat) return { state: "unknown" };
  return Date.parse(event) - Date.parse(heartbeat) > HOOK_STALE_MS
    ? { state: "stale", heartbeat, event }
    : { state: "live" };
}

function rowStatuses(state: AidlcState, slug: string): string[] {
  return state.phases.flatMap((p) => p.stages.filter((s) => s.slug === slug).map((s) => s.status));
}

/** Is this questions file one of the active stage's own — the dir the stop hook reads? */
function inActiveDir(rel: string, stage: string, unit: string | undefined): boolean {
  const parts = rel.split("/");
  if (unit)
    return (
      parts.length === 4 && parts[0] === "construction" && parts[1] === unit && parts[2] === stage
    );
  return parts.length === 3 && parts[1] === stage;
}

export function buildWaits(w: WaitsInput): Waits {
  const { state, position } = w;
  const rt = state.runtime;
  const current =
    state.currentStage && state.currentStage !== "none" ? state.currentStage : undefined;
  // The engine reads the FIRST row of the Current Stage's slug (`parseCheckboxes(…)
  // .find`), so a later `[-]` row of the same slug does not make it in progress.
  const row = current ? rowStatuses(state, current)[0] : undefined;
  const autonomous = rt.autonomyMode === "autonomous";
  const marker = "marker" in w.marker ? w.marker.marker : undefined;

  const gate =
    current && row === "awaiting"
      ? { stage: current, since: pendingGate(w.events, current)?.since }
      : undefined;
  const revising = current && row === "revising" ? current : undefined;

  const parkedHere = rt.parked !== "" && rt.parkedAtStage !== "" && rt.parkedAtStage === current;
  const parked = parkedHere
    ? { stage: rt.parkedAtStage, since: rt.parked, byPerson: rt.parkedBy === "person" }
    : marker?.kind === "parked"
      ? { stage: marker.stage, since: "", byPerson: false }
      : undefined;

  const stageLevel = w.stageLevel === true;
  const unitPaused =
    !stageLevel && rt.unitState === "paused" && rt.activeUnit
      ? {
          unit: rt.activeUnit,
          stage: rt.unitStage || undefined,
          reason: rt.unitPauseReason,
          nextAction: rt.unitNextAction,
        }
      : undefined;

  // A plan-approval ask also writes the questions file the blocker list reads — so a
  // file holding the section, answered or not, is that ask; only one with no file is
  // the marker's alone.
  const planInFile = (stage: string, unit?: string) =>
    w.questions.files.some(
      (f) =>
        f.stage === stage &&
        f.unit === unit &&
        f.questions.some((q) => q.kind === "confirmation" && /plan approval/i.test(q.heading)),
    );
  const unitCacheLeftover =
    stageLevel && rt.activeUnit
      ? {
          unit: rt.activeUnit,
          ...(rt.unitStage ? { stage: rt.unitStage } : {}),
          paused: rt.unitState === "paused",
        }
      : undefined;

  const answered =
    (marker?.askType === "plan-approval" && planInFile(marker.stage, marker.unit)) ||
    (marker?.askType === "guard-recovery" && marker.guardRecovery === "ready") ||
    // The same paused unit is already its own row.
    (marker?.askType === "unit-paused" && unitPaused?.unit === marker.unit);
  const engineAsk =
    marker?.kind === "ask" && !answered
      ? { askType: marker.askType, stage: marker.stage, unit: marker.unit }
      : undefined;

  // The stop hook reads the active stage's own files only while its row is `[-]` (a
  // team unit-major directive skips that check), and under autonomy only a pending
  // plan approval — which the blocker list reads already.
  const team = state.unitOwnership === "team";
  const teamUnitMajor = team && state.constructionIteration === "unit-major" && !!position.unit;
  const engineOnly =
    position.stage && !autonomous && (teamUnitMajor || row === "active")
      ? w.questions.files
          .filter(
            (f) =>
              f.rawBlank &&
              f.unanswered.length === 0 &&
              inActiveDir(f.rel, position.stage ?? "", position.unit),
          )
          .map((f) => f.rel)
      : [];

  // The 2.11 signature is `<stage>::<state digest>::<directive fingerprint>`; one in any
  // other shape carries no digest to compare, so it is not dated this way.
  const sigDigest = w.guard?.signature.split("::")[1];
  const guardRecordStale =
    !!w.guard &&
    !!sigDigest &&
    /^[0-9a-f]{64}$/.test(sigDigest) &&
    sigDigest !== w.guard.stateDigest;

  // Open decision, under `isPendingDecisionStop`'s own preconditions. The hook's
  // `activeStage`/`activeUnit` come from its own fresh `next` probe, and the nearest
  // record of that is a current directive marker; the unit cache is a mirror the
  // engine keeps for cheap status reads, so a decision scoped by it alone is said to be
  // unconfirmed rather than claimed as the hook's.
  // At stage level too: the hook's `directive.unit ?? activeMarker.unit` lets a stage-level
  // probe's null unit fall through to the marker's, so the marker scopes the decision as
  // it does per unit. The unit cache is what stage level drops, and it reaches here only
  // through `position` (scan/run-position.ts).
  const scope = marker
    ? { stage: marker.stage, unit: marker.unit }
    : { stage: position.stage, unit: position.unit };
  const scopeVerified = !!marker || (position.basis === "current-stage" && position.verified);
  const teamScope = team && state.constructionIteration === "unit-major" && !!scope.unit;
  let decision: OpenDecision | undefined;
  if (!autonomous) {
    if (teamScope && scope.stage) {
      decision = openDecisionInAttempt(w.events, scope.stage, scope.unit, w.stageIndex);
    } else if (current && row === "active") {
      const ahead = scope.stage;
      if (ahead && ahead !== current)
        decision = openDecisionInAttempt(w.events, ahead, undefined, w.stageIndex);
      decision ??= openDecision(w.events, current);
    }
  }
  // A plan approval asked through a decision (the legacy picker path, one unit or a
  // batch) also has its section in each unit's file. It is the same interaction only
  // where that section is a blank ask ALREADY COUNTED as current — a file of another
  // unit, or one only listed as an earlier leftover, is not a duplicate of it.
  if (decision && decision.checkpoint === PLAN_APPROVAL_CHECKPOINT) {
    const units = decision.unit ? [decision.unit] : (decision.units ?? []);
    const counted = w.blockers.some(
      (b) =>
        b.isCurrentStage &&
        b.stage === decision?.stage &&
        b.kind === "confirmation" &&
        /plan approval/i.test(b.heading) &&
        (units.length === 0
          ? b.unit === undefined
          : b.unit !== undefined && units.includes(b.unit)),
    );
    if (counted) decision = undefined;
  }
  if (decision) decision = { ...decision, scopeVerified };

  // Team unit gate, as `isHumanWaitStop` reads it first: the active stage and unit, at the
  // effective gate scope. Its `activeStage`/`activeUnit` are the hook's own probe
  // (`directive.unit ?? marker.unit`), so the scope follows the decision's — a current
  // marker, else the unit cache, unconfirmed. At stage level `position` already holds no
  // cached unit (the router returns before team unit routing, so only a marker names one);
  // and a cache unit off the resolved roster is not where the engine is, so no gate is
  // read for it.
  const cacheOffRoster = !marker && !!position.offRoster;
  let teamGate: Waits["teamGate"];
  let teamGateUnread = false;
  if (w.teamGate && scope.stage && scope.unit && !cacheOffRoster) {
    const status =
      w.teamGate.scope === "unknown"
        ? "unknown"
        : unitGateStatus(
            w.events,
            scope.stage,
            scope.unit,
            w.teamGate.scope,
            w.teamGate.claim,
            w.stageIndex,
          );
    if (status === "unknown") teamGateUnread = true;
    else if (status === "awaiting-approval" || status === "revising") {
      teamGate = { stage: scope.stage, unit: scope.unit, status, scopeVerified };
    }
  }

  const nowMs = Date.parse(w.now);
  const compose =
    !autonomous &&
    w.marks.compose !== undefined &&
    Number.isFinite(w.marks.compose) &&
    nowMs - w.marks.compose <= COMPOSE_TTL_MS
      ? { since: new Date(w.marks.compose).toISOString().replace(/\.\d{3}Z$/, "Z") }
      : undefined;
  const turnEnded =
    w.marks.turnEnd !== undefined &&
    w.marks.humanTurn !== undefined &&
    w.marks.turnEnd > w.marks.humanTurn;

  return {
    position,
    decision,
    compose,
    turnEnded,
    hooks: hookLiveness(w.hookHeartbeats, w.events),
    gate,
    revising,
    parked,
    unitPaused,
    ...(unitCacheLeftover ? { unitCacheLeftover } : {}),
    engineAsk,
    engineOnly,
    autonomous,
    checkoutPark: w.checkoutParkFile && !parked,
    teamGate,
    teamGateUnread,
    guardRecordStale,
  };
}
