// Is a stage's approval gate open right now, according to the audit?
//
// A transcription of the engine's `pendingOrganicGate` (2.11 aidlc-utility.ts),
// which the engine consults only while the stage's state row is `[?]`. The reader
// it replaces opened the wait on `STAGE_AWAITING_APPROVAL` and closed it only on
// the stage's next start/complete/skip — so an approved or rejected gate stayed
// "awaiting approval" until the stage moved on, which is exactly the window someone
// watching the page cares about. The engine's rules:
//
//   - OPENS on `STAGE_AWAITING_APPROVAL` for the stage, except a row marked
//     `Recovered: true` or `Revalidated: true` (a re-stamp, not a new ask).
//   - CLEARS on `GATE_APPROVED`, `GATE_REJECTED` or `STAGE_SKIPPED` for the stage;
//     on any `WORKFLOW_STARTED` or `STAGE_JUMPED`; and on a `STAGE_STARTED` of the
//     stage unless its `Workflow` starts `single-stage:`.
//   - Rows sharing one second are causally ordered only within a shard: each
//     shard's last effect is taken, and if the shards disagree the gate is clear
//     ("fail closed" — the engine will not claim a wait it cannot order).
//
// The 2.11.0 rules, applied to every tree (the dashboard reads 2.11 only).
//
// The stage is read from the block's own `**Stage**` field, as the engine reads it,
// not from `Context` attribution.

import type { AuditEvent } from "./audit";

const RELEVANT = new Set([
  "WORKFLOW_STARTED",
  "STAGE_JUMPED",
  "STAGE_STARTED",
  "STAGE_AWAITING_APPROVAL",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "STAGE_SKIPPED",
]);

/** When the stage's gate opened, if it is open now. `events` ascending by time. */
export function pendingGate(events: AuditEvent[], stage: string): { since: string } | undefined {
  const rows = events.filter((e) => RELEVANT.has(e.event));
  let pending: { since: string } | undefined;
  for (let start = 0; start < rows.length; ) {
    let end = start + 1;
    while (end < rows.length && rows[end]?.ts === rows[start]?.ts) end++;
    const effect = new Map<string, "open" | "clear">();
    for (const e of rows.slice(start, end)) {
      const eventStage = e.fields.Stage;
      const boundary =
        e.event === "WORKFLOW_STARTED" ||
        e.event === "STAGE_JUMPED" ||
        (e.event === "STAGE_STARTED" &&
          eventStage === stage &&
          !(e.fields.Workflow ?? "").startsWith("single-stage:"));
      if (boundary) {
        effect.set(e.shard, "clear");
        continue;
      }
      if (eventStage !== stage) continue;
      if (e.event === "STAGE_AWAITING_APPROVAL") {
        if (e.fields.Recovered === "true" || e.fields.Revalidated === "true") continue;
        effect.set(e.shard, "open");
      } else {
        effect.set(e.shard, "clear");
      }
    }
    const kinds = new Set(effect.values());
    if (kinds.size > 1 || kinds.has("clear")) pending = undefined;
    else if (kinds.has("open")) {
      const since = rows[start]?.ts ?? "";
      pending = Number.isFinite(Date.parse(since)) ? { since } : undefined;
    }
    start = end;
  }
  return pending;
}
