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
//   - REVISING: a `[R]` row — the person rejected the gate and the stage is being
//     reworked. Shown, not counted: the next move is the run's, not the person's.
//   - PARKED: `Parked` + `Parked At Stage` in `## Runtime State`, valid only while
//     `Parked At Stage` is still the Current Stage — a park the run has moved past
//     is a leftover. `Parked By: person` (2.11) marks one a person set.
//   - UNIT PAUSED: `Unit State: paused`, with the engine's own reason and next action.
//   - ENGINE ASK: a current `active-directive.json` of kind `ask` — 2.11 holds ten
//     kinds of question there and writes a questions file for only one of them
//     (plan approval), so without the marker nine of them are invisible.
//   - ENGINE-ONLY BLANK: the stop hook's raw test (`rawBlank`) on the active stage's
//     own questions files, when no ask this dashboard reads explains it — a fenced
//     example, a placeholder answered elsewhere. A diagnostic, not a count: what it
//     proves is that the hook may let the turn end there, not that a person owes an
//     answer.
//
// Read-only, never throws.

import type { AuditEvent } from "../scan/audit";
import { pendingGate } from "../scan/gate-wait";
import type { AidlcState } from "../scan/parser";
import type { QuestionsReport } from "../scan/questions";
import type { DirectiveMarker, MarkerMiss, RunPosition } from "../scan/run-position";

export interface Waits {
  position: RunPosition;
  /** The Current Stage's gate is open (row `[?]`); `since` from the audit when it says. */
  gate?: { stage: string; since?: string };
  /** The Current Stage row is `[R]`. */
  revising?: string;
  parked?: { stage: string; since: string; byPerson: boolean };
  unitPaused?: { unit: string; stage?: string; reason: string; nextAction: string };
  /** `askType` is absent on 2.10's untyped ask. */
  engineAsk?: { askType?: string; stage: string; unit?: string };
  /** Record-relative paths — see ENGINE-ONLY BLANK above. */
  engineOnly: string[];
  /** `Construction Autonomy Mode: autonomous` — the stop hook's cap and rules differ. */
  autonomous: boolean;
}

export interface WaitsInput {
  state: AidlcState;
  position: RunPosition;
  marker: { marker: DirectiveMarker } | { miss: MarkerMiss };
  events: AuditEvent[];
  questions: QuestionsReport;
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
  const rows = current ? rowStatuses(state, current) : [];
  const autonomous = rt.autonomyMode === "autonomous";
  const marker = "marker" in w.marker ? w.marker.marker : undefined;

  const gate =
    current && rows.includes("awaiting")
      ? { stage: current, since: pendingGate(w.events, current)?.since }
      : undefined;
  const revising = current && rows.includes("revising") ? current : undefined;

  const parkedHere = rt.parked !== "" && rt.parkedAtStage !== "" && rt.parkedAtStage === current;
  const parked = parkedHere
    ? { stage: rt.parkedAtStage, since: rt.parked, byPerson: rt.parkedBy === "person" }
    : undefined;

  const unitPaused =
    rt.unitState === "paused" && rt.activeUnit
      ? {
          unit: rt.activeUnit,
          stage: rt.unitStage || undefined,
          reason: rt.unitPauseReason,
          nextAction: rt.unitNextAction,
        }
      : undefined;

  // A plan-approval ask also writes the questions file the blocker list already shows.
  const askedInFile = (stage: string, unit?: string) =>
    w.questions.files.some(
      (f) =>
        f.stage === stage && (unit === undefined || f.unit === unit) && f.unanswered.length > 0,
    );
  const engineAsk =
    marker?.kind === "ask" &&
    !(marker.askType === "plan-approval" && askedInFile(marker.stage, marker.unit)) &&
    // A paused unit is already its own row.
    !(marker.askType === "unit-paused" && unitPaused)
      ? { askType: marker.askType, stage: marker.stage, unit: marker.unit }
      : undefined;

  // The stop hook reads the active stage's own files only while its row is `[-]`, and
  // under autonomy only a pending plan approval — which the blocker list reads already.
  const engineOnly =
    position.stage && !autonomous && rows.includes("active")
      ? w.questions.files
          .filter(
            (f) =>
              f.rawBlank &&
              f.unanswered.length === 0 &&
              inActiveDir(f.rel, position.stage ?? "", position.unit),
          )
          .map((f) => f.rel)
      : [];

  return { position, gate, revising, parked, unitPaused, engineAsk, engineOnly, autonomous };
}
