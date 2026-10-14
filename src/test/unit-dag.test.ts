// The unit roster is resolved the way the engine resolves it (`resolveBoltDag`): the
// authored `unit-of-work-dependency.md` is authoritative whenever it exists, and the
// runtime graph's `bolt_dag` is only a cache that must still match it.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { esc } from "../render/common";
import { strings } from "../render/i18n";
import { renderBody } from "../render/page";
import { resolveUnitDag } from "../scan/unit-dag";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const RECORD = "aidlc/spaces/default/intents/260101-demo-migration";
const DEP = "inception/units-generation/unit-of-work-dependency.md";
const EN = strings("en");

const yaml = (units: string) => `# Unit of Work Dependency\n\n\`\`\`yaml\nunits:\n${units}\`\`\`\n`;
const graph = (dag: unknown) => JSON.stringify({ stages: [], bolt_dag: dag });

/** A bare record dir holding only the two files the resolver reads. */
const record = (files: { dep?: string; graph?: string }, fn: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-dag-"));
  try {
    if (files.dep !== undefined) {
      fs.mkdirSync(path.join(dir, path.dirname(DEP)), { recursive: true });
      fs.writeFileSync(path.join(dir, DEP), files.dep);
    }
    if (files.graph !== undefined)
      fs.writeFileSync(path.join(dir, "runtime-graph.json"), files.graph);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const GRAPH_AB = graph({
  units: [
    { name: "a", depends_on: [], kind: "library" },
    { name: "b", depends_on: ["a"], kind: "ui" },
  ],
  batches: [["a"], ["b"]],
});
const DEP_AB = yaml(
  "  - name: a\n    depends_on: []\n    kind: library\n  - name: b\n    depends_on: [a]\n    kind: ui\n",
);

describe("resolveUnitDag — the engine's resolveBoltDag", () => {
  test("no authored file: the graph's cache is the roster", () => {
    record({ graph: GRAPH_AB }, (dir) => {
      const r = resolveUnitDag(dir);
      expect(r.state).toBe("ok");
      if (r.state !== "ok") return;
      expect(r.units).toEqual(["a", "b"]);
      expect(r.healed).toBe(false);
      expect(r.unitKinds?.get("b")).toBe("ui");
    });
  });

  test("neither file: none", () => {
    record({}, (dir) => expect(resolveUnitDag(dir)).toEqual({ state: "none" }));
  });

  test("a matching authored file keeps the cache (healed: false)", () => {
    record({ graph: GRAPH_AB, dep: DEP_AB }, (dir) => {
      const r = resolveUnitDag(dir);
      expect(r.state === "ok" && r.healed).toBe(false);
      expect(r.state === "ok" && r.graphDiffers).toBe(false);
    });
  });

  test("an authored file the cache no longer matches wins (a unit added after the compile)", () => {
    const dep = yaml(
      "  - name: a\n    depends_on: []\n  - name: b\n    depends_on: [a]\n  - name: c\n    depends_on: []\n",
    );
    record({ graph: GRAPH_AB, dep }, (dir) => {
      const r = resolveUnitDag(dir);
      expect(r.state).toBe("ok");
      if (r.state !== "ok") return;
      expect(r.batches).toEqual([["a", "c"], ["b"]]);
      expect(r.units).toEqual(["a", "c", "b"]);
      expect(r.healed).toBe(true);
      expect(r.graphDiffers).toBe(true);
      // Kinds are compared too: the authored file dropped them, so the cache is stale.
      expect(r.unitKinds).toBeNull();
    });
  });

  test("an authored file with no yaml units block is malformed, even beside a good cache", () => {
    record({ graph: GRAPH_AB, dep: "# Unit of Work Dependency\n\nPU-A then PU-B.\n" }, (dir) => {
      const r = resolveUnitDag(dir);
      expect(r.state).toBe("malformed");
      expect(r.state === "malformed" && r.reason).toBe("absent");
    });
  });

  test("a cyclic or dangling DAG is malformed with the engine's reason", () => {
    const cyc = yaml("  - name: a\n    depends_on: [b]\n  - name: b\n    depends_on: [a]\n");
    record({ dep: cyc }, (dir) => {
      const r = resolveUnitDag(dir);
      expect(r.state === "malformed" && r.reason).toBe("cyclic");
    });
    const dangling = yaml("  - name: a\n    depends_on: [zz]\n");
    record({ dep: dangling }, (dir) => {
      const r = resolveUnitDag(dir);
      expect(r.state === "malformed" && r.reason).toBe("malformed");
    });
  });

  test("an authored path that cannot be read is malformed (unreadable), not absent", () => {
    record({ graph: GRAPH_AB }, (dir) => {
      fs.mkdirSync(path.join(dir, DEP), { recursive: true }); // a directory where the file goes
      const r = resolveUnitDag(dir);
      expect(r.state === "malformed" && r.reason).toBe("unreadable");
    });
  });

  test("a cache without valid batches is no cache: units[] alone is not a roster", () => {
    const noBatches = graph({ units: [{ name: "a", depends_on: [] }] });
    record({ graph: noBatches }, (dir) => expect(resolveUnitDag(dir)).toEqual({ state: "none" }));
    const badName = graph({ units: [], batches: [["a b"]] });
    record({ graph: badName }, (dir) => expect(resolveUnitDag(dir)).toEqual({ state: "none" }));
    const dup = graph({ units: [], batches: [["a"], ["a"]] });
    record({ graph: dup }, (dir) => expect(resolveUnitDag(dir)).toEqual({ state: "none" }));
  });

  test("roster order is the batches', not bolt_dag.units' (the compiler writes authored order)", () => {
    const g = graph({
      units: [
        { name: "b", depends_on: ["a"] },
        { name: "a", depends_on: [] },
      ],
      batches: [["a"], ["b"]],
    });
    record({ graph: g }, (dir) => {
      const r = resolveUnitDag(dir);
      expect(r.state === "ok" && r.units).toEqual(["a", "b"]);
    });
  });
});

describe("the page reads the resolved roster", () => {
  const withFixture = (edit: (record: string) => void, fn: (root: string) => void) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-dag-page-"));
    try {
      fs.cpSync(FIXTURE, root, { recursive: true });
      edit(path.join(root, RECORD));
      fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  test("the fixture's authored DAG matches its graph: matrix as before, no warning", () => {
    const m = assemble(FIXTURE);
    expect(m.matrix?.units.map((u) => u.name)).toEqual(["PU-A-core", "PU-B-ui"]);
    expect(m.unitDag).toEqual({ state: "ok", healed: false, graphDiffers: false });
    expect(m.warnings.map((w) => w.code)).not.toContain("unit-dag-malformed");
  });

  test("a malformed authored DAG withholds the matrix and names the reason", () => {
    withFixture(
      (rec) => fs.writeFileSync(path.join(rec, DEP), "# Unit of Work Dependency\n\nNo block.\n"),
      (root) => {
        const m = assemble(root);
        expect(m.matrix).toBeUndefined();
        expect(m.unitDag.state).toBe("malformed");
        const w = m.warnings.find((x) => x.code === "unit-dag-malformed");
        expect(w).toBeDefined();
        const html = renderBody(m, "en");
        expect(html).toContain(esc(EN.overview.unitDagMalformed("absent", "construction")));
        expect(html).not.toContain(EN.overview.noUnits);
      },
    );
  });

  test("while Units Generation is still open, an unreadable block is not yet a stop", () => {
    withFixture(
      (rec) => {
        fs.writeFileSync(path.join(rec, DEP), "# Unit of Work Dependency\n\nStill writing.\n");
        const sp = path.join(rec, "aidlc-state.md");
        fs.writeFileSync(
          sp,
          fs.readFileSync(sp, "utf-8").replace("- [x] units-generation", "- [-] units-generation"),
        );
      },
      (root) => {
        const m = assemble(root);
        expect(m.matrix).toBeUndefined();
        expect(m.unitDag.state === "malformed" && m.unitDag.stop).toBe("units-generation-gate");
        const html = renderBody(m, "en");
        expect(html).toContain(esc(EN.overview.unitDagMalformedPill("units-generation-gate")));
        expect(html).not.toContain(`>${EN.overview.unitDagMalformedPill("construction")}<`);
      },
    );
  });

  test("an authored unit the graph has not caught up with gets its column", () => {
    withFixture(
      (rec) =>
        fs.writeFileSync(
          path.join(rec, DEP),
          yaml(
            "  - name: PU-A-core\n    depends_on: []\n    kind: library\n" +
              "  - name: PU-B-ui\n    depends_on: [PU-A-core]\n    kind: ui\n" +
              "  - name: PU-C-api\n    depends_on: [PU-A-core]\n    kind: service\n",
          ),
        ),
      (root) => {
        const m = assemble(root);
        expect(m.matrix?.units.map((u) => u.name)).toEqual(["PU-A-core", "PU-B-ui", "PU-C-api"]);
        expect(m.matrix?.units.find((u) => u.name === "PU-C-api")?.kind).toBe("service");
        expect(m.unitDag).toEqual({ state: "ok", healed: true, graphDiffers: true });
        expect(renderBody(m, "en")).toContain(esc(EN.overview.unitDagHealed));
      },
    );
  });
});

describe("the run position checks the unit cache against the resolved roster", () => {
  const STATE = "aidlc-state.md";
  const withUnitCache = (unit: string, dep: string | undefined, fn: (root: string) => void) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-dag-pos-"));
    try {
      fs.cpSync(FIXTURE, root, { recursive: true });
      const rec = path.join(root, RECORD);
      const sp = path.join(rec, STATE);
      fs.writeFileSync(
        sp,
        fs
          .readFileSync(sp, "utf-8")
          .replace(
            "## Runtime State\n",
            `## Runtime State\n- **Unit Stage**: code-generation\n- **Active Unit**: ${unit}\n`,
          ),
      );
      if (dep !== undefined) fs.writeFileSync(path.join(rec, DEP), dep);
      fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  test("an Active Unit the roster has is read as before", () => {
    withUnitCache("PU-B-ui", undefined, (root) => {
      const p = assemble(root).waits.position;
      expect(p.unit).toBe("PU-B-ui");
      expect(p.verified).toBe(true);
      expect(p.offRoster).toBeUndefined();
    });
  });

  test("an Active Unit the authored DAG no longer lists is not a verified position", () => {
    const dep = yaml("  - name: PU-A-core\n    depends_on: []\n    kind: library\n");
    withUnitCache("PU-B-ui", dep, (root) => {
      const m = assemble(root);
      expect(m.waits.position.verified).toBe(false);
      expect(m.waits.position.offRoster).toBe("absent");
      expect(renderBody(m, "en")).toContain(esc(EN.status.runOffRoster("PU-B-ui", "absent")));
    });
  });

  test("with the roster unreadable, a cached unit cannot be checked either", () => {
    withUnitCache("PU-B-ui", "# Unit of Work Dependency\n\nNo block.\n", (root) => {
      const p = assemble(root).waits.position;
      expect(p.verified).toBe(false);
      expect(p.offRoster).toBe("unknown");
    });
  });
});

describe("## Unit Progress is checked against the roster the engine rebuilds it from", () => {
  const TEAM = "\n- **Unit Ownership**: team\n- **Construction Iteration**: unit-major";
  const TABLE =
    "\n## Unit Progress\n\n| unit | owner | code-generation | gate |\n| --- | --- | --- | --- |\n" +
    "| PU-A-core | jiho | [x] | [x] |\n| PU-B-ui | - | [-] | [ ] |\n";
  const withTeam = (dep: string | undefined, fn: (root: string) => void) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-dag-up-"));
    try {
      fs.cpSync(FIXTURE, root, { recursive: true });
      const rec = path.join(root, RECORD);
      const sp = path.join(rec, "aidlc-state.md");
      const base = fs.readFileSync(sp, "utf-8");
      fs.writeFileSync(
        sp,
        base.replace("- **State Version**: 8", `- **State Version**: 8${TEAM}`) + TABLE,
      );
      if (dep !== undefined) fs.writeFileSync(path.join(rec, DEP), dep);
      fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  test("a table matching the roster renders as before", () => {
    withTeam(undefined, (root) => {
      const m = assemble(root);
      expect(m.state.unitProgress?.rows.length).toBe(2);
      expect(m.unitProgressStale).toBeUndefined();
    });
  });

  test("a table naming units the roster lost, or missing one it gained, is a past projection", () => {
    const dep = yaml(
      "  - name: PU-A-core\n    depends_on: []\n    kind: library\n  - name: PU-C-api\n    depends_on: [PU-A-core]\n",
    );
    withTeam(dep, (root) => {
      const m = assemble(root);
      expect(m.unitProgressStale).toEqual({
        kind: "roster",
        missing: ["PU-C-api"],
        extra: ["PU-B-ui"],
      });
      expect(renderBody(m, "en")).toContain(
        esc(EN.overview.unitProgressStaleRoster(["PU-C-api"], ["PU-B-ui"])),
      );
    });
  });

  test("with the roster unreadable the engine cannot rebuild the table, and the page says so", () => {
    withTeam("# Unit of Work Dependency\n\nNo block.\n", (root) => {
      const m = assemble(root);
      expect(m.unitProgressStale).toEqual({ kind: "dag-unreadable" });
      expect(renderBody(m, "en")).toContain(esc(EN.overview.unitProgressStaleDag));
    });
  });
});
