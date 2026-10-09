// Find the questions the run is waiting on — the single most useful thing this
// dashboard can show, because an AI-DLC run that looks "stopped" is usually
// sitting on an unanswered question rather than broken.
//
// FORMAT. Every stage that asks something writes `<stage-dir>/<stage>-questions.md`:
//
//   ## Q1 — Plan Approval
//   <prose + the option list>
//   [Answer]: A (Approve Plan) — 사용자 승인 2026-07-30
//
// An UNANSWERED question is an `[Answer]:` marker with nothing but whitespace or
// underscores after the colon. That is the engine's own convention
// (stage-protocol.md: "blank or contains only underscores"; the stop hook's
// pending-question carve-out reads `\[Answer\]:[ \t]*_*[ \t]*$`), and a reader
// that took only whitespace read a `___` placeholder as an answer. It is what distinguishes
// "asked and waiting" from "asked and answered" — verified against a real stall
// where one unit's `[Answer]:` was blank and stop.drops corroborated with three
// "pending-question carve-out" lines.
//
// THE HEADING IS WRITTEN FIVE WAYS. Measured across one long real run (23
// artifacts, 195 `##` headings): `Q1 —` 119, `[Q1]` 58, `[F1]` 13, `F1.` 5. The
// bracket is optional, follow-ups use an `F` id, and either form can carry a
// suffix. Matching only the bare `Q<n>` form found 119 of 194 asks — 39% of that
// run's questions were invisible, including a whole stage's worth. So the id is
// matched with the bracket and suffix optional. The fifth way is the suffix
// WITHOUT a hyphen: run B wrote `Q1-a`/`Q6-b`, a later run wrote `## Q6a. (후속)
// …`, and requiring the hyphen dropped it — a real follow-up with a filled
// `[Answer]:`. The hyphen is optional for that reason.
//
// AND NOT EVERY ASK HAS AN ID AT ALL. Three headings the engine writes carry a
// gating `[Answer]:` with no `Q<n>`, and the engine's own parser treats them as
// question sections — `aidlc-lib.ts` gates on
// `(title === "Requested Changes Feedback" || questionId !== null)`:
//
//   ## Consolidated Summary Confirmation   the per-stage approval receipt, answered
//                                         exactly `Looks correct` / `Request changes`
//   ## Assumption Confirmation             `A. Accept assumptions` /
//                                         `B. Convert to follow-up questions`
//   ## Requested Changes Feedback          the free-text "What should change?"
//
// `stage-protocol.md` is explicit that these block: *"Do not revise anything until
// the human provides that feedback"*, and the assumption one *"Do not invoke the
// reviewer or proceed to completion while an assumption confirmation `[Answer]:`
// is blank."* So a run parked on any of them is hard-stopped — and this reader
// used to show it as ZERO blockers, because the id regex is all that opened a
// span. Measured on one real tree: 103 `##` headings across its questions files,
// 27 invisible, of which **14 were these three** (10 summary + 3 assumption + 1
// feedback). All were filled there, so the hidden-blocker count was 0 — but the
// summary confirmation exists at every stage gate, which makes it the single most
// likely state for a run to be waiting in.
//
// A FOURTH ARRIVED WITH THE ENGINE-HELD PLAN APPROVAL. Code Generation's
// `<unit>/code-generation/code-generation-questions.md` is now written by
// `aidlc-plan-approval-ask.ts` as one `## Plan Approval` section — question,
// `A. Approve Plan` / `B. Request Changes` / `C. I'll edit the files`, then
// `[Answer]:` — and the engine counts its tags only under a heading that is
// "exactly `Plan Approval`" (`aidlc-testing-posture.ts`). Plan approval is
// human-owned even under Construction autonomy, so a blank one is a hard stop.
// Measured on run E: all three of its
// code-generation questions files read as zero asks, and blanking one answer on a copy still showed zero
// blockers on both the dashboard and the picker card.
//
// Two things make it unlike the other three. It is matched the way the ENGINE
// matches it (`isPlanApprovalLabel`, `aidlc-testing-posture.ts`): one wrapping
// emphasis pair and a trailing `?`/`:` are ignored, because the legacy recovery
// path has the model write this heading by hand (`code-generation.md`) and the
// engine accepts those spellings — a stricter reader would miss a blank one the
// engine is waiting on. And with plan approval off, the engine writes the same
// section pre-answered `Plan approval off` as a record that "asks nothing"; that
// one is dropped, not counted as an answered ask.
//
// TWO RULES KEEP THAT WIDENING FROM INVENTING QUESTIONS:
//
//   1. A heading is an ask only if its span holds an `[Answer]:` marker. The
//      marker is how the engine asks, so a heading without one is prose — real
//      example, `## [Q5] 후속 — 원문에서 확인한 것`, a narrative section reusing an
//      answered question's id. Without this rule it reads as a blocker.
//   2. The answer is the first NON-EMPTY marker in the span, not the first
//      marker. A human answering under the engine's blank placeholder leaves
//      `[Answer]:` followed by `[Answer]: C. …`; taking the first marker calls
//      that question unanswered. Measured: of 194 spans exactly one holds two
//      markers, and it is that shape — blank-then-filled, never filled-then-blank.
//
// WHAT THE ENGINE SEES DECIDES WHAT IS ASKED (2.11). Six rules, each a shape
// the engine read one way and this reader another:
//
//   - Only VISIBLE lines count (scan/visible-lines.ts): a tag or heading inside a
//     fence, an HTML comment or a <pre> block is example text, as the engine's
//     `visibleMarkdownLines` reads it. That module approximates the engine's and
//     differs both ways on rare shapes (its header lists them); an unclosed block
//     hides nothing and is reported — the alternative is a typo hiding every
//     blocker below it.
//   - A question heading opens a span at ANY depth (`### Q2.`), and a heading
//     DEEPER than the span's own is a subsection that stays inside it; a heading
//     at the same depth or shallower ends it. Closing on any `##` had a `### 선택지`
//     under `## Q1` hide Q1's tag. ATX headings take 0–3 spaces of indent and an
//     optional closing `##`. Numbered forms (`## 1.`, `## Question 1:`) are
//     questions too — the engine's own question prefix (`QUESTION_PREFIX_RE`).
//   - A leading emoji is decoration (2.11 `headingKey`), so `## ❓ Q1.` is Q1 and
//     `## 📌 Assumption Confirmation` is that gate. The summary and feedback
//     headings are compared exactly by the engine and stay exact here.
//   - The three gate headings are H2 only, as the engine reads them.
//   - A blank tag under NO recognised heading is still an ask. The protocol asks
//     for every blank tag to be filled ("If any [Answer]: tag is still blank …"),
//     whatever heading it sits under. It attaches to the heading above it (or to
//     none), as `loose`. A filled one there stays uncounted, as before.
//   - Plan approval and the summary confirmation are read by TRANSCRIPTIONS of the
//     engine's readers, which own their lines: `latestPlanApproval`
//     (aidlc-testing-posture.ts — the latest section's last tag, its own heading
//     grammar and section ends) and `summaryConfirmationAnswer` (aidlc-lib.ts — the
//     first summary H2 through the next H2, exactly one tag). Letting the general
//     question grammar draw their boundaries split a nested `### [Q2]` off a plan
//     and hid the blank tag the engine was waiting on. Compared against the engine
//     functions (2.11.0) on 20,000 random files built from these shapes, with no
//     unclosed block: 0 disagreements; adding a line holding only a closing tag
//     (`</pre>`, CommonMark HTML block type 7, which visible-lines.ts does not
//     model) brings it to 0.6–0.8%. Every other ask keeps rule 2 below.
//
// THIS IS A READING OF THE RECORD, NOT THE ENGINE'S PENDING CHECK. The stop hook
// (aidlc-continue-workflow.ts `hasPendingQuestion`) tests the raw text of the
// ACTIVE stage's own questions files with one regex — no headings, no visibility,
// no column-0 anchor — and what it decides is whether the forwarding loop may let
// the turn end, not what was answered. So a blank placeholder this reader reads as
// answered (rule 2, a continuation section) can still hold that hook. Which files
// are active, and that second fact, belong with the pending-interaction reading in
// model/status.ts, not here.
//
// WHERE WE LOOK. Recursively below each known phase dir (bounded in depth, dot-dirs
// and symlinked dirs skipped). That is a dashboard choice: the protocol's
// "Recursively read every `<record>/**/*-questions.md`" is about reusing earlier
// answers, while the stop hook reads only a stage dir's direct children — a file
// further down is a record to show, not proof the run is held by it. Which stage a file
// belongs to comes from the catalogue's `isStage` oracle when there is one — a
// stage's own subdirectory (`<stage>/reviews/`) was read as a unit named after
// the stage. Without one, only `construction/` has units, and there a dir
// holding further dirs is one, as before.
//
// Node fs only, never throws.

import * as fs from "node:fs";
import * as path from "node:path";
import { visibleLines } from "./visible-lines";

/**
 * What kind of ask a heading is. `confirmation` is one of the four id-less gate
 * headings; the remedy differs (pick a fixed option / write feedback rather than
 * answer a question), so the panel says which one it is looking at. `loose` is a
 * blank tag under no heading this reader recognises — the engine waits on it all
 * the same, but the reader cannot say what it asks.
 */
export type AskKind = "question" | "confirmation" | "loose";

/** One question block found in a questions artifact. */
export interface QuestionEntry {
  /** Heading label, e.g. "Q1 — Plan Approval". Empty for a `loose` tag above every heading. */
  heading: string;
  /** The answer text; empty string means unanswered. */
  answer: string;
  answered: boolean;
  kind: AskKind;
  /**
   * Set only on a summary confirmation holding more than one tag: the engine reads
   * no answer from it at all, so it is unanswered whatever the tags say.
   */
  invalidTags?: number;
}

/** One questions artifact. */
export interface QuestionsFile {
  /** Record-relative POSIX path, for display. */
  rel: string;
  phase: string;
  stage: string;
  /** Set only for a per-unit Construction artifact. */
  unit?: string;
  questions: QuestionEntry[];
  /** Questions with a blank `[Answer]:`. */
  unanswered: QuestionEntry[];
  /** File mtime (ISO) — how long the ask has been outstanding. */
  mtime: string;
  /** A fence, comment or raw HTML block was never closed and was read as text. */
  unclosed: boolean;
  /**
   * The stop hook's own test on the raw text — `\[Answer\]:[ \t]*_*[ \t]*$` anywhere,
   * no headings, no visibility (aidlc-continue-workflow.ts `hasPendingQuestion`). Not
   * an ask: a fact about the engine, used only for the active stage's own files.
   */
  rawBlank: boolean;
}

export interface QuestionsReport {
  files: QuestionsFile[];
  /** Only the artifacts that still have a blank answer, newest-asked first. */
  blocked: QuestionsFile[];
  totalQuestions: number;
  totalUnanswered: number;
  /** `rel` of every file read with an unclosed block, so the page can say so. */
  unclosed: string[];
}

/** The phase dirs a record can hold (mirrors PHASES in the engine's lib). */
const PHASE_DIRS = ["initialization", "ideation", "inception", "construction", "operation"];

/** How deep below a phase dir the recursive walk goes. The deepest real shape is 3. */
const MAX_DEPTH = 6;

/** An ATX heading: 0–3 spaces, 1–6 `#`, then a space or end of line. */
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
/**
 * A heading carrying a question id: `Q1`, `[Q1]`, `F1`, `[F1]`, with an optional
 * suffix that may or may not be hyphenated (`Q1-a`, `Q6a`). The id must be
 * followed by a delimiter or end of line, so a prose heading that merely starts
 * with the letter (`## U1의 완료는 …`) is not an ask, and neither is one whose id is
 * only mentioned mid-sentence.
 */
const QUESTION_ID_RE = /^\[?([QF]\d+(?:-?[A-Za-z0-9]+)?)\]?(?:$|[\s.:\]])/;
/**
 * The numbered forms the engine's own question prefix accepts (`QUESTION_PREFIX_RE`
 * and `NUMBERED_QUESTION_HEADING_RE`, aidlc-testing-posture.ts): `1.`, `2)`,
 * `Question 3:`, or a bare number. A delimiter must be followed by a space or end
 * the heading, so `## 1.5 GB 한도` is prose.
 */
const NUMBERED_RE = /^(?:q(?:uestion)?[ \t]*)?(\d+)[ \t]*(?:[:.)-](?:[ \t]|$)|$)/i;
/** The engine's question prefix, stripped before matching the plan approval label. */
const QUESTION_PREFIX_RE = /^(?:(?:q(?:uestion)?[ \t]*)?\d+[ \t]*[:.)-][ \t]*)/i;
/** A numbered heading with nothing after the number: its label is on the next line. */
const NUMBERED_BARE_RE = /^(?:q(?:uestion)?[ \t]*)?\d+[ \t]*[.:)-]?[ \t]*$/i;

/**
 * The engine's `headingKey` (2.11 aidlc-artifact-vocabulary.ts): a run of emoji,
 * optionally ZWJ-joined, then whitespace is decoration — and a bare
 * text-presentation symbol (©, ™, ▶) is not. `RGI_Emoji` is what draws that line
 * and needs the `v` flag, which `tsconfig`'s ES2023 target refuses in a literal;
 * the runtime has it, so the pattern is built rather than approximated.
 */
// biome-ignore lint/complexity/useRegexLiterals: a `v`-flag literal fails the ES2023 typecheck.
const LEADING_EMOJI_RE = new RegExp("^\\p{RGI_Emoji}(?:\\u200D?\\p{RGI_Emoji})*[ \\t]+", "v");
function headingKey(title: string): string {
  return title.replace(LEADING_EMOJI_RE, "").trim();
}

/**
 * The id-less gate headings, H2 only and compared exactly the way the engine
 * compares them: the summary and the feedback heading against the raw title, the
 * assumption heading through `headingKey`. A suffix is NOT accepted — the protocol
 * appends *sibling* sections sharing the title, and `aidlc-lib.ts` guards
 * duplicates by that same exact name. They stay English even in a Korean run (the
 * assumption heading is in `memory-seed/org.md`'s preserved-token list; the other
 * two are literals in the stage protocol), so there is no localisation to tolerate.
 */
const SUMMARY_HEADING = "Consolidated Summary Confirmation";
const FEEDBACK_HEADING = "Requested Changes Feedback";
const ASSUMPTION_HEADING = "Assumption Confirmation";

/** The engine's `isPlanApprovalLabel`: one emphasis pair and a trailing `?`/`:` ignored. */
function isPlanApprovalTitle(title: string): boolean {
  let t = title
    .trim()
    .replace(/[?:][ \t]*$/, "")
    .trim();
  for (const m of ["**", "__", "*", "_"]) {
    if (t.startsWith(m) && t.endsWith(m) && t.length > m.length * 2) {
      t = t.slice(m.length, -m.length).trim();
      break;
    }
  }
  return t.toLowerCase() === "plan approval";
}

/** What the engine writes after `[Answer]:` for a plan built with approval off. */
const PLAN_APPROVAL_OFF = "plan approval off";
// The engine writes `[Answer]:` at line start; capture the remainder verbatim so
// a multi-word answer with a trailing comment still reads as answered.
const ANSWER_RE = /^\[Answer\]:[ \t]*(.*)$/;

/** Blank after the colon, or only underscores — still waiting. */
function isBlank(answer: string): boolean {
  return /^_*$/.test(answer);
}

/** How a span's tags become an answer — see the header for where each rule comes from. */
type Role = "question" | "gate" | "loose";

const KIND: Record<Role, AskKind> = { question: "question", gate: "confirmation", loose: "loose" };

/**
 * The id a question heading names, so a later section reusing it (`### Q7 답변`)
 * lands on the same question. `Question 1` and `Q1` are the same id.
 */
function questionId(title: string): string | undefined {
  const key = headingKey(title);
  const id = QUESTION_ID_RE.exec(key)?.[1];
  if (id) return id.toUpperCase();
  const n = NUMBERED_RE.exec(key)?.[1];
  return n === undefined ? undefined : `Q${Number(n)}`;
}

/**
 * The role a heading opens, or undefined for one this reader does not recognise.
 * Plan approval and the summary are not here: their own readers below own those
 * lines, with the engine's boundaries rather than this one's.
 */
function roleOf(title: string, depth: number): Role | undefined {
  const key = headingKey(title);
  if (QUESTION_ID_RE.test(key) || NUMBERED_RE.test(key)) return "question";
  if (depth === 2 && (title === FEEDBACK_HEADING || key === ASSUMPTION_HEADING)) return "gate";
  return undefined;
}

/** An ask found at a line, so the readers' results can be put back in document order. */
type Located = { line: number; entry: QuestionEntry };

/** Lines a dedicated reader claimed, so the general one does not read them twice. */
type Owned = Set<number>;

/**
 * `latestPlanApproval` (aidlc-testing-posture.ts), transcribed rather than
 * approximated: its heading grammar (column 0, a closing `#` with no space), its
 * section end (a heading at the section's depth or shallower, or a numbered
 * heading at any depth), its subsection rule (a deeper tag fills only an empty
 * slot), its `## 1.` + label-on-the-next-line form, and its reset — every new Plan
 * Approval heading discards what the last one held. A reader that let its general
 * question grammar decide these boundaries split a nested `### [Q2]` off the plan
 * and hid the blank tag the engine was waiting on.
 */
const PLAN_HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
function readPlanApproval(lines: string[], owned: Owned): Located | undefined {
  let inPlan = false;
  let awaitingLabel = false;
  let numberedLine = -1;
  let depth = 0;
  let inSub = false;
  let found: { line: number; heading: string } | undefined;
  let answer: string | undefined;
  const open = (d: number, heading: string, line: number) => {
    inPlan = true;
    depth = d;
    inSub = false;
    awaitingLabel = false;
    found = { line, heading };
    answer = undefined;
  };
  lines.forEach((line, i) => {
    const h = PLAN_HEADING_RE.exec(line);
    if (h) {
      const d = h[1]?.length ?? 0;
      const text = (h[2] ?? "").trim();
      if (isPlanApprovalTitle(text.replace(QUESTION_PREFIX_RE, ""))) {
        open(d, text, i);
        owned.add(i);
        return;
      }
      if (inPlan && d > depth && !QUESTION_PREFIX_RE.test(text) && !NUMBERED_BARE_RE.test(text)) {
        inSub = true;
        awaitingLabel = false;
        owned.add(i);
        return;
      }
      inPlan = false;
      awaitingLabel = NUMBERED_BARE_RE.test(text);
      if (awaitingLabel) {
        depth = d;
        numberedLine = i;
      }
      return;
    }
    if (awaitingLabel && line.trim().length > 0) {
      awaitingLabel = false;
      if (isPlanApprovalTitle(line)) {
        open(depth, line.trim(), numberedLine);
        owned.add(numberedLine);
      }
    }
    if (!inPlan) return;
    owned.add(i);
    const a = ANSWER_RE.exec(line);
    if (a && !(inSub && answer !== undefined)) answer = (a[1] ?? "").trim();
  });
  if (!found || answer === undefined) return undefined;
  // A plan built with approval off left a record, not an ask (see the header).
  if (answer.toLowerCase() === PLAN_APPROVAL_OFF) return undefined;
  const base = { heading: found.heading, kind: "confirmation" as const };
  return {
    line: found.line,
    entry: isBlank(answer)
      ? { ...base, answer: "", answered: false }
      : { ...base, answer, answered: true },
  };
}

/**
 * `summaryConfirmationAnswer` (aidlc-lib.ts): the FIRST visible H2 titled exactly
 * `Consolidated Summary Confirmation`, through the next H2 — an H1 or a nested
 * question heading does not end it — answered only by exactly one tag.
 */
function readSummary(lines: string[], owned: Owned): Located | undefined {
  let start = -1;
  const answers: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const h = ATX_RE.exec(line);
    if (h && h[1]?.length === 2) {
      if (start >= 0) break;
      if (closedTitle(h[2]) === SUMMARY_HEADING) {
        start = i;
        owned.add(i);
      }
      continue;
    }
    if (start < 0) continue;
    owned.add(i);
    const a = ANSWER_RE.exec(line);
    if (a) answers.push((a[1] ?? "").trim());
  }
  if (start < 0 || answers.length === 0) return undefined;
  const base = {
    heading: SUMMARY_HEADING,
    kind: "confirmation" as const,
    answer: "",
    answered: false,
  };
  if (answers.length > 1) return { line: start, entry: { ...base, invalidTags: answers.length } };
  const answer = answers[0] ?? "";
  return { line: start, entry: isBlank(answer) ? base : { ...base, answer, answered: true } };
}

/** An ATX heading's title without its closing sequence (`## Q3 ##` → `Q3`). */
function closedTitle(raw: string | undefined): string {
  return (raw ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim();
}

/** The answer a general span gives, or undefined when it is not an ask. */
function entryOf(s: { heading: string; role: Role; markers: string[] }): QuestionEntry | undefined {
  if (s.markers.length === 0) return undefined;
  const base = { heading: s.heading, kind: KIND[s.role] };
  if (s.role === "loose") {
    // Only an all-blank one is an ask; a filled one stays uncounted, as before.
    return s.markers.every(isBlank) ? { ...base, answer: "", answered: false } : undefined;
  }
  // Rule 2: the first NON-EMPTY marker, not the first marker.
  const answer = s.markers.find((m) => !isBlank(m));
  return answer === undefined
    ? { ...base, answer: "", answered: false }
    : { ...base, answer, answered: true };
}

/**
 * Parse one questions artifact's text. Exported for tests: this is the whole
 * answered/unanswered contract, checkable from a string.
 *
 * Plan approval and the summary confirmation are read first, by transcriptions of
 * the engine's own readers, and claim their lines. Everything else goes to the
 * general reader: a recognised heading opens a span that runs to the next heading
 * at its depth or shallower (or to the next recognised one), it becomes an ask only
 * if it holds an `[Answer]:` marker, and a marker under no recognised heading
 * belongs to the nearest heading above it. See the header for the shapes behind
 * each rule.
 */
export function parseQuestionsFile(text: string): {
  questions: QuestionEntry[];
  unclosed: boolean;
} {
  type Span = {
    heading: string;
    depth: number;
    role: Role;
    markers: string[];
    inSub: boolean;
    id?: string;
    line: number;
  };
  const visible = visibleLines(text);
  const lines = visible.lines;
  const owned: Owned = new Set();
  const found: Located[] = [];
  const plan = readPlanApproval(lines, owned);
  if (plan) found.push(plan);
  const summary = readSummary(lines, owned);
  if (summary) found.push(summary);

  // A sink for lines after a claimed section, until the next heading opens a span.
  const sink: Span = { heading: "", depth: 0, role: "loose", markers: [], inSub: false, line: -1 };
  let current: Span = { heading: "", depth: 0, role: "loose", markers: [], inSub: false, line: 0 };
  const spans: Span[] = [current];

  lines.forEach((line, i) => {
    if (owned.has(i)) {
      current = sink;
      return;
    }
    const h = ATX_RE.exec(line);
    if (h) {
      const depth = h[1]?.length ?? 0;
      const title = closedTitle(h[2]);
      const role = roleOf(title, depth);
      if (role === undefined && current.role !== "loose" && depth > current.depth) {
        // A subsection of the open ask: its tags still belong to that ask.
        current.inSub = true;
        return;
      }
      current = {
        heading: title,
        depth,
        role: role ?? "loose",
        markers: [],
        inSub: false,
        line: i,
      };
      if (role === "question") current.id = questionId(title);
      spans.push(current);
      return;
    }
    const a = ANSWER_RE.exec(line);
    if (a) current.markers.push((a[1] ?? "").trim());
  });

  // A section reusing an earlier question's id is read as that question's
  // continuation — a dashboard reading of how humans answer here (`### Q7 답변`
  // under the engine's blank `### Q7.`), not an engine rule: its markers join the
  // first one's in document order, so rule 2 reads across both. The stop hook's raw
  // regex still sees the placeholder blank; that is a separate, active-stage fact.
  const byId = new Map<string, Span>();
  for (const s of spans) {
    if (s.role !== "question" || s.id === undefined) continue;
    const first = byId.get(s.id);
    if (!first) {
      byId.set(s.id, s);
      continue;
    }
    // A loop, not `push(...)`: a spread of a huge array overflows the stack.
    for (const m of s.markers) first.markers.push(m);
    s.markers = [];
  }

  for (const s of spans) {
    const e = entryOf(s);
    if (e) found.push({ line: s.line, entry: e });
  }
  found.sort((a, b) => a.line - b.line);
  return { questions: found.map((f) => f.entry), unclosed: visible.unclosed };
}

/** Just the asks — see `parseQuestionsFile`. */
export function parseQuestions(text: string): QuestionEntry[] {
  return parseQuestionsFile(text).questions;
}

function statMtime(p: string): string {
  try {
    return fs
      .statSync(p)
      .mtime.toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  } catch {
    return "";
  }
}

/** The stop hook's pending-question regex, verbatim. */
const STOP_HOOK_BLANK_RE = /\[Answer\]:[ \t]*_*[ \t]*$/m;

/** Read one questions artifact into a QuestionsFile, or undefined if unreadable. */
function readFileEntry(
  recordDir: string,
  relParts: string[],
  phase: string,
  stage: string,
  unit: string | undefined,
): QuestionsFile | undefined {
  const abs = path.join(recordDir, ...relParts);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf-8");
  } catch {
    return undefined;
  }
  const parsed = parseQuestionsFile(text);
  return {
    rel: relParts.join("/"),
    phase,
    stage,
    unit,
    questions: parsed.questions,
    unanswered: parsed.questions.filter((q) => !q.answered),
    mtime: statMtime(abs),
    unclosed: parsed.unclosed,
    rawBlank: STOP_HOOK_BLANK_RE.test(text),
  };
}

function entries(abs: string): fs.Dirent[] {
  try {
    return fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return [];
  }
}

/** Every `*-questions.md` below `dirs`, as the dir segments under the phase dir. */
function walk(recordDir: string, phase: string, dirs: string[], out: string[][]): void {
  if (dirs.length > MAX_DEPTH) return;
  for (const e of entries(path.join(recordDir, phase, ...dirs))) {
    if (e.name.startsWith(".")) continue;
    // `isDirectory()` on a Dirent does not follow a symlink, so a link cannot loop.
    if (e.isDirectory()) walk(recordDir, phase, [...dirs, e.name], out);
    else if (dirs.length > 0 && e.name.endsWith("-questions.md")) out.push([...dirs, e.name]);
  }
}

/**
 * Which stage — and, under construction, which unit — a file belongs to, from the
 * dir segments between the phase dir and the file. With the catalogue's oracle the
 * first segment that is a stage decides; without it, only construction has units,
 * and there a segment followed by another dir is one.
 */
function attribute(
  phase: string,
  dirs: string[],
  isStage: ((slug: string) => boolean) | undefined,
): { stage: string; unit?: string } {
  const [first = "", second] = dirs;
  if (isStage) {
    if (isStage(first)) return { stage: first };
    if (phase === "construction" && second !== undefined && isStage(second)) {
      return { stage: second, unit: first };
    }
  }
  if (phase === "construction" && second !== undefined && !isStage?.(first)) {
    return { stage: second, unit: first };
  }
  return { stage: first };
}

export interface QuestionsOptions {
  /** The catalogue's oracle, for the unit-vs-stage-subdirectory ambiguity. */
  isStage?: (slug: string) => boolean;
}

/**
 * Walk the record's phase dirs for questions artifacts, recursively — see WHERE WE
 * LOOK in the header. Never throws.
 */
export function readQuestions(recordDir: string, opts: QuestionsOptions = {}): QuestionsReport {
  const files: QuestionsFile[] = [];

  for (const phase of PHASE_DIRS) {
    const found: string[][] = [];
    walk(recordDir, phase, [], found);
    for (const parts of found) {
      const { stage, unit } = attribute(phase, parts.slice(0, -1), opts.isStage);
      const e = readFileEntry(recordDir, [phase, ...parts], phase, stage, unit);
      if (e) files.push(e);
    }
  }

  const blocked = files
    .filter((f) => f.unanswered.length > 0)
    .sort((a, b) => (a.mtime > b.mtime ? -1 : a.mtime < b.mtime ? 1 : 0));

  return {
    files,
    blocked,
    totalQuestions: files.reduce((n, f) => n + f.questions.length, 0),
    totalUnanswered: files.reduce((n, f) => n + f.unanswered.length, 0),
    unclosed: files.filter((f) => f.unclosed).map((f) => f.rel),
  };
}
