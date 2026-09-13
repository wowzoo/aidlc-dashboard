// Panel (c) — where the wall-clock went.
//
// Every second belongs to one visible bucket: user wait, parked, observed
// execution, or unknown. Unknown is deliberately not painted as execution.

import type { DashboardModel } from "../model/types";
import type { GapSplit, StageEndKind, StageSpan, TimingReport } from "../scan/timing";
import { esc, hours, mins, pill, section, shortTs } from "./common";
import type { Strings } from "./i18n";

/** Track offset+width as percentages of the whole run, for the gantt row. */
function trackGeometry(
  startedAt: string,
  elapsedSec: number,
  runStart: number,
  runSpan: number,
): { left: number; width: number; tick: boolean } {
  if (runSpan <= 0) return { left: 0, width: 100, tick: false };
  const left = ((Date.parse(startedAt) - runStart) / 1000 / runSpan) * 100;
  const width = (elapsedSec / runSpan) * 100;
  // A 0-second stage is normal (the three bootstrap stages stamp STARTED and
  // COMPLETED in the same second), but the 0.4% floor that keeps a bar visible is
  // worth 31 minutes on a 130h run — enough to make `workspace-scaffold` (0.0min) as
  // wide as `scope-definition` (29.9min), and to stack the three bootstrap bars into
  // one indistinguishable blob. So a zero-length stage gets a tick, not a bar.
  if (elapsedSec <= 0) return { left: Math.max(0, left), width: 0, tick: true };
  return { left: Math.max(0, left), width: Math.max(0.4, width), tick: false };
}

function kindClass(kind: StageEndKind): string {
  if (kind === "completed") return "done";
  if (kind === "skipped") return "skip";
  if (kind === "awaiting-approval") return "await";
  if (kind === "superseded") return "sup";
  return "live";
}

/** One segment's own split, so the tooltip describes the bar under the cursor. */
function segmentTip(
  stage: string,
  g: GapSplit & { startedAt: string; endedAt: string; endKind: StageEndKind },
  s: Strings,
): string {
  const t = s.timeline;
  return t.segmentTip(
    stage,
    t.endKinds[g.endKind],
    shortTs(g.startedAt),
    shortTs(g.endedAt),
    t.splitLine(
      mins(g.humanWaitSec),
      mins(g.parkedSec),
      mins(g.observedSec),
      mins(g.conversationSec),
      mins(g.unknownSec),
    ),
  );
}

function ganttRow(sp: StageSpan, runStart: number, runSpan: number, s: Strings): string {
  const bars = sp.segments
    .map((segment) => {
      const g = trackGeometry(segment.startedAt, segment.elapsedSec, runStart, runSpan);
      // FILL THE BAR WITH THE SPLIT, not with the end kind. Bar width is calendar
      // occupancy, and on a real run the widest stage (30.6% of the track) was 93.8%
      // parked and ranked 16th of 22 in observed execution — so colouring by end kind
      // made a night of waiting look identical to a night of work. End kind moves to
      // the outline; the four buckets are the fill.
      const total =
        segment.humanWaitSec +
        segment.parkedSec +
        segment.observedSec +
        segment.conversationSec +
        segment.unknownSec;
      const fill =
        total > 0
          ? (
              [
                ["wait", segment.humanWaitSec],
                ["parked", segment.parkedSec],
                ["observed", segment.observedSec],
                ["conv", segment.conversationSec],
                ["unknown", segment.unknownSec],
              ] as const
            )
              .filter(([, sec]) => sec > 0)
              .map(
                ([kind, sec]) =>
                  `<i class="${kind}" style="width:${((sec / total) * 100).toFixed(2)}%"></i>`,
              )
              .join("")
          : "";
      if (g.tick) {
        return `<span class="g-tick k-${kindClass(segment.endKind)}" style="left:${g.left.toFixed(
          2,
        )}%" title="${esc(
          `${segmentTip(sp.stage, segment, s)}\n${s.timeline.zeroSecondTip}`,
        )}"></span>`;
      }
      return `<span class="g-bar k-${kindClass(segment.endKind)}" style="left:${g.left.toFixed(
        2,
      )}%;width:${g.width.toFixed(2)}%" title="${esc(
        segmentTip(sp.stage, segment, s),
      )}">${fill}</span>`;
    })
    .join("");
  // Abbreviated so the column stays one line; the full text is the cell tooltip.
  const t = s.timeline;
  const load = [
    sp.workload.artifacts ? t.loadArtifacts(sp.workload.artifacts) : "",
    // `sensor` is the engine's own noun and reads the same in both languages.
    sp.workload.sensors ? `sensor ${sp.workload.sensors}` : "",
    // Sensor failures were tallied and then dropped here; on a real run that hid 84.
    sp.workload.sensorFailures ? t.loadFailures(sp.workload.sensorFailures) : "",
    sp.workload.delegations ? t.loadDelegations(sp.workload.delegations) : "",
    sp.workload.humanTurns ? t.loadHumanTurns(sp.workload.humanTurns) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<tr>
  <th class="g-name">${esc(sp.stage)}</th>
  <td class="g-track"><div class="g-track-line">${bars}</div></td>
  <td class="g-n">${esc(mins(sp.elapsedSec))}</td>
  <td class="g-n wait">${esc(mins(sp.humanWaitSec))}</td>
  <td class="g-n parked">${esc(mins(sp.parkedSec))}</td>
  <td class="g-n work">${esc(mins(sp.observedSec))}</td>
  <td class="g-n conv">${esc(mins(sp.conversationSec))}</td>
  <td class="g-n unknown">${esc(mins(sp.unknownSec))}</td>
  <td class="g-n attn"><b>${esc(mins(sp.workSec))}</b></td>
  <td class="g-load" title="${esc(load)}">${esc(load)}</td>
</tr>`;
}

function pct(value: number, total: number): string {
  return total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
}

/**
 * Rework — the ledger's most valuable signal and, until now, the one the panel was
 * silent about. `m.gates` counted the events and no render module read it, so a run
 * with 11 rejections and 18.9h of redone work looked identical to one with none.
 *
 * The rejection reason is shown verbatim: it is a human's own sentence about what was
 * wrong, which no aggregate can replace.
 */
function reworkBlock(m: DashboardModel, classifiedSec: number, s: Strings): string {
  const t = s.timeline;
  const r = m.rework;
  if (r.rejected === 0 && r.revisions === 0 && r.jumps === 0) {
    return `<p class="note">${esc(t.reworkNone)}</p>`;
  }
  const share = classifiedSec > 0 ? pct(r.reworkSec, classifiedSec) : "0.0";
  const rows = r.stages
    .map((st) => {
      return `<tr>
  <th class="g-name">${esc(st.stage)}${
    st.settled ? "" : `<span class="prov-mark" title="${esc(t.reworkProvisionalTip)}">~</span>`
  }</th>
  <td class="g-n">${esc(String(st.submissions || "—"))}</td>
  <td class="g-n unknown"><b>${esc(String(st.rejections))}</b></td>
  <td class="g-n">${esc(String(st.revisions || "—"))}${
    st.revisionHigh ? `<span class="mute"> /${esc(String(st.revisionHigh))}</span>` : ""
  }</td>
  <td class="g-n"><b>${esc(hours(st.reworkSec))}</b></td>
  <td class="g-n">${st.feedback.length > 0 ? esc(t.feedbackCount(st.feedback.length)) : "—"}</td>
</tr>`;
    })
    .join("\n");

  // The reason goes UNDER the table, at full card width. It is a human's dense
  // paragraph — 1042 characters on one measured rejection, no line breaks — and a
  // table cell competing with five numeric columns is the wrong container for it
  // twice over: the cell clamped it visually AND the renderer sliced it at 400
  // characters, dropping 642 of those 1042 without a mark to say so. "Shown
  // verbatim" has to mean the whole thing, so nothing is sliced here.
  const reasons = r.stages
    .filter((st) => st.feedback.length > 0)
    .flatMap((st) =>
      st.feedback.map(
        (f) => `<li class="why-item">
  <div class="why-head"><b>${esc(st.stage)}</b><span class="mute">${esc(shortTs(f.at))}</span></div>
  <p class="why-text">${esc(f.text)}</p>
</li>`,
      ),
    )
    .join("");
  const reasonBlock = reasons
    ? `<details class="why-all"><summary>${esc(
        t.reasonsSummary(r.stages.reduce((n, st) => n + st.feedback.length, 0)),
      )}</summary>
  <p class="note">${t.reasonsNote}</p>
  <ul class="why-list">${reasons}</ul>
</details>`
    : "";

  return `<div class="time-stats">
  <div class="unknown"><span class="time-stat-n">${esc(hours(r.reworkSec))}</span><span class="time-stat-l">${esc(
    t.reworkStatShare(share),
  )}</span></div>
  <div><span class="time-stat-n">${r.rejected}</span><span class="time-stat-l">${esc(t.statRejected)}</span></div>
  <div><span class="time-stat-n">${r.approved}</span><span class="time-stat-l">${esc(t.statApproved)}</span></div>
  <div><span class="time-stat-n">${r.revisions}</span><span class="time-stat-l">${esc(t.statRevisions)}</span></div>
  ${r.jumps ? `<div><span class="time-stat-n">${r.jumps}</span><span class="time-stat-l">${esc(t.statJumps)}</span></div>` : ""}
  ${r.freezeBlocked ? `<div><span class="time-stat-n">${r.freezeBlocked}</span><span class="time-stat-l">${esc(t.statFreezeBlocked)}</span></div>` : ""}
</div>
<div class="timeline-table-wrap"><table class="tbl">
  <thead><tr><th>${esc(t.colStage)}</th><th title="${esc(t.colSubmissionsTip)}">${esc(
    t.colSubmissions,
  )}</th><th>${esc(t.colRejections)}</th><th title="${esc(t.colRevisionsTip)}">${esc(
    t.colRevisions,
  )}</th><th title="${esc(t.colReworkTip)}">${esc(t.colRework)}</th><th title="${esc(
    t.colReasonTip,
  )}">${esc(t.colReason)}</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
${reasonBlock}
<p class="note">${t.reworkNote(share, esc(hours(classifiedSec)), r.provisional)}</p>`;
}

/**
 * The five buckets: one bar plus a legend that carries BOTH the hours and the share.
 *
 * The hours used to live in a tile strip above the bar — six equal tiles holding the
 * window total and its five parts, which made the whole look like a sixth part and
 * invited an addition that does not work (the five sum to the CLASSIFIED span, 52.1h,
 * not to the 57.2h window; the 4.7h of 무기록 is in neither). The tiles also duplicated
 * this legend, which already listed all five, and the sixth tile wrapped onto a row of
 * its own. So the total is now a headline (it is the denominator, not a part) and the
 * hours moved down here, next to the share they belong to.
 */
function breakdown(split: GapSplit, total: number, s: Strings): string {
  const t = s.timeline;
  const parts = [
    ["wait", t.bucketWait, split.humanWaitSec, t.bucketWaitTip],
    ["parked", t.bucketParked, split.parkedSec, t.bucketParkedTip],
    ["observed", t.bucketObserved, split.observedSec, t.bucketObservedTip],
    ["conv", t.bucketConversation, split.conversationSec, t.bucketConversationTip],
    ["unknown", t.bucketUnknown, split.unknownSec, t.bucketUnknownTip],
  ] as const;
  return `<div class="time-breakdown" role="img" aria-label="${esc(
    parts.map(([, label, seconds]) => `${label} ${pct(seconds, total)}%`).join(", "),
  )}">
${parts
  .filter(([, , seconds]) => seconds > 0)
  .map(
    ([kind, label, seconds]) =>
      `<span class="${kind}" style="width:${pct(seconds, total)}%" title="${esc(
        `${label} ${hours(seconds)} (${pct(seconds, total)}%)`,
      )}"></span>`,
  )
  .join("")}
</div>
<div class="time-legend">
${parts
  .map(
    ([kind, label, seconds, tip]) =>
      `<span class="lgi" title="${esc(tip)}"><i class="${kind}"></i><b class="${kind}">${esc(
        hours(seconds),
      )}</b> ${esc(label)} <span class="mute">${esc(pct(seconds, total))}%</span></span>`,
  )
  .join("")}
</div>`;
}

/**
 * The per-worker table, shown only for a parallel run.
 *
 * WHY BOTH NUMBERS ARE KEPT. The merged and per-worker idle figures measure
 * different things, and NEITHER dominates the other — both directions were
 * measured:
 *
 *   - merged UNDER-reports when clones overlap: while A waits at a gate, B's
 *     events land inside that gap, so the gate→HUMAN_TURN pair is no longer
 *     adjacent and the wait reads as work. On a real 4-developer run this lost
 *     69% of the waiting (819 min merged vs 2,632 min per-worker).
 *   - merged OVER-reports at a handoff: A's SESSION_ENDED followed 45 min later
 *     by B's SESSION_STARTED is a real team-wide pause, but it belongs to neither
 *     shard's own timeline, so per-worker misses it entirely.
 *
 * So: merged idle = "nobody on the team was working"; per-worker idle = "how long
 * each person waited". Both are shown, labelled for what they are, and the delta
 * is described in whichever direction it actually falls.
 */
function workerTable(t: TimingReport, s: Strings): string {
  if (!t.parallel) return "";
  const x = s.timeline;

  const rows = t.workers
    .map((w) => {
      const lead = w.gatesApproved > 0;
      return `<tr>
  <th class="g-name">${esc(w.label)}${
    lead ? ` <span class="tag-lead" title="${esc(x.leadTagTip)}">${esc(x.leadTag)}</span>` : ""
  }</th>
  <td class="g-n">${w.events}</td>
  <td class="g-n">${esc(mins(w.elapsedSec))}</td>
  <td class="g-n wait">${esc(mins(w.humanWaitSec))}</td>
  <td class="g-n parked">${esc(mins(w.parkedSec))}</td>
  <td class="g-n work">${esc(mins(w.observedSec))}</td>
  <td class="g-n conv">${esc(mins(w.conversationSec))}</td>
  <td class="g-n unknown">${esc(mins(w.unknownSec))}</td>
  <td class="g-n">${w.gatesApproved || ""}</td>
  <td class="g-load" title="${esc(w.stages.join(", "))}">${esc(w.stages.slice(0, 2).join(", "))}</td>
  <td class="g-n" title="${esc(w.units.join(", ") || x.noUnitAttribution)}">${
    w.units.length || "—"
  }</td>
</tr>`;
    })
    .join("\n");

  const par = t.parallelism;
  const delta = t.personIdleSec - t.total.idleSec;
  // WHY THE TWO FIGURES DIFFER, stated from what was measured rather than assumed.
  // The old wording blamed interleaving ("someone else's events filled my wait")
  // unconditionally; on a run whose clones never overlap that is impossible, and the
  // real cause there is the handover gap. So the reason is chosen by overlap.
  const deltaNote =
    Math.abs(delta) <= 60
      ? esc(x.deltaSame)
      : t.overlapSec > 0
        ? delta > 0
          ? x.deltaOverlapUnder(esc(hours(delta)), esc(hours(t.overlapSec)))
          : x.deltaOverlapOver(esc(hours(-delta)))
        : delta > 0
          ? x.deltaHandoverUnder(esc(hours(delta)))
          : x.deltaHandoverOver(esc(hours(-delta)), esc(hours(t.handoverSec)));

  // "병렬" is a claim about time, so it is made only when the windows actually
  // overlap. Measured on a real 3-shard run: 0 overlap, i.e. a sequential handover.
  const shapeLabel =
    t.overlapSec > 0
      ? x.workerShapeOverlap(t.clones, esc(hours(t.overlapSec)))
      : x.workerShapeSequential(
          t.clones,
          t.handoverSec > 60 ? esc(hours(t.handoverSec)) : undefined,
        );
  const hostNote =
    t.workers.length > t.clones
      ? `<p class="note">${x.hostNote(t.workers.length, t.clones)}</p>`
      : "";
  const parkedOut = t.workers.filter((w) => w.endedParked);

  return `<details open><summary>${esc(x.workerSummary(shapeLabel))}</summary>
<div class="worker-stats">
  <span><b>${esc(hours(t.personElapsedSec))}</b> ${esc(x.personTotal)}</span>
  <span><b>${esc(hours(t.personHumanWaitSec))}</b> ${esc(x.bucketWait)}</span>
  <span><b>${esc(hours(t.personParkedSec))}</b> ${esc(x.bucketParked)}</span>
  <span><b>${esc(hours(t.personObservedSec))}</b> ${esc(x.bucketObserved)}</span>
  <span><b>${esc(hours(t.personConversationSec))}</b> ${esc(x.bucketConversation)}</span>
  <span><b>${esc(hours(t.personUnknownSec))}</b> ${esc(x.bucketUnknown)}</span>
  ${par ? `<span><b>${esc(par.toFixed(2))}×</b> ${esc(x.personParallelism)}</span>` : ""}
</div>
<div class="timeline-table-wrap"><table class="tbl">
  <thead><tr><th>${esc(x.colClone)}</th><th>${esc(x.colEvents)}</th><th>${esc(
    x.colSpanMin,
  )}</th><th>${esc(x.colWait)}</th><th>${esc(x.colParked)}</th><th>${esc(
    x.colObserved,
  )}</th><th>${esc(x.colConversation)}</th><th>${esc(x.colUnknown)}</th><th>${esc(
    x.colGates,
  )}</th><th>${esc(x.colMainStage)}</th><th>${esc(x.colUnits)}</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="note">${x.workerNote(esc(hours(t.total.idleSec)), deltaNote)}</p>
${hostNote}
${
  parkedOut.length
    ? `<p class="note warn">${parkedOut
        .map((w) => x.endedParked(esc(w.label), esc(shortTs(w.lastTs))))
        .join(" · ")}${esc(x.endedParkedTail)}</p>`
    : ""
}
${par ? `<p class="note">${x.parallelismNote}</p>` : ""}
<p class="note">${x.unitColumnNote}</p>
</details>`;
}

/**
 * A time axis for the Gantt track, plus the read clock at the right edge.
 *
 * Without it the last bar always touches the right edge, which reads as "the run
 * finished here" on a run that is merely open — and the stretch after the last event
 * (which bars no longer cover, since 1차) had nothing to name it.
 */
function trackAxis(t: TimingReport, runStart: number, runSpan: number, s: Strings): string {
  if (!t.firstTs || runSpan <= 0) return "";
  const ticks = 4;
  const marks: string[] = [];
  for (let i = 0; i <= ticks; i++) {
    const at = new Date(runStart + (runSpan * 1000 * i) / ticks);
    const label = `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    marks.push(
      `<span class="ax-t" style="left:${((i / ticks) * 100).toFixed(2)}%">${esc(label)}</span>`,
    );
  }
  // The silence gets its own shaded band so it is visibly outside the bars.
  const silence =
    t.sinceLastEventSec > 0
      ? `<span class="ax-gap" style="left:${(
          ((runSpan - t.sinceLastEventSec) / runSpan) * 100
        ).toFixed(2)}%;width:${((t.sinceLastEventSec / runSpan) * 100).toFixed(2)}%" title="${esc(
          s.timeline.axisSilenceTip(hours(t.sinceLastEventSec)),
        )}"></span>`
      : "";
  return `<div class="g-axis">${silence}${marks.join("")}</div>`;
}

function body(m: DashboardModel, s: Strings): string {
  const x = s.timeline;
  const t = m.timing;
  if (t.stages.length === 0 || !t.firstTs) return `<p class="note">${esc(x.noStageSpans)}</p>`;

  const runStart = Date.parse(t.firstTs);
  const runSpan = t.elapsedSec;

  // WHAT IS THE RUN WAITING ON — said out loud rather than left to be inferred from
  // the rightmost bar. `awaitingStage` is undefined on a run that never emitted
  // STAGE_AWAITING_APPROVAL for its current stage, and silence there is what made a
  // reader guess from bar colour.
  const inFlight = t.stages.filter((s) => s.endKind === "in-flight");
  const nowLine = `<p class="note">${
    inFlight.length
      ? x.inFlight(
          inFlight.map((sp) => `<b>${esc(sp.stage)}</b> ${esc(hours(sp.elapsedSec))}`).join(" · "),
        )
      : esc(x.noneInFlight)
  } · ${t.awaitingStage ? x.awaiting(esc(t.awaitingStage)) : x.awaitingNone}${
    m.rework.provisional ? esc(x.reworkPending) : ""
  }</p>`;

  // On a multi-clone run the merged split is not a per-person figure.
  const mergedNote = t.parallel
    ? `<p class="note warn">${x.mergedNote(t.workers.length, t.clones)}</p>`
    : "";

  // The window total is the DENOMINATOR of everything below it, not a sixth bucket, so
  // it stands alone. `분류 대상` is stated beside it because that — not the window — is
  // what the percentages divide by. The gap between the two is the 무기록 stretch, and
  // that is named ONCE, in the date-range note below: the pill lives next to the last
  // event, which is what it is about. Saying it here as well put the same fact twice
  // within five lines. The number still has to be stated somewhere — an open run's
  // window grows on every poll while the ledger does not — but once is enough.
  const classified = runSpan - t.sinceLastEventSec;
  const kpis = `<div class="time-head">
  <span class="time-head-n" title="${esc(
    t.sinceLastEventSec > 0 ? x.windowTipOpen(hours(t.sinceLastEventSec)) : x.windowTipClosed,
  )}">${esc(hours(runSpan))}</span>
  <span class="time-head-l">${esc(t.parallel ? x.windowTeam : x.windowSolo)}</span>
  <span class="time-head-sub">${x.windowSub(esc(hours(classified)))}</span>
</div>
${
  // The percentages are OF THE CLASSIFIED SPAN, not of the window: nothing past the
  // last event is classified, so dividing by the window would make the five shares
  // shrink every poll on a quiet tree and never reach 100%.
  breakdown(t.total, classified, s)
}
<p class="note">${esc(shortTs(t.firstTs))} ~ ${esc(shortTs(t.lastEventTs ?? t.lastTs))}${
    // The window of an open run ends at the read clock, so it keeps growing while
    // nothing happens — name that stretch instead of folding it into the span.
    t.sinceLastEventSec > 0
      ? ` · ${pill(x.unrecordedPill(hours(t.sinceLastEventSec)), "warn")}`
      : ""
  }${t.parallel ? ` · ${pill(x.clonesPill(t.clones), "warn")}` : ""}${esc(
    x.delegated(hours(t.total.delegatedSec)),
  )}</p>
${nowLine}
${mergedNote}
<details${m.rework.rejected > 0 ? " open" : ""}><summary>${esc(
    x.reworkSummary(m.rework.rejected, hours(m.rework.reworkSec)),
  )}</summary>
${reworkBlock(m, runSpan - t.sinceLastEventSec, s)}
</details>
${workerTable(t, s)}`;

  const rows = t.stages.map((sp) => ganttRow(sp, runStart, runSpan, s)).join("\n");

  // The long unclassified gaps, surfaced rather than folded silently into WORK.
  // WHICH STAGE WAS THIS GAP IN. The span itself carries only its two event names, so
  // "18 minutes between two artifact writes" was unactionable — the reader could not
  // tell which part of the run to go look at. The stage whose segment contains the
  // timestamp is derivable from data already on the page, so derive it.
  const stageAt = (ts: string): string | undefined =>
    t.stages.find((s) => s.segments.some((g) => ts >= g.startedAt && ts <= g.endedAt))?.stage;
  const unknown = [...t.total.unknown]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 12)
    .map((g) => {
      const stage = stageAt(g.at);
      return `<li><b>${esc(x.minutes(mins(g.seconds)))}</b> ${
        stage ? `<span class="g-where">${esc(stage)}</span>` : ""
      } <code>${esc(g.fromEvent)} → ${esc(g.toEvent)}</code> <span class="mute">${esc(
        shortTs(g.at),
      )}</span></li>`;
    })
    .join("");

  return `${kpis}
<div class="timeline-table-wrap"><table class="tbl gantt">
  <thead><tr><th>${esc(x.colStage)}</th><th class="g-track-h">${esc(x.colTrack)}${trackAxis(
    t,
    runStart,
    runSpan,
    s,
  )}</th><th>${esc(x.colTotalMin)}</th><th>${esc(x.colWait)}</th><th>${esc(
    x.colParked,
  )}</th><th>${esc(x.colObserved)}</th><th title="${esc(x.colConversationTip)}">${esc(
    x.colConversation,
  )}</th><th>${esc(x.colUnknown)}</th><th title="${esc(x.colWorkEstimateTip)}">${esc(
    x.colWorkEstimate,
  )}</th><th>${esc(x.colWorkload)}</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="note">${x.ganttLegend}</p>
<p class="note warn">${x.observedCaveat}</p>
${
  unknown
    ? `<details><summary>${esc(
        x.unknownGapsSummary(t.total.unknown.length),
      )}</summary><ul class="gaps">${unknown}</ul>
<p class="note">${esc(x.unknownGapsNote)}</p></details>`
    : ""
}
${
  t.total.inferredParkSec > 0 || t.total.parkAnomalies > 0
    ? `<p class="note warn">${esc(
        x.inferredPark(hours(t.total.inferredParkSec), t.total.parkAnomalies),
      )}</p>`
    : ""
}`;
}

export function renderTimeline(m: DashboardModel, s: Strings): string {
  return section(s.timeline.section, body(m, s), "timeline");
}
