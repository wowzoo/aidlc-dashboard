// English copy.
//
// English is here as a LINGUA FRANCA, not as a locale: the audience splits Korean /
// non-Korean, so the target is plain and unambiguous rather than idiomatic for any
// region. Two consequences worth keeping in mind while editing:
//
//   - The Korean side is calibrated against real run trees and carries the measured
//     reasoning (see CLAUDE.md). Translate the CLAIM, not the sentence shape — where the
//     reasoning behind a line is already written in English in this repo's module
//     headers, that wording is the better source than the Korean rendering of it.
//   - Engine vocabulary stays as the engine writes it. `stage`, `unit`, `UNIT_COMPLETED`,
//     `Run floor`, `state.md`, `stage-graph.json` are identifiers a reader will grep for,
//     so they are never localised on either side.

import type { ReceiptReason } from "../scan/matrix";
import type {
  BlockerStrings,
  CardStrings,
  CliStrings,
  DeferralStrings,
  ErrorPageStrings,
  ExplorerStrings,
  FreshnessStrings,
  HealthStrings,
  KpiStrings,
  OpenFileStrings,
  OverviewStrings,
  PageStrings,
  PickerStrings,
  StatusStrings,
  Strings,
  TimelineStrings,
  UsageStrings,
  ViewerStrings,
  WarnStrings,
} from "./i18n";
/** What each `unverified` cause means — each one the engine could settle either way. */
const RECEIPT_REASON_EN: Record<ReceiptReason, string> = {
  "team-claim":
    "Every artifact is present, and the completion receipt is settled by the claim file (team ownership) — the audit ledger alone cannot say whether the engine considers this done. The Unit Progress table above is the authority",
  "team-claim-skip":
    "A skip is recorded for this unit (UNIT_SKIPPED), but under team ownership the engine reads only rows matching the claim attempt (Attempt Generation, scope stamp) — the audit ledger alone cannot say whether the engine counts it skipped",
  "wave-fingerprint":
    "Every artifact is present, and the completion receipt is settled by an artifact fingerprint (wave mode) — the audit ledger alone cannot say whether the engine considers this done",
  "ambiguous-floor":
    "Every artifact is present, but boundary events from different clones share a timestamp, so the attempt floor cannot be reproduced — the audit ledger alone cannot say whether the engine considers this done",
};

const warn: WarnStrings = {
  catalogReadFailed: (harnessDir) =>
    `Could not read ${harnessDir}/tools/data/stage-graph.json — artifact-contract judgements and stage attribution fall back to approximations`,

  catalogNotFound:
    "No stage catalogue found (looked for <root>/<harness>/tools/data/stage-graph.json under .kiro, .claude, .aidlc and any other dot-dir) — " +
    "artifact-contract judgements and stage attribution fall back to approximations. If the harness tree lives elsewhere, point --harness at it",

  auditEmpty: "The audit ledger is empty — the hooks may never have fired",
  auditShardRefused: (paths) =>
    `${plural(paths.length, "audit path")} not read, by the engine's rules — reached through a symlink, outside the workspace root, or not a regular file (a symlinked root itself is fine). Audit-derived figures, history and absences cover only what was read: ${paths.join(", ")}`,

  stateVersionMismatch: (stateVersion, harnessVersion, harnessDir) =>
    `state.md declares State Version ${stateVersion}, but the harness supports ${harnessVersion} (${harnessDir}/tools/aidlc-lib.ts) — the engine refuses next, report and doctor on this combination. Contract judgements cannot be made against a different generation, so they were withheld`,

  stateVersionUnreadable: (stateVersion) =>
    `Cannot read State Version from state.md (${stateVersion === undefined ? "field absent" : `value: ${stateVersion}`}) — the engine refuses a missing, empty or non-numeric value alike (aidlc-lib.ts classifyStateVersion). The artifact contract is still shown, but this page does not claim its completion judgements match the engine's`,

  teamWithoutUnitMajor: (constructionIteration) =>
    `Unit Ownership is team but Construction Iteration is not unit-major (${constructionIteration ?? "absent"}) — the engine contract requires both together, and only then does a Unit Progress table exist. Check the configuration`,

  unitProgressMalformed:
    "The `## Unit Progress` table in state.md is not in the shape the engine defines (the table does not start at column 0, or its first column is not `unit`, or the separator row's width differs from the header — the engine refuses it on the same conditions). Owner and per-unit gate are not shown",

  unitProgressMissing: (stageLevel) =>
    stageLevel
      ? "This is a team / unit-major run, but state.md has no `## Unit Progress` section — the engine could derive one from the unit roster, but there is no authoritative source here for owner and per-unit gate"
      : "This is a team / unit-major run, but state.md has no `## Unit Progress` section — with no authoritative source for owner and per-unit gate, the matrix below is reconstructed from disk and the audit ledger",

  rosterMismatch: (stateVersion, unknownToCatalog, missingFromState) => {
    const ver = stateVersion ? `(State Version: ${stateVersion})` : "(no State Version)";
    const engineNote = "the engine refuses this combination too: aidlc-lib.ts classifyStateVersion";
    const unknown =
      unknownToCatalog.length > 0
        ? ` · stages the catalogue does not know: ${unknownToCatalog.join(", ")}`
        : "";
    const missing =
      missingFromState.length > 0
        ? ` · stages with no row in state: ${missingFromState.join(", ")} (the engine writes a row even for SKIP)`
        : "";
    return `The stage rosters in state.md and the stage catalogue disagree ${ver}${unknown}${missing}. Artifact-contract judgements cannot be trusted, so they were made approximately (${engineNote})`;
  },

  harnessCoexist: (harnesses, chosen) =>
    `Harness directories ${harnesses.join(" and ")} both exist — the usage panel was set to ${chosen === "claude" ? "Claude Code tokens" : "Kiro credit"} automatically. To see the other one, pass --usage ${chosen === "claude" ? "kiro" : "claude"}.`,

  engineVersionUnsupported: (harnessDir, found, supported) =>
    `${found ? `Engine ${found}` : "No valid engine version stamp (aidlc-stamp.json)"} (${harnessDir}) — this dashboard reads AI-DLC ${supported} only. A record from another version is read by the ${supported} rules too, so some panels may be empty or wrong.`,

  questionsUnclosedBlock: (files) =>
    `${plural(files.length, "questions file")} with a code block or comment that is never closed — read as text rather than hidden, so no blocker is hidden by it. The engine may read it differently; check the file: ${files.join(", ")}`,

  recordFileUnreadable: (files, questions) =>
    `${plural(files.length, "record path")} could not be read or confirmed (for example no permission, a directory where a file was listed, a dangling link, or a directory link this reader does not follow) — not counted as absent${questions ? ". Part of the questions walk is among them, so the blocker list may be incomplete" : ""}: ${files.join(", ")}`,

  unitDagMalformed: (reason, detail, stop) =>
    `The units block in inception/units-generation/unit-of-work-dependency.md cannot be read (${reason}: ${detail}). ${
      stop === "construction"
        ? "The engine stops at the per-unit Construction stages until it is rewritten"
        : "The engine will not open the Units Generation gate until it can read it — while that stage is still open the file may simply be mid-write"
    }, so the unit matrix is withheld rather than drawn from runtime-graph.json's cached roster.`,

  tokenUsageFailed: (detail) =>
    `Token usage assembly failed — only the usage panel is degraded: ${detail}`,

  creditAssemblyFailed: (detail) =>
    `Credit assembly failed — only the credit panel is degraded: ${detail}`,
};

const blockers: BlockerStrings = {
  staleStage: "earlier stage (parked question)",
  confirmation: "gate confirmation",
  confirmationTip:
    "An approval-gate decision — the run proceeds only once you pick one of the engine's options or state what should change",
  loose: "unrecognised heading",
  looseTip:
    "A blank [Answer]: under no heading this dashboard reads as a question — the protocol asks for every blank tag to be filled whatever heading it sits under, so while this stage is running it is waiting for an answer too",
  untitled: "(no heading)",
  invalidTags: (tags) => `confirmation invalid · ${tags} [Answer]: tags`,
  invalidTagsTip:
    "A summary confirmation must hold exactly one [Answer]: — with more, the engine reads no answer at all, so keep one and delete the rest to proceed",
  viewTip: (rel) => `Read ${rel} in the dashboard`,
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const EN_ASK: Record<string, string> = {
  "compose-offer": "compose offer",
  "guard-recovery": "guard recovery choice",
  "intent-pick": "intent pick",
  "legacy-plan-approval-recovery": "plan approval recovery",
  "new-work-routing": "new work routing",
  "plan-approval": "plan approval",
  "project-type": "project type",
  "scope-confirm": "scope confirmation",
  "unit-claim": "unit claim",
  "unit-paused": "paused unit",
};

const status: StatusStrings = {
  runComplete: "✓ Complete",
  runUnknown: "? Run state unknown",
  runSource: "state.md",
  running: "▶ Running",
  runningSub: (stage, age) => `${stage} · last record ${age} ago`,
  runTip:
    "The last record is the newest event in the audit log. If it keeps growing, the run is not writing anything",
  runTipPartial: (refused) =>
    `The last record is the newest event in the audit shards read — ${plural(refused, "audit path")} refused, so a growing age does not show that the run stopped writing`,
  runningUnit: (unit) => `unit ${unit}`,
  runUnverified: "position unverified",
  runConflict: (where) => `engine directive says ${where}`,
  runOffRoster: (unit, why) =>
    why === "absent" ? `unit ${unit} is not in the unit roster` : "the unit roster cannot be read",
  runOffRosterTip:
    "The unit position in state.md (Active Unit) is a cache. The engine walks only the units in unit-of-work-dependency.md and resumes an active unit only from among them, so a cached unit the roster does not list — or a roster it cannot read — is not a position this dashboard can confirm",
  runConflictTip:
    "The unit position in state.md (Unit Stage, Active Unit) and the engine directive matching the current state (active-directive.json) point to different places. Neither is the engine's routing authority, so this dashboard does not pick one",
  runUnverifiedTip:
    "Under unit-major, Current Stage stays on the first per-unit stage, so the run may be further on. state.md has no Unit Stage and no engine directive (active-directive.json) matches the current state, so Current Stage is shown",
  stuckNoRecord: "No block recorded",
  stuckClear: "✓ Not stuck",
  stuckEarlier: (stage) => `last block was in ${stage} · this clone`,
  stuckStateChanged: "State changed since the last block — no block since",
  stuckNudged: "Nudged once — first block after progress",
  stuckBlocked: (count, cap) =>
    `⚠ ${count} blocks recorded with no progress (default limit ${cap})`,
  stuckReleased: (count, cap) =>
    `⚠ ${count} blocks recorded — at the default limit of ${cap} the hook may have let the turn end`,
  stuckSource: "stop hook · this clone",
  stuckTip: (cap, autonomous) =>
    `The stop hook's block-count.json. The first block after progress writes 1, each further block without progress adds one, and only done, notice or park resets it to 0. At the limit the hook stops blocking and lets the turn end. The limit shown is the ${autonomous ? "autonomous" : "interactive"} default of ${cap}; CLAUDE_CODE_STOP_HOOK_BLOCK_CAP may have changed it`,
  humanGate: (stage) => `Approval pending: ${stage}`,
  humanGateSource: "gate open · state.md [?]",
  humanRevising: (stage) => `${stage} in revision — gate rejected`,
  humanRevisingTip:
    "You rejected the approval gate (state.md [R]). This stretch covers both asking you what to change and the rework itself, so this row alone cannot say whose move it is — it is not counted as awaiting you",
  humanParked: (stage, byPerson) => `⏸ Parked — ${stage}${byPerson ? " · parked by a person" : ""}`,
  humanParkedTip: "The run is parked. It continues only once you ask the engine to resume",
  humanStateSource: "state.md · Runtime State",
  humanUnitPaused: (unit, reason) => `⏸ Unit ${unit} paused${reason ? ` — ${reason}` : ""}`,
  humanUnitNext: (next) => `next: ${next}`,
  humanUnitCacheLeftover: (unit, stage, paused) =>
    `Unit ${unit}${stage ? ` on ${stage}` : ""}${paused ? " (paused)" : ""} is a leftover in the state — this plan has no units`,
  humanUnitCacheLeftoverTip:
    "This plan skips Units Generation, so the engine runs each per-unit stage once at stage level and refuses unit start, pause and complete — no step writes the state's Active Unit / Unit Stage in this mode. The stop hook does not read them either: what is waiting follows Current Stage and the engine's current directive.",
  humanEngineAsk: (askType, where) =>
    `Engine question pending — ${askType ? (EN_ASK[askType] ?? askType) : "question"} · ${where}`,
  humanEngineAskSource: "active-directive.json",
  humanEngineAskTip:
    "The directive the engine last handed out asks you something. Only a directive whose digest matches the current state is read; most of these are asked in the conversation with no questions file",
  humanUnreadable: (n) =>
    `${plural(n, "questions path")} could not be read — the questions in ${n === 1 ? "it" : "them"} are not counted`,
  humanUnreadableTip:
    "Could not be read or confirmed (for example no permission, a directory where a file was listed, a dangling link, or a directory link this reader does not follow). A blank answer in it is missing, and an engine ask the file would have explained may be counted on its own, so the count above can be off either way. The paths are in the warnings at the top of the page",
  humanTeamGateUnread: "Team unit gate — not read",
  humanTeamGateUnreadTip:
    "Under team ownership a unit's gate is decided from the audit by unit, gate scope and claim attempt, not by the state row. The claim state is not visible to this dashboard, so whether an approval is pending was not determined — this does not mean nothing is waiting",
  humanCheckoutPark: "Unit park marker in this checkout — applicability unverified",
  humanCheckoutParkTip:
    "aidlc/.aidlc-unit-parked exists. Whether it applies to the intent shown is decided by a scope stamp this dashboard does not check, so it is not counted",
  humanDecision: (checkpoint, decision) =>
    `Decision pending — ${[checkpoint, decision].filter(Boolean).join(": ") || "unnamed decision"}`,
  humanDecisionSource: "audit log · DECISION_RECORDED",
  humanDecisionUnscoped: "scope unconfirmed — taken from the state's unit cache alone",
  humanDecisionTip:
    "A decision opened through the audit log rather than a questions file (a learnings selection, anything to add, a unit or batch approval). The engine waits for your answer until a receipt closes it",
  humanCompose: "Compose proposal awaiting approval",
  humanComposeTip:
    "aidlc/.aidlc-compose-pending was updated within the last 24 hours. The run continues once you approve, edit or reject the proposed composition",
  humanTurnEnded: "The engine ended its turn — the next message is yours",
  humanTurnEndedTip:
    "The engine's last directive was a question or a stopping print (.aidlc-engine/turn-end is newer than human-turn). A question to answer shows as the engine-question row above; this row is not counted",
  humanHooksStale: (hb, ev) =>
    `⚠ Hooks look stopped — last fired ${hb} ago, last stage/gate record ${ev} ago`,
  humanHooksNever: "⚠ No hook has fired — but stage/gate records exist",
  humanHooksStaleTip:
    "The newest hook heartbeat is more than five minutes behind the newest STAGE_/GATE_ record (the engine's hookLiveness comparison). 2.11 refuses to record a plan-approval decision (aidlc-log decision --checkpoint plan-approval) in this state; check the harness's hook registration",
  humanHooksNeverTip:
    "hooks-health holds no .last file at all, yet STAGE_/GATE_ records exist. The hooks may not be registered, or did not run on this clone",
  humanAutonomous: "Autonomous mode — questions and decisions do not hold the run",
  humanAutonomousTip:
    "Construction Autonomy Mode is autonomous. Only a unit-major plan approval stops the run; other questions, decisions and compose proposals let it keep going",
  humanEngineOnly: (file) => `Blank tag only the engine waits on · ${file}`,
  humanEngineOnlyTip:
    "The stop hook lets the turn end when the raw text of the running stage's questions file holds a blank [Answer]:. This dashboard reads that spot as answered (an example in a code block, a placeholder answered in another section), so it is not counted — but the engine may stop here",
  humanNone: "✓ Nothing awaiting you",
  humanSource: "questions files · state · audit · engine markers",
  checksNone: "No checks recorded this stage",
  checksNonePartial: (refused) =>
    `No checks recorded this stage in the audit shards read — ${plural(refused, "audit path")} refused, and a check recorded there is not seen`,
  checksInFlight: (pending) => `⋯ ${plural(pending, "check")} running`,
  checksFailed: (failed) => `✗ ${plural(failed, "check failure")} recorded`,
  checksPassed: (passed) => `✓ ${plural(passed, "check")} passed`,
  checksPassedPartial: (passed, refused) =>
    `✓ ${plural(passed, "check")} passed in the audit shards read — ${plural(refused, "refused audit path")} may hold a failure`,
  checksSource: (stage) => `sensors · ${stage} (Current Stage) · audit log`,
  checksUnverified: (n) => `? ${plural(n, "check")} without a verified result`,
  checksUnverifiedTip:
    "A pass carrying a Note (tool unavailable, script error, findings that could not be written) or a budget override, with no later verified pass of the same output. A blocking gate refuses both like a failure, so neither is counted as passed",
  checksFailedTip:
    "Sensor failures recorded in the current stage that no later verified pass of the same output has retired. The gate re-runs its sensors, so this is what was recorded, not a verdict ahead of it",
};

const overview: OverviewStrings = {
  sectionProgress: "Progress",
  planLabel: (name) => `plan: ${name}`,
  sectionUnitProgress: "Unit progress (state.md, authoritative)",
  sectionMatrix: "Construction unit matrix",
  runComplete: "complete",
  nowLabel: "now",
  updatedLabel: "updated",
  kindArtifact: "artifact",
  kindQuestions: "questions / answers",
  kindDiary: "stage diary",
  openInEditor: (rel) => `${rel} — open in the default editor`,
  provisionalTip: "in flight — these numbers are still growing",
  totalColumn: "total",
  unassignedOwner: "unassigned",
  batchNote:
    "Units inside a batch can run in parallel — batches are the topological order of their dependencies.",
  unitProgressNote:
    "state.md's <code>## Unit Progress</code> — an <b>authoritative</b> projection the engine rewrites on every\n  <code>next</code> from receipts, reviews and gates. Hand edits are never routing or completion evidence. The matrix below is a separate diagnostic, reconstructed from disk.",
  unitProgressStaleRoster: (missing, extra, rewritesOnNext) =>
    `This table no longer matches the unit roster the engine rebuilds it from (${[
      missing.length ? `not in the table: ${missing.join(", ")}` : "",
      extra.length ? `not in the roster: ${extra.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ")}). It is the last projection written; ${
      rewritesOnNext
        ? "the engine rewrites it on the next `next`"
        : "at stage level `next` does not rewrite it"
    }.`,
  unitProgressStaleDag:
    "The unit roster (unit-of-work-dependency.md) cannot be read, and the engine refuses to rebuild this table without it — what is shown is the last projection written, not the current authority.",
  sectionUnitProgressStageLevel: "Unit progress (state.md — this plan runs stages at stage level)",
  unitProgressStageLevelNote:
    "state.md's <code>## Unit Progress</code>. This plan skips Units Generation, so the engine runs each per-unit stage once at stage level and does not walk units by this table there. It can still read the table elsewhere — unit claims, for one.",
  noUnits: "No unit information — units-generation has not been reached.",
  noUnitsPill: "n/a",
  stageLevelUnits:
    "No per-unit matrix — this plan skips Units Generation, so there are no units. Each per-unit Construction stage runs once at stage level and writes under construction/<stage>/ (see Phase · Stage above).",
  stageLevelUnitsPill: "stage level",
  unitModeUnknown:
    "Neither the state file nor the scope grid says whether Units Generation runs, so this matrix assumes artifacts are per unit.",
  unitDagMalformed: (reason, stop) =>
    `No per-unit matrix — the engine cannot read the units block in unit-of-work-dependency.md (${reason}), so the unit set is unknown until it is rewritten${
      stop === "construction" ? "" : " (Units Generation is still open, so it may be mid-write)"
    }. The runtime graph's cached roster is not drawn in its place.`,
  unitDagMalformedPill: (stop) => (stop === "construction" ? "blocked" : "not readable yet"),
  unitDagHealed:
    "Units read from unit-of-work-dependency.md, as the engine reads them — the copy cached in runtime-graph.json differs from it (in its batches or unit kinds), so the engine does not use that copy either.",

  tipPartial: (missing) => `missing: ${missing.join(", ")}`,
  tipComplete: (present) => `complete: ${present.join(", ")}`,
  tipUnsettled: (present) =>
    `Every artifact is present but there is no completion receipt (UNIT_COMPLETED) — the unit may be paused, waiting to resume, or unapproved (files: ${present.join(", ")})`,
  tipUnverified: (reason, present) =>
    `${RECEIPT_REASON_EN[reason]}${present.length ? ` (files: ${present.join(", ")})` : ""}`,
  tipNotApplicable: (present) =>
    `Nothing is contracted for this unit's kind${present.length ? ` (files present: ${present.join(", ")})` : ""}`,
  tipSkipped: (reason) =>
    `The engine skipped this stage for this unit (UNIT_SKIPPED)${reason ? ` — reason: ${reason}` : ""}`,
  tipNotStarted: "not started",

  legendBase:
    "\u2588 complete (receipt confirmed where the stage uses receipts, else by artifacts) · \u25a8 started, artifacts incomplete (hover a cell to see what is missing) · · not started",
  legendUnsettled:
    " · \u25a9 every artifact present but no completion receipt (UNIT_COMPLETED) — the engine treats this unit as uncovered too",
  legendUnverified:
    " · \u25a4 the completion receipt cannot be checked from the audit ledger alone — this is NOT a verdict that the work is incomplete (hover a cell for the reason)",
  legendNa:
    " · \u2013 nothing contracted for this unit's kind (the bracket in the total column is how many)",
  legendSkipped:
    " · \u2298 the engine skipped this stage for the unit (UNIT_SKIPPED) — left out of the total",
  legendUnverifiedContract:
    "state.md's State Version could not be checked against the harness, so this is an <b>unverified contract</b> — the contract is shown as read, but this page does not warrant that its completion judgements match the engine's",
  legendNoContract: (receiptAware) =>
    `No stage-graph.json, so contract judgements are impossible — a cell means file presence${receiptAware ? " and the completion receipt" : ""} only`,

  checkpointHeading: "Checkpoint verification",
  checkpointNote:
    "Read from each unit's checkpoint proof. While a proof reads like this, the engine cannot count the checkpoint verified, so it will not ask for or record a new approval of the unit until a verification passes. Two things it does not settle, so this page does not say them: whether an approval the unit already holds is kept (it can be, over a scope change), and what has to happen next. None of this is counted as a wait — the engine opens no person's ask for it. A proof that passed is not listed: whether it is still current depends on a fingerprint this page does not reproduce.",
  checkpointIndefiniteNote:
    "Marked ?: this reader cannot settle these — they may not be the file the engine reads, or the file could not be read here — so no verdict of the engine's is claimed for them.",
  checkpointKind: (kind) =>
    kind === "skeleton" ? "walking-skeleton checkpoint" : "unit checkpoint",
  checkpointFailed: (unit, kind, detail, startedAt) =>
    `${unit} — ${kind}: verification did not pass (${detail}), run ${startedAt}`,
  checkpointFault: (fault, exitCode, signal) =>
    fault === "exit-code"
      ? exitCode === null
        ? "no exit code"
        : `exit ${exitCode}`
      : fault === "signal"
        ? `signal ${signal ?? "?"}`
        : fault === "error"
          ? "the check could not run"
          : fault === "evidence-changed"
            ? "the unit's evidence changed while it ran"
            : fault === "unfinished"
              ? "did not finish"
              : fault === "not-verified"
                ? "not verified"
                : fault === "wrong-unit"
                  ? "the proof names another unit"
                  : "the proof is for another checkpoint kind",
  checkpointMalformed: (unit, kind) =>
    `${unit} — ${kind}: the proof file is not one the engine accepts (unparseable, or a field of the wrong shape), so it reads as no proof — and with the file present, the committed verification row does not stand in for it`,
  checkpointUnreadable: (unit, kind, cause) =>
    `${unit} — ${kind}: the proof could not be read (${
      cause === "link"
        ? "a symbolic link on its path — the engine refuses it and stops with an error"
        : cause === "hardlink"
          ? "a hardlink — the engine refuses it and stops with an error"
          : cause === "not-file"
            ? "not a regular file — the engine refuses it and stops with an error"
            : cause === "too-large"
              ? "larger than this reader's 1 MB bound"
              : cause === "changed"
                ? "it changed while being read — the next refresh reads it again"
                : "a read error — the engine stops with an error on it too"
    })`,
  checkpointKindUndetermined:
    "Skeleton Stance is scope-dependent (or the graph names no batches) and the scope file is not read here, so both of the skeleton unit's proofs are checked — only one of them is the one the engine reads.",
  checkpointOutputTail: "output tail",
};

const page: PageStrings = {
  warningsHeading: "Read warnings",
  harnessNotFound: "not found",
  pickFolder: "📁 Change folder",
  wsMenuTip: "Switch workspace",
  wsHeading: "Workspaces",
  wsNoOthers: "No other workspaces found.",
  wsLoading: "Looking for workspaces…",
  wsLoadFailed: "Could not load the list",
  wsCurrent: "current",
  wsTruncated: "The search limit was reached. If yours is missing, browse for it.",
  reloadTitle:
    "Read again now (r) — picks up edits a poll can miss, such as switching SKIP\u2194EXECUTE by hand",
  reloadLabel: "Refresh",
  footer: "Read-only — this dashboard never writes to the workspace.",
  langGroupLabel: "Page language",
  langKo: "한국어",
  langEn: "English",

  jsReloading: "Refreshing",
  jsRefreshedPrefix: "updated ",
  jsRefreshFailed: "Update failed — retrying",
  jsOpenFailedStatus: "Could not open ({status})",
  jsOpenFailedUnreachable: "Could not open — the server did not respond",
};

const health: HealthStrings = {
  sectionDiary: "Decisions and issues",
  sectionStream: "Audit ledger",
  kindDeviation: "plan change",
  kindDeviationTip: "Records something that diverged from the original plan mid-run, and why",
  kindTradeoff: "trade-off",
  kindTradeoffTip: "Records what was gained and given up in choosing between alternatives",
  kindInterpretation: "interpretation",
  kindInterpretationTip: "Records how an ambiguous requirement or instruction was understood",
  kindResolved: "resolved",
  kindResolvedTip: "Marks a previously open question or issue as settled",
  kindFollowUp: "follow-up",
  kindFollowUpTip: "Something still to be checked or decided",
  kindNote: "note",
  kindNoteTip: "An open question with no stated follow-up or resolution",
  sourceLink: "source",
  openTip: (rel) => `Open ${rel}`,
  noRecords: "No records.",
  more: (count) => `${count} more`,
  stageRollup: (count) => `All records by stage · ${count} normalised`,
  colStage: "stage",
  colDecision: "decisions",
  colDeviation: "changes",
  colFollowUp: "follow-ups",
  colResolved: "resolved",
  colNote: "notes",
  colTotal: "total",
  noDiaryFiles: "No stage diary (memory.md).",
  noDiaryRecords: "No recorded decisions or follow-up issues.",
  statFollowUp: "follow-ups",
  statResolved: "resolved",
  statDeviation: "plan changes",
  statDecision: "decisions",
  tidyPill: "clear",
  tidyPillTip: "Means no follow-up candidate is left without a resolution marker",
  tidyNote: "No follow-up candidates left unresolved.",
  headingFollowUp: "Follow-up candidates",
  headingRecentDecisions: "Recent decisions",
  headingRecentDeviations: "Recent plan changes",
  resolvedRecords: (count) => `${count} resolved`,
  emptyLedger: "The audit ledger is empty.",
  filterLabel: "kind",
  filterAll: (total) => `all (${total})`,
  streamMeta: (shown, total, shards) =>
    `showing the latest ${shown} of ${total} · ${shards} shard${shards === 1 ? "" : "s"}`,
  colTime: "time",
  colEvent: "event",
  colStageUnit: "stage / unit",
  colDetail: "detail",
};

const deferrals: DeferralStrings = {
  section: "Deferred decisions",
  faces: {
    passed: {
      label: "past stage",
      tip: "The stage this decision was assigned to has already finished, and no answer is recorded. The engine writes no close marker, so this means 'not visible', not 'dropped'",
    },
    current: {
      label: "current stage",
      tip: "The stage running now is the one that should ask this — it is due this turn",
    },
    ahead: {
      label: "later stage",
      tip: "Assigned to a stage that has not started yet — it will be asked when the run gets there",
    },
    outOfScope: {
      label: "out of scope",
      tip: "A real stage, but not in this run's scope (state.md) — nobody is going to ask it",
    },
    nextCycle: { label: "next cycle", tip: "Explicitly pushed outside this cycle" },
    unassigned: {
      label: "unassigned",
      tip: "No stage could be read from the assignment cell — with nowhere to ask it, this can simply disappear at the next stage",
    },
  },
  ageTip: "Time since this item was first recorded",
  sourceLink: "source",
  viewTip: (rel) => `Read ${rel} in the dashboard`,
  editorLink: "editor",
  openTip: (rel) => `Open ${rel}`,
  assignLabel: "assigned to",
  noneApplicable: "None.",
  more: (key, count) => `${key}: ${count} more`,
  ownerRollup: (stages) => `By assigned stage · ${stages} stage${stages === 1 ? "" : "s"}`,
  colOwner: "assigned to",
  colStatus: "status",
  colCount: "count",
  assumptionPill: "assumption",
  assumptionPillTip: "An assumption carried into the next stage unconfirmed — it names no stage",
  assumptionSummary: (count) =>
    `${count} unconfirmed assumption${count === 1 ? "" : "s"} — unassigned`,
  assumptionNote: `The engine's stage protocol marks an assumption <code>[assumption]</code> and requires it to stay
  an assumption in downstream artifacts until the user confirms it in that stage's questions file. These are prose
  rather than a table, so there is no assigned stage and this dashboard cannot say where they will come due —
  it does not guess a stage name out of a sentence.`,
  diaryFollowUpPill: "follow-up",
  diaryFollowUpTip: "The sentence itself asks for a follow-up or a decision",
  diaryNotePill: "diary open item",
  diaryNoteTip:
    "The stage filed this under its open-questions section but the sentence carries no follow-up wording — the heading is the declaration, so it still counts",
  diarySummary: (count) =>
    `${count} open item${count === 1 ? "" : "s"} in the stage diaries — unassigned`,
  diaryNote: (resolved) =>
    `Read from <code>## Open questions</code> in <code>memory.md</code>, not from an artifact —
  the second open-item ledger the engine mandates in every stage diary. It is the orchestrator's own note rather than
  a contract with a later stage, and it has no assignment cell, so it is <b>never summed</b> with the artifact items above.${
    resolved > 0 ? ` ${resolved} marked resolved ${resolved === 1 ? "was" : "were"} excluded.` : ""
  }`,
  ledgerItems: "artifact open items",
  ledgerItemsSource: "open entries under <code>## Assumptions &amp; Open Questions</code>",
  ledgerAssumptions: "unconfirmed assumptions",
  ledgerAssumptionsSource: "<code>[assumption]</code> entries in the same section",
  ledgerDiary: "stage diary open items",
  ledgerDiarySource: "<code>## Open questions</code> in each stage's <code>memory.md</code>",
  ledgerDeclared: "stage-declared open questions",
  ledgerDeclaredSource:
    "<code>Open questions</code> in <code>requirements.md</code> and <code>contract-summary.md</code>",
  declaredFaces: {
    requirements: {
      label: "requirements",
      tip: "requirements-analysis's own Open questions — remaining uncertainties for later stages",
    },
    contract: {
      label: "contract",
      tip: "contract-design's Open questions table — an unresolved contract point and what it blocks",
    },
  },
  declaredSummary: (count) =>
    `${count} open question${count === 1 ? "" : "s"} declared by a stage's own artifact — unassigned`,
  declaredNote: `Read from the <code>Open questions</code> that requirements-analysis (<code>requirements.md</code>)
  and contract-design (<code>contract-summary.md</code>) are told to write — outside the
  <code>## Assumptions &amp; Open Questions</code> section. Neither has an assignment cell: <code>Blocks</code> names what
  the point blocks, not a stage that will answer it, so <b>no owner is claimed and these are never summed</b> with the
  artifact items above.`,
  contractLabel: "contract",
  blocksLabel: "blocks",
  declaredUnread: (files) =>
    `The <code>Open questions</code> section of ${files} is in a shape this reader does not know —
    <b>not read, which is not the same as empty</b>.`,
  declaredMissing: (files) =>
    `No <code>Open questions</code> section this reader recognises was found in ${files} — its stage file asks for
    one, though not under a fixed heading, so it may be written in a shape this reader does not know.`,
  declaredUnreadable: (files) =>
    `${files} is present but could not be read as a file — <b>its open questions were not read</b>.`,
  aoqUnreadable: (files) =>
    `${files} could not be read or confirmed — <b>any <code>## Assumptions &amp; Open Questions</code> section in it is not in the counts above</b>.`,
  diaryUnreadable: (files) =>
    `Stage diary path ${files} could not be read or confirmed — <b>any open question in it was not read</b>.`,
  unreadAlongside: (unread, files) =>
    `<b>${unread} <code>## Assumptions &amp; Open Questions</code> section${unread === 1 ? " is" : "s are"} in a shape
    this reader does not know</b> (${files}) — whatever ${unread === 1 ? "it holds is" : "they hold is"} not in the counts above.`,
  chipUnassignedTip:
    "Prose, so there is no assignment cell — it stays an assumption until the user confirms it in that stage's questions file",
  chipFollowUp: "follow-up",
  chipFollowUpTip: "The sentence itself asks for a follow-up or a decision",
  chipOther: "other",
  chipOtherTip:
    "Filed under the open-questions section but with no follow-up wording in the sentence — the heading is the declaration, so it still counts",
  ledgersNote: `These ledgers are <b>different reads</b> — only the first row has an assignment cell, and the
others have nowhere assigned to ask them. <b>They are not summed.</b>`,
  noSections: (artifacts, unreadable) =>
    unreadable > 0
      ? `No artifact that could be read carries an <code>## Assumptions &amp; Open Questions</code> section —
    <b>${unreadable} path${unreadable === 1 ? "" : "s"} could not be read</b>, and a section there is not counted. (${artifacts} artifact${artifacts === 1 ? "" : "s"} read)`
      : `No artifact carries an <code>## Assumptions &amp; Open Questions</code> section — either this run left no
    open-item ledger, or it has not written artifacts yet. (${artifacts} artifact${artifacts === 1 ? "" : "s"} read)`,
  unreadSections: (sections, unread, emptySections) =>
    `There ${sections === 1 ? "is" : "are"} ${sections} <code>## Assumptions &amp; Open Questions</code>
      section${sections === 1 ? "" : "s"}, and <b>${unread} of them ${unread === 1 ? "is" : "are"} in a shape this reader does not know</b> — no table
      (<code>| item | assigned |</code>), no <code>[assumption]</code> tag, and no <code>**OQ1**</code>-style ledger id.
      <b>That does not mean there are no open items; it means they were not read.</b>
      ${emptySections} section${emptySections === 1 ? "" : "s"} declared <code>None.</code> explicitly.`,
  noOpenPill: "no open items",
  noOpenPillTip: "The ledger section is present and empty — an explicit declaration of 'none'",
  allNone: (sections, partial) =>
    partial
      ? ` The ${sections} <code>## Assumptions &amp; Open Questions</code> section${sections === 1 ? "" : "s"} that could be read ${sections === 1 ? "reads" : "all read"} <code>None.</code>`
      : ` All ${sections} <code>## Assumptions &amp; Open Questions</code> section${sections === 1 ? "" : "s"} read <code>None.</code>`,
  lead: (items, sections, rows, exits) =>
    `<b>${items}</b> open item${items === 1 ? "" : "s"} · ${sections} <code>## Assumptions &amp; Open Questions</code>
  section${sections === 1 ? "" : "s"} (${rows} raw row${rows === 1 ? "" : "s"} → ${items} after de-duplication)${
    exits > 0
      ? ` · ${exits} explicitly pushed outside this cycle ${exits === 1 ? "is" : "are"} not in that number`
      : ""
  }.
  The engine protocol states that <b>when downstream work needs an unresolved item, it asks a follow-up</b> — so nothing
  here has gone away, it <b>will be asked again</b>. The engine writes no close marker either, which is why
  <b>'past stage' means no answer is visible, not that the item was dropped</b>.`,
  catalogMissingNote: `With no stage catalogue, stage names in the assignment cells were judged against this run's
    state.md alone — an out-of-scope stage may therefore have been demoted to <b>unassigned</b>.`,
  headingPassed: (count) => `Assigned to a past stage · ${count}`,
  headingCurrent: (count) => `The current stage should ask · ${count}`,
  summaryAhead: (count) =>
    `${count} assigned to a later stage — they come due when the run gets there`,
  summaryRest: (count) => `${count} unassigned or outside this cycle`,
};

const timeline: TimelineStrings = {
  section: "Time analysis",
  endKinds: {
    completed: "completed",
    skipped: "skipped",
    "awaiting-approval": "awaiting approval",
    "in-flight": "in flight",
    superseded: "superseded by re-entry",
    paused: "paused",
  },
  segmentTip: (stage, endKind, from, to, split) =>
    `${stage} — ${endKind}\n${from} → ${to}\n${split}`,
  splitLine: (wait, parked, observed, conversation, unknown) =>
    `user wait ${wait}min · parked ${parked}min · observed ${observed}min · conversation ${conversation}min · unclassified ${unknown}min`,
  zeroSecondTip: "0s — started and completed in the same second",
  loadArtifacts: (n) => `artifacts ${n}`,
  loadFailures: (n) => `failed ${n}`,
  loadDelegations: (n) => `reviews ${n}`,
  loadHumanTurns: (n) => `human ${n}`,
  noStageSpans: "The audit ledger holds no stage spans.",
  noStageSpansPartial: (refused) =>
    `The audit shards read hold no stage spans — ${plural(refused, "audit path")} refused.`,
  partialAuditNote: (refused) =>
    `${plural(refused, "audit path")} refused. The times, the rework and the worker table below use only the events read, and a missing event can change a duration, a classification or an inferred state — an absence here is not an absence across the run.`,

  bucketWait: "user wait",
  bucketWaitTip: "From a gate or question opening until a human answered",
  bucketParked: "parked",
  bucketParkedTip: "Stretches where every clone PRESENT at that moment was parked",
  bucketObserved: "observed execution",
  bucketObservedTip:
    "The sum of sub-5-minute event gaps and explicit delegation spans — not pure model or CPU time",
  bucketConversation: "conversation",
  bucketConversationTip:
    "One clone's HUMAN_TURN to that same clone's next HUMAN_TURN. It contains the engine's chat reply (which leaves no audit event) together with the human reading and typing, and the ledger draws no boundary between them — so it is neither wait nor execution and keeps its own bucket",
  bucketUnknown: "unclassified",
  bucketUnknownTip:
    "Five minutes or more with no marker worth trusting — left unpainted rather than counted as execution",

  windowTipOpen: (silence) =>
    `First event → now. The ${silence} since the last event is NOT in the breakdown below (with no records, it cannot be classified).`,
  windowTipClosed: "First event → last event",
  windowTeam: "team wall clock",
  windowSolo: "total elapsed",
  windowSub: (classified) => `Shares below divide by <b>${classified} classified</b>`,
  unrecordedPill: (silence) => `${silence} unrecorded since the last event`,
  clonesPill: (clones) => `${clones} clone${clones === 1 ? "" : "s"}`,
  delegated: (h) => ` · delegated ${h}`,
  inFlight: (list) => `In flight: ${list}`,
  noneInFlight: "No stage in flight",
  noneInFlightPartial: (refused) =>
    `No stage in flight in the audit shards read (${plural(refused, "audit path")} refused)`,
  awaiting: (stage) => `awaiting approval: <b>${stage}</b>`,
  awaitingDecision: (name) => `awaiting decision: <b>${name ?? "unnamed decision"}</b>`,
  awaitingDecisionUnscoped:
    '<span class="mute"> (scope unconfirmed — taken from the state\'s unit cache alone)</span>',
  awaitingTeamUnread:
    'unit gate not read<span class="mute"> (team ownership — whether a unit approval is pending is not determined here)</span>',
  awaitingNone:
    'no stage gate open<span class="mute"> (the Current Stage row is not awaiting approval — other asks are in the Your answers tab; past submissions are in the rework table below)</span>',
  reworkPending: " · a stage is rejected and not yet re-approved",
  mergedNote: (workers, clones) =>
    `${workers} ledger${workers === 1 ? "" : "s"} (${clones} clone${clones === 1 ? "" : "s"}) merged — the breakdown above is
       a <b>team-wide</b> figure over every record on one line. For per-person time see <b>per-worker breakdown</b>.`,
  axisSilenceTip: (silence) =>
    `${silence} since the last event — unrecorded, so it is left unclassified`,

  reworkSummary: (rejected, h) =>
    `Rework — ${rejected} rejection${rejected === 1 ? "" : "s"} · ${h}`,
  reworkNone: (approved) =>
    approved === 0
      ? "No gate has been approved yet, and none was rejected or revised."
      : `No rejections or revisions — all ${plural(approved, "gate approval")} so far passed first time.`,
  reworkNonePartial: (refused) =>
    `No rejections or revisions in the audit shards read — ${plural(refused, "audit path")} refused, and a rejection recorded there is not seen.`,
  reworkProvisionalTip: "Not approved yet — this time is still growing",
  feedbackCount: (n) => `${n}`,
  reasonsSummary: (n) => `${n} rejection reason${n === 1 ? "" : "s"} written by a human — in full`,
  reasonsNote: `Copied verbatim from <code>**Feedback**</code> in the ledger. Duplicates across a rejection/revision pair
  are removed and at most 6 are kept per stage — nothing is summarised or truncated.`,
  reworkStatShare: (share) => `rework ${share}%`,
  statRejected: "rejected",
  statApproved: "approved",
  statRevisions: "revision rounds",
  statJumps: "stage jumps",
  statReopened: "units reopened",
  statReopenedTip:
    "A per-unit stage re-entered at the person's request (/aidlc --stage, or Redo on re-entry). Not a rejection: the content was not judged, so it is neither in the rejected count nor in the rework time",
  statFreezeBlocked: "edits blocked in review",
  colSubmissions: "submitted",
  colSubmissionsTip: "STAGE_AWAITING_APPROVAL — how many times it was put to a gate",
  colRejections: "rejected",
  colRevisions: "revisions",
  colRevisionsTip: "Revision rounds / the cumulative Revision count in state.md",
  colRework: "rework",
  colReworkTip: "First rejection → last approval",
  colReason: "reasons",
  colReasonTip: "Rejection reasons written by a human — the full text is below the table",
  reworkNote: (share, classified, provisional) =>
    `Rework = <b>first rejection through last approval</b>. A stage rejected twice includes the approval in
  between: this measures "time not yet accepted", not a sum of rounds — the ledger gives no close marker for a
  revision round. ${share}% is of the classified span (${classified}).${
    provisional ? " Stages marked <b>~</b> are not approved yet, so their time keeps growing." : ""
  }`,

  colStage: "stage",
  colTrack: "occupancy",
  colTotalMin: "total (min)",
  colWait: "user wait",
  colParked: "parked",
  colObserved: "observed",
  colConversation: "conversation",
  colConversationTip:
    "One human turn to the next — the engine's chat reply and the human reading and typing are mixed together, so it is counted as neither.",
  colUnknown: "unclassified",
  colWorkEstimate: "work estimate",
  colWorkEstimateTip:
    "Observed + unclassified — the span minus user wait, parked and conversation. Not execution time but 'time not explained by waiting', and this column, not total (min), is what answers which stage was expensive.",
  colWorkload: "workload",
  ganttLegend: `A bar's <b>length</b> is calendar occupancy; its <b>fill</b> is that stretch's own split —
  <i class="lg wait"></i>wait · <i class="lg parked"></i>parked · <i class="lg observed"></i>observed ·
  <i class="lg conv"></i>conversation · <i class="lg unknown"></i>unclassified. The outline is how the stage ended:
  teal=completed · grey=skipped · orange=awaiting approval · blue=in flight · dashed=superseded by re-entry
  (that attempt ended and the stage started again). A 0-second stage gets a tick, not a bar.
  <b>Read which stage was expensive from the «work estimate» column, not from bar length</b> — the longest bar can be
  all waiting.`,
  colUnitStage: "unit · stage",
  inferredStartTip: (firstWrite, receipt) =>
    receipt
      ? `Start moved back to the unit's first record write in this stage (${firstWrite}); its UNIT_STARTED receipt is at ${receipt}. Earliest recorded evidence, not a measured start.`
      : `No UNIT_STARTED receipt (a completion-only receipt); the start is the unit's first record write in this stage (${firstWrite}). Earliest recorded evidence, not a measured start.`,
  inferredRowTip:
    "At least one segment's start is inferred from the unit's first record write — see the bar's tooltip.",
  durationUnknownTip:
    "A completion with no start receipt and no record write of the unit in this stage: the duration is unknown.",
  pauseOnlyTip:
    "A pause recorded with nothing open: its start was another clone's row in the same second, which the engine's rule ranks below a pause, or was never written, and no completion was observed. The engine reads this unit as paused.",
  unitSummary: (units, stages) =>
    `Unit view — ${units} unit segment row${units === 1 ? "" : "s"} across ${stages} stage${stages === 1 ? "" : "s"}`,
  unitVsStage: (stage, unitHours, stageHours) =>
    stageHours === undefined
      ? `<b>${stage}</b>: Σ unit segments ${unitHours}`
      : `<b>${stage}</b>: Σ unit segments ${unitHours} · stage bar ${stageHours}`,
  unitStageSkipped: (stage) => `<b>${stage}</b>: every recorded row is a skip`,
  colUnitTrack: "occupancy (units' window)",
  unitNote: `Read from the unit lifecycle rows: a segment opens at <code>UNIT_STARTED</code> or
  <code>UNIT_RESUMED</code> and closes at <code>UNIT_PAUSED</code> (dotted) or <code>UNIT_COMPLETED</code>;
  <code>UNIT_SKIPPED</code> closes an open segment and is otherwise a tick. Two clones' rows for one unit in the same
  second cannot be ordered, so they are reduced as the engine reduces them: a possible pause wins, then a start or
  resume, and a pause with nothing open is a tick. The view runs THROUGH completion — the unit
  checkpoint work after it (verification, the unit-end gate) is not in it. A start receipt can be written after the
  work, and a wave or recovery completion has none, so a segment may start at the unit's first record write in the
  stage instead, within the same attempt and clone (<b>~</b> on the row, details in the bar's tooltip): that is the
  earliest recorded evidence, not a measured start. A segment's split is classified on the events of the clone that ran
  the unit; what that clone's events do not cover is unclassified. The per-stage figure is a SUM of unit segments, so
  overlapping units count twice. Under unit-major the engine keeps Current Stage on the first per-unit stage while units
  walk the later ones, so a stage bar above is calendar occupancy and can be far longer — or, for a later stage,
  shorter — than its units' segments. The two answer different questions; neither corrects the other.`,
  observedCaveat: `Observed execution is the sum of sub-5-minute event gaps and explicit delegation spans, not pure
  model or CPU time. <b>Conversation</b> runs from one human turn to the next — the engine's chat reply leaves no audit
  event, so that stretch holds engine work together with the human reading and typing, and with no boundary in the
  ledger it is <b>counted as neither</b>.`,
  unknownGapsSummary: (count) =>
    `${count} unclassified gap${count === 1 ? "" : "s"} of 5min+ (top 12)`,
  unknownGapsNote:
    "Stretches that cannot be settled as wait, parked or execution, so they are kept out of execution time.",
  minutes: (min) => `${min}min`,
  inferredPark: (h, anomalies) =>
    `${h} of the parked time is inferred from session-resume events${
      anomalies > 0 ? ` · ${anomalies} park-marker anomal${anomalies === 1 ? "y" : "ies"}` : ""
    }.`,

  workerShapeOverlap: (clones, overlap) => `${clones} clones · ${overlap} worked concurrently`,
  workerShapeSequential: (clones, handover) =>
    `${clones} clones · sequential handover (no overlap)${handover ? ` · ${handover} handover gap` : ""}`,
  workerSummary: (shape) => `Per-worker breakdown — ${shape}`,
  leadTag: "lead",
  leadTagTip: "Passed an approval gate = the clone driving the workflow",
  noUnitAttribution: "No unit attribution in the audit ledger",
  personTotal: "person-hours total",
  personParallelism: "effective parallelism",
  colClone: "clone",
  colEvents: "events",
  colSpanMin: "span (min)",
  colGates: "gates",
  colMainStage: "main stages",
  colUnits: "units",
  workerNote: (teamIdle, deltaNote) =>
    `Each row is computed from <b>that clone's timeline alone</b> = "how long did each person wait".
  The team-wide parked+wait total above (${teamIdle}) merges every record onto one line.
  ${deltaNote}`,
  deltaSame: "The two figures are close to equal.",
  deltaOverlapUnder: (delta, overlap) =>
    `In the merged ledger someone else's events fill my wait, so it reads <b>${delta} lower</b>
             (the clones worked ${overlap} concurrently).`,
  deltaOverlapOver: (delta) =>
    `The merged ledger is <b>${delta} higher</b> — a non-overlapping handover gap is team-wide stopped
             time, but it is absent from any individual timeline.`,
  deltaHandoverUnder: (delta) =>
    `The <b>${delta}</b> difference is handover, not overlap — the clones never coincide in time
             (overlap 0), so one clone parking cannot be read team-wide as another clone's absence.`,
  deltaHandoverOver: (delta, handover) =>
    `The merged ledger is <b>${delta} higher</b> — the handover gap between clones
             (${handover}) is team-wide stopped time but absent from any individual timeline.`,
  hostNote: (workers, clones) =>
    `Some of the ${workers} ledgers are <b>the same working copy</b> under a different host name —
         the clone count is ${clones}.`,
  endedParked: (label, at) => `<b>${label}</b> ended parked at ${at}`,
  endedParkedTail: " — a ledger that never came back.",
  parallelismNote: `Effective parallelism = person-hours ÷ team wall clock. It only means anything when there is
       concurrent work, so it is withheld when overlap is 0.`,
  unitColumnNote: `A clone showing "—" for units has no audit row that names a unit (a <code>Unit</code> field or a
  per-unit <code>Context</code>) — for example, it worked only on stage-level stages. Its stages are still attributed.`,
};

const picker: PickerStrings = {
  docTitle: "Choose an AI-DLC workspace",
  heading: "Choose a workspace",
  currentMark: "current",
  launchMark: "found where you launched",
  workspaceKind: "AI-DLC workspace",
  openAction: "Open&nbsp;›",
  tagWorkspace: "workspace",
  tagAidlcTree: "aidlc tree",
  tagUnreadable: "unreadable",
  open: "Open",
  openThisFolder: "Open this folder",
  explorerEmpty: "No subfolders to show.",
  explorerHeading: "Browse folders",
  explorerRootsLabel: "Browse roots",
  breadcrumbLabel: "Current path",
  filterLabel: "Filter directory names in this folder",
  filterPlaceholder: "Filter folder names",
  filterClear: "Clear filter",
  showHidden: "Show hidden folders",
  hideHidden: "Hide hidden folders",
  filterNoMatch: "No folders match.",
  noWorkspacesFound: "No workspaces found.",
  foundSuffix: " found",
  scanned: (count) => `${count} folders scanned`,
  manualHeading: "Open by path",
  manualLabel: "Workspace path",
  manualButton: "Open workspace",
  manualNote: "A root path containing an <code>aidlc/</code> folder · <code>~</code> works",
  foundHeading: "Workspaces found",
  rescan: "Scan again",
  truncated: "The scan limit was reached. You can type a path directly above.",
  summaryPctLabel: "complete",
  summaryBlockersLabel: "blockers",
  summaryNoRunNone: "no run recorded",
  summaryNoRunAmbiguous: "several intents · no active cursor",
  summaryNoRunArchived: (count) => `only archived intents (${count}) · none active`,
  summaryUnreadable: "cannot read state.md",
  summaryFailed: "could not load",
  summaryProgressTip: (done, total, asOf) =>
    `${done}/${total} per state.md · updated ${asOf} (stamped at transitions, so it trails mid-stage)`,
  summaryBlockersTip: (asked) => `unanswered out of ${asked} asks · read from disk just now`,
  summaryBlockersUnreadableTip: (n) => `a floor: ${n} questions path(s) could not be read`,
  footer: (path) => `Current workspace · <code>${path}</code> ·
         <a href="/">Back to the dashboard</a>`,
};

const usage: UsageStrings = {
  windowLong7d: "last 7 days",
  windowLong30d: "last 30 days",
  windowLongAll: "all time",
  window7d: "7d",
  window30d: "30d",
  windowAll: "all",
  trendToggleLabel: "Trend period",
  tokenToggleLabel: "Aggregation period",

  creditSection: "Credit",
  statusLoading: "collecting",
  statusOk: "ok",
  statusPartial: "partial data",
  statusFailure: "collection failed",
  statusNone: "no data",
  rowPlan: "plan",
  rowUsed: "used",
  rowRemaining: "remaining",
  rowLimit: "plan limit",
  rowRatio: "usage",
  ratioUnavailable: "usage cannot be computed",
  ratioLabel: (pct) => `usage ${pct}`,
  fetchFailed: (reason) =>
    `Could not fetch the latest data (${reason}). What follows is the last successful reading.`,
  rawSummary: "Show the raw failure output",
  rawEmpty: "(no output)",
  stalePill: "stale data",
  firstCollection: "Collecting credit usage for the first time.",
  noCreditYet: "No credit data has been collected yet. It will appear here once collection runs.",
  staleNote: "More than 10 minutes since the last success — these figures may not be current.",
  pollHalted: (failures, retryEvery) =>
    `After ${failures} consecutive failures the automatic collection period was widened to ${retryEvery} minutes, so a broken upstream is not polled every five minutes. The figures below are the last success; one successful collection restores the normal period. The refresh button retries immediately.`,
  pollHaltedReason: (reason) => `Last failure: ${reason}`,
  lastSuccess: (at) => `Last success: ${at}`,
  chartEmpty: (w) => `Cumulative usage trend, ${w}: no data to show`,
  chartSummary: (w, min, max, latest) =>
    `Cumulative usage trend, ${w}: min ${min}, max ${max}, latest ${latest}`,
  chartNoData: "No data to show",

  tokenSection: "Token usage",
  tokenPartial: "partial count",
  rowTokenTotal: "total tokens",
  rowInput: "input",
  rowOutput: "output",
  rowThinking: "thinking (included in output)",
  rowCacheRead: "cache read",
  rowCacheCreate: "cache create",
  rowCachedPrompt: "prompt cache hit",
  rowCachedPromptTip:
    "cache read ÷ (input + cache read + cache create). The share of prompt tokens served from cache; output is not in the denominator.",
  rowSessions: "sessions",
  rowMessages: "API responses",
  colModel: "model",
  colShare: "share",
  tokenChartEmpty: (w) => `Daily token trend, ${w}: no data to show`,
  tokenChartSummary: (w, days, min, max, latest) =>
    `Daily token trend, ${w}: ${days} day${days === 1 ? "" : "s"}, min ${min}, max ${max}, latest ${latest}`,
  noTokens: "No Claude Code token usage was recorded in this window. Try widening it.",
  span: (range) => `Window: ${range}`,
  sidechain: (count) => `${count} subagent replies are included in the totals above.`,
  rowSessionWall: "session wall clock",
  rowSessionApi: "of which API",
  rowSessionTool: "of which tool execution",
  rowSessionCount: "sessions with a checkpoint",
  sessionCrossCheck:
    "Read from the checkpoints Claude Code writes per session. This is an independent source from the audit ledger the timing panel computes over, so it is a cross-check: where the two disagree, the audit ledger is authoritative. Sessions do not map onto stages, so this cannot be broken down per stage. A checkpoint is written mid-session, so this count can be lower than the `sessions` figure above — a session still running may not have written one yet.",
  sessionStraddling: (count) =>
    `${count} session(s) cross the window edge and are excluded from the totals above — the record is a per-session cumulative total, so it cannot be cut.`,
  sessionAllStraddling: (count) =>
    `No session fits entirely inside this window — ${count} cross its edge. Try a wider period.`,
  noteNoTranscripts: (triedPath) =>
    `No Claude Code transcripts found (${triedPath}). Either this workspace was never driven by Claude Code, or it ran from a different path.`,
  noteFilesCapped: (count) =>
    `${count} transcript file(s) were not read because of the byte cap — the figures below may be incomplete.`,
  noteUnreadableFiles: (count) => `${count} transcript file(s) could not be read.`,
  noteMalformedLines: (count) => `${count} malformed line(s) were skipped.`,
};

const errorPage: ErrorPageStrings = {
  docTitle: "AI-DLC dashboard",
  heading: "Cannot show this workflow",
  triedPathLabel: "Path read: ",
  checkThis: `Check that the <code>&lt;root&gt;/aidlc/active-space</code> and
<code>&lt;root&gt;/aidlc/spaces/&lt;space&gt;/intents/active-intent</code> cursors point at a record that exists.`,
  pickAnother: "Choose another folder",
  readFailed: (message) => `Read error: ${message}`,
  noSelection: "(nothing selected)",
  notAWorkspace: (dir) => `${dir} has no aidlc/ folder — it is not a workspace.`,
  noWorkspaceSelected: "No workspace selected.",
};

const cli: CliStrings = {
  needValue: (flag) => `${flag} needs a value`,
  mustBeNumber: (flag, raw) => `${flag} must be a number: ${raw}`,
  msFloor: (flag, floor, zeroOk, got) =>
    `${flag} is in milliseconds and must be at least ${floor}${zeroOk ? " (0 disables it)" : ""}: ${got}`,
  portRange: (max, got) => `--port must be between 1 and ${max}: ${got}`,
  needRoot: "--root needs a path",
  pathMissing: (path) => `No such path: ${path}`,
  notAWorkspace: (path) => `No aidlc/ directory — not an AI-DLC workspace root: ${path}`,
  harnessMissing: (path) => `The directory given to --harness does not exist: ${path}`,
  needUsage: "--usage needs a value (auto|kiro|claude)",
  badUsage: (raw) => `--usage must be one of auto|kiro|claude: ${raw}`,
  needLang: "--lang needs a value (ko|en)",
  badLang: (raw) => `--lang must be either ko or en: ${raw}`,
  unknownArg: (arg) => `Unknown argument: ${arg}`,
  noRootPicker: "No --root — choose a folder in the browser",
  bunTooOld: (have, floor) =>
    `bun ${have} is too old — ${floor} or later is required. Upgrade with bun upgrade, then run again.`,
  manualRefreshFailed: (detail) => `Manual refresh failed (isolated): ${detail}`,
  routeFailed: (route) => `${route} failed:`,
  creditBootFailed: (detail) =>
    `Credit subsystem failed to boot (the dashboard is still starting): ${detail}`,
  unhandled: "Unhandled error:",
  harnessNotFound: "not found",
  startupSummary: (audit, langDefault) => `audit ${audit} · lang ${langDefault} by default`,
  intentAmbiguous: (root) => `Several intents but no active-intent cursor: ${root}`,
  intentArchived: (root, count) =>
    `Only archived intents (${count}) — the engine does not pick one as the active intent either. Start new work, or point the active-intent cursor at an archived one to read it: ${root}`,
  noWorkflow: (root) => `No AI-DLC workflow found: ${root}`,
};

const openFile: OpenFileStrings = {
  badRel: "The path is empty or too long",
  badChars: "The path contains a character that is not allowed",
  outsideRecord: "A path outside the record folder cannot be opened",
  extension: (allowed) => `This extension cannot be opened (only ${allowed.join(" / ")})`,
  symlinkEscape: "The symlink points outside the record folder",
  notFound: "No such file",
  statFailed: "Cannot read the file's metadata",
  notAFile: "Not a regular file",
  platformUnsupported: (platform) =>
    `Opening files is not supported on this platform (${platform})`,
  interpreterMetachars: "The filename contains interpreter metacharacters — refused",
  openerMissing: (cmd) => `The open command ${cmd} was not found on PATH`,
  spawnFailed: (detail) => `Could not open: ${detail}`,
  spawnFailedLog: (cmd, detail) => `Could not open the file (${cmd}): ${detail}`,
  readFailed: (detail) => `Could not read the file: ${detail}`,
};

const viewer: ViewerStrings = {
  docTitle: (rel) => `${rel} — source`,
  back: "← Dashboard",
  openInEditor: "Open in editor",
  size: (bytes) => `${bytes}`,
  truncated: (shown, total) =>
    `Showing the first ${shown} of ${total}. Open the file in an editor to read the rest.`,
  refusalHeading: "Cannot show this source",
  empty: "This file is empty.",
};

const explorer: ExplorerStrings = {
  rootHome: "Home",
  rootCurrent: "Current",
  volume: (name) => `Volume ${name}`,
  mount: (name) => `Mount ${name}`,
  media: (name) => `Media ${name}`,
  browseFailed: (dir, message) => `Cannot open ${dir}: ${message}`,
};

const freshness: FreshnessStrings = {
  graphBehind: (lag, drift) =>
    `${lag} behind the audit ledger — this snapshot is only recompiled at a stage transition${drift ? `. ${drift}` : ""}`,
  graphUnreadable:
    "Could not read runtime-graph.json — units-generation not reached, or not synced",
  stageGraphMissing: "No stage-graph.json — artifact-contract judgements are skipped",
  sensorDrift: (fired, missing) =>
    `${missing} of the ${fired} sensor firings in the audit ledger are absent from this snapshot`,
};

const cards: CardStrings = {
  stageTitle: "Stage",
  unitTitle: "Unit",
  unresolvedTitle: "Unresolved",
  healthTitle: "Run Health",
  colStage: "stage",
  colWorkChat: "work+chat",
  workChatTip:
    "Time the audit ledger classifies as work (event-dense stretches and delegation) plus conversation (between human turns). Waiting on a human, parked time and unclassified gaps are left out",
  noStages: "No stages in this phase",
  colUnit: "unit",
  colArtifacts: "artifacts",
  cellLabel: {
    complete: "done",
    partial: "partial",
    unsettled: "no receipt",
    unverified: "unverifiable",
    absent: "not started",
    skipped: "skipped",
    "n/a": "n/a",
  },
  decisionsTab: "Open decisions",
  openQsTab: "Open questions",
  declaredTab: "Stage-declared",
  colItemOwner: "item → owner stage",
  colAge: "age",
  noDecisions: "No open decisions",
  noOpenQs: "No open questions",
  noDeclared: "No stage-declared open questions",
  notAllRead: "None in what could be read — the Unresolved panel names what was not",
  answersTab: "Your answers",
  stuckTab: "Stuck",
  checksTab: "Failed checks",
  summaryTab: "Summary",
  colAsk: "question · file",
  colWait: "waiting",
  colGuard: "stop hook",
  colCount: "blocks in a row",
  colCheck: "check · stage",
  colWhen: "when",
  moreRows: (n) => `+${n} more`,
  moreTimeline: "Open the full Gantt timeline",
  moreMatrix: "Open the stage × unit matrix",
  moreDeferrals: "Open the full list",
  drillsHeading: "Details",
  sourcesLabel: "Sources",
  sourceAge: (age) => `${age} ago`,
  sourceMissing: "no record",
  sourceStale: "stale",
  sourceNames: {
    disk: "files",
    audit: "audit",
    "state.md": "state.md",
    "runtime-graph": "runtime-graph",
    "hooks-health": "stop hook",
    "stage-graph": "stage-graph",
  },
};

const kpi: KpiStrings = {
  heading: "Key figures",
  progressLabel: "Progress",
  progressSub: (done, total) => `${done}/${total} stages · state.md`,
  usageLabel: "Usage",
  creditSub: (limit, pct) =>
    limit === undefined ? "Kiro credits · limit unknown" : `Kiro credits · ${pct} of ${limit}`,
  tokenSub: (window) => `Measured tokens, ${window} · no limit exists locally`,
  usageNone: "No usage recorded",
  timeLabel: "Work + chat",
  timeSub: (work, chat) => `work ${work} · chat ${chat} · audit`,
  timeExcluded: (unknown) => `${unknown} unclassified, not included`,
  timeTip:
    "Observed work time plus conversation time. Human waits, parked time, unclassified gaps and the stretch after the last event are left out. This is not elapsed wall-clock time.",
  personTime: (total, clones, concurrent, refused) =>
    (concurrent
      ? `${clones} clones worked at once — the figure is the team's; ${total} of person-time`
      : `${clones} clones worked in turn — the figure is the team's; ${total} of person-time`) +
    (refused > 0 ? ` (in the audit shards read; ${plural(refused, "audit path")} refused)` : ""),
  progressChartTitle: "Stages first completed, cumulative",
  progressChartNote:
    "Counts each stage slug once, at its first STAGE_COMPLETED in the audit. Construction's per-unit repeats and later re-runs are not reflected, so a reopened stage stays counted. The progress figure above is state.md's checkbox count, so the two can differ.",
  progressChartAria: (completed) => `Cumulative completed stages, ${completed} so far`,
  timeChartTitle: "Work + chat time per 6 hours",
  timeChartAria: (total, bins) =>
    `Work + chat time across ${bins} six-hour bins, ${total} in total`,
  binTip: (start, work, chat, wait, parked, unknown) =>
    `6 hours from ${start} — work ${work} · chat ${chat} · human wait ${wait} · parked ${parked} · unclassified ${unknown}`,
  legendWork: "work",
  legendChat: "chat",
  legendSilence: "since the last event",
  noEvents: "No audit events",
  noEventsPartial: (refused) => `No audit events read — ${plural(refused, "audit path")} refused`,
};

export const EN: Strings = {
  locale: "en",
  warn,
  blockers,
  status,
  overview,
  page,
  health,
  deferrals,
  timeline,
  picker,
  usage,
  errorPage,
  cli,
  openFile,
  viewer,
  explorer,
  freshness,
  cards,
  kpi,
};
