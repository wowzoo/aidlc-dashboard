// Panel (b) — why the run is stopped.
//
// This panel is first on the page for a reason: an AI-DLC run that looks hung is
// almost always waiting on a human answer, and the answer's location (which unit,
// which file) is exactly what is tedious to find by hand.

import type { Blocker, DashboardModel } from "../model/types";
import { dur, esc, pill, section, shortTs } from "./common";
import type { Strings } from "./i18n";

function blockerCard(b: Blocker, s: Strings): string {
  const where = b.unit ? `${b.unit} · ${b.stage}` : b.stage;
  const tone = b.isCurrentStage ? "bad" : "warn";
  const label = b.isCurrentStage ? s.blockers.currentStage : s.blockers.staleStage;
  // A gate confirmation is a different ask: the remedy is picking one of the
  // engine's fixed options (`Looks correct` / `Request changes`, `A. Accept
  // assumptions` / `B. …`) or writing the "what should change" feedback, not
  // answering a question. Naming it saves the reader opening the file to find out.
  const gate =
    b.kind === "confirmation"
      ? pill(s.blockers.confirmation, tone, s.blockers.confirmationTip)
      : "";
  return `<div class="blocker ${tone}">
  <div class="blocker-head">${pill(label, tone)}${gate}<span class="blocker-where">${esc(where)}</span>
    <span class="blocker-age">${esc(s.blockers.waiting(dur(b.waitingSec)))}</span></div>
  <div class="blocker-q">${esc(b.heading)}</div>
  <div class="blocker-path"><a href="/view?rel=${encodeURIComponent(b.rel)}" title="${esc(
    s.blockers.viewTip(b.rel),
  )}">${esc(b.rel)}</a> · ${esc(shortTs(b.since))}</div>
</div>`;
}

function blockerBody(m: DashboardModel, s: Strings): string {
  if (m.blockers.length === 0) {
    return `<p class="note">${esc(s.blockers.none)} ${pill(s.blockers.ok, "ok")}</p>`;
  }
  const current = m.blockers.filter((b) => b.isCurrentStage);
  const stale = m.blockers.filter((b) => !b.isCurrentStage);
  const head =
    current.length > 0
      ? `<p class="lead">${esc(s.blockers.currentWaiting(current.length))}</p>`
      : `<p class="lead">${esc(s.blockers.staleOnly(stale.length))}</p>`;
  return head + [...current, ...stale].map((b) => blockerCard(b, s)).join("\n");
}

/** The blocker card alone — placed first on the page, above everything. */
export function renderBlockerCard(m: DashboardModel, s: Strings): string {
  return section(s.blockers.title, blockerBody(m, s), "blockers");
}
