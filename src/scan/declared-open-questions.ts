// The two open-question ledgers a STAGE declares in its own primary artifact —
// outside the `## Assumptions & Open Questions` section scan/deferrals.ts reads.
//
// THE CONTRACT, from the 2.11.0 stage files:
//
//   requirements-analysis  Step 10 — `requirements.md` contains, among its sections,
//                          "**Open questions** — Any remaining uncertainties for later
//                          stages"            (aidlc-common/stages/inception/requirements-analysis.md)
//   contract-design        Step 4 — `contract-summary.md` carries "**Open questions** —
//                          a table of unresolved contract points and which unit each
//                          blocks: `| Contract | Question | Blocks |`"
//                                            (aidlc-common/stages/inception/contract-design.md)
//
// Both are named by path in the stage file, so they are read at exactly those two
// paths: a stray `## Open Questions` in some other artifact is not a declared ledger,
// and `memory.md`'s own `## Open questions` is the diary axis (scan/memory-diary.ts).
// On run E these two ledgers held 5 items the panel never showed.
//
// The template names the section, not its markup. Writers have rendered it as a
// `## Open Questions` heading (bullets with `**OQ1**:` ids in requirements, the table in
// contract-design); a bold-lead paragraph `**Open questions**` is accepted too, because
// that is how the stage file itself spells the name.
//
// NO OWNER IS CLAIMED. Neither ledger has an assignment cell: requirements' bullets
// are prose ("… 설계 단계에서 확정한다"), and `Blocks` names what the point blocks —
// "which unit each blocks" — not a stage contracted to answer it. Reading a stage out of
// either would be the prose-mining scan/deferrals.ts rule 3 forbids, so these are kept
// as their own ledger and never summed with the owner-bearing items.
//
// Node fs only, never throws.

import * as fs from "node:fs";
import * as path from "node:path";
import { entryKind, readRecordText } from "./record-read";
import { visibleLines } from "./visible-lines";

/** Which declared ledger an item came from. */
export type DeclaredSource = "requirements" | "contract";

/** Where each declared ledger lives, relative to the record (the stage files' paths). */
export const DECLARED_LEDGERS: { source: DeclaredSource; stage: string; rel: string }[] = [
  {
    source: "requirements",
    stage: "requirements-analysis",
    rel: "inception/requirements-analysis/requirements.md",
  },
  {
    source: "contract",
    stage: "contract-design",
    rel: "inception/contract-design/contract-summary.md",
  },
];

/** One parsed entry, before it is placed in the record. */
export interface DeclaredEntry {
  text: string;
  /** The `Contract` cell, when the ledger is a table that has one. */
  contract?: string;
  /** The `Blocks` cell, verbatim — what this point blocks, never an owner. */
  blocks?: string;
}

export interface DeclaredQuestion extends DeclaredEntry {
  source: DeclaredSource;
  stage: string;
  /** Record-relative POSIX path of the artifact, for the source link. */
  rel: string;
  /** The artifact's mtime. */
  since: string;
}

/**
 * How one declared artifact read. `missing` is the artifact present with no section this
 * reader recognises (the template names the section, not its markup); `unreadable` is a
 * path present but not readable as a file. An artifact that does not exist is not listed
 * at all — the stage has not written it, which is not a gap in this reader.
 */
export type DeclaredStatus = "read" | "none" | "unread" | "missing" | "unreadable";

export interface DeclaredLedger {
  source: DeclaredSource;
  rel: string;
  status: DeclaredStatus;
  /** Entries read from it, after de-duplication. */
  count: number;
}

export interface DeclaredOpenQuestions {
  questions: DeclaredQuestion[];
  ledgers: DeclaredLedger[];
}

export interface ParsedDeclared {
  items: DeclaredEntry[];
  /** Sections found. */
  sections: number;
  /** Sections whose body was only an explicit `None.`. */
  none: number;
  /** Sections that yielded nothing and declared nothing. */
  unread: number;
}

/** `## Open questions` at any level (a leading section number allowed), and nothing more. */
const HEADING_RE = /^(#{1,6})\s+(?:\d+(?:\.\d+)*\.?\s+)?open\s+questions?\s*:?\s*#*\s*$/i;
/** `**Open questions**` alone on a line — the stage file's own spelling of the name. */
const BOLD_LEAD_RE = /^\*\*\s*open\s+questions?\s*:?\s*\*\*\s*:?\s*$/i;
/** Any other bold-lead line ends a bold-lead section. */
const ANY_BOLD_LEAD_RE = /^\*\*[^*]+\*\*\s*:?\s*$/;
const ANY_HEADING_RE = /^(#{1,6})\s/;
const TABLE_SEP_RE = /^\s*\|[\s:|-]*-{2,}[\s:|-]*\|?\s*$/;
const TABLE_ROW_RE = /^\s*\|(.*?)\|?\s*$/;
const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const NONE_RE = /^(?:none|n\/a|not applicable|없음|해당\s*없음)[.!。]?$/i;
/**
 * `Open questions: None.` on one line — the section's name and the empty declaration
 * together. A 2.11.1 requirements.md wrote its ledger as exactly this bullet, inside
 * `## Assumptions & Open Questions`, and with no heading to find the ledger read as
 * missing. Only `None.` is taken from a labelled line: a label followed by prose is not
 * a shape this reader knows, so it is not invented into an entry.
 */
const LABELLED_RE =
  /^(?:\*\*)?\s*open\s+questions?\s*(?:\*\*)?\s*[:：—–]\s*(?:\*\*)?\s*(.*?)\s*(?:\*\*)?$/i;

/** `None.`, bare or after the section's own name. */
function isNone(text: string): boolean {
  const labelled = LABELLED_RE.exec(text);
  return NONE_RE.test(labelled ? (labelled[1] ?? "") : text);
}
/** A bold id at the head of an entry — `**OQ1**:` → `OQ1:`, as scan/deferrals.ts keeps it. */
const BOLD_ID_RE = /^\*\*([A-Z][A-Z0-9.-]*\d[A-Z0-9.-]*[a-z]?)\*\*/;

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cellsOf(line: string): string[] {
  const m = TABLE_ROW_RE.exec(line);
  return m ? (m[1] ?? "").split("|").map((c) => tidy(c)) : [];
}

/**
 * Column positions by header name. A table with no column named for the question is not
 * this ledger's shape — guessing a column read `Contract | Status | Blocks` as questions.
 */
function columns(
  header: string[],
): { question: number; contract?: number; blocks?: number } | undefined {
  const find = (re: RegExp) => {
    const i = header.findIndex((h) => re.test(h));
    return i < 0 ? undefined : i;
  };
  const question = find(/^(?:questions?|질문|items?|항목)$/i);
  if (question === undefined) return undefined;
  return {
    question,
    contract: find(/^(?:contracts?|계약)$/i),
    blocks: find(/^(?:blocks?|blocking|막는 대상|차단)$/i),
  };
}

/** The A&OQ heading scan/deferrals.ts reads — its `### Open questions` is that reader's. */
const AOQ_RE = /^(#{1,6})\s+Assumptions\s*&\s*Open\s*Questions\s*$/i;

/**
 * Parse every declared Open-questions section in one artifact's text. Exported for
 * tests. Visible lines only (scan/visible-lines.ts), so a fenced example is not the
 * ledger, and an Open questions heading nested in `## Assumptions & Open Questions` is
 * left to scan/deferrals.ts. A heading section ends at the next heading of its level or
 * higher; a bold-lead one at the next heading or bold-lead line.
 *
 * A section is judged on every block in it, not on whether anything was read: a table
 * with no Question column, a row with no question, or prose beside nothing read is a
 * gap (`unread`), and a read bullet does not vouch for an unreadable table beside it.
 * `None.` — a line, a bullet, a Question cell — or a header with no rows is the empty
 * declaration.
 */
export function parseDeclaredOpenQuestions(text: string): ParsedDeclared {
  const out: ParsedDeclared = { items: [], sections: 0, none: 0, unread: 0 };
  const lines = visibleLines(text).lines;
  const seen = new Set<string>();
  const push = (e: DeclaredEntry) => {
    const key = [e.contract ?? "", e.text, e.blocks ?? ""].join("\u0001").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.items.push(e);
  };
  /** Level of the enclosing A&OQ heading, while inside one. */
  let aoqLevel: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const anyHead = ANY_HEADING_RE.exec(line);
    if (anyHead) {
      const lv = (anyHead[1] ?? "").length;
      const aoq = AOQ_RE.exec(line);
      if (aoq) {
        aoqLevel = lv;
        continue;
      }
      if (aoqLevel !== undefined && lv <= aoqLevel) aoqLevel = undefined;
    }
    // A labelled `None.` is the whole section on one line, inside the A&OQ or out of it.
    if (!anyHead && LABELLED_RE.test(tidy(line.replace(LIST_MARKER_RE, "")))) {
      if (isNone(tidy(line.replace(LIST_MARKER_RE, "")))) {
        out.sections++;
        out.none++;
      }
      continue;
    }
    if (aoqLevel !== undefined) continue;
    const head = HEADING_RE.exec(line);
    const bold = !head && BOLD_LEAD_RE.test(line.trim());
    if (!head && !bold) continue;
    out.sections++;
    const level = head ? (head[1] ?? "#").length : 7;
    const ends = (l: string) => {
      const h = ANY_HEADING_RE.exec(l);
      if (h) return (h[1] ?? "").length <= level;
      return bold && ANY_BOLD_LEAD_RE.test(l.trim());
    };

    /** Entries recognised — counted before de-duplication, so a restatement still reads. */
    let found = 0;
    let noneMarks = 0;
    let gaps = 0;
    let prose = 0;
    let bullet: string | undefined;
    // The table in progress: header rows until the separator, then body rows.
    let header: string[] | undefined;
    let cols: ReturnType<typeof columns>;
    let inBody = false;
    let bodyRows = 0;

    const flushBullet = () => {
      const b = bullet;
      bullet = undefined;
      if (b === undefined) return;
      const t = tidy(b.replace(BOLD_ID_RE, "$1"));
      if (t.length === 0) return;
      if (isNone(t)) {
        noneMarks++;
        return;
      }
      found++;
      push({ text: t });
    };
    const closeTable = () => {
      if (header === undefined) return;
      // Pipes with no separator are not a table this reader knows.
      if (!inBody) prose++;
      else if (cols === undefined) gaps++;
      else if (bodyRows === 0) noneMarks++; // the header written, no row under it
      header = undefined;
      cols = undefined;
      inBody = false;
      bodyRows = 0;
    };

    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (ends(l)) break;
      if (l.trim().startsWith("|")) {
        flushBullet();
        if (TABLE_SEP_RE.test(l) && header !== undefined && !inBody) {
          cols = columns(header);
          inBody = true;
          continue;
        }
        const cells = cellsOf(l);
        if (!inBody) {
          // Rows before the separator are the header; the last one names the columns.
          header = cells;
          continue;
        }
        bodyRows++;
        if (cols === undefined) continue;
        // A header row repeated under the separator is not a question.
        if (cells.join("|").toLowerCase() === (header ?? []).join("|").toLowerCase()) continue;
        const q = tidy(cells[cols.question] ?? "");
        if (q.length === 0) {
          gaps++;
          continue;
        }
        if (NONE_RE.test(q)) {
          noneMarks++;
          continue;
        }
        const e: DeclaredEntry = { text: q };
        const c = cols.contract === undefined ? "" : tidy(cells[cols.contract] ?? "");
        const b = cols.blocks === undefined ? "" : tidy(cells[cols.blocks] ?? "");
        if (c.length > 0) e.contract = c;
        if (b.length > 0) e.blocks = b;
        found++;
        push(e);
        continue;
      }
      // A table ends at the first non-row line; the next one needs its own header.
      closeTable();
      // A blank line or a deeper heading closes the entry above it; neither is content.
      if (l.trim().length === 0 || ANY_HEADING_RE.test(l)) {
        flushBullet();
        continue;
      }
      const m = LIST_ITEM_RE.exec(l);
      if (m) {
        // A nested bullet is detail of the entry above it, not an entry of its own.
        if ((m[1] ?? "").length === 0) {
          flushBullet();
          bullet = m[2] ?? "";
        }
        continue;
      }
      if (bullet !== undefined && /^\s+\S/.test(l)) {
        bullet = `${bullet} ${l.trim()}`;
        continue;
      }
      flushBullet();
      if (isNone(tidy(l.replace(LIST_MARKER_RE, "")))) noneMarks++;
      else prose++;
    }
    flushBullet();
    closeTable();
    const outcome =
      gaps > 0 ? "unread" : found > 0 ? "read" : noneMarks > 0 && prose === 0 ? "none" : "unread";
    if (outcome === "none") out.none++;
    else if (outcome === "unread") out.unread++;
    i = j - 1;
  }
  return out;
}

function mtime(p: string): string {
  try {
    return fs
      .statSync(p)
      .mtime.toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  } catch {
    return "";
  }
}

/**
 * Read both declared ledgers of a record. Only a path that does not exist is left out;
 * anything else that stops the read is a named gap, never an empty ledger.
 */
export function readDeclaredOpenQuestions(recordDir: string): DeclaredOpenQuestions {
  const questions: DeclaredQuestion[] = [];
  const ledgers: DeclaredLedger[] = [];
  for (const d of DECLARED_LEDGERS) {
    const abs = path.join(recordDir, ...d.rel.split("/"));
    // Nothing at the path is the one legal absence; a dangling link is not (see
    // scan/record-read.ts), and neither is a dir or anything that will not read.
    const kind = entryKind(abs);
    if (kind === "absent") continue;
    const read = kind === "other" ? readRecordText(abs) : undefined;
    if (read?.kind !== "text") {
      ledgers.push({ source: d.source, rel: d.rel, status: "unreadable", count: 0 });
      continue;
    }
    const text = read.text;
    const parsed = parseDeclaredOpenQuestions(text);
    const since = mtime(abs);
    for (const e of parsed.items) {
      questions.push({ ...e, source: d.source, stage: d.stage, rel: d.rel, since });
    }
    const status: DeclaredStatus =
      parsed.sections === 0
        ? "missing"
        : parsed.unread > 0
          ? "unread"
          : parsed.items.length > 0
            ? "read"
            : "none";
    ledgers.push({ source: d.source, rel: d.rel, status, count: parsed.items.length });
  }
  return { questions, ledgers };
}
