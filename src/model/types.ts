// The view-model the renderers consume, and the provenance record every panel
// carries.
//
// WHY PROVENANCE IS A FIRST-CLASS FIELD. The four sources this dashboard reads
// have genuinely different freshness, and mixing them without saying so produces
// confident wrong numbers:
//
//   disk         live at read time
//   audit        live, but only as live as the hooks that append to it
//   state.md     rewritten at each transition; carries its own Last Updated
//   runtime-graph recompiled ONLY at stage transitions — measured 19h behind the
//                audit on a real in-flight run, under-reporting 6 stages
//
// So a panel says where its numbers came from and how old they are, and a stale
// source is called stale on screen rather than quietly averaged in.

import type { TokenViewModel } from "../credit/claude/token-model";
import type { CreditViewModel } from "../credit/view/credit-model";
import type { StageArtifact } from "../scan/artifacts";
import type { DeferralReport } from "../scan/deferrals";
import type { HealthReport } from "../scan/hooks-health";
import type { ConstructionMatrix } from "../scan/matrix";
import type { DiaryReport } from "../scan/memory-diary";
import type { AidlcState } from "../scan/parser";
import type { AskKind, QuestionsReport } from "../scan/questions";
import type { ReworkReport } from "../scan/rework";
import type { SensorReport } from "../scan/sensors";
import type { TimingReport } from "../scan/timing";

/** Where a number came from. */
export type SourceKind =
  | "disk"
  | "audit"
  | "state.md"
  | "runtime-graph"
  | "hooks-health"
  | "stage-graph";

/** Freshness of one source, resolved at assembly time. */
export interface Provenance {
  source: SourceKind;
  /** ISO timestamp the source last changed (embedded field preferred over mtime). */
  asOf?: string;
  /** Seconds between `asOf` and the assembly clock. Undefined when asOf is. */
  ageSec?: number;
  /** True when this source is known to lag another that corroborates it. */
  stale: boolean;
  /**
   * Why, as a CODE AND ITS FACTS. Only set when stale.
   *
   * A sentence here would be prose in the model, the same defect `Warning` records — and
   * it reaches `/api/model`, so a consumer had to substring-match a Korean paragraph to
   * learn that the graph was merely lagging. `render/i18n` says it; this names it.
   */
  staleReason?: StaleReason;
}

export type StaleReason =
  | { code: "graph-behind"; lagSec: number; sensorDrift?: { fired: number; missing: number } }
  | { code: "graph-unreadable" }
  | { code: "stage-graph-missing" };

/** Identity of the run being shown. */
export interface RunIdentity {
  /** Workspace root passed on the command line. */
  root: string;
  /** Active space name. */
  space: string;
  /** Intent record dir name. */
  record: string;
  /** Record-relative path of the state file, for display. */
  stateRel: string;
  /**
   * Absolute path of the intent record dir. NOT for display — this is the jail
   * the /open endpoint resolves artifact paths against, so a click can never
   * reach a file outside the record being shown.
   */
  recordDir: string;
  /**
   * Harness dir the stage catalogue was read from (".kiro" / ".claude" /
   * ".aidlc" / …), or undefined when none was found. Display-only: the dashboard
   * reads the `aidlc/` docs tree, which is the same on every harness, so this
   * says which engine install happens to sit beside it — not what is supported.
   */
  harnessDir?: string;
  /** Registry metadata for this intent, when intents.json listed it. */
  slug?: string;
  scope?: string;
  status?: string;
}

/** The unanswered-question blocker, lifted to the top of the model. */
export interface Blocker {
  /** Stage the question belongs to. */
  stage: string;
  /** Unit of work, for a per-unit Construction question. */
  unit?: string;
  /** Question heading, e.g. "Q1 — Plan Approval". */
  heading: string;
  /** `confirmation` for a gate heading with no `Q<n>` id — see scan/questions.ts. */
  kind: AskKind;
  /** Record-relative path of the questions artifact. */
  rel: string;
  /** When the artifact was last written — how long the ask has been open. */
  since: string;
  /** Seconds outstanding at assembly time. */
  waitingSec?: number;
  /** True when this question belongs to the stage the engine is currently on. */
  isCurrentStage: boolean;
}

/** Approval-gate ledger. */
export interface GateSummary {
  approved: number;
  rejected: number;
  /** `Revision Count` from state.md — rework the run absorbed. */
  revisionCount?: number;
  /** Stage sitting at an approval gate right now, per the audit. */
  awaitingStage?: string;
  jumps: number;
}

/**
 * Which usage panel to show. `auto` resolves from the harness dir the workspace
 * carries; `kiro`/`claude` pin it.
 *
 * Why an override exists rather than harness detection alone: the two providers
 * measure different things (Kiro reports a remote quota, Claude Code reports
 * local token counts), and a dev tree can hold `.kiro` and `.claude` side by
 * side — in which case catalogue probe order, not the reader's intent, would pick
 * the panel. `auto` still does the obvious thing; the flag exists for the tree
 * where the obvious thing is ambiguous.
 */
export type UsageMode = "auto" | "kiro" | "claude";

/**
 * Reading language of the rendered page. Two values, because the audience splits
 * Korean / non-Korean and English serves the second as a lingua franca — this is
 * not a list of regional locales, and `ko-KR` vs `ko` is not a distinction anyone
 * reading this dashboard is making.
 *
 * It lives HERE, beside `UsageMode`, only because that is where this repo keeps the
 * closed unions the CLI parses. It is NOT part of `DashboardModel` and `assemble`
 * never sees it — see the header of `render/locale.ts` for why.
 */
export type Locale = "ko" | "en";

/**
 * A non-fatal reading problem, as a CODE AND ITS FACTS — never as a sentence.
 *
 * WHY THIS IS NOT A STRING. It was, and that put eleven Korean paragraphs inside
 * `assemble`, which is the same rule this repo already broke once and wrote down:
 * `byOwner` stood a missing stage up as `` `(${status})` ``, a display string built in
 * the scan layer, and it printed an English `(unassigned)` on a Korean screen. The fix
 * there was "the scan layer names nothing it does not read from the tree"; these
 * warnings were the 11 places still exempt from it.
 *
 * Three things follow, and only one of them is about translation:
 *
 *   - `/api/model` stops carrying prose. A consumer gets `code` + facts and can act on
 *     it; before, it got a paragraph in one language and had to substring-match.
 *   - The TESTS stop matching on copy. Fifteen assertions did
 *     `warnings.some(w => w.includes("절이 없습니다"))`, so rewording a sentence broke
 *     the suite while a wrong CODE passed silently. They assert codes now.
 *   - And a second language becomes a table lookup rather than an edit to `assemble`.
 *
 * The union is closed and `render/warnings.ts` switches on it exhaustively, so adding a
 * member without giving it copy is a typecheck failure rather than a blank line on
 * screen.
 */
export type Warning =
  | { code: "catalog-read-failed"; harnessDir: string }
  | { code: "catalog-not-found" }
  | { code: "audit-empty" }
  /** All three are REQUIRED: the harness version is read off the catalogue, so a
   *  mismatch can only be detected when the catalogue — and its dir — is in hand.
   *  `harnessDir?` let the sentence print `(undefined/tools/aidlc-lib.ts)`, which the
   *  copy test caught; the type says it cannot happen instead of a fallback hiding it. */
  | {
      code: "state-version-mismatch";
      stateVersion: string;
      harnessVersion: string;
      harnessDir: string;
    }
  /** `stateVersion` absent = the field was missing; present = it was there and unusable. */
  | { code: "state-version-unreadable"; stateVersion?: string }
  | { code: "team-without-unit-major"; constructionIteration?: string }
  | { code: "unit-progress-malformed" }
  | { code: "unit-progress-missing" }
  | {
      code: "roster-mismatch";
      stateVersion?: string;
      unknownToCatalog: string[];
      missingFromState: string[];
    }
  | { code: "harness-coexist"; harnesses: string[]; chosen: "kiro" | "claude" }
  | { code: "token-usage-failed"; detail: string }
  | { code: "credit-assembly-failed"; detail: string };

/**
 * The usage panel, discriminated by provider. A union rather than two optional
 * fields: exactly one provider is shown, and the type should not be able to say
 * otherwise.
 *
 * `kiro` carries the credit/quota view (u3 `CreditViewModel`, fed by the polled
 * `kiro-cli /usage` snapshots). `claude` carries the token view, aggregated from
 * local Claude Code transcripts — no quota exists there, so the panel reports
 * measured tokens instead of a percentage of an unknown limit.
 */
export type UsageView =
  | { kind: "kiro"; credit: CreditViewModel }
  | { kind: "claude"; tokens: TokenViewModel };

/** Everything the page needs. Serialised verbatim as /api/model. */
export interface DashboardModel {
  /** ISO timestamp of this assembly — the clock all ages are relative to. */
  generatedAt: string;
  identity: RunIdentity;
  state: AidlcState;
  matrix?: ConstructionMatrix;
  sensors: SensorReport;
  questions: QuestionsReport;
  diaries: DiaryReport;
  /**
   * Decisions the run put off, and where each is scheduled to be asked again.
   * Separate from `diaries` (what the orchestrator thought) and from `blockers`
   * (a blank `[Answer]:`): a run can have zero blockers and still carry hundreds
   * of these, which is exactly the case the reader cannot otherwise see.
   */
  deferrals: DeferralReport;
  health: HealthReport;
  timing: TimingReport;
  blockers: Blocker[];
  gates: GateSummary;
  /**
   * How much of the run was done over again. Separate from `gates`, which only
   * counts the events: this pairs each rejection with the approval that closed it
   * and carries the human reasons.
   */
  rework: ReworkReport;
  /**
   * Usage view for the top-of-page panel. Always present — a run with no usage
   * data degrades to an empty view of the resolved kind rather than an absent
   * slot, so the renderer never has to guard for it.
   */
  usage: UsageView;
  /** Audit event counts by type, for the stream filter. */
  eventCounts: [string, number][];
  /** Newest audit events, for the stream panel (bounded — see assemble.ts). */
  recentEvents: {
    ts: string;
    event: string;
    stage?: string;
    unit?: string;
    detail?: string;
    shard: string;
  }[];
  /** Total events in the ledger, so a truncated stream can say so. */
  totalEvents: number;
  /** Freshness per source, keyed by source kind. */
  provenance: Record<SourceKind, Provenance>;
  /** Non-fatal problems hit while reading (missing catalogue, unreadable file). */
  warnings: Warning[];
  /**
   * Files each stage produced, keyed by the same identity the overview renders:
   * `<phase>/<slug>` for ordinary stages, `construction/<unit>/<slug>` for the
   * per-unit Construction copies (the slug alone repeats once per Bolt, so it is
   * not a key). Absent key = we never scanned that stage; empty array = we did
   * and it had nothing, which is why the toggle can be disabled honestly.
   */
  artifacts: Record<string, StageArtifact[]>;
}
