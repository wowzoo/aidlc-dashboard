// The unanswered asks — which unit, which question, which file.
//
// This used to be its own card, first on the page. It is not a card any more: the
// status strip's "awaiting you" chip carries the count and the oldest wait, and this
// list opens under that chip on demand. What it keeps is the one thing the chip cannot
// carry and that is tedious to find by hand — the location of each answer, linked.

import type { Blocker, DashboardModel } from "../model/types";
import { dur, esc, pill, shortTs } from "./common";
import type { Strings } from "./i18n";

function blockerItem(b: Blocker, s: Strings): string {
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

/**
 * Every unanswered ask, current stage first (the order `buildBlockers` already
 * sorts into). Empty string when there are none — the caller decides whether a
 * list exists at all.
 */
export function renderBlockerList(m: DashboardModel, s: Strings): string {
  return m.blockers.map((b) => blockerItem(b, s)).join("\n");
}
