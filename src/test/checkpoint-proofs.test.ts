// Construction checkpoint proofs (`<record>/.aidlc-construction-checkpoints/<unit>/<kind>.json`),
// read the way 2.11.0's `readProof` reads them, and judged only on the proof-level checks
// of `verifiedWith` — the part that decides "not verified" without the fingerprint.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { strings } from "../render/i18n";
import { renderOverview } from "../render/overview";
import { checkpointKinds, readCheckpointProofs } from "../scan/checkpoint-proofs";

const HEX = "a".repeat(64);
function proof(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 4,
    id: "7ddc62ff-d8a2-4c45-b9cd-f4670bb01260",
    kind: "unit",
    unit: "PU-A",
    fingerprint: "sha256:x",
    command_sha256: HEX,
    command_label: "bun test",
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:00:05.000Z",
    exit_code: 0,
    signal: null,
    error: null,
    stdout_bytes: 10,
    stderr_bytes: 0,
    stdout_sha256: HEX,
    stderr_sha256: HEX,
    stdout_tail: "ok",
    stderr_tail: "",
    evidence_unchanged: true,
    verified: true,
    ...over,
  };
}

function record(files: Record<string, unknown>): string {
  const rec = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(rec, ".aidlc-construction-checkpoints", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  }
  return rec;
}

describe("checkpoint proofs", () => {
  test("a failed verification is reported with what failed; a pass says nothing", () => {
    const rec = record({
      "PU-A/unit.json": proof({ exit_code: 1, verified: false, stderr_tail: "1 failed" }),
      "PU-B/unit.json": proof({ unit: "PU-B" }),
    });
    const notes = readCheckpointProofs(rec, ["PU-A", "PU-B"], undefined, "PU-A");
    expect(notes.map((n) => [n.unit, n.kind, n.state])).toEqual([["PU-A", "unit", "failed"]]);
    const n = notes[0]!;
    if (n.state !== "failed") throw new Error("expected failed");
    expect(n.faults).toEqual(["not-verified", "exit-code"]);
    expect([n.exitCode, n.stderrTail, n.rel]).toEqual([
      1,
      "1 failed",
      ".aidlc-construction-checkpoints/PU-A/unit.json",
    ]);
  });

  test("a proof that says verified but whose own fields contradict it is not verified", () => {
    // `verifiedWith` asks every one of these of the file, before any fingerprint.
    const rec = record({
      "PU-A/unit.json": proof({ signal: "SIGKILL", finished_at: null }),
      "PU-B/unit.json": proof({ unit: "PU-A" }),
    });
    const notes = readCheckpointProofs(rec, ["PU-A", "PU-B"], undefined, "PU-A");
    expect(notes.map((n) => (n.state === "failed" ? n.faults : n.state))).toEqual([
      ["signal", "unfinished"],
      ["wrong-unit"],
    ]);
  });

  test("a file readProof rejects is malformed; one it cannot open is unreadable", () => {
    const rec = record({
      "PU-A/unit.json": "{not json",
      "PU-B/unit.json": proof({ unit: "PU-B", version: 3 }),
      "PU-C/unit.json": proof({ unit: "PU-C", command_label: "a\nb" }),
    });
    fs.mkdirSync(path.join(rec, ".aidlc-construction-checkpoints/PU-D/unit.json"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(rec, ".aidlc-construction-checkpoints/PU-E"), { recursive: true });
    fs.writeFileSync(path.join(rec, "elsewhere.json"), JSON.stringify(proof({ unit: "PU-E" })));
    fs.symlinkSync(
      path.join(rec, "elsewhere.json"),
      path.join(rec, ".aidlc-construction-checkpoints/PU-E/unit.json"),
    );
    const notes = readCheckpointProofs(
      rec,
      ["PU-A", "PU-B", "PU-C", "PU-D", "PU-E"],
      undefined,
      "PU-A",
    );
    expect(notes.map((n) => [n.unit, n.state, n.state === "unreadable" ? n.cause : null])).toEqual([
      ["PU-A", "malformed", null],
      ["PU-B", "malformed", null],
      ["PU-C", "malformed", null],
      ["PU-D", "unreadable", "not-file"],
      ["PU-E", "unreadable", "link"],
    ]);
  });

  test("a linked checkpoint dir is refused like a linked file", () => {
    const rec = record({});
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-real-"));
    fs.mkdirSync(path.join(real, "PU-A"));
    fs.writeFileSync(path.join(real, "PU-A/unit.json"), JSON.stringify(proof({ verified: false })));
    fs.symlinkSync(real, path.join(rec, ".aidlc-construction-checkpoints"));
    const notes = readCheckpointProofs(rec, ["PU-A"], undefined, "PU-A");
    expect(notes.map((n) => [n.state, n.state === "unreadable" ? n.cause : null])).toEqual([
      ["unreadable", "link"],
    ]);
  });

  test("the engine reads one kind per unit: the skeleton for its unit when it is on", () => {
    expect([...checkpointKinds("on", ["PU-A", "PU-B"], "PU-A")]).toEqual([
      ["PU-A", ["skeleton"]],
      ["PU-B", ["unit"]],
    ]);
    expect([...checkpointKinds("off", ["PU-A"], "PU-A")]).toEqual([["PU-A", ["unit"]]]);
    expect([...checkpointKinds(undefined, ["PU-A"], "PU-A")]).toEqual([["PU-A", ["unit"]]]);
    // `scope-dependent` asks the scope file, which this reader does not load.
    expect([...checkpointKinds("scope-dependent", ["PU-A", "PU-B"], "PU-A")]).toEqual([
      ["PU-A", ["skeleton", "unit"]],
      ["PU-B", ["unit"]],
    ]);
    // No batches: which unit is the skeleton's is unknown, so every kind is open.
    expect([...checkpointKinds("on", ["PU-A", "PU-B"], undefined)]).toEqual([
      ["PU-A", ["skeleton", "unit"]],
      ["PU-B", ["skeleton", "unit"]],
    ]);
    // A stale unit-kind proof of the skeleton unit is a file the engine never reads.
    const rec = record({
      "PU-A/unit.json": proof({ verified: false, exit_code: 1 }),
      "PU-A/skeleton.json": proof({ kind: "skeleton" }),
    });
    expect(readCheckpointProofs(rec, ["PU-A"], "on", "PU-A")).toEqual([]);
    const undetermined = readCheckpointProofs(rec, ["PU-A"], "scope-dependent", "PU-A");
    expect(undetermined.map((n) => [n.kind, n.state, n.kindUndetermined, n.definite])).toEqual([
      ["unit", "failed", true, false],
    ]);
  });

  test("no proof dir, or no file for a unit, is nothing to say", () => {
    const rec = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-none-"));
    expect(readCheckpointProofs(rec, ["PU-A"], undefined, "PU-A")).toEqual([]);
  });
});

describe("checkpoint proofs on the page", () => {
  const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
  const REC = "aidlc/spaces/default/intents/260101-demo-migration";

  function tree(checkpoints: boolean, edit: (state: string) => string = (x) => x): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-page-"));
    fs.cpSync(FIXTURE, root, { recursive: true });
    // `constructionCheckpointsApply` needs a per-unit stage that writes code.
    const graphPath = path.join(root, ".kiro/tools/data/stage-graph.json");
    const graph = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
    for (const st of graph.stages ?? graph) {
      if (st.slug === "code-generation") st.workspace_requires = true;
    }
    fs.writeFileSync(graphPath, JSON.stringify(graph));
    // The scope must be one the engine knows (`unitMajorConstructionStageSlugs`).
    fs.writeFileSync(
      path.join(root, ".kiro/tools/data/scope-grid.json"),
      JSON.stringify({
        "demo-migration": {
          stages: {
            "units-generation": "EXECUTE",
            "functional-design": "EXECUTE",
            "code-generation": "EXECUTE",
          },
        },
      }),
    );
    const sp = path.join(root, REC, "aidlc-state.md");
    if (checkpoints) {
      fs.writeFileSync(
        sp,
        fs
          .readFileSync(sp, "utf-8")
          .replace(
            "- **State Version**: 8",
            "- **State Version**: 8\n- **Construction Checkpoints**: enabled",
          ),
      );
    }
    fs.writeFileSync(sp, edit(fs.readFileSync(sp, "utf-8")));
    const p = path.join(root, REC, ".aidlc-construction-checkpoints/PU-A-core/unit.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify(proof({ unit: "PU-A-core", verified: false, exit_code: 2 })),
    );
    return root;
  }

  test("a failed proof is shown under the matrix, as a diagnostic, not a wait", () => {
    const m = assemble(tree(true));
    expect(m.checkpointProofs?.map((n) => [n.unit, n.state])).toEqual([["PU-A-core", "failed"]]);
    const html = renderOverview(m, strings("en"));
    expect(html).toContain("PU-A-core");
    expect(html).toContain("exit 2");
    // Uncounted: the engine routes this back to the agent (verify again), not to a person.
    expect(JSON.stringify(m.waits)).not.toContain("construction-checkpoints");
  });

  test("without checkpoints in force the engine never reads the file, and neither do we", () => {
    expect(assemble(tree(false)).checkpointProofs ?? []).toEqual([]);
  });

  test("a scope the grid does not know is not one the engine resolves checkpoints for", () => {
    const m = assemble(
      tree(true, (st) => st.replace("- **Scope**: demo-migration", "- **Scope**: other")),
    );
    expect(m.checkpointProofs ?? []).toEqual([]);
  });

  test("stage-level per-unit artifacts (units-generation not run) have no unit checkpoint", () => {
    // `usesStageLevelPerUnitArtifacts`: Units Generation not EXECUTE and not completed.
    const m = assemble(
      tree(true, (st) =>
        st.replace("- [x] units-generation — EXECUTE", "- [ ] units-generation — SKIP"),
      ),
    );
    expect(m.checkpointProofs ?? []).toEqual([]);
  });

  test("the claim does not say the agent must verify, nor that an approval is gone", () => {
    // `approvalKeptOverScopeChange` can keep `approved` with `verified` false, and the
    // verification command may itself wait on a person.
    const html = renderOverview(assemble(tree(true)), strings("en"));
    expect(html).not.toContain("the next move is the agent");
    expect(html).toContain("new approval");
  });
});

describe("checkpoint proofs — what a note this reader cannot settle claims", () => {
  test("an undetermined kind gets the ? and never the engine-verdict sentence", () => {
    const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
    const REC = "aidlc/spaces/default/intents/260101-demo-migration";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-open-"));
    fs.cpSync(FIXTURE, root, { recursive: true });
    const graphPath = path.join(root, ".kiro/tools/data/stage-graph.json");
    const graph = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
    for (const st of graph) if (st.slug === "code-generation") st.workspace_requires = true;
    fs.writeFileSync(graphPath, JSON.stringify(graph));
    fs.writeFileSync(
      path.join(root, ".kiro/tools/data/scope-grid.json"),
      JSON.stringify({ "demo-migration": { stages: { "code-generation": "EXECUTE" } } }),
    );
    const sp = path.join(root, REC, "aidlc-state.md");
    fs.writeFileSync(
      sp,
      fs
        .readFileSync(sp, "utf-8")
        .replace(
          "- **State Version**: 8",
          "- **State Version**: 8\n- **Construction Checkpoints**: enabled\n- **Skeleton Stance**: scope-dependent",
        ),
    );
    const p = path.join(root, REC, ".aidlc-construction-checkpoints/PU-A-core/unit.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify(proof({ unit: "PU-A-core", verified: false, exit_code: 2 })),
    );
    const m = assemble(root);
    expect(m.checkpointProofs?.map((n) => [n.unit, n.definite])).toEqual([["PU-A-core", false]]);
    const html = renderOverview(m, strings("en"));
    expect(html).toContain("<li>? ");
    expect(html).not.toContain("new approval");
  });
});

describe("checkpoint proofs — Codex review", () => {
  test("the skeleton unit is the first of the batches, not of the roster", () => {
    // `approvedConstructionUnits`: `dag.batches.flat()[0]`; routing: `resolution.batches.flat()`.
    const rec = record({
      "PU-A/skeleton.json": proof({ kind: "skeleton" }),
      "PU-B/unit.json": proof({ unit: "PU-B" }),
      "PU-A/unit.json": proof({ verified: false, exit_code: 1 }),
      "PU-B/skeleton.json": proof({ unit: "PU-B", kind: "skeleton", verified: false }),
    });
    expect(readCheckpointProofs(rec, ["PU-B", "PU-A"], "on", "PU-A")).toEqual([]);
  });

  test("a note this reader cannot settle says so instead of claiming the engine's verdict", () => {
    const rec = record({
      "PU-A/unit.json": proof({ verified: false, exit_code: 1 }),
      "PU-B/unit.json": proof({ unit: "PU-B", padding: "x".repeat(1024 * 1024 + 10) }),
    });
    const notes = readCheckpointProofs(rec, ["PU-A", "PU-B"], "scope-dependent", "PU-A");
    expect(notes.map((n) => [n.unit, n.state, n.definite])).toEqual([
      ["PU-A", "failed", false],
      ["PU-B", "unreadable", false],
    ]);
  });

  test("a hardlinked proof is refused, as the engine refuses it", () => {
    const rec = record({ "PU-A/unit.json": proof() });
    fs.linkSync(
      path.join(rec, ".aidlc-construction-checkpoints/PU-A/unit.json"),
      path.join(rec, "alias.json"),
    );
    const notes = readCheckpointProofs(rec, ["PU-A"], undefined, "PU-A");
    expect(
      notes.map((n) => [n.state, n.state === "unreadable" ? n.cause : null, n.definite]),
    ).toEqual([["unreadable", "hardlink", true]]);
  });

  // POSIX only. The engine's error here is ENOTDIR; Windows reports a path through a file
  // as ENOENT, which `readProof` itself takes for "no proof" — so we read absence there too.
  test.skipIf(process.platform === "win32")(
    "a checkpoint dir that is a file is an error to the engine, not an absence",
    () => {
      const rec = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-notdir-"));
      fs.writeFileSync(path.join(rec, ".aidlc-construction-checkpoints"), "x");
      const notes = readCheckpointProofs(rec, ["PU-A"], undefined, "PU-A");
      expect(notes.map((n) => [n.state, n.state === "unreadable" ? n.cause : null])).toEqual([
        ["unreadable", "read-failed"],
      ]);
    },
  );
});
