// The KPI strip and its chart (render/kpi.ts). Each test states the reading it
// protects; the fixture supplies real values, and the variants override one field.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import type { DashboardModel } from "../model/types";
import { hours } from "../render/common";
import { strings } from "../render/i18n";
import { KPI_CSS, renderKpis } from "../render/kpi";
import { renderBody } from "../render/page";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const base = assemble(FIXTURE);
const ko = strings("ko");
const en = strings("en");

/** The n-th tile's markup (0-based). */
const tile = (html: string, n: number) => {
  const at = html.indexOf(`<label for="mc-kpi-${n}"`);
  return html.slice(at, html.indexOf("</label>", at));
};
/** The n-th chart panel's markup (0-based). */
const chart = (html: string, n: number) => html.split('<div class="kpi-c">')[n + 1] ?? "";

const withTiming = (over: Partial<DashboardModel["timing"]>): DashboardModel => ({
  ...base,
  timing: { ...base.timing, ...over },
});

describe("KPI strip", () => {
  test("three tiles, one radio group the poll restores, exactly one checked", () => {
    const html = renderKpis(base, ko);
    expect(html.match(/<input class="mc-r kpi-r" type="radio" name="mc-kpi"/g)?.length).toBe(3);
    expect(html.match(/ checked>/g)?.length).toBe(1);
    expect(html.match(/<div class="kpi-c">/g)?.length).toBe(3);
    for (let n = 1; n <= 3; n++) {
      expect(KPI_CSS).toContain(
        `.kpi-r:nth-of-type(${n}):checked ~ .kpi-charts > .kpi-c:nth-child(${n})`,
      );
    }
  });

  test("progress is state.md's figure and says so", () => {
    const t = tile(renderKpis(base, ko), 0);
    expect(t).toContain(`<b class="kpi-v">${base.state.overallPct}%</b>`);
    expect(t).toContain(`${base.state.overallDone}/${base.state.overallTotal} stage · state.md`);
  });

  test("time is work + conversation from the audit, never elapsed wall time", () => {
    const tt = base.timing;
    const figure = tt.total.observedSec + tt.total.conversationSec;
    expect(tt.elapsedSec).toBeGreaterThan(figure);
    const t = tile(renderKpis(base, ko), 2);
    expect(t).toContain(`<b class="kpi-v">${hours(figure)}</b>`);
    expect(t).toContain("벽시계 경과 시간이 아닙니다");
  });

  test("unclassified time is stated as left out — and only when there is some", () => {
    expect(base.timing.total.unknownSec).toBeGreaterThan(0);
    const said = ko.kpi.timeExcluded(hours(base.timing.total.unknownSec));
    expect(tile(renderKpis(base, ko), 2)).toContain(said);
    const none = withTiming({ total: { ...base.timing.total, unknownSec: 0 } });
    expect(tile(renderKpis(none, ko), 2)).not.toContain("은 포함하지 않음");
  });

  test("a multi-shard run states person-time beside the team figure; 'at once' needs overlap", () => {
    const person = hours(base.timing.personObservedSec + base.timing.personConversationSec);
    // The fixture: two clones, windows that never overlap — a handover.
    expect(base.timing.parallel).toBe(true);
    expect(base.timing.overlapSec).toBe(0);
    expect(tile(renderKpis(base, ko), 2)).toContain(
      ko.kpi.personTime(person, base.timing.clones, false),
    );
    const overlapped = withTiming({ overlapSec: 3600 });
    expect(tile(renderKpis(overlapped, ko), 2)).toContain(
      ko.kpi.personTime(person, base.timing.clones, true),
    );
    // One shard: the merged figure IS the person's, so nothing is added.
    const solo = withTiming({ parallel: false });
    expect(tile(renderKpis(solo, ko), 2)).not.toContain("사람 시간 합계");
  });

  test("usage with no record is a dashed dash, never a zero", () => {
    expect(base.usage.kind).toBe("kiro");
    const t = tile(renderKpis(base, ko), 1);
    expect(t).toContain('class="kpi missing"');
    expect(t).toContain('<b class="kpi-v">—</b>');
    expect(t).toContain(ko.kpi.usageNone);
  });

  test("Kiro usage with a limit shows the measured share of it", () => {
    if (base.usage.kind !== "kiro") throw new Error("fixture changed");
    const credit = base.usage.credit;
    const withLimit = (
      planLimit: number | null,
      usageRatio: number | null = null,
    ): DashboardModel => ({
      ...base,
      usage: {
        kind: "kiro",
        credit: {
          ...credit,
          status: "ok",
          current: {
            planName: "Pro",
            usedAmount: 250,
            remainingAmount: null,
            planLimit,
            usageRatio,
            resetDate: null,
            partial: true,
          },
        },
      },
    });
    const t = tile(renderKpis(withLimit(1000), ko), 1);
    expect(t).toContain('<b class="kpi-v">250</b>');
    expect(t).toContain("한도 1,000 중 25.0%");
    // The source's own ratio wins over the two amounts, and an overage is not clamped.
    expect(tile(renderKpis(withLimit(1000, 3.772701), ko), 1)).toContain("377.3%");
    // No limit sent → no share invented.
    const bare = tile(renderKpis(withLimit(null), ko), 1);
    expect(bare).toContain(ko.kpi.creditSub(undefined, undefined));
    expect(bare).not.toContain("%");
  });
});

describe("KPI charts", () => {
  test("one hover group per 6h bin, stacked work and chat, tip names every bucket", () => {
    const c = chart(renderKpis(base, ko), 2);
    expect(c.split("부터 6시간").length - 1).toBe(base.timing.bins.length);
    expect(c).toContain('class="k-work"');
    expect(c).toContain("사람 대기");
    expect(c).toContain("미분류");
  });

  test("the fixture's bins re-cut total exactly", () => {
    const t = base.timing;
    for (const f of [
      "observedSec",
      "conversationSec",
      "unknownSec",
      "humanWaitSec",
      "parkedSec",
    ] as const) {
      expect(t.bins.reduce((n, b) => n + b[f], 0)).toBeCloseTo(t.total[f], 6);
    }
  });

  /** `x,y` pairs of the progress chart's step line. */
  const stepPoints = (html: string) =>
    (/<polyline[^>]*points="([^"]+)"/.exec(chart(html, 0))?.[1]?.split(" ") ?? []).map((p) =>
      p.split(",").map(Number),
    ) as [number, number][];

  test("silence after the last event is a labelled band with its real length, not drawn to scale", () => {
    expect(base.timing.sinceLastEventSec).toBeGreaterThan(0);
    // The fixture was last written long ago: at true scale its run would be a sliver.
    expect(base.timing.sinceLastEventSec).toBeGreaterThan(100 * base.timing.bins.length * 6 * 3600);
    const html = renderKpis(base, ko);
    const c = chart(html, 2);
    expect(c).toContain('class="kpi-silence"');
    expect(c).toContain(`+${hours(base.timing.sinceLastEventSec)}`);
    const quiet = renderKpis(withTiming({ sinceLastEventSec: 0 }), ko);
    expect(chart(quiet, 2)).not.toContain("kpi-silence");
  });

  test("the axis ends AT the last event — the rest of its 6h bin is not drawn as recorded", () => {
    const t = base.timing;
    const html = renderKpis(base, ko);
    // Every bin's hover column, in order: a full bin is one width, the last is clipped.
    const cols = [
      ...chart(html, 2).matchAll(
        /<rect x="[\d.]+" y="\d+" width="([\d.]+)" height="\d+" fill="transparent"/g,
      ),
    ].map((m) => Number(m[1]) + 1);
    expect(cols.length).toBe(t.bins.length);
    const lastStart = Date.parse(t.bins[t.bins.length - 1]!.start);
    const frac = (Date.parse(t.lastEventTs!) - lastStart) / (6 * 3600 * 1000);
    // The fixture's last event is mid-bin, so a full-width last column would fail this.
    expect(frac).toBeGreaterThan(0.05);
    expect(frac).toBeLessThan(0.95);
    expect(cols[cols.length - 1]! / cols[1]!).toBeCloseTo(frac, 2);
    // …and the band follows the recorded span directly.
    const bandX = Number(/class="kpi-silence" x="([\d.]+)"/.exec(chart(html, 2))?.[1]);
    const pts = stepPoints(html);
    expect(bandX - pts[pts.length - 1]![0]).toBeCloseTo(2, 1);
  });

  test("the progress line is a step per stage's first completion", () => {
    const completed = base.timing.stages.filter((st) =>
      st.segments.some((g) => g.endKind === "completed"),
    ).length;
    const html = renderKpis(base, ko);
    const pts = stepPoints(html);
    // origin + two corners per completion + the flat run to the last event
    expect(pts.length).toBe(2 * completed + 2);
    for (let i = 0; i < completed; i++) {
      const [a, b] = [pts[2 * i + 1]!, pts[2 * i + 2]!];
      // A vertical riser: same x, one step up (SVG y grows downward).
      expect(a[0]).toBe(b[0]);
      expect(b[1]).toBeLessThan(a[1]);
    }
    // Starts at zero on the first event, ends flat at the final count.
    expect(pts[0]![1]).toBe(pts[1]![1]);
    expect(pts[pts.length - 1]![1]).toBe(pts[pts.length - 2]![1]);
    expect(chart(html, 0)).toContain(ko.kpi.progressChartAria(completed));
  });

  test("with no audit events the charts say so instead of drawing an empty axis", () => {
    const html = renderKpis(withTiming({ bins: [], stages: [] }), ko);
    expect(chart(html, 0)).toContain(ko.kpi.noEvents);
    expect(chart(html, 2)).toContain(ko.kpi.noEvents);
    expect(tile(html, 2)).toContain('class="kpi missing"');
  });
});

describe("KPI strip on the page", () => {
  test("sits between the run line and the cards", () => {
    const body = renderBody(base, "ko");
    const at = ["runline", 'class="kpis"', 'class="cards"'].map((k) => body.indexOf(k));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("English renders with no Hangul", () => {
    expect(/[가-힣]/.test(renderKpis(base, en))).toBe(false);
  });
});
