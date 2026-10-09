// Where the run is (scan/run-position.ts) and whether its gate is open
// (scan/gate-wait.ts). Both transcribe engine functions, so the expectations below
// that carry a digest or an open/clear verdict were taken from the 2.11.0 engine
// itself on the same input (measured 2026-10-09).

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { buildStatus } from "../model/status";
import { buildWaits } from "../model/waits";
import { strings } from "../render/i18n";
import { renderRunHealth, renderRunLine } from "../render/status";
import type { AuditEvent } from "../scan/audit";
import { pendingGate } from "../scan/gate-wait";
import { parseState } from "../scan/parser";
import type { QuestionsReport } from "../scan/questions";
import { readDirectiveMarker, resolvePosition, stateDigest } from "../scan/run-position";

const STATE = [
  "# AI-DLC State Tracking",
  "",
  "## Project Information",
  "- **Project**: Demo",
  "- **State Version**: 8",
  "- **Change Control**: off (from scope classic)",
  "",
  "## Runtime State",
  "- **Construction Iteration**: unit-major",
  "- **Active Unit**: unit-b",
  "- **Unit Stage**: code-generation",
  "- **Unit State**: in-progress",
  "",
  "## Current Status",
  "- **Lifecycle Phase**: CONSTRUCTION",
  "- **Current Stage**: functional-design",
  "- **Last Updated**: 2026-10-09T00:00:00Z",
  "",
  "## Unit Progress",
  "| Unit | Stage |",
  "|---|---|",
  "| unit-b | code-generation |",
  "",
  "## Stage Progress",
  "### CONSTRUCTION PHASE",
  "- [-] functional-design — EXECUTE",
  "- [ ] code-generation — EXECUTE",
  "",
].join("\n");
/** What the engine's `stateDigest` returned for STATE. */
const ENGINE_DIGEST = "9957a98c10edffad0464bbe538186c67cb0e458e9cdb6f60b71bcc62d9234e8e";

describe("state digest", () => {
  test("matches the engine's on the same state", () => {
    expect(stateDigest(STATE)).toBe(ENGINE_DIGEST);
  });

  test("ignores the unit cache, timestamps, the Unit Progress rows, CRLF and the policy rename", () => {
    // Each of these returned the same digest from the engine.
    const moved = STATE.replace(
      "unit-b\n- **Unit Stage**: code-generation",
      "unit-c\n- **Unit Stage**: x",
    )
      .replace("2026-10-09T00:00:00Z", "2026-10-10T00:00:00Z")
      .replace("| unit-b | code-generation |", "| unit-c | x |");
    expect(stateDigest(moved)).toBe(ENGINE_DIGEST);
    expect(stateDigest(STATE.replace(/\n/g, "\r\n"))).toBe(ENGINE_DIGEST);
    expect(stateDigest(STATE.replace("**Change Control**", "**Guard Policy**"))).toBe(
      ENGINE_DIGEST,
    );
  });

  test("a checkbox move changes it", () => {
    expect(stateDigest(STATE.replace("- [-] functional-design", "- [?] functional-design"))).toBe(
      "50637ef55526dccd6faaca5f222ade1a97be0167c84e323112d1a58ad04258e3",
    );
  });
});

describe("directive marker", () => {
  function record(marker: unknown, where = ".aidlc-engine/active-directive.json"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-pos-"));
    fs.mkdirSync(path.dirname(path.join(dir, where)), { recursive: true });
    fs.writeFileSync(
      path.join(dir, where),
      typeof marker === "string" ? marker : JSON.stringify(marker),
    );
    return dir;
  }
  const ask = {
    version: 2,
    kind: "ask",
    ask_type: "unit-paused",
    stage: "code-generation",
    unit: "unit-b",
  };

  test("is read only when it was issued against the state as it is now", () => {
    const ok = readDirectiveMarker(
      record({ ...ask, state_sha256: ENGINE_DIGEST, delivery: "delivered" }),
      STATE,
    );
    expect(ok).toEqual({
      marker: {
        kind: "ask",
        stage: "code-generation",
        unit: "unit-b",
        askType: "unit-paused",
        delivery: "delivered",
      },
    });
    const stale = readDirectiveMarker(record({ ...ask, state_sha256: "0".repeat(64) }), STATE);
    expect(stale).toEqual({ miss: "stale" });
  });

  test("a superseded or rehydrate-pending marker is not current", () => {
    expect(
      readDirectiveMarker(
        record({ ...ask, state_sha256: ENGINE_DIGEST, delivery: "superseded" }),
        STATE,
      ),
    ).toEqual({ miss: "superseded" });
    expect(
      readDirectiveMarker(
        record({ ...ask, state_sha256: ENGINE_DIGEST, needs_rehydrate: true }),
        STATE,
      ),
    ).toEqual({ miss: "superseded" });
  });

  test("absent, malformed and legacy-path markers", () => {
    expect(
      readDirectiveMarker(fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-pos-")), STATE),
    ).toEqual({
      miss: "absent",
    });
    expect(readDirectiveMarker(record("{not json"), STATE)).toEqual({ miss: "unreadable" });
    expect(
      readDirectiveMarker(record({ kind: "ask", stage: "x", state_sha256: "short" }), STATE),
    ).toEqual({
      miss: "unreadable",
    });
    const legacy = record({ ...ask, state_sha256: ENGINE_DIGEST }, ".aidlc-active-directive.json");
    expect("marker" in readDirectiveMarker(legacy, STATE)).toBe(true);
  });
});

describe("run position", () => {
  const none = { miss: "absent" as const };
  const base = {
    currentStage: "functional-design",
    unitStage: "",
    activeUnit: "",
    constructionIteration: "",
  };

  test("Unit Stage + Active Unit win over Current Stage", () => {
    expect(
      resolvePosition({
        ...base,
        unitStage: "code-generation",
        activeUnit: "unit-b",
        marker: none,
      }),
    ).toEqual({ stage: "code-generation", unit: "unit-b", basis: "unit-stage", verified: true });
  });

  test("a current directive is next", () => {
    const marker = { marker: { kind: "run-stage", stage: "code-generation", unit: "unit-a" } };
    expect(resolvePosition({ ...base, marker })).toEqual({
      stage: "code-generation",
      unit: "unit-a",
      basis: "directive",
      verified: true,
    });
  });

  test("Current Stage last — unverified only where it can lag", () => {
    const perUnit = (s: string) => s === "functional-design";
    expect(
      resolvePosition({
        ...base,
        constructionIteration: "unit-major",
        isPerUnit: perUnit,
        marker: none,
      }),
    ).toEqual({
      stage: "functional-design",
      basis: "current-stage",
      verified: false,
      markerMiss: "absent",
    });
    expect(resolvePosition({ ...base, isPerUnit: perUnit, marker: { miss: "stale" } })).toEqual({
      stage: "functional-design",
      basis: "current-stage",
      verified: true,
      markerMiss: "stale",
    });
    expect(resolvePosition({ ...base, currentStage: "none", marker: none }).stage).toBeUndefined();
  });
});

describe("gate wait", () => {
  const ev = (
    ts: string,
    event: string,
    fields: Record<string, string> = {},
    shard = "a",
  ): AuditEvent => ({
    ts,
    event,
    fields: { Stage: "requirements-analysis", ...fields },
    shard,
  });
  const OPEN = ev("2026-10-09T01:00:00Z", "STAGE_AWAITING_APPROVAL");

  test("opens on STAGE_AWAITING_APPROVAL and closes on the gate's answer", () => {
    expect(pendingGate([OPEN], "requirements-analysis")).toEqual({ since: "2026-10-09T01:00:00Z" });
    for (const close of ["GATE_APPROVED", "GATE_REJECTED", "STAGE_SKIPPED"]) {
      expect(
        pendingGate([OPEN, ev("2026-10-09T02:00:00Z", close)], "requirements-analysis"),
      ).toBeUndefined();
    }
  });

  test("a recovered or revalidated re-stamp does not open it", () => {
    expect(
      pendingGate(
        [ev("2026-10-09T01:00:00Z", "STAGE_AWAITING_APPROVAL", { Recovered: "true" })],
        "requirements-analysis",
      ),
    ).toBeUndefined();
    expect(
      pendingGate(
        [ev("2026-10-09T01:00:00Z", "STAGE_AWAITING_APPROVAL", { Revalidated: "true" })],
        "requirements-analysis",
      ),
    ).toBeUndefined();
  });

  test("a workflow boundary clears it; another stage starting does not", () => {
    expect(
      pendingGate(
        [OPEN, ev("2026-10-09T02:00:00Z", "STAGE_JUMPED", { Stage: "x" })],
        "requirements-analysis",
      ),
    ).toBeUndefined();
    expect(
      pendingGate([OPEN, ev("2026-10-09T02:00:00Z", "STAGE_STARTED")], "requirements-analysis"),
    ).toBeUndefined();
    // Not a boundary, but still an event of this stage after the ask — the engine
    // clears on it all the same.
    expect(
      pendingGate(
        [OPEN, ev("2026-10-09T02:00:00Z", "STAGE_STARTED", { Workflow: "single-stage:abc" })],
        "requirements-analysis",
      ),
    ).toBeUndefined();
    expect(
      pendingGate(
        [OPEN, ev("2026-10-09T02:00:00Z", "STAGE_STARTED", { Stage: "user-stories" })],
        "requirements-analysis",
      ),
    ).toEqual({ since: "2026-10-09T01:00:00Z" });
  });

  test("two shards disagreeing in one second fail closed", () => {
    const t = "2026-10-09T01:00:00Z";
    expect(
      pendingGate(
        [ev(t, "STAGE_AWAITING_APPROVAL", {}, "a"), ev(t, "GATE_APPROVED", {}, "b")],
        "requirements-analysis",
      ),
    ).toBeUndefined();
    // Within one shard, append order is causal: the last row wins.
    expect(
      pendingGate(
        [ev(t, "GATE_APPROVED", {}, "a"), ev(t, "STAGE_AWAITING_APPROVAL", {}, "a")],
        "requirements-analysis",
      ),
    ).toEqual({ since: t });
  });
});

// ── End to end: the fixture tree, with only the state (and a marker) changed ──────

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const RECORD_REL = "aidlc/spaces/default/intents/260101-demo-migration";

/** A copy of the fixture whose state the test rewrites; returns the root. */
function fixtureWith(edit: (state: string) => string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-pos-fx-"));
  fs.cpSync(FIXTURE, root, { recursive: true });
  const statePath = path.join(root, RECORD_REL, "aidlc-state.md");
  fs.writeFileSync(statePath, edit(fs.readFileSync(statePath, "utf-8")));
  return root;
}

/** The fixture as a unit-major run whose cursor stayed on functional-design. */
const unitMajor = (unitLines: string) => (s: string) =>
  s
    .replace(
      "- **Revision Count**: 2",
      `- **Revision Count**: 2\n- **Construction Iteration**: unit-major\n${unitLines}`,
    )
    .replace("- [x] functional-design — EXECUTE", "- [-] functional-design — EXECUTE")
    .replace("- [-] code-generation — EXECUTE", "- [ ] code-generation — EXECUTE")
    .replace("- **Current Stage**: code-generation", "- **Current Stage**: functional-design");

describe("position, end to end", () => {
  test("a unit's ask is current where Unit Stage puts the run, not where Current Stage lags", () => {
    // Before: Current Stage functional-design, so PU-B-ui's blank plan approval in
    // code-generation was filed as an earlier stage's leftover and nothing was waiting.
    const m = assemble(
      fixtureWith(unitMajor("- **Active Unit**: PU-B-ui\n- **Unit Stage**: code-generation")),
    );
    expect(m.waits.position).toEqual({
      stage: "code-generation",
      unit: "PU-B-ui",
      basis: "unit-stage",
      verified: true,
    });
    expect(m.blockers.filter((b) => b.isCurrentStage).map((b) => b.unit)).toEqual(["PU-B-ui"]);
    expect(renderRunLine(m, strings("ko"))).toContain("유닛 PU-B-ui");
  });

  test("another unit's copy of the same stage is not what holds the run", () => {
    const m = assemble(
      fixtureWith(unitMajor("- **Active Unit**: PU-A-core\n- **Unit Stage**: code-generation")),
    );
    expect(m.blockers.filter((b) => b.isCurrentStage)).toEqual([]);
  });

  test("with no unit cache and no current directive, a lagging cursor is labelled unverified", () => {
    const m = assemble(fixtureWith(unitMajor("")));
    expect(m.waits.position).toEqual({
      stage: "functional-design",
      basis: "current-stage",
      verified: false,
      markerMiss: "absent",
    });
    expect(renderRunLine(m, strings("ko"))).toContain("위치 미확인");
  });

  test("a directive issued against this state names the position and its ask", () => {
    const edit = unitMajor("");
    const root = fixtureWith(edit);
    const stateText = fs.readFileSync(path.join(root, RECORD_REL, "aidlc-state.md"), "utf-8");
    fs.mkdirSync(path.join(root, RECORD_REL, ".aidlc-engine"), { recursive: true });
    fs.writeFileSync(
      path.join(root, RECORD_REL, ".aidlc-engine", "active-directive.json"),
      JSON.stringify({
        version: 2,
        kind: "ask",
        ask_type: "scope-confirm",
        stage: "code-generation",
        unit: "PU-A-core",
        state_sha256: stateDigest(stateText),
        delivery: "delivered",
      }),
    );
    const m = assemble(root);
    expect(m.waits.position.basis).toBe("directive");
    expect(m.waits.engineAsk).toEqual({
      askType: "scope-confirm",
      stage: "code-generation",
      unit: "PU-A-core",
    });
    const html = renderRunHealth(m, strings("ko"));
    expect(html).toContain("엔진 질문 대기 — 범위 확인 · PU-A-core · code-generation");
    // Editing the state afterwards makes the same marker stale.
    fs.appendFileSync(path.join(root, RECORD_REL, "aidlc-state.md"), "- [ ] extra — EXECUTE\n");
    const after = assemble(root);
    expect(after.waits.position.markerMiss).toBe("stale");
    expect(after.waits.engineAsk).toBeUndefined();
  });
});

describe("waits", () => {
  const STATE_BASE = (rows: string, runtime = "") =>
    `## Runtime State\n${runtime}\n## Current Status\n- **Current Stage**: requirements-analysis\n\n## Stage Progress\n### INCEPTION PHASE\n${rows}\n`;
  const pos = { stage: "requirements-analysis", basis: "current-stage" as const, verified: true };
  const empty: QuestionsReport = {
    files: [],
    blocked: [],
    totalQuestions: 0,
    totalUnanswered: 0,
    unclosed: [],
  };
  const open: AuditEvent = {
    ts: "2026-10-09T01:00:00Z",
    event: "STAGE_AWAITING_APPROVAL",
    fields: { Stage: "requirements-analysis" },
    shard: "a",
  };
  const waits = (stateText: string, events: AuditEvent[] = [], questions = empty) =>
    buildWaits({
      state: parseState(stateText),
      position: pos,
      marker: { miss: "absent" },
      events,
      questions,
    });

  test("the gate is the state row's claim; the audit only says since when", () => {
    expect(waits(STATE_BASE("- [?] requirements-analysis — EXECUTE"), [open]).gate).toEqual({
      stage: "requirements-analysis",
      since: "2026-10-09T01:00:00Z",
    });
    // Before: an audit-open gate counted as awaiting whatever the row said.
    expect(waits(STATE_BASE("- [-] requirements-analysis — EXECUTE"), [open]).gate).toBeUndefined();
    expect(waits(STATE_BASE("- [R] requirements-analysis — EXECUTE")).revising).toBe(
      "requirements-analysis",
    );
  });

  test("a park counts only while the run is still on the stage it was parked at", () => {
    const rows = "- [-] requirements-analysis — EXECUTE";
    const here =
      "- **Parked**: 2026-10-09T02:00:00Z\n- **Parked At Stage**: requirements-analysis\n- **Parked By**: person";
    expect(waits(STATE_BASE(rows, here)).parked).toEqual({
      stage: "requirements-analysis",
      since: "2026-10-09T02:00:00Z",
      byPerson: true,
    });
    const left = "- **Parked**: 2026-10-09T02:00:00Z\n- **Parked At Stage**: user-stories";
    expect(waits(STATE_BASE(rows, left)).parked).toBeUndefined();
  });

  test("a paused unit carries the engine's own reason and next action", () => {
    const rt =
      "- **Active Unit**: unit-a\n- **Unit Stage**: code-generation\n- **Unit State**: paused\n- **Unit Pause Reason**: 외부 API 키 대기\n- **Unit Next Action**: 키를 받으면 resume";
    expect(waits(STATE_BASE("- [-] requirements-analysis — EXECUTE", rt)).unitPaused).toEqual({
      unit: "unit-a",
      stage: "code-generation",
      reason: "외부 API 키 대기",
      nextAction: "키를 받으면 resume",
    });
  });

  test("a raw blank in the active stage's own file that no ask explains is engine-only", () => {
    const file = (rel: string, rawBlank: boolean, unanswered: number) => ({
      rel,
      phase: "inception",
      stage: rel.split("/")[1] ?? "",
      questions: [],
      unanswered: Array.from({ length: unanswered }, () => ({
        heading: "Q1",
        answer: "",
        answered: false,
        kind: "question" as const,
      })),
      mtime: "",
      unclosed: false,
      rawBlank,
    });
    const qs = {
      ...empty,
      files: [
        file("inception/requirements-analysis/requirements-analysis-questions.md", true, 0),
        file("inception/requirements-analysis/other-questions.md", true, 1),
        file("inception/requirements-analysis/reviews/r-questions.md", true, 0),
        file("inception/user-stories/user-stories-questions.md", true, 0),
      ],
    };
    const rows = "- [-] requirements-analysis — EXECUTE";
    expect(waits(STATE_BASE(rows), [], qs).engineOnly).toEqual([
      "inception/requirements-analysis/requirements-analysis-questions.md",
    ]);
    // The stop hook reads them only while the row is `[-]`, and not under autonomy.
    expect(waits(STATE_BASE("- [?] requirements-analysis — EXECUTE"), [], qs).engineOnly).toEqual(
      [],
    );
    expect(
      waits(STATE_BASE(rows, "- **Construction Autonomy Mode**: autonomous"), [], qs).engineOnly,
    ).toEqual([]);
  });
});

describe("waits on the page", () => {
  const ko = strings("ko");
  test("park, paused unit and engine ask each count once; revising and engine-only do not", () => {
    const base = assemble(FIXTURE);
    const m = {
      ...base,
      waits: {
        ...base.waits,
        parked: { stage: "code-generation", since: base.generatedAt, byPerson: false },
        unitPaused: { unit: "PU-B-ui", reason: "", nextAction: "" },
        engineAsk: { askType: "unit-claim", stage: "code-generation" },
        revising: "code-generation",
        engineOnly: ["construction/PU-B-ui/code-generation/code-generation-questions.md"],
      },
    };
    const html = renderRunHealth(m, ko);
    for (const text of [
      "⏸ 일시정지 — code-generation",
      "⏸ 유닛 PU-B-ui 일시정지",
      "유닛 선점",
      "수정 중",
      "엔진만 대기로 보는 빈 태그",
    ]) {
      expect(html).toContain(text);
    }
    // 1 current ask + park + paused unit + engine ask.
    expect(buildStatus(m).human?.current).toBe(1);
    expect(html).toContain('<b class="mc-n warn">4</b>');
  });
});
