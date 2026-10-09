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
// WHAT IT COVERS — an approximation, on purpose, and it differs from the engine's
// in BOTH directions. The engine's version stands on Bun.markdown's block model
// (~900 lines with probes and repairs). This one handles the three constructs that
// most often hold a control line in what the engine and its humans write:
//
//   - fenced code: ``` or ~~~, 0–3 spaces of indent, closed by the same character
//     at least as long, with nothing after it
//   - HTML comments: `<!-- … -->`, on one line or across several
//   - raw-text HTML blocks: a line starting `<pre`, `<script`, `<style` or
//     `<textarea`, through the line that closes it
//
// A comment opener inside inline code (`` `<!--` ``) or escaped (`\<!--`) opens
// nothing, and text after a multi-line comment closes is kept off column 0, so it
// is neither a heading nor a tag.
//
// Known differences, each rare in these files: other HTML blocks (`<div>`, a line
// holding only a tag — CommonMark type 6/7, which run to the next blank line);
// indented code (the questions reader matches at column 0–3 so it cannot reach
// it, but the deferral reader takes indented bullets, and nested list indentation
// cannot be told from code without a block parser); fences inside list items or
// block quotes; inline code spanning lines; setext headings.
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

/**
 * Where an unclosed search already ran out. A search from line `n` that found no
 * closer covers every later start too, so a file with thousands of unclosed openers
 * costs one pass per kind of closer rather than one pass per opener.
 */
type Exhausted = Map<string, number>;

/** Index of the line closing the block opened at `start`, or -1. */
function blockEnd(
  lines: string[],
  start: number,
  key: string,
  exhausted: Exhausted,
  closes: (line: string) => boolean,
): number {
  if (start >= (exhausted.get(key) ?? Number.POSITIVE_INFINITY)) return -1;
  for (let i = start + 1; i < lines.length; i++) if (closes(lines[i] ?? "")) return i;
  exhausted.set(key, Math.min(start, exhausted.get(key) ?? start));
  return -1;
}

/** The `[start, end)` ranges of this line's inline code spans (a backtick run to its match). */
function codeSpans(line: string): [number, number][] {
  const spans: [number, number][] = [];
  const runs = [...line.matchAll(/`+/g)];
  for (let r = 0; r < runs.length; r++) {
    const open = runs[r];
    if (!open || open.index === undefined) continue;
    const match = runs.findIndex((x, n) => n > r && x[0].length === open[0].length);
    if (match < 0) continue;
    const close = runs[match];
    if (!close || close.index === undefined) continue;
    spans.push([open.index, close.index + close[0].length]);
    r = match;
  }
  return spans;
}

/** The next `<!--` at or after `from` that opens a comment: not escaped, not in inline code. */
function commentOpen(line: string, from: number, spans: [number, number][]): number {
  for (let at = line.indexOf("<!--", from); at >= 0; at = line.indexOf("<!--", at + 1)) {
    if (line[at - 1] === "\\") continue;
    if (spans.some(([s, e]) => at >= s && at < e)) continue;
    return at;
  }
  return -1;
}

/**
 * Text that follows a multi-line comment's close continues the comment's line; it
 * is not at column 0, so neither a heading nor a tag. The word joiner keeps it
 * there without adding anything a reader would see.
 */
const CONTINUATION = "\u2060";

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
  const exhausted: Exhausted = new Map();
  let unclosed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const fence = FENCE_OPEN_RE.exec(line);
    // A backtick fence's info string may not contain a backtick (CommonMark).
    if (fence && !(fence[1]?.[0] === "`" && fence[2]?.includes("`"))) {
      const marker = fence[1] ?? "";
      const end = blockEnd(lines, i, `fence:${marker}`, exhausted, (l) => fenceCloses(l, marker));
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
      const tag = (raw[1] ?? "").toLowerCase();
      const close = new RegExp(`</${tag}>`, "i");
      const end = close.test(line)
        ? i
        : blockEnd(lines, i, `raw:${tag}`, exhausted, (l) => close.test(l));
      if (end < 0) {
        unclosed = true;
        out.push(line);
        continue;
      }
      for (; i <= end; i++) out.push("");
      i = end;
      continue;
    }

    let spans = codeSpans(line);
    if (commentOpen(line, 0, spans) < 0) {
      out.push(line);
      continue;
    }
    // Strip every comment opening on this line, following one across lines: the
    // text before it and after its close stay, the lines wholly inside go blank.
    let j = i;
    let cur = line;
    let pos = 0;
    let visible = "";
    let continued = false;
    for (;;) {
      const open = commentOpen(cur, pos, spans);
      if (open < 0) {
        visible += cur.slice(pos);
        break;
      }
      visible += cur.slice(pos, open);
      let close = cur.indexOf("-->", open + 4);
      let k = j;
      if (close < 0) {
        k = blockEnd(lines, j, "comment", exhausted, (l) => l.includes("-->"));
        close = k < 0 ? -1 : (lines[k] ?? "").indexOf("-->");
      }
      if (close < 0) {
        // Never closed: read the remainder as text (see the header).
        unclosed = true;
        visible += cur.slice(open);
        break;
      }
      if (k > j) {
        out.push(continued && visible ? CONTINUATION + visible : visible);
        for (let n = j + 1; n < k; n++) out.push("");
        visible = "";
        j = k;
        cur = lines[k] ?? "";
        spans = codeSpans(cur);
        continued = true;
      }
      pos = close + 3;
    }
    out.push(continued && visible ? CONTINUATION + visible : visible);
    i = j;
  }
  return { lines: out, unclosed };
}
