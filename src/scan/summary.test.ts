// readWorkspaceSummary — the picker card's read.
//
// The point of these is that the summary agrees with `assemble` on the numbers it shows
// while reading far less: a cheaper read that quietly disagrees with the page it links to
// would be worse than no card at all. So the fixture case asserts against the same figures
// model.test.ts asserts on the full model.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { readWorkspaceSummary } from "./summary";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");

/** A workspace whose `aidlc/` tree holds the given record dirs (each with a state file
 *  unless `stateAsDir`), plus an optional active-intent cursor. */
function tree(opts: {
  records: string[];
  cursor?: string;
  stateAsDir?: boolean;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-sum-"));
  const intents = path.join(root, "aidlc", "spaces", "default", "intents");
  fs.mkdirSync(intents, { recursive: true });
  for (const record of opts.records) {
    const dir = path.join(intents, record);
    fs.mkdirSync(dir, { recursive: true });
    const state = path.join(dir, "aidlc-state.md");
    if (opts.stateAsDir) fs.mkdirSync(state);
    else fs.writeFileSync(state, "- **Lifecycle Phase**: IDEATION\n\n- [x] a\n- [ ] b\n");
  }
  if (opts.cursor) fs.writeFileSync(path.join(intents, "active-intent"), opts.cursor);
  return root;
}

describe("readWorkspaceSummary", () => {
  test("the fixture summary matches what assemble reports for the same tree", () => {
    const got = readWorkspaceSummary(FIXTURE);
    expect(got.kind).toBe("ok");
    if (got.kind !== "ok") return;
    const m = assemble(FIXTURE);
    expect(got.record).toBe(m.identity.record);
    expect(got.progress.pct).toBe(m.state.overallPct);
    expect(got.progress.done).toBe(m.state.overallDone);
    expect(got.progress.total).toBe(m.state.overallTotal);
    expect(got.progress.currentStage).toBe(m.state.currentStage);
    // The catalogue is read for names, so a card and the page cannot print two different
    // names for one stage.
    expect(got.progress.currentStageDisplay).toBe(m.state.currentStageDisplay);
    expect(got.blockers.count).toBe(m.blockers.length);
  });

  test("every figure names its own source — the card mixes two freshnesses", () => {
    const got = readWorkspaceSummary(FIXTURE);
    if (got.kind !== "ok") throw new Error("fixture must resolve");
    expect(got.progress.source).toBe("state.md");
    expect(got.blockers.source).toBe("disk");
    // state.md stamps `Last Updated` at transitions, so the date is carried for the tooltip
    // rather than turned into a staleness verdict this module has no audit to compare with.
    expect(got.progress.asOf).toBeTruthy();
  });

  test("no record at all → no-run/none, not 0%", () => {
    const root = tree({ records: [] });
    try {
      expect(readWorkspaceSummary(root)).toEqual({ kind: "no-run", reason: "none" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("several records and no cursor → no-run/ambiguous, a different sentence", () => {
    const root = tree({ records: ["260101-a", "260102-b"] });
    try {
      expect(readWorkspaceSummary(root)).toEqual({ kind: "no-run", reason: "ambiguous" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a cursor picks one of several records", () => {
    const root = tree({ records: ["260101-a", "260102-b"], cursor: "260102-b" });
    try {
      const got = readWorkspaceSummary(root);
      expect(got.kind).toBe("ok");
      if (got.kind === "ok") expect(got.record).toBe("260102-b");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a state file that resolves and cannot be read → unreadable, never a throw", () => {
    // `resolveState` only asks whether the path EXISTS, so a directory named
    // `aidlc-state.md` resolves and then fails to read. The module must degrade, not throw.
    const root = tree({ records: ["260101-a"], stateAsDir: true });
    try {
      expect(readWorkspaceSummary(root)).toEqual({ kind: "unreadable" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a path that is not a workspace at all degrades rather than throwing", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-none-"));
    try {
      expect(readWorkspaceSummary(empty)).toEqual({ kind: "no-run", reason: "none" });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
