// The status readings (model/status.ts) and their two renderings: the run line at the
// top of the body and the Run Health card (render/status.ts). The fixture gives one
// real reading of every signal; the variants are built by overriding one field of that
// model, so each test changes exactly the thing it names.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { buildStatus } from "../model/status";
import type { DashboardModel } from "../model/types";
import { strings } from "../render/i18n";
import { renderBody } from "../render/page";
import { renderRunHealth, renderRunLine } from "../render/status";

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

describe("status — readings", () => {
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

  test("a 2.10 three-part signature still names the current stage", () => {
    // 2.10 writes `<stage>::<state sha256>::<directive fingerprint>`. Cutting at the
    // LAST `::` read the stage as `<stage>::<sha>`, so a current block drew as a
    // green "cleared in an earlier stage".
    const signature = `${base.state.currentStage}::${"a".repeat(64)}::${"b".repeat(64)}`;
    expect(buildStatus(withGuard({ signature, count: 3 })).stuck).toEqual({
      state: "blocked",
      count: 3,
      stage: base.state.currentStage,
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

describe("run line — markup", () => {
  test("leads the body", () => {
    expect(renderBody(base, "ko").trimStart().startsWith('<div class="runline"')).toBe(true);
  });

  test("names the phase, the stage and the age of the last audit event", () => {
    const html = renderRunLine(base, strings("ko"));
    expect(html).toContain("▶ 진행 중");
    expect(html).toContain("Code Generation");
    expect(html).toContain("마지막 기록");
  });

  test("a completed run says so, with no running dot", () => {
    const html = renderRunLine(
      { ...base, state: { ...base.state, complete: true } },
      strings("ko"),
    );
    expect(html).toContain("rl-dot ok");
    expect(html).not.toContain("rl-dot run");
  });
});

describe("Run Health card — markup", () => {
  const ko = strings("ko");
  const tabsOf = (html: string) => html.match(/<label for="mc-health-\d+">/g)?.length ?? 0;
  const checked = (html: string) => /id="mc-health-(\d+)" value="\d+" checked/.exec(html)?.[1];

  test("three tabs while running — answers, stuck, failed checks — and no combined verdict", () => {
    const html = renderRunHealth(base, ko);
    expect(tabsOf(html)).toBe(3);
    expect(html).toContain(">Run Health</h2>");
    expect(html).toContain("내 답변");
    expect(html).toContain("막힘");
    expect(html).toContain("검사 실패");
  });

  test("tab counts carry the signal: coloured when actionable", () => {
    const html = renderRunHealth(base, ko);
    // One ask waiting, one block, one failure — all three actionable.
    expect(html).toContain('<b class="mc-n warn">1</b>');
    expect(html).toContain('<b class="mc-n bad">1</b>');
  });

  test("opens on the first tab that has a problem", () => {
    expect(checked(renderRunHealth(base, ko))).toBe("0");
    // No asks → the next problem is the block.
    expect(checked(renderRunHealth({ ...base, blockers: [] }, ko))).toBe("1");
    // No asks, no block → the failed check.
    const noBlock = withGuard({ signature: "code-generation::40", count: 0 });
    expect(checked(renderRunHealth({ ...noBlock, blockers: [] }, ko))).toBe("2");
  });

  test("a missing source is a muted dash and a dashed row, never green", () => {
    const html = renderRunHealth(withGuard(undefined), ko);
    expect(html).toContain('<b class="mc-n mute">–</b>');
    expect(html).toContain('class="mr dashed"');
    expect(html).toContain("차단 기록 없음");
    expect(html).not.toContain("✓ 막힘 없음");
  });

  test("each ask links to its file", () => {
    const html = renderRunHealth(base, ko);
    const b = base.blockers[0]!;
    expect(html).toContain(`href="/view?rel=${encodeURIComponent(b.rel)}"`);
    expect(html).toContain(b.heading);
  });

  test("an open gate with no question still counts as something awaiting you", () => {
    const m: DashboardModel = {
      ...base,
      blockers: [],
      timing: { ...base.timing, awaitingStage: "code-generation" },
    };
    const html = renderRunHealth(m, ko);
    expect(html).toContain("승인 대기 code-generation");
    expect(html).toContain('<b class="mc-n warn">1</b>');
  });

  test("an open gate on the stage whose ask is waiting counts once, not twice", () => {
    const m: DashboardModel = {
      ...base,
      timing: { ...base.timing, awaitingStage: base.state.currentStage },
    };
    expect(base.blockers.filter((b) => b.isCurrentStage).length).toBe(1);
    const html = renderRunHealth(m, ko);
    expect(html).toContain('<b class="mc-n warn">1</b>');
    expect(html).not.toContain('<b class="mc-n warn">2</b>');
  });

  test("every ask is listed — none folded behind a '+N more' with nowhere to go", () => {
    const b = base.blockers[0]!;
    const blockers = Array.from({ length: 8 }, (_, i) => ({ ...b, rel: `${b.rel}-${i}` }));
    const html = renderRunHealth({ ...base, blockers }, ko);
    for (const x of blockers) expect(html).toContain(`/view?rel=${encodeURIComponent(x.rel)}`);
    expect(html).not.toContain(ko.cards.moreRows(2));
  });

  test("a completed run renders every ask as parked, even one in the last named stage", () => {
    expect(base.blockers[0]!.isCurrentStage).toBe(true);
    const html = renderRunHealth({ ...base, state: { ...base.state, complete: true } }, ko);
    expect(html).toContain(ko.blockers.staleStage);
    expect(html).not.toContain("t-warn");
  });

  test("a completed run collapses to one summary tab and keeps parked asks reachable", () => {
    const html = renderRunHealth({ ...base, state: { ...base.state, complete: true } }, ko);
    expect(tabsOf(html)).toBe(1);
    expect(html).toContain("✓ 완료");
    expect(html).toContain(`/view?rel=${encodeURIComponent(base.blockers[0]!.rel)}`);
  });

  test("the page has no blocker card and no status strip", () => {
    const body = renderBody(base, "ko");
    expect(body).not.toContain('id="blockers"');
    expect(body).not.toContain("status-strip");
  });

  test("English renders with no Hangul", () => {
    const html = renderRunHealth(base, strings("en")) + renderRunLine(base, strings("en"));
    expect(/[가-힣]/.test(html)).toBe(false);
    expect(html).toContain("Blocked 1× with no progress");
    expect(html).toContain("Your answers");
  });
});
