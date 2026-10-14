// Where a per-unit Construction stage writes its artifacts — per unit, or once at stage
// level. A transcription of the 2.11.0 engine's `usesStageLevelPerUnitArtifacts`
// (aidlc-lib.ts) with the two readers it stands on, `effectivePlanAction` and
// `parseCheckboxes`.
//
// The engine's rule: when the approved plan does not EXECUTE Units Generation (the Unit
// DAG's producer), there are no units — a per-unit stage runs once, its artifacts live
// under `construction/<stage>/` (`producesDirsForStage`, the artifact resolver), and
// `unit start/complete` is refused. Units Generation that already COMPLETED keeps its
// units when a later recompose drops it (#1401), so the work carries on per unit.
//
// Six of the 2.11.0 scope grid's eleven scopes skip Units Generation (bugfix, express,
// infra, poc, refactor, security-patch), so this is those scopes' default shape, not an
// edge case. A matrix drawn there has no unit to stand for: with no DAG the page said
// "units-generation has not been reached" — a stage the plan never runs — and with a DAG
// left in the graph by an earlier plan, every cell judged a per-unit path the engine
// does not read.
//
// One deliberate difference: with no suffix and no grid action the engine's function
// answers "stage level" (`undefined !== "EXECUTE"`), but its artifact resolver refuses
// that state outright ("Units Generation has no effective action"). This reader cannot
// tell which the run meant, so it returns `unknown` and claims neither — the matrix then
// reads as it did before this module.

import type { ScopeGrid } from "./parser";

export type UnitArtifactMode = "per-unit" | "stage-level" | "unknown";

const UNITS_GENERATION = "units-generation";

/** `getField`: the first `- **<name>**: <value>` line, trimmed. */
function stateField(text: string, name: string): string | undefined {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^- \\*\\*${esc}\\*\\*:[ \\t]*(.*)$`, "m").exec(text);
  return m?.[1]?.trim();
}

/**
 * `parseStateStageSuffixes(content).get(slug)`: every matching row in the file, the LAST
 * one winning (a Map set in order) — the engine does not confine the scan to Stage
 * Progress, so neither does this.
 */
function stateSuffix(text: string, slug: string): "EXECUTE" | "SKIP" | undefined {
  const re = /^- \[[ xSR?-]\] (\S+)\s*—\s*(EXECUTE|SKIP)\b/gm;
  let out: "EXECUTE" | "SKIP" | undefined;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[1] === slug) out = m[2] as "EXECUTE" | "SKIP";
  }
  return out;
}

/** `parseCheckboxes(content).some(c => c.slug === slug && c.state === "completed")`. */
function checkedComplete(text: string, slug: string): boolean {
  const re = /^- \[([ xSR?-])\] (\S+)\s*—\s*(.*)$/gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[2] === slug && m[1] === "x") return true;
  }
  return false;
}

/**
 * The run's per-unit artifact placement, read from the state text and the compiled scope
 * grid. Never throws.
 */
export function unitArtifactMode(stateText: string, scopeGrid?: ScopeGrid): UnitArtifactMode {
  const scope = stateField(stateText, "Scope");
  // `effectivePlanAction`: the state's suffix (recompose and project-type overrides),
  // else the stock scope grid.
  const action =
    stateSuffix(stateText, UNITS_GENERATION) ??
    (scope ? scopeGrid?.[scope]?.[UNITS_GENERATION] : undefined);
  if (action === "EXECUTE") return "per-unit";
  if (action === undefined) return "unknown";
  return checkedComplete(stateText, UNITS_GENERATION) ? "per-unit" : "stage-level";
}
