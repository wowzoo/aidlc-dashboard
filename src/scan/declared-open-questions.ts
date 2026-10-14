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
 * How one declared artifact read. `missing` is the artifact present with no such
 * section; an artifact that does not exist is not listed at all — the stage has not
 * written it, which is not a gap in this reader.
 */
export type DeclaredStatus = "read" | "none" | "unread" | "missing";

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
/** A bold id at the head of an entry — `**OQ1**:` → `OQ1:`, as scan/deferrals.ts keeps it. */
const BOLD_ID_RE = /^\*\*([A-Z][A-Z0-9.-]*\d[A-Z0-9.-]*[a-z]?)\*\*/;

function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cellsOf(line: string): string[] {
  const m = TABLE_ROW_RE.exec(line);
  return m ? (m[1] ?? "").split("|").map((c) => tidy(c)) : [];
}

/** Column positions, by header name first and by the template's order second. */
function columns(header: string[]): { question: number; contract?: number; blocks?: number } {
  const find = (re: RegExp) => {
    const i = header.findIndex((h) => re.test(h));
    return i < 0 ? undefined : i;
  };
  const contract = find(/^(?:contract|계약)/i);
  const blocks = find(/^(?:blocks?|blocking|막는|차단)/i);
  const named = find(/^(?:question|질문|item|항목)/i);
  if (named !== undefined) return { question: named, contract, blocks };
  // No column named for the question: the template's middle column when it has the
  // three, else the first cell — the one place a decision's text can be.
  if (header.length >= 3) {
    return { question: 1, contract: contract ?? 0, blocks: blocks ?? header.length - 1 };
  }
  return { question: 0, contract, blocks };
}

/**
 * Parse every declared Open-questions section in one artifact's text. Exported for
 * tests. Visible lines only (scan/visible-lines.ts), so a fenced example is not the
 * ledger. A heading section ends at the next heading of its level or higher; a
 * bold-lead one at the next heading or bold-lead line.
 */
export function parseDeclaredOpenQuestions(text: string): ParsedDeclared {
  const out: ParsedDeclared = { items: [], sections: 0, none: 0, unread: 0 };
  const lines = visibleLines(text).lines;
  const seen = new Set<string>();
  const push = (e: DeclaredEntry) => {
    const key = `${e.contract ?? ""}\u0001${e.text}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    out.items.push(e);
    return true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
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

    let found = 0;
    let bodyLines = 0;
    let noneLines = 0;
    let header: string[] | undefined;
    let cols: ReturnType<typeof columns> | undefined;
    let bullet: string | undefined;
    const flush = () => {
      const b = bullet;
      bullet = undefined;
      if (b === undefined) return;
      const t = tidy(b.replace(BOLD_ID_RE, "$1"));
      if (t.length === 0 || NONE_RE.test(t)) return;
      if (push({ text: t })) found++;
    };

    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (ends(l)) break;
      if (l.trim().length > 0 && !ANY_HEADING_RE.test(l)) {
        bodyLines++;
        if (NONE_RE.test(tidy(l.replace(LIST_MARKER_RE, "")))) noneLines++;
      }
      if (l.trim().startsWith("|")) {
        flush();
        if (TABLE_SEP_RE.test(l)) {
          if (header) cols = columns(header);
          continue;
        }
        const cells = cellsOf(l);
        if (!cols) {
          // Rows before the separator are the header; only the last one names columns.
          header = cells;
          continue;
        }
        const q = tidy(cells[cols.question] ?? "");
        if (q.length === 0 || NONE_RE.test(q)) continue;
        const e: DeclaredEntry = { text: q };
        const c = cols.contract === undefined ? "" : tidy(cells[cols.contract] ?? "");
        const b = cols.blocks === undefined ? "" : tidy(cells[cols.blocks] ?? "");
        if (c.length > 0) e.contract = c;
        if (b.length > 0) e.blocks = b;
        if (push(e)) found++;
        continue;
      }
      // A table ends at the first non-row line; the next one needs its own header.
      header = undefined;
      cols = undefined;
      const m = LIST_ITEM_RE.exec(l);
      if (m) {
        // A nested bullet is detail of the entry above it, not an entry of its own.
        if ((m[1] ?? "").length === 0) {
          flush();
          bullet = m[2] ?? "";
        }
        continue;
      }
      if (bullet !== undefined && /^\s+\S/.test(l)) {
        bullet = `${bullet} ${l.trim()}`;
        continue;
      }
      flush();
    }
    flush();
    if (found === 0) {
      if (bodyLines > 0 && noneLines === bodyLines) out.none++;
      else out.unread++;
    }
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
 * Read both declared ledgers of a record. An artifact that does not exist is left out
 * of `ledgers`; one that cannot be read is too, rather than reported as empty.
 */
export function readDeclaredOpenQuestions(recordDir: string): DeclaredOpenQuestions {
  const questions: DeclaredQuestion[] = [];
  const ledgers: DeclaredLedger[] = [];
  for (const d of DECLARED_LEDGERS) {
    const abs = path.join(recordDir, ...d.rel.split("/"));
    let text: string;
    try {
      if (!fs.statSync(abs).isFile()) continue;
      text = fs.readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
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
