// Unit tests for the scan layer's format contracts. Each parser is exercised from
// a string where possible, so a format change fails here rather than silently
// producing a plausible-but-wrong number on the page.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { copiedAuditBlocks, parseAuditShard, parseContext, readAuditLedger } from "../scan/audit";
import type { AuditEvent } from "../scan/audit";
import { parseDeferralSections, readDeferrals, resolveOwner } from "../scan/deferrals";
import { engineReadDir } from "../scan/engine-dir";
import { parseDrops, readHealth } from "../scan/hooks-health";
import {
  type BoltDag,
  type LifecycleEvent,
  buildConstructionMatrix,
  parseBoltDag,
  readUnitLifecycle,
} from "../scan/matrix";
import { parseDiary, readDiaries } from "../scan/memory-diary";
import { type StageInfo, parseState, parseUnitProgress } from "../scan/parser";
import { parseQuestions, parseQuestionsFile, readQuestions } from "../scan/questions";
import { buildRework } from "../scan/rework";
import { parseSensorDetail, readSensorReport } from "../scan/sensors";
import {
  type CatalogStage,
  expectedArtifacts,
  requiredArtifacts,
  vacuouslyCovered,
} from "../scan/stage-catalog";
import {
  BIN_SEC,
  type GapSplit,
  buildBins,
  buildTiming,
  buildUnitSpans,
  buildWorkers,
  classifyGaps,
  shardLabel,
} from "../scan/timing";

describe("audit shard", () => {
  const SHARD = `# AI-DLC Audit Log

## Stage Start
**Timestamp**: 2026-01-01T00:00:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: orchestrator

---

## Sensor Fired
**Timestamp**: 2026-01-01T00:01:00Z
**Event**: SENSOR_FIRED
**Fire id**: abcd1234
**Sensor ID**: type-check
**Stage slug**: code-generation

---
`;

  test("parses blocks and keeps every field", () => {
    const ev = parseAuditShard(SHARD, "s.md");
    expect(ev.length).toBe(2);
    expect(ev[0]?.event).toBe("STAGE_STARTED");
    expect(ev[0]?.stage).toBe("intent-capture");
    expect(ev[0]?.fields.Agent).toBe("orchestrator");
    expect(ev[0]?.shard).toBe("s.md");
  });

  test("reads `Stage slug` for sensor rows", () => {
    const ev = parseAuditShard(SHARD, "s.md");
    expect(ev[1]?.stage).toBe("code-generation");
    expect(ev[1]?.fields["Fire id"]).toBe("abcd1234");
  });

  // A sync tool's conflict copy repeats every row; read twice, each row ties with
  // itself across two files and the counts double.
  test("a conflict copy of a shard is read once, from the shard-named file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-copy-"));
    try {
      fs.mkdirSync(path.join(dir, "audit"));
      const extra =
        "\n## Stage Done\n**Timestamp**: 2026-01-01T00:02:00Z\n**Event**: STAGE_COMPLETED\n**Stage**: intent-capture\n\n---\n";
      fs.writeFileSync(path.join(dir, "audit", "host-aabbccdd1122.md"), SHARD);
      // The copy has one row the original lacks: it is still read, once.
      fs.writeFileSync(path.join(dir, "audit", "host-aabbccdd1122 2.md"), SHARD + extra);
      const ledger = readAuditLedger(dir);
      expect(ledger.events.map((e) => e.event)).toEqual([
        "STAGE_STARTED",
        "SENSOR_FIRED",
        "STAGE_COMPLETED",
      ]);
      expect(ledger.counts.get("STAGE_STARTED")).toBe(1);
      // The shared rows come from the shard-named file even though the copy holds more.
      expect(ledger.events[0]?.shard).toBe("host-aabbccdd1122.md");
      expect(ledger.events[2]?.shard).toBe("host-aabbccdd1122 2.md");
      // Positions are the file's own, never renumbered after a skip.
      expect(ledger.events[2]?.pos).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shards that start differently are never compared, even with an identical row", () => {
    const other = SHARD.replace("**Agent**: orchestrator", "**Agent**: someone-else");
    const skip = copiedAuditBlocks([
      { shard: "a-aabbccdd1122.md", content: SHARD },
      { shard: "b-112233445566.md", content: other },
    ]);
    expect(skip.map((set) => set.size)).toEqual([0, 0]);
  });

  test("repeats inside one file are not copies", () => {
    const twice = `${SHARD}${SHARD.slice(SHARD.indexOf("\n## Sensor"))}`;
    expect(parseAuditShard(twice, "s.md").filter((e) => e.event === "SENSOR_FIRED").length).toBe(2);
    expect(copiedAuditBlocks([{ shard: "s.md", content: twice }])[0]?.size).toBe(0);
  });

  test("skips the title block (no Timestamp/Event)", () => {
    expect(parseAuditShard("# Title\n\n---\n", "s.md")).toEqual([]);
  });

  test("a direct `Unit` field beats Context, and works with no Context at all", () => {
    // UNIT_* rows carry `Timestamp, Stage, Unit, Run floor` and NO Context, so reading
    // only Context left event.unit undefined on exactly the events that say which unit
    // finished — which is also what the completion receipts are.
    const ev = parseAuditShard(
      `## Unit Complete
**Timestamp**: 2026-01-01T00:00:00Z
**Event**: UNIT_COMPLETED
**Stage**: code-generation
**Unit**: api

---
`,
      "s.md",
    );
    expect(ev[0]?.unit).toBe("api");
    expect(ev[0]?.stage).toBe("code-generation");
  });

  test("tolerates CRLF", () => {
    const ev = parseAuditShard(SHARD.replace(/\n/g, "\r\n"), "s.md");
    expect(ev.length).toBe(2);
    expect(ev[0]?.stage).toBe("intent-capture");
  });
  // The engine's `readAuditShardTexts` refuses a shard reached through a symlink —
  // the shard itself or any directory between the workspace root and it — and a `.md`
  // that is not a regular file. The root itself may be a link: the chain starts there.
  describe("a shard reached through a symlink is refused, as the engine refuses it", () => {
    const withTree = (fn: (root: string, record: string, elsewhere: string) => void) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-link-"));
      try {
        const root = path.join(tmp, "ws");
        const record = path.join(root, "aidlc", "spaces", "default", "intents", "r1");
        const elsewhere = path.join(tmp, "elsewhere");
        fs.mkdirSync(path.join(record, "audit"), { recursive: true });
        fs.mkdirSync(elsewhere);
        fn(root, record, elsewhere);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    };

    test("a symlinked shard is not read, and is named", () => {
      withTree((root, record, elsewhere) => {
        fs.writeFileSync(path.join(record, "audit", "host-aaaa.md"), SHARD);
        fs.writeFileSync(path.join(elsewhere, "copy.md"), SHARD);
        fs.symlinkSync(path.join(elsewhere, "copy.md"), path.join(record, "audit", "host-bbbb.md"));
        const ledger = readAuditLedger(record, undefined, root);
        expect(ledger.shards).toEqual(["host-aaaa.md"]);
        expect(ledger.events.length).toBe(2);
        expect(ledger.refused).toEqual([
          path.join("aidlc", "spaces", "default", "intents", "r1", "audit", "host-bbbb.md"),
        ]);
      });
    });

    test("a symlinked audit dir, or a symlinked dir above the record, refuses every shard", () => {
      withTree((root, record, elsewhere) => {
        fs.writeFileSync(path.join(elsewhere, "host-aaaa.md"), SHARD);
        fs.rmdirSync(path.join(record, "audit"));
        fs.symlinkSync(elsewhere, path.join(record, "audit"));
        const ledger = readAuditLedger(record, undefined, root);
        expect(ledger.events).toEqual([]);
        expect(ledger.refused).toEqual([
          path.join("aidlc", "spaces", "default", "intents", "r1", "audit"),
        ]);
      });
      withTree((root, _record, elsewhere) => {
        // `intents` → a copy elsewhere: the record is real, the chain to it is not.
        const intents = path.join(root, "aidlc", "spaces", "default", "intents");
        fs.renameSync(intents, path.join(elsewhere, "intents"));
        fs.symlinkSync(path.join(elsewhere, "intents"), intents);
        fs.writeFileSync(path.join(intents, "r1", "audit", "host-aaaa.md"), SHARD);
        const ledger = readAuditLedger(path.join(intents, "r1"), undefined, root);
        expect(ledger.events).toEqual([]);
        expect(ledger.refused?.length).toBe(1);
      });
    });

    test("a symlinked workspace root is still read — the chain starts below it", () => {
      withTree((root, record, elsewhere) => {
        fs.writeFileSync(path.join(record, "audit", "host-aaaa.md"), SHARD);
        const link = path.join(elsewhere, "ws-link");
        fs.symlinkSync(root, link);
        const viaLink = path.join(link, path.relative(root, record));
        const ledger = readAuditLedger(viaLink, undefined, link);
        expect(ledger.events.length).toBe(2);
        expect(ledger.refused).toEqual([]);
      });
    });

    test("a `.md` that is not a regular file is refused", () => {
      withTree((root, record) => {
        fs.mkdirSync(path.join(record, "audit", "notes.md"));
        fs.writeFileSync(path.join(record, "audit", "host-aaaa.md"), SHARD);
        const ledger = readAuditLedger(record, undefined, root);
        expect(ledger.shards).toEqual(["host-aaaa.md"]);
        expect(ledger.refused).toEqual([
          path.join("aidlc", "spaces", "default", "intents", "r1", "audit", "notes.md"),
        ]);
      });
    });

    test("a dangling audit-dir link is refused, not mistaken for an absent dir", () => {
      withTree((root, record, elsewhere) => {
        fs.rmdirSync(path.join(record, "audit"));
        fs.symlinkSync(path.join(elsewhere, "gone"), path.join(record, "audit"));
        expect(readAuditLedger(record, undefined, root).refused).toEqual([
          path.join("aidlc", "spaces", "default", "intents", "r1", "audit"),
        ]);
      });
    });

    test("a shard whose text is exactly the word `refused` is read", () => {
      withTree((root, record) => {
        fs.writeFileSync(path.join(record, "audit", "host-aaaa.md"), "refused");
        const ledger = readAuditLedger(record, undefined, root);
        expect(ledger.shards).toEqual(["host-aaaa.md"]);
        expect(ledger.refused).toEqual([]);
      });
    });

    test("components are cut on both slash families, as the engine cuts them", () => {
      if (path.sep !== "/") return;
      withTree((root, record) => {
        // A POSIX name holding `..\` reads to the engine as a `..` component.
        fs.writeFileSync(path.join(record, "audit", "..\\x.md"), SHARD);
        fs.writeFileSync(path.join(record, "audit", "host-aaaa.md"), SHARD);
        const ledger = readAuditLedger(record, undefined, root);
        expect(ledger.shards).toEqual(["host-aaaa.md"]);
        expect(ledger.refused).toEqual([
          path.join("aidlc", "spaces", "default", "intents", "r1", "audit", "..\\x.md"),
        ]);
      });
    });

    test("without an anchor the chain is checked from the record dir down", () => {
      withTree((_root, record, elsewhere) => {
        fs.writeFileSync(path.join(elsewhere, "copy.md"), SHARD);
        fs.symlinkSync(path.join(elsewhere, "copy.md"), path.join(record, "audit", "host-bbbb.md"));
        const ledger = readAuditLedger(record);
        expect(ledger.events).toEqual([]);
        expect(ledger.refused).toEqual([path.join("audit", "host-bbbb.md")]);
      });
    });
  });
});

describe("Context attribution", () => {
  // The whole point of the isStage oracle: these two 4-segment forms mean
  // different things and position alone cannot separate them.
  const isStage = (s: string) => ["practices-discovery", "functional-design"].includes(s);

  test("4 segments where slot2 is a SUBDIR → stage is slot1, no unit", () => {
    const r = parseContext("inception > practices-discovery > contributions > x.md", isStage);
    expect(r.stage).toBe("practices-discovery");
    expect(r.unit).toBeUndefined();
  });

  test("4 segments where slot2 is a STAGE → stage is slot2, unit is slot1", () => {
    const r = parseContext("construction > PU-1 > functional-design > x.md", isStage);
    expect(r.stage).toBe("functional-design");
    expect(r.unit).toBe("PU-1");
  });

  test("3 segments → stage is slot1", () => {
    expect(parseContext("inception > practices-discovery > x.md", isStage).stage).toBe(
      "practices-discovery",
    );
  });

  test("no known stage in the path → unattributed, not guessed", () => {
    expect(parseContext("verification > phase-check-ideation.md", isStage).stage).toBeUndefined();
    expect(parseContext("codekb > repo > architecture.md", isStage).stage).toBeUndefined();
  });

  test("without the oracle, falls back to position", () => {
    expect(parseContext("construction > PU-1 > functional-design > x.md").stage).toBe(
      "functional-design",
    );
    // And is wrong on the subdir shape — the documented cost of no catalogue.
    expect(parseContext("inception > practices-discovery > contributions > x.md").stage).toBe(
      "contributions",
    );
  });
});

describe("stage catalogue expectations", () => {
  const stage: CatalogStage = {
    // `for_each: "unit-of-work"` is what makes a stage per-unit — the matrix reads this
    // now rather than a hardcoded slug list, so a fixture without it is not per-unit.
    forEach: "unit-of-work",
    slug: "functional-design",
    number: "3.1",
    name: "Functional Design",
    phase: "construction",
    produces: ["business-logic-model", "business-rules"],
    optionalProduces: ["frontend-components"],
    producesKinds: {
      "business-rules": ["service", "spec", "library"],
      "frontend-components": ["ui"],
    },
    sensors: [],
  };

  test("kind-agnostic artifacts apply to every unit", () => {
    expect(expectedArtifacts(stage, "ui")).toContain("business-logic-model");
    expect(expectedArtifacts(stage, "library")).toContain("business-logic-model");
  });

  test("kind-scoped artifacts apply only to their kinds", () => {
    expect(expectedArtifacts(stage, "ui")).toEqual(["business-logic-model", "frontend-components"]);
    expect(expectedArtifacts(stage, "library")).toEqual(["business-logic-model", "business-rules"]);
  });

  test("unknown kind keeps only the kind-agnostic ones (under-claim, never over)", () => {
    expect(expectedArtifacts(stage, undefined)).toEqual(["business-logic-model"]);
  });

  test("optional_produces is NOT required — the engine does not check it either", () => {
    // `unitCovered` in aidlc-orchestrate.ts: "node.optional_produces entries are
    // DELIBERATELY not checked here ... their absence never blocks coverage." Unioning
    // them made a ui unit that wrote everything required read `partial`.
    expect(requiredArtifacts(stage, "ui")).toEqual(["business-logic-model"]);
    expect(expectedArtifacts(stage, "ui")).toEqual(["business-logic-model", "frontend-components"]);
    expect(requiredArtifacts(stage, "library")).toEqual(["business-logic-model", "business-rules"]);
  });

  test("vacuously covered mirrors the engine's two-step, unfiltered guard first", () => {
    // A kind no REQUIRED artifact applies to is n/a...
    const uiOnly: CatalogStage = {
      ...stage,
      produces: ["business-rules"],
      optionalProduces: [],
      producesKinds: { "business-rules": ["service"] },
    };
    expect(vacuouslyCovered(uiOnly, "ui")).toBe(true);
    expect(vacuouslyCovered(uiOnly, "service")).toBe(false);
    // ...but a stage declaring NO required artifact at all can never be proven covered,
    // so it is not n/a either — it is unknown.
    expect(vacuouslyCovered({ ...stage, produces: [] }, "ui")).toBe(false);
  });
});

describe("unit progress table", () => {
  const TABLE = `## Unit Progress

| unit | owner | functional-design | code-generation | gate | merged |
| --- | --- | --- | --- | --- | --- |
| api | jiho | [x] | [-] | [?] | no |
| web | - | [x] | [x] | [x] | yes |

## Current Status
`;

  test("reads columns by HEADER, so an added merged column does not shift anything", () => {
    const up = parseUnitProgress(TABLE)!;
    expect(up.stageColumns).toEqual(["functional-design", "code-generation"]);
    expect(up.rows[0]).toEqual({
      unit: "api",
      owner: "jiho",
      stages: { "functional-design": "done", "code-generation": "active" },
      gate: "awaiting",
      merged: "no",
    });
    expect(up.rows[1]?.owner).toBe("-"); // verbatim; the engine means "unclaimed"
  });

  test("absent section is undefined, not an empty table", () => {
    expect(
      parseUnitProgress("## Stage Progress\n- [x] intent-capture — EXECUTE\n"),
    ).toBeUndefined();
  });

  test("the engine's two header guards are the ones enforced", () => {
    // aidlc-state.ts refuses when header[0] !== "unit" or the separator width differs.
    expect(parseUnitProgress("## Unit Progress\n\n| x | y |\n| --- | --- |\n")?.malformed).toBe(
      true,
    );
    expect(parseUnitProgress("## Unit Progress\n\n| unit | gate |\n| --- |\n")?.malformed).toBe(
      true,
    );
    expect(parseUnitProgress("## Unit Progress\n\nprose only\n")?.malformed).toBe(true);
    // The engine uses `line.startsWith("|")` with NO trim, so an indented table is one it
    // refuses — accepting it here would label a rejected table "authoritative".
    expect(
      parseUnitProgress("## Unit Progress\n\n  | unit | gate |\n  | --- | --- |\n  | api | [x] |\n")
        ?.malformed,
    ).toBe(true);
  });
});

describe("the pre-2.11 Bolt grammar is not read", () => {
  test("`#### Bolt:`, `Current Bolt` and `Bolt batches:` give a stage no unit", () => {
    // The 2.11 state writes one row per stage; no 2.11 reader or writer knows these lines.
    // `Per unit:` stays as inert text (2.11 still writes `Per unit: [TBD]`).
    const st = parseState(
      [
        "- **Current Bolt**: unit-a",
        "## Stage Progress",
        "### CONSTRUCTION PHASE",
        "Per unit: unit-a",
        "Bolt batches: B1=[unit-a]",
        "#### Bolt: unit-a",
        "- [x] functional-design — EXECUTE",
        "- [S] nfr-design — EXECUTE",
      ].join("\n"),
    );
    const rows = st.phases.flatMap((p) => p.stages);
    expect(rows.map((r) => [r.slug, r.status])).toEqual([
      ["functional-design", "done"],
      ["nfr-design", "skipped"],
    ]);
    expect(rows.some((r) => "bolt" in r)).toBe(false);
    expect("constructionBolts" in st).toBe(false);
  });
});

describe("construction matrix", () => {
  const dag: BoltDag = {
    units: [
      { name: "PU-A", display: "Pu A", kind: "library", dependsOn: [] },
      { name: "PU-B", display: "Pu B", kind: "ui", dependsOn: ["PU-A"] },
    ],
    batches: [["PU-A"], ["PU-B"]],
  };
  const stages: StageInfo[] = [
    { slug: "code-generation", display: "Code Generation", status: "active", execute: true },
  ];
  const catalog = {
    stages: [],
    bySlug: new Map<string, CatalogStage>([
      [
        "code-generation",
        {
          forEach: "unit-of-work",
          slug: "code-generation",
          number: "3.5",
          name: "Code Generation",
          phase: "construction",
          produces: ["code-generation-plan", "code-summary"],
          optionalProduces: [],
          producesKinds: {},
          sensors: [],
        },
      ],
    ]),
    sourcePath: "/demo/.kiro/tools/data/stage-graph.json",
    harnessDir: ".kiro",
  };

  test("three states: complete / partial / absent", () => {
    const mx = buildConstructionMatrix(
      dag,
      stages,
      (unit) =>
        unit === "PU-A" ? ["code-generation-plan", "code-summary"] : ["code-generation-plan"],
      catalog,
    )!;
    const cells = mx.stages[0]!.cells;
    expect(cells[0]!.state).toBe("complete");
    expect(cells[1]!.state).toBe("partial");
    expect(cells[1]!.missing).toEqual(["code-summary"]);
    expect(mx.stages[0]!.complete).toBe(1);
    expect(mx.stages[0]!.partial).toBe(1);
    expect(mx.contractAware).toBe(true);
  });

  test("a cell missing ONLY a conditional artifact is complete, not partial", () => {
    const withOptional = {
      ...catalog,
      bySlug: new Map(catalog.bySlug).set("code-generation", {
        ...catalog.bySlug.get("code-generation")!,
        optionalProduces: ["frontend-components"],
        producesKinds: { "frontend-components": ["ui"] },
      }),
    };
    // PU-B is `ui`, so frontend-components is in its contract — but conditionally.
    const mx = buildConstructionMatrix(
      dag,
      stages,
      () => ["code-generation-plan", "code-summary"],
      withOptional,
    )!;
    const ui = mx.stages[0]!.cells[1]!;
    expect(ui.state).toBe("complete");
    expect(ui.missing).toEqual([]);
    // The contract is still shown in full, so the reader sees what MAY be written here.
    expect(ui.expected).toContain("frontend-components");
  });

  test("artifacts met but no receipt is UNSETTLED, not complete", () => {
    // aidlc-orchestrate.ts::unitLedgerFor — "receipts become the completion authority
    // and artifact existence degrades to evidence — a paused or partially-written unit
    // has artifacts but no receipt and stays uncovered (issue: artifact presence was
    // mistaken for completion)."
    const all = () => ["code-generation-plan", "code-summary"];
    // Rows must carry the current `Run floor`, or the engine (and this reader) cannot place
    // them in the current attempt — a ledger without the field reads `unverified`, not ▩.
    const f = { "Run floor": "unstarted#0" };
    const lifecycle = readUnitLifecycle([
      { event: "UNIT_STARTED", stage: "code-generation", unit: "PU-A", fields: f },
      { event: "UNIT_COMPLETED", stage: "code-generation", unit: "PU-A", fields: f },
      { event: "UNIT_PAUSED", stage: "code-generation", unit: "PU-B", fields: f },
    ]);
    const mx = buildConstructionMatrix(dag, stages, all, catalog, lifecycle)!;
    const row = mx.stages[0]!;
    expect(row.cells.map((c) => c.state)).toEqual(["complete", "unsettled"]);
    expect(row.complete).toBe(1);
    expect(row.unsettled).toBe(1);
    // Nothing is MISSING — that is exactly why this is not `partial`.
    expect(row.cells[1]!.missing).toEqual([]);
  });

  test("a later non-completion event REVOKES the receipt", () => {
    // aidlc-lib.ts::unitLifecycleSnapshot, verbatim:
    //   if (row.event !== "UNIT_COMPLETED") { receipts.delete(row.unit);
    // A set that only ever grew read `UNIT_COMPLETED → UNIT_PAUSED` as settled, which is
    // exactly the state the engine calls uncovered.
    const all = () => ["code-generation-plan", "code-summary"];
    const f = { "Run floor": "unstarted#0" };
    for (const later of ["UNIT_PAUSED", "UNIT_STARTED", "UNIT_RESUMED"]) {
      const lc = readUnitLifecycle([
        { event: "UNIT_COMPLETED", stage: "code-generation", unit: "PU-A", fields: f },
        { event: later, stage: "code-generation", unit: "PU-A", fields: f },
      ]);
      expect({ later, state: lc.state("PU-A", "code-generation").state }).toEqual({
        later,
        state: "unsettled",
      });
      const mx = buildConstructionMatrix(dag, stages, all, catalog, lc)!;
      expect(mx.stages[0]!.cells[0]!.state).toBe("unsettled");
    }
    // And a re-completion after the pause settles it again — order decides, not presence.
    const reopened = readUnitLifecycle(
      ["UNIT_COMPLETED", "UNIT_PAUSED", "UNIT_RESUMED", "UNIT_COMPLETED"].map((event) => ({
        event,
        stage: "code-generation",
        unit: "PU-A",
        fields: f,
      })),
    );
    expect(reopened.state("PU-A", "code-generation").state).toBe("settled");
  });

  test("a unit the engine skipped is its own cell, out of the denominator", () => {
    // UNIT_SKIPPED with a reason: before, the unit read as absent — work nobody did.
    const all = () => ["code-generation-plan", "code-summary"];
    const f = { "Run floor": "unstarted#0" };
    const lc = readUnitLifecycle([
      { event: "UNIT_COMPLETED", stage: "code-generation", unit: "PU-A", fields: f },
      {
        event: "UNIT_SKIPPED",
        stage: "code-generation",
        unit: "PU-B",
        fields: { ...f, Reason: "no code for a spec unit" },
      },
    ]);
    const row = buildConstructionMatrix(dag, stages, all, catalog, lc)!.stages[0]!;
    expect(row.cells.map((c) => [c.state, c.skipReason])).toEqual([
      ["complete", undefined],
      ["skipped", "no code for a spec unit"],
    ]);
    expect(row.skipped).toBe(1);
    expect(row.total - row.notApplicable - row.skipped).toBe(1);
  });

  test("a skip shows even on a stage whose only unit rows are skips", () => {
    // Second review: the matrix read verdicts only when receipts were in force, and a skip
    // does not put them in force — the skip writer emits no UNIT_STARTED.
    const lc = readUnitLifecycle([
      {
        event: "UNIT_SKIPPED",
        stage: "code-generation",
        unit: "PU-A",
        fields: { "Run floor": "unstarted#0", Reason: "r" },
      },
    ]);
    const row = buildConstructionMatrix(dag, stages, () => [], catalog, lc)!.stages[0]!;
    expect(row.cells.map((c) => c.state)).toEqual(["skipped", "absent"]);
    expect(row.total - row.notApplicable - row.skipped).toBe(1);
  });

  describe("unit receipts", () => {
    const S = "code-generation";
    /** A well-formed wave fingerprint — without one the engine refuses the receipt outright. */
    const FP = `sha256:${"a".repeat(64)}`;
    const T = "2026-01-01T00:00:00Z";
    const FLOOR = `STAGE_STARTED:${T}#1`;
    const E = (event: string, ts: string, o: Partial<LifecycleEvent> = {}): LifecycleEvent => ({
      event,
      ts,
      stage: S,
      shard: "a.md",
      fields: {},
      ...o,
    });
    /** A UNIT_* row on the CURRENT attempt: the engine requires an exact `Run floor` match. */
    const U = (event: string, ts: string, o: Partial<LifecycleEvent> = {}): LifecycleEvent =>
      E(event, ts, { ...o, fields: { "Run floor": FLOOR, ...(o.fields ?? {}) } });
    const st = (evs: LifecycleEvent[], unit = "api", opts = {}) =>
      readUnitLifecycle(evs, opts).state(unit, S).state;
    /** Why a cell is unverifiable. */
    const why = (evs: LifecycleEvent[], unit = "api", opts = {}) =>
      readUnitLifecycle(evs, opts).state(unit, S).reason;

    test("the `Run floor` FIELD is compared exactly, not just 'after the last boundary'", () => {
      // `if (auditBlockField(row.block, "Run floor") !== floorFor(unit)) continue;` — the
      // engine rebuilds `<event>:<timestamp>#<ordinal>` and demands an exact match. Asking
      // only "is this row later than the boundary?" accepted a stale floor outright.
      expect(
        st([E("STAGE_STARTED", T), U("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "api" })]),
      ).toBe("settled");
      expect(
        st([
          E("STAGE_STARTED", T),
          E("UNIT_COMPLETED", "2026-01-01T01:00:00Z", {
            unit: "api",
            fields: { "Run floor": "STAGE_STARTED:1999-01-01T00:00:00Z#1" },
          }),
        ]),
      ).toBe("unsettled");
      // The ordinal counts occurrences of the event name, so a second STAGE_STARTED in the
      // same second is a different floor — invisible to a timestamp comparison.
      expect(
        st([E("STAGE_STARTED", T), E("STAGE_STARTED", T), U("UNIT_COMPLETED", T, { unit: "api" })]),
      ).toBe("unsettled");
      expect(
        st([
          E("STAGE_STARTED", T),
          E("STAGE_STARTED", T),
          E("UNIT_COMPLETED", T, { unit: "api", fields: { "Run floor": `STAGE_STARTED:${T}#2` } }),
        ]),
      ).toBe("settled");
      // No boundary at all → the engine's `unstarted#0` sentinel.
      expect(
        st([E("UNIT_COMPLETED", T, { unit: "api", fields: { "Run floor": "unstarted#0" } })]),
      ).toBe("settled");
    });

    test("each unverifiable cause is carried, because they disagree on the ENGINE's verdict", () => {
      // A completion with no `Run floor` (a ledger from before the field) fails the
      // engine's exact match and is not current — read as the engine reads it, not held
      // back as a can't-tell. The causes below are the ones the engine could settle.
      const noFloor = [
        E("STAGE_STARTED", T),
        E("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "api" }),
      ];
      expect(st(noFloor)).toBe("unsettled");

      expect(
        why([E("STAGE_STARTED", T), U("UNIT_COMPLETED", T, { unit: "api" })], "api", {
          teamOwnership: true,
        }),
      ).toBe("team-claim");

      expect(
        why([
          E("STAGE_STARTED", T),
          U("UNIT_COMPLETED", T, {
            unit: "api",
            fields: { Mode: "wave", "Artifact Fingerprint": FP },
          }),
        ]),
      ).toBe("wave-fingerprint");

      // Two shards writing a boundary in the same second → the engine's `AMBIGUOUS:` floor.
      expect(
        why([
          E("STAGE_STARTED", T, { shard: "a.md" }),
          E("STAGE_STARTED", T, { shard: "b.md" }),
          U("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "api" }),
        ]),
      ).toBe("ambiguous-floor");

      // A settled cell carries no reason at all.
      expect(
        why([E("STAGE_STARTED", T), U("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "api" })]),
      ).toBeUndefined();
    });

    test("cross-shard rows in one second reduce by the engine's safety rank", () => {
      // rank PAUSED(2) > STARTED/RESUMED(1) > COMPLETED(0), highest wins: "a possible pause
      // blocks all progress … only unanimous terminal candidates settle it". Both orderings
      // are asserted — a one-direction fixture passed by luck of the ordering.
      const pair = (first: string, second: string) => [
        E("STAGE_STARTED", T),
        U(first, "2026-01-01T01:00:00Z", { unit: "api", shard: "a.md" }),
        U(second, "2026-01-01T01:00:00Z", { unit: "api", shard: "b.md" }),
      ];
      expect(st(pair("UNIT_PAUSED", "UNIT_COMPLETED"))).toBe("unsettled");
      expect(st(pair("UNIT_COMPLETED", "UNIT_PAUSED"))).toBe("unsettled");
      expect(st(pair("UNIT_COMPLETED", "UNIT_COMPLETED"))).toBe("settled");
      // Under team ownership the engine runs the same reduction after its claim-attempt
      // filter (`eventMatchesClaimAttempt`), which reads checkout state this reader does
      // not have — so a tie is never settled here, in either order.
      for (const p of [
        pair("UNIT_PAUSED", "UNIT_COMPLETED"),
        pair("UNIT_COMPLETED", "UNIT_PAUSED"),
      ]) {
        expect(readUnitLifecycle(p, { teamOwnership: true }).state("api", S)).toEqual({
          state: "unverifiable",
          reason: "team-claim",
        });
      }
    });

    test("wave mode is judged on THIS attempt's rows only", () => {
      // Checking it before the floor filter let one old wave row block every later attempt
      // for good. The engine filters to the current floor first.
      expect(
        st([
          E("UNIT_COMPLETED", T, {
            unit: "api",
            fields: { Mode: "wave", "Run floor": "unstarted#0" },
          }),
          E("STAGE_STARTED", "2026-01-02T00:00:00Z"),
          E("UNIT_COMPLETED", "2026-01-03T00:00:00Z", {
            unit: "api",
            fields: { "Run floor": "STAGE_STARTED:2026-01-02T00:00:00Z#1" },
          }),
        ]),
      ).toBe("settled");
      expect(
        st([
          E("STAGE_STARTED", T),
          U("UNIT_COMPLETED", T, {
            unit: "api",
            fields: { Mode: "wave", "Artifact Fingerprint": FP },
          }),
        ]),
      ).toBe("unverifiable");
      // No recorded fingerprint, or a malformed one: the engine certainly refuses it.
      for (const fp of [undefined, "sha256:short"]) {
        expect(
          st([
            E("STAGE_STARTED", T),
            U("UNIT_COMPLETED", T, {
              unit: "api",
              fields: { Mode: "wave", ...(fp ? { "Artifact Fingerprint": fp } : {}) },
            }),
          ]),
        ).toBe("unsettled");
      }
    });

    test("team ownership is unverifiable — the claim FILE decides, not the audit", () => {
      // `eventMatchesClaimAttempt` compares the row's `Attempt Generation` with the claim
      // file's: with an active stamp a MISSING field is a mismatch and a matching value is a
      // pass. Neither verdict is derivable here, so both must not be guessed. Reporting
      // "gen present → false, gen absent → true" was wrong in both directions at once.
      for (const fields of [{}, { "Attempt Generation": "3" }] as Record<string, string>[]) {
        expect(
          st([E("STAGE_STARTED", T), U("UNIT_COMPLETED", T, { unit: "api", fields })], "api", {
            teamOwnership: true,
          }),
        ).toBe("unverifiable");
      }
      // Outside team ownership the check is a no-op, so a declared generation changes nothing.
      expect(
        st([
          E("STAGE_STARTED", T),
          U("UNIT_COMPLETED", T, { unit: "api", fields: { "Attempt Generation": "3" } }),
        ]),
      ).toBe("settled");
    });

    test("a GATE_REJECTED is a boundary only when it matches this stage and unit", () => {
      // `gateRejectionMatchesAttempt`: `Gate Stages` (else `Stage`) must name the slug, and a
      // row carrying `Unit` matches only that unit — with `unit === undefined`, which is what
      // non-team ownership passes, it matches NOTHING. Reading `e.stage === stage` alone let
      // one unit's rejection invalidate another's finished work. Per-unit floor SCOPING
      // (`key = teamOwnership ? unit : ""`) cannot be observed through `state()` while team
      // ownership is unverifiable for the claim-file reason, so what is asserted here is the
      // boundary filter that scoping feeds.
      const withRejection = (fields: Record<string, string>) => [
        E("STAGE_STARTED", T),
        U("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "B" }),
        E("GATE_REJECTED", "2026-01-02T00:00:00Z", { fields }),
      ];
      // Names another unit → not this unit's boundary, so B's receipt stands.
      expect(st(withRejection({ Unit: "A", "Gate Stages": S }), "B")).toBe("settled");
      // Names no unit → everyone's boundary, so B's receipt is behind it.
      expect(st(withRejection({ "Gate Stages": S }), "B")).toBe("unsettled");
      // Names another stage → not a boundary at all.
      expect(st(withRejection({ "Gate Stages": "other-stage" }), "B")).toBe("settled");
      // No `Gate Stages` → the engine falls back to the `Stage` field.
      expect(st(withRejection({}), "B")).toBe("unsettled");
    });

    test("unit-major: GATE_REJECTED raises the floor, STAGE_STARTED does not", () => {
      const thenBoundary = (event: string) => [
        E("UNIT_COMPLETED", T, { unit: "api", fields: { "Run floor": "unstarted#0" } }),
        E(event, "2026-01-02T00:00:00Z", { fields: { "Gate Stages": S } }),
      ];
      expect(st(thenBoundary("GATE_REJECTED"), "api", { unitMajor: true })).toBe("unsettled");
      expect(st(thenBoundary("STAGE_STARTED"), "api", { unitMajor: true })).toBe("settled");
      // And a `single-stage:` re-run is not a new attempt outside unit-major either.
      expect(
        st([
          E("UNIT_COMPLETED", T, { unit: "api", fields: { "Run floor": "unstarted#0" } }),
          E("STAGE_STARTED", "2026-01-02T00:00:00Z", {
            fields: { Workflow: "single-stage:code-generation" },
          }),
        ]),
      ).toBe("settled");
    });

    test("order decides: a pause revokes, a re-completion settles again", () => {
      expect(
        st([
          E("STAGE_STARTED", T),
          U("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "api" }),
          U("UNIT_PAUSED", "2026-01-01T02:00:00Z", { unit: "api" }),
        ]),
      ).toBe("unsettled");
      expect(
        st([
          E("STAGE_STARTED", T),
          U("UNIT_COMPLETED", "2026-01-01T01:00:00Z", { unit: "api" }),
          U("UNIT_PAUSED", "2026-01-01T02:00:00Z", { unit: "api" }),
          U("UNIT_COMPLETED", "2026-01-01T03:00:00Z", { unit: "api" }),
        ]),
      ).toBe("settled");
    });
  });

  test("a stage with no unit lifecycle stays artifact-driven (the engine's own branch)", () => {
    // "When NOT in use (a genuinely ledger-free legacy flow), coverage stays
    // artifact-driven, so in-flight upgrades do not break."
    const lifecycle = readUnitLifecycle([
      { event: "UNIT_COMPLETED", stage: "some-other-stage", unit: "PU-A" },
    ]);
    const mx = buildConstructionMatrix(
      dag,
      stages,
      () => ["code-generation-plan", "code-summary"],
      catalog,
      lifecycle,
    )!;
    expect(mx.stages[0]!.cells.map((c) => c.state)).toEqual(["complete", "complete"]);
  });

  test("per-unit rows come from for_each, not a hardcoded slug list", () => {
    const notPerUnit = {
      ...catalog,
      bySlug: new Map(catalog.bySlug).set("code-generation", {
        ...catalog.bySlug.get("code-generation")!,
        forEach: undefined,
      }),
    };
    // The catalogue says this stage is not per-unit, so it is not a matrix row — even
    // though its slug is in PER_UNIT_STAGE_SLUGS, which is only the no-catalogue path.
    expect(buildConstructionMatrix(dag, stages, () => [], notPerUnit)).toBeUndefined();
  });

  test("empty segment is absent", () => {
    const mx = buildConstructionMatrix(dag, stages, () => [], catalog)!;
    expect(mx.stages[0]?.cells.every((c) => c.state === "absent")).toBe(true);
    expect(mx.stages[0]?.complete).toBe(0);
  });

  test("no catalogue degrades to binary (never 'partial')", () => {
    const mx = buildConstructionMatrix(dag, stages, () => ["code-generation-plan"], undefined)!;
    expect(mx.stages[0]?.cells.map((c) => c.state)).toEqual(["complete", "complete"]);
    expect(mx.contractAware).toBe(false);
  });

  test("in-flight stage is provisional", () => {
    const mx = buildConstructionMatrix(dag, stages, () => [], catalog)!;
    expect(mx.stages[0]?.provisional).toBe(true);
  });

  test("a kind the stage contracts nothing for is n/a, not absent", () => {
    // Real shape: functional-design scopes every artifact to service/spec/ui/library,
    // so a `packaging` unit is contracted nothing — "미착수" would be a lie.
    const kindScoped = {
      ...catalog,
      bySlug: new Map<string, CatalogStage>([
        [
          "code-generation",
          {
            ...catalog.bySlug.get("code-generation")!,
            producesKinds: { "code-generation-plan": ["ui"], "code-summary": ["ui"] },
          },
        ],
      ]),
    };
    const mx = buildConstructionMatrix(dag, stages, () => [], kindScoped)!;
    // PU-A is `service` here → nothing contracted; PU-B is `ui` → absent for real.
    expect(mx.stages[0]?.cells.map((c) => c.state)).toEqual(["n/a", "absent"]);
    expect(mx.stages[0]?.notApplicable).toBe(1);
    // The n/a unit leaves the denominator: 0 of 1 applicable, not 0 of 2.
    expect(mx.stages[0]!.total - mx.stages[0]!.notApplicable).toBe(1);
  });

  test("'nothing expected' stays binary when the kind or the catalogue row is missing", () => {
    // Unknown kind → we do not know what was contracted, so no n/a claim.
    const kindless: BoltDag = {
      units: [{ name: "PU-A", display: "Pu A", dependsOn: [] }],
      batches: [["PU-A"]],
    };
    const kindScoped = {
      ...catalog,
      bySlug: new Map<string, CatalogStage>([
        [
          "code-generation",
          {
            ...catalog.bySlug.get("code-generation")!,
            producesKinds: { "code-generation-plan": ["ui"], "code-summary": ["ui"] },
          },
        ],
      ]),
    };
    const unknownKind = buildConstructionMatrix(kindless, stages, () => [], kindScoped)!.stages[0]!;
    expect(unknownKind.cells[0]?.state).toBe("absent");
    expect(unknownKind.notApplicable).toBe(0);
    // No catalogue row at all → likewise binary.
    const noRow = { ...catalog, bySlug: new Map<string, CatalogStage>() };
    expect(buildConstructionMatrix(dag, stages, () => [], noRow)!.stages[0]?.cells[0]?.state).toBe(
      "absent",
    );
  });

  test("bolt_dag parse keeps kind, depends_on and batches", () => {
    const dag2 = parseBoltDag(
      JSON.stringify({
        bolt_dag: {
          units: [{ name: "PU-A", depends_on: [], kind: "library" }],
          batches: [["PU-A"]],
        },
      }),
    )!;
    expect(dag2.units[0]?.kind).toBe("library");
    expect(dag2.batches).toEqual([["PU-A"]]);
  });

  test("no bolt_dag → undefined (keeps the flat render)", () => {
    expect(parseBoltDag("{}")).toBeUndefined();
    expect(parseBoltDag("not json")).toBeUndefined();
  });
});

describe("questions", () => {
  test("blank [Answer]: is unanswered, filled is answered", () => {
    const qs = parseQuestions(`## Q1 — Plan Approval

text

[Answer]: A (approved)

## Q2 — Scope

text

[Answer]:
`);
    expect(qs.length).toBe(2);
    expect(qs[0]?.answered).toBe(true);
    expect(qs[0]?.answer).toBe("A (approved)");
    expect(qs[1]?.answered).toBe(false);
  });

  test("whitespace-only answer counts as unanswered", () => {
    expect(parseQuestions("## Q1 — x\n\n[Answer]:    \n")[0]?.answered).toBe(false);
  });

  test("an [Answer] before any heading is ignored", () => {
    expect(parseQuestions("[Answer]: stray\n")).toEqual([]);
  });

  test("the first [Answer] in a span wins", () => {
    const qs = parseQuestions("## Q1 — x\n[Answer]: first\n[Answer]: second\n");
    expect(qs[0]?.answer).toBe("first");
  });

  // The four id SHAPES below come from one long real run — see the header comment in
  // scan/questions.ts for the measured counts. The prose carrying them is synthetic;
  // only the shape is under test, and this repository is public.
  test("the id may be bracketed, an F follow-up, or suffixed", () => {
    const qs = parseQuestions(`## [Q1] 컴포넌트 경계를 무엇으로 가르는가

[Answer]: B

## [F2] 서버 플래그 판정은 어느 컴포넌트의 일인가

[Answer]: C

## F1. 판정 대상 6건 중 진입이 차단된 항목이 있으면?

[Answer]: A

## Q6-a. (후속) 그 차수 기한은 언제입니까?

[Answer]:
`);
    expect(qs.map((q) => q.heading.split(/\s/)[0])).toEqual(["[Q1]", "[F2]", "F1.", "Q6-a."]);
    expect(qs.map((q) => q.answered)).toEqual([true, true, true, false]);
  });

  test("a blank placeholder followed by a real answer reads as answered", () => {
    // The engine writes the blank marker; a human answers underneath it.
    const qs = parseQuestions("## [F2] x\n\n[Answer]:\n\n\n[Answer]: C. 넷으로 늘린다\n");
    expect(qs.length).toBe(1);
    expect(qs[0]?.answered).toBe(true);
    expect(qs[0]?.answer).toBe("C. 넷으로 늘린다");
  });

  test("a heading with no [Answer]: marker in its span is prose, not an ask", () => {
    // Real shape: a narrative section reusing an answered question's id. Counting
    // it would put a permanent blocker on the screen.
    const qs = parseQuestions(`## [Q5] 확인되지 않은 필드 둘을 어떻게 적어 둘까?

[Answer]: D

## [Q5] 후속 — 원문에서 확인한 것

### mgtMnbdCd — 근거를 찾았다

prose only, no marker
`);
    expect(qs.length).toBe(1);
    expect(qs[0]?.answered).toBe(true);
  });

  test("a prose heading that merely starts with a letter+digit is not a question", () => {
    expect(parseQuestions("## U1의 완료는 무엇으로 판정하나\n\n[Answer]: 판정 기준\n")).toEqual([]);
  });

  test("a non-question heading closes the span, so its [Answer] attaches to nothing", () => {
    const qs = parseQuestions("## Q1 — x\n[Answer]:\n\n## Consolidated Summary\n[Answer]: yes\n");
    expect(qs.length).toBe(1);
    expect(qs[0]?.answered).toBe(false);
  });

  test("a suffix without a hyphen is still an id (`Q6a`, not just `Q6-a`)", () => {
    // Real follow-up heading; requiring the hyphen dropped it and understated the
    // ask count, and a blank one would have been an invisible blocker.
    const qs = parseQuestions("## Q6a. (후속) 다이어그램 대안은?\n\n[Answer]: A — 계속 붙인다\n");
    expect(qs.map((q) => q.heading)).toEqual(["Q6a. (후속) 다이어그램 대안은?"]);
    expect(qs[0]?.kind).toBe("question");
  });

  test("the three id-less gate headings are asks, and a blank one is a blocker", () => {
    // `stage-protocol.md`: the run may not proceed while these are blank. The id
    // regex alone reported zero blockers over a hard-stopped run.
    const qs = parseQuestions(`## Consolidated Summary Confirmation

- Looks correct
- Request changes

[Answer]:

## Assumption Confirmation

[Answer]: A. Accept assumptions

## Requested Changes Feedback

[Answer]: 판정 표를 먼저 확정해 주세요
`);
    expect(qs.map((q) => [q.heading, q.kind, q.answered])).toEqual([
      ["Consolidated Summary Confirmation", "confirmation", false],
      ["Assumption Confirmation", "confirmation", true],
      ["Requested Changes Feedback", "confirmation", true],
    ]);
  });

  test("the engine-held plan approval is the fourth id-less ask", () => {
    // The intro line mentions `[Answer]:` mid-sentence, before any heading — it must
    // neither open a span nor count as an answer.
    const text = (answer: string) =>
      `# Code Generation Plan Approval\n\nAI-DLC writes this file when it asks you to approve the plan. To answer here\ninstead of in chat, write your answer after \`[Answer]:\` and say done.\n\n## Plan Approval\n\nApprove the code plan for unit-a?\n\n- A. Approve Plan\n- B. Request Changes\n- C. I'll edit the files\n\n[Answer]:${answer}\n`;
    expect(parseQuestions(text(""))).toEqual([
      { heading: "Plan Approval", answer: "", answered: false, kind: "confirmation" },
    ]);
    expect(parseQuestions(text(" A. Approve Plan"))[0]?.answered).toBe(true);
    // A suffix is still a different heading — not plan approval, but its blank tag is
    // still one the stop hook waits on, so it surfaces as an unrecognised ask.
    expect(parseQuestions("## Plan Approval for unit-a\n\n[Answer]:\n")).toEqual([
      { heading: "Plan Approval for unit-a", answer: "", answered: false, kind: "loose" },
    ]);
  });

  test("plan approval is matched the way the engine matches it", () => {
    // `isPlanApprovalLabel`: one emphasis pair and a trailing `?`/`:` are ignored —
    // the legacy recovery path has the model write this heading by hand.
    for (const h of ["**Plan Approval**", "Plan Approval:", "plan approval?", "_Plan Approval_"]) {
      expect(parseQuestions(`## ${h}\n\n[Answer]:\n`)[0]?.answered).toBe(false);
    }
  });

  test("a plan built with approval off is a record, not an ask", () => {
    // The engine writes the same section pre-answered and says it "asks nothing".
    const off =
      "## Plan Approval\n\nBuilt without asking: plan approval is off.\n\n[Answer]: Plan approval off\n";
    expect(parseQuestions(off)).toEqual([]);
  });

  test("a gate heading still needs an [Answer] marker, and a near-miss title is prose", () => {
    // Same guard as the id path: the marker is what makes a heading an ask.
    expect(parseQuestions("## Assumption Confirmation\n\n확인 절차 설명\n")).toEqual([]);
    expect(parseQuestions("## Assumption Confirmation 재확인\n\n[Answer]: x\n")).toEqual([]);
  });

  // ── 2.10/2.11 input rules ────────────────────────────────────────────────────
  // Each case below is a shape the engine treats one way and this reader used to
  // treat another. The engine sources are cited in scan/questions.ts's header.

  test("an underscores-only answer is blank, as the engine reads it", () => {
    // stage-protocol.md: "blank or contains only underscores". The stop hook's
    // regex is `\[Answer\]:[ \t]*_*[ \t]*$`.
    for (const a of ["_", "___", " __ "]) {
      expect(parseQuestions(`## Q1 — x\n\n[Answer]:${a}\n`)[0]?.answered).toBe(false);
    }
    // Underscores inside a word are an answer.
    expect(parseQuestions("## Q1 — x\n\n[Answer]: __init__\n")[0]?.answered).toBe(true);
  });

  test("a tag inside a fenced block, an HTML comment or a <pre> block is invisible", () => {
    expect(parseQuestions("## Q1 — x\n\n```md\n[Answer]:\n```\n\n[Answer]: A\n")[0]?.answer).toBe(
      "A",
    );
    expect(parseQuestions("## Q1 — x\n\n~~~\n[Answer]:\n~~~\n")).toEqual([]);
    expect(parseQuestions("## Q1 — x\n<!--\n[Answer]:\n-->\n[Answer]: B\n")[0]?.answer).toBe("B");
    expect(parseQuestions("## Q1 — x\n<!-- [Answer]: -->\n[Answer]: C\n")[0]?.answer).toBe("C");
    expect(parseQuestions("## Q1 — x\n<pre>\n[Answer]:\n</pre>\n[Answer]: D\n")[0]?.answer).toBe(
      "D",
    );
    // A heading hidden in a fence neither opens nor closes a span.
    const qs = parseQuestions("## Q1 — x\n````\n```\n## Q2 — y\n```\n````\n[Answer]:\n");
    expect(qs.map((q) => [q.heading, q.answered])).toEqual([["Q1 — x", false]]);
  });

  test("an unclosed fence hides nothing and is reported", () => {
    // CommonMark would run it to end of file and hide the blank tag; a reader that
    // did the same would hide a blocker over a typo, so it reads on and says so.
    const r = parseQuestionsFile("## Q1 — x\n\n```\n[Answer]:\n");
    expect(r.questions.map((q) => q.answered)).toEqual([false]);
    expect(r.unclosed).toBe(true);
    expect(parseQuestionsFile("## Q1 — x\n```\n```\n[Answer]:\n").unclosed).toBe(false);
  });

  test("a question heading opens a span at any depth, and a deeper heading stays inside it", () => {
    const qs = parseQuestions(`## Q1 — 범위

### 선택지

- A. 전부

[Answer]:

### Q2. 순서

[Answer]: A

   ## Q3 ##

[Answer]: B
`);
    expect(qs.map((q) => [q.heading, q.kind, q.answered])).toEqual([
      ["Q1 — 범위", "question", false],
      ["Q2. 순서", "question", true],
      ["Q3", "question", true],
    ]);
  });

  test("numbered and `Question n` headings are questions, as the engine's prefix reads them", () => {
    const qs = parseQuestions("## Question 1: 범위\n\n[Answer]: A\n\n## 2. 순서\n\n[Answer]:\n");
    expect(qs.map((q) => [q.heading, q.kind, q.answered])).toEqual([
      ["Question 1: 범위", "question", true],
      ["2. 순서", "question", false],
    ]);
  });

  test("a leading emoji does not hide a question id or the assumption heading", () => {
    // 2.11 `headingKey`: a run of emoji then whitespace is decoration.
    const qs = parseQuestions(
      "## ❓ Q1. 범위\n\n[Answer]:\n\n## 📌 Assumption Confirmation\n\n[Answer]:\n",
    );
    expect(qs.map((q) => [q.heading, q.kind])).toEqual([
      ["❓ Q1. 범위", "question"],
      ["📌 Assumption Confirmation", "confirmation"],
    ]);
  });

  test("a blank tag under no recognised heading is still a blocker", () => {
    // The stop hook reads the whole file, so a blank tag anywhere parks the run.
    expect(parseQuestions("## 배경\n\n[Answer]:\n")).toEqual([
      { heading: "배경", answer: "", answered: false, kind: "loose" },
    ]);
    expect(parseQuestions("[Answer]:\n")).toEqual([
      { heading: "", answer: "", answered: false, kind: "loose" },
    ]);
    // A gate heading is H2 only, so an H3 one is unrecognised — but still waited on.
    expect(parseQuestions("### Assumption Confirmation\n\n[Answer]:\n")[0]?.kind).toBe("loose");
    // The summary heading is compared exactly by the engine, emoji included.
    expect(parseQuestions("## 📌 Consolidated Summary Confirmation\n\n[Answer]:\n")[0]?.kind).toBe(
      "loose",
    );
    // A filled one under no recognised heading is not an ask, as before.
    expect(parseQuestions("## 배경\n\n[Answer]: x\n")).toEqual([]);
  });

  test("plan approval reads the LATEST section's LAST tag", () => {
    // aidlc-testing-posture.ts `latestPlanApproval`: each section resets, and a
    // later tag overwrites an earlier one.
    const again = parseQuestions(
      "## Plan Approval\n\n[Answer]: A. Approve Plan\n\n## Plan Approval\n\n[Answer]:\n",
    );
    expect(again.map((q) => q.answered)).toEqual([false]);
    expect(
      parseQuestions("## Plan Approval\n\n[Answer]:\n[Answer]: A. Approve Plan\n")[0]?.answered,
    ).toBe(true);
    expect(
      parseQuestions("## Plan Approval\n\n[Answer]: A. Approve Plan\n[Answer]:\n")[0]?.answered,
    ).toBe(false);
    // A tag in a subsection only fills a slot the section left empty.
    expect(
      parseQuestions("## Plan Approval\n\n[Answer]:\n\n### 메모\n\n[Answer]: A. Approve Plan\n")[0]
        ?.answered,
    ).toBe(false);
    // The engine strips a question prefix before matching the label.
    expect(parseQuestions("## Q1: Plan Approval\n\n[Answer]:\n")[0]?.kind).toBe("confirmation");
  });

  test("a later section reusing a question's id answers it, as a later marker would", () => {
    // Real shape: the engine's blank placeholders under `### Q7.` / `### Q8.`, then
    // the human's answers under `### Q7 답변` / `### Q8 답변`. A dashboard reading,
    // not an engine rule: the stop hook still sees the placeholder blank.
    const qs = parseQuestions(`## 학습 의례

### Q7. 보존할 후보

[Answer]:

### Q8. 더 남길 것

[Answer]:

### Q7 답변

[Answer]: A~G 전부

## Question 1: 범위

[Answer]:

## Q1 — 범위 (답)

[Answer]: B
`);
    expect(qs.map((q) => [q.heading, q.answered, q.answer])).toEqual([
      ["Q7. 보존할 후보", true, "A~G 전부"],
      ["Q8. 더 남길 것", false, ""],
      ["Question 1: 범위", true, "B"],
    ]);
  });

  // Second-review counterexamples. Each expectation is what the engine's own reader
  // returned on the same text (`questionsFileHasPendingPlanApproval`,
  // `summaryConfirmationAnswer`, 2.11.0), measured 2026-10-09.
  const pending = (t: string) => parseQuestions(t).filter((q) => !q.answered).length;

  test("plan approval: a question-looking heading nested in the section is a subsection", () => {
    // `[Q2]` is not the engine's numbered prefix, so it stays inside Plan Approval and
    // its blank tag is the plan's answer — not a second Q2 to merge with the first.
    const t = "## [Q2] Scope\n\n[Answer]: A\n\n## Plan Approval\n\n### [Q2] Scope\n\n[Answer]:\n";
    expect(pending(t)).toBe(1);
    expect(parseQuestions(t).find((q) => !q.answered)?.heading).toBe("Plan Approval");
  });

  test("plan approval: a newer section with no tag yet supersedes an older blank one", () => {
    expect(
      parseQuestions("## Plan Approval\n\n[Answer]:\n\n## Plan Approval\n\nNo tag yet\n"),
    ).toEqual([]);
  });

  test("plan approval: the engine's heading grammar — column 0, a closing `#` needs no space", () => {
    expect(pending("   ## Plan Approval\n\n[Answer]:\n")).toBe(1);
    expect(parseQuestions("   ## Plan Approval\n\n[Answer]:\n")[0]?.kind).toBe("loose");
    expect(parseQuestions("## Plan Approval#\n\n[Answer]:\n")[0]?.kind).toBe("confirmation");
  });

  test("summary confirmation: the section runs to the next H2, not to an H1 or a nested question", () => {
    for (const tail of ["### Q2. Followup", "# Notes"]) {
      const qs = parseQuestions(
        `## Consolidated Summary Confirmation\n\n[Answer]: Looks correct\n\n${tail}\n\n[Answer]: A\n`,
      );
      expect(qs).toEqual([
        {
          heading: "Consolidated Summary Confirmation",
          answer: "",
          answered: false,
          kind: "confirmation",
          invalidTags: 2,
        },
      ]);
    }
  });

  test("a comment opener inside inline code or escaped hides nothing", () => {
    expect(pending("## Plan Approval\n\n`<!--`\n[Answer]:\n`-->`\n")).toBe(1);
    expect(pending("## Q1 — x\n\n\\<!-- not a comment\n[Answer]:\n")).toBe(1);
  });

  test("text after a multi-line comment closes is not at column 0", () => {
    expect(parseQuestions("## Plan Approval\n\ntext <!--\ncomment -->[Answer]:\n")).toEqual([]);
  });

  test("a huge continuation does not overflow the stack", () => {
    const t = `## Q1 — x\n\n[Answer]:\n\n## Q1 답\n\n${"[Answer]:\n".repeat(1_000_000)}`;
    expect(() => parseQuestionsFile(t)).not.toThrow();
  });

  test("a summary confirmation must hold exactly one tag", () => {
    // `summaryConfirmationAnswer` returns null unless there is exactly one, so two
    // tags are not a confirmation the engine will accept, whatever they say.
    const qs = parseQuestions(
      "## Consolidated Summary Confirmation\n\n[Answer]:\n[Answer]: Looks correct\n",
    );
    expect(qs).toEqual([
      {
        heading: "Consolidated Summary Confirmation",
        answer: "",
        answered: false,
        kind: "confirmation",
        invalidTags: 2,
      },
    ]);
  });
});

describe("questions files on disk", () => {
  function tree(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-q-"));
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
  }
  const BLANK = "## Q1 — x\n\n[Answer]:\n";
  const where = (r: ReturnType<typeof readQuestions>) =>
    r.files.map((f) => [f.rel, f.stage, f.unit ?? null]).sort();

  test("a questions file under a stage's subdirectory belongs to that stage", () => {
    // stage-protocol.md: "Recursively read every `<record>/**/*-questions.md`".
    const dir = tree({
      "inception/requirements-analysis/reviews/r1-questions.md": BLANK,
      "inception/requirements-analysis/a/b/deep-questions.md": BLANK,
      "construction/unit-a/code-generation/code-generation-questions.md": BLANK,
      "construction/build-and-test/reviews/r2-questions.md": BLANK,
    });
    const isStage = (s: string) =>
      ["requirements-analysis", "code-generation", "build-and-test"].includes(s);
    expect(where(readQuestions(dir, { isStage }))).toEqual([
      ["construction/build-and-test/reviews/r2-questions.md", "build-and-test", null],
      [
        "construction/unit-a/code-generation/code-generation-questions.md",
        "code-generation",
        "unit-a",
      ],
      ["inception/requirements-analysis/a/b/deep-questions.md", "requirements-analysis", null],
      ["inception/requirements-analysis/reviews/r1-questions.md", "requirements-analysis", null],
    ]);
  });

  test("without a catalogue, only construction has units", () => {
    const dir = tree({
      "inception/requirements-analysis/reviews/r1-questions.md": BLANK,
      "construction/unit-a/code-generation/code-generation-questions.md": BLANK,
    });
    expect(where(readQuestions(dir))).toEqual([
      [
        "construction/unit-a/code-generation/code-generation-questions.md",
        "code-generation",
        "unit-a",
      ],
      ["inception/requirements-analysis/reviews/r1-questions.md", "requirements-analysis", null],
    ]);
  });

  test("a file with an unclosed block is named in the report", () => {
    const dir = tree({
      "inception/user-stories/user-stories-questions.md": "## Q1 — x\n```\n[Answer]:\n",
    });
    const r = readQuestions(dir);
    expect(r.unclosed).toEqual(["inception/user-stories/user-stories-questions.md"]);
    expect(r.totalUnanswered).toBe(1);
  });
});

describe("memory diary", () => {
  test("a diary quoted in a fence is not the diary", () => {
    const e = parseDiary("## Deviations\n\n```md\n## Tradeoffs\n- quoted\n```\n\n- real\n");
    expect(e.map((x) => [x.axis, x.text])).toEqual([["deviations", "real"]]);
  });

  test("counts bullets per axis and strips the timestamp", () => {
    const e = parseDiary(`# Diary

## Interpretations

- 2026-01-01T00:00:00Z — first
- 2026-01-01T00:01:00Z — second

## Deviations

## Tradeoffs

- no timestamp here

## Open questions

- 2026-01-02T00:00:00Z — still open
`);
    expect(e.filter((x) => x.axis === "interpretations").length).toBe(2);
    expect(e.filter((x) => x.axis === "deviations").length).toBe(0);
    expect(e.filter((x) => x.axis === "tradeoffs")[0]?.text).toBe("no timestamp here");
    expect(e.filter((x) => x.axis === "openQuestions")[0]?.ts).toBe("2026-01-02T00:00:00Z");
    expect(e[0]?.text).toBe("first");
  });

  test("bullets outside a known heading are ignored", () => {
    expect(parseDiary("> preamble\n\n- stray bullet\n")).toEqual([]);
  });

  test("accepts suffixed headings, removes placeholders, and classifies questions conservatively", () => {
    const entries = parseDiary(`## Deviations (추가)
- changed after review

## Open questions (u4)
- None.
- (해소됨 2026-01-02) route fixed.
- API route 정합 확인 필요.
- historical context only.
- RefreshResult.persisted? is already fixed.
`);
    expect(entries.length).toBe(5);
    expect(entries[0]?.axis).toBe("deviations");
    expect(entries[1]?.questionStatus).toBe("resolved");
    expect(entries[2]?.questionStatus).toBe("followUp");
    expect(entries[3]?.questionStatus).toBe("note");
    expect(entries[4]?.questionStatus).toBe("note");
  });

  test("deduplicates stage-major fan-in in favor of the per-unit source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-diary-"));
    const parent = path.join(root, "construction", "functional-design");
    const unit = path.join(root, "construction", "u1", "functional-design");
    fs.mkdirSync(parent, { recursive: true });
    fs.mkdirSync(unit, { recursive: true });
    const repeated = `## Interpretations
- 2026-01-01T00:00:00Z — shared decision
`;
    fs.writeFileSync(path.join(parent, "memory.md"), repeated);
    fs.writeFileSync(path.join(unit, "memory.md"), repeated);
    try {
      const report = readDiaries(root);
      expect(report.stages.length).toBe(2);
      expect(report.records.length).toBe(1);
      expect(report.records[0]?.unit).toBe("u1");
      expect(report.totals.interpretations).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sensor detail", () => {
  test("parses header fields and the JSON findings block", () => {
    const b = parseSensorDetail(
      `# type-check finding — code-generation

**Timestamp**: 2026-01-01T00:00:00Z
**Fire id**: bbbb2222
**Output path**: /demo/src/x.ts
**Pass**: false

## Findings

\`\`\`json
{ "pass": false, "errors": [{ "file": "src/x.ts", "line": 3, "message": "boom" }], "findings_count": 1 }
\`\`\`
`,
      "type-check-bbbb2222.md",
      "code-generation",
    )!;
    expect(b.sensorId).toBe("type-check");
    expect(b.fireId).toBe("bbbb2222");
    expect(b.findingsCount).toBe(1);
    expect(b.errors[0]?.line).toBe(3);
    expect(b.outputPath).toBe("/demo/src/x.ts");
  });

  test("upstream-coverage carries unreferenced artifacts", () => {
    const b = parseSensorDetail(
      `**Fire id**: cccc3333\n\n## Findings\n\n\`\`\`json\n{ "unreferenced": ["technology-stack"], "findings_count": 1 }\n\`\`\`\n`,
      "upstream-coverage-cccc3333.md",
      "nfr-requirements",
    )!;
    expect(b.sensorId).toBe("upstream-coverage");
    expect(b.unreferenced).toEqual(["technology-stack"]);
  });

  test("a truncated body keeps the header", () => {
    const b = parseSensorDetail(
      `**Fire id**: dddd4444\n\n## Findings\n\n\`\`\`json\n{ "pass": fal\n`,
      "linter-dddd4444.md",
      "code-generation",
    )!;
    expect(b.fireId).toBe("dddd4444");
    expect(b.errors).toEqual([]);
  });

  test("a failure from another clone keeps its count and is reported as body-less", () => {
    // `audit/` is sharded per clone but `.aidlc-sensors/` is not, so a record that
    // merges two developers' shards holds only one machine's finding bodies.
    // Measured on a real two-developer run: 84 failures, 54 bodies, split exactly
    // by shard (30 / 0 and 54 / 54).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-sens-"));
    try {
      const stageDir = path.join(dir, ".aidlc-sensors", "code-generation");
      fs.mkdirSync(stageDir, { recursive: true });
      fs.writeFileSync(
        path.join(stageDir, "type-check-local111.md"),
        '**Fire id**: local111\n**Pass**: false\n\n## Findings\n\n```json\n{ "findings_count": 2 }\n```\n',
      );
      const ev = (ts: string, event: string, shard: string, fireId: string): AuditEvent => ({
        ts,
        event,
        fields: { "Fire id": fireId, "Sensor ID": "type-check" },
        shard,
        stage: "code-generation",
      });
      const events: AuditEvent[] = [
        ev("2026-01-01T00:00:00Z", "SENSOR_FIRED", "local.md", "local111"),
        ev("2026-01-01T00:00:01Z", "SENSOR_FAILED", "local.md", "local111"),
        // Same sensor, other machine — its body never travelled with the copy.
        ev("2026-01-01T00:00:02Z", "SENSOR_FIRED", "other.md", "remote99"),
        ev("2026-01-01T00:00:03Z", "SENSOR_FAILED", "other.md", "remote99"),
      ];
      const r = readSensorReport(dir, {
        events,
        counts: new Map(),
        shards: ["local.md", "other.md"],
      });
      expect(r.totalFailed).toBe(2); // the audit counts both
      expect(r.failuresWithoutBody).toBe(1); // only one body is present
      expect(r.orphanDetailFiles).toBe(0); // and no file is unclaimed
      const bodyless = r.failures.find((f) => f.fireId === "remote99")!;
      expect(bodyless.detailFile).toBeUndefined();
      expect(bodyless.errors).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const sensorEv = (
    ts: string,
    event: string,
    fireId: string,
    extra: Record<string, string> = {},
  ) =>
    ({
      ts,
      event,
      fields: {
        "Fire id": fireId,
        "Sensor ID": "type-check",
        "Output path": "/w/src/a.ts",
        ...extra,
      },
      shard: "s.md",
      stage: "code-generation",
    }) as AuditEvent;
  const report = (events: AuditEvent[]) =>
    readSensorReport(path.join(os.tmpdir(), "aidlc-no-such-record"), {
      events,
      counts: new Map(),
      shards: ["s.md"],
    });

  // A noted pass has no verified result; the gate refuses it like a failure.
  test("a pass carrying a Note is unevaluated, not passed", () => {
    const r = report([
      sensorEv("2026-01-01T00:00:00Z", "SENSOR_FIRED", "f1"),
      sensorEv("2026-01-01T00:00:01Z", "SENSOR_PASSED", "f1", { Note: "tool-unavailable" }),
      sensorEv("2026-01-01T00:00:02Z", "SENSOR_FIRED", "f2"),
      sensorEv("2026-01-01T00:00:03Z", "SENSOR_PASSED", "f2"),
    ]);
    const st = r.stages[0]!;
    expect(st.passed).toBe(1);
    expect(st.unevaluated).toBe(1);
    // The verified pass of the same output came later, so nothing is left standing.
    expect(st.unverifiedStanding).toBe(0);
    expect(r.totalPassed).toBe(1);
    expect(r.totalUnevaluated).toBe(1);
  });

  test("a budget override with no later verified pass stands as unverified", () => {
    const r = report([
      sensorEv("2026-01-01T00:00:00Z", "SENSOR_FIRED", "f1"),
      sensorEv("2026-01-01T00:00:01Z", "SENSOR_BUDGET_OVERRIDE", "f1"),
    ]);
    expect(r.stages[0]?.budgetOverride).toBe(1);
    expect(r.stages[0]?.unverifiedStanding).toBe(1);
  });

  // The engine deletes the failure's detail file on that pass; the body is gone on
  // purpose, so it is neither "on another clone" nor a standing failure.
  test("a verified pass started after a body-less failure retires it; a noted one does not", () => {
    const r = report([
      sensorEv("2026-01-01T00:00:00Z", "SENSOR_FIRED", "f1"),
      sensorEv("2026-01-01T00:00:01Z", "SENSOR_FAILED", "f1"),
      sensorEv("2026-01-01T00:00:02Z", "SENSOR_FIRED", "f2", { "Output path": "/w/src/b.ts" }),
      sensorEv("2026-01-01T00:00:03Z", "SENSOR_FAILED", "f2", { "Output path": "/w/src/b.ts" }),
      sensorEv("2026-01-01T00:00:04Z", "SENSOR_FIRED", "f3"),
      sensorEv("2026-01-01T00:00:05Z", "SENSOR_PASSED", "f3"),
      sensorEv("2026-01-01T00:00:06Z", "SENSOR_FIRED", "f4", { "Output path": "/w/src/b.ts" }),
      sensorEv("2026-01-01T00:00:07Z", "SENSOR_PASSED", "f4", {
        "Output path": "/w/src/b.ts",
        Note: "script-error: exit-2",
      }),
      // A second verified pass: the time given is the first, the one that deleted it.
      sensorEv("2026-01-01T00:00:08Z", "SENSOR_FIRED", "f5"),
      sensorEv("2026-01-01T00:00:09Z", "SENSOR_PASSED", "f5"),
    ]);
    const a = r.failures.find((f) => f.fireId === "f1")!;
    const b = r.failures.find((f) => f.fireId === "f2")!;
    expect(a.supersededAt).toBe("2026-01-01T00:00:05Z");
    expect(b.supersededAt).toBeUndefined();
    expect(r.stages[0]?.superseded).toBe(1);
    expect(r.failuresWithoutBody).toBe(1); // b only
  });

  // The prune's cutoff is the pass's START: a failure written while that pass ran keeps
  // its file, so the engine still shows it.
  test("a pass that started before the failure was recorded does not retire it", () => {
    const r = report([
      sensorEv("2026-01-01T00:00:00Z", "SENSOR_FIRED", "f1"),
      sensorEv("2026-01-01T00:00:01Z", "SENSOR_FIRED", "f2"),
      sensorEv("2026-01-01T00:00:02Z", "SENSOR_FAILED", "f1"),
      sensorEv("2026-01-01T00:00:03Z", "SENSOR_PASSED", "f2"),
    ]);
    expect(r.failures[0]?.supersededAt).toBeUndefined();
    expect(r.stages[0]?.superseded).toBe(0);
  });

  // A pass prunes its own clone's detail dir; another clone's pass deletes nothing here.
  test("a pass in another shard does not retire a failure", () => {
    const r = report([
      sensorEv("2026-01-01T00:00:00Z", "SENSOR_FIRED", "f1"),
      sensorEv("2026-01-01T00:00:01Z", "SENSOR_FAILED", "f1"),
      { ...sensorEv("2026-01-01T00:00:02Z", "SENSOR_FIRED", "f2"), shard: "other.md" },
      { ...sensorEv("2026-01-01T00:00:03Z", "SENSOR_PASSED", "f2"), shard: "other.md" },
    ]);
    expect(r.failures[0]?.supersededAt).toBeUndefined();
  });

  test("a failure whose body is still on disk is never called retired", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-sens-kept-"));
    try {
      const stageDir = path.join(dir, ".aidlc-engine", "sensors", "code-generation");
      fs.mkdirSync(stageDir, { recursive: true });
      fs.writeFileSync(
        path.join(stageDir, "type-check-f1.md"),
        "**Fire id**: f1\n**Pass**: false\n**Output path**: /w/src/a.ts\n",
      );
      const r = readSensorReport(dir, {
        events: [
          sensorEv("2026-01-01T00:00:00Z", "SENSOR_FIRED", "f1"),
          sensorEv("2026-01-01T00:00:01Z", "SENSOR_FAILED", "f1"),
          sensorEv("2026-01-01T00:00:02Z", "SENSOR_FIRED", "f2"),
          sensorEv("2026-01-01T00:00:03Z", "SENSOR_PASSED", "f2"),
        ],
        counts: new Map(),
        shards: ["s.md"],
      });
      expect(r.failures[0]?.detailFile).toBe("type-check-f1.md");
      expect(r.failures[0]?.supersededAt).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine dir (2.9+)", () => {
  test("a dangling new entry pins the new path, as the engine's lstat check does", () => {
    // `existsSync` would follow the link, call it absent, and revive legacy data.
    const record = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-edir-"));
    try {
      fs.mkdirSync(path.join(record, ".aidlc-hooks-health"));
      fs.writeFileSync(
        path.join(record, ".aidlc-hooks-health", "stop.last"),
        "2026-01-01T00:00:00Z",
      );
      const current = path.join(record, ".aidlc-engine", "hooks-health");
      fs.mkdirSync(path.dirname(current));
      fs.symlinkSync("missing-target", current, "dir");
      expect(engineReadDir(record, "hooks-health", ".aidlc-hooks-health")).toBe(current);
      expect(readHealth(record).hooks).toEqual([]);
    } finally {
      fs.rmSync(record, { recursive: true, force: true });
    }
  });

  test("the stop counter is read at the 2.11 path only", () => {
    // `stopHookDir` returns `.aidlc-engine/stop-hook` unconditionally; the old
    // `.aidlc-stop-hook` is not read, even for a record with no `.aidlc-engine`.
    const record = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-edir-"));
    try {
      const write = (dir: string) => {
        fs.mkdirSync(path.join(record, dir), { recursive: true });
        fs.writeFileSync(
          path.join(record, dir, "block-count.json"),
          JSON.stringify({ signature: "s", count: 3 }),
        );
      };
      write(".aidlc-stop-hook");
      expect(readHealth(record).stopGuard).toBeUndefined();
      write(".aidlc-engine/stop-hook");
      expect(readHealth(record).stopGuard).toEqual({ signature: "s", count: 3 });
    } finally {
      fs.rmSync(record, { recursive: true, force: true });
    }
  });

  test("a dotted .drops name is still a hook; only known .last markers are not", () => {
    // The engine does not restrict hook names, and the plugin composer writes
    // harness-scoped drop files — hiding dotted names would hide real drops.
    const record = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-edir-"));
    try {
      const dir = path.join(record, ".aidlc-engine", "hooks-health");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "plugin-compose.v2.drops"), "2026-01-01T00:00:00Z\tx\n");
      fs.writeFileSync(path.join(dir, "reviewer-scope.last"), "2026-01-01T00:00:00Z");
      fs.writeFileSync(
        path.join(dir, "reviewer-scope.missing-record.last"),
        "2026-01-02T00:00:00Z",
      );
      const names = readHealth(record).hooks.map((h) => h.name);
      expect(names).toEqual(["plugin-compose.v2", "reviewer-scope"]);
    } finally {
      fs.rmSync(record, { recursive: true, force: true });
    }
  });
});

describe("hook drops", () => {
  test("splits TSV and keeps a tabless line as the reason", () => {
    const rows = parseDrops("2026-01-01T00:00:00Z\treason one\nmalformed line\n\n");
    expect(rows.length).toBe(2);
    expect(rows[0]?.ts).toBe("2026-01-01T00:00:00Z");
    expect(rows[0]?.reason).toBe("reason one");
    expect(rows[1]?.ts).toBe("");
    expect(rows[1]?.reason).toBe("malformed line");
  });
});

describe("gap classification", () => {
  const ev = (ts: string, event: string): AuditEvent => ({ ts, event, fields: {}, shard: "s" });
  const evf = (ts: string, event: string, fields: Record<string, string>): AuditEvent => ({
    ts,
    event,
    fields,
    shard: "s",
  });
  // A 2.11 review pair: one scope, one iteration, the completion echoing the request.
  const review = { Stage: "cg", Reviewer: "code-reviewer", Iteration: "1" };
  const req = (ts: string, id: string | undefined, extra: Record<string, string> = {}) =>
    evf(ts, "REVIEW_REQUESTED", {
      ...review,
      "Artifact Fingerprint": "fp-1",
      ...(id ? { "Request Id": id } : {}),
      ...extra,
    });
  const done = (ts: string, id: string | undefined, extra: Record<string, string> = {}) =>
    evf(ts, "REVIEW_COMPLETED", {
      ...review,
      Verdict: "READY",
      "Request Fingerprint": "fp-1",
      "Artifact Fingerprint": "fp-1",
      ...(id ? { "Request Id": id } : {}),
      ...extra,
    });

  test("gate → HUMAN_TURN is IDLE", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "DECISION_RECORDED"),
      ev("2026-01-01T01:00:00Z", "HUMAN_TURN"),
    ]);
    expect(g.idleSec).toBe(3600);
    expect(g.workSec).toBe(0);
  });

  test("a wait closes on the engine's answer receipts, not just HUMAN_TURN", () => {
    // audit-format.md lists all of these as authority-bearing receipts only their
    // owning tool may emit — each one means a human acted. Reading HUMAN_TURN alone
    // left an approved gate, a summary confirmation and an answered question in
    // UNKNOWN; the approval case is the least ambiguous wait the engine produces.
    const at = { Stage: "rv" };
    for (const [open, close] of [
      ["STAGE_AWAITING_APPROVAL", "GATE_APPROVED"],
      ["STAGE_AWAITING_APPROVAL", "GATE_REJECTED"],
      ["DECISION_RECORDED", "SUMMARY_CONFIRMATION_RECORDED"],
      ["DECISION_RECORDED", "QUESTION_ANSWERED"],
    ] as const) {
      const g = classifyGaps([
        evf("2026-01-01T00:00:00Z", open, at),
        evf("2026-01-01T01:00:00Z", close, at),
      ]);
      expect({ close, human: g.humanWaitSec, unknown: g.unknownSec }).toEqual({
        close,
        human: 3600,
        unknown: 0,
      });
    }
  });

  test("a receipt closes only the ask it answers", () => {
    // The rule used to read the two event names alone, so any receipt next to an
    // ask in the merged ledger closed it.
    const wait = (a: AuditEvent, b: AuditEvent) => classifyGaps([a, b]).humanWaitSec;
    const at = (ts: string, event: string, fields: Record<string, string>, shard = "s") => ({
      ...evf(ts, event, fields),
      shard,
    });
    const t0 = "2026-01-01T00:00:00Z";
    const t1 = "2026-01-01T01:00:00Z";
    // Another clone's turn or approval is another developer — this reader's policy; the
    // engine's own readers pair across shards.
    expect(wait(at(t0, "DECISION_RECORDED", { Stage: "rv" }), at(t1, "HUMAN_TURN", {}, "x"))).toBe(
      0,
    );
    expect(
      wait(
        at(t0, "STAGE_AWAITING_APPROVAL", { Stage: "rv" }),
        at(t1, "GATE_APPROVED", { Stage: "rv" }, "x"),
      ),
    ).toBe(0);
    // A receipt for another stage answers another ask.
    expect(
      wait(
        at(t0, "STAGE_AWAITING_APPROVAL", { Stage: "rv" }),
        at(t1, "GATE_APPROVED", { Stage: "fd" }),
      ),
    ).toBe(0);
    expect(
      wait(
        at(t0, "DECISION_RECORDED", { Stage: "rv" }),
        at(t1, "QUESTION_ANSWERED", { Stage: "fd" }),
      ),
    ).toBe(0);
    // A gate is answered by its gate decision, not by a recorded answer to a question.
    expect(
      wait(
        at(t0, "STAGE_AWAITING_APPROVAL", { Stage: "rv" }),
        at(t1, "QUESTION_ANSWERED", { Stage: "rv" }),
      ),
    ).toBe(0);
    // ...and a decision by its own answer: a gate decision closes only the two
    // gate-answered checkpoints, with their key (`scan/decision-wait.ts`).
    expect(
      wait(at(t0, "DECISION_RECORDED", { Stage: "rv" }), at(t1, "GATE_APPROVED", { Stage: "rv" })),
    ).toBe(0);
    const unitAsk = { Stage: "cg", Checkpoint: "Construction Unit Approval", Unit: "u1" };
    const unitGate = { Stage: "cg", Checkpoint: "construction-unit", Unit: "u1" };
    expect(wait(at(t0, "DECISION_RECORDED", unitAsk), at(t1, "GATE_APPROVED", unitGate))).toBe(
      3600,
    );
    expect(
      wait(
        at(t0, "DECISION_RECORDED", unitAsk),
        at(t1, "GATE_APPROVED", { ...unitGate, Unit: "u2" }),
      ),
    ).toBe(0);
    // A team unit gate is matched by unit and gate scope too (`unitGateStatus`), and a
    // unit-end gate opens and closes on the final stage — so Stage alone pairs it.
    const unitEnd = { Stage: "cg", Unit: "u1", "Gate Scope": "unit-end", "Gate Stages": "fd, cg" };
    expect(wait(at(t0, "STAGE_AWAITING_APPROVAL", unitEnd), at(t1, "GATE_APPROVED", unitEnd))).toBe(
      3600,
    );
    expect(
      wait(
        at(t0, "STAGE_AWAITING_APPROVAL", unitEnd),
        at(t1, "GATE_APPROVED", { ...unitEnd, Unit: "u2" }),
      ),
    ).toBe(0);
    expect(
      wait(
        at(t0, "STAGE_AWAITING_APPROVAL", unitEnd),
        at(t1, "GATE_APPROVED", { ...unitEnd, "Gate Scope": "per-stage" }),
      ),
    ).toBe(0);
    expect(
      wait(
        at(t0, "STAGE_AWAITING_APPROVAL", { Stage: "cg" }),
        at(t1, "GATE_APPROVED", { Stage: "cg", Unit: "u1" }),
      ),
    ).toBe(0);
    // A decision's answer for another unit of the same stage is another ask's.
    expect(
      wait(
        at(t0, "DECISION_RECORDED", { Stage: "cg", Unit: "u1" }),
        at(t1, "QUESTION_ANSWERED", { Stage: "cg", Unit: "u2" }),
      ),
    ).toBe(0);
    // A turn that was only a command, or only a question about a switch, did not reply
    // (`isReplyTurn`).
    for (const Reply of ["command", "question"]) {
      expect(
        wait(at(t0, "DECISION_RECORDED", { Stage: "rv" }), at(t1, "HUMAN_TURN", { Reply })),
      ).toBe(0);
    }
  });

  test("a backfilled gate row opens nothing; a revalidated one is still the open gate", () => {
    // The approve-time backstop writes `Recovered: true` while handling the approval.
    const recovered = classifyGaps([
      evf("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL", { Stage: "rv", Recovered: "true" }),
      evf("2026-01-01T01:00:00Z", "GATE_APPROVED", { Stage: "rv" }),
    ]);
    expect(recovered.humanWaitSec).toBe(0);
    const revalidated = classifyGaps([
      evf("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL", { Stage: "rv", Revalidated: "true" }),
      evf("2026-01-01T01:00:00Z", "GATE_APPROVED", { Stage: "rv" }),
    ]);
    expect(revalidated.humanWaitSec).toBe(3600);
  });

  test("another clone's row between an ask and its answer does not hide the wait", () => {
    // The wait is read on the asking clone's own rows, so one foreign row between the
    // ask and its answer no longer breaks it — while that clone is not otherwise there.
    const on = (ts: string, event: string, shard: string, fields: Record<string, string> = {}) => ({
      ...evf(ts, event, fields),
      shard,
    });
    const lone = classifyGaps([
      on("2026-01-01T00:00:00Z", "DECISION_RECORDED", "a", { Stage: "rv" }),
      on("2026-01-01T00:20:00Z", "ARTIFACT_UPDATED", "b"),
      on("2026-01-01T01:00:00Z", "HUMAN_TURN", "a"),
    ]);
    expect(lone.humanWaitSec).toBe(3600);
  });

  test("a matched delegation on other shards stays delegated through a clone's wait", () => {
    // A request on one shard and its completion on a copy are both absent at every gap,
    // so only the asking clone is present — but the review window is measured work.
    const on = (ts: string, event: string, shard: string, fields: Record<string, string> = {}) => ({
      ...evf(ts, event, fields),
      shard,
    });
    const review = { Stage: "cg", Reviewer: "code-reviewer", Iteration: "1", "Request Id": "r1" };
    const g = classifyGaps([
      on("2026-01-01T00:00:00Z", "DECISION_RECORDED", "a", { Stage: "rv" }),
      on("2026-01-01T00:10:00Z", "REVIEW_REQUESTED", "b", {
        ...review,
        "Artifact Fingerprint": "fp",
      }),
      on("2026-01-01T00:50:00Z", "REVIEW_COMPLETED", "c", {
        ...review,
        Verdict: "READY",
        "Request Fingerprint": "fp",
        "Artifact Fingerprint": "fp",
      }),
      on("2026-01-01T01:00:00Z", "HUMAN_TURN", "a"),
    ]);
    expect(g.delegatedSec).toBe(2400);
    expect(g.humanWaitSec).toBe(1200);
  });

  test("a clone that is working while another waits keeps the gap out of the wait", () => {
    const on = (ts: string, event: string, shard: string, fields: Record<string, string> = {}) => ({
      ...evf(ts, event, fields),
      shard,
    });
    // b writes before, during and after a's wait: b is present and not waiting.
    const g = classifyGaps([
      on("2026-01-01T00:00:00Z", "ARTIFACT_UPDATED", "b"),
      on("2026-01-01T00:01:00Z", "DECISION_RECORDED", "a", { Stage: "rv" }),
      on("2026-01-01T00:02:00Z", "ARTIFACT_UPDATED", "b"),
      on("2026-01-01T00:03:00Z", "ARTIFACT_UPDATED", "b"),
      on("2026-01-01T00:04:00Z", "HUMAN_TURN", "a"),
      on("2026-01-01T00:05:00Z", "ARTIFACT_UPDATED", "b"),
    ]);
    expect(g.humanWaitSec).toBe(0);
    // Both clones waiting on a person at once is the team waiting.
    const both = classifyGaps([
      on("2026-01-01T00:00:00Z", "DECISION_RECORDED", "a", { Stage: "rv" }),
      on("2026-01-01T00:01:00Z", "STAGE_AWAITING_APPROVAL", "b", { Stage: "fd" }),
      on("2026-01-01T00:30:00Z", "HUMAN_TURN", "a"),
      on("2026-01-01T00:40:00Z", "GATE_APPROVED", "b", { Stage: "fd" }),
    ]);
    // Every gap counts: before b's first row only a is there, and after a's last only b.
    expect(both.humanWaitSec).toBe(2400);
  });

  test("an ask with no Stage is not paired with a receipt that names one", () => {
    // Both are required fields in 2.11; a row missing one cannot be shown to answer it.
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL"),
      evf("2026-01-01T01:00:00Z", "GATE_APPROVED", { Stage: "rv" }),
    ]);
    expect(g.humanWaitSec).toBe(0);
  });

  test("a receipt with no gate in front of it is CONVERSATION, not a wait", () => {
    // The gate widening is about what CLOSES a wait. `HUMAN_TURN → HUMAN_TURN` holds
    // both the engine's unaudited chat reply and the human's reading time, and the
    // ledger records no boundary — so it goes to neither side, and to neither of the
    // two compatibility aggregates.
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "HUMAN_TURN"),
      ev("2026-01-01T01:00:00Z", "HUMAN_TURN"),
    ]);
    expect(g.conversationSec).toBe(3600);
    expect(g.humanWaitSec).toBe(0);
    expect(g.unknownSec).toBe(0);
    expect(g.observedSec).toBe(0);
    expect(g.idleSec).toBe(0);
    expect(g.workSec).toBe(0);
  });

  test("conversation has no duration floor, but does need the same clone", () => {
    // No floor: the rule reads the marker, not the clock, so a 3-second exchange is
    // the same phenomenon as a 40-minute one. Before this bucket existed, the 300s
    // cut split one phenomenon across `observed` and `unknown` — 1.77h and 2.95h of
    // it on the measured run.
    const short = classifyGaps([
      ev("2026-01-01T00:00:00Z", "HUMAN_TURN"),
      ev("2026-01-01T00:00:03Z", "HUMAN_TURN"),
    ]);
    expect(short.conversationSec).toBe(3);
    expect(short.observedSec).toBe(0);
    // Two clones' human turns adjacent in the merged ledger are two developers.
    const cross = classifyGaps([
      { ts: "2026-01-01T00:00:00Z", event: "HUMAN_TURN", fields: {}, shard: "a" },
      { ts: "2026-01-01T01:00:00Z", event: "HUMAN_TURN", fields: {}, shard: "b" },
    ]);
    expect(cross.conversationSec).toBe(0);
    expect(cross.unknownSec).toBe(3600);
  });

  test("SESSION_RESUMED closes a gap like SESSION_STARTED does", () => {
    // audit-format.md: "Existing Claude Code session resumed (source=resume)". Its
    // sibling was in the resume set and it was not, so a 40-minute break closed by it
    // went to 미분류 — the one event name where that misfiling is unambiguous.
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "SENSOR_PASSED"),
      ev("2026-01-01T00:40:00Z", "SESSION_RESUMED"),
    ]);
    expect(g.parkedSec).toBe(2400);
    expect(g.inferredParkSec).toBe(2400);
    expect(g.unknownSec).toBe(0);
  });

  test("delegation counts as AGENT and inside WORK", () => {
    const g = classifyGaps([
      req("2026-01-01T00:00:00Z", "review:a"),
      done("2026-01-01T00:10:00Z", "review:a"),
    ]);
    expect(g.agentSec).toBe(600);
    expect(g.workSec).toBe(600);
    expect(g.idleSec).toBe(0);
  });

  test("a gap ending in a session resume is IDLE even with no gate before it", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "SENSOR_PASSED"),
      ev("2026-01-01T00:40:00Z", "SESSION_STARTED"),
    ]);
    expect(g.idleSec).toBe(2400);
    expect(g.parkedSec).toBe(2400);
    expect(g.inferredParkSec).toBe(2400);
  });

  test("WORKFLOW_PARKED → UNPARKED stays paused even with events in between", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "WORKFLOW_PARKED"),
      ev("2026-01-01T00:30:00Z", "HUMAN_TURN"),
      ev("2026-01-01T01:00:00Z", "WORKFLOW_UNPARKED"),
      ev("2026-01-01T01:00:30Z", "ARTIFACT_UPDATED"),
    ]);
    expect(g.parkedSec).toBe(3600);
    expect(g.observedSec).toBe(30);
    expect(g.unknownSec).toBe(0);
  });

  test("STAGE_AWAITING_APPROVAL → HUMAN_TURN is user wait", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL"),
      ev("2026-01-01T00:20:00Z", "HUMAN_TURN"),
    ]);
    expect(g.humanWaitSec).toBe(1200);
  });

  test("short gate gaps stay WORK (below the 60s floor)", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "DECISION_RECORDED"),
      ev("2026-01-01T00:00:30Z", "HUMAN_TURN"),
    ]);
    expect(g.idleSec).toBe(0);
    expect(g.workSec).toBe(30);
  });

  test("long unclassified gaps are surfaced as suspect", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "SENSOR_PASSED"),
      ev("2026-01-01T00:20:00Z", "ARTIFACT_UPDATED"),
    ]);
    expect(g.suspect.length).toBe(1);
    expect(g.suspect[0]?.seconds).toBe(1200);
    expect(g.unknownSec).toBe(1200);
    expect(g.observedSec).toBe(0);
    expect(g.workSec).toBe(1200);
  });

  // A shard that has not started, or has already gone quiet, is ABSENT — not
  // working. Comparing against the whole ledger's shard set made "every clone is
  // parked" unreachable on a sequential handover: measured on a real 3-shard run it
  // fired for 0 gaps and discarded all 80.31h the ledger marks as parked.
  test("a clone that has finished is absent, so the remaining clone's park counts", () => {
    const at = (ts: string, event: string, shard: string): AuditEvent => ({
      ts,
      event,
      fields: {},
      shard,
    });
    // THE DISCRIMINATING CASE: A leaves WITHOUT parking. Against the whole ledger's
    // shard set, "every clone parked" then needs A — which never happens — so B's
    // explicit park was discarded. This is the sequential-handover shape that made a
    // real run report 0.00h of explicit park out of 80.31h marked.
    const g = classifyGaps([
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "a.md"),
      at("2026-01-01T00:10:00Z", "STAGE_COMPLETED", "a.md"), // A's last event
      at("2026-01-01T00:20:00Z", "SENSOR_FIRED", "b.md"),
      at("2026-01-01T00:30:00Z", "WORKFLOW_PARKED", "b.md"),
      at("2026-01-01T01:30:00Z", "HUMAN_TURN", "b.md"),
    ]);
    expect(g.parkedSec).toBe(3600); // B's marked hour, counted
    expect(g.inferredParkSec).toBe(0); // from the explicit marker, not a session guess
  });

  test("a parked clone does not stop the team while another clone is still present", () => {
    const at = (ts: string, event: string, shard: string): AuditEvent => ({
      ts,
      event,
      fields: {},
      shard,
    });
    const g = classifyGaps([
      at("2026-01-01T00:00:00Z", "SENSOR_FIRED", "a.md"),
      at("2026-01-01T00:10:00Z", "WORKFLOW_PARKED", "a.md"),
      // A is alone and parked for this hour → the team really is stopped.
      at("2026-01-01T01:10:00Z", "SENSOR_FIRED", "b.md"),
      // Now BOTH are present (A still has an event to come) and only A is parked,
      // so this stretch is not a team stop.
      at("2026-01-01T01:20:00Z", "SENSOR_PASSED", "a.md"),
      at("2026-01-01T01:30:00Z", "SENSOR_PASSED", "b.md"),
    ]);
    expect(g.parkedSec).toBe(3600); // only the hour A was the sole clone present
    // The stretch with A parked and B present is not park — it stays unclassified
    // rather than being credited to either side.
    expect(g.suspect.some((s) => s.at === "2026-01-01T01:10:00Z" && s.seconds === 600)).toBe(true);
    expect(g.unknownSec).toBe(1800); // that stretch plus the two 10-minute edges
  });

  // `REVIEW_REQUESTED` is followed by the artifacts the reviewer writes, so the
  // close is several events later. Measured on a real run, 52 of 61 delegation gaps
  // closed on `ARTIFACT_UPDATED`, so an adjacency test saw 0.31h of a real 14.4h.
  test("delegation spans the whole open→close window, not just the adjacent pair", () => {
    const g = classifyGaps([
      req("2026-01-01T00:00:00Z", "review:a"),
      ev("2026-01-01T00:20:00Z", "ARTIFACT_UPDATED"),
      ev("2026-01-01T00:40:00Z", "ARTIFACT_UPDATED"),
      done("2026-01-01T01:00:00Z", "review:a"),
      // After the close, an equally long gap is NOT delegation.
      ev("2026-01-01T01:20:00Z", "ARTIFACT_UPDATED"),
    ]);
    expect(g.delegatedSec).toBe(3600); // the full hour under review
    expect(g.observedSec).toBe(3600); // delegation is inside work
    expect(g.unknownSec).toBe(1200); // the post-close gap stays unclassified
  });

  // 2.11 writes a SUBAGENT_COMPLETED per subagent (Claude Code's hook), carrying no
  // request it answers; closing on the first one cut a review window to its first minute.
  test("a subagent completion does not close a review: only its own Request Id does", () => {
    const g = classifyGaps([
      req("2026-01-01T00:00:00Z", "review:a"),
      ev("2026-01-01T00:01:00Z", "SUBAGENT_COMPLETED"),
      done("2026-01-01T00:20:00Z", "review:other"),
      done("2026-01-01T00:40:00Z", "review:a"),
    ]);
    expect(g.delegatedSec).toBe(2400);
    expect(g.unknownSec).toBe(0);
  });

  test("a retried request opens the window at the last request its completion answers", () => {
    const g = classifyGaps([
      req("2026-01-01T00:00:00Z", "review:a"),
      ev("2026-01-01T00:30:00Z", "SESSION_STARTED"),
      req("2026-01-01T00:31:00Z", "review:a", { Retry: "pending-request" }),
      done("2026-01-01T00:41:00Z", "review:a"),
    ]);
    expect(g.delegatedSec).toBe(600);
  });

  // A replacement takes the iteration's pass: the replaced id's late completion answers
  // nothing, as `reviewAttemptAccounting` keeps one pending request per iteration.
  test("a replaced request's late completion closes nothing", () => {
    const g = classifyGaps([
      req("2026-01-01T00:00:00Z", "review:a"),
      req("2026-01-01T00:02:00Z", "review:b", { "Replaces Request Id": "review:a" }),
      done("2026-01-01T00:20:00Z", "review:a"),
      done("2026-01-01T00:40:00Z", "review:b"),
    ]);
    expect(g.delegatedSec).toBe(38 * 60);
  });

  // Dropping a copied shard's duplicates can leave the request in the original file and
  // its completion only in the copy; the engine's matcher has no shard limit.
  test("a review pairs across shards", () => {
    const g = classifyGaps([
      req("2026-01-01T00:00:00Z", "review:a"),
      { ...done("2026-01-01T00:10:00Z", "review:a"), shard: "copy" },
    ]);
    expect(g.delegatedSec).toBe(600);
  });

  test("a legacy request with no id pairs with an id-less completion of its fingerprint", () => {
    const g = classifyGaps([
      req("2026-01-01T00:00:00Z", undefined),
      done("2026-01-01T00:05:00Z", undefined, { "Request Fingerprint": "fp-other" }),
      done("2026-01-01T00:10:00Z", undefined),
    ]);
    expect(g.delegatedSec).toBe(600);
  });

  test("another reviewer's or iteration's completion does not close the request", () => {
    const g = classifyGaps([
      req("2026-01-01T00:00:00Z", "review:a"),
      done("2026-01-01T00:10:00Z", "review:a", { Reviewer: "security-reviewer" }),
      done("2026-01-01T00:20:00Z", "review:a", { Iteration: "2" }),
    ]);
    expect(g.delegatedSec).toBe(0);
  });

  // A pinned Unit merge is read by its pin identity (`requireMergeDispatchDecision`),
  // so a terminal for pin B cannot close pin A's invocation.
  test("a pinned merge terminal pairs only with its own pin", () => {
    const pin = (id: string) => ({
      "Bolt slug": "u1",
      "Pinned OID": "f".repeat(40),
      "Attempt Generation": "1",
      "Pin Transaction": id,
    });
    const g = classifyGaps([
      evf("2026-01-01T00:00:00Z", "MERGE_DISPATCH_INVOKED", pin("pin-a")),
      evf("2026-01-01T00:10:00Z", "MERGE_DISPATCH_INVOKED", pin("pin-b")),
      evf("2026-01-01T00:15:00Z", "MERGE_DISPATCH_RETURNED", pin("pin-b")),
    ]);
    expect(g.delegatedSec).toBe(300);
  });

  test("merge dispatch pairs by Bolt slug with the first terminal after it", () => {
    const g = classifyGaps([
      evf("2026-01-01T00:00:00Z", "MERGE_DISPATCH_INVOKED", { "Bolt slug": "b1" }),
      evf("2026-01-01T00:02:00Z", "MERGE_DISPATCH_INVOKED", { "Bolt slug": "b2" }),
      evf("2026-01-01T00:10:00Z", "MERGE_DISPATCH_FALLBACK", { "Bolt slug": "b2" }),
      evf("2026-01-01T00:20:00Z", "MERGE_DISPATCH_RETURNED", { "Bolt slug": "b1" }),
      // A terminal with no invocation open marks nothing.
      evf("2026-01-01T00:40:00Z", "MERGE_DISPATCH_RETURNED", { "Bolt slug": "b1" }),
    ]);
    expect(g.delegatedSec).toBe(1200);
    expect(g.unknownSec).toBe(1200);
  });

  test("events the 2.11 engine never writes open nothing", () => {
    const g = classifyGaps([
      ev("2026-01-01T00:00:00Z", "SUBAGENT_DISPATCHED"),
      ev("2026-01-01T00:10:00Z", "SUBAGENT_COMPLETED"),
      ev("2026-01-01T00:20:00Z", "GATE_OPENED"),
      ev("2026-01-01T00:30:00Z", "HUMAN_TURN"),
      ev("2026-01-01T00:40:00Z", "QUESTION_ASKED"),
      ev("2026-01-01T00:50:00Z", "HUMAN_TURN"),
    ]);
    expect(g.delegatedSec).toBe(0);
    expect(g.humanWaitSec).toBe(0);
  });

  test("a recorded plan approval closes the wait like any other answer receipt", () => {
    const g = classifyGaps([
      evf("2026-01-01T00:00:00Z", "DECISION_RECORDED", { Stage: "cg" }),
      evf("2026-01-01T00:30:00Z", "PLAN_APPROVAL_RECORDED", { Stage: "cg" }),
    ]);
    expect(g.humanWaitSec).toBe(1800);
  });

  test("an unclosed delegation marks nothing, so a dangling open cannot swallow the run", () => {
    const g = classifyGaps([
      req("2026-01-01T00:00:00Z", "review:a"),
      ev("2026-01-01T00:20:00Z", "ARTIFACT_UPDATED"),
      ev("2026-01-01T00:40:00Z", "ARTIFACT_UPDATED"),
    ]);
    expect(g.delegatedSec).toBe(0);
    expect(g.unknownSec).toBe(2400);
  });
});

// Parallel development: each developer's machine writes its own audit shard, and
// gap classification is only meaningful WITHIN a shard.
describe("per-worker decomposition", () => {
  const at = (
    ts: string,
    event: string,
    shard: string,
    extra: Partial<AuditEvent> = {},
  ): AuditEvent => ({
    ts,
    event,
    fields: {},
    shard,
    ...extra,
  });

  test("shardLabel strips the clone id and machine token, keeps a human name", () => {
    expect(shardLabel("jiho-kim-c02dw4rrmd6r-0c1b20ca004a.md")).toBe("jiho-kim");
    expect(shardLabel("hyeongjun-kim-c02g53bjmd6t-890e6b5a6b4e.md")).toBe("hyeongjun-kim");
    // No machine token — a pure hostname must survive intact.
    expect(shardLabel("macbook-pro-8-local-a444271ccd58.md")).toBe("macbook-pro-8-local");
    // Unrecognised shape keeps its basename rather than being mangled.
    expect(shardLabel("plain.md")).toBe("plain");
  });

  test("classifies each shard on its OWN timeline, not the merged one", () => {
    // A waits at a gate 07:00→08:00 while B works right through the same hour.
    // Merged, B's events fill A's wait and the idle vanishes; per shard it stands.
    const events = [
      at("2026-01-01T07:00:00Z", "DECISION_RECORDED", "a.md"),
      at("2026-01-01T07:20:00Z", "SENSOR_FIRED", "b.md"),
      at("2026-01-01T07:40:00Z", "SENSOR_PASSED", "b.md"),
      at("2026-01-01T08:00:00Z", "HUMAN_TURN", "a.md"),
    ].sort((x, y) => (x.ts < y.ts ? -1 : 1));

    // Merged: A's wait is read on A's own rows, so B's rows no longer erase it — but
    // the 20 minutes B is between its rows are B's work, not the team waiting. Before
    // B's first row and after its last, only A is there.
    expect(classifyGaps(events).idleSec).toBe(2400);

    // Per worker: A's full hour of waiting is recovered.
    const workers = buildWorkers(events);
    const a = workers.find((w) => w.shard === "a.md")!;
    expect(a.idleSec).toBe(3600);
    expect(workers.find((w) => w.shard === "b.md")?.idleSec).toBe(0);
  });

  test("ranks workers by event count and flags the gate-driving clone", () => {
    const events = [
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "lead.md", { stage: "code-generation" }),
      at("2026-01-01T00:01:00Z", "SENSOR_FIRED", "lead.md", { stage: "code-generation" }),
      at("2026-01-01T00:02:00Z", "GATE_APPROVED", "lead.md", { stage: "code-generation" }),
      at("2026-01-01T00:03:00Z", "STAGE_COMPLETED", "lead.md", { stage: "code-generation" }),
      at("2026-01-01T00:04:00Z", "SENSOR_FIRED", "helper.md", { stage: "code-generation" }),
    ];
    const workers = buildWorkers(events);
    expect(workers[0]?.shard).toBe("lead.md"); // busiest first
    expect(workers[0]?.gatesApproved).toBe(1);
    expect(workers[0]?.stagesCompleted).toBe(1);
    expect(workers[1]?.gatesApproved).toBe(0);
  });

  test("collects the stages and units each worker touched", () => {
    const events = [
      at("2026-01-01T00:00:00Z", "ARTIFACT_CREATED", "a.md", {
        stage: "code-generation",
        unit: "PU-1",
      }),
      at("2026-01-01T00:01:00Z", "ARTIFACT_CREATED", "a.md", {
        stage: "code-generation",
        unit: "PU-2",
      }),
      at("2026-01-01T00:02:00Z", "SENSOR_FIRED", "a.md", { stage: "nfr-design" }),
    ];
    const w = buildWorkers(events)[0]!;
    expect(w.stages).toContain("code-generation");
    expect(w.stages).toContain("nfr-design");
    expect(w.units.sort()).toEqual(["PU-1", "PU-2"]);
  });

  test("a single-clone run is not parallel and person-time equals wall-clock", () => {
    const events = [
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "solo.md", { stage: "s" }),
      at("2026-01-01T01:00:00Z", "STAGE_COMPLETED", "solo.md", { stage: "s" }),
    ];
    const t = buildTiming({
      events,
      counts: new Map(),
      shards: ["solo.md"],
      firstTs: events[0]?.ts,
      lastTs: events[1]?.ts,
    });
    expect(t.parallel).toBe(false);
    expect(t.workers.length).toBe(1);
    expect(t.personElapsedSec).toBe(t.elapsedSec);
    // One clone has nothing to be parallel WITH, so the ratio is not reported —
    // reporting 1.00× would invite reading it as a measurement of concurrency.
    expect(t.overlapSec).toBe(0);
    expect(t.parallelism).toBeUndefined();
  });

  test("non-overlapping shards are a handover, not parallel development", () => {
    // Real shape: 3 shards / 2 developers whose windows do not overlap at all. The
    // old reading called that 병렬 개발 with parallelism 0.985.
    const events = [
      at("2026-01-01T00:00:00Z", "SENSOR_FIRED", "a-aaaaaaaaaaaa.md"),
      at("2026-01-01T01:00:00Z", "SENSOR_PASSED", "a-aaaaaaaaaaaa.md"),
      // 30 minutes of handover, then the second clone picks it up.
      at("2026-01-01T01:30:00Z", "SENSOR_FIRED", "b-bbbbbbbbbbbb.md"),
      at("2026-01-01T02:30:00Z", "SENSOR_PASSED", "b-bbbbbbbbbbbb.md"),
      // A third shard sharing the SECOND clone's id — same working copy, other host.
      at("2026-01-01T03:00:00Z", "SENSOR_FIRED", "host2-bbbbbbbbbbbb.md"),
      at("2026-01-01T03:30:00Z", "SENSOR_PASSED", "host2-bbbbbbbbbbbb.md"),
    ];
    const t = buildTiming({ events, counts: new Map(), shards: [] });
    expect(t.workers.length).toBe(3);
    expect(t.clones).toBe(2); // two working copies, not three
    expect(t.overlapSec).toBe(0);
    expect(t.parallelism).toBeUndefined();
    expect(t.handoverSec).toBe(3600); // 30min + 30min between the three windows
  });

  test("parallelism exceeds 1 when shards overlap in time", () => {
    // Two shards, each spanning the same hour → 2 person-hours in 1 wall-hour.
    const events = [
      at("2026-01-01T00:00:00Z", "SENSOR_FIRED", "a.md"),
      at("2026-01-01T00:00:30Z", "SENSOR_FIRED", "b.md"),
      at("2026-01-01T01:00:00Z", "SENSOR_PASSED", "a.md"),
      at("2026-01-01T01:00:00Z", "SENSOR_PASSED", "b.md"),
    ];
    const t = buildTiming({
      events,
      counts: new Map(),
      shards: ["a.md", "b.md"],
      firstTs: events[0]?.ts,
      lastTs: "2026-01-01T01:00:00Z",
    });
    expect(t.parallel).toBe(true);
    expect(t.parallelism!).toBeGreaterThan(1.9);
  });

  test("workflow completion closes wall time and STAGE_SKIPPED closes its segment", () => {
    const events = [
      at("2026-01-01T00:00:00Z", "WORKFLOW_STARTED", "solo.md"),
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "solo.md", { stage: "optional" }),
      at("2026-01-01T00:00:10Z", "STAGE_SKIPPED", "solo.md", { stage: "optional" }),
      at("2026-01-01T00:00:20Z", "WORKFLOW_COMPLETED", "solo.md"),
      at("2026-01-01T01:00:00Z", "HUMAN_TURN", "solo.md"),
    ];
    const t = buildTiming(
      {
        events,
        counts: new Map(),
        shards: ["solo.md"],
        firstTs: events[0]?.ts,
        lastTs: events.at(-1)?.ts,
      },
      "2026-01-01T02:00:00Z",
    );
    expect(t.elapsedSec).toBe(20);
    expect(t.lastTs).toBe("2026-01-01T00:00:20Z");
    expect(t.stages[0]?.endKind).toBe("skipped");
    expect(t.stages[0]?.elapsedSec).toBe(10);
  });

  test("an open run separates the last event from the window end, and names the silence", () => {
    // A tree copied mid-run (or simply parked) keeps a fixed last event while the
    // window keeps ending at "now". Measured on such a copy: the window read 130.3h
    // at the read and 562.1h 18 days later while the classified total stayed 130.3h.
    //
    // TWO SHARDS ON PURPOSE. The first version of this test used one shard, and that
    // is why it passed against a build where the trailing silence WAS classified: a
    // lone shard is trivially "all parked" after a park marker, so the silence went
    // to `parkedSec` while the test only watched `unknownSec`. With two shards the
    // silence lands in `unknownSec` unless it is excluded from classification, so
    // this fixture actually holds the invariant its assertions claim.
    // A CONVERSATION GAP ON PURPOSE, for the same reason: the bucket-sum assertion
    // below is only a real check of the five-way split if the fixture actually visits
    // every bucket. Without these two human turns it passed while summing four.
    const events = [
      at("2026-01-01T00:00:00Z", "WORKFLOW_STARTED", "a.md"),
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "a.md", { stage: "nfr-design" }),
      at("2026-01-01T00:10:00Z", "HUMAN_TURN", "a.md"),
      at("2026-01-01T00:20:00Z", "HUMAN_TURN", "a.md"),
      at("2026-01-01T00:30:00Z", "SENSOR_FIRED", "b.md", { stage: "nfr-design" }),
      at("2026-01-01T01:00:00Z", "WORKFLOW_PARKED", "a.md", { stage: "nfr-design" }),
    ];
    const ledger = { events, counts: new Map(), shards: ["a.md", "b.md"] };
    const atRead = buildTiming(ledger, "2026-01-01T01:00:00Z");
    const muchLater = buildTiming(ledger, "2026-01-04T01:00:00Z");

    // The last EVENT does not move; only the window does.
    expect(atRead.lastEventTs).toBe("2026-01-01T01:00:00Z");
    expect(muchLater.lastEventTs).toBe("2026-01-01T01:00:00Z");
    expect(muchLater.lastTs).toBe("2026-01-04T01:00:00Z");
    expect(atRead.sinceLastEventSec).toBe(0);
    expect(muchLater.sinceLastEventSec).toBe(3 * 24 * 3600);
    expect(muchLater.elapsedSec).toBe(atRead.elapsedSec + 3 * 24 * 3600);

    // Every bucket is untouched by the clock, and no synthetic event is invented.
    for (const pick of [
      (g: GapSplit) => g.humanWaitSec,
      (g: GapSplit) => g.parkedSec,
      (g: GapSplit) => g.observedSec,
      (g: GapSplit) => g.conversationSec,
      (g: GapSplit) => g.unknownSec,
    ]) {
      expect(pick(muchLater.total)).toBe(pick(atRead.total));
    }
    expect(muchLater.total.conversationSec).toBe(600);
    expect(muchLater.total.unknown.some((u) => u.toEvent === "ANALYSIS_NOW")).toBe(false);
    // The buckets account for the window MINUS the silence, exactly.
    const bucketSum =
      muchLater.total.humanWaitSec +
      muchLater.total.parkedSec +
      muchLater.total.observedSec +
      muchLater.total.conversationSec +
      muchLater.total.unknownSec;
    expect(bucketSum).toBe(muchLater.elapsedSec - muchLater.sinceLastEventSec);
    // And an unfinished stage stops at its last event rather than following the clock.
    const stage = muchLater.stages.find((s) => s.stage === "nfr-design")!;
    expect(stage.endedAt).toBe("2026-01-01T01:00:00Z");
    expect(stage.elapsedSec).toBe(atRead.stages[0]!.elapsedSec);
  });

  test("stage re-entry sums entered segments instead of spanning unrelated work", () => {
    const events = [
      at("2026-01-01T00:00:00Z", "WORKFLOW_STARTED", "solo.md"),
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "solo.md", { stage: "rework" }),
      at("2026-01-01T00:00:10Z", "STAGE_COMPLETED", "solo.md", { stage: "rework" }),
      at("2026-01-01T00:00:10Z", "STAGE_STARTED", "solo.md", { stage: "other" }),
      at("2026-01-01T00:00:20Z", "STAGE_COMPLETED", "solo.md", { stage: "other" }),
      at("2026-01-01T00:00:20Z", "STAGE_STARTED", "solo.md", { stage: "rework" }),
      at("2026-01-01T00:00:30Z", "STAGE_COMPLETED", "solo.md", { stage: "rework" }),
      at("2026-01-01T00:00:30Z", "WORKFLOW_COMPLETED", "solo.md"),
    ];
    const t = buildTiming({ events, counts: new Map(), shards: ["solo.md"] });
    const rework = t.stages.find((stage) => stage.stage === "rework");
    expect(rework?.segments.length).toBe(2);
    expect(rework?.elapsedSec).toBe(20);
  });

  test("a segment closed by re-entry is superseded, never 'in-flight'", () => {
    // Measured symptom: two blue "진행중" bars sitting five days in the past, because a
    // re-entry closed the earlier attempt with the state it happened to be in.
    const events = [
      at("2026-01-01T00:00:00Z", "STAGE_STARTED", "solo.md", { stage: "reqs" }),
      at("2026-01-01T01:00:00Z", "STAGE_AWAITING_APPROVAL", "solo.md", { stage: "reqs" }),
      at("2026-01-01T02:00:00Z", "GATE_REJECTED", "solo.md", { stage: "reqs" }),
      // Re-entered after the rejection: the first attempt is over.
      at("2026-01-01T03:00:00Z", "STAGE_STARTED", "solo.md", { stage: "reqs" }),
      at("2026-01-01T04:00:00Z", "STAGE_COMPLETED", "solo.md", { stage: "reqs" }),
    ];
    const t = buildTiming({ events, counts: new Map(), shards: ["solo.md"] });
    const reqs = t.stages.find((s) => s.stage === "reqs")!;
    expect(reqs.segments.map((s) => s.endKind)).toEqual(["superseded", "completed"]);
    // The stage as a whole ended completed — the superseded kind never leaks upward.
    expect(reqs.endKind).toBe("completed");
  });

  test("an empty ledger yields a well-formed, non-parallel report", () => {
    const t = buildTiming({ events: [], counts: new Map(), shards: [] });
    expect(t.parallel).toBe(false);
    expect(t.workers).toEqual([]);
    expect(t.personIdleSec).toBe(0);
    expect(t.parallelism).toBeUndefined();
  });
});

// Rework: the ledger's richest signal, and the one the panel used to be silent about.
describe("rework", () => {
  const at = (ts: string, event: string, stage: string, fields: Record<string, string> = {}) =>
    ({ ts, event, fields, shard: "s.md", stage }) as AuditEvent;
  const ledger = (events: AuditEvent[]) => {
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.event, (counts.get(e.event) ?? 0) + 1);
    return { events, counts, shards: ["s.md"] };
  };

  test("pairs the first rejection with the last approval and keeps the human reason", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL", "reqs"),
        at("2026-01-01T01:00:00Z", "GATE_REJECTED", "reqs", { Feedback: "근거가 빠졌다" }),
        at("2026-01-01T01:00:00Z", "STAGE_REVISING", "reqs", {
          "Revision count": "2",
          Feedback: "근거가 빠졌다",
        }),
        at("2026-01-01T02:00:00Z", "STAGE_AWAITING_APPROVAL", "reqs"),
        at("2026-01-01T03:00:00Z", "GATE_APPROVED", "reqs"),
      ]),
    );
    expect(r.stages.length).toBe(1);
    const s = r.stages[0]!;
    expect(s.stage).toBe("reqs");
    expect(s.submissions).toBe(2);
    expect(s.rejections).toBe(1);
    expect(s.revisions).toBe(1);
    expect(s.revisionHigh).toBe(2);
    expect(s.reworkSec).toBe(7200); // 01:00 rejection → 03:00 approval
    expect(s.settled).toBe(true);
    // The same text on both events is one reason, not two.
    expect(s.feedback.map((f) => f.text)).toEqual(["근거가 빠졌다"]);
    expect(r.reworkSec).toBe(7200);
    expect(r.provisional).toBe(false);
  });

  test("two rejections span the whole stretch, including the approval in between", () => {
    // "Time this stage spent not yet accepted" — a revision has no close marker of its
    // own, so per-round spans are not available and must not be invented.
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "GATE_REJECTED", "d", { Feedback: "1차" }),
        at("2026-01-01T01:00:00Z", "GATE_APPROVED", "d"),
        at("2026-01-01T02:00:00Z", "GATE_REJECTED", "d", { Feedback: "2차" }),
        at("2026-01-01T04:00:00Z", "GATE_APPROVED", "d"),
      ]),
    );
    expect(r.stages[0]?.reworkSec).toBe(4 * 3600);
    expect(r.stages[0]?.rejections).toBe(2);
    expect(r.stages[0]?.feedback.map((f) => f.text)).toEqual(["2차", "1차"]); // newest first
  });

  test("an unapproved rejection stays provisional instead of reading as zero", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "GATE_REJECTED", "open", { Feedback: "고쳐라" }),
        at("2026-01-01T02:00:00Z", "ARTIFACT_UPDATED", "open"),
      ]),
    );
    expect(r.stages[0]?.settled).toBe(false);
    expect(r.stages[0]?.reworkSec).toBe(7200); // measured to its last event so far
    expect(r.provisional).toBe(true);
  });

  test("a clean run reports no rework stages", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL", "x"),
        at("2026-01-01T01:00:00Z", "GATE_APPROVED", "x"),
      ]),
    );
    expect(r.stages).toEqual([]);
    expect(r.reworkSec).toBe(0);
    expect(r.rejected).toBe(0);
    expect(r.approved).toBe(1);
  });

  // The approve-time backstop writes the backfilled rejection, the revision and the
  // re-entered gate in the SAME second as the approval that follows them.
  test("a backfilled rejection settles on the approval written in the same second", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "STAGE_AWAITING_APPROVAL", "x"),
        at("2026-01-01T01:00:00Z", "GATE_REJECTED", "x", { Recovered: "true" }),
        at("2026-01-01T01:00:00Z", "STAGE_REVISING", "x", { Recovered: "true" }),
        at("2026-01-01T01:00:00Z", "STAGE_AWAITING_APPROVAL", "x", { Recovered: "true" }),
        at("2026-01-01T01:00:00Z", "GATE_APPROVED", "x"),
        at("2026-01-01T02:00:00Z", "STAGE_COMPLETED", "x"),
      ]),
    );
    expect(r.stages[0]?.settled).toBe(true);
    expect(r.stages[0]?.reworkSec).toBe(0);
    expect(r.provisional).toBe(false);
  });

  test("a unit gate is its own record: unit B's approval does not settle unit A", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "GATE_REJECTED", "cg", { Unit: "A", Feedback: "A 다시" }),
        at("2026-01-01T01:00:00Z", "GATE_APPROVED", "cg", { Unit: "B" }),
        at("2026-01-01T02:00:00Z", "ARTIFACT_UPDATED", "cg", { Unit: "A" }),
      ]),
    );
    expect(r.stages.length).toBe(1);
    expect(r.stages[0]?.unit).toBe("A");
    expect(r.stages[0]?.settled).toBe(false);
    expect(r.stages[0]?.reworkSec).toBe(7200);
  });

  // The swarm writes one rejection per unit and ONE approval naming the batch.
  test("a swarm batch approval settles each unit its Units list names", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "GATE_REJECTED", "cg", { Unit: "A", Units: "A, B" }),
        at("2026-01-01T00:00:00Z", "GATE_REJECTED", "cg", { Unit: "B", Units: "A, B" }),
        at("2026-01-01T01:00:00Z", "GATE_APPROVED", "cg", { Units: "A, B", "Batch number": "1" }),
      ]),
    );
    expect(r.stages.map((st) => [st.unit, st.settled])).toEqual([
      ["A", true],
      ["B", true],
    ]);
  });

  test("the stage's own approval settles a unit's Request Changes reopen", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "GATE_REJECTED", "fd", { Unit: "A", Reopen: "change" }),
        at("2026-01-01T02:00:00Z", "GATE_APPROVED", "fd"),
      ]),
    );
    expect(r.stages[0]?.settled).toBe(true);
    expect(r.stages[0]?.reworkSec).toBe(7200);
  });

  // A unit-end checkpoint names its last stage in Stage and every stage in Gate Stages.
  test("a checkpoint approval covers each stage its Gate Stages names", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "GATE_REJECTED", "fd", { Unit: "A", Reopen: "change" }),
        at("2026-01-01T01:00:00Z", "GATE_APPROVED", "cg", {
          Unit: "A",
          "Gate Stages": "fd, cg",
          "Gate Scope": "unit-end",
        }),
      ]),
    );
    expect(r.stages[0]?.settled).toBe(true);
  });

  // Two clones' same-second rows are ordered by a sort, not by causality.
  test("another shard's approval in the same second does not prove settlement", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "GATE_REJECTED", "x"),
        { ...at("2026-01-01T00:00:00Z", "GATE_APPROVED", "x"), shard: "z.md" },
      ]),
    );
    expect(r.stages[0]?.settled).toBe(false);
  });

  test("a reopen on request is not a rejection; a Request Changes reopen is", () => {
    const r = buildRework(
      ledger([
        at("2026-01-01T00:00:00Z", "GATE_REJECTED", "fd", {
          Unit: "A",
          Reopen: "jump",
          Feedback: "Reopened Functional Design for unit A (/aidlc --stage fd).",
        }),
        at("2026-01-01T00:10:00Z", "GATE_REJECTED", "fd", { Unit: "B", Reopen: "redo" }),
        at("2026-01-01T00:20:00Z", "GATE_REJECTED", "fd", {
          Unit: "C",
          Reopen: "change",
          Feedback: "도메인 경계를 다시",
        }),
        at("2026-01-01T01:20:00Z", "GATE_APPROVED", "fd", { Unit: "C" }),
      ]),
    );
    expect(r.reopened).toBe(2);
    expect(r.rejected).toBe(1);
    expect(r.stages.map((st) => st.unit)).toEqual(["C"]);
    expect(r.stages[0]?.feedback.map((f) => f.text)).toEqual(["도메인 경계를 다시"]);
  });
});

describe("deferral ledger", () => {
  test("a section left in an HTML comment is not the ledger", () => {
    const parsed = parseDeferralSections(
      "<!--\n## Assumptions & Open Questions\n\n- `[assumption]` 지난 판의 전제\n-->\n",
    );
    expect(parsed.sections).toBe(0);
    expect(parsed.assumptions).toEqual([]);
  });

  const STRUCTURED = `# Requirements

## Functional Requirements

irrelevant

## Assumptions & Open Questions

### Assumptions

- \`[assumption]\` 배포 대상이 하나라는 전제. 확인 절차가 없다.
- 태그가 없는 불릿은 전제가 아니다.

### Open questions

| 항목 | 배정 |
| --- | --- |
| 공통 타입의 자리 | \`functional-design\` |
| 회귀 기준선 | \`build-and-test\` (\`C22\`) |

## Review

- 이 절은 대장 밖이다.
`;

  test("reads the mandated table and only the tagged assumptions", () => {
    const p = parseDeferralSections(STRUCTURED);
    expect(p.sections).toBe(1);
    expect(p.rows).toEqual([
      { item: "공통 타입의 자리", assignment: "`functional-design`" },
      { item: "회귀 기준선", assignment: "`build-and-test` (`C22`)" },
    ]);
    expect(p.assumptions).toEqual(["배포 대상이 하나라는 전제. 확인 절차가 없다."]);
    expect(p.declaredNone).toBe(false);
  });

  test("the header row is not an item — the |---| separator is what admits rows", () => {
    // Without the separator guard the header itself becomes an open item called
    // "항목", which then reads as a permanent unresolved decision on the page.
    const p = parseDeferralSections(STRUCTURED);
    expect(p.rows.map((r) => r.item)).not.toContain("항목");
  });

  test("the LAST cell is the assignment, so a 3-column variant still resolves", () => {
    const p = parseDeferralSections(`## Assumptions & Open Questions

### Open questions

| 항목 | 무엇이 없어서 못 정하는가 | 배정 |
| --- | --- | --- |
| 격리 경계 | 환경 정보 없음 | \`infrastructure-design\` |
`);
    expect(p.rows).toEqual([{ item: "격리 경계", assignment: "`infrastructure-design`" }]);
  });

  test("a section ends at the next same-level heading", () => {
    const p = parseDeferralSections(STRUCTURED);
    // "이 절은 대장 밖이다." lives under ## Review and must not become an assumption.
    expect(p.assumptions.some((a) => a.includes("대장 밖"))).toBe(false);
  });

  test("flat shape: bullets straight under the H2, no subsections", () => {
    const p = parseDeferralSections(`## Assumptions & Open Questions

- \`[assumption]\` 한 문장이 두 줄로
  줄바꿈되어도 하나의 전제다.
`);
    expect(p.rows).toEqual([]);
    expect(p.assumptions).toEqual(["한 문장이 두 줄로 줄바꿈되어도 하나의 전제다."]);
  });

  test("`None.` is an explicit nothing-open, distinct from no section at all", () => {
    const p = parseDeferralSections(`## Assumptions & Open Questions

None.
`);
    expect(p.rows).toEqual([]);
    expect(p.assumptions).toEqual([]);
    expect(p.declaredNone).toBe(true);
    // Both mandated subsections present and both empty still counts as declared.
    const q = parseDeferralSections(`## Assumptions & Open Questions

### Assumptions

None.

### Open questions

None.
`);
    expect(q.declaredNone).toBe(true);
  });

  test("bullet-shape open questions are items — a run may write no table at all", () => {
    // One real run wrote 24 sections and zero table rows, so a table-only read
    // reported "미결 0건" over 15 open questions. A bold `**OQ**`/`**AS**` id and the
    // `### Open questions` heading are both engine-written markers, so both classify.
    const p = parseDeferralSections(`## Assumptions & Open Questions

### Assumptions

- **AS1** 검사가 비동기로 분리 실행되므로 요청 처리 성능을 훼손하지 않는다.
- 태그도 id 도 없는 불릿은 전제가 아니다.

### Open questions

- **OQ1** 다중 선택 묶음을 하나의 논리 요청으로 다시 묶을지 — 이후 설계 [Q2f].
- id 가 없어도 이 절 안이면 미결이다.
`);
    expect(p.rows).toEqual([
      {
        item: "OQ1 다중 선택 묶음을 하나의 논리 요청으로 다시 묶을지 — 이후 설계 [Q2f].",
        assignment: "",
      },
      { item: "id 가 없어도 이 절 안이면 미결이다.", assignment: "" },
    ]);
    expect(p.assumptions).toEqual([
      "AS1 검사가 비동기로 분리 실행되므로 요청 처리 성능을 훼손하지 않는다.",
    ]);
  });

  test("flat `**OQ-xx**` bullets are items, and `[assumption]` still outranks the id", () => {
    // 9 of the flat bullets on that run carried an OQ id and no tag (invisible before);
    // 5 carried both, and those stay assumptions rather than being reclassified.
    const p = parseDeferralSections(`## Assumptions & Open Questions

- **OQ-US1** 판정기의 입력 자료 구조가 확정되지 않았다 [mob: quality].
- **OQ-DM1** 이력 항목의 표시 문자열이 미정이다. \`[assumption]\`
- 산문 불릿은 어느 쪽도 아니다.
`);
    expect(p.rows.map((r) => r.item)).toEqual([
      "OQ-US1 판정기의 입력 자료 구조가 확정되지 않았다 [mob: quality].",
    ]);
    expect(p.assumptions).toEqual(["**OQ-DM1** 이력 항목의 표시 문자열이 미정이다."]);
  });

  test("a `- None.` bullet is still a declaration of emptiness, not an item", () => {
    // Admitting it as a row invents a decision named "None." AND makes the section
    // non-empty, which suppresses the very declaration the engine was making.
    const p = parseDeferralSections(`## Assumptions & Open Questions

### Open questions

- None.
`);
    expect(p.rows).toEqual([]);
    expect(p.declaredNone).toBe(true);
  });

  test("a ledger id needs a digit — bold prose starting with AS/OQ is not an entry", () => {
    // `(OQ|AS)[-.A-Za-z0-9]*` case-insensitively swallowed ordinary bold-led prose
    // and invented one assumption per bullet. The engine numbers its ids.
    const p = parseDeferralSections(`## Assumptions & Open Questions

- **ASSUMPTIONS** 아래 목록은 참고용이다.
- **AS-IS** 흐름은 그대로 둔다.
- **Asset** 목록은 별도 문서에 있다.
`);
    expect(p.rows).toEqual([]);
    expect(p.assumptions).toEqual([]);
  });

  test("a no-owner rollup row carries no stage name — the model invents no label", () => {
    // `(${status})` used to stand in for a missing stage and reached the screen as a
    // row called `(unassigned)`, a raw enum name in a Korean UI. The scan layer must
    // not build display strings; the render layer owns the Korean labels.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-dfr-"));
    const stage = path.join(root, "inception", "requirements-analysis");
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(
      path.join(stage, "requirements.md"),
      `## Assumptions & Open Questions

### Open questions

| 항목 | 배정 |
| --- | --- |
| 오너가 있는 항목 | \`code-generation\` |
| 오너가 없는 항목 | 이후 설계에서 정한다 |
`,
    );
    try {
      const r = readDeferrals(root, {
        stageStatuses: new Map([["code-generation", ["active"] as StageInfo["status"][]]]),
      });
      expect(r.byOwner).toEqual([
        { stage: "code-generation", status: "current", count: 1 },
        { stage: undefined, status: "unassigned", count: 1 },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("a nested bullet is detail, not a separate decision", () => {
    const p = parseDeferralSections(`## Assumptions & Open Questions

### Open questions

- 인증 수단을 무엇으로 할지.
  - fakeLogin 은 후보에서 제외
  - 서비스 계정은 검토 중
`);
    expect(p.rows.map((r) => r.item)).toEqual(["인증 수단을 무엇으로 할지."]);
  });

  test("an ordered list is a list — the marker is not part of the contract", () => {
    const p = parseDeferralSections(`## Assumptions & Open Questions

### Open questions

1. 첫 미결.
2) 둘째 미결.
`);
    expect(p.rows.map((r) => r.item)).toEqual(["첫 미결.", "둘째 미결."]);
  });

  test("a table under ### Assumptions contributes no items", () => {
    const p = parseDeferralSections(`## Assumptions & Open Questions

### Assumptions

| 전제 | 근거 |
| --- | --- |
| 하나 | 없음 |
`);
    expect(p.rows).toEqual([]);
  });

  describe("owner resolution", () => {
    const statuses = (m: Record<string, StageInfo["status"][]>) => new Map(Object.entries(m));
    const catalog = new Set(["functional-design", "code-generation", "build-and-test", "operate"]);

    test("every occurrence done or skipped → passed", () => {
      const r = resolveOwner(
        "`functional-design`",
        statuses({ "functional-design": ["done", "skipped"] }),
        catalog,
      );
      expect(r).toEqual({ ownerStage: "functional-design", ownerStatus: "passed" });
    });

    test("any occurrence in flight → current, even beside a finished copy", () => {
      // A Construction slug repeats once per unit; one unit still working means the
      // question can still be asked, which is the safe direction to err in.
      const r = resolveOwner(
        "`code-generation`",
        statuses({ "code-generation": ["done", "active"] }),
        catalog,
      );
      expect(r).toEqual({ ownerStage: "code-generation", ownerStatus: "current" });
    });

    test("not started → ahead", () => {
      expect(
        resolveOwner("`build-and-test`", statuses({ "build-and-test": ["pending"] }), catalog),
      ).toEqual({ ownerStage: "build-and-test", ownerStatus: "ahead" });
    });

    test("in the catalogue but not in this run → outOfScope", () => {
      expect(resolveOwner("`build-and-test` (`C22`)", statuses({}), catalog)).toEqual({
        ownerStage: "build-and-test",
        ownerStatus: "outOfScope",
      });
    });

    test("a registry id is NOT a stage — never invent one", () => {
      // `NEW-...`, `P-1`, `[F5]`, `C22` are all registry ids that appear in real
      // 배정 cells. Only a slug the run or the catalogue knows becomes an owner.
      for (const cell of ["`NEW-헤더-목록`", "`P-1`·`P-2`", "`[F5]`", "`C22`", "외부 팀"]) {
        expect(resolveOwner(cell, statuses({ "code-generation": ["active"] }), catalog)).toEqual({
          ownerStatus: "unassigned",
        });
      }
    });

    test("explicitly pushed past this run → nextCycle", () => {
      for (const cell of ["다음 차수", "이후 차수 (`NEW-x`)", "next cycle"]) {
        expect(resolveOwner(cell, statuses({}), catalog).ownerStatus).toBe("nextCycle");
      }
    });

    test("without a catalogue an out-of-scope stage degrades to unassigned, not to a guess", () => {
      expect(resolveOwner("`build-and-test`", statuses({}), undefined)).toEqual({
        ownerStatus: "unassigned",
      });
    });
  });
});

describe("unit view", () => {
  const FLOOR = "WORKFLOW_STARTED:2026-01-01T00:00:00Z#1";
  const u = (
    ts: string,
    event: string,
    unit: string,
    stage = "cg",
    shard = "s.md",
    floor = FLOOR,
  ) =>
    ({
      ts,
      event,
      stage,
      unit,
      fields: { Stage: stage, Unit: unit, "Run floor": floor },
      shard,
    }) as AuditEvent;
  const ev = (ts: string, event: string, shard = "s.md") =>
    ({ ts, event, fields: {}, shard }) as AuditEvent;
  /** A record write Context-attributed to (stage, unit), as the audit parser leaves it. */
  const write = (ts: string, unit: string, stage = "cg", shard = "s.md") =>
    ({ ts, event: "ARTIFACT_CREATED", stage, unit, fields: {}, shard }) as AuditEvent;

  test("a pause splits a unit into segments, and the pause is not counted", () => {
    const spans = buildUnitSpans(
      [
        u("2026-01-01T00:00:00Z", "UNIT_STARTED", "A"),
        ev("2026-01-01T00:01:00Z", "ARTIFACT_UPDATED"),
        u("2026-01-01T00:02:00Z", "UNIT_PAUSED", "A"),
        u("2026-01-01T05:00:00Z", "UNIT_RESUMED", "A"),
        u("2026-01-01T05:03:00Z", "UNIT_COMPLETED", "A"),
      ],
      "2026-01-01T05:03:00Z",
    );
    expect(spans.length).toBe(1);
    expect(spans[0]?.segments.map((g) => g.endKind)).toEqual(["paused", "completed"]);
    expect(spans[0]?.elapsedSec).toBe(300);
    expect(spans[0]?.endKind).toBe("completed");
  });

  // Within one attempt the engine acknowledges a repeated start without a receipt; a
  // start under a new floor is a reopened attempt.
  test("a repeated start in one attempt is ignored; a start under a new floor supersedes", () => {
    const reopened = "GATE_REJECTED:2026-01-01T00:30:00Z#1";
    const spans = buildUnitSpans(
      [
        u("2026-01-01T00:00:00Z", "UNIT_STARTED", "A"),
        u("2026-01-01T00:10:00Z", "UNIT_STARTED", "A"),
        u("2026-01-01T00:30:00Z", "UNIT_STARTED", "A", "cg", "s.md", reopened),
        u("2026-01-01T00:20:00Z", "UNIT_SKIPPED", "B"),
        ev("2026-01-01T00:40:00Z", "ARTIFACT_UPDATED"),
      ],
      "2026-01-01T00:40:00Z",
    );
    const a = spans.find((x) => x.unit === "A")!;
    expect(a.segments.map((g) => [g.endKind, g.elapsedSec])).toEqual([
      ["superseded", 1800],
      ["in-flight", 600],
    ]);
    const b = spans.find((x) => x.unit === "B")!;
    expect(b.segments.map((g) => [g.endKind, g.elapsedSec])).toEqual([["skipped", 0]]);
  });

  test("a skip closes an open segment", () => {
    const spans = buildUnitSpans(
      [
        u("2026-01-01T00:00:00Z", "UNIT_STARTED", "A"),
        u("2026-01-01T00:05:00Z", "UNIT_SKIPPED", "A"),
      ],
      "2026-01-01T00:05:00Z",
    );
    expect(spans[0]?.segments.map((g) => [g.endKind, g.elapsedSec])).toEqual([["skipped", 300]]);
  });

  // Under team ownership another clone's unit runs in the same hours; its events are not
  // this unit's gaps.
  test("a segment's split reads only the shard that ran the unit", () => {
    const spans = buildUnitSpans(
      [
        u("2026-01-01T00:00:00Z", "UNIT_STARTED", "A", "cg", "a.md"),
        ev("2026-01-01T00:02:00Z", "ARTIFACT_UPDATED", "b.md"),
        ev("2026-01-01T00:04:00Z", "ARTIFACT_UPDATED", "b.md"),
        u("2026-01-01T00:30:00Z", "UNIT_COMPLETED", "A", "cg", "a.md"),
      ],
      "2026-01-01T00:30:00Z",
    );
    expect(spans[0]?.unknownSec).toBe(1800);
    expect(spans[0]?.observedSec).toBe(0);
  });

  // The row has to add up even where the running clone's events stop short of the end.
  test("time the running shard's events do not cover is unclassified, not lost", () => {
    const spans = buildUnitSpans(
      [
        u("2026-01-01T00:00:00Z", "UNIT_STARTED", "A", "cg", "a.md"),
        u("2026-01-01T00:20:00Z", "UNIT_COMPLETED", "A", "cg", "b.md"),
      ],
      "2026-01-01T00:20:00Z",
    );
    const g = spans[0]!;
    expect(g.elapsedSec).toBe(1200);
    expect(g.humanWaitSec + g.parkedSec + g.observedSec + g.conversationSec + g.unknownSec).toBe(
      1200,
    );
  });

  // The receipt-printing path writes both rows after the work; read literally, the unit
  // took 5 seconds.
  test("a start receipt written after the work starts at the pair's first record write", () => {
    const spans = buildUnitSpans(
      [
        u("2026-01-01T00:00:00Z", "UNIT_COMPLETED", "A", "fd"),
        write("2026-01-01T00:02:00Z", "A"),
        write("2026-01-01T00:03:00Z", "B", "cg", "other.md"), // another pair, another clone
        // A gate or decision names the pair but is not its work.
        {
          ...u("2026-01-01T00:01:00Z", "UNIT_PAUSED", "Z"),
          event: "PLAN_APPROVAL_RECORDED",
        } as AuditEvent,
        write("2026-01-01T00:20:00Z", "A"),
        u("2026-01-01T00:40:00Z", "UNIT_STARTED", "A"),
        u("2026-01-01T00:40:05Z", "UNIT_COMPLETED", "A"),
      ],
      "2026-01-01T00:40:05Z",
    );
    const a = spans.find((x) => x.stage === "cg" && x.unit === "A")!;
    expect(
      a.segments.map((g) => [g.startedAt, g.endedAt, g.startInferred, g.receiptStartedAt]),
    ).toEqual([["2026-01-01T00:02:00Z", "2026-01-01T00:40:05Z", true, "2026-01-01T00:40:00Z"]]);
    // A receipt that came first needs no inference.
    const plain = buildUnitSpans(
      [
        u("2026-01-01T00:00:00Z", "UNIT_STARTED", "A"),
        u("2026-01-01T00:05:00Z", "UNIT_COMPLETED", "A"),
      ],
      "2026-01-01T00:05:00Z",
    );
    expect(plain[0]?.segments[0]?.startInferred).toBeUndefined();
  });

  // A reopen is an attempt boundary: the old attempt's writes are not the new one's start.
  test("a write from before the receipt's run floor never moves a start", () => {
    const reopened = "GATE_REJECTED:2026-01-01T02:00:00Z#1";
    const spans = buildUnitSpans(
      [
        write("2026-01-01T01:00:00Z", "A"),
        u("2026-01-01T03:00:00Z", "UNIT_STARTED", "A", "cg", "s.md", reopened),
        u("2026-01-01T03:10:00Z", "UNIT_COMPLETED", "A", "cg", "s.md", reopened),
      ],
      "2026-01-01T03:10:00Z",
    );
    expect(spans[0]?.segments[0]?.startedAt).toBe("2026-01-01T03:00:00Z");
    expect(spans[0]?.segments[0]?.startInferred).toBeUndefined();
  });

  test("any lifecycle row clears pending writes, a completion with nothing open included", () => {
    const spans = buildUnitSpans(
      [
        write("2026-01-01T00:00:00Z", "A"),
        u("2026-01-01T00:05:00Z", "UNIT_COMPLETED", "A"), // completion-only, consumes the write
        u("2026-01-01T01:00:00Z", "UNIT_STARTED", "A"),
        u("2026-01-01T01:10:00Z", "UNIT_COMPLETED", "A"),
      ],
      "2026-01-01T01:10:00Z",
    );
    expect(spans[0]?.segments.map((g) => [g.startedAt, g.startInferred ?? false])).toEqual([
      ["2026-01-01T00:00:00Z", true],
      ["2026-01-01T01:00:00Z", false],
    ]);
  });

  // Two clones' rows in one second are causally unordered; the engine keeps each shard's
  // last row and then the safest one (PAUSED > STARTED/RESUMED > COMPLETED/SKIPPED,
  // `currentUnitLifecycleRows`). Both orderings are asserted — the merge puts shards in
  // listing order, so a one-direction fixture passes by luck of the shard names.
  test("cross-shard lifecycle rows in one second reduce by the engine's safety rank", () => {
    const at = "2026-01-01T00:30:00Z";
    const pair = (first: [string, string], second: [string, string]) =>
      buildUnitSpans(
        [
          u("2026-01-01T00:00:00Z", "UNIT_STARTED", "A", "cg", "a.md"),
          u(at, first[0], "A", "cg", first[1]),
          u(at, second[0], "A", "cg", second[1]),
        ],
        at,
      )[0]!;
    for (const span of [
      pair(["UNIT_COMPLETED", "a.md"], ["UNIT_PAUSED", "b.md"]),
      pair(["UNIT_PAUSED", "a.md"], ["UNIT_COMPLETED", "b.md"]),
    ]) {
      expect(span.segments.map((g) => [g.endKind, g.elapsedSec])).toEqual([["paused", 1800]]);
      expect(span.endKind).toBe("paused");
    }
    // A possible resume keeps the unit open; only unanimous terminal rows close it.
    for (const span of [
      pair(["UNIT_COMPLETED", "a.md"], ["UNIT_RESUMED", "b.md"]),
      pair(["UNIT_RESUMED", "a.md"], ["UNIT_COMPLETED", "b.md"]),
    ]) {
      expect(span.segments.map((g) => [g.endKind, g.elapsedSec])).toEqual([["in-flight", 1800]]);
    }
    const both = pair(["UNIT_COMPLETED", "a.md"], ["UNIT_COMPLETED", "b.md"]);
    expect(both.segments.map((g) => [g.endKind, g.elapsedSec])).toEqual([["completed", 1800]]);
    // A start that loses to another clone's pause leaves nothing open; the engine reads the
    // unit as paused, so it stays on screen as a tick rather than vanishing.
    const lost = buildUnitSpans(
      [u(at, "UNIT_STARTED", "A", "cg", "a.md"), u(at, "UNIT_PAUSED", "A", "cg", "b.md")],
      at,
    );
    expect(lost.map((x) => x.segments.map((g) => [g.endKind, g.elapsedSec]))).toEqual([
      [["paused", 0]],
    ]);
  });

  // One shard's rows are in append order, which IS causal — the reduction is for ties the
  // merge cannot order, so a receipt written in the second its work closed stays a segment.
  test("one shard's rows in one second keep their order", () => {
    const at = "2026-01-01T00:30:00Z";
    const spans = buildUnitSpans(
      [
        u("2026-01-01T00:00:00Z", "UNIT_STARTED", "A", "cg", "a.md"),
        u(at, "UNIT_PAUSED", "A", "cg", "a.md"),
        u(at, "UNIT_RESUMED", "A", "cg", "a.md"),
        u("2026-01-01T00:40:00Z", "UNIT_COMPLETED", "A", "cg", "a.md"),
      ],
      "2026-01-01T00:40:00Z",
    );
    expect(spans[0]?.segments.map((g) => [g.endKind, g.elapsedSec])).toEqual([
      ["paused", 1800],
      ["completed", 600],
    ]);
  });

  // The engine reduces only the current attempt's rows (it filters to the unit's `Run
  // floor` first), so a row of another attempt is never one of the candidates.
  test("rows of different attempts in one second are not one tie", () => {
    const at = "2026-01-01T00:30:00Z";
    const reopened = `GATE_REJECTED:${at}#1`;
    const spans = buildUnitSpans(
      [
        u("2026-01-01T00:00:00Z", "UNIT_STARTED", "A", "cg", "a.md"),
        u(at, "UNIT_PAUSED", "A", "cg", "a.md"),
        u(at, "UNIT_STARTED", "A", "cg", "b.md", reopened),
        u("2026-01-01T00:40:00Z", "UNIT_COMPLETED", "A", "cg", "b.md", reopened),
      ],
      "2026-01-01T00:40:00Z",
    );
    expect(spans[0]?.segments.map((g) => [g.endKind, g.elapsedSec])).toEqual([
      ["paused", 1800],
      ["completed", 600],
    ]);
  });

  // A wave or recovery completion writes UNIT_COMPLETED with no start receipt.
  test("a completion with no start stays visible, with an unknown duration when nothing was written", () => {
    const spans = buildUnitSpans(
      [u("2026-01-01T00:05:00Z", "UNIT_COMPLETED", "A")],
      "2026-01-01T00:05:00Z",
    );
    expect(spans.length).toBe(1);
    expect(spans[0]?.segments[0]?.durationUnknown).toBe(true);
    expect(spans[0]?.endKind).toBe("completed");
  });

  test("buildTiming carries the unit view, and a run with no unit rows has none", () => {
    const events = [
      { ...ev("2026-01-01T00:00:00Z", "STAGE_STARTED"), stage: "cg", fields: { Stage: "cg" } },
      u("2026-01-01T00:01:00Z", "UNIT_STARTED", "A"),
      u("2026-01-01T00:04:00Z", "UNIT_COMPLETED", "A"),
    ] as AuditEvent[];
    expect(buildTiming({ events, counts: new Map(), shards: [] }).units.length).toBe(1);
    expect(
      buildTiming({ events: events.slice(0, 1), counts: new Map(), shards: [] }).units,
    ).toEqual([]);
  });
});

describe("time bins", () => {
  const ev = (ts: string, event: string, shard = "s"): AuditEvent => ({
    ts,
    event,
    fields: {},
    shard,
  });
  // Local wall-clock times, so bin boundaries (local 00/06/12/18) are exact on any TZ.
  const local = (h: number, min = 0) => new Date(2026, 0, 1, h, min, 0).toISOString();
  const FIELDS = [
    "humanWaitSec",
    "parkedSec",
    "observedSec",
    "conversationSec",
    "unknownSec",
  ] as const;

  test("each bucket summed over the bins equals that bucket in total — a re-cut, not a re-count", () => {
    const events = [
      ev(local(1), "WORKFLOW_STARTED"),
      ev(local(1, 2), "ARTIFACT_CREATED"),
      { ...ev(local(1, 4), "STAGE_AWAITING_APPROVAL"), fields: { Stage: "rv" } },
      { ...ev(local(7), "GATE_APPROVED"), fields: { Stage: "rv" } },
      ev(local(7, 1), "HUMAN_TURN"),
      ev(local(7, 30), "HUMAN_TURN"),
      ev(local(8), "WORKFLOW_PARKED"),
      ev(local(20), "WORKFLOW_UNPARKED"),
      ev(local(21), "SENSOR_PASSED"),
    ];
    const t = buildTiming({ events, counts: new Map(), shards: ["s"] }, local(23));
    expect(t.bins.length).toBeGreaterThan(2);
    for (const f of FIELDS) {
      expect(t.bins.reduce((n, b) => n + b[f], 0)).toBeCloseTo(t.total[f], 6);
    }
    // Every bucket is exercised, so the sum check is not vacuous on any of them.
    for (const f of FIELDS) expect(t.total[f]).toBeGreaterThan(0);
  });

  test("a gap crossing a bin edge is split by overlap, not dropped into the bin it starts in", () => {
    const bins = buildBins(
      [{ from: local(4), to: local(10), bucket: "parked" }],
      local(4),
      local(10),
    );
    expect(bins.map((b) => b.start)).toEqual([local(0), local(6)]);
    expect(bins[0]!.parkedSec).toBe(2 * 3600);
    expect(bins[1]!.parkedSec).toBe(4 * 3600);
    expect(BIN_SEC).toBe(6 * 3600);
  });

  test("bins stop at the last event; the silence after it is carried by sinceLastEventSec", () => {
    const events = [ev(local(1), "WORKFLOW_STARTED"), ev(local(1, 3), "ARTIFACT_CREATED")];
    const t = buildTiming({ events, counts: new Map(), shards: ["s"] }, local(23));
    // The window reaches the read clock…
    expect(t.sinceLastEventSec).toBe(22 * 3600 - 180);
    // …but bins cover only what was recorded, so a long-silent tree is not squeezed
    // into one edge of its chart by hundreds of empty bins.
    expect(t.bins.length).toBe(1);
    expect(t.bins[0]!.observedSec).toBe(180);
  });

  test("an empty ledger has no bins", () => {
    expect(buildTiming({ events: [], counts: new Map(), shards: [] }).bins).toEqual([]);
  });
});
