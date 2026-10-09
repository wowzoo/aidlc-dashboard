// Which units the engine counts as done with a stage — its `UNIT_COMPLETED` /
// `UNIT_SKIPPED` receipts for the CURRENT attempt — read from the audit alone.
//
// A TRANSCRIPTION, not an approximation. The engine's verdict (2.11 aidlc-lib.ts
// `unitLifecycleSnapshot` over `currentUnitLifecycleRows`) rests on a cluster of
// rules that the earlier reader reproduced only in part, and each missing one was a
// cell drawn wrong on a real tree shape:
//
//   - THE ATTEMPT FLOOR (`latestMainWorkflowStageRunFloorFromRows`) is the token a
//     receipt must carry in `Run floor`. Boundaries: `WORKFLOW_STARTED`; a
//     `STAGE_JUMPED` only when it REACHES the stage (`stageJumpReaches` — a jump to a
//     later stage leaves an earlier stage's receipts alone; the old reader let every
//     jump reset every stage); a `GATE_REJECTED` naming the stage in `Gate Stages`
//     (else `Stage`) and, when it names a unit, only that unit's attempt; and a
//     main-workflow `STAGE_STARTED` of the stage — under unit-major flooring only the
//     starts recorded while stage-major flooring was in force, and under stage-major
//     only those not recorded under unit-major (`stageStartsUnderStageFlooring` /
//     `stageStartsUnderUnitFlooring`, read from `CONSTRUCTION_POLICY_SET` rows), so
//     receipts finished under one policy survive a switch to the other. Ordinals:
//     a start keeps its place among all of the stage's starts, a jump its place among
//     all jumps, anything else counts within the filtered rows. Rows tied in the last
//     second across shards make `AMBIGUOUS:<ts>#<sha256 over shard, pos, event, …>` —
//     rebuilt here exactly, because the ledger keeps each block's `pos`.
//   - THE FLOOR IS PER UNIT (`unitLifecycleRunFloorForProject`) under team ownership,
//     Construction Checkpoints, or solo unit-major (`unitScopedLifecycleFloors`), and
//     for ANY unit with its own reopen (a `GATE_REJECTED` naming it) — so a reopened
//     unit's old receipt is revoked in every mode, and unit A's rejection does not
//     revoke unit B's finished work.
//   - UNIT-MAJOR here means `Construction Iteration: unit-major` OR `Construction
//     Checkpoints: enabled`, as the engine's snapshot reads it.
//   - THE ROWS (`currentUnitLifecycleRows`): the stage's UNIT_* rows (UNIT_SKIPPED
//     included) whose `Run floor` equals the unit's floor and, under stage-major, not
//     before the stage's latest counted start; ordered by (time, shard index, pos);
//     each (second, unit) group reduced to one candidate per shard and, across shards,
//     ranked PAUSED > STARTED/RESUMED > COMPLETED/SKIPPED, highest kept.
//   - THE REPLAY (`unitLifecycleSnapshot`): SKIPPED records a skip (with its reason)
//     and revokes the receipt; COMPLETED adds it; anything else revokes it.
//   - IN USE: the stage has any UNIT_STARTED/PAUSED/RESUMED/COMPLETED row — or the
//     engine REQUIRES receipts by policy (`unitLedgerFor`: `inUse || receiptsRequired`,
//     where `receiptsRequired` is `constructionCheckpointsApply`). Measured before this
//     reader existed: checkpoints on + stage-major, engine settled, dashboard not.
//
// Run by extraction against the engine's own source on random ledgers — see the test.
//
// WHAT THE AUDIT CANNOT SAY stays `unverifiable`, never guessed: team ownership (the
// engine also matches each row's `Attempt Generation` against a claim file outside the
// audit), a wave-mode completion (held only while an artifact fingerprint matches), a
// and a cross-shard tie on events built without block positions. A ledger from before
// the `Run floor` field is read as the engine reads it: no row is current.
//
// GENERATION. This reads 2.11.0 — the dashboard's one supported engine. A tree from an
// older engine is read by these same rules, under the page's version warning; the
// 2.10.0 release's own rules (every jump reset every stage, no policy flooring, no
// UNIT_SKIPPED) are not reproduced.

import { createHash } from "node:crypto";
import type { AuditEvent } from "./audit";

/** The fields of an audit row this reader needs; `pos`/`shardIndex` may be absent. */
export interface ReceiptRow {
  ts?: string;
  event: string;
  shard?: string;
  pos?: number;
  shardIndex?: number;
  fields?: Record<string, string>;
}

/** Why a receipt cannot be read from the audit alone. */
export type ReceiptReason = "team-claim" | "wave-fingerprint" | "ambiguous-floor";

export type ReceiptVerdict =
  | { state: "settled" | "unsettled"; reason?: undefined }
  /** `reason` is the engine's own `Reason` field on the UNIT_SKIPPED row. */
  | { state: "skipped"; reason: string }
  | { state: "unverifiable"; reason: ReceiptReason };

export interface ReceiptPolicy {
  /** `Construction Iteration: unit-major` or `Construction Checkpoints: enabled`. */
  unitMajor: boolean;
  /** Team ownership, checkpoints enabled, or solo unit-major — per-unit floors. */
  unitScoped: boolean;
  team: boolean;
  /** The engine requires receipts by policy (`constructionCheckpointsApply`). */
  receiptsRequired: boolean;
  /** Catalogue stage order, for `stageJumpReaches`. */
  stageIndex?: (slug: string) => number;
}

interface Row {
  ts: string;
  event: string;
  shard: string;
  shardIndex: number;
  pos: number;
  f: Record<string, string>;
}

const UNIT_ROWS = new Set([
  "UNIT_STARTED",
  "UNIT_PAUSED",
  "UNIT_RESUMED",
  "UNIT_COMPLETED",
  "UNIT_SKIPPED",
]);
const IN_USE_ROWS = new Set(["UNIT_STARTED", "UNIT_PAUSED", "UNIT_RESUMED", "UNIT_COMPLETED"]);
const TERMINAL = new Set(["UNIT_COMPLETED", "UNIT_SKIPPED"]);

const byTime = (a: Row, b: Row): number =>
  a.ts !== b.ts
    ? a.ts < b.ts
      ? -1
      : 1
    : a.shardIndex !== b.shardIndex
      ? a.shardIndex - b.shardIndex
      : a.pos - b.pos;

/** `sortAttemptEvents`: within a shard, append order breaks a same-second tie. */
const sortAttempt = (rows: readonly Row[]): Row[] =>
  [...rows].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    if (a.shard === b.shard) return a.pos - b.pos;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });

/** `attemptEventDefinitelyBefore`: append order within a shard, time across shards. */
const before = (a: Row, b: Row): boolean => (a.shard === b.shard ? a.pos < b.pos : a.ts < b.ts);

const isMainStart = (r: Row, slug?: string): boolean =>
  r.event === "STAGE_STARTED" &&
  (slug === undefined || r.f.Stage === slug) &&
  !(r.f.Workflow ?? "").startsWith("single-stage:");

function gateStages(r: Row): string[] {
  const explicit = r.f["Gate Stages"];
  if (explicit) {
    return explicit
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return r.f.Stage ? [r.f.Stage] : [];
}

function rejectionMatches(r: Row, slug: string, unit: string | undefined): boolean {
  if (!gateStages(r).includes(slug)) return false;
  const eventUnit = r.f.Unit;
  if (eventUnit === undefined) return true;
  return unit !== undefined && eventUnit === unit;
}

function jumpReaches(r: Row, slug: string, stageIndex?: (s: string) => number): boolean {
  const name = r.f.Target;
  if (!name || name === slug) return true;
  try {
    const target = stageIndex?.(name) ?? -1;
    const at = stageIndex?.(slug) ?? -1;
    return target === -1 || at === -1 || at >= target;
  } catch {
    return true;
  }
}

function policyComplete(r: Row): boolean {
  const field = r.f.Field;
  return (
    (field === "Construction Iteration" ||
      field === "Construction Checkpoints" ||
      field === "Construction Execution") &&
    !!r.f.Value &&
    !!r.f["Previous Value"] &&
    !!r.f["Construction Iteration"] &&
    !!r.f["Construction Checkpoints"]
  );
}

function policyFoundUnitMajor(r: Row): boolean {
  const was = (field: string): string | undefined =>
    r.f.Field === field ? r.f["Previous Value"] : r.f[field];
  return (
    was("Construction Iteration") === "unit-major" || was("Construction Checkpoints") === "enabled"
  );
}

function policyChanges(rows: readonly Row[]): Row[] {
  return rows.filter((r) => r.event === "CONSTRUCTION_POLICY_SET" && policyComplete(r));
}

/** The first changes that may follow `start` — every one when none is plainly first. */
function firstAfter(start: Row, changes: readonly Row[]): Row[] {
  const after = changes.filter((c) => !before(c, start));
  const first = after.filter((c) => !after.some((o) => before(start, o) && before(o, c)));
  return first.length > 0 ? first : after;
}

function stageStartsUnderStageFlooring(rows: readonly Row[]): Set<Row> {
  const counted = new Set<Row>();
  const changes = policyChanges(rows);
  if (changes.length === 0) return counted;
  for (const start of rows) {
    if (start.event !== "STAGE_STARTED") continue;
    if (firstAfter(start, changes).some((c) => !policyFoundUnitMajor(c))) counted.add(start);
  }
  return counted;
}

function stageStartsUnderUnitFlooring(
  rows: readonly Row[],
  stageIndex?: (s: string) => number,
): Set<Row> {
  const ignored = new Set<Row>();
  const changes = policyChanges(rows);
  if (changes.length === 0) return ignored;
  for (const start of rows) {
    if (start.event !== "STAGE_STARTED") continue;
    const after = changes.filter((c) => !before(c, start));
    if (after.length === 0) continue;
    if (firstAfter(start, changes).every((c) => before(start, c) && policyFoundUnitMajor(c)))
      ignored.add(start);
  }
  // A unit-major walk finishes a later stage's units before that stage's first
  // STAGE_STARTED; that first start, after a change that found unit-major flooring
  // and after unit rows of the stage, is not a restart of it.
  const unitRows = rows.filter((r) => UNIT_ROWS.has(r.event));
  const boundaries = rows.filter(
    (r) => r.event === "WORKFLOW_STARTED" || r.event === "STAGE_JUMPED",
  );
  for (const start of rows) {
    if (start.event !== "STAGE_STARTED" || ignored.has(start)) continue;
    const slug = start.f.Stage;
    if (!slug || (start.f.Workflow ?? "").startsWith("single-stage:")) continue;
    const opened = (r: Row): boolean =>
      before(r, start) &&
      !boundaries.some(
        (b) =>
          (b.event === "WORKFLOW_STARTED" || jumpReaches(b, slug, stageIndex)) &&
          before(r, b) &&
          before(b, start),
      );
    const first = !rows.some((o) => o !== start && isMainStart(o, slug) && opened(o));
    if (
      first &&
      changes.some((c) => before(c, start) && policyFoundUnitMajor(c)) &&
      unitRows.some((r) => r.f.Stage === slug && opened(r))
    ) {
      ignored.add(start);
    }
  }
  return ignored;
}

/**
 * What every floor in one read shares: the two policy-flooring sets and the jump
 * ordinals do not depend on the stage or unit, so they are computed once per read —
 * recomputing them per (stage, unit) put an O(starts × changes²) pass behind every cell.
 */
interface Shared {
  rows: readonly Row[];
  stageFloored: Set<Row>;
  unitFloored: Set<Row>;
  jumpOrdinals: Map<Row, number>;
  startOrdinals: Map<string, Map<Row, number>>;
  floors: Map<string, string>;
  stageIndex?: (s: string) => number;
}

function shared(rows: readonly Row[], p: ReceiptPolicy): Shared {
  return {
    rows,
    stageFloored: p.unitMajor ? stageStartsUnderStageFlooring(rows) : new Set(),
    unitFloored: p.unitMajor ? new Set() : stageStartsUnderUnitFlooring(rows, p.stageIndex),
    jumpOrdinals: new Map(
      rows
        .filter((r) => r.event === "STAGE_JUMPED")
        .sort(byTime)
        .map((r, i) => [r, i + 1]),
    ),
    startOrdinals: new Map(),
    floors: new Map(),
    stageIndex: p.stageIndex,
  };
}

/** `latestMainWorkflowStageRunFloorFromRows`, with `unitReceipts` = true. */
function runFloor(c: Shared, slug: string, unitMajor: boolean, unit: string | undefined): string {
  let startOrdinals = c.startOrdinals.get(slug);
  if (!startOrdinals) {
    startOrdinals = new Map(
      sortAttempt(c.rows.filter((r) => isMainStart(r, slug))).map((r, i) => [r, i + 1]),
    );
    c.startOrdinals.set(slug, startOrdinals);
  }
  const rows = c.rows.filter((r) => {
    if (r.event === "WORKFLOW_STARTED") return true;
    if (r.event === "STAGE_JUMPED") return jumpReaches(r, slug, c.stageIndex);
    if (r.event === "GATE_REJECTED") return rejectionMatches(r, slug, unit);
    return isMainStart(r, slug) && (unitMajor ? c.stageFloored.has(r) : !c.unitFloored.has(r));
  });
  rows.sort(byTime);
  if (rows.length === 0) return "unstarted#0";

  const latest = rows[rows.length - 1]?.ts ?? "";
  const tied = rows.filter((r) => r.ts === latest);
  if (new Set(tied.map((r) => r.shard)).size > 1) {
    const identity = tied
      .map((r) => {
        const fields: (string | number)[] = [r.shard, r.pos, r.event, r.f.Stage ?? ""];
        if (unit !== undefined) fields.push(r.f.Unit ?? "", r.f["Gate Stages"] ?? "");
        return fields.join(":");
      })
      .sort()
      .join("|");
    const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
    return `AMBIGUOUS:${latest}#${digest}`;
  }

  const ordinals = new Map<string, number>();
  let floor = "unstarted#0";
  for (const r of rows) {
    const ordinal =
      r.event === "STAGE_STARTED"
        ? (startOrdinals.get(r) ?? 0)
        : r.event === "STAGE_JUMPED"
          ? (c.jumpOrdinals.get(r) ?? 0)
          : (ordinals.get(r.event) ?? 0) + 1;
    ordinals.set(r.event, ordinal);
    floor = `${r.event}:${r.ts}#${ordinal}`;
  }
  return floor;
}

/** `unitLifecycleRunFloorForProject`: per-unit when scoped, or when the unit was reopened. */
function unitFloor(c: Shared, slug: string, unit: string, p: ReceiptPolicy): string {
  const ownReopen = c.rows.some(
    (r) => r.event === "GATE_REJECTED" && r.f.Unit === unit && gateStages(r).includes(slug),
  );
  const floored = p.unitScoped || ownReopen ? unit : undefined;
  const key = `${slug}\u0001${floored ?? ""}`;
  const known = c.floors.get(key);
  if (known !== undefined) return known;
  const floor = runFloor(c, slug, p.unitMajor, floored);
  c.floors.set(key, floor);
  return floor;
}

export interface UnitReceipts {
  /** The stage has unit lifecycle rows, or the engine requires receipts by policy. */
  inUse: (slug: string) => boolean;
  state: (unit: string, slug: string) => ReceiptVerdict;
}

/**
 * Read every (stage, unit) receipt from the audit. `events` in ledger order (time,
 * then shard); rows lacking `pos`/`shardIndex` take their array index and 0.
 */
export function readUnitReceipts(
  events: readonly (AuditEvent | ReceiptRow)[],
  p: ReceiptPolicy,
): UnitReceipts {
  const hasPositions = events.every((e) => e.pos !== undefined);
  // A ledger row always has a timestamp; one built by hand without it sorts first, in
  // array order (its `pos`).
  const rows: Row[] = events.map((e, i) => ({
    ts: e.ts ?? "",
    event: e.event,
    shard: e.shard ?? "",
    shardIndex: e.shardIndex ?? 0,
    pos: e.pos ?? i,
    f: e.fields ?? {},
  }));

  const ctx = shared(rows, p);
  const inUse = new Set(
    rows.filter((r) => IN_USE_ROWS.has(r.event) && r.f.Stage).map((r) => r.f.Stage as string),
  );
  const slugs = new Set(
    rows
      .filter((r) => UNIT_ROWS.has(r.event) && r.f.Stage && r.f.Unit)
      .map((r) => r.f.Stage as string),
  );
  const verdicts = new Map<string, ReceiptVerdict>();

  for (const slug of slugs) {
    const lifecycle = rows.filter((r) => UNIT_ROWS.has(r.event) && r.f.Stage === slug && r.f.Unit);
    const units = [...new Set(lifecycle.map((r) => r.f.Unit as string))];
    const set = (unit: string, v: ReceiptVerdict) => verdicts.set(`${slug}\u0001${unit}`, v);

    if (p.team) {
      for (const u of units) set(u, { state: "unverifiable", reason: "team-claim" });
      continue;
    }

    // Under stage-major flooring the rows start at the latest stage start that counts.
    const starts = rows.filter((r) => isMainStart(r, slug));
    const startedAt = [...starts].sort(byTime).at(-1)?.ts ?? "";
    const ignoredStarts = ctx.unitFloored;
    const cutoff =
      ignoredStarts.size === 0
        ? startedAt
        : (sortAttempt(starts.filter((r) => !ignoredStarts.has(r))).at(-1)?.ts ?? "");

    const floors = new Map<string, string>();
    const floorOf = (unit: string): string => {
      const known = floors.get(unit);
      if (known !== undefined) return known;
      const f = unitFloor(ctx, slug, unit, p);
      floors.set(unit, f);
      return f;
    };

    const current = lifecycle.filter(
      (r) =>
        r.f["Run floor"] === floorOf(r.f.Unit as string) &&
        !(!p.unitMajor && cutoff && r.ts < cutoff),
    );
    current.sort(byTime);

    // Reduce each (second, unit) group: one candidate per shard, then the safety rank.
    const rank = (event: string) => (event === "UNIT_PAUSED" ? 2 : TERMINAL.has(event) ? 0 : 1);
    const reduced: Row[] = [];
    for (let a = 0; a < current.length; ) {
      let b = a + 1;
      while (b < current.length && current[b]?.ts === current[a]?.ts) b++;
      const byUnit = new Map<string, Row[]>();
      for (const r of current.slice(a, b)) {
        const list = byUnit.get(r.f.Unit as string) ?? [];
        list.push(r);
        byUnit.set(r.f.Unit as string, list);
      }
      for (const list of byUnit.values()) {
        const byShard = new Map<string, Row>();
        for (const r of list) byShard.set(r.shard, r);
        const candidates = [...byShard.values()];
        candidates.sort(
          (x, y) => rank(x.event) - rank(y.event) || x.shardIndex - y.shardIndex || x.pos - y.pos,
        );
        const pick = candidates[candidates.length - 1];
        if (pick) reduced.push(pick);
      }
      a = b;
    }
    reduced.sort(byTime);

    const receipts = new Set<string>();
    const skipped = new Map<string, string>();
    const wave = new Set<string>();
    for (const r of reduced) {
      const unit = r.f.Unit as string;
      // A wave completion holds only while its artifact fingerprint matches, which the
      // audit cannot check: it revokes any earlier receipt (the engine's replay does the
      // same whenever the fingerprint fails) and leaves the unit unverifiable — until a
      // later row decides it.
      wave.delete(unit);
      if (r.event === "UNIT_SKIPPED") {
        receipts.delete(unit);
        skipped.set(unit, r.f.Reason ?? "");
        continue;
      }
      skipped.delete(unit);
      if (r.event !== "UNIT_COMPLETED") {
        receipts.delete(unit);
        continue;
      }
      if (r.f.Mode === "wave") {
        receipts.delete(unit);
        // `waveCompletionHolds` needs a well-formed recorded digest first; without one the
        // engine certainly refuses the receipt, so only a well-formed one is a can't-tell.
        if (/^sha256:[0-9a-f]{64}$/.test(r.f["Artifact Fingerprint"] ?? "")) wave.add(unit);
      } else {
        receipts.add(unit);
      }
    }

    for (const unit of units) {
      const mine = lifecycle.filter((r) => r.f.Unit === unit);
      const matched = mine.some((r) => r.f["Run floor"] === floorOf(unit));
      // A row with no `Run floor` (a ledger from before the field) fails the exact match
      // and is simply not current, as the engine reads it — no special case.
      if (!matched && !hasPositions && floorOf(unit).startsWith("AMBIGUOUS:")) {
        // Built without block positions, the AMBIGUOUS digest cannot be rebuilt.
        set(unit, { state: "unverifiable", reason: "ambiguous-floor" });
      } else if (skipped.has(unit)) {
        set(unit, { state: "skipped", reason: skipped.get(unit) ?? "" });
      } else if (receipts.has(unit)) {
        set(unit, { state: "settled" });
      } else if (wave.has(unit)) {
        set(unit, { state: "unverifiable", reason: "wave-fingerprint" });
      } else {
        set(unit, { state: "unsettled" });
      }
    }
  }

  return {
    inUse: (slug) => p.receiptsRequired || inUse.has(slug),
    state: (unit, slug) => verdicts.get(`${slug}\u0001${unit}`) ?? { state: "unsettled" },
  };
}
