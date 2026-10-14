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
    const notes = readCheckpointProofs(rec, ["PU-A", "PU-B"], undefined);
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
    const notes = readCheckpointProofs(rec, ["PU-A", "PU-B"], undefined);
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
    const notes = readCheckpointProofs(rec, ["PU-A", "PU-B", "PU-C", "PU-D", "PU-E"], undefined);
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
    const notes = readCheckpointProofs(rec, ["PU-A"], undefined);
    expect(notes.map((n) => [n.state, n.state === "unreadable" ? n.cause : null])).toEqual([
      ["unreadable", "link"],
    ]);
  });

  test("the engine reads one kind per unit: the skeleton for the first unit when it is on", () => {
    expect([...checkpointKinds("on", ["PU-A", "PU-B"])]).toEqual([
      ["PU-A", ["skeleton"]],
      ["PU-B", ["unit"]],
    ]);
    expect([...checkpointKinds("off", ["PU-A"])]).toEqual([["PU-A", ["unit"]]]);
    expect([...checkpointKinds(undefined, ["PU-A"])]).toEqual([["PU-A", ["unit"]]]);
    // `scope-dependent` asks the scope file, which this reader does not load.
    expect([...checkpointKinds("scope-dependent", ["PU-A", "PU-B"])]).toEqual([
      ["PU-A", ["skeleton", "unit"]],
      ["PU-B", ["unit"]],
    ]);
    // A stale unit-kind proof of the skeleton unit is a file the engine never reads.
    const rec = record({
      "PU-A/unit.json": proof({ verified: false, exit_code: 1 }),
      "PU-A/skeleton.json": proof({ kind: "skeleton" }),
    });
    expect(readCheckpointProofs(rec, ["PU-A"], "on")).toEqual([]);
    const undetermined = readCheckpointProofs(rec, ["PU-A"], "scope-dependent");
    expect(undetermined.map((n) => [n.kind, n.state, n.kindUndetermined])).toEqual([
      ["unit", "failed", true],
    ]);
  });

  test("no proof dir, or no file for a unit, is nothing to say", () => {
    const rec = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-none-"));
    expect(readCheckpointProofs(rec, ["PU-A"], undefined)).toEqual([]);
  });
});

describe("checkpoint proofs on the page", () => {
  const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
  const REC = "aidlc/spaces/default/intents/260101-demo-migration";

  function tree(checkpoints: boolean): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-page-"));
    fs.cpSync(FIXTURE, root, { recursive: true });
    // `constructionCheckpointsApply` needs a per-unit stage that writes code.
    const graphPath = path.join(root, ".kiro/tools/data/stage-graph.json");
    const graph = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
    for (const st of graph.stages ?? graph) {
      if (st.slug === "code-generation") st.workspace_requires = true;
    }
    fs.writeFileSync(graphPath, JSON.stringify(graph));
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
});
