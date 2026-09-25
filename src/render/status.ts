// The status strip — see model/status.ts for what each chip reads and why there is
// no combined verdict. This module only turns those readings into markup.
//
// Deliberately NOT `role="status"`: the body is swapped on every poll, and a live
// region would re-announce the whole strip each minute. It is a labelled list, so a
// screen reader reaches it first and reads it on demand.

import { type ChecksReading, type StuckReading, buildStatus } from "../model/status";
import type { DashboardModel } from "../model/types";
import { renderBlockerList } from "./blockers";
import { dur, esc } from "./common";
import type { Strings } from "./i18n";

/**
 * `mute` (dashed) means "no reading" — a source that is absent or has nothing for
 * this stage. `plain` is a reading that carries no judgement, like the run chip.
 */
type Tone = "ok" | "warn" | "bad" | "mute" | "plain";

interface Chip {
  tone: Tone;
  head: string;
  sub: string;
  /** In-page anchor of the panel that holds the detail. */
  href?: string;
  tip?: string;
  /**
   * Detail that opens UNDER the chip on click, instead of living in a card of its
   * own. Native <details>, so it needs no script and page.ts's poll restores it open.
   */
  pop?: string;
}

function chip(c: Chip): string {
  const title = c.tip ? ` title="${esc(c.tip)}"` : "";
  const inner = `<span class="st-head">${esc(c.head)}</span><span class="st-sub">${esc(c.sub)}</span>`;
  if (c.pop) {
    return `<li class="st-chip ${c.tone} has-pop"><details><summary${title}>${inner}</summary><div class="st-pop">${c.pop}</div></details></li>`;
  }
  const body = c.href
    ? `<a href="${esc(c.href)}"${title}>${inner}</a>`
    : `<span${title}>${inner}</span>`;
  return `<li class="st-chip ${c.tone}">${body}</li>`;
}

function stuckChip(r: StuckReading, s: Strings): Chip {
  const x = s.status;
  switch (r.state) {
    case "no-record":
      return { tone: "mute", head: x.stuckNoRecord, sub: x.stuckSource, tip: x.stuckTip };
    case "clear":
      return { tone: "ok", head: x.stuckClear, sub: x.stuckSource, tip: x.stuckTip };
    case "earlier-stage":
      return { tone: "ok", head: x.stuckClear, sub: x.stuckEarlier(r.stage), tip: x.stuckTip };
    case "blocked":
      return {
        tone: "warn",
        head: x.stuckBlocked(r.count),
        sub: `${r.stage} · ${x.stuckSource}`,
        tip: x.stuckTip,
      };
  }
}

function checksChip(r: ChecksReading, s: Strings): Chip {
  const x = s.status;
  const href = "#timeline";
  switch (r.state) {
    case "none":
      return { tone: "mute", head: x.checksNone, sub: x.checksSource, href };
    case "in-flight":
      return { tone: "mute", head: x.checksInFlight(r.pending), sub: x.checksSource, href };
    case "failed":
      return {
        tone: "warn",
        head: x.checksFailed(r.failed),
        sub: x.checksSource,
        href,
        tip: x.checksFailedTip,
      };
    case "passed":
      return { tone: "ok", head: x.checksPassed(r.passed), sub: x.checksSource, href };
  }
}

export function renderStatus(m: DashboardModel, s: Strings): string {
  const x = s.status;
  const st = buildStatus(m);
  const chips: Chip[] = [];

  if (st.run.state === "complete") {
    chips.push({ tone: "ok", head: x.runComplete, sub: x.runSource });
  } else if (st.run.state === "unknown") {
    chips.push({ tone: "mute", head: x.runUnknown, sub: x.runSource });
  } else {
    chips.push({
      tone: "plain",
      head: x.running,
      sub: x.runningSub(st.run.stageDisplay, dur(st.run.lastEventAgeSec)),
      tip: x.runTip,
    });
  }

  if (st.stuck) chips.push(stuckChip(st.stuck, s));

  const h = st.human;
  if (h) {
    const earlier = h.earlier > 0 ? ` · ${x.humanEarlier(h.earlier)}` : "";
    // The asks themselves — which file to open — open under this chip. Present
    // whenever any ask is unanswered, current or parked, so none is unreachable.
    const pop = m.blockers.length > 0 ? renderBlockerList(m, s) : undefined;
    if (h.current > 0) {
      const gate = h.awaitingGate ? ` · ${x.humanGate(h.awaitingGate)}` : "";
      chips.push({
        tone: "bad",
        head: x.humanWaiting(h.current),
        sub: `${x.humanOldest(dur(h.oldestWaitingSec))}${gate}${earlier}`,
        pop,
      });
    } else if (h.awaitingGate) {
      chips.push({
        tone: "warn",
        head: x.humanGate(h.awaitingGate),
        sub: `${x.humanGateSource}${earlier}`,
        href: pop ? undefined : "#timeline",
        pop,
      });
    } else {
      chips.push({ tone: "ok", head: x.humanNone, sub: `${x.humanSource}${earlier}`, pop });
    }
  }

  if (st.checks) chips.push(checksChip(st.checks, s));

  return `<ul class="status-strip" aria-label="${esc(x.label)}">${chips.map(chip).join("")}</ul>`;
}
