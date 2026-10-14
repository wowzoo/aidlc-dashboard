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
// (`proofFromVerificationRow`) is not tried. So `ask`/`approve` refuse a NEW approval
// of the unit until a verification passes (`askConstructionCheckpoint` /
// `approveConstructionCheckpoint`). Two things it does NOT settle, so the page does not
// say them: whether an approval the unit already holds is kept — it can be, over a scope
// change (`approvalKeptOverScopeChange` sets `approved` without `verified`) — and what
// has to happen next, since the verification command may itself be waiting on a person.
// Never a counted wait: no engine reader turns a failed verification into a person's ask.
//
// The same holds for a file `readProof` rejects (bad JSON, a field of the wrong shape):
// it reads as no proof, the file still exists, so no fallback — not verified. And one it
// cannot open (a link anywhere on the path, a hardlink, not a regular file, an error on
// the way) makes the engine stop with an error. What this reader cannot settle — the
// first unit's kind under `scope-dependent`, a file over its own size bound, a file that
// changed while being read — is reported `definite: false` and never with the claim.
//
// Only read where the engine's ROUTING resolves a unit checkpoint: checkpoints in force
// (`constructionCheckpointsApply`) and units of their own (not `usesStageLevelPerUnitArtifacts`)
// — the caller decides both. An explicit `aidlc-bolt.ts checkpoint --action status` reads
// a proof with no such gate; that is a command a person runs, not the run's state.
//
// The unit roster is the matrix's, which is the engine's `resolveBoltDag` (scan/unit-dag.ts):
// the authored `unit-of-work-dependency.md` first, the runtime graph only as a cache that
// still matches it. A malformed authored DAG yields no matrix, so no proof is read either;
// the engine's checkpoint readers likewise take nothing from a DAG that is not `ok`
// (aidlc-construction-checkpoints.ts, `dag.state !== "ok"`).

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
  /** The skeleton unit's kind could not be decided here, so both of its files are read. */
  kindUndetermined?: true;
  /**
   * True when the note is the engine's own verdict on the file it reads — not verified, or
   * refused with an error. False when this reader cannot settle it (see the header).
   */
  definite: boolean;
}

export type UnreadableCause =
  | "link"
  | "hardlink"
  | "not-file"
  | "read-failed"
  | "too-large"
  | "changed";

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
  | (NoteBase & { state: "unreadable"; cause: UnreadableCause });

const PROOF_DIR = ".aidlc-construction-checkpoints";
const CHECK_OUTPUT_TAIL_BYTES = 2048;
/** This reader's bound — the engine has none. A proof is ~1KB; past this, say "cannot tell". */
const MAX_BYTES = 1024 * 1024;
const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * The kind the engine reads for each unit — `constructionCheckpointKind`: the walking
 * skeleton's unit stops at the skeleton checkpoint, every other unit at its own. The
 * skeleton's unit is the FIRST OF THE BATCHES (`dag.batches.flat()[0]`), not of the
 * roster: the graph writes `units` in authored order and the batches level by level, each
 * sorted, so the two can differ. `constructionSkeletonOn` is `Skeleton Stance: on`, or
 * `scope-dependent` with the scope file's own `skeleton: on`. The scope file is not read
 * here, so `scope-dependent` leaves that unit's kind open — both files are read and the
 * notes are not definite. No batches → the skeleton's unit is unknown, so every unit's
 * kind is open while the skeleton may be on.
 */
export function checkpointKinds(
  skeletonStance: string | undefined,
  units: readonly string[],
  skeletonUnit: string | undefined,
): Map<string, CheckpointKind[]> {
  const stance = skeletonStance?.trim();
  const open: CheckpointKind[] = ["skeleton", "unit"];
  return new Map(
    units.map((u): [string, CheckpointKind[]] => {
      if (stance !== "on" && stance !== "scope-dependent") return [u, ["unit"]];
      if (skeletonUnit === undefined) return [u, open];
      if (u !== skeletonUnit) return [u, ["unit"]];
      return [u, stance === "on" ? ["skeleton"] : open];
    }),
  );
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
  | { kind: "unreadable"; cause: UnreadableCause };

const sameFile = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino;

/**
 * `readRegularFileNoFollowOrThrow(recordFileTargetOrThrow(root, rel))`: no link on the
 * chain from the record's real path down to the file; opened without following a link;
 * a regular file with exactly one link (a hardlink can alias content from elsewhere);
 * the pathname still naming the descriptor's file; and after the read the same file, the
 * same size, mtime and ctime, and as many bytes as it said. Only ENOENT is "no proof" —
 * `readProof` rethrows anything else, ENOTDIR included. The engine reads the proof with
 * no size bound; this one stops at `MAX_BYTES` and says it cannot tell.
 */
function readNoFollow(recordDir: string, rel: string): Read {
  let anchor: string;
  try {
    anchor = fs.realpathSync(recordDir);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unreadable", cause: "read-failed" };
  }
  if (!chainIsClean(anchor, rel)) return { kind: "unreadable", cause: "link" };
  const p = path.join(anchor, rel);
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | NO_FOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", cause: code === "ELOOP" ? "link" : "read-failed" };
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) return { kind: "unreadable", cause: "not-file" };
    if (st.nlink === 0n) return { kind: "unreadable", cause: "changed" };
    if (st.nlink !== 1n) return { kind: "unreadable", cause: "hardlink" };
    if (st.size > BigInt(MAX_BYTES)) return { kind: "unreadable", cause: "too-large" };
    if (fs.lstatSync(p).isSymbolicLink()) return { kind: "unreadable", cause: "link" };
    if (!sameFile(fs.statSync(fs.realpathSync(p), { bigint: true }), st)) {
      return { kind: "unreadable", cause: "changed" };
    }
    // Bounded like the engine's capped read: the stat size plus one detection byte.
    const buf = Buffer.alloc(Number(st.size) + 1);
    let length = 0;
    while (length < buf.length) {
      const n = fs.readSync(fd, buf, length, buf.length - length, length);
      if (n === 0) break;
      length += n;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      !sameFile(fs.statSync(fs.realpathSync(p), { bigint: true }), st) ||
      after.nlink !== 1n ||
      after.size !== st.size ||
      after.mtimeNs !== st.mtimeNs ||
      after.ctimeNs !== st.ctimeNs ||
      BigInt(length) !== st.size
    ) {
      return { kind: "unreadable", cause: "changed" };
    }
    return { kind: "text", text: buf.subarray(0, length).toString("utf-8") };
  } catch {
    return { kind: "unreadable", cause: "read-failed" };
  } finally {
    fs.closeSync(fd);
  }
}

/** Causes the engine meets the same way — it refuses the file and stops with an error. */
const ENGINE_REFUSES: ReadonlySet<UnreadableCause> = new Set([
  "link",
  "hardlink",
  "not-file",
  "read-failed",
]);

const str = (v: unknown) => (typeof v === "string" ? v : null);

/**
 * Every roster unit's proof the engine would read, reported only where the engine
 * cannot count it verified. Roster order, then kind order.
 */
export function readCheckpointProofs(
  recordDir: string,
  units: readonly string[],
  skeletonStance: string | undefined,
  /** `batches.flat()[0]`; undefined when the graph carries no batches. */
  skeletonUnit: string | undefined,
): CheckpointProofNote[] {
  const notes: CheckpointProofNote[] = [];
  for (const [unit, kinds] of checkpointKinds(skeletonStance, units, skeletonUnit)) {
    const open = kinds.length > 1;
    for (const kind of kinds) {
      const rel = `${PROOF_DIR}/${unit}/${kind}.json`;
      const base: NoteBase = {
        unit,
        kind,
        rel,
        ...(open ? { kindUndetermined: true as const } : {}),
        definite: !open,
      };
      const r = readNoFollow(recordDir, rel);
      if (r.kind === "absent") continue;
      if (r.kind === "unreadable") {
        notes.push({
          ...base,
          definite: base.definite && ENGINE_REFUSES.has(r.cause),
          state: "unreadable",
          cause: r.cause,
        });
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
