// Reading a record file without letting a failure pass for absence.
//
// The record readers (questions, deferrals, diaries) used to wrap every read in a bare
// `catch { skip }`. Absence is a legal state for all of them — a stage need not have a
// questions file or a diary — so a file that EXISTS but could not be read (no
// permission, a directory where a file was listed, a dangling link) left the page with
// no trace, and the panel built on what was left could then say "none". Measured on a
// copy of the reference fixture whose other ledgers were empty: an A&OQ artifact with
// no read permission dropped 5 items and 1 assumption with no warning, and the
// deferrals panel printed its "no open items" pill; a questions file the same way took
// its blocker from 1 to 0.
//
// So only ENOENT on a path where nothing exists is absence. ENOENT through a link that
// is there is a dangling link — something was put at that path and cannot be read —
// and every other error is a failure. Callers collect what fails and `assemble` names
// it (`record-file-unreadable`).
//
// The engine's stop hook skips the same failures (`aidlc-continue-workflow.ts`, a
// failed read is "not pending"), and the readers that transcribe a hook decision keep
// doing so: what the hook does is the fact they report. These readers report the
// RECORD, and an unread record file is "not known", not "empty".
//
// Node fs only, never throws.

import * as fs from "node:fs";

export type TextRead = { kind: "text"; text: string } | { kind: "absent" } | { kind: "unreadable" };

export type DirList =
  | { kind: "listed"; entries: fs.Dirent[] }
  | { kind: "absent" }
  | { kind: "unreadable" };

function code(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

/** True when nothing at all sits at `p` — not even a link. */
function nothingAt(p: string): boolean {
  try {
    fs.lstatSync(p);
    return false;
  } catch (e) {
    return code(e) === "ENOENT";
  }
}

/** Read `abs` as UTF-8. `absent` only when nothing is at the path. */
export function readRecordText(abs: string): TextRead {
  try {
    return { kind: "text", text: fs.readFileSync(abs, "utf-8") };
  } catch (e) {
    return code(e) === "ENOENT" && nothingAt(abs) ? { kind: "absent" } : { kind: "unreadable" };
  }
}

/** List `abs`, sorted by name. `absent` only when nothing is at the path. */
export function listRecordDir(abs: string): DirList {
  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: "listed", entries };
  } catch (e) {
    return code(e) === "ENOENT" && nothingAt(abs) ? { kind: "absent" } : { kind: "unreadable" };
  }
}
