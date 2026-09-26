// The KPI strip under the run line, and the one chart the selected tile drives.
//
// THREE TILES, EACH FROM ONE SOURCE. Progress is state.md's checkbox count, usage is
// the harness's own usage source (Kiro credits over ACP, or Claude Code's measured
// tokens), and time is the audit ledger's classified work + conversation. Each tile
// names its source, and none is combined with another into a score.
//
// The time figure is `total.observedSec + total.conversationSec` over the MERGED
// timeline — the same basis as the Stage card and the timeline panel, so the three
// agree on one screen. It is not wall-clock time, and it leaves out human waits,
// parked time and unclassified gaps; the unclassified part is stated under the tile
// rather than dropped silently. On a multi-shard run merged time is the team's clock,
// not the sum of people's, so person-time is stated beside it — the same condition
// the timeline panel uses for its merged-view note.
//
// Claude Code has no local limit, so its usage tile shows measured tokens and never
// a percentage (AGENTS.md "Usage panel").
//
// SELECTION IS A RADIO GROUP, like the card tabs (render/card-kit.ts): the inputs
// carry the `mc-r` class, so page.ts's poll restores the reader's pick with no code
// of its own, and the chart is switched by CSS alone.
//
// Both timing charts share one time axis: the recorded span, then a band for the
// stretch after the last event, labelled with its length. Without that band the last
// bar touches the right edge and reads as "the run ended here" (the same rule as the
// timeline track); see `axisOf` for why the band has a fixed width.

import { buildAriaLabel, renderLineChart } from "../credit/view/svg-chart";
import type { DashboardModel } from "../model/types";
import type { TimeBin, TimingReport } from "../scan/timing";
import { BIN_SEC } from "../scan/timing";
import { esc, hours } from "./common";
import type { Strings } from "./i18n";

/** Number of tiles; KPI_CSS is generated for exactly this many positions. */
const TILES = 3;

// Close to the chart's rendered width on a laptop screen, so 11-unit text renders near
// 11px instead of being scaled up with the whole drawing.
const W = 1160;
const H = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 44 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

interface Tile {
  label: string;
  value: string;
  sub: string;
  /** Second small line — an exclusion or a caveat. */
  note?: string;
  tip?: string;
  /** Dashed: the tile has no record behind it, which must not read as a figure. */
  missing?: boolean;
  chart: string;
}

/** Locale-independent compact count: 12,345,678 → 12.3M. */
function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** `MM-DD` in local time — the timeline axis uses the same form. */
function day(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `MM-DD HH:00` in local time, for a bin's hover text and short-span ticks. */
function dayHour(ms: number): string {
  return `${day(ms)} ${String(new Date(ms).getHours()).padStart(2, "0")}:00`;
}
const binStart = (iso: string) => dayHour(Date.parse(iso));

/** Width of the band standing for the silence after the last event, in SVG units. */
const SILENCE_W = 64;

interface Axis {
  from: number;
  /** End of the RECORDED span: the last event. */
  to: number;
  /** Right edge of the recorded span in SVG units; the silence band starts here. */
  recordedRight: number;
  xOf(ms: number): number;
}

/**
 * The time axis covers what the ledger recorded — first event to LAST EVENT — and the
 * silence after it gets a FIXED-WIDTH band rather than its true length. At true scale
 * a tree opened weeks after its last event would draw its whole run as a sliver at the
 * left edge; the band's label states the real length instead, so the scale break is
 * said, not hidden. The axis ends at the last event and not at the end of its bin:
 * the rest of that bin is silence too, and drawing it inside the recorded span would
 * pass it off as recorded time.
 */
function axisOf(t: TimingReport): Axis | undefined {
  if (t.bins.length === 0 || !t.firstTs || !t.lastEventTs) return undefined;
  const from = Date.parse(t.firstTs);
  // A 0-second run still gets an axis; everything on it lands at the left edge.
  const to = Math.max(Date.parse(t.lastEventTs), from + 1);
  const recordedRight = PAD.left + PLOT_W - (t.sinceLastEventSec > 0 ? SILENCE_W : 0);
  return {
    from,
    to,
    recordedRight,
    xOf: (ms) => PAD.left + ((ms - from) / (to - from)) * (recordedRight - PAD.left),
  };
}

/** Frame, date ticks over the recorded span, and the band after the last event. */
function frame(t: TimingReport, ax: Axis, s: Strings, yTop: string): string {
  const base = PAD.top + PLOT_H;
  // Ticks sit on bin boundaries, which are whole local hours (00/06/12/18), so a label
  // never rounds the time it marks. A span under about four days carries the hour too,
  // or neighbouring ticks repeat the same date.
  const label = ax.to - ax.from < 4 * 86400 * 1000 ? dayHour : day;
  const edges: number[] = [];
  const first = t.bins[0] ? Date.parse(t.bins[0].start) : ax.from;
  for (let ms = first; ms <= ax.to; ms += BIN_SEC * 1000) if (ms >= ax.from) edges.push(ms);
  const step = Math.max(1, Math.ceil(edges.length / 5));
  const ticks: string[] = [];
  for (let k = 0; k < edges.length; k += step) {
    const px = ax.xOf(edges[k] as number);
    const anchor = px < PAD.left + 40 ? "start" : px > ax.recordedRight - 40 ? "end" : "middle";
    ticks.push(
      `<text x="${px.toFixed(1)}" y="${H - 6}" text-anchor="${anchor}" fill="var(--mute)" font-size="11">${esc(label(edges[k] as number))}</text>`,
    );
  }
  let band = "";
  if (t.sinceLastEventSec > 0) {
    const bx = ax.recordedRight + 2;
    const silence = hours(t.sinceLastEventSec);
    band = `<g><title>${esc(s.timeline.axisSilenceTip(silence))}</title><rect class="kpi-silence" x="${bx.toFixed(
      1,
    )}" y="${PAD.top}" width="${SILENCE_W - 2}" height="${PLOT_H}" /><text x="${(
      bx + (SILENCE_W - 2) / 2
    ).toFixed(
      1,
    )}" y="${PAD.top + PLOT_H / 2}" text-anchor="middle" fill="var(--mute)" font-size="11">+${esc(silence)}</text></g>`;
  }
  return [
    band,
    `<line x1="${PAD.left}" y1="${base}" x2="${ax.recordedRight}" y2="${base}" stroke="var(--line)" />`,
    `<text x="${PAD.left - 6}" y="${PAD.top + 9}" text-anchor="end" fill="var(--mute)" font-size="11">${esc(yTop)}</text>`,
    `<text x="${PAD.left - 6}" y="${base}" text-anchor="end" fill="var(--mute)" font-size="11">0</text>`,
    ...ticks,
  ].join("");
}

function svg(aria: string, inner: string): string {
  return `<svg class="kpi-svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(
    aria,
  )}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}

function legend(items: [string, string][]): string {
  return `<div class="kpi-legend">${items
    .map(([cls, label]) => `<span><i class="${cls}"></i>${esc(label)}</span>`)
    .join("")}</div>`;
}

function chartBox(title: string, body: string, note?: string): string {
  return `<div class="kpi-c"><h3>${esc(title)}</h3>${body}${
    note ? `<p class="note">${esc(note)}</p>` : ""
  }</div>`;
}

// ── Progress ─────────────────────────────────────────────────────────────────

/**
 * First completion time of each stage slug, oldest first. A stage re-completed after
 * rework is counted once, at its FIRST completion — the curve answers "when was each
 * stage first finished", and a rework shows up in the timeline's rework block instead.
 */
function completions(t: TimingReport): number[] {
  const out: number[] = [];
  for (const st of t.stages) {
    const done = st.segments.find((g) => g.endKind === "completed");
    if (done) out.push(Date.parse(done.endedAt));
  }
  return out.filter(Number.isFinite).sort((a, b) => a - b);
}

function progressChart(m: DashboardModel, s: Strings): string {
  const t = m.timing;
  const ax = axisOf(t);
  const k = s.kpi;
  if (!ax) return chartBox(k.progressChartTitle, `<p class="note">${esc(k.noEvents)}</p>`);
  const done = completions(t);
  const top = Math.max(done.length, 1);
  const yOf = (n: number) => PAD.top + PLOT_H - (n / top) * PLOT_H;
  // A step, not a slope: the count is constant between completions.
  const pts = [`${ax.xOf(ax.from).toFixed(1)},${yOf(0).toFixed(1)}`];
  done.forEach((ms, i) => {
    pts.push(`${ax.xOf(ms).toFixed(1)},${yOf(i).toFixed(1)}`);
    pts.push(`${ax.xOf(ms).toFixed(1)},${yOf(i + 1).toFixed(1)}`);
  });
  // The line stops at the last event; the band after it says why it goes no further.
  pts.push(`${ax.xOf(ax.to).toFixed(1)},${yOf(done.length).toFixed(1)}`);
  const line = `<polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${pts.join(" ")}" />`;
  return chartBox(
    k.progressChartTitle,
    svg(k.progressChartAria(done.length), frame(t, ax, s, String(top)) + line) +
      legend([["k-silence", k.legendSilence]]),
    k.progressChartNote,
  );
}

function progressTile(m: DashboardModel, s: Strings): Tile {
  const st = m.state;
  return {
    label: s.kpi.progressLabel,
    value: `${st.overallPct}%`,
    sub: s.kpi.progressSub(st.overallDone, st.overallTotal),
    chart: progressChart(m, s),
  };
}

// ── Usage ────────────────────────────────────────────────────────────────────

function windowLong(w: "7d" | "30d" | "all", s: Strings): string {
  return w === "7d"
    ? s.usage.windowLong7d
    : w === "30d"
      ? s.usage.windowLong30d
      : s.usage.windowLongAll;
}

function usageTile(m: DashboardModel, s: Strings): Tile {
  const k = s.kpi;
  const title = m.usage.kind === "claude" ? s.usage.tokenSection : s.usage.creditSection;
  if (m.usage.kind === "claude") {
    const tk = m.usage.tokens;
    const w = windowLong(tk.trend.window, s);
    const sum = tk.trend.summary;
    const aria =
      sum.count === 0
        ? s.usage.tokenChartEmpty(w)
        : s.usage.tokenChartSummary(
            w,
            sum.count,
            compact(sum.min ?? 0),
            compact(sum.max ?? 0),
            compact(sum.latest ?? 0),
          );
    const none = tk.status === "none";
    return {
      label: k.usageLabel,
      value: none ? "—" : compact(tk.grandTotal),
      sub: none ? k.usageNone : k.tokenSub(w),
      missing: none,
      chart: chartBox(
        title,
        renderLineChart(tk.trend, s, { width: W, height: H, ariaLabel: aria }),
      ),
    };
  }
  const cr = m.usage.credit;
  const cur = cr.current;
  const used = cur?.usedAmount ?? null;
  const limit = cur?.planLimit ?? null;
  // The source's own ratio first (ACP's percentage / 100); a ratio of the two measured
  // amounts only when it sent none. Never clamped: an overage is real — measured on
  // one account, 377% with a negative remainder — and a gauge-style cap would hide it.
  const ratio =
    cur?.usageRatio ?? (used !== null && limit !== null && limit > 0 ? used / limit : null);
  const pct = ratio === null || limit === null ? undefined : `${(ratio * 100).toFixed(1)}%`;
  return {
    label: k.usageLabel,
    value: used === null ? "—" : compact(used),
    sub:
      used === null
        ? k.usageNone
        : k.creditSub(limit === null || pct === undefined ? undefined : compact(limit), pct),
    missing: used === null,
    chart: chartBox(
      title,
      renderLineChart(cr.trend, s, {
        width: W,
        height: H,
        ariaLabel: buildAriaLabel(cr.trend, windowLong(cr.trend.window, s), s),
      }),
    ),
  };
}

// ── Time ─────────────────────────────────────────────────────────────────────

const workChat = (b: TimeBin) => b.observedSec + b.conversationSec;

function timeChart(m: DashboardModel, s: Strings): string {
  const t = m.timing;
  const ax = axisOf(t);
  const k = s.kpi;
  if (!ax) return chartBox(k.timeChartTitle, `<p class="note">${esc(k.noEvents)}</p>`);
  const peak = Math.max(0, ...t.bins.map(workChat));
  const base = PAD.top + PLOT_H;
  const hOf = (sec: number) => (peak > 0 ? (sec / peak) * PLOT_H : 0);
  const bars = t.bins
    .map((b) => {
      // Clipped to the recorded span: the first bin starts before the first event and
      // the last one runs past the last, and neither part was recorded.
      const lo = Math.max(Date.parse(b.start), ax.from);
      const hi = Math.min(Date.parse(b.start) + BIN_SEC * 1000, ax.to);
      const x0 = ax.xOf(lo);
      const bw = Math.max(1, ax.xOf(hi) - x0 - 1);
      const hw = hOf(b.observedSec);
      const hc = hOf(b.conversationSec);
      const tip = k.binTip(
        binStart(b.start),
        hours(b.observedSec),
        hours(b.conversationSec),
        hours(b.humanWaitSec),
        hours(b.parkedSec),
        hours(b.unknownSec),
      );
      // One group per bin so the hover text covers the whole column, empty or not.
      return `<g><title>${esc(tip)}</title><rect x="${x0.toFixed(1)}" y="${PAD.top}" width="${bw.toFixed(
        1,
      )}" height="${PLOT_H}" fill="transparent" />${
        hw > 0
          ? `<rect class="k-work" x="${x0.toFixed(1)}" y="${(base - hw).toFixed(1)}" width="${bw.toFixed(1)}" height="${hw.toFixed(1)}" />`
          : ""
      }${
        hc > 0
          ? `<rect class="k-chat" x="${x0.toFixed(1)}" y="${(base - hw - hc).toFixed(1)}" width="${bw.toFixed(1)}" height="${hc.toFixed(1)}" />`
          : ""
      }</g>`;
    })
    .join("");
  const total = t.total.observedSec + t.total.conversationSec;
  return chartBox(
    k.timeChartTitle,
    svg(k.timeChartAria(hours(total), t.bins.length), frame(t, ax, s, hours(peak)) + bars) +
      legend([
        ["k-work", k.legendWork],
        ["k-chat", k.legendChat],
        ["k-silence", k.legendSilence],
      ]),
  );
}

function timeTile(m: DashboardModel, s: Strings): Tile {
  const t = m.timing;
  const k = s.kpi;
  const none = t.bins.length === 0;
  const notes: string[] = [];
  if (t.total.unknownSec > 0) notes.push(k.timeExcluded(hours(t.total.unknownSec)));
  // Same gate as the timeline's merged-view note (`t.parallel`), not overlap: even a
  // sequential handover puts cross-clone gaps into the merged timeline that no one
  // person's does. "At once" is claimed only when the windows actually overlapped.
  if (t.parallel) {
    notes.push(
      k.personTime(
        hours(t.personObservedSec + t.personConversationSec),
        t.clones,
        t.overlapSec > 0,
      ),
    );
  }
  return {
    label: k.timeLabel,
    value: none ? "—" : hours(t.total.observedSec + t.total.conversationSec),
    sub: none ? k.noEvents : k.timeSub(hours(t.total.observedSec), hours(t.total.conversationSec)),
    note: notes.length > 0 ? notes.join(" · ") : undefined,
    tip: k.timeTip,
    missing: none,
    chart: timeChart(m, s),
  };
}

// ── Strip ────────────────────────────────────────────────────────────────────

/** Shows the chart of the checked tile and marks that tile. One rule set per position. */
export const KPI_CSS = Array.from({ length: TILES }, (_, i) => {
  const n = i + 1;
  return `.kpi-r:nth-of-type(${n}):checked ~ .kpi-charts > .kpi-c:nth-child(${n}) { display:block; }
.kpi-r:nth-of-type(${n}):checked ~ .kpi-tiles > label:nth-of-type(${n}) { border-color:var(--accent); background:var(--card); }
.kpi-r:nth-of-type(${n}):focus-visible ~ .kpi-tiles > label:nth-of-type(${n}) { outline:2px solid var(--accent); outline-offset:2px; }`;
}).join("\n");

export function renderKpis(m: DashboardModel, s: Strings): string {
  const tiles = [progressTile(m, s), usageTile(m, s), timeTile(m, s)];
  const group = "mc-kpi";
  const radios = tiles
    .map(
      (_, i) =>
        `<input class="mc-r kpi-r" type="radio" name="${group}" id="${group}-${i}" value="${i}"${
          i === 0 ? " checked" : ""
        }>`,
    )
    .join("");
  const labels = tiles
    .map(
      (t, i) =>
        `<label for="${group}-${i}" class="kpi${t.missing ? " missing" : ""}"${
          t.tip ? ` title="${esc(t.tip)}"` : ""
        }><span class="kpi-l">${esc(t.label)}</span><b class="kpi-v">${esc(t.value)}</b><span class="kpi-s">${esc(
          t.sub,
        )}</span>${t.note ? `<span class="kpi-s kpi-n">${esc(t.note)}</span>` : ""}</label>`,
    )
    .join("");
  return `<section class="kpis" aria-label="${esc(s.kpi.heading)}">
${radios}<div class="kpi-tiles">${labels}</div>
<div class="kpi-charts">${tiles.map((t) => t.chart).join("")}</div>
</section>`;
}
