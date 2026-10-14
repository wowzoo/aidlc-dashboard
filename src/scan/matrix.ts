// Reconstruct the Construction per-unit progress matrix. The (unit × stage)
// progress is not carried by any single file:
//
//   - aidlc-state.md      → one checkbox for the WHOLE stage, no per-unit cursor
//   - the unit DAG        → the unit ROSTER + topology + each unit's `kind`,
//                           resolved as the engine resolves it (scan/unit-dag.ts):
//                           the authored unit-of-work-dependency.md first, the
//                           runtime graph's `bolt_dag` only as a cache that still
//                           matches it — the graph is recompiled at transitions
//                           only, and its `stages` rows carry no unit field
//   - construction/<unit>/<stage>/ dirs → the only live record of which unit has
//                           produced what
//
// So the matrix is the unit DAG (structure) × disk (completion) × stage-graph.json
// (the artifact contract that says when a unit's segment is actually DONE).
//
// WHY THREE STATES. The obvious rule — a cell is present when the segment dir is
// non-empty — over-reports: a unit stopped at its plan-approval question has
// `code-generation-plan.md` + `code-generation-questions.md` on disk but no
// `code-summary.md`, and reads as fully present — which hides the very unit the
// run is blocked on. Intersecting the dir listing with the stage's contracted
// artifacts for that unit's kind separates "started" from "finished" and names
// what is missing. Verified on a 9-unit run: 30 of 31 populated cells matched
// the contract exactly and the single mismatch was the real blocker.
//
// Degradation: no stage catalogue (older harness, partial sync) → fall back to the
// binary present/absent rule, with `expected` empty and state never "partial".
//
// Node fs only (local FS) — no vscode import — so it stays unit-testable headless
// the way parser.ts / resolve.ts are.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ClaimFilter } from "./claim-attempt";
import { type StageInfo, type StageStatus, displayFromSlug } from "./parser";
import {
  type StageCatalog,
  artifactFilename,
  expectedArtifacts,
  requiredArtifacts,
  vacuouslyCovered,
} from "./stage-catalog";
import { type UnitDag, resolveUnitDag } from "./unit-dag";
import {
  type ReceiptReason,
  type ReceiptRow,
  type UnitReceipts,
  readUnitReceipts,
} from "./unit-receipts";

// The per-unit Construction stage slugs — the stages the engine runs once per Unit of
// Work (each writing a `construction/<unit>/<stage>/` segment). The remaining
// Construction stages (build-and-test / ci-pipeline) run once globally and are NOT
// part of the matrix.
//
// FALLBACK ONLY. The stage graph declares this per stage as `for_each: "unit-of-work"`
// and `CatalogStage.forEach` already parsed it, while this hardcoded set did the
// deciding — the same "fixed list instead of the declared contract" shape the harness
// discovery and STAGE_DISPLAY notes warn about, and it would silently mis-shape the
// matrix the first time the engine adds or retires a per-unit stage. `isPerUnitStage`
// asks the catalogue first; this set is what a tree with no harness dir falls back to.
export const PER_UNIT_STAGE_SLUGS: ReadonlySet<string> = new Set([
  "functional-design",
  "nfr-requirements",
  "nfr-design",
  "infrastructure-design",
  "code-generation",
]);

/** How the state file's declared schema version compares with the harness's. */
export type StateCompat = "verified" | "unknown" | "incompatible";

/**
 * The per-stage unit-receipt ledger, read from the audit (scan/unit-receipts.ts — a
 * transcription of the engine's `unitLifecycleSnapshot`). Mirrors the engine's two
 * modes (`aidlc-orchestrate.ts::unitLedgerFor`): once a stage has ANY unit lifecycle
 * event — or the engine requires receipts by policy — its receipts are the completion
 * authority and artifacts are only evidence; a stage with neither is "a genuinely
 * ledger-free legacy flow" and stays artifact-driven, which is the behaviour every
 * earlier tree had. Absent entirely → artifact-driven, unchanged.
 *
 * FOUR ANSWERS, not a boolean. `settled(): boolean` once returned false both for "the
 * engine says this unit is not done" and for "this reader cannot tell" — so every gap
 * in the reproduction printed as a red ▩, a fabricated blocker. `unverifiable` is the
 * honest answer for the second, and `skipped` (UNIT_SKIPPED) is neither done nor
 * outstanding: the engine's own record that this unit does not run the stage.
 */
/**
 * WHY a receipt could not be checked — each cause is one the engine could settle either
 * way, and the audit alone cannot say which:
 *
 *   claim-unresolved    a team row's claim attempt needs an intent registry the engine
 *                       would throw on; whether the unit owes the stage at all is open,
 *                       so it is shown whatever the segment holds, never absent or exempt.
 *   wave-fingerprint    an artifact fingerprint decides; same.
 *   ambiguous-floor     the floor is `AMBIGUOUS:<ts>#<digest>`, not reproducible; same.
 */
export type { ReceiptReason, ReceiptVerdict } from "./unit-receipts";

export type UnitLifecycle = UnitReceipts;

/** An audit row as the receipt reader takes it; `pos`/`shardIndex` come from the ledger. */
export type LifecycleEvent = ReceiptRow & { stage?: string; unit?: string };

/**
 * Read the per-stage unit-receipt ledger. `unitMajor` is `Construction Iteration:
 * unit-major` OR `Construction Checkpoints: enabled`; `unitScoped` defaults to the
 * engine's `unitScopedLifecycleFloors` (team, checkpoints, or solo unit-major), which
 * for these two flags is `teamOwnership || unitMajor`.
 */
export function readUnitLifecycle(
  events: readonly LifecycleEvent[],
  opts: {
    unitMajor?: boolean;
    teamOwnership?: boolean;
    /** The checkout's claim-attempt filter — see `ReceiptPolicy.claim`. */
    claim?: ClaimFilter;
    unitScoped?: boolean;
    receiptsRequired?: boolean;
    stageIndex?: (slug: string) => number;
  } = {},
): UnitLifecycle {
  // Rows built by hand (tests) may carry the stage/unit only on the event, not in its
  // fields, so those are folded in. A parsed ledger row (it has a `pos`) is passed as it
  // is: its `stage`/`unit` may be INFERRED from `Context`, and the engine reads only the
  // raw `Stage`/`Unit` fields — folding them in turned a Context-only completion into a
  // receipt the engine never counted.
  const rows = events.map((e) =>
    e.pos !== undefined
      ? e
      : {
          ...e,
          fields: {
            ...(e.stage !== undefined ? { Stage: e.stage } : {}),
            ...(e.unit !== undefined ? { Unit: e.unit } : {}),
            ...e.fields,
          },
        },
  );
  const unitMajor = opts.unitMajor ?? false;
  const team = opts.teamOwnership ?? false;
  return readUnitReceipts(rows, {
    unitMajor,
    claim: opts.claim,
    unitScoped: opts.unitScoped ?? (team || unitMajor),
    receiptsRequired: opts.receiptsRequired ?? false,
    stageIndex: opts.stageIndex,
  });
}

/** The engine's own marker for a per-unit stage, with the fixed list as fallback. */
function isPerUnitStage(slug: string, catalog: StageCatalog | undefined): boolean {
  const row = catalog?.bySlug.get(slug);
  if (row) return row.forEach === "unit-of-work";
  return PER_UNIT_STAGE_SLUGS.has(slug);
}

/** One Unit column of the matrix, in the engine's roster order (`batches.flat()`). */
export interface MatrixUnit {
  /** Unit slug, verbatim from the resolved DAG. */
  name: string;
  /** Title-cased display name derived from the slug. */
  display: string;
  /** Unit kind (ui/service/library/spec/...) — drives the artifact contract. */
  kind?: string;
  /** Units this one depends on, from whichever DAG source won (display only). */
  dependsOn: string[];
}

/**
 * absent   — no segment dir, or an empty one: this unit has not started the stage.
 * partial  — artifacts on disk, but the stage's contract for this unit's kind is
 *            not met yet. `missing` names what is outstanding.
 * complete — every contracted artifact is on disk (or, with no catalogue, the
 *            segment dir is simply non-empty).
 * unsettled — every contracted artifact is on disk BUT the unit's completion receipt
 *            for this stage is missing, on a stage that demonstrably uses the unit
 *            lifecycle. Not "complete": the engine says so in its own words —
 *            "receipts become the completion authority and artifact existence degrades
 *            to evidence — a paused or partially-written unit has artifacts but no
 *            receipt and stays uncovered (issue: artifact presence was mistaken for
 *            completion)" (aidlc-orchestrate.ts::unitLedgerFor). Not "partial" either,
 *            because nothing is missing from the contract; what is missing is the
 *            receipt. A paused, stale or reopened unit lands here.
 * unverified — every contracted artifact is on disk and the receipt CANNOT BE CHECKED from
 *            the audit alone: team ownership (the claim file decides), wave mode (an
 *            artifact fingerprint decides), or an `AMBIGUOUS` attempt floor on events
 *            built without block positions. Kept apart from `unsettled` because merging
 *            them printed a red "not done" over every gap in this reader's reproduction of
 *            the engine — a fabricated blocker.
 * skipped  — the engine recorded UNIT_SKIPPED for this unit in this attempt: it does not
 *            run the stage, by the engine's own decision, with the reason it gave. Neither
 *            done nor outstanding, and not `n/a` either — n/a is the CONTRACT having
 *            nothing for the unit's kind, skipped is the RUN deciding. A later start,
 *            rejection or reaching jump cancels it (the receipt reader's floor).
 *            Without this state a unit skipped in a stage read as `absent`, i.e. as work
 *            nobody had done.
 * n/a      — the stage contracts NOTHING for this unit's kind, so there is nothing
 *            to be missing. Distinct from `absent` on purpose: measured on a real
 *            run, a `packaging` unit sat at functional-design, whose every artifact
 *            is scoped to service/spec/ui/library. The cell had expected=[] and so
 *            rendered as "미착수" — reading as a unit that never started a stage it
 *            had in fact run (its questions file and audit events were there). Only
 *            claimed when the catalogue has the stage row AND the unit's kind is
 *            known; without either, "nothing expected" means "we don't know".
 */
export type CellState =
  | "absent"
  | "partial"
  | "complete"
  | "unsettled"
  | "unverified"
  | "skipped"
  | "n/a";

/** One per-unit cell. */
export interface MatrixCell {
  unit: string;
  state: CellState;
  /** Files found in the segment dir, by name with extension, minus the questions file. */
  present: string[];
  /** Contracted artifacts for this unit's kind ([] when no catalogue). */
  expected: string[];
  /** The part of `expected` that judges the cell — `optional_produces` excluded. */
  required: string[];
  /** required − present; empty on every state but "partial" and "absent". */
  missing: string[];
  /** Why the receipt could not be checked. Set only when state is "unverified". */
  receiptReason?: ReceiptReason;
  /** The engine's `Reason` on the UNIT_SKIPPED row. Set only when state is "skipped". */
  skipReason?: string;
}

/**
 * One per-unit Construction stage as a matrix row. `status` is the authoritative
 * state.md checkbox (the engine's verdict for the stage as a whole), while the
 * cells are reconstructed live from disk. For a completed stage the two agree —
 * the gate only opens once every unit's segment landed. For an in-flight stage
 * they need not, and `provisional` flags that the counts still grow.
 */
export interface MatrixStage {
  slug: string;
  display: string;
  status: StageStatus;
  /** false when the stage is scope-excluded (SKIP): no cells, no counts. */
  execute: boolean;
  /**
   * Per-unit cells in roster order — empty for a stage that did not run, which is
   * EITHER spelling of skip: scope-excluded (`— SKIP`, `execute` false) or skipped at
   * runtime (`[S]` on an `— EXECUTE` row, `status` "skipped").
   */
  cells: MatrixCell[];
  /** Units whose cell is "complete". */
  complete: number;
  /** Units whose cell is "partial" — started, contract unmet. */
  partial: number;
  /** Artifacts met but no completion receipt — see CellState `unsettled`. */
  unsettled: number;
  /** Artifacts met, receipt not checkable from the audit — see CellState `unverified`. */
  unverified: number;
  /** Units the stage contracts nothing for — excluded from the row's denominator. */
  notApplicable: number;
  /** Units the engine recorded as skipping this stage — excluded from the denominator too. */
  skipped: number;
  /** Roster size (0 for a stage that did not run). */
  total: number;
  /** True when the stage is not yet [x] — counts are a snapshot, not final. */
  provisional: boolean;
}

export interface ConstructionMatrix {
  /** Unit roster in the engine's order: the batches flattened (topological levels). */
  units: MatrixUnit[];
  /** The per-unit Construction stages present in state.md, in document order. */
  stages: MatrixStage[];
  /** Topological batches from the resolved DAG: units in one batch may run in parallel. */
  batches: string[][];
  /**
   * False when no stage catalogue was available (cells are binary only).
   *
   * `contractAware` and `stateVerified` are separate axes on purpose. Collapsing an
   * unreadable `State Version` into "no catalogue" threw the artifact contract away
   * wholesale and degraded the matrix to 2-state, which HIDES blocked units — a real
   * cost paid for a missing label. Showing the contract while saying it is unverified is
   * strictly more information than showing neither.
   */
  contractAware: boolean;
  /**
   * Whether the state/catalogue pairing was actually CHECKED, and how it came out. Three
   * values, not a boolean: a boolean `stateVerified` read `true` whenever the state's own
   * number was numeric, even with the harness silent about the version it supports — that
   * is nothing compared against, so the honest answer is `unknown`.
   *
   *   verified     both sides declared a version and they match
   *   unknown      one side is silent, or the state's value is unparseable (which the
   *                engine itself refuses — `classifyStateVersion`)
   *   incompatible declared and different; the catalogue is withheld entirely
   */
  stateCompat: StateCompat;
  /**
   * True when at least one stage's unit lifecycle is in force, so a cell can be
   * `unsettled` from a missing receipt. Independent of `contractAware`: receipts come
   * from the audit, so a tree with NO catalogue can still produce ▩, and the old
   * "칸은 파일 유무만 뜻함" note was wrong whenever it did.
   */
  receiptAware: boolean;
}

/** The resolved unit DAG as this module consumes it. */
export interface BoltDag {
  units: MatrixUnit[];
  batches: string[][];
}

/**
 * The matrix's view of a resolved DAG (scan/unit-dag.ts), or undefined when there is no
 * roster to draw — `none` (a run before units-generation) and `malformed` (the engine's
 * unit set is unknowable, so no roster from anywhere else stands in for it) alike. The
 * caller tells those two apart on the page.
 */
export function boltDagFrom(dag: UnitDag): BoltDag | undefined {
  if (dag.state !== "ok") return undefined;
  return {
    units: dag.units.map((name) => ({
      name,
      display: displayFromSlug(name),
      kind: dag.unitKinds?.get(name),
      dependsOn: dag.dependsOn.get(name) ?? [],
    })),
    batches: dag.batches,
  };
}

/** The engine's `isRegularFile`: `statSync(...).isFile()`, so a link to a file counts. */
function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The files a segment dir holds, by name, minus the `-questions` file. Questions are a
 * conversation artifact, never listed in a stage's produces[], so counting them would
 * make every started segment look started for nothing.
 *
 * A NAME, NOT A STEM. `produces` names artifacts logically and the engine maps each to
 * exactly one file (`artifactFilename`: `<name>.md`, or the vocabulary's exception —
 * `traceability` is `traceability.json`), then asks `isRegularFile` of that path
 * (`unitCovered`, `missingUnitArtifacts`). This scan used to strip whatever extension was
 * on disk, which fixed the `.json` case run B had measured (an `.md`-only filter left
 * 8 cells permanently partial) but also let `code-summary.json` cover `code-summary` and
 * `traceability.md` cover `traceability` — files the engine never reads as the artifact.
 * A link counts when it reaches a regular file, because `isRegularFile` follows it. This
 * listing only DISPLAYS what is there and says a unit started; coverage is the stat of
 * each contracted file's path (`hasFile`), which is what the engine does.
 */
function readSegment(recordDir: string, unit: string, stageSlug: string): string[] {
  const dir = path.join(recordDir, "construction", unit, stageSlug);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    // Dotfiles are never artifacts; a dir inside a segment is not one either.
    if (name.startsWith(".") || name.replace(/\.[^.]+$/, "").endsWith("-questions")) continue;
    if (isRegularFile(path.join(dir, name))) files.push(name);
  }
  return files.sort();
}

/**
 * Build the matrix from the roster + the parsed Construction stages + a segment
 * oracle. Pure: `readUnitSegment` is injected so this is testable without a
 * filesystem. `catalog` undefined → binary cells (extension-compatible).
 * Returns undefined when there is no roster or no per-unit stage to show.
 */
export function buildConstructionMatrix(
  dag: BoltDag,
  constructionStages: StageInfo[],
  readUnitSegment: (unit: string, stageSlug: string) => string[],
  catalog: StageCatalog | undefined,
  /** Omitted → artifact-driven, which is the engine's own ledger-free branch. */
  lifecycle?: UnitLifecycle,
  /** How the state/catalogue version pairing came out. Default `unknown`. */
  stateCompat?: StateCompat,
  /**
   * Is `<segment>/<file>` a regular file? The engine stats the contract's path rather than
   * reading a listing, so an unlistable dir or a case-folding filesystem answers the same.
   * Omitted → the listing decides (tests).
   */
  hasFile?: (unit: string, stageSlug: string, file: string) => boolean,
): ConstructionMatrix | undefined {
  if (dag.units.length === 0) return undefined;

  let receiptsInForce = false;
  const stages: MatrixStage[] = [];
  for (const st of constructionStages) {
    if (!isPerUnitStage(st.slug, catalog)) continue; // global stage — not a row
    if (!st.execute || st.status === "skipped") {
      // Did not run — scope-excluded (SKIP) or skipped at runtime ([S]): a row for
      // continuity, but no per-unit scan/count. `[S]` has to be caught here too: its
      // row still says EXECUTE, and scanning it drew every unit as absent with a
      // provisional mark — "0/3, still growing" for a stage the run had closed by
      // skipping. `execute` keeps what the state file says.
      stages.push({
        slug: st.slug,
        display: st.display,
        status: st.status,
        execute: st.execute,
        cells: [],
        complete: 0,
        partial: 0,
        unsettled: 0,
        unverified: 0,
        notApplicable: 0,
        skipped: 0,
        total: 0,
        provisional: false,
      });
      continue;
    }

    const catStage = catalog?.bySlug.get(st.slug);
    const cells: MatrixCell[] = dag.units.map((u) => {
      const present = readUnitSegment(u.name, st.slug);
      // JUDGED on the required set, DISPLAYED as the whole contract. A conditional
      // artifact absent must not read as partial — the engine does not check it either
      // (see requiredArtifacts). `expected` stays the union so the cell can still show
      // what the stage may write here.
      const required = catStage ? requiredArtifacts(catStage, u.kind) : [];
      const expected = catStage ? expectedArtifacts(catStage, u.kind) : [];
      const has = hasFile
        ? (a: string) => hasFile(u.name, st.slug, artifactFilename(a))
        : (a: string) => present.includes(artifactFilename(a));
      const missing = required.filter((a) => !has(a));
      // Started is the listing OR a contracted file the stat found — a listing the
      // engine never takes must not turn a covered cell into "not started".
      const started = present.length > 0 || missing.length < required.length;
      // A known kind that the stage contracts nothing REQUIRED for is not "not started".
      // Requires both the catalogue row and the kind: with either absent, an empty
      // required set means "unknown", which stays on the binary rule below.
      // Artifacts met is COVERAGE, not completion. Where the stage uses the unit
      // lifecycle, the `UNIT_COMPLETED` receipt is the authority and a unit with every
      // file but no receipt is unsettled — paused, stale or reopened.
      const artifactsMet = started && missing.length === 0;
      const needsReceipt = lifecycle?.inUse(st.slug) === true;
      if (needsReceipt) receiptsInForce = true;
      // A skip is read whether or not receipts are in force: UNIT_SKIPPED does not count
      // toward `inUse` (the engine's snapshot leaves it out, and adding it would make
      // every other legacy unit of the stage receipt-bound), but the engine's settled
      // check reads the skip first. A stage whose only unit rows are skips is real — the
      // skip writer emits no UNIT_STARTED.
      const verdict = lifecycle?.state(u.name, st.slug);
      // An unresolved claim is read the same way: it could hide a skip, and a skip-only
      // stage is not `inUse`, so dropping the verdict there would draw the unit absent.
      const receipt =
        needsReceipt ||
        verdict?.state === "skipped" ||
        (verdict?.state === "unverifiable" && verdict.reason === "claim-unresolved")
          ? verdict
          : undefined;
      const state: CellState =
        catStage !== undefined && u.kind !== undefined && vacuouslyCovered(catStage, u.kind)
          ? "n/a"
          : receipt?.state === "skipped"
            ? "skipped"
            : // Before the artifact checks: whether the unit owes the stage at all is the
              // open question, so an empty segment is not "not started".
              receipt?.state === "unverifiable" && receipt.reason === "claim-unresolved"
              ? "unverified"
              : !started
                ? "absent"
                : !artifactsMet
                  ? "partial"
                  : receipt?.state === "unsettled"
                    ? "unsettled"
                    : receipt?.state === "unverifiable"
                      ? "unverified"
                      : "complete";
      return {
        unit: u.name,
        state,
        present,
        expected,
        required,
        missing,
        ...(receipt?.state === "unverifiable" ? { receiptReason: receipt.reason } : {}),
        ...(receipt?.state === "skipped" ? { skipReason: receipt.reason } : {}),
      };
    });

    const notApplicable = cells.filter((c) => c.state === "n/a").length;
    const skipped = cells.filter((c) => c.state === "skipped").length;
    stages.push({
      slug: st.slug,
      display: st.display,
      status: st.status,
      execute: true,
      cells,
      complete: cells.filter((c) => c.state === "complete").length,
      partial: cells.filter((c) => c.state === "partial").length,
      unsettled: cells.filter((c) => c.state === "unsettled").length,
      unverified: cells.filter((c) => c.state === "unverified").length,
      notApplicable,
      skipped,
      total: dag.units.length,
      // Only a completed stage is guaranteed to hold every unit's segment; an
      // in-flight stage's counts are a snapshot that grows until it gates.
      provisional: st.status !== "done",
    });
  }
  if (stages.length === 0) return undefined;

  return {
    units: dag.units,
    stages,
    batches: dag.batches,
    contractAware: catalog !== undefined,
    stateCompat: stateCompat ?? "unknown",
    receiptAware: receiptsInForce,
  };
}

/**
 * Filesystem entry point: given the intent record dir (the folder holding
 * aidlc-state.md), the parsed Construction stages, and the workspace's stage
 * catalogue, reconstruct the matrix. Returns undefined when the unit DAG resolves to
 * no roster (`none` or `malformed`). Never throws.
 */
export function scanConstructionMatrix(
  recordDir: string,
  constructionStages: StageInfo[],
  catalog: StageCatalog | undefined,
  lifecycle?: UnitLifecycle,
  stateCompat?: StateCompat,
  /** The record's resolved DAG; resolved here when the caller has not already. */
  unitDag: UnitDag = resolveUnitDag(recordDir),
): ConstructionMatrix | undefined {
  const dag = boltDagFrom(unitDag);
  if (!dag) return undefined;
  return buildConstructionMatrix(
    dag,
    constructionStages,
    (unit, slug) => readSegment(recordDir, unit, slug),
    catalog,
    lifecycle,
    stateCompat,
    (unit, slug, file) => isRegularFile(path.join(recordDir, "construction", unit, slug, file)),
  );
}
