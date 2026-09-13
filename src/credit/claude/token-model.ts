/**
 * ClaudeTokenModel — 트랜스크립트 집계를 표시용 뷰모델 `TokenViewModel`로 조립한다.
 *
 * Kiro 경로의 `assembleCredit`(u3)과 같은 자리를 차지하되, 신선도 개념이 다르다.
 *
 * Kiro는 원격 `/usage`를 폴링하므로 "마지막 성공이 10분 넘게 지났으면 stale"이 성립한다.
 * 반면 이 경로는 assemble마다 로컬 파일을 다시 읽으므로 **표시값이 구조적으로 항상
 * 최신**이다(host provenance의 `disk`가 정의상 fresh인 것과 같다). 마지막 활동이 오래됐다는
 * 것은 데이터가 낡았다는 뜻이 아니라 그동안 Claude Code를 쓰지 않았다는 사실이므로,
 * stale 배지 대신 `lastActivityAt`을 그대로 보여준다. 의미 없는 경고로 배지를 마비시키지
 * 않는다는 host 규율(freshness.ts의 state.md 판단과 동일한 논리)을 따른다.
 *
 * 순수 함수 — 파일 읽기는 transcript-reader가 하고, 이 모듈은 집계를 뷰모델로 옮긴다.
 */

import type { TrendSeries, TrendWindow } from "../trend/trend";
import {
  type ModelBreakdown,
  type SessionTimeAggregate,
  type TokenTotals,
  type TranscriptAggregate,
  totalOf,
} from "./transcript-reader";

/** 표시 상태. `partial`은 집계가 불완전하다는 뜻이다(상한·손상 줄·읽기 실패). */
export type TokenStatus = "none" | "partial" | "ok";

/** 세션 시간 분해(표시용). 시간 단위는 뷰가 포맷하므로 여기서는 초로 싣는다. */
export interface SessionTimeView {
  sessions: number;
  /**
   * 창 경계를 걸쳐 제외한 세션 수.
   *
   * `TokenNote` 로 싣지 않는 이유가 있다 — 노트는 "집계가 불완전하다"는 결함 신호이고 `warn`
   * 색으로 렌더된다. 세션이 창을 걸치는 것은 결함이 아니라 며칠씩 이어지는 세션의 정상 모습이라
   * (실측 7d 창에서 12건), 경고로 칠하면 과장이 된다. 그래서 이 블록 자신의 값으로 두고 블록
   * 안에서 담담하게 밝힌다. `status: partial` 도 이것 때문에는 켜지지 않는다.
   */
  straddling: number;
  totalSec: number;
  apiSec: number;
  toolSec: number;
  /**
   * API 시간 / 세션 벽시계(0~1). 분모가 0이면 null.
   *
   * 실측 분위: p10 0.004 · p50 0.141 · p90 0.541 — 즉 중앙값 세션은 86%가 API 밖이다. 이 값이
   * 이 블록의 요점이고, 타이밍 패널이 감사 원장에서 내는 관측/대기 분할과 대조할 수 있는 유일한
   * 독립 수치다.
   */
  apiRatio: number | null;
}

/** Claude Code 토큰 사용량 뷰모델. Kiro의 `CreditViewModel`과 대응하는 자리를 채운다. */
export interface TokenViewModel {
  status: TokenStatus;
  totals: TokenTotals;
  /** 토큰 총량(= input + output + cacheRead + cacheCreate). thinking은 output에 포함. */
  grandTotal: number;
  /**
   * 프롬프트 토큰 중 캐시에서 읽어 온 비율(0~1). 분모가 0이면 null.
   *
   * **실측값끼리의 비**라서 이 패널에 놓일 수 있다. 없는 한도로 사용률을 만들지 않는다는
   * 규율(모듈 머리주석의 게이지 얘기)이 금지하는 것은 분모가 측정되지 않은 비율이고,
   * 여기 분자·분모는 둘 다 트랜스크립트에서 읽은 수다.
   */
  cachedPromptRatio: number | null;
  /**
   * 세션 시간 분해. `cost-state` 레코드가 없으면 null 이고, 그때 패널은 이 블록을 그리지 않는다.
   *
   * **교차 검증용이며 권위가 없다.** 타이밍 패널은 같은 질문("얼마나 일하고 얼마나 기다렸나")에
   * 감사 원장으로 답하고, 이쪽은 완전히 독립된 소스로 답한다 — `runtime-graph` 를 감사 대비
   * 대조로만 쓰는 것과 같은 자리다. 세션은 stage·unit 에 귀속되지 않으므로 전체 수준 대조까지만
   * 가능하고, 화면도 그렇게 말한다.
   */
  sessionTime: SessionTimeView | null;
  byModel: ModelBreakdown[];
  messages: number;
  sidechainMessages: number;
  sessions: number;
  /** 일별 토큰 총량 시계열. host `renderLineChart`가 그대로 소비한다. */
  trend: TrendSeries;
  /** 마지막 메시지 시각(ISO). 활동이 없으면 null. */
  lastActivityAt: string | null;
  /** 창 내 첫 메시지 시각(ISO). */
  firstActivityAt: string | null;
  /** 읽은 트랜스크립트 디렉터리. 못 찾으면 null. */
  dir: string | null;
  /** 디렉터리를 못 찾았을 때 시도한 경로 — 화면에서 무엇을 찾았는지 밝힌다. */
  triedPath: string;
  /** 집계가 불완전한 사유. 비어 있지 않으면 화면에 그대로 표시한다. */
  /**
   * 화면에 뜨는 주의 문구를 **코드로** 싣는다(문장은 `render/i18n` 소관).
   *
   * `model.warnings` 와 같은 이유다 — 모델 계층이 한국어 문단을 만들면 언어를 하나 더
   * 붙일 수 없고, `/api/model` 도 산문을 실어 나른다. 여기 숫자는 사실이므로 코드에 함께 싣고,
   * 자릿수 구분은 뷰가 로케일로 포맷한다.
   */
  notes: TokenNote[];
}

/** 일별 집계를 host 차트가 소비하는 TrendSeries로 변환한다. */
function toTrend(daily: { date: string; total: number }[], window: TrendWindow): TrendSeries {
  const points = daily.map((d) => ({
    // 로컬 자정 기준. 차트는 x축에 Date.parse 결과만 쓰므로 하루 단위 등간격이 유지된다.
    ts: `${d.date}T00:00:00`,
    value: d.total,
    ok: true,
  }));
  const values = daily.map((d) => d.total);
  return {
    window,
    points,
    summary: {
      latest: values.length > 0 ? (values[values.length - 1] ?? null) : null,
      min: values.length > 0 ? Math.min(...values) : null,
      max: values.length > 0 ? Math.max(...values) : null,
      count: values.length,
    },
  };
}

/**
 * 프롬프트 토큰 중 캐시에서 읽어 온 비율. 분모가 0이면 null.
 *
 * **분모는 프롬프트 측 세 버킷 전부다.** 트랜스크립트가 싣는 세 필드가 모두 `*_input_tokens`
 * 계열이기 때문이다 — `input_tokens`(캐시를 타지 않은 입력), `cache_read_input_tokens`(캐시에서
 * 읽은 입력), `cache_creation_input_tokens`(처리하면서 캐시에 써 둔 입력). `totalOf()` 도 이 셋을
 * 그대로 더한다.
 *
 * `cacheCreate` 를 분모에서 빼면 **캐시를 크게 새로 만든 창에서도 100% 가 나온다** — 캐시를
 * 채우는 데 든 프롬프트가 셈에서 사라지므로, 이 값이 답하기로 한 질문("프롬프트 중 얼마를
 * 캐시로 때웠나")과 어긋난다. `output` 은 프롬프트가 아니므로 분모에 없다.
 */
function cachedPromptRatioOf(t: TokenTotals): number | null {
  const prompt = t.input + t.cacheRead + t.cacheCreate;
  return prompt > 0 ? t.cacheRead / prompt : null;
}

/** 리더 집계 → 표시용. 레코드가 없었으면(절반의 프로젝트가 그렇다) null 을 그대로 넘긴다. */
function sessionTimeOf(agg: SessionTimeAggregate | null): SessionTimeView | null {
  if (agg === null) return null;
  const totalSec = agg.totalMs / 1000;
  return {
    sessions: agg.sessions,
    straddling: agg.straddling,
    totalSec,
    apiSec: agg.apiMs / 1000,
    toolSec: agg.toolMs / 1000,
    apiRatio: agg.totalMs > 0 ? agg.apiMs / agg.totalMs : null,
  };
}

/**
 * 집계가 불완전하다는 주의 문구 — 코드와 그 사실만. 문장은 `render/i18n` 이 갖는다.
 * 닫힌 유니온이라 `token-view` 의 switch 가 빠짐없이 다루도록 타입이 강제한다.
 */
export type TokenNote =
  | { code: "no-transcripts"; triedPath: string }
  | { code: "files-capped"; count: number }
  | { code: "unreadable-files"; count: number }
  | { code: "malformed-lines"; count: number };

/**
 * 집계 → 뷰모델. 상태 판정은 `none`(데이터 없음) → `partial`(불완전) → `ok` 순이다.
 *
 * @param agg    transcript-reader 산출 집계.
 * @param window 현재 창(창 토글 표시용).
 */
export function assembleTokens(agg: TranscriptAggregate, window: TrendWindow): TokenViewModel {
  const notes: TokenNote[] = [];

  if (agg.dir === null) {
    notes.push({ code: "no-transcripts", triedPath: agg.triedPath });
  }
  if (agg.filesCapped > 0) {
    notes.push({ code: "files-capped", count: agg.filesCapped });
  }
  if (agg.unreadableFiles > 0) {
    notes.push({ code: "unreadable-files", count: agg.unreadableFiles });
  }
  if (agg.malformedLines > 0) {
    notes.push({ code: "malformed-lines", count: agg.malformedLines });
  }

  const incomplete = agg.filesCapped > 0 || agg.unreadableFiles > 0 || agg.malformedLines > 0;
  // `none` 은 **정말로 사용량이 없을 때만**이다. 집계가 불완전하면 메시지 0 이어도 `partial`이다 —
  // 단일 파일이 상한을 넘으면 filesRead 0·messages 0 이 되는데, 그때 `none` 을 내면 화면이
  // "이 기간에 사용량이 없습니다. 기간을 넓혀 보세요" 를 띄운다. 사용량은 있고, 기간을 넓히면
  // 상한에 더 걸린다. 조용한 절단 금지 규율이 여기서 깨지는 자리였다.
  const status: TokenStatus =
    agg.messages === 0 && !incomplete ? "none" : incomplete ? "partial" : "ok";

  return {
    status,
    totals: agg.totals,
    grandTotal: totalOf(agg.totals),
    cachedPromptRatio: cachedPromptRatioOf(agg.totals),
    sessionTime: sessionTimeOf(agg.sessionTime),
    byModel: agg.byModel,
    messages: agg.messages,
    sidechainMessages: agg.sidechainMessages,
    sessions: agg.sessions,
    trend: toTrend(agg.daily, window),
    lastActivityAt: agg.lastAt,
    firstActivityAt: agg.firstAt,
    dir: agg.dir,
    triedPath: agg.triedPath,
    notes,
  };
}
