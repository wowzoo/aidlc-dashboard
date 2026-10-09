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
// (Not in the 2.10.0 release: `aidlc-plan-approval-ask.ts` landed after it, and
// run E came from that later engine.) Measured on run E: all three of its
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
// WHAT THE ENGINE SEES DECIDES WHAT IS ASKED (2.10/2.11). Six rules, each a shape
// the engine read one way and this reader another:
//
//   - Only VISIBLE lines count (scan/visible-lines.ts): a tag or heading inside a
//     fence, an HTML comment or a <pre> block is example text, as the engine's
//     `visibleMarkdownLines` reads it. An unclosed one hides nothing and is
//     reported — the alternative is a typo hiding every blocker below it.
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
//   - A blank tag under NO recognised heading is still a blocker. The stop hook
//     tests the whole file with one regex and never looks at headings, so the run
//     parks on it all the same. It attaches to the heading above it (or to none),
//     as `loose`. A filled one there stays uncounted, as before.
//   - Plan approval reads the LATEST section's LAST tag, a subsection tag only
//     filling an empty slot (`latestPlanApproval`, aidlc-testing-posture.ts); the
//     summary confirmation must hold EXACTLY ONE tag or the engine reads no answer
//     at all (`summaryConfirmationAnswer`), whatever the tags say. Every other ask
//     keeps rule 2 below.
//
// The engine is not consistent with itself here, and this reader sides with the
// readers that DECIDE: the stop hook's whole-file regex also counts a blank tag
// inside a fence and does not anchor `[Answer]:` to the line start, while the
// readers that grant an approval read visible lines with the tag at column 0.
//
// WHERE WE LOOK. stage-protocol.md: "Recursively read every
// `<record>/**/*-questions.md`", so the walk is recursive below each known phase
// dir (bounded in depth, dot-dirs and symlinked dirs skipped). Which stage a file
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
type Role = "question" | "gate" | "summary" | "plan" | "loose";

const KIND: Record<Role, AskKind> = {
  question: "question",
  gate: "confirmation",
  summary: "confirmation",
  plan: "confirmation",
  loose: "loose",
};

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

/** The role a heading opens, or undefined for one this reader does not recognise. */
function roleOf(title: string, depth: number): Role | undefined {
  if (isPlanApprovalTitle(title.replace(QUESTION_PREFIX_RE, ""))) return "plan";
  const key = headingKey(title);
  if (QUESTION_ID_RE.test(key) || NUMBERED_RE.test(key)) return "question";
  if (depth !== 2) return undefined;
  if (title === SUMMARY_HEADING) return "summary";
  if (title === FEEDBACK_HEADING || key === ASSUMPTION_HEADING) return "gate";
  return undefined;
}

/** The answer a span gives, or undefined when it is not an ask. */
function entryOf(s: {
  heading: string;
  role: Role;
  markers: { value: string; sub: boolean }[];
}): QuestionEntry | undefined {
  const base = { heading: s.heading, kind: KIND[s.role] };
  if (s.markers.length === 0) return undefined;
  const unanswered = { ...base, answer: "", answered: false };
  switch (s.role) {
    case "plan": {
      // Each tag overwrites the last; a subsection's only fills an empty slot.
      let answer: string | undefined;
      for (const m of s.markers) if (!(m.sub && answer !== undefined)) answer = m.value;
      if (answer === undefined) return undefined;
      // A plan built with approval off left a record, not an ask (see the header).
      if (answer.toLowerCase() === PLAN_APPROVAL_OFF) return undefined;
      return isBlank(answer) ? unanswered : { ...base, answer, answered: true };
    }
    case "summary": {
      if (s.markers.length > 1) return { ...unanswered, invalidTags: s.markers.length };
      const answer = s.markers[0]?.value ?? "";
      return isBlank(answer) ? unanswered : { ...base, answer, answered: true };
    }
    case "loose":
      // Only an all-blank one is an ask; a filled one stays uncounted, as before.
      return s.markers.every((m) => isBlank(m.value)) ? unanswered : undefined;
    default: {
      // Rule 2: the first NON-EMPTY marker, not the first marker.
      const answer = s.markers.find((m) => !isBlank(m.value))?.value;
      return answer === undefined ? unanswered : { ...base, answer, answered: true };
    }
  }
}

/**
 * Parse one questions artifact's text. Exported for tests: this is the whole
 * answered/unanswered contract, checkable from a string.
 *
 * A recognised heading opens a span that runs to the next heading at its depth or
 * shallower (or to the next recognised one). It becomes an ask only if it holds an
 * `[Answer]:` marker, and how its markers become an answer depends on what kind of
 * ask it is — see the header for the real-run and engine shapes behind each rule.
 * A marker under no recognised heading belongs to the nearest heading above it.
 */
export function parseQuestionsFile(text: string): {
  questions: QuestionEntry[];
  unclosed: boolean;
} {
  type Span = {
    heading: string;
    depth: number;
    role: Role;
    markers: { value: string; sub: boolean }[];
    inSub: boolean;
    awaitLabel: boolean;
    id?: string;
  };
  const span = (heading: string, depth: number, role: Role, awaitLabel = false): Span => ({
    heading,
    depth,
    role,
    markers: [],
    inSub: false,
    awaitLabel,
  });
  const visible = visibleLines(text);
  let current = span("", 0, "loose");
  const spans: Span[] = [current];

  for (const line of visible.lines) {
    const h = ATX_RE.exec(line);
    if (h) {
      const depth = h[1]?.length ?? 0;
      // A closing sequence (`## Q3 ##`) is not part of the title.
      const title = (h[2] ?? "").replace(/(?:^|[ \t]+)#+$/, "").trim();
      const role = roleOf(title, depth);
      if (role === undefined && current.role !== "loose" && depth > current.depth) {
        // A subsection of the open ask: its tags still belong to that ask.
        current.inSub = true;
        current.awaitLabel = false;
        continue;
      }
      const awaitLabel = role === "question" && NUMBERED_BARE_RE.test(headingKey(title));
      current = span(title, depth, role ?? "loose", awaitLabel);
      if (role === "question") current.id = questionId(title);
      spans.push(current);
      continue;
    }
    if (current.awaitLabel && line.trim().length > 0) {
      // `## 1.` with the label on the next line: the engine reads that as plan
      // approval when the label is one.
      current.awaitLabel = false;
      if (isPlanApprovalTitle(line)) {
        current.role = "plan";
        current.heading = line.trim();
        current.id = undefined;
      }
    }
    const a = ANSWER_RE.exec(line);
    if (a) current.markers.push({ value: (a[1] ?? "").trim(), sub: current.inSub });
  }

  // A section reusing an earlier question's id is that question's continuation: its
  // markers join the first one's, in document order, so rule 2 reads across both.
  // The engine refuses two sections with one id, so this never merges two real asks.
  const byId = new Map<string, Span>();
  for (const s of spans) {
    if (s.role !== "question" || s.id === undefined) continue;
    const first = byId.get(s.id);
    if (!first) {
      byId.set(s.id, s);
      continue;
    }
    first.markers.push(...s.markers);
    s.markers = [];
  }

  // Only the latest plan approval section is read; an earlier one is superseded.
  const lastPlan = spans.findLastIndex((s) => s.role === "plan" && s.markers.length > 0);
  const out: QuestionEntry[] = [];
  spans.forEach((s, i) => {
    if (s.role === "plan" && i !== lastPlan) return;
    const e = entryOf(s);
    if (e) out.push(e);
  });
  return { questions: out, unclosed: visible.unclosed };
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
