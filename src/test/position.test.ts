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
import { claimFilter } from "../scan/claim-attempt";
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

/** A v2 marker in the shape the engine's own parser accepts (checked against it). */
const H = "a".repeat(64);
function v2(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    kind: "ask",
    ask_type: "unit-paused",
    stage: "code-generation",
    unit: "unit-b",
    state_sha256: ENGINE_DIGEST,
    project_sha256: H,
    intent_uuid: null,
    state_present: true,
    owner_session: "s1",
    revision: 1,
    owner_epoch: 0,
    context_epoch: 0,
    event_sequence: 3,
    human_sequence: 1,
    engine_sequence: 2,
    conversation_sequence: 0,
    stop_count: 0,
    delivery: "issued",
    needs_rehydrate: false,
    active_attempt: {
      command_kind: "next",
      command_sha256: H,
      issued_state_sha256: H,
      session_id: "s1",
      owner_epoch: 0,
      context_epoch: 0,
      status: "settled",
    },
    ...over,
  };
}

function markerRecord(marker: unknown, where = ".aidlc-engine/active-directive.json"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-pos-"));
  fs.mkdirSync(path.dirname(path.join(dir, where)), { recursive: true });
  fs.writeFileSync(
    path.join(dir, where),
    typeof marker === "string" ? marker : JSON.stringify(marker),
  );
  return dir;
}

describe("directive marker", () => {
  test("is read only when it was issued against the state as it is now", () => {
    expect(readDirectiveMarker(markerRecord(v2()), STATE)).toEqual({
      marker: {
        kind: "ask",
        stage: "code-generation",
        unit: "unit-b",
        askType: "unit-paused",
        delivery: "issued",
      },
    });
    expect(readDirectiveMarker(markerRecord(v2({ state_sha256: "0".repeat(64) })), STATE)).toEqual({
      miss: "stale",
    });
  });

  test("a superseded or rehydrate-pending marker is not current", () => {
    expect(readDirectiveMarker(markerRecord(v2({ delivery: "superseded" })), STATE)).toEqual({
      miss: "superseded",
    });
    expect(readDirectiveMarker(markerRecord(v2({ needs_rehydrate: true })), STATE)).toEqual({
      miss: "superseded",
    });
  });

  test("a marker the engine's parser would refuse is not read", () => {
    // Second review: the first cut accepted each of these (measured against the
    // engine's own `parseActiveDirectiveMarker`, which refuses all four).
    const incomplete = {
      version: 2,
      kind: "ask",
      stage: "code-generation",
      state_sha256: ENGINE_DIGEST,
    };
    for (const m of [incomplete, v2({ version: 3 }), v2({ stage: "../oops" }), v2({ unit: "" })]) {
      expect(readDirectiveMarker(markerRecord(m), STATE)).toEqual({ miss: "unreadable" });
    }
    expect(readDirectiveMarker(markerRecord("{not json"), STATE)).toEqual({ miss: "unreadable" });
  });

  test("a v1 marker gives a position and never an ask", () => {
    const v1 = {
      version: 1,
      kind: "ask",
      ask_type: "scope-confirm",
      stage: "code-generation",
      state_sha256: ENGINE_DIGEST,
    };
    expect(readDirectiveMarker(markerRecord(v1), STATE)).toEqual({
      marker: { kind: "", stage: "code-generation" },
    });
  });

  test("the legacy file is read only when the new marker AND its lock are absent", () => {
    expect(
      readDirectiveMarker(fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-pos-")), STATE),
    ).toEqual({ miss: "absent" });
    const legacy = markerRecord(v2(), ".aidlc-active-directive.json");
    expect("marker" in readDirectiveMarker(legacy, STATE)).toBe(true);
    fs.mkdirSync(path.join(legacy, ".aidlc-engine", "active-directive.lock"), { recursive: true });
    expect(readDirectiveMarker(legacy, STATE)).toEqual({ miss: "absent" });
  });

  test("a marker over 64 KiB is refused from the bytes read, not from a stat", () => {
    expect(
      readDirectiveMarker(
        markerRecord(v2({ message: "x".repeat(1000), pad: "y".repeat(70_000) })),
        STATE,
      ),
    ).toEqual({
      miss: "unreadable",
    });
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
      JSON.stringify(
        v2({ ask_type: "scope-confirm", unit: "PU-A-core", state_sha256: stateDigest(stateText) }),
      ),
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
    unreadable: [],
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
      checkoutParkFile: false,
      hookHeartbeats: { present: false, stamps: [] },
      blockers: [],
      marks: {},
      now: "2026-10-09T12:00:00Z",
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
      "수정 구간",
      "엔진만 대기로 보는 빈 태그",
    ]) {
      expect(html).toContain(text);
    }
    // 1 current ask + park + paused unit + engine ask.
    expect(buildStatus(m).human?.current).toBe(1);
    expect(html).toContain('<b class="mc-n warn">4</b>');
  });
});

describe("second-review regressions", () => {
  const none = { miss: "absent" as const };
  const base = {
    currentStage: "functional-design",
    unitStage: "",
    activeUnit: "",
    constructionIteration: "",
  };
  const marker = (stage: string, unit?: string) => ({
    marker: { kind: "ask", stage, ...(unit ? { unit } : {}) },
  });

  test("a unit cache the current directive contradicts is not verified", () => {
    expect(
      resolvePosition({
        ...base,
        unitStage: "nfr-design",
        activeUnit: "unit-a",
        marker: marker("code-generation", "unit-b"),
      }),
    ).toEqual({
      stage: "nfr-design",
      unit: "unit-a",
      basis: "unit-stage",
      verified: false,
      conflict: { stage: "code-generation", unit: "unit-b" },
    });
  });

  test("unit-major with no catalogue cannot claim Current Stage is where the run is", () => {
    expect(
      resolvePosition({ ...base, constructionIteration: "unit-major", marker: none }).verified,
    ).toBe(false);
  });

  const STATE = (rows: string, runtime = "", info = "") =>
    `## Project Information\n${info}\n## Runtime State\n${runtime}\n## Current Status\n- **Current Stage**: code-generation\n\n## Stage Progress\n### CONSTRUCTION PHASE\n${rows}\n`;
  const pos = {
    stage: "code-generation",
    unit: "unit-b",
    basis: "unit-stage" as const,
    verified: true,
  };
  const empty: QuestionsReport = {
    files: [],
    blocked: [],
    totalQuestions: 0,
    totalUnanswered: 0,
    unclosed: [],
    unreadable: [],
  };
  const w = (
    stateText: string,
    m: { marker: Record<string, unknown> } | { miss: "absent" },
    extra: Partial<Parameters<typeof buildWaits>[0]> = {},
  ) =>
    buildWaits({
      state: parseState(stateText),
      position: pos,
      marker: m as Parameters<typeof buildWaits>[0]["marker"],
      events: [],
      questions: empty,
      checkoutParkFile: false,
      hookHeartbeats: { present: false, stamps: [] },
      blockers: [],
      marks: {},
      now: "2026-10-09T12:00:00Z",
      ...extra,
    });
  const ROW = "- [-] code-generation — EXECUTE";
  const ask = (over: Record<string, unknown>) => ({
    marker: { kind: "ask", stage: "code-generation", unit: "unit-b", ...over },
  });

  test("an answered guard-recovery ask is not a wait; one awaiting feedback is", () => {
    expect(
      w(STATE(ROW), ask({ askType: "guard-recovery", guardRecovery: "ready" })).engineAsk,
    ).toBeUndefined();
    expect(
      w(STATE(ROW), ask({ askType: "guard-recovery", guardRecovery: "awaiting-feedback" }))
        .engineAsk,
    ).toBeDefined();
  });

  test("a plan approval whose section is already in the file is that ask, answered or not", () => {
    const file = {
      rel: "construction/unit-b/code-generation/code-generation-questions.md",
      phase: "construction",
      stage: "code-generation",
      unit: "unit-b",
      questions: [
        {
          heading: "Plan Approval",
          answer: "A. Approve Plan",
          answered: true,
          kind: "confirmation" as const,
        },
      ],
      unanswered: [],
      mtime: "",
      unclosed: false,
      rawBlank: false,
    };
    const qs = { ...empty, files: [file] };
    expect(
      w(STATE(ROW), ask({ askType: "plan-approval" }), { questions: qs }).engineAsk,
    ).toBeUndefined();
    // Another question blank in the same stage is not the plan approval.
    const other = {
      ...file,
      questions: [{ heading: "Q1", answer: "", answered: false, kind: "question" as const }],
    };
    expect(
      w(STATE(ROW), ask({ askType: "plan-approval" }), { questions: { ...empty, files: [other] } })
        .engineAsk,
    ).toBeDefined();
  });

  test("a paused unit hides only its own unit-paused ask", () => {
    const paused = "- **Active Unit**: unit-a\n- **Unit State**: paused";
    expect(
      w(STATE(ROW, paused), ask({ askType: "unit-paused", unit: "unit-b" })).engineAsk,
    ).toBeDefined();
    expect(
      w(STATE(ROW, paused), ask({ askType: "unit-paused", unit: "unit-a" })).engineAsk,
    ).toBeUndefined();
  });

  test("the engine's park directive counts; a checkout park file alone is shown unverified", () => {
    expect(w(STATE(ROW), { marker: { kind: "parked", stage: "code-generation" } }).parked).toEqual({
      stage: "code-generation",
      since: "",
      byPerson: false,
    });
    const file = w(STATE(ROW), { miss: "absent" }, { checkoutParkFile: true });
    expect(file.parked).toBeUndefined();
    expect(file.checkoutPark).toBe(true);
  });

  test("a team unit's own gate is read as the stop hook reads it", () => {
    // `isHumanWaitStop` asks `unitGateStatus` for the active stage and unit first; under
    // team ownership the state row never moves to `[?]` for it. Expectations are the
    // engine's own (scan/team-gate.ts header; 0 of 47,680 random queries disagree).
    const team = "- **Unit Ownership**: team\n- **Construction Iteration**: unit-major";
    const claim = claimFilter({
      team: true,
      stamp: null,
      generations: {},
      space: "default",
      uuid: () => ({ ok: true, value: "u-1" }),
    });
    const teamGate = { claim, scope: "per-stage" as const };
    let pos = 0;
    const g = (event: string, ts: string, fields: Record<string, string> = {}): AuditEvent => ({
      event,
      ts,
      shard: "a.md",
      shardIndex: 0,
      pos: pos++,
      fields: { Stage: "code-generation", Unit: "unit-b", ...fields },
    });
    const open = [g("STAGE_AWAITING_APPROVAL", "2026-10-09T10:00:00Z")];
    expect(w(STATE(ROW, team), { miss: "absent" }, { events: open, teamGate }).teamGate).toEqual({
      stage: "code-generation",
      unit: "unit-b",
      status: "awaiting-approval",
      scopeVerified: false,
    });
    // Approved closes it; a rejection leaves it revising — shown, like `[R]`.
    const approved = [...open, g("GATE_APPROVED", "2026-10-09T10:05:00Z")];
    expect(
      w(STATE(ROW, team), { miss: "absent" }, { events: approved, teamGate }).teamGate,
    ).toBeUndefined();
    const rejected = [...open, g("GATE_REJECTED", "2026-10-09T10:05:00Z")];
    expect(
      w(STATE(ROW, team), { miss: "absent" }, { events: rejected, teamGate }).teamGate?.status,
    ).toBe("revising");
    // Another unit's gate, or another gate scope, is not this unit's.
    const other = [g("STAGE_AWAITING_APPROVAL", "2026-10-09T10:00:00Z", { Unit: "unit-a" })];
    expect(
      w(STATE(ROW, team), { miss: "absent" }, { events: other, teamGate }).teamGate,
    ).toBeUndefined();
    const unitEnd = { claim, scope: "unit-end" as const };
    expect(
      w(STATE(ROW, team), { miss: "absent" }, { events: open, teamGate: unitEnd }).teamGate,
    ).toBeUndefined();
    // A gate row the claim filter cannot decide: unread, never "nothing waiting".
    const stuck = { claim: () => "unknown" as const, scope: "per-stage" as const };
    const unread = w(STATE(ROW, team), { miss: "absent" }, { events: open, teamGate: stuck });
    expect(unread.teamGate).toBeUndefined();
    expect(unread.teamGateUnread).toBe(true);
    // It names its unit and stage, so it reads apart from a stage-level leftover cache.
    expect(unread.teamGateUnreadAt).toEqual({
      stage: "code-generation",
      unit: "unit-b",
      scopeVerified: false,
    });
    // Outside team ownership there is no unit gate to read.
    const solo = w(STATE(ROW), { miss: "absent" }, { events: open });
    expect(solo.teamGate).toBeUndefined();
    expect(solo.teamGateUnread).toBe(false);
  });

  test("the team gate is scoped as the hook's activeUnit is: marker, never a leftover cache", () => {
    // `activeUnit = directive.unit ?? (marker on the same stage ? marker.unit : undefined)`
    // (aidlc-continue-workflow.ts), and `isHumanWaitStop` asks `unitGateStatus` only with
    // one. At stage level the router returns before team unit routing
    // (`usesStageLevelPerUnitArtifacts` ahead of `emitTeamUnitMajorRunStage`, aidlc-
    // orchestrate.ts), so the directive names no unit and only a current marker can.
    const team = "- **Unit Ownership**: team\n- **Construction Iteration**: unit-major";
    const cache = "- **Unit Stage**: code-generation\n- **Active Unit**: unit-b";
    const claim = claimFilter({
      team: true,
      stamp: null,
      generations: {},
      space: "default",
      uuid: () => ({ ok: true, value: "u-1" }),
    });
    const teamGate = { claim, scope: "per-stage" as const };
    const open = (unit: string): AuditEvent[] => [
      {
        event: "STAGE_AWAITING_APPROVAL",
        ts: "2026-10-09T10:00:00Z",
        shard: "a.md",
        shardIndex: 0,
        pos: 0,
        fields: { Stage: "code-generation", Unit: unit },
      },
    ];
    const at = (o: Parameters<typeof resolvePosition>[0]) => resolvePosition(o);
    const input = {
      currentStage: "code-generation",
      unitStage: "code-generation",
      activeUnit: "unit-b",
      constructionIteration: "unit-major",
    };
    const none = { miss: "absent" as const };
    const markerA = { marker: { kind: "ask", stage: "code-generation", unit: "unit-a" } };

    // Stage level, no marker: the leftover cache is no unit, so no gate is asked.
    const level = at({ ...input, stageLevel: true, marker: none });
    const noMarker = w(STATE(ROW, `${team}\n${cache}`), none, {
      events: open("unit-b"),
      teamGate,
      position: level,
      stageLevel: true,
    });
    expect(noMarker.teamGate).toBeUndefined();
    expect(noMarker.teamGateUnread).toBe(false);
    // Stage level, a current marker naming a unit: the hook takes the marker's unit.
    const marked = w(STATE(ROW, `${team}\n${cache}`), markerA as never, {
      events: open("unit-a"),
      teamGate,
      position: at({ ...input, stageLevel: true, marker: markerA as never }),
      stageLevel: true,
    });
    expect(marked.teamGate).toEqual({
      stage: "code-generation",
      unit: "unit-a",
      status: "awaiting-approval",
      scopeVerified: true,
    });

    // Per unit, a cache unit off the resolved roster (#26) is not where the engine is,
    // and the hook never reads the cache — no gate is read for it.
    const off = at({ ...input, rosterUnits: ["unit-a"], marker: none });
    expect(off.offRoster).toBe("absent");
    const offRoster = w(STATE(ROW, `${team}\n${cache}`), none, {
      events: open("unit-b"),
      teamGate,
      position: off,
    });
    expect(offRoster.teamGate).toBeUndefined();
    expect(offRoster.teamGateUnread).toBe(false);
    // ...unless an applicable scope stamp names it: the router then walks `[stamp.unit]`
    // instead of the roster (`emitTeamUnitMajorRunStage`), so that unit is routable.
    const stamped = w(STATE(ROW, `${team}\n${cache}`), none, {
      events: open("unit-b"),
      teamGate: { ...teamGate, stampUnit: "unit-b" },
      position: off,
    });
    expect(stamped.teamGate?.unit).toBe("unit-b");
    // An unreadable roster stops per-unit routing before any stamp is read.
    const unknown = at({ ...input, rosterUnits: null, marker: none });
    expect(unknown.offRoster).toBe("unknown");
    const malformed = w(STATE(ROW, `${team}\n${cache}`), none, {
      events: open("unit-b"),
      teamGate: { ...teamGate, stampUnit: "unit-b" },
      position: unknown,
    });
    expect(malformed.teamGate).toBeUndefined();
    // A current marker is the hook's own source, roster or not.
    const markerB = { marker: { kind: "ask", stage: "code-generation", unit: "unit-b" } };
    const viaMarker = w(STATE(ROW, `${team}\n${cache}`), markerB as never, {
      events: open("unit-b"),
      teamGate,
      position: at({ ...input, rosterUnits: null, marker: markerB as never }),
    });
    expect(viaMarker.teamGate?.scopeVerified).toBe(true);
    // On the roster, the cache scopes it, unconfirmed — as it scopes a decision.
    const on = w(STATE(ROW, `${team}\n${cache}`), none, {
      events: open("unit-b"),
      teamGate,
      position: at({ ...input, rosterUnits: ["unit-a", "unit-b"], marker: none }),
    });
    expect(on.teamGate?.scopeVerified).toBe(false);
  });

  test("a team unit-major directive reads engine-only blanks without the [-] row", () => {
    const team = "- **Unit Ownership**: team\n- **Construction Iteration**: unit-major";
    const file = {
      rel: "construction/unit-b/code-generation/code-generation-questions.md",
      phase: "construction",
      stage: "code-generation",
      unit: "unit-b",
      questions: [],
      unanswered: [],
      mtime: "",
      unclosed: false,
      rawBlank: true,
    };
    const qs = { ...empty, files: [file] };
    const notActive = "- [ ] code-generation — EXECUTE";
    expect(w(STATE(notActive, team), { miss: "absent" }, { questions: qs }).engineOnly).toEqual([
      file.rel,
    ]);
    expect(w(STATE(notActive), { miss: "absent" }, { questions: qs }).engineOnly).toEqual([]);
  });

  test("a stop record made against another state is history, not a current block", () => {
    const sig = (digest: string) => `code-generation::${digest}::${"f".repeat(64)}`;
    const cur = "b".repeat(64);
    expect(
      w(
        STATE(ROW),
        { miss: "absent" },
        { guard: { signature: sig("c".repeat(64)), stateDigest: cur } },
      ).guardRecordStale,
    ).toBe(true);
    expect(
      w(STATE(ROW), { miss: "absent" }, { guard: { signature: sig(cur), stateDigest: cur } })
        .guardRecordStale,
    ).toBe(false);
    // A pre-2.9 signature carries no digest and cannot be dated.
    expect(
      w(
        STATE(ROW),
        { miss: "absent" },
        { guard: { signature: "code-generation::40", stateDigest: cur } },
      ).guardRecordStale,
    ).toBe(false);
  });
});

describe("stage level (usesStageLevelPerUnitArtifacts)", () => {
  // A plan that skips Units Generation runs each per-unit stage once at stage level: the
  // orchestrator issues it with `unit: null` (aidlc-orchestrate.ts `emitPerUnitRunStage`),
  // both unit-major walks return null, and `unit start/pause/complete` is refused
  // (aidlc-state.ts). So the unit cache can only be a leftover of an earlier plan, and
  // `Current Stage` is where routing is — it has no later unit step to lag behind.
  const none = { miss: "absent" as const };
  const base = {
    currentStage: "code-generation",
    unitStage: "",
    activeUnit: "",
    constructionIteration: "unit-major",
  };

  test("a leftover unit cache does not place the run on a unit", () => {
    expect(
      resolvePosition({
        ...base,
        unitStage: "functional-design",
        activeUnit: "unit-b",
        stageLevel: true,
        marker: none,
      }),
    ).toEqual({
      stage: "code-generation",
      basis: "current-stage",
      verified: true,
      markerMiss: "absent",
      leftoverUnit: { unit: "unit-b", stage: "functional-design" },
    });
  });

  test("Current Stage does not lag, catalogue or not", () => {
    // Per unit, unit-major with no catalogue lowers the claim; at stage level it cannot lag.
    expect(resolvePosition({ ...base, marker: none }).verified).toBe(false);
    expect(resolvePosition({ ...base, stageLevel: true, marker: none }).verified).toBe(true);
    expect(
      resolvePosition({ ...base, stageLevel: true, isPerUnit: () => true, marker: none }).verified,
    ).toBe(true);
  });

  test("a current directive keeps its unit — the hook recovers it from the marker", () => {
    // The stop hook takes `directive.unit ?? activeMarker.unit` (aidlc-continue-workflow.ts),
    // so a stage-level probe's null unit falls through to the marker's. A unit-named
    // marker is reachable here: the team report path has no stage-level guard and a
    // guard-recovery ask carries the refusal's unit. Only the state's unit cache, which
    // the hook never reads, is dropped.
    const marker = { marker: { kind: "ask", stage: "code-generation", unit: "unit-a" } };
    expect(
      resolvePosition({
        ...base,
        unitStage: "functional-design",
        activeUnit: "unit-b",
        stageLevel: true,
        marker,
      }),
    ).toEqual({
      stage: "code-generation",
      unit: "unit-a",
      basis: "directive",
      verified: true,
      leftoverUnit: { unit: "unit-b", stage: "functional-design" },
    });
  });

  const STATE = (runtime: string) =>
    `## Runtime State\n- **Construction Iteration**: unit-major\n${runtime}\n## Current Status\n- **Current Stage**: code-generation\n\n## Stage Progress\n### CONSTRUCTION PHASE\n- [-] code-generation — EXECUTE\n`;
  const empty: QuestionsReport = {
    files: [],
    blocked: [],
    totalQuestions: 0,
    totalUnanswered: 0,
    unclosed: [],
    unreadable: [],
  };
  const pos = { stage: "code-generation", basis: "current-stage" as const, verified: true };
  const w = (runtime: string, stageLevel: boolean) =>
    buildWaits({
      state: parseState(STATE(runtime)),
      position: pos,
      marker: { miss: "absent" },
      events: [],
      questions: empty,
      checkoutParkFile: false,
      hookHeartbeats: { present: false, stamps: [] },
      blockers: [],
      marks: {},
      now: "2026-10-09T12:00:00Z",
      stageLevel,
    });
  const PAUSED =
    "- **Active Unit**: unit-a\n- **Unit Stage**: code-generation\n- **Unit State**: paused\n- **Unit Pause Reason**: 외부 API 키 대기\n- **Unit Next Action**: 키를 받으면 resume";

  test("a leftover paused unit is not a wait, and is said as a leftover", () => {
    // The engine's only hold on a paused unit is its `unit-paused` ask, issued from the
    // per-unit routers after their stage-level return — so at stage level nothing asks.
    expect(w(PAUSED, false).unitPaused?.unit).toBe("unit-a");
    const at = w(PAUSED, true);
    expect(at.unitPaused).toBeUndefined();
    expect(at.unitCacheLeftover).toEqual({
      unit: "unit-a",
      stage: "code-generation",
      paused: true,
    });
    expect(w("", true).unitCacheLeftover).toBeUndefined();
  });

  test("with no marker, a leftover unit cache does not scope a decision to a unit", () => {
    // The hook scopes a decision by `directive.unit ?? marker.unit` and never by the
    // state's unit cache. With neither naming a unit, a team run on a `[-]` row reads the
    // stage's own decision (`openDecisionBlock`). Per unit, the dashboard's position
    // took the cache's unit and read a team-scoped attempt the stage's row is not in.
    const stateText = `## Project Information\n- **Unit Ownership**: team\n${STATE(PAUSED)}`;
    const row = (event: string, fields: Record<string, string>): AuditEvent => ({
      ts: event === "STAGE_STARTED" ? "2026-10-09T00:00:00Z" : "2026-10-09T01:00:00Z",
      event,
      fields: { Stage: "code-generation", ...fields },
      shard: "a",
    });
    const events = [
      row("STAGE_STARTED", {}),
      row("DECISION_RECORDED", { Checkpoint: "Anything to add?", Decision: "pending" }),
    ];
    const run = (stageLevel: boolean) => {
      const state = parseState(stateText);
      const position = resolvePosition({
        currentStage: state.currentStage,
        unitStage: state.runtime.unitStage,
        activeUnit: state.runtime.activeUnit,
        constructionIteration: state.constructionIteration ?? "",
        marker: { miss: "absent" },
        stageLevel,
      });
      return buildWaits({
        state,
        position,
        marker: { miss: "absent" },
        events,
        questions: empty,
        checkoutParkFile: false,
        hookHeartbeats: { present: false, stamps: [] },
        blockers: [],
        marks: {},
        now: "2026-10-09T12:00:00Z",
        stageLevel,
      });
    };
    expect(run(false).decision).toBeUndefined();
    expect(run(true).decision).toMatchObject({
      stage: "code-generation",
      checkpoint: "Anything to add?",
    });
    expect(run(true).decision?.unit).toBeUndefined();
  });

  test("a current marker's unit still scopes a decision at stage level", () => {
    const stateText = `## Project Information\n- **Unit Ownership**: team\n${STATE("")}`;
    const events: AuditEvent[] = [
      {
        ts: "2026-10-09T00:00:00Z",
        event: "STAGE_STARTED",
        fields: { Stage: "code-generation" },
        shard: "a",
      },
      {
        ts: "2026-10-09T01:00:00Z",
        event: "DECISION_RECORDED",
        fields: { Stage: "code-generation", Checkpoint: "Anything to add?", Decision: "pending" },
        shard: "a",
      },
    ];
    const at = buildWaits({
      state: parseState(stateText),
      position: { stage: "code-generation", unit: "unit-a", basis: "directive", verified: true },
      marker: { marker: { kind: "ask", stage: "code-generation", unit: "unit-a" } },
      events,
      questions: empty,
      checkoutParkFile: false,
      hookHeartbeats: { present: false, stamps: [] },
      blockers: [],
      marks: {},
      now: "2026-10-09T12:00:00Z",
      stageLevel: true,
    });
    // The hook reads unit-a's workflow attempt, where a row with no Unit is not — so the
    // stage's decision is not what it waits on.
    expect(at.decision).toBeUndefined();
  });
});
