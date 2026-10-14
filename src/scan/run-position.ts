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
//      its statusline reads them first.
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
// `Guard Policy`; sha256 over the rest joined by LF. Checked against the 2.11.0
// function on a sample state (the test pins the value it returned).
//
// Read-only and never throws: a missing or malformed marker is "no marker", with
// the reason kept so the page can say why it fell back.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ENGINE_DIR } from "./engine-dir";

/** `STATE_DIGEST_IGNORED_FIELDS`, 2.11.0 aidlc-lib.ts. */
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
  /** Set on an `ask` directive — one of the ten 2.11 `ask_type`s. */
  askType?: string;
  delivery?: string;
  /**
   * A guard-recovery ask's answer state: `ready` means the person has answered and
   * the remedy can run — the engine's shared human wait is over
   * (`hasCurrentSharedGuardRecoveryWait`), even while the marker stays `consumed`.
   */
  guardRecovery?: string;
}

/** Why there is no usable marker — kept so the page can say why it fell back. */
export type MarkerMiss = "absent" | "unreadable" | "stale" | "superseded";

/** The engine's `ACTIVE_DIRECTIVE_MAX_BYTES`. */
const MARKER_MAX_BYTES = 64 * 1024;

const KINDS = new Set([
  "load-steering",
  "run-stage",
  "ask",
  "print",
  "error",
  "done",
  "parked",
  "notice",
  "dispatch-subagent",
  "invoke-swarm",
  "present-gate",
]);

/**
 * The engine's path rule (`activeDirectiveMarkerPath`): the legacy root file only when
 * BOTH the new marker and the new lock are absent — an unreadable new location is not
 * absence, and must not revive legacy state through it.
 */
function markerPath(recordDir: string): string | undefined {
  const engine = path.join(recordDir, ENGINE_DIR);
  const current = path.join(engine, "active-directive.json");
  try {
    const engineEntry = fs.lstatSync(engine, { throwIfNoEntry: false });
    if (engineEntry === undefined || engineEntry.isDirectory()) {
      const marker = fs.lstatSync(current, { throwIfNoEntry: false });
      const lock = fs.lstatSync(path.join(engine, "active-directive.lock"), {
        throwIfNoEntry: false,
      });
      if (marker === undefined && lock === undefined) {
        const legacy = path.join(recordDir, ".aidlc-active-directive.json");
        return fs.lstatSync(legacy, { throwIfNoEntry: false })?.isFile() ? legacy : undefined;
      }
    }
  } catch {
    // Fail closed onto the new path, as the engine does.
  }
  return fs.existsSync(current) ? current : undefined;
}

/** One descriptor, at most cap + 1 bytes — a file growing between stat and read cannot slip past. */
function boundedRead(p: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(MARKER_MAX_BYTES + 1);
    let length = 0;
    while (length < buf.byteLength) {
      const n = fs.readSync(fd, buf, length, buf.byteLength - length, length);
      if (n === 0) break;
      length += n;
    }
    return length > MARKER_MAX_BYTES ? undefined : buf.subarray(0, length).toString("utf-8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // read-only descriptor; close is best-effort
      }
    }
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z][a-z0-9-]*$/;
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

/**
 * `parseActiveDirectiveMarker` (2.11 aidlc-lib.ts), its structural checks transcribed:
 * a marker the engine would refuse is not one this page may read a position or an ask
 * from. NOT transcribed — the guard-recovery remedy list (`validActiveDirectiveGuardRemedies`,
 * `isGuardRemedyOp`, the feedback-hash rule that depends on it) and `validateUnitName`
 * on `units` (only non-empty strings are checked). Both are fields only the engine's own
 * writers produce. v1 carries no kind, so it gives a position and never an ask.
 */
function parseMarker(j: unknown): DirectiveMarker | undefined {
  if (!isObject(j)) return undefined;
  const stage = typeof j.stage === "string" ? j.stage.trim() : "";
  const unit = typeof j.unit === "string" ? j.unit.trim() : undefined;
  if (!SLUG.test(stage) || ("unit" in j && !unit) || !HEX64.test(String(j.state_sha256 ?? ""))) {
    return undefined;
  }
  if (j.version === 1) return { kind: "", stage, ...(unit ? { unit } : {}) };
  const a = isObject(j.active_attempt) ? j.active_attempt : undefined;
  const resume = isObject(j.resume) ? j.resume : undefined;
  const g = isObject(j.guard_recovery_response) ? j.guard_recovery_response : undefined;
  const optHex = (k: string) => !(k in j) || HEX64.test(String(j[k] ?? ""));
  const bad =
    j.version !== 2 ||
    !HEX64.test(String(j.project_sha256 ?? "")) ||
    (j.intent_uuid !== null && typeof j.intent_uuid !== "string") ||
    typeof j.state_present !== "boolean" ||
    ("code_generation_source_sha256" in j &&
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64}|unbindable)$/.test(
        String(j.code_generation_source_sha256 ?? ""),
      )) ||
    ("code_generation_authority_revision" in j && !isCount(j.code_generation_authority_revision)) ||
    ("rules_bundle" in j && !/^sha256:[0-9a-f]{64}$/.test(String(j.rules_bundle ?? ""))) ||
    !optHex("directive_sha256") ||
    ("units" in j &&
      (!Array.isArray(j.units) ||
        j.units.length === 0 ||
        j.units.some((u) => typeof u !== "string" || u.trim() === ""))) ||
    ("remedies" in j &&
      (j.kind !== "ask" || j.ask_type !== "guard-recovery" || !Array.isArray(j.remedies))) ||
    ("cursor_harness" in j &&
      (typeof j.cursor_harness !== "string" ||
        !/^[a-z0-9][a-z0-9._-]*$/i.test(j.cursor_harness))) ||
    ("ask_type" in j && (typeof j.ask_type !== "string" || !SLUG.test(j.ask_type))) ||
    ("guard_recovery_response" in j &&
      (j.kind !== "ask" ||
        j.ask_type !== "guard-recovery" ||
        !g ||
        Object.keys(g).some(
          (k) =>
            !["status", "selection_sha256", "selected_op", "feedback_sha256", "picked_by"].includes(
              k,
            ),
        ) ||
        ("picked_by" in g && !["person", "conductor"].includes(String(g.picked_by))) ||
        !["awaiting-feedback", "ready"].includes(String(g.status)) ||
        !HEX64.test(String(g.selection_sha256 ?? "")))) ||
    ("message" in j &&
      (typeof j.message !== "string" || Buffer.byteLength(j.message, "utf-8") > 2000)) ||
    typeof j.owner_session !== "string" ||
    j.owner_session.length === 0 ||
    ![j.revision, j.owner_epoch, j.context_epoch, j.event_sequence, j.human_sequence].every(
      isCount,
    ) ||
    ![j.engine_sequence, j.conversation_sequence, j.stop_count].every(isCount) ||
    !KINDS.has(String(j.kind)) ||
    !["issued", "delivered", "consumed", "superseded"].includes(String(j.delivery)) ||
    typeof j.needs_rehydrate !== "boolean" ||
    !a ||
    ("id" in a && typeof a.id !== "string") ||
    !["next", "continue", "report", "park"].includes(String(a.command_kind)) ||
    !HEX64.test(String(a.command_sha256 ?? "")) ||
    !HEX64.test(String(a.issued_state_sha256 ?? "")) ||
    typeof a.session_id !== "string" ||
    !isCount(a.owner_epoch) ||
    !isCount(a.context_epoch) ||
    !["pending", "settled", "failed"].includes(String(a.status)) ||
    ("claim_revision" in a && !isCount(a.claim_revision)) ||
    ("shared_attempt" in a && typeof a.shared_attempt !== "boolean") ||
    ["cursor_input_sha256", "result_sha256", "guard_recovery_selection_sha256"].some(
      (k) => k in a && !HEX64.test(String(a[k] ?? "")),
    ) ||
    ("result_revision" in a && !isCount(a.result_revision)) ||
    ("resume_gate_revision" in a && !isCount(a.resume_gate_revision)) ||
    (resume !== undefined &&
      (!["waiting", "selected", "superseded"].includes(String(resume.status)) ||
        typeof resume.issuing_stage !== "string" ||
        !HEX64.test(String(resume.issuing_state_sha256 ?? "")) ||
        typeof resume.issuing_session !== "string" ||
        (resume.issuing_intent_uuid !== null && typeof resume.issuing_intent_uuid !== "string")));
  if (bad) return undefined;
  if (j.continue_token !== undefined) {
    if (
      typeof j.continue_token !== "string" ||
      Buffer.byteLength(j.continue_token, "utf-8") > 16 * 1024
    ) {
      return undefined;
    }
    const sha = createHash("sha256").update(j.continue_token, "utf-8").digest("hex");
    if (sha !== j.continue_token_sha256) return undefined;
  }
  if (j.steering_payload !== undefined && !isObject(j.steering_payload)) return undefined;
  if (
    j.steering_payload_receipt !== undefined &&
    (typeof j.steering_payload_receipt !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(j.steering_payload_receipt))
  ) {
    return undefined;
  }
  if (
    j.kind === "load-steering" &&
    (!Number.isInteger(j.part) ||
      !Number.isInteger(j.parts) ||
      (j.part as number) < 1 ||
      (j.part as number) > (j.parts as number) ||
      j.continue_token === undefined)
  ) {
    return undefined;
  }
  return {
    kind: String(j.kind),
    stage,
    ...(unit ? { unit } : {}),
    ...(typeof j.ask_type === "string" ? { askType: j.ask_type } : {}),
    delivery: String(j.delivery),
    ...(g ? { guardRecovery: String(g.status) } : {}),
  };
}

/**
 * The directive the engine last handed out, if the engine would read it AND it was
 * issued against the state file as it is now (`readActiveDirectiveMarker`). Refusing a
 * superseded or rehydrate-pending one is THIS reader's policy, not that function's: the
 * engine replaces such a marker before acting on it, so it says nothing about now.
 * Never throws.
 */
export function readDirectiveMarker(
  recordDir: string,
  stateText: string,
): { marker: DirectiveMarker } | { miss: MarkerMiss } {
  const p = markerPath(recordDir);
  if (!p) return { miss: "absent" };
  const text = boundedRead(p);
  let raw: unknown;
  try {
    raw = text === undefined ? undefined : JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const marker = parseMarker(raw);
  if (!marker || !isObject(raw)) return { miss: "unreadable" };
  if (raw.state_sha256 !== stateDigest(stateText)) return { miss: "stale" };
  if (raw.delivery === "superseded" || raw.needs_rehydrate === true) return { miss: "superseded" };
  return { marker };
}

/** Where the run is, and how sure this reading is. */
export interface RunPosition {
  /** Stage slug, or undefined when the state names none (`none`, or a finished run). */
  stage?: string;
  unit?: string;
  basis: "unit-stage" | "directive" | "current-stage";
  /**
   * False when this reading cannot claim the engine is here: the fallback to a
   * `Current Stage` that can lag, or a unit cache the current directive contradicts.
   */
  verified: boolean;
  /** Why the directive marker was not used, when it was not. */
  markerMiss?: MarkerMiss;
  /** A current directive naming a different stage or unit than the unit cache. */
  conflict?: { stage: string; unit?: string };
  /**
   * The unit cache names a unit the resolved roster does not have (`absent`), or the
   * roster cannot be read (`unknown`, the engine's `malformed`). The engine walks only the
   * roster's units and resumes an active one only from among them (`nextUncoveredUnit`),
   * so neither case is a position this reader can claim.
   */
  offRoster?: "absent" | "unknown";
}

export interface PositionInput {
  currentStage: string;
  unitStage: string;
  activeUnit: string;
  constructionIteration: string;
  /** True when the catalogue says this stage runs once per unit; absent = no catalogue. */
  isPerUnit?: (slug: string) => boolean;
  /**
   * The resolved unit roster (scan/unit-dag.ts): the units, `null` when it is malformed
   * (unknowable), absent when there is no DAG — then the cache is not checked against one.
   */
  rosterUnits?: string[] | null;
  marker: { marker: DirectiveMarker } | { miss: MarkerMiss };
}

/**
 * Resolve the run's position — see THE ORDER in the header. Neither the unit cache nor
 * the marker is the engine's routing authority (that is the orchestrator's walk over
 * receipts and the DAG; the cache is documented as a cache), so when the two disagree
 * the reading keeps the cache's last lifecycle position and says it is contradicted,
 * rather than picking a winner it cannot justify.
 */
export function resolvePosition(p: PositionInput): RunPosition {
  const marker = "marker" in p.marker ? p.marker.marker : undefined;
  const markerMiss = "miss" in p.marker ? p.marker.miss : undefined;
  if (p.unitStage && p.activeUnit) {
    const agrees = !marker || (marker.stage === p.unitStage && marker.unit === p.activeUnit);
    const offRoster =
      p.rosterUnits === null
        ? ("unknown" as const)
        : p.rosterUnits && !p.rosterUnits.includes(p.activeUnit)
          ? ("absent" as const)
          : undefined;
    return {
      stage: p.unitStage,
      unit: p.activeUnit,
      basis: "unit-stage",
      verified: agrees && !offRoster,
      ...(agrees || !marker ? {} : { conflict: { stage: marker.stage, unit: marker.unit } }),
      ...(offRoster ? { offRoster } : {}),
    };
  }
  if (marker) return { stage: marker.stage, unit: marker.unit, basis: "directive", verified: true };
  const stage = p.currentStage && p.currentStage !== "none" ? p.currentStage : undefined;
  // Without a catalogue there is no telling which stages run per unit, so under
  // unit-major any stage might lag — the claim is lowered, not assumed.
  const canLag =
    p.constructionIteration === "unit-major" &&
    !!stage &&
    (p.isPerUnit ? p.isPerUnit(stage) : true);
  return { stage, basis: "current-stage", verified: !canLag, markerMiss };
}
