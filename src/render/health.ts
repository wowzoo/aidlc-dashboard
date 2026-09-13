// User-facing decisions and issues, plus the optional raw ledger.
// Hook health stays in the model for diagnostics and freshness calculations but
// is intentionally not exposed as a dashboard card.

import type { DashboardModel } from "../model/types";
import type { DiaryRecord } from "../scan/memory-diary";
import { esc, pill, section, shortTs } from "./common";
import type { Strings } from "./i18n";

function diaryWhere(record: DiaryRecord): string {
  return record.unit ? `${record.unit} / ${record.stage}` : record.stage;
}

interface DiaryKind {
  label: string;
  tone: "ok" | "warn" | "mute";
  tooltip: string;
}

function diaryKind(record: DiaryRecord, s: Strings): DiaryKind {
  const t = s.health;
  if (record.axis === "deviations") {
    return { label: t.kindDeviation, tone: "warn", tooltip: t.kindDeviationTip };
  }
  if (record.axis === "tradeoffs") {
    return { label: t.kindTradeoff, tone: "ok", tooltip: t.kindTradeoffTip };
  }
  if (record.axis === "interpretations") {
    return { label: t.kindInterpretation, tone: "mute", tooltip: t.kindInterpretationTip };
  }
  if (record.questionStatus === "resolved") {
    return { label: t.kindResolved, tone: "ok", tooltip: t.kindResolvedTip };
  }
  if (record.questionStatus === "followUp") {
    return { label: t.kindFollowUp, tone: "warn", tooltip: t.kindFollowUpTip };
  }
  return { label: t.kindNote, tone: "mute", tooltip: t.kindNoteTip };
}

function diaryItem(record: DiaryRecord, s: Strings): string {
  const kind = diaryKind(record, s);
  const text = record.text.length > 320 ? `${record.text.slice(0, 320)}…` : record.text;
  return `<li class="diary-item">
  <div class="diary-meta">${pill(kind.label, kind.tone, kind.tooltip)}
    <span class="diary-where">${esc(diaryWhere(record))}</span>
    <span class="diary-time">${esc(shortTs(record.ts))}</span>
    <a class="diary-source" href="/open?rel=${encodeURIComponent(record.rel)}" title="${esc(
      s.health.openTip(record.rel),
    )}">${esc(s.health.sourceLink)}</a>
  </div>
  <div class="diary-text">${esc(text)}</div>
</li>`;
}

function diaryList(records: DiaryRecord[], visible: number, s: Strings): string {
  if (records.length === 0) return `<p class="note">${esc(s.health.noRecords)}</p>`;
  const shown = records.slice(0, visible);
  const rest = records.slice(visible);
  const item = (r: DiaryRecord) => diaryItem(r, s);
  return `<ul class="diary-list">${shown.map(item).join("")}</ul>${
    rest.length > 0
      ? `<details class="diary-more"><summary>${esc(s.health.more(rest.length))}</summary>
  <ul class="diary-list">${rest.map(item).join("")}</ul></details>`
      : ""
  }`;
}

interface DiaryStageRollup {
  label: string;
  decision: number;
  deviation: number;
  followUp: number;
  resolved: number;
  note: number;
  latest: string;
}

function diaryStageTable(records: DiaryRecord[], s: Strings): string {
  const grouped = new Map<string, DiaryStageRollup>();
  for (const record of records) {
    const key = `${record.phase}/${record.unit ?? ""}/${record.stage}`;
    let row = grouped.get(key);
    if (!row) {
      row = {
        label: diaryWhere(record),
        decision: 0,
        deviation: 0,
        followUp: 0,
        resolved: 0,
        note: 0,
        latest: "",
      };
      grouped.set(key, row);
    }
    if (record.axis === "interpretations" || record.axis === "tradeoffs") row.decision++;
    else if (record.axis === "deviations") row.deviation++;
    else if (record.questionStatus === "followUp") row.followUp++;
    else if (record.questionStatus === "resolved") row.resolved++;
    else row.note++;
    if ((record.ts ?? "") > row.latest) row.latest = record.ts ?? "";
  }
  const rows = [...grouped.values()]
    .sort((a, b) => b.latest.localeCompare(a.latest) || a.label.localeCompare(b.label))
    .map((row) => {
      const total = row.decision + row.deviation + row.followUp + row.resolved + row.note;
      return `<tr><th class="g-name">${esc(row.label)}</th>
  <td class="g-n">${row.decision || ""}</td><td class="g-n">${row.deviation || ""}</td>
  <td class="g-n">${row.followUp || ""}</td><td class="g-n">${row.resolved || ""}</td>
  <td class="g-n">${row.note || ""}</td><td class="g-n">${total}</td></tr>`;
    })
    .join("");
  const t = s.health;
  return `<details class="diary-audit"><summary>${esc(t.stageRollup(records.length))}</summary>
  <div class="diary-table-wrap"><table class="tbl diary-table">
    <thead><tr><th>${esc(t.colStage)}</th><th>${esc(t.colDecision)}</th><th>${esc(
      t.colDeviation,
    )}</th><th>${esc(t.colFollowUp)}</th><th>${esc(t.colResolved)}</th><th>${esc(
      t.colNote,
    )}</th><th>${esc(t.colTotal)}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</details>`;
}

function diaryBody(m: DashboardModel, s: Strings): string {
  const t = s.health;
  const d = m.diaries;
  if (d.stages.length === 0) return `<p class="note">${esc(t.noDiaryFiles)}</p>`;
  if (d.records.length === 0) return `<p class="note">${esc(t.noDiaryRecords)}</p>`;

  const newest = (records: DiaryRecord[]) => [...records].reverse();
  const followUps = newest(
    d.records.filter(
      (record) => record.axis === "openQuestions" && record.questionStatus === "followUp",
    ),
  );
  const resolved = newest(
    d.records.filter(
      (record) => record.axis === "openQuestions" && record.questionStatus === "resolved",
    ),
  );
  const decisions = newest(
    d.records.filter((record) => record.axis === "interpretations" || record.axis === "tradeoffs"),
  );
  const deviations = newest(d.records.filter((record) => record.axis === "deviations"));

  const kpis = `<div class="diary-stats">
  <div class="diary-stat ${followUps.length > 0 ? "warn" : "ok"}"><span class="diary-stat-n">${
    followUps.length
  }</span><span class="diary-stat-l">${esc(t.statFollowUp)}</span></div>
  <div class="diary-stat ok"><span class="diary-stat-n">${resolved.length}</span><span class="diary-stat-l">${esc(t.statResolved)}</span></div>
  <div class="diary-stat"><span class="diary-stat-n">${deviations.length}</span><span class="diary-stat-l">${esc(t.statDeviation)}</span></div>
  <div class="diary-stat"><span class="diary-stat-n">${decisions.length}</span><span class="diary-stat-l">${esc(t.statDecision)}</span></div>
</div>`;

  const followUpBody =
    followUps.length > 0
      ? diaryList(followUps, 6, s)
      : `<p class="note">${pill(t.tidyPill, "ok", t.tidyPillTip)} ${esc(t.tidyNote)}</p>`;

  return `${kpis}
<div class="diary-focus">
  <h3>${esc(t.headingFollowUp)}</h3>
  ${followUpBody}
</div>
<div class="diary-columns">
  <div class="diary-group"><h3>${esc(t.headingRecentDecisions)}</h3>${diaryList(decisions, 4, s)}</div>
  <div class="diary-group"><h3>${esc(t.headingRecentDeviations)}</h3>${diaryList(deviations, 4, s)}</div>
</div>
${
  resolved.length > 0
    ? `<details class="diary-resolved"><summary>${esc(
        t.resolvedRecords(resolved.length),
      )}</summary>${diaryList(resolved, 6, s)}</details>`
    : ""
}
${diaryStageTable(d.records, s)}`;
}

function streamBody(m: DashboardModel, s: Strings): string {
  const t = s.health;
  if (m.recentEvents.length === 0) return `<p class="note">${esc(t.emptyLedger)}</p>`;

  const opts = m.eventCounts
    .map(([k, v]) => `<option value="${esc(k)}">${esc(k)} (${v})</option>`)
    .join("");

  const rows = m.recentEvents
    .map(
      (e) =>
        `<tr data-ev="${esc(e.event)}">
  <td class="ts">${esc(shortTs(e.ts))}</td>
  <td><code class="ev">${esc(e.event)}</code></td>
  <td>${esc(e.unit ? `${e.unit} / ${e.stage ?? ""}` : (e.stage ?? ""))}</td>
  <td class="det">${esc(e.detail && e.detail.length > 160 ? `${e.detail.slice(0, 160)}…` : (e.detail ?? ""))}</td>
</tr>`,
    )
    .join("\n");

  const shards = new Set(m.recentEvents.map((e) => e.shard)).size;
  return `<div class="filter-row">
  <label>${esc(t.filterLabel)} <select id="ev-filter"><option value="">${esc(
    t.filterAll(m.totalEvents),
  )}</option>${opts}</select></label>
  <span class="mute">${esc(t.streamMeta(m.recentEvents.length, m.totalEvents, shards))}</span>
</div>
<table class="tbl stream" id="ev-table">
  <thead><tr><th>${esc(t.colTime)}</th><th>${esc(t.colEvent)}</th><th>${esc(
    t.colStageUnit,
  )}</th><th>${esc(t.colDetail)}</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

// Both panels in this module are BUILT but not MOUNTED. Flip a flag to re-mount
// one with no other edit; referencing the builders here (rather than deleting the
// calls) is what keeps them live code the type-checker still covers.
//
// SHOW_STREAM — the raw event list is noise for the people this dashboard is shown to.
//
// SHOW_DIARY — 결정과 이슈 was the decision panel until 미뤄둔 결정 (render/deferrals.ts)
// replaced it. It read `memory.md`, which records what the ORCHESTRATOR thought, and
// on one real run that came to 140 결정 근거 · 63 계획 변경 · 28 후속 확인 — three digits of
// prose in which nothing stated what the run still owed the reader or where it would
// be asked again. The deferral ledger answers that from the engine's own mandated
// section, with an assigned stage per item, so the two panels were not two views of
// one thing: one of them was the question the reader actually had. `m.diaries` stays
// in the model for /api/model, on the same footing as sensors, gates and hook health.
// ONE AXIS OF IT DID COME BACK, and not here: `## Open questions` is mandated in every
// stage's memory.md by the engine's own memory template, and its entries do state a
// debt ("재스캔 비용을 받아들일지 … 결정할 것"). It renders inside 미뤄둔 결정
// (render/deferrals.ts, diaryOpenBlock) beside the other two ledgers, because that is
// the panel answering the question those entries belong to. The other three axes are
// what stays unmounted — mixing them back in is what made this card unreadable.
const SHOW_STREAM = false;
const SHOW_DIARY = false;

export function renderHealth(m: DashboardModel, s: Strings): string {
  return [
    ...(SHOW_DIARY ? [section(s.health.sectionDiary, diaryBody(m, s), "decisions")] : []),
    ...(SHOW_STREAM ? [section(s.health.sectionStream, streamBody(m, s), "stream")] : []),
  ].join("\n");
}
