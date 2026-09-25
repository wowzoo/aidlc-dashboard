// The status strip (model/status.ts + render/status.ts). The fixture gives one real
// reading of every signal; the variants are built by overriding one field of that
// model, so each test changes exactly the thing it names.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { buildStatus } from "../model/status";
import type { DashboardModel } from "../model/types";
import { strings } from "../render/i18n";
import { renderBody } from "../render/page";
import { renderStatus } from "../render/status";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const base = assemble(FIXTURE);

const withGuard = (stopGuard: DashboardModel["health"]["stopGuard"]): DashboardModel => ({
  ...base,
  health: { ...base.health, stopGuard },
});

const withSensorRow = (
  row: Partial<DashboardModel["sensors"]["stages"][number]>,
): DashboardModel => ({
  ...base,
  sensors: {
    ...base.sensors,
    stages: base.sensors.stages.map((s) =>
      s.stage === base.state.currentStage ? { ...s, ...row } : s,
    ),
  },
});

describe("status strip — readings", () => {
  test("the fixture: running, blocked once, one answer waiting, one check failure", () => {
    const st = buildStatus(base);
    expect(st.run).toEqual({
      state: "running",
      stageDisplay: "Code Generation",
      lastEventAgeSec: base.provenance.audit.ageSec,
    });
    expect(st.stuck).toEqual({ state: "blocked", count: 1, stage: "code-generation" });
    expect(st.human?.current).toBe(1);
    expect(st.human?.earlier).toBe(0);
    expect(st.human?.oldestWaitingSec).toBe(base.blockers[0]?.waitingSec);
    expect(st.checks).toEqual({ state: "failed", failed: 1, passed: 0 });
  });

  test("a completed run shows the run chip alone — past blocks and failures are history", () => {
    const st = buildStatus({ ...base, blockers: [], state: { ...base.state, complete: true } });
    expect(st).toEqual({ run: { state: "complete" } });
  });

  test("a completed run keeps unanswered asks reachable, as parked loose ends", () => {
    const st = buildStatus({ ...base, state: { ...base.state, complete: true } });
    expect(st).toEqual({ run: { state: "complete" }, human: { current: 0, earlier: 1 } });
  });

  test("no block-count.json is 'no record', never 'not stuck'", () => {
    expect(buildStatus(withGuard(undefined)).stuck).toEqual({ state: "no-record" });
  });

  test("count 0 is clear", () => {
    expect(buildStatus(withGuard({ signature: "code-generation::40", count: 0 })).stuck).toEqual({
      state: "clear",
    });
  });

  test("a block recorded in a stage the run has left is not a current block", () => {
    const st = buildStatus(withGuard({ signature: "functional-design::12", count: 5 }));
    expect(st.stuck).toEqual({ state: "earlier-stage", stage: "functional-design" });
  });

  test("no sensor row for the current stage is 'none', not 'passed'", () => {
    const m: DashboardModel = {
      ...base,
      sensors: {
        ...base.sensors,
        stages: base.sensors.stages.filter((s) => s.stage !== base.state.currentStage),
      },
    };
    expect(buildStatus(m).checks).toEqual({ state: "none" });
  });

  test("a pending firing reads as in flight before its outcome", () => {
    expect(buildStatus(withSensorRow({ fired: 2, pending: 1 })).checks?.state).toBe("in-flight");
  });

  test("all firings passed", () => {
    const st = buildStatus(withSensorRow({ fired: 2, passed: 2, failed: 0, pending: 0 }));
    expect(st.checks).toEqual({ state: "passed", passed: 2 });
  });

  test("an open gate with no unanswered question is still something awaiting the human", () => {
    const m: DashboardModel = {
      ...base,
      blockers: [],
      timing: { ...base.timing, awaitingStage: "code-generation" },
    };
    const h = buildStatus(m).human;
    expect(h).toEqual({
      current: 0,
      oldestWaitingSec: undefined,
      awaitingGate: "code-generation",
      earlier: 0,
    });
  });
});

describe("status strip — markup", () => {
  test("leads the body, above the columns", () => {
    const body = renderBody(base, "ko");
    expect(body.trimStart().startsWith('<ul class="status-strip"')).toBe(true);
  });

  test("four chips while running — no combined verdict chip", () => {
    const html = renderStatus(base, strings("ko"));
    expect(html.match(/<li class="st-chip/g)?.length).toBe(4);
  });

  test("a completed run renders one chip", () => {
    const html = renderStatus(
      { ...base, blockers: [], state: { ...base.state, complete: true } },
      strings("ko"),
    );
    expect(html.match(/<li class="st-chip/g)?.length).toBe(1);
    expect(html).toContain("st-chip ok");
  });

  test("tones follow the readings, and missing sources are dashed rather than green", () => {
    const html = renderStatus(base, strings("ko"));
    expect(html).toContain("st-chip bad has-pop");
    expect(html).toContain("진행 없이 1회 연속 차단");
    const none = renderStatus(withGuard(undefined), strings("ko"));
    expect(none).toContain("st-chip mute");
    expect(none).not.toContain("✓ 막힘 없음");
  });

  test("the asks open under the awaiting chip, each linked to its file", () => {
    const html = renderStatus(base, strings("ko"));
    const b = base.blockers[0]!;
    expect(html).toContain('<div class="st-pop">');
    expect(html).toContain(`href="/view?rel=${encodeURIComponent(b.rel)}"`);
    expect(html).toContain(b.heading);
  });

  test("no asks, no popover — the chip is a plain reading", () => {
    const html = renderStatus({ ...base, blockers: [] }, strings("ko"));
    expect(html).not.toContain("st-pop");
    expect(html).toContain("✓ 답변 대기 없음");
  });

  test("the page no longer has a blocker card", () => {
    const body = renderBody(base, "ko");
    expect(body).not.toContain('id="blockers"');
    expect(body).not.toContain("🚧");
    // …but the one path to the file survives, under the strip.
    expect(body).toContain(`/view?rel=${encodeURIComponent(base.blockers[0]!.rel)}`);
  });

  test("an open popover survives the poll: the strip's details are keyed", () => {
    expect(renderBody(base, "ko")).toContain('<details data-key="s-0"');
  });

  test("English renders with no Hangul", () => {
    const html = renderStatus(base, strings("en"));
    expect(/[가-힣]/.test(html)).toBe(false);
    expect(html).toContain("Blocked 1× with no progress");
    expect(html).toContain("1 answer awaiting you");
  });
});
