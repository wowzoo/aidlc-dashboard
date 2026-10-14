// The unit roster, resolved the way the engine resolves it.
//
// A transcription of the AI-DLC 2.11.0 `resolveBoltDag` (tools/aidlc-lib.ts) and the
// readers it stands on — `parseBoltDag` (with `extractYamlUnitsBlock`, `unquoteScalar`,
// `parseInlineDepsList`, `parseUnitsBlock`, `computeBatches`), `validateUnitName`, and
// `boltDagMatches`. Construction walks its Units from this, so a roster read any other
// way draws a matrix over units the engine does not have.
//
// THE AUTHORED FILE IS AUTHORITATIVE; THE GRAPH IS A CACHE. This module used to read
// `runtime-graph.json`'s `bolt_dag.units` alone (scan/matrix.ts), which is wrong in three
// reachable ways, because the graph is a compiled copy — rebuilt by the hook on transition
// events or by a manual `runtime compile`, not on every edit (AGENTS.md,
// "runtime-graph.json is not current"):
//   - the authored DAG changed after the last compile: the engine walks the new roster,
//     the page drew the old one;
//   - the compile found the authored block malformed and OMITTED `bolt_dag`, then the file
//     was fixed: the engine reads it at once, the page said there were no units;
//   - the authored block is malformed now, beside a graph still holding the old roster:
//     the engine refuses (`malformed` — "the unit set is unknowable and must fail
//     closed"), the page drew a plausible, wrong matrix.
// A cache is accepted only when its batches AND unit kinds still match the authored file.
// The page says when one was outvoted (`graphDiffers`), and says only that — a kind-only
// difference sets it too, so it is not evidence of an "older" roster.
//
// Other readers of the roster: the run position checks the unit cache against it
// (scan/run-position.ts, `offRoster`), and `## Unit Progress` is compared to it, because
// the engine rebuilds that table from this DAG (`deriveTeamUnitProgressModel`). The timing
// unit view reads audit history and `scan/summary.ts` reads state progress — neither is a
// roster claim, so neither is filtered by it.
//
// ROSTER ORDER IS `batches.flat()`. The compiler writes `bolt_dag.units` in AUTHORED order
// (`computeBoltDag` → `parsed.units`), not topological, and the engine's own roster is
// the flattened batches (topological levels, each sorted). Kinds come from
// `bolt_dag.units` on the cache path and from the authored `kind:` lines otherwise —
// the cache accepts any string kind, the authored file only `UNIT_KINDS`, exactly as
// the engine does.
//
// Never throws. `parseUnitsBlock` throws internally, as the engine's does, and
// `parseUnitDag` maps that to `malformed` the same way `parseBoltDag` does.
//
// Not the engine's: `depends_on` per unit. The engine's resolution drops it (batches
// carry the topology); the matrix shows it, so it is kept from whichever source won —
// the authored edges, or the cache's units when no authored file exists. And an
// unreadable authored file reports its errno `code`, not `errorMessage(e)`, which
// carries the absolute path into a page that already names the file.

import * as fs from "node:fs";
import * as path from "node:path";

/** `aidlc-lib.ts`'s `UNIT_KINDS`: what a Unit of Work is, for the artifact contract. */
export const UNIT_KINDS = ["service", "spec", "ui", "packaging", "library"] as const;

const UNIT_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNIT_NAME_MAX_LENGTH = 64;

/** The authored file, relative to the record dir (`unitDependencyPath`). */
export const UNIT_DEPENDENCY_FILE = path.join(
  "inception",
  "units-generation",
  "unit-of-work-dependency.md",
);

export interface UnitEdge {
  name: string;
  depends_on: string[];
  kind?: string;
}

export type UnitDagParse =
  | { ok: true; units: UnitEdge[]; batches: string[][] }
  | { ok: false; reason: "absent" | "malformed" | "cyclic"; detail: string };

/**
 * The engine's `BoltDagResolution`, plus two fields this reader needs: `dependsOn` (see
 * the header) and `graphDiffers` — a cache existed and the authored file outvoted it,
 * which is the stale-graph case the page says out loud. `healed` keeps the engine's
 * meaning: true whenever the authored file supplied the roster.
 */
export type UnitDag =
  | {
      state: "ok";
      batches: string[][];
      units: string[];
      unitKinds: Map<string, string> | null;
      healed: boolean;
      graphDiffers: boolean;
      dependsOn: Map<string, string[]>;
    }
  | { state: "none" }
  | { state: "malformed"; reason: string; detail: string };

type OkDag = Extract<UnitDag, { state: "ok" }>;

/** `validateUnitName`: null when the name is a safe path component. */
export function validateUnitName(name: string): string | null {
  if (!name) return "Unit name is empty";
  if (name.length > UNIT_NAME_MAX_LENGTH) {
    return `Unit name "${name.slice(0, 32)}..." is ${name.length} chars; max is ${UNIT_NAME_MAX_LENGTH}`;
  }
  if (!UNIT_NAME_REGEX.test(name)) {
    return `Invalid Unit name "${name}" - must match ${UNIT_NAME_REGEX} (ASCII letter/digit, then ASCII letters/digits/dot/underscore/hyphen)`;
  }
  return null;
}

function extractYamlUnitsBlock(body: string): string | null {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^```ya?ml\s*$/.test((lines[i] ?? "").trim())) {
      const inner: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const inLine = lines[j] ?? "";
        if (/^```\s*$/.test(inLine.trim())) break;
        inner.push(inLine);
      }
      const block = inner.join("\n");
      if (/^\s*units\s*:/m.test(block)) return block;
      i = j; // not the units block — resume past its close fence
    }
  }
  return null;
}

function unquoteScalar(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineDepsList(raw: string): string[] {
  const t = raw.trim();
  if (t === "" || t === "[]") return [];
  if (t.startsWith("[")) {
    let close = -1;
    let quote: '"' | "'" | null = null;
    for (let i = 1; i < t.length; i++) {
      const char = t[i] ?? "";
      if (quote !== null) {
        if (quote === '"' && char === "\\") {
          i++;
        } else if (char === quote) {
          quote = null;
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === "]") {
        close = i;
        break;
      }
    }
    if (quote !== null || close === -1) return [];
    if (!/^[ \t]*(?:#[^\r\n]*)?$/.test(t.slice(close + 1))) return [];

    const body = t.slice(1, close);
    const items: string[] = [];
    let start = 0;
    quote = null;
    for (let i = 0; i < body.length; i++) {
      const char = body[i] ?? "";
      if (quote !== null) {
        if (quote === '"' && char === "\\") {
          i++;
        } else if (char === quote) {
          quote = null;
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ",") {
        items.push(body.slice(start, i));
        start = i + 1;
      }
    }
    if (quote !== null) return [];
    items.push(body.slice(start));
    return items.map((item) => unquoteScalar(item)).filter((item) => item !== "");
  }
  return [unquoteScalar(t)];
}

/** Throws on a structurally unparseable block, as the engine's does; see the caller. */
function parseUnitsBlock(block: string): UnitEdge[] {
  const lines = block.split(/\r?\n/);
  let i = 0;
  for (; i < lines.length; i++) {
    const head = lines[i] ?? "";
    if (/^\s*units\s*:/.test(head)) {
      const after = head.replace(/^\s*units\s*:/, "").trim();
      if (after !== "") throw new Error("units: must be a block list, not an inline value");
      break;
    }
  }
  if (i >= lines.length) throw new Error("missing units: key");
  i++;

  const edges: UnitEdge[] = [];
  let current: UnitEdge | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;

    const nameMatch = line.match(/^\s*-\s+name\s*:\s*(.+?)\s*$/);
    if (nameMatch) {
      if (current) edges.push(current);
      current = { name: unquoteScalar(nameMatch[1] ?? ""), depends_on: [] };
      continue;
    }

    const depMatch = line.match(/^\s*depends_on\s*:\s*(.*)$/);
    if (depMatch) {
      if (!current) throw new Error("depends_on: before any - name: entry");
      current.depends_on = parseInlineDepsList(depMatch[1] ?? "");
      continue;
    }

    const kindMatch = line.match(/^\s*kind\s*:\s*(.+?)\s*$/);
    if (kindMatch) {
      if (!current) throw new Error("kind: before any - name: entry");
      const value = unquoteScalar(kindMatch[1] ?? "");
      if (!(UNIT_KINDS as readonly string[]).includes(value)) {
        throw new Error(
          `unit "${current.name}" has invalid kind "${value}" (expected ${UNIT_KINDS.join("|")})`,
        );
      }
      current.kind = value;
      continue;
    }

    const itemMatch = line.match(/^\s*-\s+(.+?)\s*$/);
    if (itemMatch && current) {
      current.depends_on.push(unquoteScalar(itemMatch[1] ?? ""));
      continue;
    }

    throw new Error(`unrecognised line in units block: ${line.trim()}`);
  }
  if (current) edges.push(current);

  for (const e of edges) {
    const nameError = validateUnitName(e.name);
    if (nameError) throw new Error(nameError);
  }
  return edges;
}

/** Kahn by level, each level sorted; null on a cycle. */
function computeBatches(edges: UnitEdge[]): string[][] | null {
  const deps = new Map<string, string[]>();
  for (const e of edges) deps.set(e.name, e.depends_on);
  const remaining = new Set(edges.map((e) => e.name));
  const batches: string[][] = [];
  while (remaining.size > 0) {
    const level: string[] = [];
    for (const name of remaining) {
      const satisfied = (deps.get(name) ?? []).every((dep) => !remaining.has(dep));
      if (satisfied) level.push(name);
    }
    if (level.length === 0) return null;
    level.sort();
    for (const name of level) remaining.delete(name);
    batches.push(level);
  }
  return batches;
}

/** The engine's `parseBoltDag`: the authored file's body → edges + batches, or why not. */
export function parseUnitDag(body: string): UnitDagParse {
  const block = extractYamlUnitsBlock(body);
  if (block === null) {
    return { ok: false, reason: "absent", detail: "no fenced ```yaml units: block found" };
  }

  let edges: UnitEdge[];
  try {
    edges = parseUnitsBlock(block);
  } catch (e) {
    return { ok: false, reason: "malformed", detail: e instanceof Error ? e.message : String(e) };
  }
  if (edges.length === 0) {
    return { ok: false, reason: "malformed", detail: "units: block has no entries" };
  }

  const names = new Set<string>();
  const foldedNames = new Map<string, string>();
  for (const u of edges) {
    if (names.has(u.name)) {
      return { ok: false, reason: "malformed", detail: `duplicate unit name: ${u.name}` };
    }
    names.add(u.name);
    const folded = u.name.toLowerCase();
    const existing = foldedNames.get(folded);
    if (existing !== undefined && existing !== u.name) {
      return {
        ok: false,
        reason: "malformed",
        detail: `case-folding unit name collision: "${existing}" and "${u.name}"`,
      };
    }
    foldedNames.set(folded, u.name);
  }
  for (const u of edges) {
    for (const dep of u.depends_on) {
      if (dep === u.name) {
        return { ok: false, reason: "malformed", detail: `unit "${u.name}" depends on itself` };
      }
      if (!names.has(dep)) {
        return {
          ok: false,
          reason: "malformed",
          detail: `unit "${u.name}" depends on unknown unit "${dep}"`,
        };
      }
    }
  }

  const batches = computeBatches(edges);
  if (batches === null) return { ok: false, reason: "cyclic", detail: "dependency cycle detected" };
  return { ok: true, units: edges, batches };
}

/** `boltDagMatches`: same batches, same kinds. */
function dagMatches(a: OkDag, b: OkDag): boolean {
  if (JSON.stringify(a.batches) !== JSON.stringify(b.batches)) return false;
  const aKinds = a.unitKinds ?? new Map<string, string>();
  const bKinds = b.unitKinds ?? new Map<string, string>();
  if (aKinds.size !== bKinds.size) return false;
  for (const [unit, kind] of aKinds) {
    if (bKinds.get(unit) !== kind) return false;
  }
  return true;
}

/** The graph's `bolt_dag` as the engine accepts it as a cache, or null. */
function readCache(recordDir: string): OkDag | null {
  const graphPath = path.join(recordDir, "runtime-graph.json");
  if (!fs.existsSync(graphPath)) return null;
  try {
    const graph: unknown = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
    const boltDag =
      graph !== null && typeof graph === "object" && "bolt_dag" in graph
        ? (graph as { bolt_dag?: { batches?: unknown; units?: unknown } }).bolt_dag
        : undefined;
    const batches = boltDag?.batches;
    if (
      !Array.isArray(batches) ||
      !batches.every(
        (batch) =>
          Array.isArray(batch) &&
          batch.every((unit) => typeof unit === "string" && validateUnitName(unit) === null),
      )
    ) {
      return null;
    }
    const typedBatches = batches as string[][];
    const units = typedBatches.flat();
    if (units.length === 0 || new Set(units).size !== units.length) return null;
    const unitKinds = new Map<string, string>();
    const dependsOn = new Map<string, string[]>();
    if (Array.isArray(boltDag?.units)) {
      for (const unit of boltDag.units) {
        if (unit === null || typeof unit !== "object") continue;
        const r = unit as { name?: unknown; kind?: unknown; depends_on?: unknown };
        if (typeof r.name !== "string") continue;
        if (typeof r.kind === "string") unitKinds.set(r.name, r.kind);
        // Display only — the engine's cache carries no topology but the batches.
        if (Array.isArray(r.depends_on) && !dependsOn.has(r.name)) {
          dependsOn.set(
            r.name,
            r.depends_on.filter((d): d is string => typeof d === "string"),
          );
        }
      }
    }
    return {
      state: "ok",
      batches: typedBatches,
      units,
      unitKinds: unitKinds.size > 0 ? unitKinds : null,
      healed: false,
      graphDiffers: false,
      dependsOn,
    };
  } catch {
    // Fall through to the authored dependency artifact, as the engine does.
    return null;
  }
}

/**
 * Resolve the record's unit DAG: `resolveBoltDag` for one record dir. `none` is a real
 * no-DAG workflow; `malformed` means the unit set is unknowable, and a caller must not
 * draw a roster from anything else in its place.
 */
export function resolveUnitDag(recordDir: string): UnitDag {
  const cached = readCache(recordDir);

  const dependencyPath = path.join(recordDir, UNIT_DEPENDENCY_FILE);
  // `existsSync` as the engine has it: false for a dangling link, so that reads as no
  // authored file (the deferrals reader names the dangling link on its own).
  if (!fs.existsSync(dependencyPath)) return cached ?? { state: "none" };

  let body: string;
  try {
    body = fs.readFileSync(dependencyPath, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      state: "malformed",
      reason: "unreadable",
      detail: code ?? (e instanceof Error ? e.message : String(e)),
    };
  }
  const parsed = parseUnitDag(body);
  if (!parsed.ok) return { state: "malformed", reason: parsed.reason, detail: parsed.detail };

  const unitKinds = new Map(
    parsed.units
      .filter((u): u is UnitEdge & { kind: string } => u.kind !== undefined)
      .map((u) => [u.name, u.kind] as const),
  );
  const authored: OkDag = {
    state: "ok",
    batches: parsed.batches,
    units: parsed.batches.flat(),
    unitKinds: unitKinds.size > 0 ? unitKinds : null,
    healed: true,
    graphDiffers: cached !== null,
    dependsOn: new Map(parsed.units.map((u) => [u.name, u.depends_on])),
  };
  if (cached !== null && dagMatches(cached, authored)) {
    // The cache stands, but the authored edges are the source the cache was compiled
    // from — the display keeps them rather than the cache's copy.
    return { ...cached, dependsOn: authored.dependsOn };
  }
  return authored;
}
