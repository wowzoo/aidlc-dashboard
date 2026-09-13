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
  CliStrings,
  DeferralStrings,
  ErrorPageStrings,
  ExplorerStrings,
  FreshnessStrings,
  HealthStrings,
  OpenFileStrings,
  OverviewStrings,
  PageStrings,
  PickerStrings,
  Strings,
  TimelineStrings,
  UsageStrings,
  ViewerStrings,
  WarnStrings,
} from "./i18n";
/**
 * What each `unverified` cause means. Split per cause because only ONE of them has a known
 * engine verdict: a row with no `Run floor` fails the engine's exact-match test, so the
 * engine WILL re-run that unit — calling that "not incomplete" would be the same kind of
 * over-claim this cell state exists to avoid.
 */
const RECEIPT_REASON_EN: Record<ReceiptReason, string> = {
  "no-run-floor":
    "Every artifact is present, but the completion receipt carries no `Run floor` — the engine treats this unit as uncovered and will run it again. Whether the work actually finished cannot be told from the audit ledger alone (a ledger written before the field existed)",
  "team-claim":
    "Every artifact is present, and the completion receipt is settled by the claim file (team ownership) — the audit ledger alone cannot say whether the engine considers this done. The Unit Progress table above is the authority",
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

  stateVersionMismatch: (stateVersion, harnessVersion, harnessDir) =>
    `state.md declares State Version ${stateVersion}, but the harness supports ${harnessVersion} (${harnessDir}/tools/aidlc-lib.ts) — the engine refuses next, report and doctor on this combination. Contract judgements cannot be made against a different generation, so they were withheld`,

  stateVersionUnreadable: (stateVersion) =>
    `Cannot read State Version from state.md (${stateVersion === undefined ? "field absent" : `value: ${stateVersion}`}) — the engine refuses a missing, empty or non-numeric value alike (aidlc-lib.ts classifyStateVersion). The artifact contract is still shown, but this page does not claim its completion judgements match the engine's`,

  teamWithoutUnitMajor: (constructionIteration) =>
    `Unit Ownership is team but Construction Iteration is not unit-major (${constructionIteration ?? "absent"}) — the engine contract requires both together, and only then does a Unit Progress table exist. Check the configuration`,

  unitProgressMalformed:
    "The `## Unit Progress` table in state.md is not in the shape the engine defines (the table does not start at column 0, or its first column is not `unit`, or the separator row's width differs from the header — the engine refuses it on the same conditions). Owner and per-unit gate are not shown",

  unitProgressMissing:
    "This is a team / unit-major run, but state.md has no `## Unit Progress` section — with no authoritative source for owner and per-unit gate, the matrix below is reconstructed from disk and the audit ledger",

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

  tokenUsageFailed: (detail) =>
    `Token usage assembly failed — only the usage panel is degraded: ${detail}`,

  creditAssemblyFailed: (detail) =>
    `Credit assembly failed — only the credit panel is degraded: ${detail}`,
};

const blockers: BlockerStrings = {
  title: "🚧 Blockers",
  currentStage: "current stage",
  staleStage: "earlier stage (parked question)",
  confirmation: "gate confirmation",
  confirmationTip:
    "Not a question but an approval-gate confirmation — the run proceeds only once you pick one of the engine's options or state what should change",
  waiting: (age) => `waiting ${age}`,
  none: "No unanswered questions.",
  ok: "clear",
  currentWaiting: (count) =>
    `The current stage is waiting on ${count} answer${count === 1 ? "" : "s"} — the workflow is stopped until it is given.`,
  staleOnly: (count) =>
    `The current stage is clear, but ${count} unanswered question${count === 1 ? "" : "s"} remain in earlier stages.`,
  viewTip: (rel) => `Read ${rel} in the dashboard`,
};

const overview: OverviewStrings = {
  sectionProgress: "Progress",
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
  noUnits: "No unit information — units-generation has not been reached.",
  noUnitsPill: "n/a",

  tipPartial: (missing) => `missing: ${missing.join(", ")}`,
  tipComplete: (present) => `complete: ${present.join(", ")}`,
  tipUnsettled: (present) =>
    `Every artifact is present but there is no completion receipt (UNIT_COMPLETED) — the unit may be paused, waiting to resume, or unapproved (files: ${present.join(", ")})`,
  tipUnverified: (reason, present) => `${RECEIPT_REASON_EN[reason]} (files: ${present.join(", ")})`,
  tipNotApplicable: (present) =>
    `Nothing is contracted for this unit's kind${present.length ? ` (files present: ${present.join(", ")})` : ""}`,
  tipNotStarted: "not started",

  legendBase:
    "\u2588 complete (receipt confirmed) · \u25a8 started, artifacts incomplete (hover a cell to see what is missing) · · not started",
  legendUnsettled:
    " · \u25a9 every artifact present but no completion receipt (UNIT_COMPLETED) — the engine treats this unit as uncovered too",
  legendUnverifiedNoFloor:
    " · \u25a4 the completion receipt cannot be checked from the audit ledger alone (hover a cell for the reason) — where a `Run floor` is missing, the engine treats the unit as uncovered and will run it again",
  legendUnverified:
    " · \u25a4 the completion receipt cannot be checked from the audit ledger alone — this is NOT a verdict that the work is incomplete (hover a cell for the reason)",
  legendNa:
    " · \u2013 nothing contracted for this unit's kind (the bracket in the total column is how many)",
  legendUnverifiedContract:
    "state.md's State Version could not be checked against the harness, so this is an <b>unverified contract</b> — the contract is shown as read, but this page does not warrant that its completion judgements match the engine's",
  legendNoContract: (receiptAware) =>
    `No stage-graph.json, so contract judgements are impossible — a cell means file presence${receiptAware ? " and the completion receipt" : ""} only`,
};

const page: PageStrings = {
  warningsHeading: "Read warnings",
  harnessNotFound: "not found",
  pickFolder: "📁 Change folder",
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
  chipUnassignedTip:
    "Prose, so there is no assignment cell — it stays an assumption until the user confirms it in that stage's questions file",
  chipFollowUp: "follow-up",
  chipFollowUpTip: "The sentence itself asks for a follow-up or a decision",
  chipOther: "other",
  chipOtherTip:
    "Filed under the open-questions section but with no follow-up wording in the sentence — the heading is the declaration, so it still counts",
  ledgersNote: `The three ledgers are <b>different reads</b> — only the first row has an assignment cell, and the
other two have nowhere assigned to ask them. <b>They are not summed.</b>`,
  noSections: (artifacts) =>
    `No artifact carries an <code>## Assumptions &amp; Open Questions</code> section — either this run left no
    open-item ledger, or it has not written artifacts yet. (${artifacts} artifact${artifacts === 1 ? "" : "s"} read)`,
  unreadSections: (sections, unread, emptySections) =>
    `${sections} artifact${sections === 1 ? "" : "s"} carry an <code>## Assumptions &amp; Open Questions</code>
      section, and <b>${unread} of them are in a shape this reader does not know</b> — no table
      (<code>| item | assigned |</code>), no <code>[assumption]</code> tag, and no <code>**OQ1**</code>-style ledger id.
      <b>That does not mean there are no open items; it means they were not read.</b>
      ${emptySections} section${emptySections === 1 ? "" : "s"} declared <code>None.</code> explicitly.`,
  noOpenPill: "no open items",
  noOpenPillTip: "The ledger section is present and empty — an explicit declaration of 'none'",
  allNone: (sections) =>
    ` Every open-item ledger across ${sections} artifact${sections === 1 ? "" : "s"} reads <code>None.</code>`,
  lead: (items, sections, rows, exits) =>
    `<b>${items}</b> open item${items === 1 ? "" : "s"} · ${sections} artifact${sections === 1 ? "" : "s"} carry an
  <code>## Assumptions &amp; Open Questions</code> ledger (${rows} raw row${rows === 1 ? "" : "s"} → ${items} after de-duplication)${
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
  },
  segmentTip: (stage, endKind, from, to, split) =>
    `${stage} — ${endKind}\n${from} → ${to}\n${split}`,
  splitLine: (wait, parked, observed, conversation, unknown) =>
    `user wait ${wait}min · parked ${parked}min · observed ${observed}min · conversation ${conversation}min · unclassified ${unknown}min`,
  zeroSecondTip: "0s — started and completed in the same second",
  loadArtifacts: (n) => `artifacts ${n}`,
  loadFailures: (n) => `failed ${n}`,
  loadDelegations: (n) => `delegated ${n}`,
  loadHumanTurns: (n) => `human ${n}`,
  noStageSpans: "The audit ledger holds no stage spans.",

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
  awaiting: (stage) => `awaiting approval: <b>${stage}</b>`,
  awaitingNone:
    'no stage awaiting approval<span class="mute"> (nothing is waiting at a gate right now — past submissions are in the rework table below)</span>',
  reworkPending: " · a stage is rejected and not yet re-approved",
  mergedNote: (workers, clones) =>
    `${workers} ledger${workers === 1 ? "" : "s"} (${clones} clone${clones === 1 ? "" : "s"}) merged — the breakdown above is
       a <b>team-wide</b> figure over every record on one line. For per-person time see <b>per-worker breakdown</b>.`,
  axisSilenceTip: (silence) =>
    `${silence} since the last event — unrecorded, so it is left unclassified`,

  reworkSummary: (rejected, h) =>
    `Rework — ${rejected} rejection${rejected === 1 ? "" : "s"} · ${h}`,
  reworkNone: "No rejections or revisions — every gate passed first time.",
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
  unitColumnNote: `⚠️A clone showing "—" for units has an <code>Output path</code> in the ledger that is a code path
  rather than an artifact, so the unit cannot be traced back — only the stage it worked on is certain.`,
};

const picker: PickerStrings = {
  docTitle: "Choose an AI-DLC workspace",
  heading: "Choose a workspace",
  currentMark: "current",
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
  summaryUnreadable: "cannot read state.md",
  summaryFailed: "could not load",
  summaryProgressTip: (done, total, asOf) =>
    `${done}/${total} per state.md · updated ${asOf} (stamped at transitions, so it trails mid-stage)`,
  summaryBlockersTip: (asked) => `unanswered out of ${asked} asks · read from disk just now`,
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
  gaugeUnavailable: "usage cannot be computed",
  gaugeUnavailableShort: "n/a",
  gaugeLabel: (pct) => `usage ${pct}`,

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
  rowMessages: "assistant messages",
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
    `The transcripts are large, so ${count} older file(s) were not read — the figures below under-count by that much.`,
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
  manualRefreshFailed: (detail) => `Manual refresh failed (isolated): ${detail}`,
  routeFailed: (route) => `${route} failed:`,
  creditBootFailed: (detail) =>
    `Credit subsystem failed to boot (the dashboard is still starting): ${detail}`,
  unhandled: "Unhandled error:",
  harnessNotFound: "not found",
  startupSummary: (audit, langDefault) => `audit ${audit} · lang ${langDefault} by default`,
  intentAmbiguous: (root) => `Several intents but no active-intent cursor: ${root}`,
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

export const EN: Strings = {
  locale: "en",
  warn,
  blockers,
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
};
