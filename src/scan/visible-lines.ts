// The lines of a markdown artifact a reader can SEE — the same question the
// engine asks before it reads a heading or an `[Answer]:` tag.
//
// WHY. Since 2.10 the engine reads its own control lines through
// `visibleMarkdownLines` (aidlc-lib.ts): a heading or a tag inside a fenced code
// block or an HTML comment is example text, not structure. A questions file that
// shows the human what an answer looks like (```` ```md\n[Answer]: A\n``` ````)
// otherwise reads as an ask, and a fenced `## Q2` closes the real question's span
// and hides its blank tag. The diary and the deferral ledger have the same
// problem with their headings and bullets, so all three read through this.
//
// WHAT IT COVERS — a small subset, on purpose. The engine's version stands on
// Bun.markdown's block model (~900 lines with probes and repairs). This one
// handles the three constructs that can actually hold a control line at the
// start of a line, which is the only place the readers here look:
//
//   - fenced code: ``` or ~~~, 0–3 spaces of indent, closed by the same character
//     at least as long, with nothing after it
//   - HTML comments: `<!-- … -->`, on one line or across several
//   - raw-text HTML blocks: a line starting `<pre`, `<script`, `<style` or
//     `<textarea`, through the line that closes it
//
// Indented code needs nothing: every reader matches its control lines at column
// 0–3, which indented code cannot reach. Fences inside list items or block
// quotes are not recognised, and neither are setext headings; both are rare in
// what the engine writes.
//
// AN UNCLOSED BLOCK HIDES NOTHING. CommonMark runs an unclosed fence to the end of
// the file; reading it that way would let a typo hide every blank tag below it,
// i.e. a blocker that disappears from the one panel meant to show it. So an
// opener with no closer is read as ordinary text, and the caller is told
// (`unclosed`) so it can say so on screen instead of quietly picking a side.
//
// Line count is preserved — an invisible line becomes "" — so a line index here is
// a line index in the source.

/** The source split into lines, with every invisible stretch blanked. */
export interface VisibleText {
  lines: string[];
  /** A fence, comment or raw-text block opened and never closed (read as text). */
  unclosed: boolean;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RAW_OPEN_RE = /^ {0,3}<(pre|script|style|textarea)(?:[\s>]|$)/i;

function fenceCloses(line: string, fence: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1]?.[0] === fence[0] && (m[1]?.length ?? 0) >= fence.length;
}

/** Index of the line closing the block opened at `start`, or -1. */
function blockEnd(lines: string[], start: number, closes: (line: string) => boolean): number {
  for (let i = start + 1; i < lines.length; i++) if (closes(lines[i] ?? "")) return i;
  return -1;
}

/**
 * Blank out the invisible stretches of `text`. Never throws; an unclosed block is
 * read as text and flagged rather than hiding the rest of the file.
 */
export function visibleLines(text: string): VisibleText {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out: string[] = [];
  let unclosed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const fence = FENCE_OPEN_RE.exec(line);
    // A backtick fence's info string may not contain a backtick (CommonMark).
    if (fence && !(fence[1]?.[0] === "`" && fence[2]?.includes("`"))) {
      const marker = fence[1] ?? "";
      const end = blockEnd(lines, i, (l) => fenceCloses(l, marker));
      if (end < 0) {
        unclosed = true;
        out.push(line);
        continue;
      }
      for (; i <= end; i++) out.push("");
      i = end;
      continue;
    }

    const raw = RAW_OPEN_RE.exec(line);
    if (raw) {
      const close = new RegExp(`</${raw[1]}>`, "i");
      const end = close.test(line) ? i : blockEnd(lines, i, (l) => close.test(l));
      if (end < 0) {
        unclosed = true;
        out.push(line);
        continue;
      }
      for (; i <= end; i++) out.push("");
      i = end;
      continue;
    }

    if (!line.includes("<!--")) {
      out.push(line);
      continue;
    }
    // Strip every comment opening on this line, following one across lines: the
    // text before it and after its close stay, the lines wholly inside go blank.
    let j = i;
    let cur = line;
    let pos = 0;
    let visible = "";
    for (;;) {
      const open = cur.indexOf("<!--", pos);
      if (open < 0) {
        visible += cur.slice(pos);
        break;
      }
      visible += cur.slice(pos, open);
      let close = cur.indexOf("-->", open + 4);
      let k = j;
      while (close < 0 && k + 1 < lines.length) {
        k++;
        close = (lines[k] ?? "").indexOf("-->");
      }
      if (close < 0) {
        // Never closed: read the remainder as text (see the header).
        unclosed = true;
        visible += cur.slice(open);
        break;
      }
      if (k > j) {
        out.push(visible);
        for (let n = j + 1; n < k; n++) out.push("");
        visible = "";
        j = k;
        cur = lines[k] ?? "";
      }
      pos = close + 3;
    }
    out.push(visible);
    i = j;
  }
  return { lines: out, unclosed };
}
