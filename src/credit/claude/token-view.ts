/**
 * ClaudeTokenView — `TokenViewModel`을 host 룩앤필 HTML 문자열로 렌더한다.
 *
 * Kiro의 `renderCredit`과 같은 카드 자리를 차지하고 같은 host 프리미티브(`section`·`pill`·
 * `esc`·`bar`)와 같은 차트(`renderLineChart`)를 쓴다 — 두 패널이 시각적으로 형제로 보여야
 * 하기 때문이다. 다른 점은 표의 내용뿐이다: 할당량(플랜·한도·잔량·사용률)이 아니라 실사용
 * 토큰이다.
 *
 * 게이지(`renderGauge`)는 쓰지 않는다. 게이지는 0~1 사용률을 전제하는데 Claude Code 로컬
 * 데이터에는 한도가 없어 분모가 존재하지 않는다. 한도를 설정값으로 받아 %를 만들 수도
 * 있지만 그러면 실측이 아닌 값이 실측 자리에 앉는다(host의 "라벨 없는 숫자 금지" 규율).
 *
 * 이스케이프 규율: 외부 텍스트(모델명·경로·집계 note)는 반드시 `esc()`. 결측은 `"—"`.
 * 읽기 전용 — 부수효과 없음.
 */

import { bar, esc, hours, pill, section, shortTs } from "../../render/common";
import type { Strings } from "../../render/i18n";
import type { TrendWindow } from "../trend/trend";
import { renderLineChart } from "../view/svg-chart";
import type { TokenNote, TokenStatus, TokenViewModel } from "./token-model";
import { totalOf } from "./transcript-reader";

/** 창 이름·칩 라벨은 카탈로그(`render/i18n`) 소관. Kiro 패널과 같은 `?cw=` 계약을 공유한다. */
function windowLabelOf(w: TrendWindow, s: Strings): string {
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

/** `TokenNote` → 문장. switch 는 `never` 가드로 빠짐없음이 강제된다. */
function noteText(note: TokenNote, s: Strings): string {
  const t = s.usage;
  const n = (v: number) => fmtNumber(v, s.locale);
  switch (note.code) {
    case "no-transcripts":
      return t.noteNoTranscripts(note.triedPath);
    case "files-capped":
      return t.noteFilesCapped(n(note.count));
    case "unreadable-files":
      return t.noteUnreadableFiles(n(note.count));
    case "malformed-lines":
      return t.noteMalformedLines(n(note.count));
    default: {
      const unhandled: never = note;
      return unhandled;
    }
  }
}

function statusPill(status: TokenStatus, s: Strings): string {
  if (status === "ok") return pill(s.usage.statusOk, "ok");
  if (status === "partial") return pill(s.usage.tokenPartial, "warn");
  return pill(s.usage.statusNone, "mute");
}

/** 천단위 구분은 ko-KR 과 en-US 가 동일해 실측 확인됨 — 로케일로 갈리지 않는다. */
function fmtNumber(n: number | null, locale: string): string {
  if (n === null || Number.isNaN(n)) return "—";
  return n.toLocaleString(locale);
}

/**
 * 0~1 비율 → 백분율 한 자리. 결측은 `"—"`.
 *
 * 로케일을 받지 않는다 — 이 패널의 `modelTable` 이 비중을 이미 `toFixed(1)` 로 내고 있고,
 * 소수점 문자는 ko-KR·en-US 가 동일하다(`fmtNumber` 주석과 같은 실측 근거).
 */
function fmtPercent(ratio: number | null): string {
  if (ratio === null || Number.isNaN(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** 토큰 5종 + 캐시 적중률 + 세션·메시지 표. thinking이 output의 부분집합임을 라벨에 명시한다. */
function totalsTable(m: TokenViewModel, s: Strings): string {
  const t = s.usage;
  const n = (v: number | null) => fmtNumber(v, s.locale);
  // 세 번째 칸은 `<th>` 의 title — 비율 행은 분모를 밝히지 않으면 라벨 없는 숫자가 된다.
  const rows: [string, string, string?][] = [
    [t.rowTokenTotal, n(m.grandTotal)],
    [t.rowInput, n(m.totals.input)],
    [t.rowOutput, n(m.totals.output)],
    [t.rowThinking, n(m.totals.thinking)],
    [t.rowCacheRead, n(m.totals.cacheRead)],
    [t.rowCacheCreate, n(m.totals.cacheCreate)],
    [t.rowCachedPrompt, fmtPercent(m.cachedPromptRatio), t.rowCachedPromptTip],
    [t.rowSessions, n(m.sessions)],
    [t.rowMessages, n(m.messages)],
  ];
  const body = rows
    .map(([k, v, tip]) => {
      const th =
        tip === undefined ? `<th>${esc(k)}</th>` : `<th title="${esc(tip)}">${esc(k)}</th>`;
      return `<tr>${th}<td class="g-n">${v}</td></tr>`;
    })
    .join("");
  return `<table class="tbl"><tbody>${body}</tbody></table>`;
}

/**
 * 세션 시간 분해. 레코드가 없으면 아무것도 그리지 않는다(프로젝트 절반이 그렇다).
 *
 * **권위 없는 교차 검증이라고 화면이 직접 말한다.** 타이밍 패널이 감사 원장으로 같은 질문에
 * 답하고 이쪽은 독립 소스이므로, 두 수치가 다를 때 독자가 어느 쪽을 믿어야 하는지 알아야 한다.
 * 세션이 stage 에 귀속되지 않는다는 사실도 함께 밝힌다 — 그래서 stage 별로 쪼갤 수 없다.
 */
function sessionTimeBlock(m: TokenViewModel, s: Strings): string {
  const st = m.sessionTime;
  if (st === null || st.sessions === 0) {
    // 걸친 세션만 있고 합계가 빈 경우는 숫자 없이 그 사실만 말한다.
    if (st !== null && st.straddling > 0) {
      return `<p class="note">${esc(s.usage.sessionAllStraddling(fmtNumber(st.straddling, s.locale)))}</p>`;
    }
    return "";
  }
  const t = s.usage;
  const rows: [string, string][] = [
    [t.rowSessionWall, hours(st.totalSec)],
    [
      t.rowSessionApi,
      `${hours(st.apiSec)}${st.apiRatio === null ? "" : ` (${fmtPercent(st.apiRatio)})`}`,
    ],
    [t.rowSessionTool, hours(st.toolSec)],
    [t.rowSessionCount, fmtNumber(st.sessions, s.locale)],
  ];
  const body = rows
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td class="g-n">${esc(v)}</td></tr>`)
    .join("");
  const straddling =
    st.straddling > 0
      ? `<p class="note">${esc(t.sessionStraddling(fmtNumber(st.straddling, s.locale)))}</p>`
      : "";
  return `<table class="tbl"><tbody>${body}</tbody></table>
${straddling}
<p class="note">${esc(t.sessionCrossCheck)}</p>`;
}

/** 모델별 분해 표. 비중은 총 토큰 대비 막대로 병기한다(색 비의존 — 수치도 함께). */
function modelTable(m: TokenViewModel, s: Strings): string {
  if (m.byModel.length === 0) return "";
  const t = s.usage;
  const n = (v: number | null) => fmtNumber(v, s.locale);
  const rows = m.byModel
    .map((row) => {
      const total = totalOf(row.totals);
      const share = m.grandTotal > 0 ? (total / m.grandTotal) * 100 : null;
      return `<tr>
  <td>${esc(row.model)}</td>
  <td class="g-n">${n(total)}</td>
  <td class="g-n">${n(row.totals.output)}</td>
  <td class="g-n">${n(row.messages)}</td>
  <td class="token-share">${bar(share)}<span class="note">${share === null ? "—" : `${share.toFixed(1)}%`}</span></td>
</tr>`;
    })
    .join("");
  return `<table class="tbl token-models">
  <thead><tr><th>${esc(t.colModel)}</th><th>${esc(t.rowTokenTotal)}</th><th>${esc(
    t.rowOutput,
  )}</th><th>${esc(t.rowMessages)}</th><th>${esc(t.colShare)}</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

/** 창 토글(radiogroup). Kiro 패널과 같은 `?cw=` 링크·같은 `.window-toggle` 칩 CSS를 쓴다. */
function windowToggle(current: TrendWindow, s: Strings): string {
  const radios = WINDOW_ORDER.map(
    (w) =>
      `<a role="radio" aria-checked="${w === current ? "true" : "false"}" href="?cw=${w}">${esc(
        windowChipLabel(w, s),
      )}</a>`,
  ).join("");
  return `<div class="window-toggle" role="radiogroup" aria-label="${esc(
    s.usage.tokenToggleLabel,
  )}">${radios}</div>`;
}

/** 일별 토큰 추이 + 접근성 텍스트 요약. */
function trendPanel(m: TokenViewModel, window: TrendWindow, s: Strings): string {
  const label = windowLabelOf(m.trend.window, s);
  const { summary } = m.trend;
  const n = (v: number | null) => fmtNumber(v, s.locale);
  const summaryText =
    summary.count === 0
      ? s.usage.tokenChartEmpty(label)
      : s.usage.tokenChartSummary(
          label,
          summary.count,
          n(summary.min),
          n(summary.max),
          n(summary.latest),
        );
  const chart = renderLineChart(m.trend, s, { ariaLabel: summaryText });
  return `<div class="credit-trend">
  ${windowToggle(window, s)}
  <div class="credit-chart">${chart}</div>
  <p class="note">${esc(summaryText)}</p>
</div>`;
}

/**
 * 토큰 사용량 카드를 렌더한다. host `section()`으로 감싸 Kiro 패널과 같은 자리에 놓인다.
 *
 * @param m      뷰모델(assembleTokens 산출).
 * @param window 현재 창(창 토글 aria-checked 표시용).
 */
export function renderTokens(m: TokenViewModel, window: TrendWindow, s: Strings): string {
  const t = s.usage;
  const parts: string[] = [];

  parts.push(
    `<div class="credit-head">${statusPill(m.status, s)}${pill("Claude Code", "mute")}</div>`,
  );

  for (const note of m.notes) {
    parts.push(`<p class="note warn">${esc(noteText(note, s))}</p>`);
  }

  if (m.status === "none" && m.dir !== null) {
    parts.push(`<p class="note">${esc(t.noTokens)}</p>`);
  }

  if (m.messages > 0) {
    parts.push(`<div class="credit-current">${totalsTable(m, s)}</div>`);
    parts.push(modelTable(m, s));

    const span =
      m.firstActivityAt !== null && m.lastActivityAt !== null
        ? `${esc(shortTs(m.firstActivityAt))} — ${esc(shortTs(m.lastActivityAt))}`
        : "—";
    parts.push(`<p class="note">${t.span(span)}</p>`);

    if (m.sidechainMessages > 0) {
      parts.push(
        `<p class="note">${esc(t.sidechain(fmtNumber(m.sidechainMessages, s.locale)))}</p>`,
      );
    }

    parts.push(sessionTimeBlock(m, s));
  }

  parts.push(trendPanel(m, window, s));

  return section(t.tokenSection, parts.join("\n"), "credit");
}
