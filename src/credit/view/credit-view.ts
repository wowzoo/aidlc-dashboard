/**
 * CreditView — `CreditViewModel`을 host 룩앤필의 서버사이드 HTML 문자열로 렌더한다(BR2.x·
 * BR3.2·BR4.1·NFR1.1·NFR1.2·NFR7).
 *
 * 기존 credit-dashboard `src/ui/app.ts`의 클라이언트 fetch(`/api/current`·`/api/trend`) +
 * DOM 조작 렌더를 **서버사이드 문자열 렌더**로 전환한 것이다. 신규 JSON 엔드포인트를 두지
 * 않고, 추이 창 전환은 `?cw=7d|30d|all` 링크(radiogroup)로 서버 재렌더한다.
 *
 * 이스케이프 규율: HTML 컨텍스트 외부 텍스트는 host `esc()`(`../../render/common`), SVG
 * 컨텍스트는 `escapeXml`(svg-chart). 비계약 외부 텍스트(`planName`·`warning.raw`·`reason`)를
 * 반드시 이스케이프한다. 결측은 `"—"`로 치환해 `undefined`/`NaN`/`[object Object]` 누출을 막는다.
 * 읽기 전용: 저장·쓰기 부수효과 없음(NFR1.4).
 */

import { bar, esc, pill, section, shortTs } from "../../render/common";
import type { Strings } from "../../render/i18n";
import type { PollHalt } from "../pipeline/polling-scheduler";
import type { TrendWindow } from "../trend/trend";
import type { ParsedUsage } from "../types";
import type { CreditStatus, CreditViewModel } from "./credit-model";
import { buildAriaLabel, renderGauge, renderLineChart } from "./svg-chart";

/** 문구는 카탈로그(`render/i18n`) 소관 — 여기는 창 순서와 톤만 정한다. */
function windowLabel(w: TrendWindow, s: Strings): string {
  return w === "7d"
    ? s.usage.windowLong7d
    : w === "30d"
      ? s.usage.windowLong30d
      : s.usage.windowLongAll;
}

/** 창 토글 라디오 정의(표시 순서). */
const WINDOW_ORDER: readonly TrendWindow[] = ["7d", "30d", "all"];

function windowChipLabel(w: TrendWindow, s: Strings): string {
  return w === "7d" ? s.usage.window7d : w === "30d" ? s.usage.window30d : s.usage.windowAll;
}

/** 상태별 배지. host `pill()` 재사용. */
function statusPill(status: CreditStatus, s: Strings): string {
  const t = s.usage;
  if (status === "loading") return pill(t.statusLoading, "mute");
  if (status === "ok") return pill(t.statusOk, "ok");
  if (status === "partial") return pill(t.statusPartial, "warn");
  if (status === "failure") return pill(t.statusFailure, "bad");
  return pill(t.statusNone, "mute");
}

/** 숫자 포맷(결측·NaN 은 em dash). */
function fmtNumber(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

/** 사용률 포맷(0~1 비율 → %). 결측·NaN 은 em dash. */
function fmtRatio(r: number | null): string {
  if (r === null || Number.isNaN(r)) return "—";
  return `${(r * 100).toFixed(1)}%`;
}

/**
 * `?cw` 쿼리값을 허용 창으로 무해화한다(NFR1.3). `7d`/`30d`/`all` 만 수용하고 무효·주입·
 * 부재는 `30d` 로 폴백한다.
 */
export function resolveWindow(cw: string | null | undefined): TrendWindow {
  if (cw === "7d" || cw === "30d" || cw === "all") return cw;
  return "30d";
}

/**
 * 현재 지표 5종을 표로 렌더한다. 결측은 "—". 외부 텍스트(planName)는 esc.
 *
 * `resetDate`는 파싱은 하되 표에 싣지 않는다 — 화면에서 뺀 필드이므로 `ParsedUsage`·저장·추이
 * 에는 그대로 남아 있다.
 */
function metricsTable(current: ParsedUsage, s: Strings): string {
  const t = s.usage;
  const rows: [string, string][] = [
    [t.rowPlan, esc(current.planName ?? "—")],
    [t.rowUsed, fmtNumber(current.usedAmount)],
    [t.rowRemaining, fmtNumber(current.remainingAmount)],
    [t.rowLimit, fmtNumber(current.planLimit)],
    [t.rowRatio, fmtRatio(current.usageRatio)],
  ];
  const body = rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td class="g-n">${v}</td></tr>`)
    .join("");
  return `<table class="tbl"><tbody>${body}</tbody></table>`;
}

/** 사용률 진행 막대 + 접근성 progressbar. 계산 불가(null)는 빈 트랙 + 안내. */
function progressBlock(ratio: number | null, s: Strings): string {
  const pct = ratio === null ? null : Math.max(0, Math.min(100, ratio * 100));
  const label = ratio === null ? s.usage.ratioUnavailable : s.usage.ratioLabel(fmtRatio(ratio));
  const valueNow = pct === null ? "" : ` aria-valuenow="${pct.toFixed(1)}"`;
  return `<div class="credit-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"${valueNow} aria-label="${esc(label)}">
  ${bar(pct)}
  <p class="note">${esc(label)}</p>
</div>`;
}

/** 실패 경고 배너(role=alert). 사유·원문 모두 esc. */
function warningBanner(warning: { raw: string; reason: string }, s: Strings): string {
  const t = s.usage;
  return `<div class="warnbox" role="alert">
  ${esc(t.fetchFailed(warning.reason))}
  <details><summary>${esc(t.rawSummary)}</summary><pre>${esc(
    warning.raw || t.rawEmpty,
  )}</pre></details>
</div>`;
}

/**
 * 자동 수집 중단 고지.
 *
 * `warningBanner` 와 **별개 사실**이라 별도 블록이다 — 배너는 "마지막 시도가 실패했다"이고
 * 이쪽은 "그래서 더 시도하지 않는다"다. 합치면 독자가 화면의 숫자를 아직 갱신되는 값으로 읽고,
 * 실제로는 영원히 그대로다.
 */
function haltNotice(halt: PollHalt, s: Strings): string {
  const t = s.usage;
  // 분 **숫자만** 넘긴다 — 단위를 붙이는 것은 카탈로그 소관이다(렌더 모듈의 한국어 리터럴은
  // `### Page language` 가 막으려는 바로 그 결함이다).
  const retryEvery = String(Math.max(1, Math.round(halt.retryEveryMs / 60_000)));
  return `<div class="warnbox" role="status">
  ${esc(t.pollHalted(String(halt.failures), retryEvery))}
  ${halt.lastReason === undefined ? "" : `<div class="note">${esc(t.pollHaltedReason(halt.lastReason))}</div>`}
</div>`;
}

/**
 * 추이 창 토글(radiogroup). 현재 창만 aria-checked="true". `?cw=` 링크로 서버 재렌더.
 *
 * 칩 모양은 `.window-toggle a` CSS가 전담한다 — 예전에 붙어 있던 `pickbtn` 클래스는
 * `header.top nav` 스코프라 이 자리에서는 아무 스타일도 주지 않았고, 그래서 세 창이
 * 맨 링크 세 개로 붙어 "7월 30일"처럼 읽혔다.
 */
function windowToggle(current: TrendWindow, s: Strings): string {
  const radios = WINDOW_ORDER.map(
    (w) =>
      `<a role="radio" aria-checked="${w === current ? "true" : "false"}" href="?cw=${w}">${esc(
        windowChipLabel(w, s),
      )}</a>`,
  ).join("");
  return `<div class="window-toggle" role="radiogroup" aria-label="${esc(
    s.usage.trendToggleLabel,
  )}">${radios}</div>`;
}

/** 추이 패널: 창 토글 + 라인차트(SVG) + 텍스트 요약(접근성 병기). */
function trendPanel(model: CreditViewModel, window: TrendWindow, s: Strings): string {
  const chart = renderLineChart(model.trend, s);
  const summaryText = buildAriaLabel(model.trend, windowLabel(model.trend.window, s), s);
  return `<div class="credit-trend">
  ${windowToggle(window, s)}
  <div class="credit-chart">${chart}</div>
  <p class="note">${esc(summaryText)}</p>
</div>`;
}

/**
 * 크레딧 뷰를 host 룩앤필 HTML 문자열로 렌더한다. host `section()` 카드로 감싼다.
 * 최상단 배치(병목 패널 치환)는 u4가 host 페이지에 배선한다.
 *
 * @param model  u3 소유 뷰모델(assembleCredit 산출).
 * @param window 현재 추이 창(창 토글 aria-checked 표시용).
 */
export function renderCredit(model: CreditViewModel, window: TrendWindow, s: Strings): string {
  const t = s.usage;
  const parts: string[] = [];

  const stalePill = model.freshness.stale ? ` ${pill(t.stalePill, "warn")}` : "";
  parts.push(`<div class="credit-head">${statusPill(model.status, s)}${stalePill}</div>`);

  if (model.status === "loading") {
    parts.push(`<p class="note" role="status">${esc(t.firstCollection)}</p>`);
  }

  if (model.status === "none") {
    parts.push(`<p class="note">${esc(t.noCreditYet)}</p>`);
  }

  if (model.pollHalt !== null) {
    parts.push(haltNotice(model.pollHalt, s));
  }

  if (model.status === "failure" && model.warning !== null) {
    parts.push(warningBanner(model.warning, s));
  }

  if (model.freshness.stale) {
    parts.push(`<p class="note warn">${esc(t.staleNote)}</p>`);
  }

  if (model.current !== null) {
    parts.push(`<div class="credit-current">
  <div class="credit-gauge">${renderGauge(model.current.usageRatio, s)}</div>
  ${metricsTable(model.current, s)}
</div>`);
    parts.push(progressBlock(model.current.usageRatio, s));
    parts.push(
      `<p class="note">${esc(t.lastSuccess(shortTs(model.lastSuccessAt ?? undefined)))}</p>`,
    );
  }

  parts.push(trendPanel(model, window, s));

  return section(t.creditSection, parts.join("\n"), "credit");
}
