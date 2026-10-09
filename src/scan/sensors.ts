// Sensor outcomes: how many fired, how many failed, and what the failures say.
//
// TWO SOURCES, DELIBERATELY. Neither alone is sufficient:
//
//   - the audit ledger has EVERY firing (SENSOR_FIRED, then a terminal
//     SENSOR_PASSED / SENSOR_FAILED / SENSOR_BUDGET_OVERRIDE correlated by
//     `Fire id`) but no finding bodies;
//   - `.aidlc-sensors/<stage>/<sensorId>-<fireId>.md` (`.aidlc-engine/sensors/…`
//     since AI-DLC 2.9.0 — scan/engine-dir.ts) has the finding bodies but
//     ONLY for failures — a passing fire writes no file (verified twice: 46 detail
//     files all `**Pass**: false`, and 54 on a second run, likewise all false).
//
// THE FILE SET IS A SUBSET, NOT A MIRROR, AND THE REASON IS THE CLONE. The first
// measurement had files and SENSOR_FAILED matching exactly (46 = 46), which reads
// like an invariant. It is not: a two-developer run had **84 failures and 54
// files**, and the split is exactly per shard —
//
//   seokwon-…-d645e6b4dc7e   30 failures →  0 detail files
//   lottes-…-74726ff984d7    54 failures → 54 detail files (1:1)
//
// because `audit/` is the ONLY per-clone-sharded source in a record.
// `.aidlc-sensors/`, `.aidlc-hooks-health/` and `.aidlc-stop-hook/` carry no clone
// dimension in their paths, so a tree that holds several clones' audit shards holds
// only ONE clone's sensor bodies — the other developer's findings never travelled.
// (The boundary looks temporal because the two shards' windows are adjacent, which
// is how an earlier reading of this same tree mistook it for the engine starting to
// write findings mid-run. It is not: same sensor ids, different machine.)
//
// So file count is a floor on failures, never the count, and a failure without a
// body means "recorded elsewhere", not "no findings". This is why `failures` walks
// the audit and attaches a body only when one exists — counting files would have
// under-reported by 36% — and why `failuresWithoutBody` is reported rather than
// left as a silent absence.
//
// So counts come from audit and bodies from disk, joined on fire id. Note we do
// NOT use runtime-graph.json's pre-aggregated `sensor_firings`: it is only
// recompiled at stage transitions, so for the in-flight stage — the one being
// looked at — it is empty while audit already holds hundreds of firings.
//
// A PASS WITH A `Note` EVALUATED NOTHING. `tool-unavailable` or `script-error: …`
// (`tools/aidlc-sensor.ts`) rides on `SENSOR_PASSED`, and `audit-format.md` says a
// blocking gate refuses it like a failure. Counting it as a pass put a green "checks
// passed" on a stage whose checker never ran, so it is its own count, `unevaluated`.
//
// A VERIFIED PASS RETIRES EARLIER FAILURES OF THE SAME OUTPUT. On a pass with no Note
// the engine deletes that sensor's older detail files for the same output path in the
// stage (`pruneSupersededDetailFiles`) — "without this the directory keeps showing a
// failure that no longer exists". The audit keeps the failure row, so a reader that
// stopped there showed the failure as current AND, its body now gone, as "recorded on
// another clone". A failure followed by such a pass is `supersededAt` instead. The
// engine compares realpaths; a reader of a copied tree compares the recorded spelling
// (separators normalised), so a second spelling of one output keeps the failure shown,
// which is the side to err on.
//
// Node fs only, never throws.

import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditLedger } from "./audit";
import { engineReadDir } from "./engine-dir";

/** A type-check finding row from the detail file's JSON block. */
export interface TypeCheckError {
  file: string;
  line?: number;
  column?: number;
  message: string;
}

/** One failed firing, with its finding body when the detail file was readable. */
export interface SensorFailure {
  /** Sensor id, e.g. "type-check" / "upstream-coverage". */
  id: string;
  stage: string;
  fireId: string;
  ts: string;
  /** The artifact/file the sensor judged, absolute as recorded by the engine. */
  outputPath?: string;
  /** `findings_count` from the JSON block. */
  findingsCount?: number;
  /** type-check / linter: the individual errors. */
  errors: TypeCheckError[];
  /** upstream-coverage: consumed artifacts never referenced by the output. */
  unreferenced: string[];
  /** Detail-file basename, or undefined when no body was found on disk. */
  detailFile?: string;
  /**
   * When a later verified pass of the same sensor on the same output in the same stage
   * retired this failure — the pass that made the engine delete its detail file.
   */
  supersededAt?: string;
}

/** Per-stage roll-up of firings. */
export interface SensorStageSummary {
  stage: string;
  fired: number;
  /** Verified passes only — a pass carrying a `Note` is in `unevaluated`. */
  passed: number;
  /** `SENSOR_PASSED` with a `Note`: the sensor ran nothing (tool missing, script error). */
  unevaluated: number;
  /** Of `unevaluated`, those no later verified pass of the same output answered. */
  unevaluatedStanding: number;
  failed: number;
  /** Failures a later verified pass retired; a subset of `failed`. */
  superseded: number;
  budgetOverride: number;
  /** Firings with no terminal event yet — in flight at read time. */
  pending: number;
  /** sensor id → firing count, so a stage shows which sensors dominate. */
  byId: Map<string, number>;
}

export interface SensorReport {
  /** In stage-first-seen order (audit is time-ordered, so run order). */
  stages: SensorStageSummary[];
  /** Every failure, newest first. */
  failures: SensorFailure[];
  totalFired: number;
  totalPassed: number;
  totalUnevaluated: number;
  totalFailed: number;
  /** Detail files found on disk that no audit failure claimed — a drift signal. */
  orphanDetailFiles: number;
  /**
   * Failures whose findings body is absent. Normal in a multi-clone record: the
   * audit merges every clone's shard while `.aidlc-sensors/` holds only the local
   * clone's files, so these findings exist — on another machine. Reported so the
   * screen can say that instead of showing a failure with an empty body. A superseded
   * failure is not counted: the engine deleted its body on purpose.
   */
  failuresWithoutBody: number;
}

interface DetailBody {
  fireId: string;
  sensorId: string;
  stage: string;
  ts?: string;
  outputPath?: string;
  findingsCount?: number;
  errors: TypeCheckError[];
  unreferenced: string[];
  file: string;
}

const FIELD_RE = /^\*\*([^*]+)\*\*:[ \t]*(.*)$/;

/** What a verified pass retires: one sensor, one stage, one output (spelling-normalised). */
function outputKey(e: { fields: Record<string, string>; stage?: string }): string | undefined {
  const id = e.fields["Sensor ID"];
  const output = e.fields["Output path"];
  if (!id || !output) return undefined;
  return `${e.stage ?? ""}\0${id}\0${output.trim().replace(/\\/g, "/")}`;
}

/**
 * Parse one `.aidlc-sensors/**` detail file. Exported for tests — the format
 * contract (header fields + a fenced JSON findings block) lives here alone.
 */
export function parseSensorDetail(
  text: string,
  fileName: string,
  stage: string,
): DetailBody | undefined {
  const fields: Record<string, string> = {};
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = FIELD_RE.exec(line);
    if (m) fields[m[1]!] = (m[2] ?? "").trim();
    // Header fields all precede the findings block; stop before parsing JSON.
    if (line.startsWith("## Findings")) break;
  }
  // `<sensorId>-<fireId8>.md` — the id may itself contain hyphens, so split on
  // the LAST one rather than the first.
  const base = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
  const cut = base.lastIndexOf("-");
  if (cut <= 0) return undefined;
  const sensorId = base.slice(0, cut);
  const fireId = fields["Fire id"] || base.slice(cut + 1);

  const errors: TypeCheckError[] = [];
  const unreferenced: string[] = [];
  let findingsCount: number | undefined;

  const fence = /```json\n([\s\S]*?)\n```/.exec(text);
  if (fence) {
    try {
      const j = JSON.parse(fence[1] ?? "") as Record<string, unknown>;
      if (typeof j.findings_count === "number") findingsCount = j.findings_count;
      if (Array.isArray(j.errors)) {
        for (const e of j.errors) {
          if (typeof e !== "object" || e === null) continue;
          const r = e as Record<string, unknown>;
          if (typeof r.file !== "string" || typeof r.message !== "string") continue;
          errors.push({
            file: r.file,
            line: typeof r.line === "number" ? r.line : undefined,
            column: typeof r.column === "number" ? r.column : undefined,
            message: r.message,
          });
        }
      }
      if (Array.isArray(j.unreferenced)) {
        for (const u of j.unreferenced) if (typeof u === "string") unreferenced.push(u);
      }
    } catch {
      // A truncated/partially-synced body: keep the header, drop the findings.
    }
  }

  return {
    fireId,
    sensorId,
    stage,
    ts: fields.Timestamp,
    outputPath: fields["Output path"],
    findingsCount,
    errors,
    unreferenced,
    file: fileName,
  };
}

/**
 * Read every detail file under the sensors dir, keyed by fire id —
 * `.aidlc-engine/sensors/` since AI-DLC 2.9.0, `.aidlc-sensors/` before it.
 */
function readDetailBodies(recordDir: string): Map<string, DetailBody> {
  const out = new Map<string, DetailBody>();
  const root = engineReadDir(recordDir, "sensors", ".aidlc-sensors");
  let stageDirs: string[];
  try {
    stageDirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const stage of stageDirs) {
    let files: string[];
    try {
      files = fs.readdirSync(path.join(root, stage));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      let text: string;
      try {
        text = fs.readFileSync(path.join(root, stage, f), "utf-8");
      } catch {
        continue;
      }
      const body = parseSensorDetail(text, f, stage);
      if (body) out.set(body.fireId, body);
    }
  }
  return out;
}

/**
 * Join the audit ledger's firings with the on-disk finding bodies.
 * `recordDir` is only read for the bodies, so a ledger-only call still yields
 * correct counts with empty failure details.
 */
export function readSensorReport(recordDir: string, ledger: AuditLedger): SensorReport {
  const bodies = readDetailBodies(recordDir);
  const claimed = new Set<string>();

  const perStage = new Map<string, SensorStageSummary>();
  const stageOf = (stage: string): SensorStageSummary => {
    let s = perStage.get(stage);
    if (!s) {
      s = {
        stage,
        fired: 0,
        passed: 0,
        unevaluated: 0,
        unevaluatedStanding: 0,
        failed: 0,
        superseded: 0,
        budgetOverride: 0,
        pending: 0,
        byId: new Map(),
      };
      perStage.set(stage, s);
    }
    return s;
  };

  // Terminal events per fire id, so a FIRED with no terminal counts as pending. A
  // noted pass is told apart here, and each output's LAST verified pass is kept for the
  // failures it retires.
  const terminal = new Map<string, string>();
  const lastVerifiedPass = new Map<string, { index: number; ts: string }>();
  const notedPasses: { index: number; stage: string; key?: string }[] = [];
  ledger.events.forEach((e, index) => {
    if (
      e.event === "SENSOR_PASSED" ||
      e.event === "SENSOR_FAILED" ||
      e.event === "SENSOR_BUDGET_OVERRIDE"
    ) {
      const noted = e.event === "SENSOR_PASSED" && Object.hasOwn(e.fields, "Note");
      const fid = e.fields["Fire id"];
      if (fid) terminal.set(fid, noted ? "SENSOR_PASSED+Note" : e.event);
      const key = e.event === "SENSOR_PASSED" ? outputKey(e) : undefined;
      if (noted) notedPasses.push({ index, stage: e.stage ?? "(unattributed)", key });
      else if (key) lastVerifiedPass.set(key, { index, ts: e.ts });
    }
  });
  const answered = (key: string | undefined, index: number): string | undefined => {
    const pass = key ? lastVerifiedPass.get(key) : undefined;
    return pass && pass.index > index ? pass.ts : undefined;
  };

  const failures: SensorFailure[] = [];
  for (const [index, e] of ledger.events.entries()) {
    if (e.event === "SENSOR_FIRED") {
      const stage = e.stage ?? "(unattributed)";
      const s = stageOf(stage);
      s.fired++;
      const id = e.fields["Sensor ID"] ?? "(unknown)";
      s.byId.set(id, (s.byId.get(id) ?? 0) + 1);
      const fid = e.fields["Fire id"];
      const t = fid ? terminal.get(fid) : undefined;
      if (t === "SENSOR_PASSED") s.passed++;
      else if (t === "SENSOR_PASSED+Note") s.unevaluated++;
      else if (t === "SENSOR_FAILED") s.failed++;
      else if (t === "SENSOR_BUDGET_OVERRIDE") s.budgetOverride++;
      else s.pending++;
      continue;
    }
    if (e.event !== "SENSOR_FAILED") continue;

    const fireId = e.fields["Fire id"] ?? "";
    const body = fireId ? bodies.get(fireId) : undefined;
    if (body) claimed.add(fireId);
    const supersededAt = answered(outputKey(e), index);
    if (supersededAt) stageOf(e.stage ?? body?.stage ?? "(unattributed)").superseded++;
    const countRaw = e.fields["Findings count"];
    failures.push({
      id: e.fields["Sensor ID"] ?? body?.sensorId ?? "(unknown)",
      stage: e.stage ?? body?.stage ?? "(unattributed)",
      fireId,
      ts: e.ts,
      outputPath: body?.outputPath,
      findingsCount:
        body?.findingsCount ?? (countRaw && /^\d+$/.test(countRaw) ? Number(countRaw) : undefined),
      errors: body?.errors ?? [],
      unreferenced: body?.unreferenced ?? [],
      detailFile: body?.file,
      ...(supersededAt ? { supersededAt } : {}),
    });
  }

  failures.reverse(); // ledger is ascending; failures read newest-first
  for (const p of notedPasses)
    if (!answered(p.key, p.index)) stageOf(p.stage).unevaluatedStanding++;

  const stages = [...perStage.values()];
  return {
    stages,
    failures,
    totalFired: stages.reduce((n, s) => n + s.fired, 0),
    totalPassed: stages.reduce((n, s) => n + s.passed, 0),
    totalUnevaluated: stages.reduce((n, s) => n + s.unevaluated, 0),
    totalFailed: stages.reduce((n, s) => n + s.failed, 0),
    orphanDetailFiles: [...bodies.keys()].filter((k) => !claimed.has(k)).length,
    failuresWithoutBody: failures.filter((f) => f.detailFile === undefined && !f.supersededAt)
      .length,
  };
}
