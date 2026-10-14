// Open decisions (scan/decision-wait.ts) and the turn-shape readings beside them
// (model/waits.ts). The decision readers transcribe the engine's `openDecisionBlock`
// and `hasPendingDecision(…, workflowAttempt)`; both were run against the engine's
// own source on 20,000 random ledgers each with no disagreement (measured
// 2026-10-09), and the cases below pin the rules that comparison exercised.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { buildWaits } from "../model/waits";
import { strings } from "../render/i18n";
import { renderRunHealth } from "../render/status";
import type { AuditEvent } from "../scan/audit";
import { parseAuditShard } from "../scan/audit";
import { openDecision, openDecisionInAttempt } from "../scan/decision-wait";
import { readHealth } from "../scan/hooks-health";
import { parseState } from "../scan/parser";
import type { QuestionsReport } from "../scan/questions";

let n = 0;
const ev = (
  event: string,
  fields: Record<string, string> = {},
  shard = "a",
  ts?: string,
): AuditEvent => ({
  ts: ts ?? `2026-10-09T0${Math.floor(n / 60)}:${String(n++ % 60).padStart(2, "0")}:00Z`,
  event,
  fields: { Stage: "requirements-analysis", ...fields },
  shard,
});
const START = () => ev("STAGE_STARTED");
const ASK = (f: Record<string, string> = {}) =>
  ev("DECISION_RECORDED", { Checkpoint: "Learnings", Decision: "보존할 학습 후보", ...f });

describe("open decision — ordinary stage window", () => {
  test("opens on DECISION_RECORDED after the stage started, and any closing receipt closes it", () => {
    const ask = ASK();
    expect(openDecision([START(), ask], "requirements-analysis")).toEqual({
      stage: "requirements-analysis",
      checkpoint: "Learnings",
      decision: "보존할 학습 후보",
      since: ask.ts,
    });
    for (const close of [
      "QUESTION_ANSWERED",
      "SUMMARY_CONFIRMATION_RECORDED",
      "VERIFICATION_COMMAND_RECORDED",
      "CONSTRUCTION_POLICY_RECORDED",
      "PLAN_APPROVAL_RECORDED",
    ]) {
      expect(openDecision([START(), ASK(), ev(close)], "requirements-analysis")).toBeUndefined();
    }
  });

  test("no main-workflow start means no window; a single-stage start does not reset it", () => {
    expect(openDecision([ASK()], "requirements-analysis")).toBeUndefined();
    const single = ev("STAGE_STARTED", { Workflow: "single-stage:abc" });
    // The decision before the single-stage start is still inside the window.
    expect(openDecision([START(), ASK(), single], "requirements-analysis")).toBeDefined();
    // A new main-workflow start drops an earlier attempt's open decision.
    expect(openDecision([START(), ASK(), START()], "requirements-analysis")).toBeUndefined();
  });

  test("another stage's receipt does not close it", () => {
    const other = ev("QUESTION_ANSWERED", { Stage: "user-stories" });
    expect(openDecision([START(), ASK(), other], "requirements-analysis")).toBeDefined();
  });

  test("a gate row closes only its own checkpoint, key, kind and fingerprint", () => {
    const unitAsk = (f: Record<string, string> = {}) =>
      ASK({ Checkpoint: "Construction Unit Approval", Unit: "u1", Kind: "unit", ...f });
    const gate = (f: Record<string, string>) =>
      ev("GATE_APPROVED", { Checkpoint: "construction-unit", Unit: "u1", ...f });
    expect(openDecision([START(), unitAsk(), gate({})], "requirements-analysis")).toBeUndefined();
    // An ordinary stage gate is not this checkpoint's answer.
    expect(
      openDecision([START(), unitAsk(), ev("GATE_APPROVED")], "requirements-analysis"),
    ).toBeDefined();
    expect(
      openDecision([START(), unitAsk(), gate({ Unit: "u2" })], "requirements-analysis"),
    ).toBeDefined();
    expect(
      openDecision(
        [START(), unitAsk(), gate({ Checkpoint: "walking-skeleton" })],
        "requirements-analysis",
      ),
    ).toBeDefined();
    // A receipt for earlier evidence cannot answer a fingerprinted ask.
    expect(
      openDecision(
        [START(), unitAsk({ Fingerprint: "f2" }), gate({ Fingerprint: "f1" })],
        "requirements-analysis",
      ),
    ).toBeDefined();
    const batch = ASK({ Checkpoint: "Swarm Batch Approval", "Batch number": "1" });
    expect(
      openDecision(
        [START(), batch, ev("GATE_REJECTED", { Checkpoint: "swarm-batch", "Batch number": "1" })],
        "requirements-analysis",
      ),
    ).toBeUndefined();
  });
});

describe("open decision — attempt mode", () => {
  const ORDER = ["requirements-analysis", "functional-design", "code-generation"];
  const idx = (s: string) => ORDER.indexOf(s);

  test("the window starts at the last workflow start or a jump that reaches the stage", () => {
    expect(openDecisionInAttempt([ASK()], "requirements-analysis", undefined, idx)).toBeDefined();
    expect(
      openDecisionInAttempt(
        [ASK(), ev("WORKFLOW_STARTED")],
        "requirements-analysis",
        undefined,
        idx,
      ),
    ).toBeUndefined();
    // A jump to a later stage does not reach this one: the decision stands.
    const later = ev("STAGE_JUMPED", { Stage: "x", Target: "code-generation" });
    expect(
      openDecisionInAttempt([ASK(), later], "requirements-analysis", undefined, idx),
    ).toBeDefined();
    const back = ev("STAGE_JUMPED", { Stage: "x", Target: "requirements-analysis" });
    expect(
      openDecisionInAttempt([ASK(), back], "requirements-analysis", undefined, idx),
    ).toBeUndefined();
  });

  test("a unit filter reads only that unit's rows", () => {
    const ask = ASK({ Unit: "u1" });
    expect(openDecisionInAttempt([ask], "requirements-analysis", "u1", idx)).toBeDefined();
    expect(openDecisionInAttempt([ask], "requirements-analysis", "u2", idx)).toBeUndefined();
  });

  test("several shards writing several kinds in one second are unordered and clear it", () => {
    const t = "2026-10-09T09:00:00Z";
    const rows = [
      ASK({}),
      ev("DECISION_RECORDED", {}, "a", t),
      ev("QUESTION_ANSWERED", {}, "b", t),
    ];
    expect(openDecisionInAttempt(rows, "requirements-analysis", undefined, idx)).toBeUndefined();
  });
});

describe("waits — decisions, compose, turn shape, hooks", () => {
  const STATE = (row: string, runtime = "") =>
    `## Runtime State\n${runtime}\n## Current Status\n- **Current Stage**: requirements-analysis\n\n## Stage Progress\n### INCEPTION PHASE\n${row}\n`;
  const ACTIVE = "- [-] requirements-analysis — EXECUTE";
  const pos = { stage: "requirements-analysis", basis: "current-stage" as const, verified: true };
  const empty: QuestionsReport = {
    files: [],
    blocked: [],
    totalQuestions: 0,
    totalUnanswered: 0,
    unclosed: [],
    unreadable: [],
  };
  const NOW = "2026-10-09T12:00:00Z";
  const w = (stateText: string, extra: Partial<Parameters<typeof buildWaits>[0]> = {}) =>
    buildWaits({
      state: parseState(stateText),
      position: pos,
      marker: { miss: "absent" },
      events: [],
      questions: empty,
      checkoutParkFile: false,
      hookHeartbeats: { present: false, stamps: [] },
      blockers: [],
      marks: {},
      now: NOW,
      ...extra,
    });
  const open = [START(), ASK()];

  test("an open decision holds the run only under the stop hook's preconditions", () => {
    expect(w(STATE(ACTIVE), { events: open }).decision?.checkpoint).toBe("Learnings");
    // Not while the row is not `[-]`, and never under autonomy.
    expect(
      w(STATE("- [?] requirements-analysis — EXECUTE"), { events: open }).decision,
    ).toBeUndefined();
    expect(
      w(STATE(ACTIVE, "- **Construction Autonomy Mode**: autonomous"), { events: open }).decision,
    ).toBeUndefined();
  });

  test("a stage running ahead of Current Stage is read in attempt mode", () => {
    const ahead = {
      stage: "code-generation",
      basis: "unit-stage" as const,
      unit: "u1",
      verified: true,
    };
    const events = [
      ev("DECISION_RECORDED", {
        Stage: "code-generation",
        Checkpoint: "Construction Unit Approval",
        Unit: "u1",
      }),
    ];
    expect(w(STATE(ACTIVE), { events, position: ahead }).decision?.stage).toBe("code-generation");
  });

  test("a plan approval decision is deduplicated only against the same unit's counted ask", () => {
    const PA = "Code Generation Plan Approval";
    const blocker = (unit: string | undefined, isCurrentStage = true) => ({
      stage: "requirements-analysis",
      unit,
      heading: "Plan Approval",
      kind: "confirmation" as const,
      rel: "x",
      since: NOW,
      isCurrentStage,
    });
    const one = [START(), ASK({ Checkpoint: PA, Unit: "u1" })];
    expect(w(STATE(ACTIVE), { events: one, blockers: [blocker("u1")] }).decision).toBeUndefined();
    // Second review: another unit's file, or an earlier leftover, deleted the decision.
    expect(w(STATE(ACTIVE), { events: one, blockers: [blocker("u2")] }).decision).toBeDefined();
    expect(
      w(STATE(ACTIVE), { events: one, blockers: [blocker("u1", false)] }).decision,
    ).toBeDefined();
    // A batch decision names its members in `Units`.
    const batch = [START(), ASK({ Checkpoint: PA, Units: "u1, u2" })];
    expect(w(STATE(ACTIVE), { events: batch, blockers: [blocker("u2")] }).decision).toBeUndefined();
    expect(w(STATE(ACTIVE), { events: batch, blockers: [blocker("u9")] }).decision).toBeDefined();
    // The checkpoint is matched exactly, not by a substring.
    const near = [START(), ASK({ Checkpoint: "Plan Approval Notes", Unit: "u1" })];
    expect(w(STATE(ACTIVE), { events: near, blockers: [blocker("u1")] }).decision).toBeDefined();
  });

  test("a compose marker counts while fresh and not under autonomy", () => {
    const hour = 60 * 60 * 1000;
    const fresh = Date.parse(NOW) - hour;
    expect(w(STATE(ACTIVE), { marks: { compose: fresh } }).compose).toEqual({
      since: "2026-10-09T11:00:00Z",
    });
    expect(
      w(STATE(ACTIVE), { marks: { compose: Date.parse(NOW) - 25 * hour } }).compose,
    ).toBeUndefined();
    expect(
      w(STATE(ACTIVE, "- **Construction Autonomy Mode**: autonomous"), {
        marks: { compose: fresh },
      }).compose,
    ).toBeUndefined();
  });

  test("the turn ended only when both markers exist and turn-end is newer", () => {
    expect(w(STATE(ACTIVE), { marks: { turnEnd: 2, humanTurn: 1 } }).turnEnded).toBe(true);
    expect(w(STATE(ACTIVE), { marks: { turnEnd: 1, humanTurn: 2 } }).turnEnded).toBe(false);
    expect(w(STATE(ACTIVE), { marks: { turnEnd: 2 } }).turnEnded).toBe(false);
  });

  test("hook liveness: stale beyond five minutes, never fired, live, unknown", () => {
    const stage = (ts: string) => ev("STAGE_COMPLETED", {}, "a", ts);
    const at = (h: string) => `2026-10-09T${h}Z`;
    const hb = (...stamps: string[]) => ({ present: true, stamps });
    expect(
      w(STATE(ACTIVE), { events: [stage(at("10:06:00"))], hookHeartbeats: hb(at("10:00:00")) })
        .hooks,
    ).toEqual({
      state: "stale",
      heartbeat: at("10:00:00"),
      event: at("10:06:00"),
    });
    expect(
      w(STATE(ACTIVE), { events: [stage(at("10:04:00"))], hookHeartbeats: hb(at("10:00:00")) })
        .hooks,
    ).toEqual({
      state: "live",
    });
    expect(
      w(STATE(ACTIVE), {
        events: [stage(at("10:04:00"))],
        hookHeartbeats: { present: false, stamps: [] },
      }).hooks,
    ).toEqual({ state: "never", event: at("10:04:00") });
    // A `.last` that exists but holds no timestamp is not "never fired" (engine `neverFired`).
    expect(
      w(STATE(ACTIVE), { events: [stage(at("10:04:00"))], hookHeartbeats: hb() }).hooks,
    ).toEqual({
      state: "unknown",
    });
    expect(w(STATE(ACTIVE), { hookHeartbeats: hb(at("10:00:00")) }).hooks).toEqual({
      state: "unknown",
    });
  });
});

describe("waits on the page — decisions and turn shape", () => {
  const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
  const ko = strings("ko");

  test("a decision and a compose gate count; turn-ended, hooks and autonomy are shown only", () => {
    const base = assemble(FIXTURE);
    const m = {
      ...base,
      waits: {
        ...base.waits,
        decision: {
          stage: "code-generation",
          checkpoint: "Learnings",
          decision: "보존할 학습 후보",
          since: base.generatedAt,
        },
        compose: { since: base.generatedAt },
        turnEnded: true,
        autonomous: true,
      },
    };
    const html = renderRunHealth(m, ko);
    for (const text of [
      "결정 대기 — Learnings: 보존할 학습 후보",
      "작업 묶음(compose) 승인 대기",
      "엔진이 턴을 끝냄",
      "hook 이 멈춘 듯함",
      "자율 모드",
    ]) {
      expect(html).toContain(text);
    }
    // 1 current ask + decision + compose.
    expect(html).toContain('<b class="mc-n warn">3</b>');
  });
});

describe("second-review regressions — decisions", () => {
  test("audit fields are read as the engine reads them: bullets allowed, first value wins", () => {
    const shard = [
      "**Event**: STAGE_STARTED",
      "**Timestamp**: 2026-10-09T01:00:00Z",
      "- **Stage**: requirements-analysis",
      "---",
      "**Event**: DECISION_RECORDED",
      "**Timestamp**: 2026-10-09T01:01:00Z",
      "**Stage**: requirements-analysis",
      "**Stage**: user-stories",
      "**Checkpoint**: Construction Unit Approval",
      "**Unit**: u1",
      "**Fingerprint**: f1",
      "**Fingerprint**: f2",
      "---",
      "**Event**: GATE_APPROVED",
      "**Timestamp**: 2026-10-09T01:02:00Z",
      "**Stage**: requirements-analysis",
      "**Checkpoint**: construction-unit",
      "**Unit**: u1",
      "**Fingerprint**: f1",
    ].join("\n");
    const events = parseAuditShard(shard, "a");
    expect(events.map((e) => e.fields.Stage)).toEqual([
      "requirements-analysis",
      "requirements-analysis",
      "requirements-analysis",
    ]);
    // The first Fingerprint is f1, which the gate receipt matches: closed.
    expect(openDecision(events, "requirements-analysis")).toBeUndefined();
  });

  const STATE = (rows: string, runtime = "") =>
    `## Runtime State\n${runtime}\n## Current Status\n- **Current Stage**: functional-design\n\n## Stage Progress\n### CONSTRUCTION PHASE\n${rows}\n`;
  const base = (stateText: string, extra: Partial<Parameters<typeof buildWaits>[0]> = {}) =>
    buildWaits({
      state: parseState(stateText),
      position: { stage: "functional-design", basis: "current-stage", verified: true },
      marker: { miss: "absent" },
      events: [],
      questions: {
        files: [],
        blocked: [],
        totalQuestions: 0,
        totalUnanswered: 0,
        unclosed: [],
        unreadable: [],
      },
      blockers: [],
      checkoutParkFile: false,
      hookHeartbeats: { present: false, stamps: [] },
      marks: {},
      now: "2026-10-09T12:00:00Z",
      ...extra,
    });

  test("the decision scope follows a current directive over the unit cache", () => {
    const events = [
      ev("DECISION_RECORDED", {
        Stage: "code-generation",
        Unit: "u1",
        Checkpoint: "Construction Unit Approval",
      }),
    ];
    const cache = {
      stage: "code-generation",
      unit: "u1",
      basis: "unit-stage" as const,
      verified: false,
    };
    const marker = { marker: { kind: "run-stage", stage: "functional-design", unit: "u2" } };
    // Measured: the engine function given the marker's stage returns false.
    expect(
      base(STATE("- [-] functional-design — EXECUTE"), { events, position: cache, marker })
        .decision,
    ).toBeUndefined();
    // With the cache alone the decision is shown, marked unconfirmed.
    const alone = base(STATE("- [-] functional-design — EXECUTE"), { events, position: cache });
    expect(alone.decision?.scopeVerified).toBe(false);
  });

  test("the precondition reads the slug's FIRST row, as the engine does", () => {
    const events = [
      ev("STAGE_STARTED", { Stage: "functional-design" }),
      ev("DECISION_RECORDED", { Stage: "functional-design" }),
    ];
    const rows = "- [x] functional-design — EXECUTE\n- [-] functional-design — EXECUTE";
    expect(base(STATE(rows), { events }).decision).toBeUndefined();
  });

  test("a failing stage lookup or a bad compose stamp does not throw", () => {
    const jump = ev("STAGE_JUMPED", { Stage: "x", Target: "code-generation" });
    const boom = () => {
      throw new Error("x");
    };
    expect(() =>
      openDecisionInAttempt([ASK(), jump], "requirements-analysis", undefined, boom),
    ).not.toThrow();
    expect(() =>
      base(STATE("- [-] functional-design — EXECUTE"), {
        marks: { compose: Number.POSITIVE_INFINITY },
      }),
    ).not.toThrow();
  });
});

describe("second-review regressions — hooks-health and turn markers", () => {
  test("every .last counts as fired, marker-suffixed ones included; empty ones carry no stamp", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-hh-"));
    const hh = path.join(dir, ".aidlc-engine", "hooks-health");
    fs.mkdirSync(hh, { recursive: true });
    fs.writeFileSync(path.join(hh, "reviewer-scope.missing-record.last"), "2026-10-09T10:00:00Z");
    fs.writeFileSync(path.join(hh, "continue-workflow.last"), "");
    fs.writeFileSync(path.join(hh, "x.trace"), "2026-10-09T11:00:00Z");
    const h = readHealth(dir);
    expect(h.heartbeats).toEqual({ present: true, stamps: ["2026-10-09T10:00:00Z"] });
    // The hook list keeps excluding the marker (unchanged).
    expect(h.hooks.map((x) => x.name)).toEqual(["continue-workflow"]);
  });

  test("a turn marker reached through a symlink is not read", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-tm-"));
    fs.cpSync(path.join(import.meta.dir, "..", "..", "fixtures", "reference"), root, {
      recursive: true,
    });
    const rec = path.join(root, "aidlc/spaces/default/intents/260101-demo-migration/.aidlc-engine");
    fs.mkdirSync(rec, { recursive: true });
    const real = path.join(root, "real-turn-end");
    fs.writeFileSync(path.join(rec, "human-turn"), "");
    fs.writeFileSync(real, "");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(real, later, later);
    fs.symlinkSync(real, path.join(rec, "turn-end"));
    expect(assemble(root).waits.turnEnded).toBe(false);
  });
});
