// Korean copy. The original, and the one calibrated against real run trees.
//
// Every string here was MOVED from the module that used to hold it, unchanged. The
// golden-snapshot tests exist to keep it that way: `?lang=ko` output is asserted
// byte-identical to what the dashboard rendered before the catalogue existed, so a
// well-meaning reword shows up as a failing test rather than as drift.

import type { ReceiptReason } from "../scan/matrix";
import type {
  BlockerStrings,
  CliStrings,
  DeferralStrings,
  ErrorPageStrings,
  ExplorerStrings,
  FreshnessStrings,
  HealthStrings,
  OpenFileStrings,
  OverviewStrings,
  PageStrings,
  PickerStrings,
  Strings,
  TimelineStrings,
  UsageStrings,
  ViewerStrings,
  WarnStrings,
} from "./i18n";
/**
 * What each `unverified` cause means. Split per cause because only ONE of them has a known
 * engine verdict: a row with no `Run floor` fails the engine's exact-match test, so the
 * engine WILL re-run that unit — calling that "not incomplete" would be the same kind of
 * over-claim this cell state exists to avoid.
 */
const RECEIPT_REASON_KO: Record<ReceiptReason, string> = {
  "no-run-floor":
    "산출물은 다 있지만 완료 수령증에 `Run floor` 가 없습니다 — 엔진은 이 유닛을 미완으로 보고 다시 실행합니다. 실제 작업이 끝났는지는 감사 기록만으로 알 수 없습니다(필드 도입 전 원장)",
  "team-claim":
    "산출물은 다 있고, 완료 수령증은 claim 파일이 판정합니다 (team 소유) — 감사 기록만으로는 엔진이 완료로 볼지 알 수 없습니다. 위의 유닛 진행 표가 권위 있는 값입니다",
  "wave-fingerprint":
    "산출물은 다 있고, 완료 수령증은 산출물 지문이 판정합니다 (wave 모드) — 감사 기록만으로는 엔진이 완료로 볼지 알 수 없습니다",
  "ambiguous-floor":
    "산출물은 다 있고, 같은 시각의 사본 간 경계 때문에 attempt floor 가 재현되지 않습니다 — 감사 기록만으로는 엔진이 완료로 볼지 알 수 없습니다",
};

const warn: WarnStrings = {
  catalogReadFailed: (harnessDir) =>
    `${harnessDir}/tools/data/stage-graph.json 읽기 실패 — 산출물 계약 판정과 stage 귀속이 근사값으로 하락`,

  catalogNotFound:
    "stage 카탈로그 미검출 (<root>/<harness>/tools/data/stage-graph.json, .kiro·.claude·.aidlc 등 탐색) — " +
    "산출물 계약 판정과 stage 귀속이 근사값으로 하락. harness 트리가 다른 곳에 있으면 --harness 로 지정할 것",

  auditEmpty: "감사 기록 비어 있음 — hook 미발화 가능성",

  stateVersionMismatch: (stateVersion, harnessVersion, harnessDir) =>
    `state.md 은 State Version ${stateVersion}, harness 는 ${harnessVersion} 을 지원합니다 (${harnessDir}/tools/aidlc-lib.ts) — 엔진은 이 조합에서 next·report·doctor 를 모두 거부합니다. 다른 세대의 계약으로 판정할 수 없어 산출물 계약 판정을 내렸습니다`,

  stateVersionUnreadable: (stateVersion) =>
    `state.md 의 State Version 을 읽을 수 없습니다 (${stateVersion === undefined ? "필드 없음" : `값: ${stateVersion}`}) — 엔진은 누락·빈 값·비수치를 모두 거부합니다(aidlc-lib.ts classifyStateVersion). 산출물 계약은 그대로 보여주지만 엔진과 동일한 완료 판정이라고 주장하지 않습니다`,

  teamWithoutUnitMajor: (constructionIteration) =>
    `Unit Ownership 은 team 인데 Construction Iteration 이 unit-major 가 아닙니다 (${constructionIteration ?? "없음"}) — 엔진 계약은 이 둘을 함께 요구하고, 그때만 Unit Progress 표가 존재합니다. 설정을 확인할 것`,

  unitProgressMalformed:
    "state.md 의 `## Unit Progress` 표를 엔진이 정한 모양으로 읽지 못했습니다 (표가 줄 맨 앞에서 시작하지 않거나, 첫 열이 `unit` 이 아니거나, 구분선 폭이 헤더와 다름 — 엔진도 같은 조건에서 거부합니다). owner·유닛 게이트를 표시하지 않습니다",

  unitProgressMissing:
    "team / unit-major 실행인데 state.md 에 `## Unit Progress` 절이 없습니다 — owner·유닛 게이트의 권위 있는 원천이 없어 아래 매트릭스는 디스크와 감사 기록으로 재구성한 값입니다",

  rosterMismatch: (stateVersion, unknownToCatalog, missingFromState) => {
    const ver = stateVersion ? `(State Version: ${stateVersion})` : "(State Version 없음)";
    const engineNote = "엔진도 이 조합을 거부합니다: aidlc-lib.ts classifyStateVersion";
    const unknown =
      unknownToCatalog.length > 0
        ? ` · 카탈로그가 모르는 stage: ${unknownToCatalog.join(", ")}`
        : "";
    const missing =
      missingFromState.length > 0
        ? ` · state 에 행이 없는 stage: ${missingFromState.join(", ")} (엔진은 SKIP 도 한 행씩 씁니다)`
        : "";
    return `state.md 과 stage 카탈로그의 stage 목록이 어긋납니다 ${ver}${unknown}${missing}. 산출물 계약 판정을 신뢰할 수 없어 근사값으로 내렸습니다 (${engineNote})`;
  },

  harnessCoexist: (harnesses, chosen) =>
    `harness 디렉터리 ${harnesses.join("·")} 가 공존 — 사용량 패널을 ${chosen === "claude" ? "Claude Code 토큰" : "Kiro 크레딧"}으로 자동 선택했습니다. 다른 쪽을 보려면 --usage ${chosen === "claude" ? "kiro" : "claude"} 를 지정하세요.`,

  tokenUsageFailed: (detail) => `토큰 사용량 조립 실패 — 사용량 패널만 하락: ${detail}`,

  creditAssemblyFailed: (detail) => `크레딧 조립 실패 — 크레딧 패널만 하락: ${detail}`,
};

const blockers: BlockerStrings = {
  title: "🚧 병목",
  currentStage: "현재 stage",
  staleStage: "이전 stage (파킹된 질문)",
  confirmation: "게이트 확인",
  confirmationTip:
    "질문이 아니라 승인 관문의 확인 항목입니다 — 엔진이 정한 선택지를 고르거나 수정 요청 사유를 적어야 진행됩니다",
  waiting: (age) => `${age} 대기`,
  none: "미답변 질문 없음.",
  ok: "정상",
  currentWaiting: (count) => `현재 stage 가 답변 ${count}건 대기 중 — 이 답 없이는 워크플로 정지.`,
  staleOnly: (count) => `현재 stage 는 정상. 다만 이전 stage 에 미답변 질문 ${count}건 잔존.`,
  viewTip: (rel) => `${rel} 원문을 대시보드에서 보기`,
};

const overview: OverviewStrings = {
  sectionProgress: "진행 개요",
  sectionUnitProgress: "유닛 진행 (state.md 권위)",
  sectionMatrix: "Construction 유닛 매트릭스",
  runComplete: "완료",
  nowLabel: "현재",
  updatedLabel: "갱신",
  kindArtifact: "산출물",
  kindQuestions: "질문/응답",
  kindDiary: "stage 일지",
  openInEditor: (rel) => `${rel} — 기본 편집기로 열기`,
  provisionalTip: "진행 중 — 수치는 계속 늘어남",
  totalColumn: "계",
  unassignedOwner: "미배정",
  batchNote: "배치 안의 유닛은 병렬 가능 — 의존 순서대로 묶인 위상 배치.",
  unitProgressNote:
    "state.md 의 <code>## Unit Progress</code> — 엔진이 수령증·리뷰·게이트를 반영해 매 <code>next</code> 마다 다시 쓰는\n  <b>권위 있는 값</b>입니다. 손으로 고친 내용은 라우팅·완료 근거가 되지 않습니다. 아래 매트릭스는 디스크에서 재구성한 별개의 진단입니다.",
  noUnits: "유닛 정보 없음 — units-generation 미진입.",
  noUnitsPill: "해당 없음",

  tipPartial: (missing) => `미완: ${missing.join(", ")}`,
  tipComplete: (present) => `완료: ${present.join(", ")}`,
  tipUnsettled: (present) =>
    `산출물은 다 있으나 완료 수령증(UNIT_COMPLETED)이 없습니다 — 일시중지·재개 대기·미승인 상태일 수 있습니다 (파일: ${present.join(", ")})`,
  tipUnverified: (reason, present) => `${RECEIPT_REASON_KO[reason]} (파일: ${present.join(", ")})`,
  tipNotApplicable: (present) =>
    `이 유닛 kind 에 계약된 산출물 없음${present.length ? ` (있는 파일: ${present.join(", ")})` : ""}`,
  tipNotStarted: "미착수",

  legendBase:
    "█ 완료(수령증 확인) · ▨ 착수했으나 산출물 미완(칸에 마우스를 올리면 무엇이 빠졌는지 표시) · · 미착수",
  legendUnsettled:
    " · ▩ 산출물은 다 있으나 완료 수령증(UNIT_COMPLETED) 없음 — 엔진도 이 유닛을 미완으로 봅니다",
  legendUnverifiedNoFloor:
    " · ▤ 완료 수령증을 감사 기록만으로 확인할 수 없음 (칸에 마우스를 올려 이유 확인) — 그중 `Run floor` 가 없는 칸은 엔진이 미완으로 보고 다시 실행합니다",
  legendUnverified:
    " · ▤ 완료 수령증을 감사 기록만으로 확인할 수 없음 — 미완이라고 판정된 것은 아닙니다 (칸에 마우스를 올려 이유 확인)",
  legendNa: " · – 이 유닛 kind 에 계약된 산출물 없음(계 열의 괄호는 그 수)",
  legendUnverifiedContract:
    "state.md 와 harness 의 State Version 을 대조하지 못해 <b>확인되지 않은 계약</b>입니다 — 계약 내용은 그대로 보여주지만, 엔진과 같은 완료 판정이라고 보증하지 않습니다",
  legendNoContract: (receiptAware) =>
    `stage-graph.json 부재로 계약 판정 불가 — 칸은 파일 유무${receiptAware ? "와 완료 수령증" : ""}만 뜻함`,
};

const page: PageStrings = {
  warningsHeading: "읽기 경고",
  harnessNotFound: "미검출",
  pickFolder: "📁 폴더 변경",
  reloadTitle: "지금 다시 읽기 (r) — SKIP↔EXECUTE 변경처럼 폴링이 놓칠 수 있는 수정을 즉시 반영",
  reloadLabel: "새로고침",
  footer: "읽기 전용 — 이 대시보드는 워크스페이스에 쓰지 않음.",
  langGroupLabel: "화면 언어 선택",
  langKo: "한국어",
  langEn: "English",

  jsReloading: "새로고침 중",
  jsRefreshedPrefix: "갱신 ",
  jsRefreshFailed: "갱신 실패 — 재시도 중",
  jsOpenFailedStatus: "열기 실패 ({status})",
  jsOpenFailedUnreachable: "열기 실패 — 서버에 닿지 못했다",
};

const health: HealthStrings = {
  sectionDiary: "결정과 이슈",
  sectionStream: "감사 원장",
  kindDeviation: "계획 변경",
  kindDeviationTip: "실행 중 원래 계획에서 달라진 내용과 그 이유를 기록한 항목",
  kindTradeoff: "선택 근거",
  kindTradeoffTip: "여러 대안 사이에서 무엇을 얻고 포기하며 선택했는지 기록한 항목",
  kindInterpretation: "해석",
  kindInterpretationTip: "모호한 요구나 지시를 어떤 의미로 이해했는지 기록한 항목",
  kindResolved: "해결됨",
  kindResolvedTip: "이전에 열린 질문이나 이슈가 해결되었음을 표시한 항목",
  kindFollowUp: "후속 확인",
  kindFollowUpTip: "아직 확인하거나 결정해야 할 작업이 남은 항목",
  kindNote: "참고",
  kindNoteTip: "열린 질문이지만 후속 조치나 해결 여부가 명시되지 않은 항목",
  sourceLink: "원문",
  openTip: (rel) => `${rel} 열기`,
  noRecords: "기록 없음.",
  more: (count) => `나머지 ${count}건`,
  stageRollup: (count) => `Stage별 전체 기록 · 정규화 ${count}건`,
  colStage: "stage",
  colDecision: "결정",
  colDeviation: "변경",
  colFollowUp: "후속",
  colResolved: "해결",
  colNote: "참고",
  colTotal: "계",
  noDiaryFiles: "stage 일지(memory.md) 없음.",
  noDiaryRecords: "기록된 결정이나 후속 이슈 없음.",
  statFollowUp: "후속 확인",
  statResolved: "해결 기록",
  statDeviation: "계획 변경",
  statDecision: "결정 근거",
  tidyPill: "정리됨",
  tidyPillTip: "해결 표시 없이 남아 있는 후속 확인 후보가 없음을 의미",
  tidyNote: "해결 표시 없이 남은 후속 후보 없음.",
  headingFollowUp: "후속 확인 후보",
  headingRecentDecisions: "최근 결정",
  headingRecentDeviations: "최근 계획 변경",
  resolvedRecords: (count) => `해결 기록 ${count}건`,
  emptyLedger: "감사 기록 비어 있음.",
  filterLabel: "종류",
  filterAll: (total) => `전체 (${total}건)`,
  streamMeta: (shown, total, shards) =>
    `최근 ${shown}건 표시 · 전체 ${total}건 · shard ${shards}개`,
  colTime: "시각",
  colEvent: "이벤트",
  colStageUnit: "stage / unit",
  colDetail: "내용",
};

const deferrals: DeferralStrings = {
  section: "미뤄둔 결정",
  faces: {
    passed: {
      label: "지난 단계",
      tip: "이 결정을 맡기로 한 단계가 이미 끝났습니다. 답이 기록된 흔적은 없습니다 — 엔진이 닫힘 표시를 쓰지 않으므로 '버려졌다'가 아니라 '보이지 않는다'는 뜻입니다",
    },
    current: {
      label: "현재 단계",
      tip: "지금 진행 중인 단계가 이 결정을 물어야 합니다 — 이번 차례에 청구되는 몫",
    },
    ahead: {
      label: "예정 단계",
      tip: "아직 시작하지 않은 단계로 배정됐습니다 — 그 단계에 가면 다시 물어옵니다",
    },
    outOfScope: {
      label: "범위 밖 단계",
      tip: "실재하는 단계지만 이번 실행 범위(state.md)에 없습니다 — 아무도 물어보지 않습니다",
    },
    nextCycle: { label: "다음 차수", tip: "이번 차수 밖으로 명시적으로 밀어낸 항목" },
    unassigned: {
      label: "배정 없음",
      tip: "배정 칸에서 단계를 읽어낼 수 없습니다 — 물어볼 자리가 정해지지 않았으므로 다음 단계에서 사라질 수 있습니다",
    },
  },
  ageTip: "이 항목이 처음 기록된 뒤 지난 시간",
  sourceLink: "원문",
  viewTip: (rel) => `${rel} 원문을 대시보드에서 보기`,
  editorLink: "에디터",
  openTip: (rel) => `${rel} 열기`,
  assignLabel: "배정",
  noneApplicable: "해당 없음.",
  more: (key, count) => `${key} 나머지 ${count}건`,
  ownerRollup: (stages) => `배정된 자리별 집계 · stage ${stages}곳`,
  colOwner: "배정된 자리",
  colStatus: "상태",
  colCount: "건수",
  assumptionPill: "전제",
  assumptionPillTip: "확인되지 않은 채로 다음 단계에 넘어간 전제 — 배정된 자리가 없습니다",
  assumptionSummary: (count) => `확인되지 않은 전제 ${count}건 — 배정 없음`,
  assumptionNote: `엔진의 stage 규약은 전제를 <code>[assumption]</code>으로 표시하고, 사용자가 그 단계의 질문지에서
  확인해 줄 때까지 하류 산출물에서도 전제로 남기라고 정합니다. 표가 아니라 산문이라 배정된 자리가 없어
  이 대시보드도 어디서 청구될지 말할 수 없습니다 — 산문에서 단계 이름을 추측하지 않습니다.`,
  diaryFollowUpPill: "후속 확인",
  diaryFollowUpTip: "문장 자체가 후속 확인·결정을 요구합니다",
  diaryNotePill: "일지 미결",
  diaryNoteTip:
    "stage 가 미결 소절에 적었지만 문장에 후속 신호는 없습니다 — 소절 자체가 미결 선언이라 그대로 셉니다",
  diarySummary: (count) => `stage 일지의 미결 ${count}건 — 배정 없음`,
  diaryNote: (resolved) =>
    `산출물이 아니라 <code>memory.md</code>의 <code>## Open questions</code>에서 읽었습니다 —
  엔진이 모든 stage 일지에 두라고 정한 두 번째 미결 대장입니다. 오케스트레이터가 스스로 적은 메모라
  하류 단계와의 계약이 아니고 배정 칸도 없어서, 위 산출물 미결과 <b>합산하지 않습니다</b>.${
    resolved > 0 ? ` 해소 표시가 붙은 ${resolved}건은 제외했습니다.` : ""
  }`,
  ledgerItems: "산출물 미결",
  ledgerItemsSource: "<code>## Assumptions &amp; Open Questions</code>의 미결 항목",
  ledgerAssumptions: "확인되지 않은 전제",
  ledgerAssumptionsSource: "같은 절의 <code>[assumption]</code> 항목",
  ledgerDiary: "stage 일지 미결",
  ledgerDiarySource: "각 stage <code>memory.md</code>의 <code>## Open questions</code>",
  chipUnassignedTip:
    "산문이라 배정 칸이 없습니다 — 사용자가 그 단계 질문지에서 확인해 줄 때까지 전제로 남습니다",
  chipFollowUp: "후속 확인",
  chipFollowUpTip: "문장 자체가 후속 확인·결정을 요구하는 항목",
  chipOther: "그 외",
  chipOtherTip:
    "미결 소절에 적혀 있으나 문장에 후속 신호는 없는 항목 — 소절 자체가 미결 선언이라 그대로 셉니다",
  ledgersNote: `세 대장은 <b>서로 다른 읽기</b>입니다 — 배정 칸이 있는 것은 첫 줄뿐이고,
아래 둘은 물어볼 자리가 정해져 있지 않습니다. <b>합산하지 않습니다.</b>`,
  noSections: (artifacts) =>
    `산출물에 <code>## Assumptions &amp; Open Questions</code> 절이 없습니다 — 이 실행은
    미결 대장을 남기지 않았거나 아직 산출물을 쓰지 않았습니다. (읽은 산출물 ${artifacts}개)`,
  unreadSections: (sections, unread, emptySections) =>
    `산출물 ${sections}곳에 <code>## Assumptions &amp; Open Questions</code>
      절이 있고, 그중 <b>${unread}곳은 이 리더가 아는 모양이 아닙니다</b> — 표(<code>| 항목 | 배정 |</code>)도,
      <code>[assumption]</code> 태그도, <code>**OQ1**</code> 형태의 대장 id 도 없습니다.
      <b>미결이 없다는 뜻이 아니라 읽지 못했다는 뜻입니다.</b>
      명시적으로 <code>None.</code>을 선언한 절은 ${emptySections}곳입니다.`,
  noOpenPill: "미결 없음",
  noOpenPillTip: "미결 대장 절은 있고 그 안이 비어 있음 — 명시적으로 '없음'을 선언한 상태",
  allNone: (sections) => ` 산출물 ${sections}곳의 미결 대장이 모두 <code>None.</code>입니다.`,
  lead: (items, sections, rows, exits) =>
    `미결 <b>${items}건</b> · 산출물 ${sections}곳에
  <code>## Assumptions &amp; Open Questions</code> 대장이 있습니다 (원시 ${rows}행 → 중복 정리 후 ${items}건)${
    exits > 0 ? ` · 이번 차수 밖으로 명시적으로 밀어낸 것 ${exits}건은 위 숫자에 없습니다` : ""
  }.
  엔진 규약은 <b>하류 단계가 미결을 필요로 하면 후속 질문으로 다시 묻는다</b>고 정합니다 — 여기 있는 항목은
  없어진 것이 아니라 <b>다시 물어올 것</b>입니다. 항목이 닫혔다는 표시는 엔진이 쓰지 않으므로
  <b>‘지난 단계’는 버려졌다는 뜻이 아니라 답이 보이지 않는다는 뜻</b>입니다.`,
  catalogMissingNote: `stage 카탈로그가 없어 배정 칸의 단계 이름을 이 실행의 state.md 로만 판정했습니다 —
    범위 밖 단계가 <b>배정 없음</b>으로 내려가 있을 수 있습니다.`,
  headingPassed: (count) => `지난 단계로 배정됨 · ${count}건`,
  headingCurrent: (count) => `현재 단계가 물어야 할 것 · ${count}건`,
  summaryAhead: (count) => `예정 단계로 배정됨 ${count}건 — 그 단계에 가면 물어옵니다`,
  summaryRest: (count) => `배정 없음·차수 밖 ${count}건`,
};

const timeline: TimelineStrings = {
  section: "시간 분석",
  endKinds: {
    completed: "완료",
    skipped: "건너뜀",
    "awaiting-approval": "승인 대기",
    "in-flight": "진행 중",
    superseded: "재진입으로 대체",
  },
  segmentTip: (stage, endKind, from, to, split) =>
    `${stage} — ${endKind}\n${from} → ${to}\n${split}`,
  splitLine: (wait, parked, observed, conversation, unknown) =>
    `사용자 대기 ${wait}분 · 일시중지 ${parked}분 · 관측 실행 ${observed}분 · 대화 ${conversation}분 · 미분류 ${unknown}분`,
  zeroSecondTip: "0초 — 같은 초에 시작·완료",
  loadArtifacts: (n) => `산출 ${n}`,
  loadFailures: (n) => `실패 ${n}`,
  loadDelegations: (n) => `위임 ${n}`,
  loadHumanTurns: (n) => `사람 ${n}`,
  noStageSpans: "감사 기록에 stage 구간 없음.",

  bucketWait: "사용자 대기",
  bucketWaitTip: "관문·질문이 열린 뒤 사람이 답하기까지",
  bucketParked: "일시중지",
  bucketParkedTip: "present 한 모든 사본이 park 상태였던 구간",
  bucketObserved: "관측 실행",
  bucketObservedTip:
    "5분 미만 이벤트 간격과 명시적 위임 구간의 합 — 순수 모델·CPU 실행 시간이 아닙니다",
  bucketConversation: "대화",
  bucketConversationTip:
    "한 사본의 HUMAN_TURN 에서 바로 그 사본의 다음 HUMAN_TURN 까지. 엔진의 대화 응답(감사 기록을 남기지 않음)과 사람이 읽고 입력한 시간이 함께 들어 있고 원장에 그 경계가 없어, 대기도 실행도 아닌 자기 몫으로 둡니다",
  bucketUnknown: "미분류",
  bucketUnknownTip: "5분 이상인데 신뢰할 만한 마커가 없는 구간 — 실행으로 칠하지 않고 남겨 둡니다",

  windowTipOpen: (silence) =>
    `첫 기록 → 지금. 마지막 기록 이후 ${silence} 은 아래 분류에 포함되지 않는다(기록이 없어 분류할 수 없음).`,
  windowTipClosed: "첫 기록 → 마지막 기록",
  windowTeam: "팀 벽시계",
  windowSolo: "전체 경과",
  windowSub: (classified) => `아래 비율의 기준은 <b>분류 대상 ${classified}</b>`,
  unrecordedPill: (silence) => `마지막 기록 이후 ${silence} 무기록`,
  clonesPill: (clones) => `사본 ${clones}개`,
  delegated: (h) => ` · 위임 ${h}`,
  inFlight: (list) => `진행 중 ${list}`,
  noneInFlight: "진행 중인 stage 없음",
  awaiting: (stage) => `승인 대기 <b>${stage}</b>`,
  awaitingNone:
    '승인 대기 없음<span class="mute"> (지금 관문에서 승인을 기다리는 stage 가 없다는 뜻 — 과거 제출 이력은 아래 재작업 표)</span>',
  reworkPending: " · 반려 후 승인 전인 stage 있음",
  mergedNote: (workers, clones) =>
    `기록 ${workers}개(사본 ${clones}개) 병합 — 위 분류는 전 기록을 한 줄로
       합친 <b>팀 단위</b> 수치. 개인별 시간은 <b>작업자별 분해</b> 참조.`,
  axisSilenceTip: (silence) => `마지막 기록 이후 ${silence} — 기록이 없어 분류하지 않는 구간`,

  reworkSummary: (rejected, h) => `재작업 — 반려 ${rejected}건 · ${h}`,
  reworkNone: "반려·수정 기록 없음 — 모든 관문을 한 번에 통과.",
  reworkProvisionalTip: "아직 승인되지 않음 — 시간은 계속 늘어남",
  feedbackCount: (n) => `${n}건`,
  reasonsSummary: (n) => `사람이 적은 반려 사유 ${n}건 — 전문`,
  reasonsNote: `원장에서 <code>**Feedback**</code>을 그대로 옮긴 것입니다. 반려·수정 쌍에서 중복은 제거했고
  stage 당 최대 6건까지 보관합니다 — 요약하거나 자르지 않습니다.`,
  reworkStatShare: (share) => `재작업 ${share}%`,
  statRejected: "반려",
  statApproved: "승인",
  statRevisions: "수정 회차",
  statJumps: "stage 점프",
  statFreezeBlocked: "검토중 편집 차단",
  colSubmissions: "제출",
  colSubmissionsTip: "STAGE_AWAITING_APPROVAL — 관문에 올린 횟수",
  colRejections: "반려",
  colRevisions: "수정",
  colRevisionsTip: "수정 회차 / state.md 의 누적 Revision count",
  colRework: "재작업",
  colReworkTip: "첫 반려 → 마지막 승인",
  colReason: "사유",
  colReasonTip: "사람이 적은 반려 사유 — 전문은 표 아래에 있습니다",
  reworkNote: (share, classified, provisional) =>
    `재작업 = <b>첫 반려부터 마지막 승인까지</b>. 두 번 반려된 stage 는 그 사이 승인까지 포함한
  "아직 받아들여지지 않은 시간"이며, 회차별 합이 아닙니다 — 원장에 수정 회차의 종료 표시가 없습니다.
  ${share}% 는 분류 대상 구간(${classified}) 기준.${
    provisional ? " <b>~</b> 표시 stage 는 아직 승인 전이라 계속 늘어납니다." : ""
  }`,

  colStage: "stage",
  colTrack: "진입 구간",
  colTotalMin: "전체(분)",
  colWait: "사용자 대기",
  colParked: "중지",
  colObserved: "관측 실행",
  colConversation: "대화",
  colConversationTip:
    "사람 턴에서 바로 다음 사람 턴까지 — 엔진의 대화 응답과 사람이 읽고 입력한 시간이 섞여 있어 어느 쪽으로도 계상하지 않는다.",
  colUnknown: "미분류",
  colWorkEstimate: "작업 추정",
  colWorkEstimateTip:
    "관측 실행 + 미분류 — 사람 대기·중지·대화를 뺀 시간. 실행 시간이 아니라 '대기로 설명되지 않는 시간'이며, 어느 stage가 비쌌는지는 전체(분)보다 이 열이 답한다.",
  colWorkload: "작업량",
  ganttLegend: `막대 <b>길이</b>는 달력 점유, <b>내부 색</b>은 그 구간의 분류 —
  <i class="lg wait"></i>대기 · <i class="lg parked"></i>중지 · <i class="lg observed"></i>관측 ·
  <i class="lg conv"></i>대화 · <i class="lg unknown"></i>미분류. 테두리는 종료 방식: 청록=완료 · 회색=건너뜀 · 주황=승인대기 ·
  파랑=진행중 · 점선=재진입으로 대체(그 시도는 끝났고 다시 시작됨). 0초 stage 는 막대가 아니라 눈금.
  <b>어느 stage 가 비쌌는지는 길이가 아니라 「작업 추정」 열로 읽으세요</b> — 가장 긴 막대가 대기로만 채워질 수 있습니다.`,
  observedCaveat: `관측 실행은 5분 미만 이벤트 간격과 명시적 위임 구간의 합이며, 순수 모델·CPU 실행 시간이 아님.
  <b>대화</b>는 사람 턴에서 바로 다음 사람 턴까지 — 엔진의 대화 응답은 감사 기록을 남기지 않으므로 그 구간에는
  엔진 작업과 사람이 읽고 입력한 시간이 함께 들어 있고, 원장에 경계가 없어 <b>어느 쪽으로도 계상하지 않습니다</b>.`,
  unknownGapsSummary: (count) => `미분류 5분+ 공백 ${count}건 (상위 12)`,
  unknownGapsNote: "대기·중지·실행 어느 쪽으로도 확정할 수 없어 실행 시간에서 분리한 구간.",
  minutes: (min) => `${min}분`,
  inferredPark: (h, anomalies) =>
    `일시중지 중 ${h}은 session 재개 이벤트로 추정${
      anomalies > 0 ? ` · park 마커 이상 ${anomalies}건` : ""
    }.`,

  workerShapeOverlap: (clones, overlap) => `clone ${clones}개 · 겹쳐 일한 시간 ${overlap}`,
  workerShapeSequential: (clones, handover) =>
    `clone ${clones}개 · 순차 인계(겹침 없음)${handover ? ` · 인계 공백 ${handover}` : ""}`,
  workerSummary: (shape) => `작업자별 분해 — ${shape}`,
  leadTag: "주도",
  leadTagTip: "승인 게이트를 통과시킨 = 워크플로를 주도한 clone",
  noUnitAttribution: "감사 기록에 유닛 귀속 없음",
  personTotal: "사람-시간 합",
  personParallelism: "실효 병렬도",
  colClone: "clone",
  colEvents: "이벤트",
  colSpanMin: "구간(분)",
  colGates: "게이트",
  colMainStage: "주 stage",
  colUnits: "유닛",
  workerNote: (teamIdle, deltaNote) =>
    `각 행은 <b>그 clone 의 타임라인만</b> 보고 계산 = "각 사람이 얼마나 기다렸나".
  위쪽 팀 단위 중지·대기 합(${teamIdle})은 전 기록을 한 줄로 합친 값.
  ${deltaNote}`,
  deltaSame: "두 수치가 거의 같음.",
  deltaOverlapUnder: (delta, overlap) =>
    `합친 기록에서는 남의 이벤트가 내 대기를 메워 <b>${delta} 만큼 덜 잡힘</b>
             (clone 들이 ${overlap} 겹쳐 일했다).`,
  deltaOverlapOver: (delta) =>
    `합친 기록이 <b>${delta} 더 많음</b> — 겹치지 않은 인계 공백은 팀으로는 멈춘
             시간이지만 개인 타임라인에는 부재.`,
  deltaHandoverUnder: (delta) =>
    `차이 <b>${delta}</b> 는 겹침이 아니라 인계 때문 — clone 들이 시간상 전혀 겹치지
             않으므로(겹침 0), 한 clone 이 park 한 구간을 팀 단위로는 다른 clone 의 부재로 볼 수 없다.`,
  deltaHandoverOver: (delta, handover) =>
    `합친 기록이 <b>${delta} 더 많음</b> — clone 간 인계 공백
             (${handover})은 팀으로는 멈춘 시간이지만 개인 타임라인에는 부재.`,
  hostNote: (workers, clones) =>
    `기록 ${workers}개 중 일부는 <b>같은 작업 사본</b>이 다른 호스트 이름으로
         남긴 것 — 사본 수는 ${clones}개다.`,
  endedParked: (label, at) => `<b>${label}</b> 는 ${at} 에 park 상태로 끝남`,
  endedParkedTail: " — 되돌아오지 않은 기록이다.",
  parallelismNote: `실효 병렬도 = 사람-시간 합 ÷ 팀 벽시계. 겹쳐 일한 시간이 있을 때만 의미가 있어
       겹침이 0이면 표시하지 않는다.`,
  unitColumnNote: `⚠️유닛 열이 "—"인 clone 은 감사 기록의 <code>Output path</code> 가 산출물이 아니라 코드 경로여서
  유닛 역추적 불가 — 담당 stage 까지만 확실.`,
};

const picker: PickerStrings = {
  docTitle: "AI-DLC 워크스페이스 선택",
  heading: "워크스페이스 선택",
  currentMark: "현재",
  workspaceKind: "AI-DLC 워크스페이스",
  openAction: "열기&nbsp;›",
  tagWorkspace: "워크스페이스",
  tagAidlcTree: "aidlc 트리",
  tagUnreadable: "읽기 불가",
  open: "열기",
  openThisFolder: "이 폴더 열기",
  explorerEmpty: "표시할 하위 폴더가 없습니다.",
  explorerHeading: "폴더 탐색",
  explorerRootsLabel: "탐색 루트",
  breadcrumbLabel: "현재 경로",
  filterLabel: "현재 폴더에서 디렉터리 이름 필터",
  filterPlaceholder: "폴더 이름 필터",
  filterClear: "필터 지우기",
  showHidden: "숨김 폴더 보기",
  hideHidden: "숨김 폴더 감추기",
  filterNoMatch: "일치하는 폴더가 없습니다.",
  noWorkspacesFound: "검색된 워크스페이스가 없습니다.",
  foundSuffix: "개 발견",
  scanned: (count) => `${count}개 폴더 확인`,
  manualHeading: "경로로 열기",
  manualLabel: "워크스페이스 경로",
  manualButton: "워크스페이스 열기",
  manualNote: "<code>aidlc/</code> 폴더가 있는 루트 경로 · <code>~</code> 사용 가능",
  foundHeading: "찾은 워크스페이스",
  rescan: "다시 검색",
  truncated: "검색 한도에 도달했습니다. 위에서 경로를 직접 지정할 수 있습니다.",
  summaryPctLabel: "완성도",
  summaryBlockersLabel: "병목",
  summaryNoRunNone: "실행 기록 없음",
  summaryNoRunAmbiguous: "인텐트 여러 개 · 활성 커서 없음",
  summaryUnreadable: "state.md 읽기 불가",
  summaryFailed: "조회 실패",
  summaryProgressTip: (done, total, asOf) =>
    `state.md 기준 ${done}/${total} · 갱신 ${asOf} (전환 시점에 기록되므로 stage 진행 중에는 뒤처집니다)`,
  summaryBlockersTip: (asked) => `질문 ${asked}건 중 미답변 · 디스크에서 방금 읽음`,
  footer: (path) => `현재 워크스페이스 · <code>${path}</code> ·
         <a href="/">대시보드로 돌아가기</a>`,
};

const usage: UsageStrings = {
  windowLong7d: "최근 7일",
  windowLong30d: "최근 30일",
  windowLongAll: "전체 기간",
  window7d: "7일",
  window30d: "30일",
  windowAll: "전체",
  trendToggleLabel: "추이 기간 선택",
  tokenToggleLabel: "집계 기간 선택",

  creditSection: "크레딧",
  statusLoading: "수집 중",
  statusOk: "정상",
  statusPartial: "부분 데이터",
  statusFailure: "수집 실패",
  statusNone: "데이터 없음",
  rowPlan: "플랜",
  rowUsed: "누적 사용량",
  rowRemaining: "잔량",
  rowLimit: "플랜 한도",
  rowRatio: "사용률",
  ratioUnavailable: "사용률 계산 불가",
  ratioLabel: (pct) => `사용률 ${pct}`,
  fetchFailed: (reason) =>
    `최신 데이터를 가져오지 못했습니다 (${reason}). 아래는 마지막 성공값입니다.`,
  rawSummary: "실패 원문 보기",
  rawEmpty: "(원문 없음)",
  stalePill: "오래된 데이터",
  firstCollection: "크레딧 사용량을 처음 수집하고 있습니다.",
  noCreditYet: "아직 수집된 크레딧 데이터가 없습니다. 수집이 진행되면 이 자리에 표시됩니다.",
  staleNote: "마지막 성공 이후 10분 이상 경과 — 표시값이 최신이 아닐 수 있습니다.",
  pollHalted: (failures, retryEvery) =>
    `연속 ${failures}회 실패해 자동 수집 주기를 ${retryEvery}분으로 늘렸습니다 — 깨진 상태를 5분마다 두드리지 않기 위해서입니다. 아래 값은 마지막 성공값이며, 수집이 한 번이라도 성공하면 원래 주기로 돌아옵니다. 새로고침 버튼으로 지금 바로 다시 시도할 수도 있습니다.`,
  pollHaltedReason: (reason) => `마지막 실패 사유: ${reason}`,
  lastSuccess: (at) => `마지막 성공: ${at}`,
  chartEmpty: (w) => `${w} 누적 사용량 추이: 표시할 데이터 없음`,
  chartSummary: (w, min, max, latest) =>
    `${w} 누적 사용량 추이, 최소 ${min}, 최대 ${max}, 최신 ${latest}`,
  chartNoData: "표시할 데이터가 없습니다",
  gaugeUnavailable: "사용률 계산 불가",
  gaugeUnavailableShort: "계산 불가",
  gaugeLabel: (pct) => `사용률 ${pct}`,

  tokenSection: "토큰 사용량",
  tokenPartial: "부분 집계",
  rowTokenTotal: "총 토큰",
  rowInput: "입력",
  rowOutput: "출력",
  rowThinking: "사고 토큰 (출력 내 포함)",
  rowCacheRead: "캐시 읽기",
  rowCacheCreate: "캐시 생성",
  rowCachedPrompt: "프롬프트 캐시 적중",
  rowCachedPromptTip:
    "캐시 읽기 ÷ (입력 + 캐시 읽기 + 캐시 생성). 프롬프트 토큰 중 캐시에서 온 비율이며, 출력은 분모에 없습니다.",
  rowSessions: "세션",
  rowMessages: "응답 메시지",
  colModel: "모델",
  colShare: "비중",
  tokenChartEmpty: (w) => `${w} 일별 토큰 추이: 표시할 데이터 없음`,
  tokenChartSummary: (w, days, min, max, latest) =>
    `${w} 일별 토큰 추이, ${days}일, 최소 ${min}, 최대 ${max}, 최근 ${latest}`,
  noTokens: "이 기간에 기록된 Claude Code 토큰 사용량이 없습니다. 기간을 넓혀 보세요.",
  span: (range) => `집계 구간: ${range}`,
  sidechain: (count) => `서브에이전트 응답 ${count}건이 위 합계에 포함되어 있습니다.`,
  rowSessionWall: "세션 벽시계",
  rowSessionApi: "그중 API",
  rowSessionTool: "그중 도구 실행",
  rowSessionCount: "체크포인트 있는 세션",
  sessionCrossCheck:
    "Claude Code 가 세션마다 남긴 체크포인트에서 읽은 값입니다. 감사 원장으로 계산하는 타이밍 패널과 독립된 소스이므로 대조용이며, 두 수치가 다르면 감사 원장이 권위 있는 값입니다. 세션은 stage 에 귀속되지 않아 stage 별로 쪼갤 수 없습니다. 체크포인트는 세션 도중에 기록되므로, 위 `세션` 수보다 적을 수 있습니다 — 진행 중인 세션은 아직 남기지 않았을 수 있습니다.",
  sessionStraddling: (count) =>
    `세션 ${count}개는 창 경계를 걸쳐 위 합계에서 제외했습니다 — 레코드가 세션 누적 총합이라 잘라 넣을 수 없습니다.`,
  sessionAllStraddling: (count) =>
    `이 창에 온전히 든 세션이 없습니다 — 세션 ${count}개가 창 경계를 걸칩니다. 기간을 넓혀 보세요.`,
  noteNoTranscripts: (triedPath) =>
    `Claude Code 트랜스크립트를 찾지 못했습니다 (${triedPath}). 이 워크스페이스에서 Claude Code로 실행한 이력이 없거나, 다른 경로에서 실행되었습니다.`,
  noteFilesCapped: (count) =>
    `트랜스크립트가 커서 오래된 ${count}개 파일을 읽지 않았습니다 — 아래 수치는 그만큼 과소 집계입니다.`,
  noteUnreadableFiles: (count) => `읽지 못한 트랜스크립트 파일 ${count}개.`,
  noteMalformedLines: (count) => `형식이 깨진 줄 ${count}개를 건너뛰었습니다.`,
};

const errorPage: ErrorPageStrings = {
  docTitle: "AI-DLC dashboard",
  heading: "워크플로 표시 불가",
  triedPathLabel: "읽으려던 경로: ",
  checkThis: `확인할 것: <code>&lt;root&gt;/aidlc/active-space</code> 와
<code>&lt;root&gt;/aidlc/spaces/&lt;space&gt;/intents/active-intent</code> 커서가 실재하는 record 를 가리키는지.`,
  pickAnother: "다른 폴더 선택",
  readFailed: (message) => `읽기 중 오류: ${message}`,
  noSelection: "(선택 없음)",
  notAWorkspace: (dir) => `${dir} 에 aidlc/ 폴더 없음 — 워크스페이스가 아님.`,
  noWorkspaceSelected: "워크스페이스 미선택.",
};

const cli: CliStrings = {
  needValue: (flag) => `${flag} 에 값 필요`,
  mustBeNumber: (flag, raw) => `${flag} 는 숫자여야 함: ${raw}`,
  msFloor: (flag, floor, zeroOk, got) =>
    `${flag} 는 밀리초 단위로 ${floor} 이상이어야 함${zeroOk ? " (0 은 비활성화)" : ""}: ${got}`,
  portRange: (max, got) => `--port 는 1~${max} 범위여야 함: ${got}`,
  needRoot: "--root 에 경로 필요",
  pathMissing: (path) => `경로 없음: ${path}`,
  notAWorkspace: (path) => `aidlc/ 디렉터리 없음 — AI-DLC 워크스페이스 루트가 아님: ${path}`,
  harnessMissing: (path) => `--harness 로 지정한 디렉터리 없음: ${path}`,
  needUsage: "--usage 에 값 필요 (auto|kiro|claude)",
  badUsage: (raw) => `--usage 는 auto|kiro|claude 중 하나여야 함: ${raw}`,
  needLang: "--lang 에 값 필요 (ko|en)",
  badLang: (raw) => `--lang 는 ko|en 중 하나여야 함: ${raw}`,
  unknownArg: (arg) => `알 수 없는 인자: ${arg}`,
  noRootPicker: "--root 없음 — 브라우저에서 폴더 선택",
  manualRefreshFailed: (detail) => `수동 새로고침 실패(격리됨): ${detail}`,
  routeFailed: (route) => `${route} 실패:`,
  creditBootFailed: (detail) => `크레딧 서브시스템 부팅 실패(대시보드는 계속 기동): ${detail}`,
  unhandled: "처리되지 않은 오류:",
  harnessNotFound: "미검출",
  startupSummary: (audit, langDefault) => `audit ${audit}건 · lang ${langDefault} 기본`,
  intentAmbiguous: (root) => `intent 가 여럿인데 active-intent 커서 없음: ${root}`,
  noWorkflow: (root) => `AI-DLC 워크플로 미검출: ${root}`,
};

const openFile: OpenFileStrings = {
  badRel: "경로가 비었거나 너무 김",
  badChars: "경로에 허용되지 않는 문자 포함",
  outsideRecord: "record 폴더 밖의 경로는 열기 불가",
  extension: (allowed) => `이 확장자는 열기 불가 (${allowed.join(" / ")} 만 허용)`,
  symlinkEscape: "symlink 가 record 폴더 밖을 가리킴",
  notFound: "파일 없음",
  statFailed: "파일 정보 읽기 불가",
  notAFile: "일반 파일이 아님",
  platformUnsupported: (platform) => `이 플랫폼(${platform})은 열기 미지원`,
  interpreterMetachars: "파일 이름에 해석기 특수문자 포함 — 열기 거부",
  openerMissing: (cmd) => `열기 명령 ${cmd} 를 PATH 에서 찾을 수 없음`,
  spawnFailed: (detail) => `열기 실패: ${detail}`,
  spawnFailedLog: (cmd, detail) => `파일 열기 실패(${cmd}): ${detail}`,
  readFailed: (detail) => `파일 읽기 실패: ${detail}`,
};

const viewer: ViewerStrings = {
  docTitle: (rel) => `${rel} — 원문`,
  back: "← 대시보드",
  openInEditor: "에디터로 열기",
  size: (bytes) => `크기 ${bytes}`,
  truncated: (shown, total) =>
    `앞부분 ${shown} 만 표시했습니다 (전체 ${total}). 나머지는 에디터로 열어 확인하세요.`,
  refusalHeading: "원문을 보여줄 수 없습니다",
  empty: "빈 파일입니다.",
};

const explorer: ExplorerStrings = {
  rootHome: "홈",
  rootCurrent: "현재",
  volume: (name) => `볼륨 ${name}`,
  mount: (name) => `마운트 ${name}`,
  media: (name) => `미디어 ${name}`,
  browseFailed: (dir, message) => `${dir} 열기 불가: ${message}`,
};

const freshness: FreshnessStrings = {
  graphBehind: (lag, drift) =>
    `감사 기록보다 ${lag} 뒤처짐 — 이 스냅샷은 stage 전이 시점에만 재컴파일됨${drift ? `. ${drift}` : ""}`,
  graphUnreadable: "runtime-graph.json 읽기 실패 — units-generation 미진입 또는 미동기화",
  stageGraphMissing: "stage-graph.json 없음 — 산출물 계약 판정 생략",
  sensorDrift: (fired, missing) =>
    `감사 기록의 sensor 발화 ${fired}건 중 ${missing}건이 이 스냅샷에 부재`,
};

export const KO: Strings = {
  locale: "ko",
  warn,
  blockers,
  overview,
  page,
  health,
  deferrals,
  timeline,
  picker,
  usage,
  errorPage,
  cli,
  openFile,
  viewer,
  explorer,
  freshness,
};
