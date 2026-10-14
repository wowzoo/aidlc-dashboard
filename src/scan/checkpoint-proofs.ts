// Construction checkpoint proofs — the file the engine's `verify` writes for a unit's
// checkpoint, at `<record>/.aidlc-construction-checkpoints/<unit>/<kind>.json`
// (2.11.0 `aidlc-construction-checkpoints.ts`, `proofRelativePath`). Read-only, bounded,
// never throws.
//
// WHAT THE PAGE MAY CLAIM FROM IT. The engine's `verified` is `verifiedWith`: the proof's
// own fields (kind, unit, verified, evidence_unchanged, exit code, signal, error,
// finished_at) AND a fingerprint of the unit's evidence, the authorised command's hash
// and the audit's verification row. The second half needs the workspace source listing
// and the claim files, which this reader does not reproduce — so a proof whose own
// fields all pass says NOTHING here: it may or may not still be current. A proof whose
// own fields fail is different, and certain: `verifiedWith` refuses it before the
// fingerprint, and with a proof file present the committed-row fallback
// (`proofFromVerificationRow`) is not tried. The engine then neither asks for nor
// accepts the unit's approval (`askConstructionCheckpoint` / `approve…` require
// `verified`), and the next move is the agent's — verify again — not a person's. So it
// is a diagnostic beside the matrix, never a counted wait.
//
// The same holds for a file `readProof` rejects (bad JSON, a field of the wrong shape):
// it reads as no proof, the file still exists, so no fallback — not verified. And one it
// cannot open (a link anywhere on the path, not a regular file) makes the engine stop with
// an error, which is worth saying too.
//
// Only read where the engine reads it: `constructionCheckpointsApply` (checkpoints
// enabled, not team, a per-unit stage that writes code) — the caller decides that, from
// the same policy the receipt reader uses.

import * as fs from "node:fs";
import * as path from "node:path";
import { chainIsClean } from "./audit";

export type CheckpointKind = "unit" | "skeleton";

/** Which of `verifiedWith`'s proof-level checks failed, in its order. */
export type ProofFault =
  | "wrong-kind"
  | "wrong-unit"
  | "not-verified"
  | "evidence-changed"
  | "exit-code"
  | "signal"
  | "error"
  | "unfinished";

interface NoteBase {
  unit: string;
  kind: CheckpointKind;
  /** Record-relative path of the proof. */
  rel: string;
  /** `Skeleton Stance: scope-dependent` on the first unit: both files are read. */
  kindUndetermined?: true;
}

export type CheckpointProofNote =
  | (NoteBase & {
      state: "failed";
      faults: ProofFault[];
      exitCode: number | null;
      signal: string | null;
      error: string | null;
      startedAt: string;
      finishedAt: string | null;
      commandLabel: string;
      stdoutTail: string;
      stderrTail: string;
    })
  | (NoteBase & { state: "malformed" })
  | (NoteBase & { state: "unreadable"; cause: "link" | "not-file" | "read-failed" | "too-large" });

const PROOF_DIR = ".aidlc-construction-checkpoints";
const CHECK_OUTPUT_TAIL_BYTES = 2048;
/** The engine reads the file whole; a proof is ~1KB, so this only stops a runaway file. */
const MAX_BYTES = 1024 * 1024;
const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * The kind the engine reads for each unit — `constructionCheckpointKind`: the walking
 * skeleton's first unit (roster order) stops at the skeleton checkpoint, every other at
 * its own. `constructionSkeletonOn` is `Skeleton Stance: on`, or `scope-dependent` with
 * the scope's own `skeleton: on`. The scope file is not read here, so `scope-dependent`
 * leaves the first unit's kind open and both files are read — an approximation, said
 * on screen through `kindUndetermined`.
 */
export function checkpointKinds(
  skeletonStance: string | undefined,
  units: readonly string[],
): Map<string, CheckpointKind[]> {
  const stance = skeletonStance?.trim();
  const first: CheckpointKind[] =
    stance === "on" ? ["skeleton"] : stance === "scope-dependent" ? ["skeleton", "unit"] : ["unit"];
  return new Map(units.map((u, i) => [u, i === 0 ? first : ["unit"]]));
}

/** `hasUnsafeSingleLineCharacter`, plus `readProof`'s own extra class for the label. */
function unsafeLabel(label: string): boolean {
  for (const ch of label) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || cp === 0x7f || cp === 0x2028 || cp === 0x2029) return true;
  }
  return /[\x80-\x9f\p{Cf}\p{Zl}\p{Zp}\u00a0]/u.test(label);
}

const safeCount = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

/** `readProof`'s shape check — anything it rejects reads as no proof. */
function proofShape(doc: unknown): Record<string, unknown> | undefined {
  if (doc === null || typeof doc !== "object") return undefined;
  const p = doc as Record<string, unknown>;
  const label = p.command_label;
  const ok =
    p.version === 4 &&
    typeof p.id === "string" &&
    typeof p.fingerprint === "string" &&
    typeof p.command_sha256 === "string" &&
    SHA256.test(p.command_sha256) &&
    typeof label === "string" &&
    label.trim() !== "" &&
    label.length <= 1024 &&
    !unsafeLabel(label) &&
    typeof p.started_at === "string" &&
    safeCount(p.stdout_bytes) &&
    safeCount(p.stderr_bytes) &&
    typeof p.stdout_tail === "string" &&
    p.stdout_tail.length <= CHECK_OUTPUT_TAIL_BYTES &&
    typeof p.stderr_tail === "string" &&
    p.stderr_tail.length <= CHECK_OUTPUT_TAIL_BYTES &&
    typeof p.stdout_sha256 === "string" &&
    SHA256.test(p.stdout_sha256) &&
    typeof p.stderr_sha256 === "string" &&
    SHA256.test(p.stderr_sha256);
  return ok ? p : undefined;
}

/** `verifiedWith`'s checks on the file alone, in its order. */
function faultsOf(p: Record<string, unknown>, kind: CheckpointKind, unit: string): ProofFault[] {
  const f: ProofFault[] = [];
  if (p.kind !== kind) f.push("wrong-kind");
  if (p.unit !== unit) f.push("wrong-unit");
  if (p.verified !== true) f.push("not-verified");
  if (p.evidence_unchanged !== true) f.push("evidence-changed");
  if (p.exit_code !== 0) f.push("exit-code");
  if (p.signal !== null) f.push("signal");
  if (p.error !== null) f.push("error");
  if (typeof p.finished_at !== "string") f.push("unfinished");
  return f;
}

type Read =
  | { kind: "absent" }
  | { kind: "text"; text: string }
  | { kind: "unreadable"; cause: "link" | "not-file" | "read-failed" | "too-large" };

/**
 * `readRegularFileNoFollowOrThrow(recordFileTargetOrThrow(root, rel))`: no link on the
 * chain from the record's real path down to the file, opened without following a link,
 * and a regular file. ENOENT is "no proof", as the engine reads it.
 */
function readNoFollow(recordDir: string, rel: string): Read {
  let anchor: string;
  try {
    anchor = fs.realpathSync(recordDir);
  } catch {
    return { kind: "absent" };
  }
  if (!chainIsClean(anchor, rel)) return { kind: "unreadable", cause: "link" };
  const p = path.join(anchor, rel);
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | NO_FOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable", cause: code === "ELOOP" ? "link" : "read-failed" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { kind: "unreadable", cause: "not-file" };
    if (st.size > MAX_BYTES) return { kind: "unreadable", cause: "too-large" };
    return { kind: "text", text: fs.readFileSync(fd, "utf-8") };
  } catch {
    return { kind: "unreadable", cause: "read-failed" };
  } finally {
    fs.closeSync(fd);
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/**
 * Every roster unit's proof the engine would read, reported only where the engine
 * cannot count it verified. Roster order, then kind order.
 */
export function readCheckpointProofs(
  recordDir: string,
  units: readonly string[],
  skeletonStance: string | undefined,
): CheckpointProofNote[] {
  const notes: CheckpointProofNote[] = [];
  for (const [unit, kinds] of checkpointKinds(skeletonStance, units)) {
    for (const kind of kinds) {
      const rel = `${PROOF_DIR}/${unit}/${kind}.json`;
      const base: NoteBase = {
        unit,
        kind,
        rel,
        ...(kinds.length > 1 ? { kindUndetermined: true as const } : {}),
      };
      const r = readNoFollow(recordDir, rel);
      if (r.kind === "absent") continue;
      if (r.kind === "unreadable") {
        notes.push({ ...base, state: "unreadable", cause: r.cause });
        continue;
      }
      let doc: unknown;
      try {
        doc = JSON.parse(r.text);
      } catch {
        notes.push({ ...base, state: "malformed" });
        continue;
      }
      const p = proofShape(doc);
      if (!p) {
        notes.push({ ...base, state: "malformed" });
        continue;
      }
      const faults = faultsOf(p, kind, unit);
      if (faults.length === 0) continue;
      notes.push({
        ...base,
        state: "failed",
        faults,
        exitCode: typeof p.exit_code === "number" ? p.exit_code : null,
        signal: str(p.signal),
        error: str(p.error),
        startedAt: p.started_at as string,
        finishedAt: str(p.finished_at),
        commandLabel: p.command_label as string,
        stdoutTail: p.stdout_tail as string,
        stderrTail: p.stderr_tail as string,
      });
    }
  }
  return notes;
}
