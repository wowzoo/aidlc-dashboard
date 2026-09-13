/**
 * token-view 단위 테스트. 문자열 렌더러이므로 DOM 없이 출력 문자열만 검사한다.
 *
 * 이스케이프 검사가 핵심이다 — 모델명·경로·note 는 트랜스크립트에서 온 외부 텍스트이고,
 * 이 카드가 그것을 화면에 올리는 유일한 지점이다(Kiro 쪽 `warning.raw` 와 같은 위치).
 */

import { strings } from "../../render/i18n";

/** 테스트는 한국어 출력을 단정한다 — 기존 기대 문자열이 그대로 유효하다. */
const KO = strings("ko");
import { describe, expect, test } from "bun:test";
import type { TokenViewModel } from "./token-model";
import { renderTokens } from "./token-view";

function vm(over: Partial<TokenViewModel> = {}): TokenViewModel {
  return {
    status: "ok",
    totals: { input: 10, output: 100, cacheRead: 1000, cacheCreate: 50, thinking: 40 },
    grandTotal: 1160,
    cachedPromptRatio: 1000 / 1060,
    sessionTime: null,
    byModel: [
      {
        model: "claude-opus-5",
        totals: { input: 10, output: 100, cacheRead: 1000, cacheCreate: 50, thinking: 40 },
        messages: 1,
      },
    ],
    messages: 1,
    sidechainMessages: 0,
    sessions: 1,
    trend: {
      window: "30d",
      points: [{ ts: "2026-08-25T00:00:00", value: 1160, ok: true }],
      summary: { latest: 1160, min: 1160, max: 1160, count: 1 },
    },
    lastActivityAt: "2026-08-25T10:00:00Z",
    firstActivityAt: "2026-08-25T09:00:00Z",
    dir: "/home/.claude/projects/-ws",
    triedPath: "/home/.claude/projects/-ws",
    notes: [],
    ...over,
  };
}

describe("renderTokens", () => {
  test("토큰 5종과 세션·메시지를 표로 렌더한다", () => {
    const html = renderTokens(vm(), "30d", KO);
    expect(html).toContain("토큰 사용량");
    expect(html).toContain("총 토큰");
    expect(html).toContain("1,160");
    expect(html).toContain("캐시 읽기");
    // thinking 이 output 에 포함된 값이라는 사실을 라벨이 말해야 한다.
    expect(html).toContain("출력 내 포함");
  });

  test("캐시 적중률을 백분율로 내고, 분모를 tooltip 으로 밝힌다", () => {
    const html = renderTokens(vm(), "30d", KO);
    expect(html).toContain("프롬프트 캐시 적중");
    expect(html).toContain("94.3%");
    // 분모가 화면에 없으면 라벨 없는 비율이 된다.
    expect(html).toContain("캐시 읽기 ÷ (입력 + 캐시 읽기 + 캐시 생성)");
  });

  test("프롬프트 토큰이 없으면 적중률 칸은 — 이다", () => {
    const html = renderTokens(vm({ cachedPromptRatio: null }), "30d", KO);
    expect(html).toContain("프롬프트 캐시 적중");
    expect(html).not.toContain("94.3%");
  });

  test("영어 카탈로그도 같은 행을 낸다 — 한 쪽만 추가되는 실패 모드를 막는다", () => {
    const html = renderTokens(vm(), "30d", strings("en"));
    expect(html).toContain("prompt cache hit");
    expect(html).toContain("cache read ÷ (input + cache read + cache create)");
    expect(html).toContain("94.3%");
  });

  test("세션 시간이 없으면 그 블록을 아예 그리지 않는다", () => {
    const html = renderTokens(vm(), "30d", KO);
    expect(html).not.toContain("세션 벽시계");
  });

  test("세션 시간은 시간 단위 + API 비율로 렌더하고, 권위 없음을 화면이 말한다", () => {
    const html = renderTokens(
      vm({
        sessionTime: {
          sessions: 3,
          straddling: 0,
          totalSec: 7200,
          apiSec: 1800,
          toolSec: 600,
          apiRatio: 0.25,
        },
      }),
      "30d",
      KO,
    );
    expect(html).toContain("세션 벽시계");
    expect(html).toContain("2.0h");
    expect(html).toContain("25.0%");
    // 두 수치가 다를 때 독자가 어느 쪽을 믿을지 알아야 한다.
    expect(html).toContain("감사 원장이 권위 있는 값");
    expect(html).toContain("stage 에 귀속되지 않아");
    // 토큰 기준 `세션` 과 체크포인트 기준 세션 수는 다를 수 있다(실측 7 대 6). 두 숫자가 나란히
    // 서면 독자가 어느 쪽이 맞는지 묻게 되므로, 라벨과 문구가 그 차이를 직접 설명해야 한다.
    expect(html).toContain("체크포인트 있는 세션");
    expect(html).toContain("진행 중인 세션은 아직 남기지 않았을 수 있습니다");
  });

  test("걸친 세션은 담담하게 밝히고 warn 으로 칠하지 않는다", () => {
    const html = renderTokens(
      vm({
        sessionTime: {
          sessions: 1,
          straddling: 4,
          totalSec: 60,
          apiSec: 6,
          toolSec: 0,
          apiRatio: 0.1,
        },
      }),
      "30d",
      KO,
    );
    expect(html).toContain("세션 4개는 창 경계를 걸쳐");
    // note 는 있어도 note warn 은 아니다 — 정상 현상이라 경고색이면 과장이다.
    expect(html).toContain('<p class="note">세션 4개');
  });

  test("창에 온전히 든 세션이 없으면 숫자 없이 그 사실만 말한다", () => {
    const html = renderTokens(
      vm({
        sessionTime: {
          sessions: 0,
          straddling: 2,
          totalSec: 0,
          apiSec: 0,
          toolSec: 0,
          apiRatio: null,
        },
      }),
      "30d",
      KO,
    );
    expect(html).not.toContain("세션 벽시계");
    expect(html).toContain("온전히 든 세션이 없습니다");
  });

  test("영어 카탈로그도 세션 블록을 낸다", () => {
    const html = renderTokens(
      vm({
        sessionTime: {
          sessions: 2,
          straddling: 0,
          totalSec: 3600,
          apiSec: 900,
          toolSec: 0,
          apiRatio: 0.25,
        },
      }),
      "30d",
      strings("en"),
    );
    expect(html).toContain("session wall clock");
    expect(html).toContain("audit ledger is authoritative");
  });

  test("모델별 분해 표와 비중을 렌더한다", () => {
    const html = renderTokens(vm(), "30d", KO);
    expect(html).toContain("claude-opus-5");
    expect(html).toContain("100.0%");
  });

  test("적대적 모델명을 이스케이프한다", () => {
    const html = renderTokens(
      vm({
        byModel: [
          {
            model: '<script>alert("x")</script>',
            totals: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0, thinking: 0 },
            messages: 1,
          },
        ],
      }),
      "30d",
      KO,
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  test("적대적 note(경로) 도 이스케이프한다", () => {
    // note 는 이제 코드 + 사실이라, 이스케이프해야 할 외부 문자열은 `triedPath` 뿐이다.
    const html = renderTokens(
      vm({ notes: [{ code: "no-transcripts", triedPath: '<img src=x onerror="alert(1)">' }] }),
      "30d",
      KO,
    );
    expect(html).not.toContain("<img src=x");
  });

  test("데이터 없음 상태는 배지와 안내를 낸다 — 표는 그리지 않는다", () => {
    const html = renderTokens(
      vm({ status: "none", messages: 0, byModel: [], grandTotal: 0 }),
      "7d",
      KO,
    );
    expect(html).toContain("데이터 없음");
    expect(html).not.toContain("총 토큰");
  });

  test("부분 집계는 배지로 드러난다", () => {
    expect(renderTokens(vm({ status: "partial" }), "30d", KO)).toContain("부분 집계");
  });

  test("상한에 걸려 수치가 0 일 때 '사용량 없음' 안내를 띄우지 않는다", () => {
    // 이 안내는 "기간을 넓혀 보세요" 라고 조언하는데, 상한에 걸린 상태에서는 기간을 넓히면
    // 상황이 나빠진다. 그래서 partial 에는 나오면 안 된다.
    const html = renderTokens(
      vm({
        status: "partial",
        messages: 0,
        byModel: [],
        grandTotal: 0,
        notes: [{ code: "files-capped", count: 1 }],
      }),
      "30d",
      KO,
    );
    expect(html).not.toContain("기간을 넓혀 보세요");
    expect(html).toContain("과소 집계");
  });

  test("창 토글은 현재 창만 aria-checked 로 표시한다", () => {
    const html = renderTokens(vm(), "7d", KO);
    expect(html).toContain('aria-checked="true" href="?cw=7d"');
    expect(html).toContain('aria-checked="false" href="?cw=30d"');
  });

  test("차트 접근성 라벨은 토큰 문구를 쓴다 (누적 사용량 문구 재사용 금지)", () => {
    const html = renderTokens(vm(), "30d", KO);
    expect(html).toContain("일별 토큰 추이");
    expect(html).not.toContain("누적 사용량 추이");
  });

  test("서브에이전트 응답이 있으면 합계 포함 사실을 밝힌다", () => {
    expect(renderTokens(vm({ sidechainMessages: 4 }), "30d", KO)).toContain("서브에이전트 응답 4");
  });
});
