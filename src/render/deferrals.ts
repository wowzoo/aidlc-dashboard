// 미뤄둔 결정 — the deferral ledger panel.
//
// The question this panel answers is "what did we decide not to decide, and where
// does it come back?" Nothing else on the page answers it. The blocker panel reads a
// blank `[Answer]:`, and a finished run has none while still owing 230 decisions.
//
// It carries THREE ledgers, kept separate because they are separate claims: the
// artifacts' `## Assumptions & Open Questions` (items, with an assigned stage where
// the tree names one), its `[assumption]` entries (no owner), and each stage's
// `memory.md` `## Open questions` (diaryOpenBlock, no owner). The stage-diary card
// that used to sit here read all four memory.md axes and was unmounted for it
// (render/health.ts, SHOW_DIARY) — three of those axes are the orchestrator's
// reasoning and state no debt. Only the Open questions axis does, so only it came
// back, and it came back here rather than there.
//
// THREE RULES THIS PANEL FOLLOWS, mirroring the timing panel's hard-won ones:
//
//   1. Rank by what the reader must act on, not by size. `passed` leads — the stage
//      an item was assigned to has finished, so nobody is going to ask it — then
//      `current`, which is the run's live bill. `nextCycle` and `outOfScope` are
//      deliberate exits and sort last however many there are.
//   2. Show the direction, do not label it. A row prints `기록 stage → 배정 stage`
//      so the reader sees for themselves whether a decision was pushed forward or
//      handed back to a closed stage. Computing "backward" would need an ordering
//      assumption this module has no measured right to make.
//   3. Say what cannot be seen. The engine writes no close marker for an open item,
//      so `passed` cannot mean "dropped" — it means "no answer is visible". The note
//      under the ledger rows says that in one sentence rather than letting a count
//      read as a defect tally.
//   4. Never let the layout assert a comparison the data does not support. The three
//      ledgers get a ROW EACH (ledgerRows) rather than tiles in one strip, because
//      equal tiles side by side say "these measure the same thing" and only the first
//      four numbers do. Same rule as the timing panel's bar length vs bar colour.

import type { DashboardModel } from "../model/types";
import type { DeferralItem, OwnerStatus } from "../scan/deferrals";
import { dur, esc, pill, section, shortTs } from "./common";
import type { Strings } from "./i18n";

interface StatusFace {
  label: string;
  tone: "ok" | "warn" | "bad" | "mute";
  tip: string;
}

/** Tone is presentation and stays here; the words come from the catalogue. */
const TONE: Record<OwnerStatus, StatusFace["tone"]> = {
  passed: "bad",
  current: "warn",
  ahead: "mute",
  outOfScope: "warn",
  nextCycle: "mute",
  unassigned: "bad",
};

function face(status: OwnerStatus, s: Strings): StatusFace {
  const f = s.deferrals.faces[status];
  return { label: f.label, tone: TONE[status], tip: f.tip };
}

/** KPI order: the two that need action, then the two that are merely scheduled. */
const KPI_ORDER: OwnerStatus[] = ["passed", "current", "ahead", "unassigned"];

function assignmentText(cell: string): string {
  const flat = cell.replace(/`/g, "");
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

function itemRow(it: DeferralItem, s: Strings): string {
  const f = face(it.ownerStatus, s);
  const origin = it.unit ? `${it.unit} / ${it.stage}` : it.stage;
  const target = it.ownerStage ?? "—";
  const fanIn =
    it.sources.length > 1 ? ` <span class="dfr-fan">+${it.sources.length - 1}</span>` : "";
  return `<li class="dfr-item">
  <div class="dfr-meta">${pill(f.label, f.tone, f.tip)}
    <span class="dfr-route"><span class="dfr-from">${esc(origin)}</span> → <span class="dfr-to">${esc(
      target,
    )}</span></span>${fanIn}
    <span class="dfr-age" title="${esc(s.deferrals.ageTip)}">${esc(dur(it.ageSec))}</span>
    <a class="dfr-source" href="/view?rel=${encodeURIComponent(it.rel)}" title="${esc(
      s.deferrals.viewTip(it.rel),
    )}">${esc(s.deferrals.sourceLink)}</a>
    <a class="dfr-source" href="/open?rel=${encodeURIComponent(it.rel)}" title="${esc(
      s.deferrals.openTip(it.rel),
    )}">${esc(s.deferrals.editorLink)}</a>
  </div>
  <div class="dfr-text">${esc(it.item.length > 300 ? `${it.item.slice(0, 300)}…` : it.item)}</div>
  ${
    it.assignment.length > 0
      ? // The cell is markdown and its slugs arrive backticked; the backticks are
        // redundant inside <code>, so they come off here rather than in the scanner —
        // the model keeps the cell verbatim because it also carries registry ids.
        `<div class="dfr-assign">${esc(s.deferrals.assignLabel)} <code>${esc(
          assignmentText(it.assignment),
        )}</code></div>`
      : ""
  }
</li>`;
}

function itemList(items: DeferralItem[], visible: number, key: string, s: Strings): string {
  if (items.length === 0) return `<p class="note">${esc(s.deferrals.noneApplicable)}</p>`;
  const shown = items.slice(0, visible);
  const rest = items.slice(visible);
  const rowOf = (it: DeferralItem) => itemRow(it, s);
  return `<ul class="dfr-list">${shown.map(rowOf).join("")}</ul>${
    rest.length > 0
      ? `<details class="dfr-more"><summary>${esc(s.deferrals.more(key, rest.length))}</summary>
  <ul class="dfr-list">${rest.map(rowOf).join("")}</ul></details>`
      : ""
  }`;
}

/**
 * Which stage each decision was handed to, and how many landed there. This is the one
 * view that answers "who is carrying the most of this", so it only exists when at
 * least one item names a stage.
 *
 * WHEN NO ITEM HAS AN OWNER IT IS NOT RENDERED. On a tree whose 배정 cells are all
 * prose it collapsed to a single row — `(unassigned) · 배정 없음 · 15` — which repeated
 * the ledger row above it verbatim and spent a raw enum name to do it. A `<details>`
 * that costs a click and returns nothing new is worse than no `<details>`.
 */
function ownerTable(m: DashboardModel, s: Strings): string {
  const all = m.deferrals.byOwner;
  const stages = all.filter((o) => o.stage !== undefined).length;
  if (stages === 0) return "";
  const rows = all
    .map((o) => {
      const f = face(o.status, s);
      // A bucket row carries no stage; its label lives in the catalogue, not the model.
      return `<tr><th class="g-name">${esc(o.stage ?? f.label)}</th>
  <td>${pill(f.label, f.tone, f.tip)}</td>
  <td class="g-n">${o.count}</td></tr>`;
    })
    .join("");
  const t = s.deferrals;
  return `<details class="dfr-owners"><summary>${esc(t.ownerRollup(stages))}</summary>
  <table class="tbl">
    <thead><tr><th>${esc(t.colOwner)}</th><th>${esc(t.colStatus)}</th><th>${esc(
      t.colCount,
    )}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</details>`;
}

function assumptionsBlock(m: DashboardModel, s: Strings): string {
  const t = s.deferrals;
  const list = m.deferrals.assumptions;
  if (list.length === 0) return "";
  const rows = list
    .map(
      (a) => `<li class="dfr-item">
  <div class="dfr-meta">${pill(t.assumptionPill, "mute", t.assumptionPillTip)}
    <span class="dfr-route"><span class="dfr-from">${esc(
      a.unit ? `${a.unit} / ${a.stage}` : a.stage,
    )}</span></span>
    <a class="dfr-source" href="/open?rel=${encodeURIComponent(a.rel)}" title="${esc(
      t.openTip(a.rel),
    )}">${esc(t.sourceLink)}</a>
  </div>
  <div class="dfr-text">${esc(a.text.length > 260 ? `${a.text.slice(0, 260)}…` : a.text)}</div>
</li>`,
    )
    .join("");
  return `<details class="dfr-assum"><summary>${esc(t.assumptionSummary(list.length))}</summary>
  <p class="note">${t.assumptionNote}</p>
  <ul class="dfr-list">${rows}</ul>
</details>`;
}

/**
 * The SECOND mandated open-questions ledger — `## Open questions` in each stage's
 * `memory.md` (`knowledge/aidlc-shared/memory-template.md` puts it in every one).
 *
 * It lands here rather than back in 결정과 이슈 because this is the panel that answers
 * "what is still owed?", and that card was unmounted for mixing this axis with three
 * that do not answer it (Interpretations / Deviations / Tradeoffs — 140 · 63 of prose
 * on one run, none of it stating a debt). The Open questions axis is the exception:
 * on one real tree its 34 entries across 6 stages read as plain obligations ("재스캔
 * 비용을 받아들일지 … 결정할 것"), and nothing on screen was showing them.
 *
 * Two honesty rules, both borrowed from the artifact ledger above:
 *
 *   - The HEADING is the declaration, so a `note` entry counts as open just like a
 *     `followUp` one. `questionStatus` is a regex reading of the sentence and is used
 *     only to sort, never to drop an entry the engine filed under Open questions.
 *   - A diary bullet has no 배정 cell either, so no owner is claimed. The diary is the
 *     orchestrator's own note, not a contract with a later stage — which is exactly
 *     why these are kept apart from the artifact items instead of summed with them.
 */
function diaryOpenBlock(m: DashboardModel, s: Strings): string {
  const t = s.deferrals;
  const all = m.diaries.records.filter((r) => r.axis === "openQuestions");
  const open = all.filter((r) => r.questionStatus !== "resolved");
  if (open.length === 0) return "";
  const resolved = all.length - open.length;
  // Newest first, and the sentences that name an obligation ahead of the rest.
  const ordered = [...open]
    .reverse()
    .sort((a, b) =>
      a.questionStatus === b.questionStatus ? 0 : a.questionStatus === "followUp" ? -1 : 1,
    );
  const rows = ordered
    .map(
      (r) => `<li class="dfr-item">
  <div class="dfr-meta">${pill(
    r.questionStatus === "followUp" ? t.diaryFollowUpPill : t.diaryNotePill,
    r.questionStatus === "followUp" ? "warn" : "mute",
    r.questionStatus === "followUp" ? t.diaryFollowUpTip : t.diaryNoteTip,
  )}
    <span class="dfr-route"><span class="dfr-from">${esc(
      r.unit ? `${r.unit} / ${r.stage}` : r.stage,
    )}</span></span>
    ${r.ts ? `<span class="dfr-age">${esc(shortTs(r.ts))}</span>` : ""}
    <a class="dfr-source" href="/open?rel=${encodeURIComponent(r.rel)}" title="${esc(
      t.openTip(r.rel),
    )}">${esc(t.sourceLink)}</a>
  </div>
  <div class="dfr-text">${esc(r.text.length > 260 ? `${r.text.slice(0, 260)}…` : r.text)}</div>
</li>`,
    )
    .join("");
  return `<details class="dfr-assum"><summary>${esc(t.diarySummary(open.length))}</summary>
  <p class="note">${t.diaryNote(resolved)}</p>
  <ul class="dfr-list">${rows}</ul>
</details>`;
}

/**
 * The three ledgers, one row each.
 *
 * This started as a six-tile KPI strip and that was the wrong shape for the content:
 * six numbers side by side in identical tiles read as six comparable measurements of
 * one thing, which is the single claim this panel must not make — the first four
 * partition `items`, and the last two are separate reads that are never summed with
 * them. Three leading zeros also took half the width while 15 · 12 · 28 were squeezed
 * to the right, and the sixth tile wrapped onto a row of its own, taking the divider
 * that was carrying the "these are different" signal with it.
 *
 * A row per ledger fixes all of that by construction: the count, what it is, where it
 * was read from, and — only for the ledger that has owners — the owner breakdown as
 * chips. Zeros stay visible (a `지난 단계 0` is worth reading: nothing has fallen
 * through) but they no longer compete with the totals for the eye.
 */
function ledgerRows(
  d: DashboardModel["deferrals"],
  diaryOpen: number,
  diaryFollowUp: number,
  s: Strings,
): string {
  const t = s.deferrals;
  const chip = (label: string, n: number, tone: string, tip: string) =>
    `<span class="dfr-chip t-${n > 0 ? tone : "zero"}" title="${esc(tip)}">${esc(
      label,
    )} <b>${n}</b></span>`;

  const rows: string[] = [
    row({
      n: d.items.length,
      // Urgency of the whole ledger is its worst live status, not its size.
      tone:
        d.counts.passed > 0 || d.counts.unassigned > 0
          ? "bad"
          : d.counts.current > 0
            ? "warn"
            : "mute",
      label: t.ledgerItems,
      source: t.ledgerItemsSource,
      chips: KPI_ORDER.map((st) => {
        const f = face(st, s);
        return chip(f.label, d.counts[st], f.tone, f.tip);
      }).join(""),
    }),
  ];
  if (d.assumptions.length > 0) {
    rows.push(
      row({
        n: d.assumptions.length,
        tone: "mute",
        label: t.ledgerAssumptions,
        source: t.ledgerAssumptionsSource,
        chips: chip(t.faces.unassigned.label, d.assumptions.length, "mute", t.chipUnassignedTip),
      }),
    );
  }
  if (diaryOpen > 0) {
    rows.push(
      row({
        n: diaryOpen,
        tone: diaryFollowUp > 0 ? "warn" : "mute",
        label: t.ledgerDiary,
        source: t.ledgerDiarySource,
        chips:
          chip(t.chipFollowUp, diaryFollowUp, "warn", t.chipFollowUpTip) +
          chip(t.chipOther, diaryOpen - diaryFollowUp, "mute", t.chipOtherTip),
      }),
    );
  }
  return `<ul class="dfr-ledgers">${rows.join("")}</ul>
<p class="note">${t.ledgersNote}</p>`;
}

function row(r: {
  n: number;
  tone: string;
  label: string;
  source: string;
  chips: string;
}): string {
  return `<li class="dfr-ledger">
  <span class="dfr-ledger-n t-${r.tone}">${r.n}</span>
  <div class="dfr-ledger-body">
    <div class="dfr-ledger-h">${esc(r.label)} <span class="dfr-ledger-src">${r.source}</span></div>
    <div class="dfr-chips">${r.chips}</div>
  </div>
</li>`;
}

function body(m: DashboardModel, s: Strings): string {
  const t = s.deferrals;
  const d = m.deferrals;
  const diary = diaryOpenBlock(m, s);
  if (d.sections === 0) {
    return `<p class="note">${t.noSections(d.artifacts)}</p>${diary}`;
  }
  if (d.items.length === 0 && d.assumptions.length === 0) {
    // `emptySections` counts only an explicit `None.`; `sections` counts the heading
    // wherever it appears. A gap between them is a shape this reader cannot parse,
    // and calling that "비어 있음" is the one thing this panel must never say — it is
    // exactly the false all-clear that reading only the table shape used to produce.
    const unread = d.sections - d.emptySections;
    if (unread > 0) {
      return `<p class="note warn">${t.unreadSections(
        d.sections,
        unread,
        d.emptySections,
      )}</p>${diary}`;
    }
    return `<p class="note">${pill(t.noOpenPill, "ok", t.noOpenPillTip)}${t.allNone(
      d.sections,
    )}</p>${diary}`;
  }

  const diaryOpen = m.diaries.records.filter(
    (r) => r.axis === "openQuestions" && r.questionStatus !== "resolved",
  );
  const diaryFollowUp = diaryOpen.filter((r) => r.questionStatus === "followUp").length;
  const kpis = ledgerRows(d, diaryOpen.length, diaryFollowUp, s);

  const exits = d.counts.nextCycle + d.counts.outOfScope;
  const lead = `<p class="note">${t.lead(d.items.length, d.sections, d.rows, exits)}</p>`;

  const byStatus = (s: OwnerStatus) => d.items.filter((i) => i.ownerStatus === s);
  const passed = byStatus("passed");
  const current = byStatus("current");
  const rest = d.items.filter(
    (i) => i.ownerStatus !== "passed" && i.ownerStatus !== "current" && i.ownerStatus !== "ahead",
  );
  const ahead = byStatus("ahead");

  const warn = d.catalogMissing ? `<p class="note warn">${t.catalogMissingNote}</p>` : "";

  return `${kpis}${lead}${warn}
<div class="dfr-focus">
  <h3>${esc(t.headingPassed(passed.length))}</h3>
  ${itemList(passed, 6, t.faces.passed.label, s)}
</div>
<div class="dfr-focus">
  <h3>${esc(t.headingCurrent(current.length))}</h3>
  ${itemList(current, 5, t.faces.current.label, s)}
</div>
${
  ahead.length > 0
    ? `<details class="dfr-ahead"><summary>${esc(t.summaryAhead(ahead.length))}</summary>
  <ul class="dfr-list">${ahead.map((it) => itemRow(it, s)).join("")}</ul>
</details>`
    : ""
}
${
  rest.length > 0
    ? `<details class="dfr-rest"><summary>${esc(t.summaryRest(rest.length))}</summary>
  <ul class="dfr-list">${rest.map((it) => itemRow(it, s)).join("")}</ul>
</details>`
    : ""
}
${assumptionsBlock(m, s)}
${diary}
${ownerTable(m, s)}`;
}

export function renderDeferrals(m: DashboardModel, s: Strings): string {
  return section(s.deferrals.section, body(m, s), "deferrals");
}
