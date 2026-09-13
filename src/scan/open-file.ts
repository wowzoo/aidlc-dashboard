// Open one record artifact in the user's default editor.
//
// WHY THE SERVER DOES THIS. A browser cannot launch a local application — that
// is the sandbox working as designed. But this server is a local bun process the
// user started themselves, so it can. The click therefore travels
// browser → GET /open?rel=... → this module → OS "open with default app".
//
// THE PATH IS NEVER TRUSTED. `rel` arrives from the page, so it is treated as
// hostile input and must survive three checks before anything is spawned:
//
//   1. resolve it under the record dir and confirm the result is still inside
//      (blocks `../../../etc/passwd` and absolute paths alike),
//   2. confirm it is a regular file — realpath'd, so a symlink pointing outside
//      the record is rejected even though step 1 passed on the link itself,
//   3. confirm the extension is allowed (.md only today).
//
// THOSE THREE CHECKS ARE `resolveArtifact`, AND THAT SPLIT IS DELIBERATE. They used
// to be inlined here, entangled with the opener probe — so a second reader of the
// same file (`/view`, which renders the source instead of launching an editor) could
// only reuse them by also dragging in `spawn`, `PATH` probing and the win32
// interpreter branch. The jail is a property of the RECORD, not of the opener, so it
// is its own function with its own refusal union (`JailRefusal`) and `openArtifact`
// is what adds the four opener-specific refusals on top.
//
// The command is spawned with an ARGUMENT ARRAY, never a shell string, so a file
// name containing shell metacharacters cannot become a command — on darwin and
// linux. WIN32 IS THE EXCEPTION and the blanket claim used to be made there too:
// the opener is `cmd /c start ""`, so the array is handed to a command INTERPRETER
// that re-parses it, and Node's arg escaping does not save `cmd.exe` from `&` or a
// quote. Nothing in the jail stops a file NAME from carrying one. So the win32
// branch refuses a name with interpreter metacharacters instead of relying on a
// property it does not have (`WIN32_UNSAFE`).
//
// Never throws, and never lets the PROCESS die either — see the `error` listener
// on the spawned child, which is not the same thing as the try/catch around it.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Strings } from "../render/i18n";

/**
 * Why the JAIL refused a `rel`, as a CODE — the sentence lives in `render/i18n`.
 *
 * These reach the SCREEN: `/open` returns them as JSON and the page's script puts the
 * text in the link's `title`. So a Korean sentence built here is the same defect as one
 * built in `assemble` (see the `Warning` doc in model/types.ts).
 *
 * Shared by every reader of a record file, because the reasons a path is out of bounds
 * do not depend on what the caller meant to do with it.
 */
export type JailRefusal =
  | { code: "bad-rel" }
  | { code: "bad-chars" }
  | { code: "outside-record" }
  | { code: "extension"; allowed: string[] }
  | { code: "symlink-escape" }
  | { code: "not-found" }
  | { code: "stat-failed" }
  | { code: "not-a-file" };

/** The jail's refusals plus the four only an OPENER can hit. */
export type OpenRefusal =
  | JailRefusal
  | { code: "platform-unsupported"; platform: string }
  | { code: "interpreter-metachars" }
  | { code: "opener-missing"; cmd: string }
  | { code: "spawn-failed"; detail: string };

/** A jailed, realpath'd, stat'd absolute path — or why not. Never 500: every failure
 *  here is the caller's path being wrong, not this machine being broken. */
export type JailResult =
  | { ok: true; real: string }
  | { ok: false; refusal: JailRefusal; status: 400 | 403 | 404 };

export type OpenResult =
  | { ok: true; abs: string }
  | { ok: false; refusal: OpenRefusal; status: 400 | 403 | 404 | 500 };

/** Extensions we are willing to hand to the OS — the artifact kinds a record
 *  actually holds: markdown, the html the visual-mockups plugin writes at the
 *  mockup stages, and the json the engine writes for `traceability`, which 8
 *  stages contract as a deliverable. Keeping the set closed means the engine's
 *  bookkeeping files (`.last`, `.drops`) and any stray binary can never be
 *  launched. Must stay in sync with LISTED_EXT in scan/artifacts.ts: a file the
 *  page lists but this refuses would be a dead link.
 *
 *  ⚠️ html opens in the default BROWSER, which is the point for a mockup — but
 *  it also means the opened file can run its own scripts. That is acceptable
 *  only because the path is jailed to the record the user chose to view. json is
 *  inert by comparison — it opens in the user's text editor. */
const ALLOWED_EXT = new Set([".md", ".html", ".json"]);

/** Characters `cmd.exe` re-interprets after Node has handed it the argument array.
 *  Only consulted on win32, where the opener IS an interpreter; on darwin and linux
 *  the array is passed to execve untouched and a `&` in a filename is just a `&`. */
const WIN32_UNSAFE = /[&|<>^"%!\r\n]/;

/** Per-platform "open with the default application" command. `shell` marks the
 *  branch whose command re-parses its arguments — see WIN32_UNSAFE. */
function opener(): { cmd: string; pre: string[]; shell: boolean } | undefined {
  if (process.platform === "darwin") return { cmd: "open", pre: [], shell: false };
  if (process.platform === "win32") return { cmd: "cmd", pre: ["/c", "start", ""], shell: true };
  if (process.platform === "linux") return { cmd: "xdg-open", pre: [], shell: false };
  return undefined;
}

/**
 * True when `cmd` resolves to an executable on PATH.
 *
 * Probed BEFORE spawning because `spawn` reports a missing binary on the async
 * `error` event, long after this function has returned `{ok:true}` — so without the
 * probe a Linux box with no `xdg-open` gets a silent success and no editor. A few
 * stat calls on a click is a fair price for an honest answer. PATH unset (some
 * containers) → probe skipped rather than a false refusal.
 */
function onPath(cmd: string): boolean {
  const raw = process.env.PATH;
  if (!raw) return true;
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, cmd + ext), fs.constants.X_OK);
        return true;
      } catch {
        // next candidate
      }
    }
  }
  return false;
}

/**
 * The jail: resolve a client-supplied `rel` under `recordDir` and prove it names a
 * regular file of an allowed kind inside that record. `recordDir` must be absolute.
 *
 * Every reader of a record file goes through this — `/open` and `/view` alike — so a
 * path check added here is added for all of them. Never throws.
 */
export function resolveArtifact(recordDir: string, rel: string): JailResult {
  if (!rel || rel.length > 512) return { ok: false, refusal: { code: "bad-rel" }, status: 400 };
  // NUL byte would truncate the path at the syscall boundary.
  if (rel.includes("\0")) return { ok: false, refusal: { code: "bad-chars" }, status: 400 };

  const base = path.resolve(recordDir);
  const abs = path.resolve(base, rel);
  // Compare with a trailing separator so `/record-evil` cannot pass as `/record`.
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return { ok: false, refusal: { code: "outside-record" }, status: 403 };
  }
  if (!ALLOWED_EXT.has(path.extname(abs).toLowerCase())) {
    return { ok: false, refusal: { code: "extension", allowed: [...ALLOWED_EXT] }, status: 403 };
  }

  // realpath AFTER the prefix check: resolves symlinks, so a link inside the
  // record that points outside it is caught here rather than followed.
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { ok: false, refusal: { code: "not-found" }, status: 404 };
  }
  const realBase = (() => {
    try {
      return fs.realpathSync(base);
    } catch {
      return base;
    }
  })();
  if (real !== realBase && !real.startsWith(realBase + path.sep)) {
    return { ok: false, refusal: { code: "symlink-escape" }, status: 403 };
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    return { ok: false, refusal: { code: "stat-failed" }, status: 404 };
  }
  if (!st.isFile()) return { ok: false, refusal: { code: "not-a-file" }, status: 403 };

  return { ok: true, real };
}

/**
 * Validate `rel` against `recordDir` and, if it holds up, ask the OS to open it.
 * `recordDir` must be absolute (assemble derives it from the state file path).
 */
export function openArtifact(recordDir: string, rel: string, s: Strings): OpenResult {
  const jailed = resolveArtifact(recordDir, rel);
  if (!jailed.ok) return jailed;
  const real = jailed.real;

  const o = opener();
  if (!o) {
    return {
      ok: false,
      refusal: { code: "platform-unsupported", platform: process.platform },
      status: 500,
    };
  }
  // Fails closed on the one platform whose opener re-parses its arguments. A real
  // artifact name is a slug, so this refuses nothing the engine writes.
  if (o.shell && WIN32_UNSAFE.test(real)) {
    return { ok: false, refusal: { code: "interpreter-metachars" }, status: 403 };
  }
  if (!onPath(o.cmd)) {
    return { ok: false, refusal: { code: "opener-missing", cmd: o.cmd }, status: 500 };
  }
  try {
    // Argument array (never a shell string) + detached so the editor outlives
    // this request, and stdio ignored so a chatty opener cannot block us.
    const child = spawn(o.cmd, [...o.pre, real], { detached: true, stdio: "ignore" });
    // THIS LISTENER KEEPS THE SERVER ALIVE, and the try/catch above cannot do it.
    // `spawn` reports a failure to launch on the async `error` event, not by
    // throwing, and an unhandled `error` on a ChildProcess is an uncaughtException —
    // which kills the process. `Bun.serve`'s own `error()` hook does not see that.
    // Measured before the fix: a missing opener answered `{ok:true}` and then took
    // the whole dashboard down with exit 9. The response is already decided by the
    // time this fires, so logging is all that is left to do.
    child.on("error", (err) => {
      console.warn(`[aidlc-dashboard] ${s.openFile.spawnFailedLog(o.cmd, err.message)}`);
    });
    child.unref();
  } catch (err) {
    return {
      ok: false,
      refusal: {
        code: "spawn-failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      status: 500,
    };
  }
  return { ok: true, abs: real };
}
