// The 2×2 cards (render/cards.ts) and the tab/row kit they share (render/card-kit.ts).
// Each test states the reading it protects; the fixture supplies real values, and the
// variants override exactly one field.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import type { DashboardModel, SourceKind } from "../model/types";
import { DRILL, MAX_TABS, TAB_CSS, tabbedCard } from "../render/card-kit";
import {
  renderCards,
  renderSources,
  renderStageCard,
  renderUnitCard,
  renderUnresolvedCard,
} from "../render/cards";
import { esc, hours } from "../render/common";
import { strings } from "../render/i18n";
import { STAGE_GLYPH } from "../render/overview";
import { renderPage } from "../render/page";
import { renderTimeline } from "../render/timeline";
import type { MatrixCell } from "../scan/matrix";
import type { StageStatus } from "../scan/parser";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const base = assemble(FIXTURE);
const ko = strings("ko");
const en = strings("en");
const checkedTab = (html: string, id: string) =>
  new RegExp(`id="mc-${id}-(\\d+)" value="\\d+" checked`).exec(html)?.[1];

describe("card kit", () => {
  test("one radio per tab, exactly one checked, labels wired to them", () => {
    const html = tabbedCard({
      id: "t",
      title: "T",
      tabs: [
        { label: "a", body: "A" },
        { label: "b", body: "B" },
      ],
      selected: 1,
    });
    expect(html.match(/<input class="mc-r"/g)?.length).toBe(2);
    expect(html.match(/ checked>/g)?.length).toBe(1);
    expect(checkedTab(html, "t")).toBe("1");
    expect(html).toContain('<label for="mc-t-0">a</label>');
  });

  test("an out-of-range selection is clamped, never left with nothing checked", () => {
    const html = tabbedCard({
      id: "t",
      title: "T",
      tabs: [{ label: "a", body: "A" }],
      selected: 9,
    });
    expect(checkedTab(html, "t")).toBe("0");
  });

  test("the CSS covers every tab position the kit allows", () => {
    for (let n = 1; n <= MAX_TABS; n++) {
      expect(TAB_CSS).toContain(
        `.mc-r:nth-of-type(${n}):checked ~ .mc-panels > .mc-p:nth-child(${n})`,
      );
    }
  });

  test("the page ships the tab CSS and restores picked tabs across the poll", () => {
    const html = renderPage(base, 60000, "ko");
    expect(html).toContain(".mc-r:nth-of-type(1):checked");
    expect(html).toContain("pickedTabs");
    // A drill-down link must open its closed <details>, not just scroll to it.
    expect(html).toContain("a[data-drill]");
    // The usage window toggle reloads onto ?cw=, and must land with that panel open.
    expect(html).toContain(`/[?&]cw=/.test(location.search)) openDrill("${DRILL.usage}")`);
  });
});

describe("Stage card", () => {
  test("tabs by phase and opens on the phase the run is in", () => {
    const html = renderStageCard(base, ko);
    const phases = base.state.phases.filter((p) => p.stages.length > 0);
    expect(html.match(/<label for="mc-stage-\d+">/g)?.length).toBe(phases.length);
    const at = phases.findIndex((p) => p.stages.some((s) => s.slug === base.state.currentStage));
    expect(checkedTab(html, "stage")).toBe(String(at));
  });

  test("time is work + conversation, never elapsed wall time", () => {
    const sp = base.timing.stages.find((t) => t.stage === "code-generation")!;
    expect(sp.elapsedSec).toBeGreaterThan(sp.observedSec + sp.conversationSec);
    const html = renderStageCard(base, ko);
    const row = html.slice(html.indexOf('title="code-generation"'));
    const value = /<span class="mr-v">([^<]*)<\/span>/.exec(row)?.[1];
    // hours() of observed + conversation: 8m on the fixture, not the ~31h wall span.
    expect(value).toBe("8m");
    expect(html).toContain("작업+대화");
    expect(html).toContain('class="has-tip"');
  });

  test("a stage with no audit span shows a dash, not zero hours", () => {
    const html = renderStageCard(base, ko);
    expect(base.timing.stages.some((t) => t.stage === "infrastructure-design")).toBe(false);
    const skipped = html.slice(html.indexOf('title="infrastructure-design"'));
    expect(/<span class="mr-v">([^<]*)<\/span>/.exec(skipped)?.[1]).toBe("—");
  });

  test("repeated copies of a slug fold into one row: partly done and idle is pending, not active", () => {
    const phase = base.state.phases.find((p) => p.key.toLowerCase().includes("construction"))!;
    const copy = phase.stages.find((s) => s.slug === "functional-design")!;
    const m: DashboardModel = {
      ...base,
      state: {
        ...base.state,
        phases: base.state.phases.map((p) =>
          p !== phase
            ? p
            : {
                ...p,
                stages: [
                  { ...copy, status: "done" as const },
                  { ...copy, status: "pending" as const },
                  ...p.stages.filter((s) => s.slug !== "functional-design"),
                ],
              },
        ),
      },
    };
    const html = renderStageCard(m, ko);
    const row = html.slice(html.indexOf('title="functional-design"'));
    const label = /<span class="mr-l">(.*?)<\/span><span class="mr-v">/.exec(row)?.[1] ?? "";
    expect(label).toContain("· Functional Design");
    expect(label).not.toContain("▶");
    // One row for the slug, not one per unit copy.
    expect(html.split('title="functional-design"').length - 1).toBe(1);
  });

  const foldRow = (copies: { status: StageStatus }[]) => {
    const phase = base.state.phases.find((p) => p.key.toLowerCase().includes("construction"))!;
    const copy = phase.stages.find((s) => s.slug === "functional-design")!;
    const m: DashboardModel = {
      ...base,
      state: {
        ...base.state,
        phases: base.state.phases.map((p) =>
          p !== phase
            ? p
            : {
                ...p,
                stages: [
                  ...copies.map((c) => ({ ...copy, ...c })),
                  ...p.stages.filter((s) => s.slug !== "functional-design"),
                ],
              },
        ),
      },
    };
    const html = renderStageCard(m, ko);
    const row = html.slice(html.indexOf('title="functional-design"'));
    return /<span class="mr-l">(.*?)<\/span><span class="mr-v">/.exec(row)?.[1] ?? "";
  };

  test("a copy at its gate outranks one that is working: the fold shows awaiting", () => {
    const label = foldRow([{ status: "active" }, { status: "awaiting" }]);
    expect(label.startsWith(`${STAGE_GLYPH.awaiting} `)).toBe(true);
  });
});

describe("Unit card", () => {
  test("shows the current construction stage, one row per unit, with the matrix glyphs", () => {
    const html = renderUnitCard(base, ko);
    expect(html).toContain(">Unit</h2>");
    expect(html).toContain("Code Generation");
    expect(html).toContain("█ PU-A-core");
    expect(html).toContain("▨ PU-B-ui");
    // Contract met as a fraction when a contract exists.
    expect(html).toContain('<span class="mr-v">1/2</span>');
    // The hover text is the matrix's own tip, naming what is missing.
    expect(html).toContain("미완: code-summary");
  });

  const withCell = (cell: Partial<MatrixCell>) => {
    const matrix = base.matrix!;
    const m: DashboardModel = {
      ...base,
      matrix: {
        ...matrix,
        stages: matrix.stages.map((st) =>
          st.slug !== base.state.currentStage
            ? st
            : { ...st, cells: [{ ...(st.cells[0] as MatrixCell), ...cell }] },
        ),
      },
    };
    const html = renderUnitCard(m, ko);
    // From the first ROW — `<div class="mr` alone would also match the `mr-h` header.
    return html.slice(html.indexOf('<div class="mr"'));
  };

  test("the fraction counts REQUIRED artifacts — an optional one is neither owed nor met", () => {
    const expected = ["plan", "code-summary", "optional-notes"];
    const required = ["plan", "code-summary"];
    const complete = withCell({
      state: "complete",
      present: ["plan.md", "code-summary.md"],
      expected,
      required,
      missing: [],
    });
    expect(complete).toContain('<span class="mr-v">2/2</span>');
    const partial = withCell({
      state: "partial",
      present: ["plan.md"],
      expected,
      required,
      missing: ["code-summary"],
    });
    expect(partial).toContain('<span class="mr-v">1/2</span>');
  });

  test("with no required set the figure is a file count, and no bar is drawn for it", () => {
    const row = withCell({
      state: "complete",
      present: ["plan.md", "code-summary.md"],
      expected: [],
      required: [],
      missing: [],
    });
    expect(row).toContain('<span class="mr-v">2</span>');
    expect(row.slice(0, row.indexOf("</div>"))).not.toContain("mr-b");
  });

  test("with no matrix it says so rather than rendering an empty grid", () => {
    const html = renderUnitCard({ ...base, matrix: undefined }, ko);
    expect(html).toContain(ko.overview.noUnits);
  });
});

describe("Unresolved card", () => {
  test("two tabs — open decisions and open questions — each counted", () => {
    const html = renderUnresolvedCard(base, ko);
    expect(html).toContain(`미결 결정 <b class="mc-n mute">${base.deferrals.items.length}</b>`);
    const open = base.diaries.records.filter(
      (r) => r.axis === "openQuestions" && r.questionStatus !== "resolved",
    ).length;
    expect(html).toContain(`Open questions <b class="mc-n mute">${open}</b>`);
  });

  test("each item links to the file it came from and names its owner", () => {
    const html = renderUnresolvedCard(base, ko);
    const it = base.deferrals.items[0]!;
    expect(html).toContain(`/view?rel=${encodeURIComponent(it.rel)}`);
    expect(html).toContain(`→ ${it.ownerStage}`);
  });

  test("a ledger read only in part says so without sending the reader to a panel that is gone", () => {
    // The empty text used to say the full panel names what was not read. That panel is
    // unmounted (SHOW_DEFERRALS), so the card has to carry the partial read on its own:
    // a floor count and a sentence that points nowhere.
    const m: DashboardModel = {
      ...base,
      deferrals: { ...base.deferrals, items: [], unreadSections: ["inception/x/y.md"] },
    };
    for (const s of [ko, en]) {
      const html = renderUnresolvedCard(m, s);
      expect(html).toContain(`${s.cards.decisionsTab} <b class="mc-n mute">0+</b>`);
      expect(html).toContain(esc(s.cards.notAllRead));
      expect(s.cards.notAllRead).not.toMatch(/패널|panel/i);
    }
  });

  test("the decisions tab says what its rows are — records, not open asks", () => {
    // With the full box unmounted this card is the ledger's only surface, so the limits
    // the panel used to state have to be on it: an artifact record, no close marker so
    // no way to tell whether it was answered, and owners per stage, not per unit.
    for (const s of [ko, en]) {
      const html = renderUnresolvedCard(base, s);
      const decisions = html.slice(
        0,
        html.indexOf('<div class="mc-p">', html.indexOf('<div class="mc-p">') + 1),
      );
      expect(decisions).toContain(esc(s.cards.decisionsNote));
      // The owner tips say what the record says, and promise no ask the ledger cannot see.
      expect(s.deferrals.faces.current.tip).not.toMatch(/이번 차례|this turn/);
      expect(s.deferrals.faces.ahead.tip).not.toMatch(/다시 물어옵니다|will be asked/);
    }
  });

  test("opens the questions tab when there are no decisions but there are questions", () => {
    const m: DashboardModel = { ...base, deferrals: { ...base.deferrals, items: [] } };
    expect(checkedTab(renderUnresolvedCard(m, ko), "unresolved")).toBe("1");
  });
});

describe("Unresolved card — stage-declared open questions", () => {
  test("a run whose only open points are stage-declared does not read 0 and 0", () => {
    // decisionRows read the A&OQ items and openQuestionRows the diaries, so a run whose
    // open points lived in requirements.md / contract-summary.md showed two empty tabs.
    const m: DashboardModel = {
      ...base,
      deferrals: { ...base.deferrals, items: [] },
      diaries: { ...base.diaries, records: [] },
    };
    const html = renderUnresolvedCard(m, ko);
    const q = base.deferrals.declared.questions[0]!;
    expect(html).toContain(
      `${ko.cards.declaredTab} <b class="mc-n mute">${base.deferrals.declared.questions.length}</b>`,
    );
    expect(html).toContain(`/view?rel=${encodeURIComponent(q.rel)}`);
    expect(checkedTab(html, "unresolved")).toBe("2");
  });
});

describe("grid, drill-downs and sources", () => {
  test("four cards in reading order", () => {
    const html = renderCards(base, ko);
    const order = ["card-stage", "card-unit", "card-unresolved", "card-health"].map((id) =>
      html.indexOf(`id="${id}"`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("every source is named with its age, and a stale one is outlined with its reason", () => {
    const html = renderSources(base, ko);
    const kinds = Object.keys(base.provenance) as SourceKind[];
    expect(kinds.length).toBe(6);
    for (const k of kinds) expect(html).toContain(`${esc(ko.cards.sourceNames[k])} · `);
    expect(base.provenance["runtime-graph"].stale).toBe(true);
    expect(html).toMatch(
      /<span class="src stale" title="[^"]+">runtime-graph · [^<]+ · 낡음<\/span>/,
    );
  });

  test("English renders the cards with no Hangul outside text quoted from the run", () => {
    let html = renderCards(base, en) + renderSources(base, en);
    // The fixture's run content is Korean; the cards quote it verbatim, as they must.
    for (const t of treeText(base)) html = html.split(esc(t)).join("");
    expect(html.match(/[가-힣]+/g) ?? []).toEqual([]);
  });
});

/** Text the cards quote verbatim from the run (item text, question headings). */
function treeText(m: DashboardModel): string[] {
  return [
    ...m.deferrals.items.map((i) => i.item),
    ...m.deferrals.declared.questions.map((q) => q.text),
    ...m.diaries.records.map((r) => r.text),
    ...m.blockers.map((b) => b.heading),
  ];
}

describe("timeline — unit view", () => {
  const ko = strings("ko");
  const unit = (stage: string, unitName: string, startedAt: string, sec: number) => {
    const endedAt = new Date(Date.parse(startedAt) + sec * 1000).toISOString().replace(".000", "");
    const split = {
      humanWaitSec: 0,
      parkedSec: 0,
      inferredParkSec: 0,
      observedSec: sec,
      conversationSec: 0,
      unknownSec: 0,
      delegatedSec: 0,
      parkAnomalies: 0,
      unknown: [],
      idleSec: 0,
      agentSec: 0,
      workSec: sec,
      suspect: [],
    };
    return {
      stage,
      unit: unitName,
      startedAt,
      endedAt,
      endKind: "completed" as const,
      elapsedSec: sec,
      segments: [{ startedAt, endedAt, endKind: "completed" as const, elapsedSec: sec, ...split }],
      ...split,
    };
  };

  test("no unit rows, no unit block", () => {
    expect(base.timing.units).toEqual([]);
    expect(renderTimeline(base, ko)).not.toContain(ko.timeline.unitNote);
  });

  // The point of the block: a unit-major stage bar is calendar occupancy, so each stage
  // the units touched sets their summed time beside that bar.
  test("each unit gets a row, and each stage sets its units' time beside its bar", () => {
    const sp = base.timing.stages.find((t) => t.stage === "code-generation")!;
    const m: DashboardModel = {
      ...base,
      timing: {
        ...base.timing,
        units: [
          unit("code-generation", "PU-A", sp.startedAt, 600),
          unit("code-generation", "PU-B", sp.startedAt, 1200),
        ],
      },
    };
    const html = renderTimeline(m, ko);
    expect(html).toContain(ko.timeline.unitSummary(2, 1));
    expect(html).toContain("PU-A");
    expect(html).toContain("PU-B");
    expect(html).toContain(ko.timeline.unitVsStage("code-generation", "30m", hours(sp.elapsedSec)));
  });

  test("a stage whose units were all skipped says so instead of 0 hours", () => {
    const skipped = { ...unit("infrastructure-design", "PU-A", base.timing.firstTs!, 0) };
    skipped.endKind = "skipped" as never;
    skipped.segments = skipped.segments.map((g) => ({ ...g, endKind: "skipped" as never }));
    const html = renderTimeline({ ...base, timing: { ...base.timing, units: [skipped] } }, ko);
    expect(html).toContain(ko.timeline.unitStageSkipped("infrastructure-design"));
  });

  // A lone skip gives the units' window zero width; it must stay a tick.
  test("a zero-length unit segment is a tick, never a full-width bar", () => {
    const skipped = { ...unit("infrastructure-design", "PU-A", base.timing.firstTs!, 0) };
    const html = renderTimeline({ ...base, timing: { ...base.timing, units: [skipped] } }, ko);
    const block = html.slice(html.indexOf(ko.timeline.unitSummary(1, 1)));
    expect(block).toContain('class="g-tick');
    expect(block).not.toContain("width:100.00%");
  });

  // Every tooltip prints the ledger's UTC stamp; the axis must read the same clock.
  test("the units' axis reads UTC, with the date where it changes", () => {
    const a = unit("code-generation", "PU-A", "2026-01-01T22:00:00Z", 3600);
    const b = unit("code-generation", "PU-B", "2026-01-02T01:00:00Z", 3600);
    const html = renderTimeline({ ...base, timing: { ...base.timing, units: [a, b] } }, ko);
    const block = html.slice(html.indexOf(ko.timeline.unitSummary(2, 1)));
    expect(block).toContain(">01-01 22:00<");
    expect(block).toContain(">01-02 00:00<");
  });
});
