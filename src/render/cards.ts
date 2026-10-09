// The 2×2 card grid under the page header, the drill-down sections below it, and the
// sources line at the bottom.
//
// A CARD IS A SUMMARY, NOT A SECOND COPY OF A PANEL. Each card answers one question in
// a handful of bar-backed rows — which stage took the time, which unit is short of its
// contract, what is still unresolved, whether anything needs the human — and links to
// the full panel for the rest. The full panels are the existing renderers, mounted
// unchanged inside closed <details> ("drill-downs"), so no reading this dashboard
// already made is lost or re-implemented: the cards only choose what to show first.
//
// Two rules carry over from the panels they summarise:
//   - A number that was not measured is not drawn. A stage with no audit span shows
//     "—", not 0h; a unit with no contract shows the files it has, not a fraction.
//   - Stage time is WORK + CONVERSATION (`observedSec + conversationSec`), the same two
//     buckets the timing panel classifies, never elapsed wall time. Waiting on a human,
//     parked time and unclassified gaps are excluded, and the column tip says so.

import { renderTokens } from "../credit/claude/token-view";
import { renderCredit } from "../credit/view/credit-view";
import type { DashboardModel, Provenance, SourceKind } from "../model/types";
import type { CellState, MatrixCell, MatrixStage } from "../scan/matrix";
import type { PhaseInfo, StageInfo, StageStatus } from "../scan/parser";
import { DRILL, type Row, type RowTone, rowList, share, tabbedCard, viewLink } from "./card-kit";
import { dur, esc, hours } from "./common";
import { renderDeferrals } from "./deferrals";
import type { Strings } from "./i18n";
import { STAGE_GLYPH, cellGlyph, cellTip, renderOverview } from "./overview";
import { renderRunHealth } from "./status";
import { renderTimeline } from "./timeline";

/** Rows a card shows before folding the rest into "+N more". */
const CARD_ROWS = 6;

// ── Stage ────────────────────────────────────────────────────────────────────

const STAGE_TONE: Record<StageStatus, RowTone> = {
  done: "ok",
  active: "accent",
  awaiting: "warn",
  revising: "warn",
  pending: "none",
  skipped: "none",
};

/**
 * One row per stage SLUG. The 2.11 state writes one row per stage, so a slug normally has
 * one copy; a hand-edited state can repeat one, and the audit's timing is keyed by slug,
 * so copies fold into one row. The folded status is the most urgent one present: a
 * stage is only "done" when every executed copy is.
 */
function foldStatus(copies: StageInfo[]): StageStatus {
  const run = copies.filter((c) => c.execute && c.status !== "skipped");
  if (run.length === 0) return "skipped";
  if (run.every((c) => c.status === "done")) return "done";
  // A gate waiting on the human outranks a unit that is merely working: parallel units
  // can be at both at once, and the one that needs the reader is the one to show.
  for (const st of ["awaiting", "revising", "active"] as const) {
    if (run.some((c) => c.status === st)) return st;
  }
  // Some copies finished, the rest have not started, and none is on it now. That is NOT
  // "active" — ▶ would claim the run is working on this stage when it is not.
  return "pending";
}

function stageRows(phase: PhaseInfo, m: DashboardModel): Row[] {
  const bySlug = new Map<string, StageInfo[]>();
  for (const st of phase.stages) {
    const list = bySlug.get(st.slug);
    if (list) list.push(st);
    else bySlug.set(st.slug, [st]);
  }
  const timeOf = (slug: string): number | undefined => {
    const sp = m.timing.stages.find((t) => t.stage === slug);
    return sp ? sp.observedSec + sp.conversationSec : undefined;
  };
  const times = [...bySlug.keys()].map(timeOf).filter((t): t is number => t !== undefined);
  const max = Math.max(0, ...times);
  return [...bySlug.entries()].map(([slug, copies]) => {
    const status = foldStatus(copies);
    const first = copies[0] as StageInfo;
    const t = timeOf(slug);
    return {
      label: `${esc(STAGE_GLYPH[status])} ${esc(first.display)}`,
      value: t === undefined ? "—" : hours(t),
      pct: t === undefined ? undefined : share(t, max),
      tone: STAGE_TONE[status],
      dim: status === "skipped",
      tip: slug,
    };
  });
}

function currentPhaseIndex(phases: PhaseInfo[], current: string): number {
  const at = phases.findIndex((p) => p.stages.some((st) => st.slug === current));
  if (at >= 0) return at;
  for (let i = phases.length - 1; i >= 0; i--) if ((phases[i] as PhaseInfo).done > 0) return i;
  return 0;
}

export function renderStageCard(m: DashboardModel, s: Strings): string {
  const phases = m.state.phases.filter((p) => p.stages.length > 0);
  const tabs = phases.map((p) => ({
    label: p.display,
    count: { text: `${p.done}/${p.total}` },
    body: rowList(stageRows(p, m), {
      head: [s.cards.colStage, s.cards.colWorkChat],
      headTip: s.cards.workChatTip,
      max: CARD_ROWS,
      moreText: s.cards.moreRows,
      empty: s.cards.noStages,
    }),
  }));
  return tabbedCard({
    id: "stage",
    title: s.cards.stageTitle,
    tabs: tabs.length > 0 ? tabs : [{ label: "—", body: rowList([], { empty: s.cards.noStages }) }],
    selected: currentPhaseIndex(phases, m.state.currentStage),
    more: { href: `#${DRILL.timeline}`, label: s.cards.moreTimeline },
  });
}

// ── Unit ─────────────────────────────────────────────────────────────────────

const CELL_TONE: Record<CellState, RowTone> = {
  complete: "ok",
  partial: "warn",
  unsettled: "alt",
  unverified: "none",
  absent: "none",
  skipped: "none",
  "n/a": "none",
};

/**
 * REQUIRED artifacts met, as a fraction — the same set the cell's state is judged on.
 * `expected` also holds `optional_produces`, which never block coverage, so counting it
 * would read "3/3" for a unit that wrote none of its optional files and over-count a
 * partial one. With no required set (no catalogue, or an unknown kind) there is no
 * denominator: the figure is the file count, and no bar is drawn for it.
 */
function cellFigure(c: MatrixCell): { value: string; pct?: number } {
  if (c.state === "n/a") return { value: "—" };
  const total = c.required.length;
  if (total === 0) return { value: String(c.present.length) };
  const met = total - c.missing.length;
  return { value: `${met}/${total}`, pct: share(met, total) };
}

function unitRows(st: MatrixStage, s: Strings): Row[] {
  return st.cells.map((c) => {
    const fig = cellFigure(c);
    return {
      label: `${esc(cellGlyph(c.state))} ${esc(c.unit)}<span class="mr-sub"> · ${esc(
        s.cards.cellLabel[c.state],
      )}</span>`,
      value: fig.value,
      pct: fig.pct,
      tone: CELL_TONE[c.state],
      dim: c.state === "n/a",
      tip: cellTip(c.state, c.missing, c.present, s, c.receiptReason, c.skipReason),
    };
  });
}

export function renderUnitCard(m: DashboardModel, s: Strings): string {
  const more = { href: `#${DRILL.overview}`, label: s.cards.moreMatrix };
  const stages = m.matrix?.stages.filter((st) => st.execute && st.status !== "skipped") ?? [];
  if (stages.length === 0) {
    return tabbedCard({
      id: "unit",
      title: s.cards.unitTitle,
      tabs: [{ label: "—", body: rowList([], { empty: s.overview.noUnits }) }],
      more,
    });
  }
  // One stage, not a tab per stage: Construction has five or more per-unit stages
  // with long names, which do not fit as tabs in a half-width card. The card shows the
  // stage the run is on — or, off Construction, the latest one with any progress — and
  // the full stage × unit matrix is one click away.
  let pick = stages.find((st) => st.slug === m.state.currentStage);
  if (!pick) {
    // Any cell the run has touched counts as progress — a skip or an unverifiable receipt
    // is the run having been there, not a stage nothing happened in.
    for (const st of stages) {
      if (st.complete + st.partial + st.unsettled + st.unverified + st.skipped > 0) pick = st;
    }
  }
  const st = pick ?? (stages[0] as MatrixStage);
  return tabbedCard({
    id: "unit",
    title: s.cards.unitTitle,
    tabs: [
      {
        label: st.display,
        count: { text: `${st.complete}/${st.total - st.notApplicable - st.skipped}` },
        body: rowList(unitRows(st, s), {
          head: [s.cards.colUnit, s.cards.colArtifacts],
          max: CARD_ROWS,
          moreText: s.cards.moreRows,
        }),
      },
    ],
    more,
  });
}

// ── Unresolved ───────────────────────────────────────────────────────────────

function decisionRows(m: DashboardModel, s: Strings): Row[] {
  const items = m.deferrals.items;
  const max = Math.max(0, ...items.map((it) => it.ageSec ?? 0));
  return items.map((it) => {
    const owner = it.ownerStage ?? s.deferrals.faces[it.ownerStatus].label;
    return {
      label: `${viewLink(it.rel, it.item)} <span class="mr-sub">→ ${esc(owner)}</span>`,
      value: dur(it.ageSec),
      pct: it.ageSec === undefined ? undefined : share(it.ageSec, max),
      tone: it.ownerStatus === "passed" ? "warn" : it.ownerStatus === "current" ? "accent" : "none",
      tip: s.deferrals.faces[it.ownerStatus].tip,
    };
  });
}

function openQuestionRows(m: DashboardModel): Row[] {
  const now = Date.parse(m.generatedAt);
  const open = m.diaries.records
    .filter((r) => r.axis === "openQuestions" && r.questionStatus !== "resolved")
    // Follow-ups first: the same order the full panel uses.
    .sort((a, b) =>
      a.questionStatus === b.questionStatus ? 0 : a.questionStatus === "followUp" ? -1 : 1,
    );
  const ages = open.map((r) => (r.ts ? (now - Date.parse(r.ts)) / 1000 : undefined));
  const max = Math.max(0, ...ages.filter((a): a is number => a !== undefined && a > 0));
  return open.map((r, i) => {
    const age = ages[i];
    const where = r.unit ? `${r.stage} · ${r.unit}` : r.stage;
    return {
      label: `${viewLink(r.rel, r.text)} <span class="mr-sub">· ${esc(where)}</span>`,
      value: age !== undefined && age >= 0 ? dur(age) : "—",
      pct: age !== undefined && age >= 0 ? share(age, max) : undefined,
      tone: r.questionStatus === "followUp" ? "warn" : "none",
    };
  });
}

export function renderUnresolvedCard(m: DashboardModel, s: Strings): string {
  const decisions = decisionRows(m, s);
  const questions = openQuestionRows(m);
  const head: [string, string] = [s.cards.colItemOwner, s.cards.colAge];
  return tabbedCard({
    id: "unresolved",
    title: s.cards.unresolvedTitle,
    tabs: [
      {
        label: s.cards.decisionsTab,
        count: { text: String(decisions.length) },
        body: rowList(decisions, {
          head,
          max: CARD_ROWS,
          moreText: s.cards.moreRows,
          empty: s.cards.noDecisions,
        }),
      },
      {
        label: s.cards.openQsTab,
        count: { text: String(questions.length) },
        body: rowList(questions, {
          head: [s.cards.colStage, s.cards.colAge],
          max: CARD_ROWS,
          moreText: s.cards.moreRows,
          empty: s.cards.noOpenQs,
        }),
      },
    ],
    // Open the tab that has something in it.
    selected: decisions.length === 0 && questions.length > 0 ? 1 : 0,
    more: { href: `#${DRILL.deferrals}`, label: s.cards.moreDeferrals },
  });
}

// ── Grid, drill-downs, sources ───────────────────────────────────────────────

/** Stage, Unit, Unresolved, Run Health — reading order left to right, top to bottom. */
export function renderCards(m: DashboardModel, s: Strings): string {
  return `<div class="cards">
${renderStageCard(m, s)}
${renderUnitCard(m, s)}
${renderUnresolvedCard(m, s)}
${renderRunHealth(m, s)}
</div>`;
}

/**
 * The full panels, unchanged, each inside a closed <details>. They are what the cards
 * summarise, and they stay one click away rather than on the page by default — the
 * page should open on the summary, not on 20 screens of tables.
 */
export function renderDrills(m: DashboardModel, s: Strings): string {
  const usage =
    m.usage.kind === "claude"
      ? renderTokens(m.usage.tokens, m.usage.tokens.trend.window, s)
      : renderCredit(m.usage.credit, m.usage.credit.trend.window, s);
  const usageTitle = m.usage.kind === "claude" ? s.usage.tokenSection : s.usage.creditSection;
  const drill = (id: string, title: string, html: string) =>
    `<details class="drill" id="${id}"><summary>${esc(title)}</summary>
<div class="drill-body">
${html}
</div>
</details>`;
  return `<section class="drills" aria-label="${esc(s.cards.drillsHeading)}">
<h2 class="drills-h">${esc(s.cards.drillsHeading)}</h2>
${drill(DRILL.overview, s.overview.sectionProgress, renderOverview(m, s))}
${drill(DRILL.timeline, s.timeline.section, renderTimeline(m, s))}
${drill(DRILL.deferrals, s.deferrals.section, renderDeferrals(m, s))}
${drill(DRILL.usage, usageTitle, usage)}
</section>`;
}

/** Sources in the order a reader checks them: the ledger, the state file, then the rest. */
const SOURCE_ORDER: SourceKind[] = [
  "audit",
  "state.md",
  "disk",
  "hooks-health",
  "runtime-graph",
  "stage-graph",
];

function staleText(p: Provenance, s: Strings): string | undefined {
  const r = p.staleReason;
  if (!r) return undefined;
  switch (r.code) {
    case "graph-behind":
      return s.freshness.graphBehind(
        hours(r.lagSec),
        r.sensorDrift
          ? s.freshness.sensorDrift(r.sensorDrift.fired, r.sensorDrift.missing)
          : undefined,
      );
    case "graph-unreadable":
      return s.freshness.graphUnreadable;
    case "stage-graph-missing":
      return s.freshness.stageGraphMissing;
  }
}

/**
 * One line naming every source and how old it is. It replaces nothing: the per-source
 * provenance was always in the model; this is where the page states it, once, instead
 * of badging every number. A stale source is outlined so it is findable without
 * colour, and its reason is the hover text.
 */
export function renderSources(m: DashboardModel, s: Strings): string {
  const parts = SOURCE_ORDER.map((k) => {
    const p = m.provenance[k];
    const name = s.cards.sourceNames[k];
    const age = p.ageSec === undefined ? s.cards.sourceMissing : s.cards.sourceAge(dur(p.ageSec));
    const stale = p.stale ? ` · ${s.cards.sourceStale}` : "";
    const tip = staleText(p, s);
    return `<span class="src${p.stale ? " stale" : ""}${p.ageSec === undefined ? " missing" : ""}"${
      tip ? ` title="${esc(tip)}"` : ""
    }>${esc(name)} · ${esc(age)}${esc(stale)}</span>`;
  });
  return `<div class="sources"><span class="src-l">${esc(s.cards.sourcesLabel)}</span>${parts.join(
    "",
  )}</div>`;
}
