// The unit-receipt reader (scan/unit-receipts.ts) transcribes the engine's
// `unitLifecycleSnapshot` cluster. It was run against the engine 2.11.0 source,
// extracted and fed the same ledgers, on 6,000 random two-shard ledgers (36,000
// cells, 2,722 settled and 3,240 skipped among them) with no disagreement, measured
// 2026-10-09. Each case below is one of the rules that comparison covers and the
// earlier reader got wrong; every expectation is what the engine returned for it.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { renderBody } from "../render/page";
import { parseAuditShard } from "../scan/audit";
import { readUnitLifecycle } from "../scan/matrix";
import { parseState } from "../scan/parser";
import { type ReceiptPolicy, readUnitReceipts } from "../scan/unit-receipts";

const ORDER = ["functional-design", "nfr-design", "code-generation"];
const POLICY: ReceiptPolicy = {
  unitMajor: false,
  unitScoped: false,
  team: false,
  receiptsRequired: false,
  stageIndex: (s) => ORDER.indexOf(s),
};

/** Blocks as `**Field**: value` lines, one shard per array. */
function ledger(...shards: Record<string, string>[][]) {
  const events = shards.flatMap((blocks, si) =>
    parseAuditShard(
      [
        "# Audit",
        ...blocks.map((b) =>
          Object.entries(b)
            .map(([k, v]) => `**${k}**: ${v}`)
            .join("\n"),
        ),
      ].join("\n---\n"),
      `host-${si}.md`,
      undefined,
      si,
    ),
  );
  return events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}
const at = (m: number) => `2026-10-09T00:${String(m).padStart(2, "0")}:00Z`;
const unit = (
  event: string,
  m: number,
  stage: string,
  u: string,
  floor: string,
  extra: Record<string, string> = {},
) => ({
  Event: event,
  Timestamp: at(m),
  Stage: stage,
  Unit: u,
  "Run floor": floor,
  ...extra,
});
const read = (events: ReturnType<typeof ledger>, p: Partial<ReceiptPolicy> = {}) =>
  readUnitReceipts(events, { ...POLICY, ...p });

describe("unit receipts — the engine's rules", () => {
  test("a jump to a later stage leaves an earlier stage's receipts alone", () => {
    // The old reader reset every stage on every jump.
    const e = ledger([
      unit("UNIT_COMPLETED", 1, "functional-design", "u1", "unstarted#0"),
      { Event: "STAGE_JUMPED", Timestamp: at(2), Stage: "x", Target: "code-generation" },
    ]);
    expect(read(e).state("u1", "functional-design").state).toBe("settled");
    const back = ledger([
      unit("UNIT_COMPLETED", 1, "functional-design", "u1", "unstarted#0"),
      { Event: "STAGE_JUMPED", Timestamp: at(2), Stage: "x", Target: "functional-design" },
    ]);
    expect(read(back).state("u1", "functional-design").state).toBe("unsettled");
  });

  test("a unit's own reopen revokes its receipt in every mode, and only its", () => {
    // `GATE_REJECTED` naming a unit: the old reader passed unit "" outside team mode, so
    // the reopen matched nothing and the unit to redo stayed complete.
    const e = ledger([
      unit("UNIT_COMPLETED", 1, "functional-design", "u1", "unstarted#0"),
      unit("UNIT_COMPLETED", 1, "functional-design", "u2", "unstarted#0"),
      {
        Event: "GATE_REJECTED",
        Timestamp: at(2),
        Stage: "functional-design",
        Unit: "u1",
        "Gate Scope": "unit-end",
      },
    ]);
    const r = read(e);
    expect(r.state("u1", "functional-design").state).toBe("unsettled");
    expect(r.state("u2", "functional-design").state).toBe("settled");
  });

  test("UNIT_SKIPPED is its own verdict, with the engine's reason, until a later row decides", () => {
    const skip = unit("UNIT_SKIPPED", 1, "nfr-design", "u1", "unstarted#0", {
      Reason: "no NFR for a spec unit",
    });
    expect(read(ledger([skip])).state("u1", "nfr-design")).toEqual({
      state: "skipped",
      reason: "no NFR for a spec unit",
    });
    const restarted = ledger([skip, unit("UNIT_STARTED", 2, "nfr-design", "u1", "unstarted#0")]);
    expect(read(restarted).state("u1", "nfr-design").state).toBe("unsettled");
  });

  test("checkpoints by policy make receipts the authority before any unit row exists", () => {
    // `unitLedgerFor`: `inUse || receiptsRequired`. Measured: checkpoints on + stage-major,
    // engine required receipts, the old reader stayed artifact-driven.
    expect(read([]).inUse("code-generation")).toBe(false);
    expect(read([], { receiptsRequired: true }).inUse("code-generation")).toBe(true);
  });

  test("receipts finished under unit-major survive a switch back to stage-major", () => {
    // A stage start recorded while unit-major flooring was in force is not a restart under
    // stage-major (`stageStartsUnderUnitFlooring`), so it does not reset the floor.
    const policy = {
      Event: "CONSTRUCTION_POLICY_SET",
      Timestamp: at(3),
      Field: "Construction Iteration",
      Value: "stage-major",
      "Previous Value": "unit-major",
      "Construction Iteration": "unit-major",
      "Construction Checkpoints": "disabled",
    };
    const e = ledger([
      unit("UNIT_COMPLETED", 1, "functional-design", "u1", "unstarted#0"),
      { Event: "STAGE_STARTED", Timestamp: at(2), Stage: "functional-design" },
      policy,
    ]);
    expect(read(e).state("u1", "functional-design").state).toBe("settled");
    // Without the policy row the same start IS a restart, and the receipt is stale.
    const noPolicy = ledger([
      unit("UNIT_COMPLETED", 1, "functional-design", "u1", "unstarted#0"),
      { Event: "STAGE_STARTED", Timestamp: at(2), Stage: "functional-design" },
    ]);
    expect(read(noPolicy).state("u1", "functional-design").state).toBe("unsettled");
  });

  test("a cross-shard tie in the last boundary second is rebuilt as the engine's AMBIGUOUS token", () => {
    // The old reader could not rebuild it and reported every such unit unverifiable. The
    // token below is what the engine's own floor function returned for these blocks.
    const start = { Event: "STAGE_STARTED", Timestamp: at(5), Stage: "functional-design" };
    const token = "AMBIGUOUS:2026-10-09T00:05:00Z#13c90a487181";
    const withReceipt = (floor: string) =>
      read(ledger([start, unit("UNIT_COMPLETED", 6, "functional-design", "u1", floor)], [start]));
    expect(withReceipt(token).state("u1", "functional-design").state).toBe("settled");
    expect(
      withReceipt("AMBIGUOUS:2026-10-09T00:05:00Z#000000000000").state("u1", "functional-design")
        .state,
    ).toBe("unsettled");
  });
});

describe("receipts required by policy, end to end", () => {
  test("checkpoints on a scope that writes code make a met-but-unreceipted cell unsettled", () => {
    // The fixture has no UNIT_* row at all, so before this its cells were artifact-driven
    // and a fully written code-generation unit read complete. With checkpoints enabled and
    // code-generation marked `workspace_requires`, the engine requires its receipt.
    const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-rc-"));
    fs.cpSync(FIXTURE, root, { recursive: true });
    const graph = path.join(root, ".kiro", "tools", "data", "stage-graph.json");
    const g = JSON.parse(fs.readFileSync(graph, "utf-8"));
    const stagesOf = (x: unknown): { slug: string; workspace_requires?: boolean }[] =>
      Array.isArray(x) ? x : (x as { stages: { slug: string }[] }).stages;
    for (const st of stagesOf(g)) if (st.slug === "code-generation") st.workspace_requires = true;
    fs.writeFileSync(graph, JSON.stringify(g));
    const statePath = path.join(
      root,
      "aidlc/spaces/default/intents/260101-demo-migration/aidlc-state.md",
    );
    const before = assemble(root).matrix?.stages.find((s) => s.slug === "code-generation")?.cells[0]
      ?.state;
    expect(before).toBe("complete");
    fs.writeFileSync(
      statePath,
      fs
        .readFileSync(statePath, "utf-8")
        .replace(
          "- **Revision Count**: 2",
          "- **Revision Count**: 2\n- **Construction Checkpoints**: enabled",
        ),
    );
    const after = assemble(root).matrix?.stages.find((s) => s.slug === "code-generation")?.cells[0]
      ?.state;
    expect(after).toBe("unsettled");
  });
});

describe("second-review regressions — receipts at the matrix boundary", () => {
  const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
  const STATE_REL = "aidlc/spaces/default/intents/260101-demo-migration/aidlc-state.md";
  function tree(editState: (s: string) => string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-rc2-"));
    fs.cpSync(FIXTURE, root, { recursive: true });
    const graph = path.join(root, ".kiro", "tools", "data", "stage-graph.json");
    const g = JSON.parse(fs.readFileSync(graph, "utf-8"));
    const list: { slug: string; workspace_requires?: boolean }[] = Array.isArray(g) ? g : g.stages;
    for (const st of list) if (st.slug === "code-generation") st.workspace_requires = true;
    fs.writeFileSync(graph, JSON.stringify(g));
    const p = path.join(root, STATE_REL);
    fs.writeFileSync(p, editState(fs.readFileSync(p, "utf-8")));
    return root;
  }
  const checkpoints = (s: string) =>
    s.replace(
      "- **Revision Count**: 2",
      "- **Revision Count**: 2\n- **Construction Checkpoints**: enabled",
    );
  const cellsOf = (root: string, slug: string) =>
    assemble(root)
      .matrix?.stages.find((s) => s.slug === slug)
      ?.cells.map((c) => c.state);

  test("a code stage the run skipped at runtime does not make receipts required", () => {
    // `unitMajorConstructionStageSlugs` excludes `[S]`; counting it turned every other
    // stage's artifact-only cells unsettled.
    const skippedCode = tree((s) =>
      checkpoints(s).replace("- [-] code-generation — EXECUTE", "- [S] code-generation — EXECUTE"),
    );
    expect(cellsOf(skippedCode, "functional-design")).toEqual(["complete", "complete"]);
    expect(cellsOf(tree(checkpoints), "functional-design")).toEqual(["unsettled", "unsettled"]);
  });

  test("a stage's action is the word after the em dash, not the word anywhere", () => {
    const root = tree((s) =>
      s.replace(
        "- [x] functional-design — EXECUTE",
        "- [x] functional-design — EXECUTE: do not SKIP the review",
      ),
    );
    const fd = assemble(root)
      .state.phases.flatMap((p) => p.stages)
      .find((s) => s.slug === "functional-design");
    expect(fd?.execute).toBe(true);
  });

  test("a completion that names its stage and unit only through Context is not a receipt", () => {
    // The engine reads the raw Stage/Unit fields; the parser's Context inference must not
    // be promoted to receipt authority.
    const shard = [
      "# Audit",
      "**Event**: UNIT_STARTED\n**Timestamp**: 2026-10-09T00:01:00Z\n**Stage**: code-generation\n**Unit**: PU-A\n**Run floor**: unstarted#0",
      "**Event**: UNIT_COMPLETED\n**Timestamp**: 2026-10-09T00:02:00Z\n**Context**: construction > PU-A > code-generation > x.md\n**Run floor**: unstarted#0",
    ].join("\n---\n");
    const events = parseAuditShard(shard, "h.md", (s) => s === "code-generation", 0);
    expect(events[1]?.stage).toBe("code-generation");
    expect(readUnitLifecycle(events).state("PU-A", "code-generation").state).toBe("unsettled");
  });

  test("a stage whose only unit rows are skips still shows the skip", () => {
    // UNIT_SKIPPED does not count toward `inUse`, and the skip writer emits no UNIT_STARTED.
    const lc = readUnitLifecycle([
      {
        event: "UNIT_SKIPPED",
        stage: "code-generation",
        unit: "PU-A",
        fields: { "Run floor": "unstarted#0", Reason: "r" },
      },
    ]);
    expect(lc.inUse("code-generation")).toBe(false);
    expect(lc.state("PU-A", "code-generation")).toEqual({ state: "skipped", reason: "r" });
  });
});

describe("2.11-only review regressions", () => {
  test("a stage row with no suffix takes the scope's own action, as the engine does", () => {
    // `unitMajorConstructionStageSlugs`: `suffix ?? mapping.stages[slug]`, for a known scope.
    const grid = {
      bugfix: { "nfr-design": "SKIP" as const, "code-generation": "EXECUTE" as const },
    };
    const state = (scope: string, row: string) =>
      `- **Scope**: ${scope}\n\n## Stage Progress\n### CONSTRUCTION PHASE\n${row}\n`;
    const exec = (scope: string, row: string) =>
      parseState(state(scope, row), undefined, grid).phases.flatMap((p) => p.stages)[0]?.execute;
    expect(exec("bugfix", "- [ ] nfr-design")).toBe(false);
    expect(exec("bugfix", "- [ ] nfr-design SKIP")).toBe(false);
    expect(exec("bugfix", "- [ ] nfr-design — EXECUTE: do not SKIP review")).toBe(true);
    expect(exec("bugfix", "- [ ] code-generation")).toBe(true);
    // A scope the grid does not know gives no default.
    expect(exec("custom", "- [ ] nfr-design")).toBe(true);
  });

  test("under team ownership a current UNIT_SKIPPED is read as the engine reads it", () => {
    // The engine's team path adds only the claim-attempt filter (`eventMatchesClaimAttempt`)
    // before the same floor and reduction. With no scope stamp and no `Attempt Generation`
    // on the unit's rows that filter passes every row, so the skip is exactly the engine's
    // — and it was read `team-claim`, which the matrix drew absent.
    const team = { team: true, unitScoped: true };
    const skip = unit("UNIT_SKIPPED", 1, "nfr-design", "u1", "unstarted#0", {
      Reason: "no NFR for a spec unit",
    });
    expect(read(ledger([skip]), team).state("u1", "nfr-design")).toEqual({
      state: "skipped",
      reason: "no NFR for a spec unit",
    });
    // A later start on the same floor supersedes it; a reopen of that unit moves its floor.
    const restarted = ledger([skip, unit("UNIT_STARTED", 2, "nfr-design", "u1", "unstarted#0")]);
    expect(read(restarted, team).state("u1", "nfr-design")).toEqual({
      state: "unverifiable",
      reason: "team-claim",
    });
    const reopened = ledger([
      skip,
      { Event: "GATE_REJECTED", Timestamp: at(2), Stage: "nfr-design", Unit: "u1" },
    ]);
    expect(read(reopened, team).state("u1", "nfr-design").state).not.toBe("skipped");
    // Another clone's pause in the same second outranks the skip.
    const tie = ledger([skip], [unit("UNIT_PAUSED", 1, "nfr-design", "u1", "unstarted#0")]);
    expect(read(tie, team).state("u1", "nfr-design").state).not.toBe("skipped");
  });

  test("under team ownership a skip the claim filter decides is a can't-tell, either way", () => {
    // A row carrying `Attempt Generation` is judged against the claim generations file, and
    // a scope stamp keeps only its own unit's rows — neither is read here. The filter can
    // drop the skip (a stale generation) or restore it by dropping the row after it, both
    // reproduced against the engine, so neither a skip nor a supersession is claimed.
    const team = { team: true, unitScoped: true };
    const cantTell = { state: "unverifiable", reason: "team-claim-skip" } as const;
    const gen = (g: string, extra: Record<string, string> = {}) => ({
      Reason: "covered by u2",
      "Attempt Generation": g,
      ...extra,
    });
    const stale = ledger([unit("UNIT_SKIPPED", 1, "nfr-design", "u1", "unstarted#0", gen("1"))]);
    expect(read(stale, team).state("u1", "nfr-design")).toEqual(cantTell);
    const restored = ledger([
      unit("UNIT_SKIPPED", 1, "nfr-design", "u1", "unstarted#0", gen("2")),
      unit("UNIT_STARTED", 2, "nfr-design", "u1", "unstarted#0", { "Attempt Generation": "1" }),
    ]);
    expect(read(restored, team).state("u1", "nfr-design")).toEqual(cantTell);
    const plain = ledger([
      unit("UNIT_SKIPPED", 1, "nfr-design", "u1", "unstarted#0", { Reason: "covered by u2" }),
    ]);
    expect(read(plain, { ...team, scopeStamp: true }).state("u1", "nfr-design")).toEqual(cantTell);
    // A unit with no current skip row keeps the claim's reason; outside team ownership the
    // stamp means nothing.
    const done = ledger([
      unit("UNIT_COMPLETED", 1, "nfr-design", "u1", "unstarted#0", { "Attempt Generation": "1" }),
    ]);
    expect(read(done, team).state("u1", "nfr-design")).toEqual({
      state: "unverifiable",
      reason: "team-claim",
    });
    expect(read(plain, { scopeStamp: true }).state("u1", "nfr-design")).toEqual({
      state: "skipped",
      reason: "covered by u2",
    });
  });

  test("under team ownership a unit with no Run floor at all is known not done", () => {
    // The claim file can only decide rows that could be current; a row with no floor
    // fails the engine's exact match whatever the claim says.
    const e = ledger([
      { Event: "UNIT_COMPLETED", Timestamp: at(1), Stage: "functional-design", Unit: "u1" },
      unit("UNIT_COMPLETED", 1, "functional-design", "u2", "unstarted#0"),
    ]);
    const r = read(e, { team: true, unitScoped: true });
    expect(r.state("u1", "functional-design").state).toBe("unsettled");
    expect(r.state("u2", "functional-design")).toEqual({
      state: "unverifiable",
      reason: "team-claim",
    });
  });
});

describe("team ownership, end to end", () => {
  test("a unit the engine skipped is drawn skipped, not absent, and leaves the denominator", () => {
    // Measured against the 2.11.0 `unitSkippedUnits` on this exact tree: it returns the
    // unit as skipped. The matrix drew it absent — a fabricated blocker in the count.
    const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
    const REC = "aidlc/spaces/default/intents/260101-demo-migration";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-team-skip-"));
    fs.cpSync(FIXTURE, root, { recursive: true });
    fs.rmSync(path.join(root, REC, "construction/PU-B-ui/functional-design"), { recursive: true });
    const statePath = path.join(root, REC, "aidlc-state.md");
    fs.writeFileSync(
      statePath,
      fs
        .readFileSync(statePath, "utf-8")
        .replace("- **Revision Count**: 2", "- **Revision Count**: 2\n- **Unit Ownership**: team"),
    );
    const shard = path.join(root, REC, "audit/demo-host-aabbccdd1122.md");
    fs.appendFileSync(
      shard,
      [
        "",
        "## Unit Skipped",
        "**Timestamp**: 2026-01-01T02:30:00Z",
        "**Event**: UNIT_SKIPPED",
        "**Stage**: functional-design",
        "**Unit**: PU-B-ui",
        "**Reason**: no UI behaviour to design",
        "**Run floor**: STAGE_STARTED:2026-01-01T02:00:00Z#1",
        "",
        "---",
        "",
      ].join("\n"),
    );
    const m = assemble(root);
    const stage = m.matrix?.stages.find((s) => s.slug === "functional-design");
    const cell = stage?.cells.find((c) => c.unit === "PU-B-ui");
    expect(cell?.state).toBe("skipped");
    expect(cell?.skipReason).toBe("no UI behaviour to design");
    expect(stage?.skipped).toBe(1);
    // Out of the denominator: one applicable unit, and it is complete.
    expect(renderBody(m, "en")).toContain("1/1 (–1⊘)");

    // A scope stamp in the checkout keeps only its own unit's rows, which is not checked
    // here — so the same skip becomes a can't-tell, still not "not started". Presence alone
    // counts, conservatively: this empty stamp is one the engine would ignore.
    fs.writeFileSync(path.join(root, "aidlc", ".aidlc-unit-scope.json"), "{}\n");
    const stamped = assemble(root).matrix?.stages.find((s) => s.slug === "functional-design");
    const held = stamped?.cells.find((c) => c.unit === "PU-B-ui");
    expect(held?.state).toBe("unverified");
    expect(held?.receiptReason).toBe("team-claim-skip");
    expect(stamped?.skipped).toBe(0);
  });
});
