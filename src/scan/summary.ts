// A one-line summary of a workspace, for the picker's cards.
//
// WHY NOT `assemble`. The picker lists every workspace discovery found, and the obvious
// implementation — one `assemble` per card — is the wrong shape for three reasons, all of
// them measured rather than guessed (the figures live beside `SUMMARY_COST` below):
//
//   1. `assemble` reads the whole record: every audit shard, every `.md` under the phase
//      dirs for the deferral ledger (115 files / 2.16MB on one real tree), the matrix, the
//      timing ledger. A card shows two numbers.
//   2. On a `.claude` tree `assemble` also reads the Claude transcripts, and it does so
//      whether or not a `UsageContext` was passed — so a bare call is a COLD transcript
//      read every time (268ms worst case, see transcript-reader.ts).
//   3. It is synchronous, and so is this. N cards on one Bun event loop means N reads
//      serialised no matter how the client paces its requests, so capping client
//      concurrency does not fix a per-read cost — only a smaller read does.
//
// So this module reads exactly what the card shows: `aidlc-state.md` for progress, and the
// `*-questions.md` walk for the blocker count. No audit, no deferral ledger, no transcripts,
// no matrix.
//
// EVERY NUMBER CARRIES ITS SOURCE, and none claims staleness. The two figures come from
// different places — progress from `state.md`, blockers from disk — and CLAUDE.md's rule is
// that a panel must not average two freshnesses into one unlabelled number. But `stale` in
// this repo means "known to lag another source that corroborates it", and the corroborating
// source is the audit, which this module deliberately does not read. So each figure names
// its `SourceKind` and the progress figure carries the state file's own `Last Updated`;
// nothing here asserts a staleness verdict it has no reference for.
//
// Never throws — an unreadable or absent tree comes back as a `kind`, like every other scan
// module.

import * as fs from "node:fs";
import * as path from "node:path";
import type { SourceKind } from "../model/types";
import { type AidlcState, parseState } from "./parser";
import { readQuestions } from "./questions";
import { resolveState } from "./resolve";
import { readStageCatalog } from "./stage-catalog";

/**
 * MEASURED, on this machine, over every AI-DLC tree present plus the repo fixture — best of
 * three reads each. Quote these when judging a change here.
 *
 * | record `.md` | `*-questions.md` | summary | assemble | ratio |
 * |---|---|---|---|---|
 * |   16 |  2 |   1.5ms |   7.6ms |  5.0x |
 * |   26 |  2 |   1.4ms |   7.2ms |  5.2x |
 * |  224 | 15 |  11.3ms |  81.3ms |  7.2x |
 * |  311 | 14 |   5.0ms |  69.8ms | 13.9x |
 * |  335 |  9 |   4.4ms |  69.7ms | 15.8x |
 * |  546 | 20 |   8.6ms | 115.2ms | 13.3x |
 *
 * Two things the table settles. **The worst summary observed is 11.3ms**, so a picker listing
 * a dozen workspaces spends ~0.1s of event loop rather than the ~1s the same list would cost
 * through `assemble` — which is what makes the lazy fill viable at all. And **the two costs
 * scale on different things**: the summary tracks the `*-questions.md` count (the 546-file
 * tree has 20 and costs 8.6ms; the 224-file tree has 15 and costs 11.3ms — file size, not
 * record size, decides), while `assemble` tracks the whole record.
 *
 * Also measured: of the 13 trees found, **7 resolve to no run at all** — `assemble` throws
 * `NoRunError` on every one of them. That is why `no-run` is a first-class result here rather
 * than an error case, and why its reason is carried instead of flattened.
 */

/** Progress, and where it was read from. */
export interface SummaryProgress {
  pct: number;
  done: number;
  total: number;
  lifecyclePhase: string;
  currentStage: string;
  /** Display name, from the workspace's own catalogue when it has one. */
  currentStageDisplay: string;
  /** `Last Updated` from state.md verbatim — stamped at transitions, so it TRAILS
   *  mid-stage by design. That is not a fault (CLAUDE.md), which is why it is reported
   *  as a date rather than turned into a staleness badge. */
  asOf?: string;
  readonly source: SourceKind;
}

/** The blocker count, and where it was read from. */
export interface SummaryBlockers {
  count: number;
  /** Total asks seen, so `count` has a denominator on screen. */
  asked: number;
  readonly source: SourceKind;
}

export type WorkspaceSummary =
  | {
      kind: "ok";
      /**
       * Record dir name — the run this summary is about.
       *
       * `Project` from state.md is deliberately NOT carried. Measured across the trees on
       * this machine, that field runs to a 400-plus-character paragraph of run description,
       * and no card renders it — so it would be the longest string in the response, shipped
       * for nothing. A summary endpoint carries what the summary shows.
       */
      record: string;
      progress: SummaryProgress;
      blockers: SummaryBlockers;
    }
  /** No single intent resolves. The two reasons are kept apart because they are different
   *  sentences: `none` is an empty or absent space, `ambiguous` is several records with no
   *  active-intent cursor — the same split `NoRunError` carries. */
  | { kind: "no-run"; reason: "none" | "ambiguous" }
  /** The state file resolved and then could not be read. */
  | { kind: "unreadable" };

/**
 * Summarise the workspace at `root`. `root` must already be a validated workspace path —
 * the caller gets that from `resolveWorkspace`, never from a raw client string.
 */
export function readWorkspaceSummary(root: string): WorkspaceSummary {
  const resolved = resolveState(root);
  if (resolved.kind !== "ok") return { kind: "no-run", reason: resolved.kind };

  const statePath = path.join(root, resolved.rel);
  const recordDir = path.dirname(statePath);

  let state: AidlcState;
  try {
    // The catalogue is consulted for stage NAMES only, so that a card and the full page
    // never print two different names for the same stage. Without one, `parseState` falls
    // back to its own table and then to a title-cased slug — the documented degradation,
    // not a wrong claim.
    const catalog = readStageCatalog(root);
    state = parseState(
      fs.readFileSync(statePath, "utf-8"),
      catalog ? (slug) => catalog.bySlug.get(slug)?.name : undefined,
    );
  } catch {
    return { kind: "unreadable" };
  }

  const questions = readQuestions(recordDir);

  return {
    kind: "ok",
    record: path.basename(recordDir),
    progress: {
      pct: state.overallPct,
      done: state.overallDone,
      total: state.overallTotal,
      lifecyclePhase: state.lifecyclePhase,
      currentStage: state.currentStage,
      currentStageDisplay: state.currentStageDisplay,
      asOf: state.lastUpdated || undefined,
      source: "state.md",
    },
    blockers: {
      count: questions.totalUnanswered,
      asked: questions.totalQuestions,
      source: "disk",
    },
  };
}
