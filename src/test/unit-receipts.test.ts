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
import { parseAuditShard } from "../scan/audit";
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
