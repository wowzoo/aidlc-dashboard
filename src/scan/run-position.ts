// Where the run is — which stage, and which unit — and the engine's own record of
// what it last handed out.
//
// WHY NOT `Current Stage`. Under unit-major Construction the engine keeps `Current
// Stage` on the FIRST per-unit stage while units walk through the later ones
// (2.11 aidlc-state.ts: "Under unit-major the Unit's stage is not Current Stage,
// which stays on the first per-unit stage"; aidlc-lib.ts: "the durable cursor stays
// on the first block stage"). Measured on run E: three code-generation plan
// approvals were asked while `Current Stage` still read functional-design, so the
// dashboard filed all three under "earlier stage" and showed nothing waiting.
//
// THE ORDER, and why each step is trusted:
//
//   1. `Unit Stage` + `Active Unit` (2.11 state, `## Runtime State`). The engine
//      writes both on every unit start/resume/pause and removes them on complete;
//      its statusline reads them first. 2.10 never writes `Unit Stage`.
//   2. `.aidlc-engine/active-directive.json` — the directive the engine last handed
//      out — but ONLY when its `state_sha256` equals the digest of the state file
//      as it is now, which is the engine's own acceptance test
//      (`readActiveDirectiveMarker`). A superseded or rehydrate-pending marker is
//      not current either. A stale marker would name a stage the run has left.
//   3. `Current Stage`, and when that can lag (unit-major, a per-unit stage) the
//      reading says it is unverified rather than claiming the engine is there.
//
// THE DIGEST is a transcription of the engine's `stateDigest` /
// `projectStateForDigest` (aidlc-lib.ts): drop empty lines, the `## Unit Progress`
// table rows and a fixed list of cache/breadcrumb fields; read `Change Control` as
// `Guard Policy`; sha256 over the rest joined by LF. 2.10 and 2.11 project
// identically except that 2.11 also ignores `Unit Stage`, a field 2.10 never
// writes — so one function serves both generations. Checked against the 2.11.0
// function on a sample state (the test pins the value it returned).
//
// Read-only and never throws: a missing or malformed marker is "no marker", with
// the reason kept so the page can say why it fell back.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ENGINE_DIR } from "./engine-dir";

/** `STATE_DIGEST_IGNORED_FIELDS`, 2.11.0 aidlc-lib.ts — the 2.10 list minus nothing it writes. */
const DIGEST_IGNORED = new Set([
  "Last Updated",
  "Active Agent",
  "Practices Affirmed Timestamp",
  "Start Date",
  "Active Unit",
  "Unit Stage",
  "Unit State",
  "Unit Pause Reason",
  "Unit Next Action",
  "Completed",
  "Worktree Path",
  "Bolt Refs",
  "Project",
  "Project Description Source",
  "Project Root",
  "Languages",
  "Frameworks",
  "Build System",
  "Last Completed Stage",
  "Next Action",
  "Pending Artifacts",
]);

/** The engine's `stateDigest`: which state an issued directive was issued against. */
export function stateDigest(stateText: string): string {
  const kept: string[] = [];
  let inDerivedTable = false;
  for (const line of stateText.split(/\r\n|[\n\r\u2028\u2029]/)) {
    if (line === "") continue;
    if (line.startsWith("## ")) {
      inDerivedTable = line.trim() === "## Unit Progress";
      kept.push(line);
      continue;
    }
    if (inDerivedTable && /^[ \t]*\|/.test(line)) continue;
    const field = /^- \*\*([^*]+)\*\*:/.exec(line);
    if (field && DIGEST_IGNORED.has((field[1] ?? "").trim())) continue;
    if (field?.[1]?.trim() === "Change Control") {
      kept.push(line.replace(/^- \*\*Change Control\*\*:/, "- **Guard Policy**:"));
      continue;
    }
    kept.push(line);
  }
  return createHash("sha256").update(kept.join("\n"), "utf-8").digest("hex");
}

/** The fields of `active-directive.json` this dashboard reads. The file has many more. */
export interface DirectiveMarker {
  kind: string;
  stage: string;
  unit?: string;
  /** Set on an `ask` directive (2.11 lists ten; 2.10 had four). */
  askType?: string;
  delivery?: string;
}

/** Why there is no usable marker — kept so the page can say why it fell back. */
export type MarkerMiss = "absent" | "unreadable" | "stale" | "superseded";

/** Same cap as the engine's reader: a marker over 64 KiB is not one it would accept. */
const MARKER_MAX_BYTES = 64 * 1024;

function markerPath(recordDir: string): string | undefined {
  // The engine falls back to the legacy root file only when the new one is absent.
  const current = path.join(recordDir, ENGINE_DIR, "active-directive.json");
  if (fs.existsSync(current)) return current;
  const legacy = path.join(recordDir, ".aidlc-active-directive.json");
  return fs.existsSync(legacy) ? legacy : undefined;
}

/**
 * The directive the engine last handed out, if it was issued against the state file
 * as it is now. Never throws.
 */
export function readDirectiveMarker(
  recordDir: string,
  stateText: string,
): { marker: DirectiveMarker } | { miss: MarkerMiss } {
  const p = markerPath(recordDir);
  if (!p) return { miss: "absent" };
  let j: Record<string, unknown>;
  try {
    if (fs.statSync(p).size > MARKER_MAX_BYTES) return { miss: "unreadable" };
    const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { miss: "unreadable" };
    j = parsed as Record<string, unknown>;
  } catch {
    return { miss: "unreadable" };
  }
  const str = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : undefined);
  const stage = str("stage");
  const digest = str("state_sha256");
  if (!stage || !digest || !/^[0-9a-f]{64}$/.test(digest)) return { miss: "unreadable" };
  if (digest !== stateDigest(stateText)) return { miss: "stale" };
  if (str("delivery") === "superseded" || j.needs_rehydrate === true) return { miss: "superseded" };
  return {
    marker: {
      kind: str("kind") ?? "",
      stage,
      unit: str("unit") || undefined,
      askType: str("ask_type") || undefined,
      delivery: str("delivery"),
    },
  };
}

/** Where the run is, and how sure this reading is. */
export interface RunPosition {
  /** Stage slug, or undefined when the state names none (`none`, or a finished run). */
  stage?: string;
  unit?: string;
  basis: "unit-stage" | "directive" | "current-stage";
  /**
   * False when the reading fell back to `Current Stage` for a per-unit stage under
   * unit-major, where the engine may be further on than the field says.
   */
  verified: boolean;
  /** Why the directive marker was not used, when it was not. */
  markerMiss?: MarkerMiss;
}

export interface PositionInput {
  currentStage: string;
  unitStage: string;
  activeUnit: string;
  constructionIteration: string;
  /** True when the catalogue says this stage runs once per unit. */
  isPerUnit?: (slug: string) => boolean;
  marker: { marker: DirectiveMarker } | { miss: MarkerMiss };
}

/** Resolve the run's position — see THE ORDER in the header. */
export function resolvePosition(p: PositionInput): RunPosition {
  if (p.unitStage && p.activeUnit) {
    return { stage: p.unitStage, unit: p.activeUnit, basis: "unit-stage", verified: true };
  }
  const markerMiss = "miss" in p.marker ? p.marker.miss : undefined;
  if ("marker" in p.marker) {
    const m = p.marker.marker;
    return { stage: m.stage, unit: m.unit, basis: "directive", verified: true };
  }
  const stage = p.currentStage && p.currentStage !== "none" ? p.currentStage : undefined;
  const canLag =
    p.constructionIteration === "unit-major" && !!stage && (p.isPerUnit?.(stage) ?? false);
  return { stage, basis: "current-stage", verified: !canLag, markerMiss };
}
