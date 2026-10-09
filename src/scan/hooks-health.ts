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
// NOT EVERY `.last` IS A HOOK. `reviewer-scope.missing-record.last` is a hook's own
// marker in the same dir: it rate-limits one advisory to a line per 10 minutes
// (`hooks/aidlc-reviewer-scope.ts`). Read as a hook it adds a row that never fires
// and lends its stamp to `lastActivity`. Only KNOWN marker suffixes are excluded,
// and only on `.last`: the engine does not restrict hook names (`recordHookDrop`
// writes `<anything>.drops`, and the plugin composer writes harness-scoped drop
// names), so "a dotted stem is a marker" would be a rule we invented, and its
// failure would hide a real hook's drops. An unknown marker shows up as an extra
// row instead — visible, which is the failure we can afford.
//
// Node fs only, never throws.

import * as fs from "node:fs";
import * as path from "node:path";
import { ENGINE_DIR, engineReadDir } from "./engine-dir";

/** `<hook><suffix>.last` files that are a hook's own markers, not heartbeats. */
const MARKER_SUFFIXES = [".missing-record"];

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
  /** `<Current Stage>::<state digest>::<directive fingerprint>` — see model/status.ts. */
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
  /**
   * Every `*.last` file, read the way the engine's `hookLiveness` reads them — which is
   * not the hook list above: a marker-suffixed `.last` counts, and a file that exists
   * counts as "fired" even when empty or unreadable. `stamps` holds the parseable
   * timestamps.
   */
  heartbeats: { present: boolean; stamps: string[] };
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
  // dropped without ever having fired, and vice versa. A known marker is not a
  // hook (see the header).
  const names = new Set<string>();
  for (const f of entries) {
    if (f.endsWith(".last")) {
      const stem = f.slice(0, -5);
      if (!MARKER_SUFFIXES.some((m) => stem.endsWith(m))) names.add(stem);
    } else if (f.endsWith(".drops")) names.add(f.slice(0, -6));
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
    // `stopHookDir`: the 2.11 engine keeps the counter here and only here.
    path.join(recordDir, ENGINE_DIR, "stop-hook", "block-count.json"),
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

  const lastFiles = entries.filter((f) => f.endsWith(".last"));
  const stamps: string[] = [];
  for (const f of lastFiles) {
    const ts = readText(path.join(healthDir, f))?.trim();
    if (ts && Number.isFinite(Date.parse(ts))) stamps.push(ts);
  }

  const fired = hooks.map((h) => h.lastFired).filter((t): t is string => !!t);
  return {
    heartbeats: { present: lastFiles.length > 0, stamps },
    hooks,
    firstFired: readText(path.join(healthDir, ".first-fired"))?.trim() || undefined,
    lastActivity: fired.length > 0 ? fired.sort()[fired.length - 1] : undefined,
    stopGuard,
    totalDrops: hooks.reduce((n, h) => n + h.drops, 0),
  };
}
