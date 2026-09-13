// Read one record artifact as SOURCE TEXT, for the in-dashboard viewer.
//
// WHY THIS EXISTS BESIDE `/open`. Naming a file and stopping was the whole of the
// blockers and deferrals panels: the reader learned that a blank `[Answer]:` sits in
// `construction/PU-1/functional-design/…-questions.md` and then had to leave the
// dashboard to see it. `/open` is that exit, and it is a narrow one — it needs an
// opener on PATH, it refuses a name carrying `cmd.exe` metacharacters on win32, and
// it hands the file to whatever application the OS picked. None of that is needed to
// put the text on screen, so this module does the reading and `render/view-page.ts`
// says it.
//
// THE PATH CHECKS ARE NOT REIMPLEMENTED HERE. `resolveArtifact` (scan/open-file.ts)
// is the jail, shared with `/open`, so the two readers cannot drift: a traversal or
// symlink-escape fix lands in one place. This module only adds "and then read it".
//
// THE READ IS CAPPED, AND SAYS SO. `MAX_VIEW_BYTES` bounds RSS BY CONSTRUCTION — a
// single fixed buffer, never `readFileSync`, which costs memory proportional to file
// size (the measurement behind that is in transcript-reader.ts's header: a 105MB file
// cost +101MB whole vs +71MB chunked). A capped read reports `truncated`, which the
// page states explicitly; a cap that reads as completeness is the failure this repo
// records against the transcript byte cap too.
//
// Never throws — an unreadable file comes back as a refusal code, like every other
// scan module (the no-throw rule in CLAUDE.md).

import * as fs from "node:fs";
import { type JailRefusal, resolveArtifact } from "./open-file";

/**
 * Byte ceiling for one artifact view.
 *
 * 512KB against a measured corpus whose *entire* deferral read is 115 files / 2.16MB
 * (~19KB per artifact, CLAUDE.md's 미뤄둔 결정 note), so this is roughly 25× the
 * largest thing the engine writes and still a fixed, small buffer. It exists for the
 * pathological file, not the normal one.
 */
export const MAX_VIEW_BYTES = 512 * 1024;

/** The jail's refusals plus the one only a READ can hit. */
export type ViewRefusal = JailRefusal | { code: "read-failed"; detail: string };

export interface ArtifactSource {
  /** Record-relative POSIX path — what the page displays. The absolute path is
   *  deliberately NOT carried: it is the jail's business, not the reader's. */
  rel: string;
  /** File text. Ends at a line boundary when `truncated`. */
  text: string;
  /** True when the file is larger than `MAX_VIEW_BYTES` and the text is a prefix. */
  truncated: boolean;
  /** Size on disk in bytes, as measured — the denominator for "you are seeing part". */
  sizeBytes: number;
  /** Bytes actually turned into `text`. */
  shownBytes: number;
}

export type ViewResult =
  | { ok: true; source: ArtifactSource }
  | { ok: false; refusal: ViewRefusal; status: 400 | 403 | 404 | 500 };

/**
 * Read `rel` under `recordDir` as text, bounded by `MAX_VIEW_BYTES`.
 *
 * A truncated read is cut back to the last newline, so the last visible line is a
 * whole line rather than a byte-sliced one — slicing mid-character would otherwise
 * end the page on a U+FFFD replacement glyph that reads as corruption in the file
 * rather than as our cap.
 */
export function readArtifactSource(recordDir: string, rel: string): ViewResult {
  const jailed = resolveArtifact(recordDir, rel);
  if (!jailed.ok) return jailed;

  let fd: number | undefined;
  try {
    const sizeBytes = fs.statSync(jailed.real).size;
    fd = fs.openSync(jailed.real, "r");
    const buf = Buffer.allocUnsafe(MAX_VIEW_BYTES);
    const read = fs.readSync(fd, buf, 0, MAX_VIEW_BYTES, 0);
    const truncated = sizeBytes > read;

    let text = buf.subarray(0, read).toString("utf-8");
    if (truncated) {
      const lastBreak = text.lastIndexOf("\n");
      if (lastBreak > 0) text = text.slice(0, lastBreak);
    }
    return { ok: true, source: { rel, text, truncated, sizeBytes, shownBytes: read } };
  } catch (err) {
    return {
      ok: false,
      refusal: { code: "read-failed", detail: err instanceof Error ? err.message : String(err) },
      status: 500,
    };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The read already answered; a failed close has nothing left to report.
      }
    }
  }
}
