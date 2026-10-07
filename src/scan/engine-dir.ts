// Where a record's engine bookkeeping lives, new layout first.
//
// AI-DLC 2.9.0 moved the record-level engine files under one directory:
//
//   <record>/.aidlc-engine/hooks-health/   was <record>/.aidlc-hooks-health/
//   <record>/.aidlc-engine/stop-hook/      was <record>/.aidlc-stop-hook/
//   <record>/.aidlc-engine/sensors/        was <record>/.aidlc-sensors/
//
// A reader that knew only the old names saw nothing on a 2.9+ tree, and the page
// said so as fact: zero hooks, "stop hook · no record", every sensor failure
// without its finding body — three claims about the run that were really claims
// about this reader. Nothing broke loudly, because absence is a legal state for
// all three. Measured on one completed 2.10 run: 11 hook heartbeats, a stop-guard
// file and a sensor body on disk; the page showed none of them, with no warning.
//
// The rule below is a transcript of the engine's own `engineReadDirFor`
// (`aidlc-lib.ts`), so the dashboard reads the SAME directory the engine does:
// the new path unless it is absent AND the legacy one exists. Two details are
// load-bearing and easy to "simplify" away:
//
//   - a `.aidlc-engine` that exists but is not a directory pins the new path —
//     the engine treats a malformed new entry as present, not as absence, and
//     never revives legacy data behind it;
//   - an unreadable parent also pins the new path, for the same reason.
//
// Pre-2.9 trees (the reference fixture among them) keep reading through the fallback.
//
// THE FALLBACK IS NOT FOR EVERY DIR. The engine gives read-only fallbacks to
// persistent evidence only — sensors, hook health, summary authorizations, source
// review — and says everything else "is transient or derived and is rebuilt at the
// new path without a fallback" (`aidlc-lib.ts`, above `engineDir`). The stop
// hook's no-progress counter is one of those: `stopHookDir` returns the new path
// unconditionally. Falling back for it would hand a 2.9+ record a counter last
// written by the previous engine as if it were current, so `engineTransientDir`
// reads the legacy name only for a record with no `.aidlc-engine` at all — a record
// no 2.9+ engine has touched, whose counter is still that engine's own.
//
// Node fs only, never throws.

import * as fs from "node:fs";
import * as path from "node:path";

/** The record-level engine dir introduced in AI-DLC 2.9.0. */
export const ENGINE_DIR = ".aidlc-engine";

function lstat(p: string): fs.Stats | undefined {
  return fs.lstatSync(p, { throwIfNoEntry: false });
}

/**
 * The directory to read persistent evidence `sub` from: `<record>/.aidlc-engine/<sub>`,
 * or `<record>/<legacyName>` when the new one is absent and the legacy one exists.
 */
export function engineReadDir(recordDir: string, sub: string, legacyName: string): string {
  const current = path.join(recordDir, ENGINE_DIR, sub);
  const legacy = path.join(recordDir, legacyName);
  try {
    const engine = lstat(path.join(recordDir, ENGINE_DIR));
    if (engine !== undefined && !engine.isDirectory()) return current;
    return lstat(current) === undefined && fs.existsSync(legacy) ? legacy : current;
  } catch {
    return current;
  }
}

/**
 * The directory to read transient state `sub` from: the new path whenever the
 * record has an `.aidlc-engine` entry of any kind, the legacy name only when it has
 * none. See the header for why this differs from `engineReadDir`.
 */
export function engineTransientDir(recordDir: string, sub: string, legacyName: string): string {
  const current = path.join(recordDir, ENGINE_DIR, sub);
  try {
    return lstat(path.join(recordDir, ENGINE_DIR)) === undefined
      ? path.join(recordDir, legacyName)
      : current;
  } catch {
    return current;
  }
}
