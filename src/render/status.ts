// The run line at the top of the body, and the Run Health card — see model/status.ts
// for what each reading is and why there is no combined verdict. This module only
// turns those readings into markup.
//
// Run Health is a tabbed card, one tab per signal (your answers, stuck, failed
// checks), and each tab's COUNT carries the signal at a glance: coloured when there is
// something to act on, green when the source was read and is clear, and a muted dash
// when there is no record at all — "no record" must never read as healthy. The card
// opens on the first tab with a problem, so a reader who only glances at it lands on
// the thing that needs them.
//
// Deliberately NOT `role="status"`: the body is swapped on every poll, and a live region
// would re-announce the whole card each minute.

import {
  type ChecksReading,
  type HumanReading,
  type StuckReading,
  buildStatus,
  defaultStopCap,
} from "../model/status";
import type { Blocker, DashboardModel } from "../model/types";
import {
  type CountTone,
  DRILL,
  type Row,
  type Tab,
  rowList,
  share,
  tabbedCard,
  viewLink,
} from "./card-kit";
import { dur, esc } from "./common";
import type { Strings } from "./i18n";

// ── Run line ─────────────────────────────────────────────────────────────────

/**
 * "Is it moving": the phase and stage the run is on, and how long since the audit last
 * recorded anything. Lives in the refreshed body, not the static header, because the
 * age is the one number on it that changes every poll.
 */
export function renderRunLine(m: DashboardModel, s: Strings): string {
  const x = s.status;
  const st = buildStatus(m);
  if (st.run.state === "complete") {
    return `<div class="runline"><span class="rl-dot ok"></span><b>${esc(x.runComplete)}</b><span class="rl-sub">${esc(
      x.runSource,
    )}</span></div>`;
  }
  if (st.run.state === "unknown") {
    return `<div class="runline"><span class="rl-dot mute"></span><b>${esc(x.runUnknown)}</b><span class="rl-sub">${esc(
      x.runSource,
    )}</span></div>`;
  }
  const phase = m.state.lifecyclePhase;
  const stage = st.run.unit
    ? `${st.run.stageDisplay} · ${x.runningUnit(st.run.unit)}`
    : st.run.stageDisplay;
  const where = phase ? `${phase} › ${stage}` : stage;
  // Said, not implied: a Current Stage that can lag is not where the engine is, and a
  // unit cache the current directive contradicts is not either.
  const conflict = m.waits.position.conflict;
  const unverified = st.run.verified
    ? ""
    : conflict
      ? ` <span class="rl-sub" title="${esc(x.runConflictTip)}">· ${esc(
          x.runConflict(conflict.unit ? `${conflict.stage} · ${conflict.unit}` : conflict.stage),
        )}</span>`
      : ` <span class="rl-sub" title="${esc(x.runUnverifiedTip)}">· ${esc(x.runUnverified)}</span>`;
  return `<div class="runline" title="${esc(x.runTip)}"><span class="rl-dot run"></span><b>${esc(
    x.running,
  )}</b><span class="rl-sub">${esc(x.runningSub(where, dur(st.run.lastEventAgeSec)))}</span>${unverified}</div>`;
}

// ── Run Health ───────────────────────────────────────────────────────────────

/**
 * One unanswered ask. `parked` overrides the blocker's own `isCurrentStage`: on a
 * finished run every ask is a loose end (model/status.ts), even one in the stage
 * `state.md` still names as current.
 */
function askRow(b: Blocker, s: Strings, maxWait: number, parked = !b.isCurrentStage): Row {
  const where = b.unit ? `${b.unit} · ${b.stage}` : b.stage;
  const file = b.rel.split("/").pop() ?? b.rel;
  const gate =
    b.invalidTags !== undefined
      ? ` · ${s.blockers.invalidTags(b.invalidTags)}`
      : b.kind === "confirmation"
        ? ` · ${s.blockers.confirmation}`
        : b.kind === "loose"
          ? ` · ${s.blockers.loose}`
          : "";
  const tip =
    b.invalidTags !== undefined
      ? s.blockers.invalidTagsTip
      : b.kind === "confirmation"
        ? s.blockers.confirmationTip
        : b.kind === "loose"
          ? s.blockers.looseTip
          : undefined;
  const earlier = parked ? `${s.blockers.staleStage} · ` : "";
  return {
    label: `${esc(earlier)}${esc(where)} · ${esc(b.heading || s.blockers.untitled)}<span class="mr-sub">${esc(gate)} · ${viewLink(
      b.rel,
      file,
      s.blockers.viewTip(b.rel),
    )}</span>`,
    value: dur(b.waitingSec),
    pct: b.waitingSec === undefined ? undefined : share(b.waitingSec, maxWait),
    tone: parked ? "none" : "warn",
    dim: parked,
    tip,
  };
}

function answersTab(h: HumanReading | undefined, m: DashboardModel, s: Strings): Tab {
  const x = s.status;
  const maxWait = Math.max(0, ...m.blockers.map((b) => b.waitingSec ?? 0));
  const rows: Row[] = [];
  const w = h?.waits;
  const now = Date.parse(m.generatedAt);
  const age = (iso: string | undefined) => {
    const t = iso ? (now - Date.parse(iso)) / 1000 : Number.NaN;
    return Number.isFinite(t) && t >= 0 ? dur(t) : "";
  };
  const sub = (text: string) => `<span class="mr-sub"> · ${esc(text)}</span>`;
  // The run's own holds first — each is something only the person can release.
  if (w?.parked) {
    rows.push({
      label: `${esc(x.humanParked(w.parked.stage, w.parked.byPerson))}${sub(x.humanStateSource)}`,
      value: age(w.parked.since),
      pct: 100,
      tone: "warn",
      tip: x.humanParkedTip,
    });
  }
  if (w?.unitPaused) {
    const next = w.unitPaused.nextAction ? ` · ${x.humanUnitNext(w.unitPaused.nextAction)}` : "";
    rows.push({
      label: `${esc(x.humanUnitPaused(w.unitPaused.unit, w.unitPaused.reason))}${sub(`${x.humanStateSource}${next}`)}`,
      value: "",
      pct: 100,
      tone: "warn",
    });
  }
  if (w?.engineAsk) {
    const where = w.engineAsk.unit
      ? `${w.engineAsk.unit} · ${w.engineAsk.stage}`
      : w.engineAsk.stage;
    rows.push({
      label: `${esc(x.humanEngineAsk(w.engineAsk.askType, where))}${sub(x.humanEngineAskSource)}`,
      value: "",
      pct: 100,
      tone: "warn",
      tip: x.humanEngineAskTip,
    });
  }
  if (w?.decision) {
    rows.push({
      label: `${esc(x.humanDecision(w.decision.checkpoint, w.decision.decision))}${sub(
        w.decision.scopeVerified === false
          ? `${x.humanDecisionSource} · ${x.humanDecisionUnscoped}`
          : x.humanDecisionSource,
      )}`,
      value: age(w.decision.since),
      pct: 100,
      tone: "warn",
      tip: x.humanDecisionTip,
    });
  }
  if (w?.compose) {
    rows.push({
      label: esc(x.humanCompose),
      value: age(w.compose.since),
      pct: 100,
      tone: "warn",
      tip: x.humanComposeTip,
    });
  }
  if (h?.awaitingGate) {
    rows.push({
      label: `${esc(x.humanGate(h.awaitingGate))}${sub(x.humanGateSource)}`,
      value: age(w?.gate?.since),
      pct: 100,
      tone: "warn",
    });
  }
  if (w?.teamGateUnread) {
    rows.push({
      label: esc(x.humanTeamGateUnread),
      value: "—",
      dashed: true,
      tip: x.humanTeamGateUnreadTip,
    });
  }
  if (w?.checkoutPark) {
    rows.push({
      label: esc(x.humanCheckoutPark),
      value: "",
      tone: "none",
      tip: x.humanCheckoutParkTip,
    });
  }
  if (w?.revising) {
    rows.push({
      label: esc(x.humanRevising(w.revising)),
      value: "",
      tone: "none",
      tip: x.humanRevisingTip,
    });
  }
  // buildBlockers already sorts current-stage asks first; parked ones follow, dimmed.
  for (const b of m.blockers) rows.push(askRow(b, s, maxWait));
  for (const rel of w?.engineOnly ?? []) {
    rows.push({
      label: `${esc(x.humanEngineOnly(rel.split("/").pop() ?? rel))}<span class="mr-sub"> · ${viewLink(
        rel,
        rel.split("/").pop() ?? rel,
        s.blockers.viewTip(rel),
      )}</span>`,
      value: "",
      tone: "none",
      dim: true,
      tip: x.humanEngineOnlyTip,
    });
  }
  if (w?.turnEnded && !w.engineAsk) {
    rows.push({ label: esc(x.humanTurnEnded), value: "", tone: "none", tip: x.humanTurnEndedTip });
  }
  if (w?.hooks.state === "stale" || w?.hooks.state === "never") {
    rows.push({
      label: esc(
        w.hooks.state === "stale"
          ? x.humanHooksStale(age(w.hooks.heartbeat), age(w.hooks.event))
          : x.humanHooksNever,
      ),
      value: "",
      tone: "warn",
      tip: w.hooks.state === "stale" ? x.humanHooksStaleTip : x.humanHooksNeverTip,
    });
  }
  if (w?.autonomous) {
    rows.push({
      label: esc(x.humanAutonomous),
      value: "",
      tone: "none",
      tip: x.humanAutonomousTip,
    });
  }
  // An open gate is usually answered IN the current-stage questions file, so adding it
  // to their count would report one approval twice. It counts on its own only when no
  // current ask carries it — the same rule the status chip used. A park, a paused unit,
  // an engine ask, an open decision and a compose gate each hold the run on their own
  // and count once each; revising, engine-only, turn-ended, hook and autonomy rows are
  // shown, not counted (see model/waits.ts).
  const current = h?.current ?? 0;
  const holds =
    (w?.parked ? 1 : 0) +
    (w?.unitPaused ? 1 : 0) +
    (w?.engineAsk ? 1 : 0) +
    (w?.decision ? 1 : 0) +
    (w?.compose ? 1 : 0);
  const open = (current > 0 ? current : h?.awaitingGate ? 1 : 0) + holds;
  return {
    label: s.cards.answersTab,
    count: { text: String(open), tone: open > 0 ? "warn" : "ok" },
    // Not capped. This card is the only place the asks are listed — the "see all" link
    // goes to the timeline, which does not list them — so a "+N more" here would make
    // the rest unreachable. The list the old blockers card showed was never capped.
    body: rowList(rows, {
      head: [s.cards.colAsk, s.cards.colWait],
      empty: x.humanNone,
      note: x.humanSource,
    }),
  };
}

function stuckTab(r: StuckReading, s: Strings, autonomous: boolean): Tab {
  const x = s.status;
  let row: Row;
  let count: { text: string; tone: CountTone };
  switch (r.state) {
    case "no-record":
      row = { label: esc(x.stuckNoRecord), value: "—", dashed: true };
      count = { text: "–", tone: "mute" };
      break;
    case "clear":
      row = { label: esc(x.stuckClear), value: "0", tone: "ok" };
      count = { text: "0", tone: "ok" };
      break;
    case "earlier-stage":
      row = {
        label: `${esc(x.stuckClear)}<span class="mr-sub"> · ${esc(x.stuckEarlier(r.stage))}</span>`,
        value: "0",
        tone: "ok",
      };
      count = { text: "0", tone: "ok" };
      break;
    case "state-changed":
      row = {
        label: `${esc(x.stuckStateChanged)}<span class="mr-sub"> · ${esc(r.stage)}</span>`,
        value: "0",
        tone: "ok",
      };
      count = { text: "0", tone: "ok" };
      break;
    case "nudged":
      row = {
        label: `${esc(x.stuckNudged)}<span class="mr-sub"> · ${esc(r.stage)}</span>`,
        value: "1",
        tone: "ok",
      };
      count = { text: "1", tone: "ok" };
      break;
    case "blocked":
      row = {
        label: `${esc(x.stuckBlocked(r.count, r.cap))}<span class="mr-sub"> · ${esc(r.stage)}</span>`,
        value: String(r.count),
        pct: share(r.count, r.cap),
        tone: "warn",
      };
      count = { text: String(r.count), tone: "warn" };
      break;
    case "released":
      row = {
        label: `${esc(x.stuckReleased(r.count, r.cap))}<span class="mr-sub"> · ${esc(r.stage)}</span>`,
        value: String(r.count),
        pct: 100,
        tone: "warn",
      };
      count = { text: String(r.count), tone: "warn" };
      break;
  }
  return {
    label: s.cards.stuckTab,
    count,
    body: rowList([{ ...row, tip: x.stuckTip(defaultStopCap(autonomous), autonomous) }], {
      head: [s.cards.colGuard, s.cards.colCount],
      note: x.stuckSource,
    }),
  };
}

function checksTab(r: ChecksReading, m: DashboardModel, s: Strings): Tab {
  const x = s.status;
  const stage = m.state.currentStage;
  const now = Date.parse(m.generatedAt);
  const failures = m.sensors.failures.filter((f) => f.stage === stage);
  const rows: Row[] = failures.map((f) => {
    const age = (now - Date.parse(f.ts)) / 1000;
    const findings = f.findingsCount !== undefined ? ` · ${f.findingsCount}` : "";
    return {
      label: `✗ ${esc(f.id)}<span class="mr-sub"> · ${esc(f.stage)}${esc(findings)}</span>`,
      value: Number.isFinite(age) && age >= 0 ? dur(age) : "—",
      pct: 100,
      tone: "bad",
      tip: x.checksFailedTip,
    };
  });
  let count: { text: string; tone: CountTone };
  switch (r.state) {
    case "none":
      rows.push({ label: esc(x.checksNone), value: "—", dashed: true });
      count = { text: "–", tone: "mute" };
      break;
    case "in-flight":
      rows.push({ label: esc(x.checksInFlight(r.pending)), value: "", dashed: true });
      count = r.failed > 0 ? { text: String(r.failed), tone: "bad" } : { text: "…", tone: "mute" };
      break;
    case "failed":
      // The roll-up counted a failure whose firing is not in the failure list (no
      // terminal record read) — still say it happened rather than show nothing.
      if (failures.length === 0) {
        rows.push({ label: esc(x.checksFailed(r.failed)), value: "", pct: 100, tone: "bad" });
      }
      count = { text: String(r.failed), tone: "bad" };
      break;
    case "passed":
      rows.push({ label: esc(x.checksPassed(r.passed)), value: "", tone: "ok" });
      count = { text: "0", tone: "ok" };
      break;
  }
  return {
    label: s.cards.checksTab,
    count,
    body: rowList(rows, {
      head: [s.cards.colCheck, s.cards.colWhen],
      max: 6,
      moreText: s.cards.moreRows,
      note: x.checksSource(m.state.currentStage),
    }),
  };
}

export function renderRunHealth(m: DashboardModel, s: Strings): string {
  const st = buildStatus(m);
  const more = { href: `#${DRILL.timeline}`, label: s.cards.moreTimeline };

  if (st.run.state === "complete") {
    // A finished run: past blocks and failed checks are history (model/status.ts). What
    // is left to show is that it finished, and any ask it left unanswered.
    const maxWait = Math.max(0, ...m.blockers.map((b) => b.waitingSec ?? 0));
    const rows: Row[] = [
      { label: esc(s.status.runComplete), value: "", tone: "ok" },
      ...m.blockers.map((b) => askRow(b, s, maxWait, true)),
    ];
    return tabbedCard({
      id: "health",
      title: s.cards.healthTitle,
      tabs: [{ label: s.cards.summaryTab, body: rowList(rows, { note: s.status.runSource }) }],
      more,
    });
  }

  const tabs = [
    answersTab(st.human, m, s),
    stuckTab(st.stuck ?? { state: "no-record" }, s, m.waits.autonomous),
    checksTab(st.checks ?? { state: "none" }, m, s),
  ];
  const problem = tabs.findIndex((t) => t.count?.tone === "warn" || t.count?.tone === "bad");
  return tabbedCard({
    id: "health",
    title: s.cards.healthTitle,
    tabs,
    selected: problem < 0 ? 0 : problem,
    more,
  });
}
