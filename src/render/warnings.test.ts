// `warningText` — the copy that used to live inside `assemble`.
//
// The point of this file is that step two changed NO user-visible text. Every expected
// string below is the literal `assemble` built before the restructure (taken from
// `git show HEAD:src/model/assemble.ts`), so a byte of drift fails here rather than
// quietly on somebody's screen.

import { describe, expect, test } from "bun:test";
import type { Warning } from "../model/types";
import { warningText } from "./warnings";

describe("warningText reproduces the pre-restructure copy exactly", () => {
  test("catalogue: the named-harness and discovery-failed branches stay distinct", () => {
    expect(warningText({ code: "catalog-read-failed", harnessDir: ".kiro" })).toBe(
      ".kiro/tools/data/stage-graph.json 읽기 실패 — 산출물 계약 판정과 stage 귀속이 근사값으로 하락",
    );
    expect(warningText({ code: "catalog-not-found" })).toBe(
      "stage 카탈로그 미검출 (<root>/<harness>/tools/data/stage-graph.json, .kiro·.claude·.aidlc 등 탐색) — " +
        "산출물 계약 판정과 stage 귀속이 근사값으로 하락. harness 트리가 다른 곳에 있으면 --harness 로 지정할 것",
    );
  });

  test("audit-empty", () => {
    expect(warningText({ code: "audit-empty" })).toBe("감사 기록 비어 있음 — hook 미발화 가능성");
  });

  test("state-version-mismatch names both generations and the file it read", () => {
    expect(
      warningText({
        code: "state-version-mismatch",
        stateVersion: "7",
        harnessVersion: "9",
        harnessDir: ".kiro",
      }),
    ).toBe(
      "state.md 은 State Version 7, harness 는 9 을 지원합니다 (.kiro/tools/aidlc-lib.ts) — 엔진은 이 조합에서 next·report·doctor 를 모두 거부합니다. 다른 세대의 계약으로 판정할 수 없어 산출물 계약 판정을 내렸습니다",
    );
  });

  test("state-version-unreadable distinguishes a missing field from a bad value", () => {
    const tail =
      " — 엔진은 누락·빈 값·비수치를 모두 거부합니다(aidlc-lib.ts classifyStateVersion). 산출물 계약은 그대로 보여주지만 엔진과 동일한 완료 판정이라고 주장하지 않습니다";
    expect(warningText({ code: "state-version-unreadable" })).toBe(
      `state.md 의 State Version 을 읽을 수 없습니다 (필드 없음)${tail}`,
    );
    expect(warningText({ code: "state-version-unreadable", stateVersion: "v8" })).toBe(
      `state.md 의 State Version 을 읽을 수 없습니다 (값: v8)${tail}`,
    );
  });

  test("team-without-unit-major, with and without the field", () => {
    const tail =
      " — 엔진 계약은 이 둘을 함께 요구하고, 그때만 Unit Progress 표가 존재합니다. 설정을 확인할 것";
    expect(
      warningText({ code: "team-without-unit-major", constructionIteration: "stage-major" }),
    ).toBe(
      `Unit Ownership 은 team 인데 Construction Iteration 이 unit-major 가 아닙니다 (stage-major)${tail}`,
    );
    expect(warningText({ code: "team-without-unit-major" })).toBe(
      `Unit Ownership 은 team 인데 Construction Iteration 이 unit-major 가 아닙니다 (없음)${tail}`,
    );
  });

  test("the two Unit Progress warnings", () => {
    expect(warningText({ code: "unit-progress-malformed" })).toBe(
      "state.md 의 `## Unit Progress` 표를 엔진이 정한 모양으로 읽지 못했습니다 (표가 줄 맨 앞에서 시작하지 않거나, 첫 열이 `unit` 이 아니거나, 구분선 폭이 헤더와 다름 — 엔진도 같은 조건에서 거부합니다). owner·유닛 게이트를 표시하지 않습니다",
    );
    expect(warningText({ code: "unit-progress-missing" })).toBe(
      "team / unit-major 실행인데 state.md 에 `## Unit Progress` 절이 없습니다 — owner·유닛 게이트의 권위 있는 원천이 없어 아래 매트릭스는 디스크와 감사 기록으로 재구성한 값입니다",
    );
  });

  test("roster-mismatch: all four combinations of version and direction", () => {
    const note =
      "산출물 계약 판정을 신뢰할 수 없어 근사값으로 내렸습니다 (엔진도 이 조합을 거부합니다: aidlc-lib.ts classifyStateVersion)";
    expect(
      warningText({
        code: "roster-mismatch",
        stateVersion: "7",
        unknownToCatalog: ["application-design"],
        missingFromState: [],
      }),
    ).toBe(
      `state.md 과 stage 카탈로그의 stage 목록이 어긋납니다 (State Version: 7) · 카탈로그가 모르는 stage: application-design. ${note}`,
    );
    expect(
      warningText({
        code: "roster-mismatch",
        unknownToCatalog: [],
        missingFromState: ["contract-design"],
      }),
    ).toBe(
      `state.md 과 stage 카탈로그의 stage 목록이 어긋납니다 (State Version 없음) · state 에 행이 없는 stage: contract-design (엔진은 SKIP 도 한 행씩 씁니다). ${note}`,
    );
    // Both directions at once, and each list joined with ", ".
    expect(
      warningText({
        code: "roster-mismatch",
        stateVersion: "8",
        unknownToCatalog: ["a", "b"],
        missingFromState: ["c"],
      }),
    ).toBe(
      `state.md 과 stage 카탈로그의 stage 목록이 어긋납니다 (State Version: 8) · 카탈로그가 모르는 stage: a, b · state 에 행이 없는 stage: c (엔진은 SKIP 도 한 행씩 씁니다). ${note}`,
    );
  });

  test("harness-coexist names the other flag, not the chosen one", () => {
    expect(
      warningText({ code: "harness-coexist", harnesses: [".claude", ".kiro"], chosen: "claude" }),
    ).toBe(
      "harness 디렉터리 .claude·.kiro 가 공존 — 사용량 패널을 Claude Code 토큰으로 자동 선택했습니다. 다른 쪽을 보려면 --usage kiro 를 지정하세요.",
    );
    expect(
      warningText({ code: "harness-coexist", harnesses: [".kiro", ".claude"], chosen: "kiro" }),
    ).toBe(
      "harness 디렉터리 .kiro·.claude 가 공존 — 사용량 패널을 Kiro 크레딧으로 자동 선택했습니다. 다른 쪽을 보려면 --usage claude 를 지정하세요.",
    );
  });

  test("the two usage-assembly failures carry the thrown message", () => {
    expect(warningText({ code: "token-usage-failed", detail: "boom" })).toBe(
      "토큰 사용량 조립 실패 — 사용량 패널만 하락: boom",
    );
    expect(warningText({ code: "credit-assembly-failed", detail: "store boom" })).toBe(
      "크레딧 조립 실패 — 크레딧 패널만 하락: store boom",
    );
  });
});

describe("every code has copy", () => {
  // A Record keyed by the union's codes: TypeScript fails this file if a Warning member
  // is added without a sample here, which pairs with the `never` guard in warnings.ts —
  // the switch cannot omit a case and this map cannot omit a code.
  const SAMPLES: Record<Warning["code"], Warning> = {
    "catalog-read-failed": { code: "catalog-read-failed", harnessDir: ".kiro" },
    "catalog-not-found": { code: "catalog-not-found" },
    "audit-empty": { code: "audit-empty" },
    "state-version-mismatch": {
      code: "state-version-mismatch",
      stateVersion: "7",
      harnessVersion: "8",
      harnessDir: ".kiro",
    },
    "state-version-unreadable": { code: "state-version-unreadable" },
    "team-without-unit-major": { code: "team-without-unit-major" },
    "unit-progress-malformed": { code: "unit-progress-malformed" },
    "unit-progress-missing": { code: "unit-progress-missing" },
    "roster-mismatch": { code: "roster-mismatch", unknownToCatalog: [], missingFromState: [] },
    "harness-coexist": { code: "harness-coexist", harnesses: [".kiro"], chosen: "kiro" },
    "token-usage-failed": { code: "token-usage-failed", detail: "x" },
    "credit-assembly-failed": { code: "credit-assembly-failed", detail: "x" },
  };

  test("no code renders empty, and no optional field leaks as 'undefined'", () => {
    for (const [code, sample] of Object.entries(SAMPLES)) {
      const text = warningText(sample);
      expect(text.length).toBeGreaterThan(10);
      // An optional param interpolated without a fallback is the failure mode this
      // catches: `(undefined)` on screen instead of `(없음)`.
      expect(text).not.toContain("undefined");
      expect(code).toBe(sample.code);
    }
  });
});
