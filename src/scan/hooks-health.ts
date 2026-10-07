// Engine health: are the hooks firing, what have they dropped, and is the stop
// guard seeing progress.
//
// THREE ARTEFACTS, all under the record dir — inside `.aidlc-engine/` since
// AI-DLC 2.9.0, at the legacy names below before it (see scan/engine-dir.ts):
//
//   .aidlc-hooks-health/<hook>.last   a bare ISO timestamp, rewritten each time
//                                     that hook fires. The liveness probe the
//                                     engine's own doctor reads.
//   .aidlc-hooks-health/<hook>.drops  TSV `<ISO>\t<reason>`, one line per event
//                                     the hook chose NOT to act on. Append-only.
//   .aidlc-stop-hook/block-count.json {"signature":"<stage>::<auditLines>","count":N}
//
// READING block-count CORRECTLY. `count` is a NO-PROGRESS counter, not an
// activity counter: the stop hook increments it for each consecutive block with
// no intervening workflow advance, and resets it to 0 the moment the signature
// changes (a `report` ran). So a rising count means the loop is stuck, and 0
// means healthy — the opposite of the "heartbeat" reading it invites. See
// hooks/aidlc-stop.ts (the no-progress counter and its run-mode-aware cap).
//
// A `.drops` reason containing "[degraded]" marks a degraded-mode drop, which the
// engine's doctor counts separately; we surface it the same way.
//
// NOT EVERY `.last` IS A HOOK. A hook also keeps its own markers in the same dir,
// named `<hook>.<marker>.last` — `reviewer-scope.missing-record.last` rate-limits
// one advisory to a line per 10 minutes (`hooks/aidlc-reviewer-scope.ts`). Read as
// a hook it would add a row that never fires on its own and lend its timestamp to
// `lastActivity`. Hook names are kebab-case filenames with no dot, so a stem that
// carries one is a marker and stays out.
//
// Node fs only, never throws.

import * as fs from "node:fs";
import * as path from "node:path";
import { engineReadDir } from "./engine-dir";

/** One hook's liveness + drop history. */
export interface HookStatus {
  /** Hook name as it appears in the filename, e.g. "runtime-compile". */
  name: string;
  /** Contents of `<hook>.last` — ISO timestamp, or undefined if it never fired. */
  lastFired?: string;
  /** Number of `<hook>.drops` lines. */
  drops: number;
  /** Drop lines whose reason carries "[degraded]". */
  degradedDrops: number;
  /** Most recent drop, when there is one. */
  lastDrop?: { ts: string; reason: string };
  /** reason (first 80 chars, normalised) → count, most frequent first. */
  topDropReasons: { reason: string; count: number }[];
}

/** The stop hook's no-progress guard. */
export interface StopGuard {
  /** `<current stage>::<audit line count>` — changes whenever work advanced. */
  signature: string;
  /** Consecutive blocks with NO progress. 0 = healthy; rising = stuck. */
  count: number;
}

export interface HealthReport {
  hooks: HookStatus[];
  /** `.first-fired` — when hooks first ran for this record. */
  firstFired?: string;
  /** Latest `lastFired` across all hooks — the engine's overall last activity. */
  lastActivity?: string;
  stopGuard?: StopGuard;
  totalDrops: number;
}

/** Collapse a drop reason to a groupable key: the leading clause, truncated. */
function reasonKey(reason: string): string {
  const head = (reason.split(":")[0] ?? "").trim();
  const base = head.length > 0 ? head : reason.trim();
  return base.length > 80 ? `${base.slice(0, 80)}…` : base;
}

/**
 * Parse a `.drops` file body into rows. Exported for tests — the TSV contract
 * lives here alone. Malformed lines (no tab) keep the whole line as the reason
 * with an empty timestamp rather than being dropped silently.
 */
export function parseDrops(text: string): { ts: string; reason: string }[] {
  const rows: { ts: string; reason: string }[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().length === 0) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) rows.push({ ts: "", reason: line.trim() });
    else rows.push({ ts: line.slice(0, tab).trim(), reason: line.slice(tab + 1).trim() });
  }
  return rows;
}

function readText(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Read the hook-health dir and the stop guard. Hooks are discovered from the
 * files present rather than a hardcoded roster, so a harness that adds a hook
 * shows up without a code change. Never throws.
 */
export function readHealth(recordDir: string): HealthReport {
  const healthDir = engineReadDir(recordDir, "hooks-health", ".aidlc-hooks-health");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(healthDir);
  } catch {
    // No health dir: hooks never fired for this record (or a partial sync).
  }

  // Union of names seen as `<name>.last` and `<name>.drops` — a hook can have
  // dropped without ever having fired, and vice versa. A dotted stem is a hook's
  // marker, not a hook (see the header).
  const names = new Set<string>();
  for (const f of entries) {
    const stem = f.endsWith(".last") ? f.slice(0, -5) : f.endsWith(".drops") ? f.slice(0, -6) : "";
    if (stem.length > 0 && !stem.includes(".")) names.add(stem);
  }

  const hooks: HookStatus[] = [];
  for (const name of [...names].sort()) {
    const lastRaw = readText(path.join(healthDir, `${name}.last`));
    const dropsRaw = readText(path.join(healthDir, `${name}.drops`));
    const dropRows = dropsRaw ? parseDrops(dropsRaw) : [];

    const byReason = new Map<string, number>();
    let degraded = 0;
    for (const d of dropRows) {
      if (d.reason.includes("[degraded]")) degraded++;
      const k = reasonKey(d.reason);
      byReason.set(k, (byReason.get(k) ?? 0) + 1);
    }

    hooks.push({
      name,
      lastFired: lastRaw?.trim() || undefined,
      drops: dropRows.length,
      degradedDrops: degraded,
      lastDrop: dropRows.length > 0 ? dropRows[dropRows.length - 1] : undefined,
      topDropReasons: [...byReason]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3),
    });
  }

  let stopGuard: StopGuard | undefined;
  const guardRaw = readText(
    path.join(engineReadDir(recordDir, "stop-hook", ".aidlc-stop-hook"), "block-count.json"),
  );
  if (guardRaw) {
    try {
      const j = JSON.parse(guardRaw) as Record<string, unknown>;
      if (typeof j.signature === "string" && typeof j.count === "number") {
        stopGuard = { signature: j.signature, count: j.count };
      }
    } catch {
      // A truncated guard file: omit rather than guess.
    }
  }

  const fired = hooks.map((h) => h.lastFired).filter((t): t is string => !!t);
  return {
    hooks,
    firstFired: readText(path.join(healthDir, ".first-fired"))?.trim() || undefined,
    lastActivity: fired.length > 0 ? fired.sort()[fired.length - 1] : undefined,
    stopGuard,
    totalDrops: hooks.reduce((n, h) => n + h.drops, 0),
  };
}
