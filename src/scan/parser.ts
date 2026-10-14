// Parser for aidlc-docs/aidlc-state.md — the single source of truth for
// AI-DLC progress. The parsing rules here are ported verbatim from the
// verified aidlc-statusline.ts hook (extractField / phaseProgress / the
// STAGE_DISPLAY map), so what the status line shows and what this panel
// shows stay in lockstep. No speculative fields — v1 reads state only.

/** Canonical lifecycle phase order and display names. */
export const PHASE_ORDER = [
  "initialization",
  "ideation",
  "inception",
  "construction",
  "operation",
] as const;

export type PhaseKey = (typeof PHASE_ORDER)[number];

export const PHASE_DISPLAY: Record<PhaseKey, string> = {
  initialization: "Initialization",
  ideation: "Ideation",
  inception: "Inception",
  construction: "Construction",
  operation: "Operation",
};

/**
 * Stage slug → display name, for a workspace with NO catalogue. Mirrors STAGE_DISPLAY
 * in aidlc-statusline.ts.
 *
 * This is the fallback, not the source: a hardcoded roster of the engine's stages goes
 * stale by construction, and it had. v2.7 renamed `application-design` to
 * `domain-design` and added `contract-design`, so on a real run parked at
 * **domain-design** the panel printed the current stage as raw kebab-case beside
 * "Refined Mockups" — while still carrying the retired name. `stageDisplay()` asks the
 * workspace's own `stage-graph.json` first for that reason; the retired entry stays
 * because an older tree can still hold it in `aidlc-state.md`.
 */
export const STAGE_DISPLAY: Record<string, string> = {
  "workspace-scaffold": "Workspace Scaffold",
  "workspace-detection": "Workspace Detection",
  "state-init": "State Init",
  "intent-capture": "Intent Capture",
  "market-research": "Market Research",
  feasibility: "Feasibility",
  "scope-definition": "Scope Definition",
  "team-formation": "Team Formation",
  "rough-mockups": "Rough Mockups",
  "approval-handoff": "Approval & Handoff",
  "reverse-engineering": "Reverse Engineering",
  "practices-discovery": "Practices Discovery",
  "requirements-analysis": "Requirements Analysis",
  "user-stories": "User Stories",
  "refined-mockups": "Refined Mockups",
  // Retired in v2.7 (→ domain-design). Kept so an older tree still reads.
  "domain-design": "Domain Design",
  "contract-design": "Contract Design",
  "units-generation": "Units Generation",
  "delivery-planning": "Delivery Planning",
  "functional-design": "Functional Design",
  "nfr-requirements": "NFR Requirements",
  "nfr-design": "NFR Design",
  "infrastructure-design": "Infrastructure Design",
  "code-generation": "Code Generation",
  "build-and-test": "Build and Test",
  "ci-pipeline": "CI Pipeline",
  "deployment-pipeline": "Deployment Pipeline",
  "environment-provisioning": "Env Provisioning",
  "deployment-execution": "Deployment Execution",
  "observability-setup": "Observability Setup",
  "incident-response": "Incident Response",
  "performance-validation": "Performance Validation",
  "feedback-optimization": "Feedback & Optimization",
};

/**
 * A slug with no name anywhere: `nfr-design` → `Nfr Design`. Never leave raw kebab-case
 * on screen beside title-cased siblings — that is how a missing table entry reads as a
 * different KIND of thing rather than as a missing name.
 */
function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Display name for a stage slug, most authoritative source first:
 *
 *   1. the workspace's own `stage-graph.json` (regenerated per harness release, so it
 *      cannot go stale and it knows stages this file has never heard of),
 *   2. STAGE_DISPLAY, for a tree with no harness dir — the common case for a sync copy,
 *   3. the title-cased slug.
 */
export function stageDisplay(
  slug: string,
  fromCatalog?: (slug: string) => string | undefined,
): string {
  return fromCatalog?.(slug) ?? STAGE_DISPLAY[slug] ?? titleCase(slug);
}

// Agent slug → display name. Mirrors the *.md frontmatter display_name values
// in the v2 ruleset (kiro-ide/agents). The orchestrator pseudo-agent has no
// agent file but can appear as Active Agent during orchestrator transitions.
export const AGENT_DISPLAY: Record<string, string> = {
  orchestrator: "Orchestrator",
  "aidlc-architect-agent": "Architect Agent",
  "aidlc-architecture-reviewer-agent": "Architecture Reviewer",
  "aidlc-aws-platform-agent": "AWS Platform Agent",
  "aidlc-compliance-agent": "Compliance Agent",
  "aidlc-delivery-agent": "Delivery Agent",
  "aidlc-design-agent": "Design Agent",
  "aidlc-developer-agent": "Developer Agent",
  "aidlc-devsecops-agent": "DevSecOps Agent",
  "aidlc-operations-agent": "Operations Agent",
  "aidlc-pipeline-deploy-agent": "Pipeline & Deploy Agent",
  "aidlc-product-agent": "Product Agent",
  "aidlc-product-lead-agent": "Product Lead",
  "aidlc-quality-agent": "Quality Agent",
};

// Stage checkbox status. Codes documented inline in aidlc-state.md:
//   [ ] not started, [-] in progress, [?] awaiting approval (gate open),
//   [R] revising (user rejected gate), [x] completed, [S] skipped.
// A "[ ] ... — SKIP" line (scope-excluded stage) is also treated as skipped.
export type StageStatus = "pending" | "active" | "awaiting" | "revising" | "done" | "skipped";

export interface StageInfo {
  slug: string;
  display: string;
  status: StageStatus;
  /** false when the scope marker is SKIP (excluded from this run). */
  execute: boolean;
}

export interface PhaseInfo {
  key: string;
  display: string;
  /** From the "## Phase Progress" section: Active | Pending | Verified | Skipped. */
  declaredStatus: string;
  stages: StageInfo[];
  /** Completed executable stages. */
  done: number;
  /** Total executable (non-skipped) stages. */
  total: number;
  /** 0–100, or null when the phase is fully skipped (no executable stages). */
  pct: number | null;
  skipped: boolean;
}

export interface AidlcState {
  project: string;
  projectType: string;
  /**
   * `State Version` verbatim, or undefined when the field is missing. The engine's
   * `classifyStateVersion()` refuses a state whose version does not match the compiled
   * graph — v2.7 (version 8) renamed `application-design` to `domain-design` and added
   * `contract-design`, so a pre-v8 file's stage rows no longer match. This reader does
   * not enforce a number (that would go stale exactly as STAGE_DISPLAY did); assemble
   * cross-checks the ROSTER against the catalogue instead. The field is carried so the
   * screen can state what the tree declares.
   */
  stateVersion?: string;
  /**
   * `Unit Ownership` / `Construction Iteration`, and whether the state carries the
   * engine-owned `## Unit Progress` projection. Read but NOT interpreted: in
   * `team` + `unit-major` that table — not the disk — is the authority for owner,
   * receipt, review, gate and merged state. Carried so `assemble` can say the panel is
   * not reading it rather than quietly showing a reconstruction. See CLAUDE.md.
   */
  unitOwnership?: string;
  constructionIteration?: string;
  /** `Construction Checkpoints` (`enabled` turns on per-unit checkpoints). */
  constructionCheckpoints?: string;
  /** `Skeleton Stance` (`on` / `off` / `scope-dependent`) — which checkpoint the first unit stops at. */
  skeletonStance?: string;
  hasUnitProgress: boolean;
  /**
   * The engine's `## Runtime State` cache of where the run is held (2.11 aidlc-state.ts):
   * the active unit and the stage it is on — under unit-major NOT `Current Stage`, which
   * stays on the first per-unit stage — and a park. Present only when written. See
   * scan/run-position.ts.
   */
  runtime: RuntimeFields;
  /** The parsed `## Unit Progress` table, when the state carries one. */
  unitProgress?: UnitProgress;
  scope: string;
  /**
   * `Plan` — present only when a plan was composed for this piece of work (its name as
   * the gate showed it, or `tailored plan`); the stage list then differs from the
   * scope's defaults, which is why the page says so. Empty when absent.
   */
  plan: string;
  lifecyclePhase: string;
  currentStage: string;
  currentStageDisplay: string;
  nextStage: string;
  status: string;
  activeAgent: string;
  activeAgentDisplay: string;
  lastUpdated: string;
  /**
   * `Revision Count` from the Runtime State section — how many times a gate was
   * rejected and a stage sent back. Empty string when the field is absent.
   * Read for the dashboard specifically: rework volume is a quality signal no
   * other panel carries.
   */
  revisionCount: string;
  phases: PhaseInfo[];
  overallDone: number;
  overallTotal: number;
  overallPct: number;
  /** True when the workflow Status field reads Completed / Complete. */
  complete: boolean;
}

// Match the Markdown list field pattern used throughout aidlc-state.md:
//   - **Lifecycle Phase**: IDEATION
// Anchored on "^-\s*\*\*LABEL\*\*:" so prose lines that merely contain the
// label cannot hijack the value. Ported from aidlc-statusline.ts:extractField.
function extractField(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^-\\s*\\*\\*${escaped}\\*\\*:[^\\S\\n]*([^\\n]*)`, "m");
  const m = text.match(re);
  return m?.[1] !== undefined ? m[1].replace(/\r$/, "").trim() : "";
}

function stageStatusFromBox(box: string, isSkipMarker: boolean): StageStatus {
  if (box === "x") return "done";
  if (box === "-") return "active";
  if (box === "?") return "awaiting";
  if (box === "R") return "revising";
  if (box === "S") return "skipped";
  // box === " " (or anything else): pending, unless scope-excluded.
  return isSkipMarker ? "skipped" : "pending";
}

/**
 * Parse the "## Phase Progress" section into a phaseKey → declared status map.
 * Lines look like: `- **Initialization**: Active`.
 */
function parseDeclaredPhaseStatus(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^-\s*\*\*([A-Za-z]+)\*\*:\s*([A-Za-z]+)/gm;
  // Restrict to the Phase Progress section to avoid colliding with other
  // bold-list fields (Project, Scope, …) elsewhere in the document.
  const section = sliceSection(text, "## Phase Progress");
  let m = re.exec(section);
  while (m !== null) {
    const key = m[1]!.toLowerCase();
    if ((PHASE_ORDER as readonly string[]).includes(key)) {
      out[key] = m[2]!;
    }
    m = re.exec(section);
  }
  return out;
}

/** Return the text from a "## Heading" up to the next "## " heading. */
function sliceSection(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const after = start + heading.length;
  const next = text.indexOf("\n## ", after);
  return next < 0 ? text.slice(after) : text.slice(after, next);
}

/**
 * Parse the "## Stage Progress" section into per-phase stage lists, grouped by
 * the `### XXX PHASE` sub-headings. Stage lines look like:
 *   - [x] workspace-scaffold — EXECUTE
 *   - [ ] reverse-engineering — SKIP
 */
export function parseStages(
  text: string,
  catalogName?: (slug: string) => string | undefined,
  /** The scope's own action for a stage, for a row with no `— EXECUTE|SKIP` suffix. */
  scopeAction?: (slug: string) => "EXECUTE" | "SKIP" | undefined,
): Map<string, StageInfo[]> {
  const byPhase = new Map<string, StageInfo[]>();
  const lines = text.split(/\r?\n/);
  let current: string | null = null;
  // The box and the slug; the action is read from the em-dash suffix below.
  const stageRe = /^-\s*\[(.)\]\s*([a-z0-9-]+)/;
  for (const line of lines) {
    const head = line.match(/^###\s+([A-Za-z]+)\s+PHASE/i);
    if (head) {
      current = head[1]!.toLowerCase();
      if (!byPhase.has(current)) byPhase.set(current, []);
      continue;
    }
    if (line.startsWith("## ")) current = null; // left the Stage Progress block
    if (!current) continue;
    const m = line.match(stageRe);
    if (!m) continue;
    const box = m[1]!;
    const slug = m[2]!;
    // The engine reads the ACTION after the em dash (`parseStateStageSuffixes`:
    // `— (EXECUTE|SKIP)\b`), not the word anywhere on the line — `— EXECUTE: do not SKIP
    // the review` is an executed stage — and, for a row with no suffix, the scope's own
    // action from the compiled grid (`suffix ?? mapping.stages[slug]`). With neither
    // (no catalogue, or a scope the grid does not know) the row reads as executing.
    const suffix = /—\s*(EXECUTE|SKIP)\b/.exec(line)?.[1];
    const isSkipMarker = (suffix ?? scopeAction?.(slug)) === "SKIP";
    byPhase.get(current)?.push({
      slug,
      display: stageDisplay(slug, catalogName),
      status: stageStatusFromBox(box, isSkipMarker),
      execute: !isSkipMarker,
    });
  }
  return byPhase;
}

/** Title-case a kebab-case unit slug: "study-session" → "Study Session". */
export function displayFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w ? w[0]?.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** `## Runtime State` fields that say where the run is held. Empty string = not written. */
export interface RuntimeFields {
  activeUnit: string;
  unitStage: string;
  /** `in-progress` or `paused` — the only two values the engine writes. */
  unitState: string;
  unitPauseReason: string;
  unitNextAction: string;
  /** ISO timestamp of the park, when parked. */
  parked: string;
  parkedAtStage: string;
  /** `person` for an attended park; otherwise the line is absent. */
  parkedBy: string;
  /** Only the exact value `autonomous` counts (`isAutonomousMode`). Often absent. */
  autonomyMode: string;
}

function readRuntimeFields(text: string): RuntimeFields {
  return {
    activeUnit: extractField(text, "Active Unit"),
    unitStage: extractField(text, "Unit Stage"),
    unitState: extractField(text, "Unit State"),
    unitPauseReason: extractField(text, "Unit Pause Reason"),
    unitNextAction: extractField(text, "Unit Next Action"),
    parked: extractField(text, "Parked"),
    parkedAtStage: extractField(text, "Parked At Stage"),
    parkedBy: extractField(text, "Parked By"),
    autonomyMode: extractField(text, "Construction Autonomy Mode"),
  };
}

/** `tools/data/scope-grid.json`: per scope, each stage's plan action. */
export type ScopeGrid = Record<string, Record<string, "EXECUTE" | "SKIP">>;

export function parseState(
  text: string,
  /**
   * Name lookup from the workspace's own stage catalogue, when one was found. Passing
   * it makes the display names come from the tree being read rather than from this
   * file's snapshot of the engine — see `stageDisplay`.
   */
  catalogName?: (slug: string) => string | undefined,
  /** The compiled scope grid (`scope → slug → action`), for rows with no suffix. */
  scopeGrid?: ScopeGrid,
): AidlcState {
  const project = extractField(text, "Project");
  const projectType = extractField(text, "Project Type");
  const stateVersion = extractField(text, "State Version");
  const unitOwnership = extractField(text, "Unit Ownership");
  const constructionIteration = extractField(text, "Construction Iteration");
  const constructionCheckpoints = extractField(text, "Construction Checkpoints");
  const skeletonStance = extractField(text, "Skeleton Stance");
  // `## Unit Progress` is an engine-owned projection present only in team/unit-major.
  const unitProgress = parseUnitProgress(text);
  const hasUnitProgress = unitProgress !== undefined;
  const scope = extractField(text, "Scope");
  const plan = extractField(text, "Plan");
  const lifecyclePhase = extractField(text, "Lifecycle Phase");
  const currentStage = extractField(text, "Current Stage");
  const nextStage = extractField(text, "Next Stage");
  const status = extractField(text, "Status");
  const activeAgent = extractField(text, "Active Agent");
  const lastUpdated = extractField(text, "Last Updated");
  const revisionCount = extractField(text, "Revision Count");

  const declared = parseDeclaredPhaseStatus(text);
  // The grid row for THIS state's scope; an unknown scope gives no default, as the
  // engine's `loadScopeMapping()[scope]` gives none.
  const grid = scopeGrid?.[extractField(text, "Scope")];
  const stagesByPhase = parseStages(text, catalogName, grid ? (slug) => grid[slug] : undefined);

  const phases: PhaseInfo[] = [];
  let overallDone = 0;
  let overallTotal = 0;

  for (const key of PHASE_ORDER) {
    const stages = stagesByPhase.get(key) ?? [];
    if (stages.length === 0 && !(key in declared)) continue; // phase absent
    // A skipped stage leaves the denominator however the skip was expressed. Two
    // shapes mean it: `— SKIP` (scope-excluded, so `execute` is false) and the `[S]`
    // checkbox (in scope, but the run skipped it — the audit carries a matching
    // STAGE_SKIPPED). Only the first used to be excluded, so a run that skipped a
    // stage at runtime could never reach 100%: measured on a real run, overall read
    // 20/25 = 80% with `[S] market-research — EXECUTE` outstanding forever, while
    // its own Ideation phase read 86% though state.md declared that phase Verified.
    // Dropping both kinds gives 20/24 = 83% overall and Ideation 100%, which agrees
    // with the engine's own verdict.
    const executable = stages.filter((s) => s.execute && s.status !== "skipped");
    const total = executable.length;
    const done = executable.filter((s) => s.status === "done").length;
    const declaredStatus = declared[key] ?? "";
    const skipped =
      declaredStatus.toLowerCase() === "skipped" || (total === 0 && stages.length > 0);
    overallDone += done;
    overallTotal += total;
    phases.push({
      key,
      display: PHASE_DISPLAY[key],
      declaredStatus,
      stages,
      done,
      total,
      pct: total > 0 ? Math.round((done * 100) / total) : null,
      skipped,
    });
  }

  const overallPct = overallTotal > 0 ? Math.round((overallDone * 100) / overallTotal) : 0;
  const complete = status === "Completed" || status === "Complete";

  return {
    project,
    projectType,
    ...(stateVersion ? { stateVersion } : {}),
    ...(unitOwnership ? { unitOwnership } : {}),
    ...(constructionIteration ? { constructionIteration } : {}),
    ...(constructionCheckpoints ? { constructionCheckpoints } : {}),
    ...(skeletonStance ? { skeletonStance } : {}),
    hasUnitProgress,
    runtime: readRuntimeFields(text),
    ...(unitProgress ? { unitProgress } : {}),
    scope,
    plan,
    lifecyclePhase,
    currentStage,
    currentStageDisplay: stageDisplay(currentStage, catalogName),
    nextStage,
    status,
    activeAgent,
    activeAgentDisplay: AGENT_DISPLAY[activeAgent] ?? activeAgent,
    lastUpdated,
    revisionCount,
    phases,
    overallDone,
    overallTotal,
    overallPct,
    complete,
  };
}

/**
 * One row of the state's `## Unit Progress` table — the engine-owned projection that is
 * authoritative for owner, per-unit stage state and gate in `team` + `unit-major`.
 *
 * PARSED THE WAY THE ENGINE PARSES IT, not from the prose template. `aidlc-state.ts::
 * parseUnitProgressTable` locates the section with `/^## Unit Progress\r?$/m`, takes the
 * first `|` line as the header, requires `header[0] === "unit"` and a separator row of
 * the same width, then keys rows by their first cell. Mirroring that is why this is
 * implementable at all: an earlier note here refused to write it for want of a real tree
 * to measure, which was the right instinct about the TEMPLATE and the wrong conclusion
 * about the WRITER — reading the writer's own format is the same move as preferring
 * `stage-graph.json` over a hardcoded stage list.
 *
 * COLUMNS ARE READ BY HEADER, never by position. Between `unit` and `gate` sit "per-unit
 * Construction stage columns in graph order", and the set is whatever the graph compiled;
 * an optional `merged` column may follow. Fixed indices would mis-read every run whose
 * stage set differs.
 */
export interface UnitProgressRow {
  unit: string;
  /** `-` until the claim increment supplies ownership; kept verbatim. */
  owner?: string;
  /** Stage column header → checkbox status, for the columns this table carries. */
  stages: Record<string, StageStatus>;
  /** The `gate` cell's status, when the table carries that column. */
  gate?: StageStatus;
  /** The `merged` cell verbatim, when present — optional in the contract. */
  merged?: string;
}

export interface UnitProgress {
  rows: UnitProgressRow[];
  /** Stage column headers in table order, i.e. compiled graph order. */
  stageColumns: string[];
  /** True when the section exists but could not be parsed to the engine's shape. */
  malformed: boolean;
}

/** Checkbox cell → status, using the same vocabulary as `## Stage Progress`. */
function cellStatus(cell: string): StageStatus | undefined {
  const m = /^\[(.)\]$/.exec(cell.trim());
  if (!m) return undefined;
  return stageStatusFromBox(m[1] ?? " ", false);
}

/**
 * Read `## Unit Progress`. Returns undefined when the section is absent (the normal case
 * — it exists only in team/unit-major). Never throws; a shape the engine would refuse
 * comes back `malformed` with no rows, so the panel can say so instead of guessing.
 */
export function parseUnitProgress(text: string): UnitProgress | undefined {
  const head = /^##[ \t]+Unit Progress[ \t]*$/m.exec(text.replace(/\r\n/g, "\n"));
  if (!head) return undefined;
  const body = text.replace(/\r\n/g, "\n").slice(head.index + head[0].length);
  const section = body.split(/^## /m)[0] ?? "";
  const lines = section.split("\n");
  // `startsWith("|")` with NO trim, because that is exactly what the engine accepts
  // (`lines.findIndex((line) => line.startsWith("|"))`). Tolerating an indented table here
  // meant calling a table "authoritative" that `aidlc-state.ts` would refuse outright.
  const first = lines.findIndex((l) => l.startsWith("|"));
  if (first < 0) return { rows: [], stageColumns: [], malformed: true };
  const table = lines
    .slice(first)
    .filter((l) => l.startsWith("|"))
    .map((l) =>
      l
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  const header = table[0];
  const separator = table[1];
  // The engine's own two guards: `header[0]` must be `unit`, and the separator must be
  // the same width. Anything else it calls "Invalid Unit Progress table header".
  if (!header || !separator || header[0]?.toLowerCase() !== "unit") {
    return { rows: [], stageColumns: [], malformed: true };
  }
  if (separator.length !== header.length) return { rows: [], stageColumns: [], malformed: true };

  const lower = header.map((h) => h.toLowerCase());
  const ownerAt = lower.indexOf("owner");
  const gateAt = lower.indexOf("gate");
  const mergedAt = lower.indexOf("merged");
  const stageAt = header
    .map((h, i) => ({ h, i }))
    .filter(({ i }) => i !== 0 && i !== ownerAt && i !== gateAt && i !== mergedAt);

  const rows: UnitProgressRow[] = [];
  for (const cells of table.slice(2)) {
    if (cells.length !== header.length) continue;
    if (cells.every((c) => /^-+$/.test(c))) continue;
    const unit = cells[0];
    if (!unit) continue;
    const stages: Record<string, StageStatus> = {};
    for (const { h, i } of stageAt) {
      const st = cellStatus(cells[i] ?? "");
      if (st) stages[h] = st;
    }
    const owner = ownerAt >= 0 ? cells[ownerAt] : undefined;
    const gate = gateAt >= 0 ? cellStatus(cells[gateAt] ?? "") : undefined;
    const merged = mergedAt >= 0 ? cells[mergedAt] : undefined;
    rows.push({
      unit,
      ...(owner ? { owner } : {}),
      stages,
      ...(gate ? { gate } : {}),
      ...(merged ? { merged } : {}),
    });
  }
  return { rows, stageColumns: stageAt.map(({ h }) => h), malformed: false };
}
