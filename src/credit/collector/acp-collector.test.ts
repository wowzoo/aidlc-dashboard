/**
 * acp-collector 단위 테스트. `AcpRpc` 를 주입해 실제 `kiro-cli` 를 부르지 않는다.
 *
 * 실제 응답 모양은 라이브에서 떠 온 것을 그대로 쓴다 — 이 확장은 문서화되지 않은 채 실험적이라,
 * 우리가 상상한 스키마가 아니라 관측된 스키마에 대고 테스트해야 의미가 있다.
 */

import { describe, expect, test } from "bun:test";
import {
  type AcpResponse,
  type AcpRpc,
  type AcpSessionRef,
  collectUsageViaAcp,
  mapAcpUsage,
  spawnAcpRpc,
} from "./acp-collector";

/** 라이브에서 관측한 `/usage` 응답의 `data` (2026-09-12). */
function liveData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planName: "KIRO POWER",
    billingCycleReset: "2026-10-01",
    overagesEnabled: true,
    isEnterprise: true,
    usageBreakdowns: [
      {
        resourceType: "CREDIT",
        displayName: "Credits",
        used: 7609.69,
        limit: 10000,
        percentage: 76.0969,
        currentOverages: 0,
        overageRate: 0.04,
        overageCharges: 0,
        currency: "USD",
        hasLimit: true,
      },
    ],
    bonusCredits: [],
    addOnCredits: [],
    overageCapable: true,
    ...over,
  };
}

/** 호출 순서를 기록하고 대본대로 답하는 RPC 스텁. */
function stubRpc(script: Record<string, AcpResponse | ((p: unknown) => AcpResponse)>): {
  rpc: AcpRpc;
  calls: { method: string; params: unknown }[];
  closed: () => number;
} {
  const calls: { method: string; params: unknown }[] = [];
  let closes = 0;
  return {
    calls,
    closed: () => closes,
    rpc: {
      call(method, params) {
        calls.push({ method, params });
        const entry = script[method];
        if (entry === undefined)
          return Promise.resolve({ error: { message: `no stub: ${method}` } });
        return Promise.resolve(typeof entry === "function" ? entry(params) : entry);
      },
      close() {
        closes++;
      },
    },
  };
}

const OK_SCRIPT = {
  initialize: { result: {} },
  "session/new": { result: { sessionId: "sess-1" } },
  "session/load": { result: {} },
  "_kiro.dev/commands/execute": { result: { success: true, data: liveData() } },
};

describe("mapAcpUsage", () => {
  test("관측된 응답을 ParsedUsage 로 옮긴다", () => {
    const r = mapAcpUsage(liveData());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({
      planName: "KIRO POWER",
      usedAmount: 7609.69,
      // 뺄셈이 만든 자리는 버린다 — 원본이 소수 2자리다.
      remainingAmount: 2390.31,
      planLimit: 10000,
      // Kiro 가 준 percentage 를 0~1 로만 옮긴다(used/limit 로 재계산하지 않는다).
      usageRatio: 0.760969,
      resetDate: "2026-10-01",
      partial: false,
    });
  });

  test("CREDIT breakdown 을 이름으로 찾는다 — 배열 첫 항목을 집지 않는다", () => {
    const r = mapAcpUsage(
      liveData({
        usageBreakdowns: [
          { resourceType: "SOMETHING_ELSE", used: 1, limit: 2, percentage: 50, hasLimit: true },
          liveData().usageBreakdowns as never,
        ].flat(),
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.usedAmount).toBe(7609.69);
  });

  test("CREDIT 항목이 없으면 포맷 변경으로 실패한다", () => {
    const r = mapAcpUsage(liveData({ usageBreakdowns: [{ resourceType: "TOKENS", used: 5 }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("CREDIT");
  });

  test("used 가 없으면 성공이라 부르지 않는다 — 게이지의 분자다", () => {
    const r = mapAcpUsage(
      liveData({ usageBreakdowns: [{ resourceType: "CREDIT", limit: 10000, hasLimit: true }] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("포맷 변경");
  });

  test("hasLimit=false 면 한도·잔량은 null 이고 partial 이 선다", () => {
    const r = mapAcpUsage(
      liveData({
        usageBreakdowns: [
          { resourceType: "CREDIT", used: 12.5, limit: 0, percentage: 0, hasLimit: false },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.planLimit).toBeNull();
    expect(r.data.remainingAmount).toBeNull();
    expect(r.data.partial).toBe(true);
  });

  test("구조가 아예 다르면 실패한다", () => {
    expect(mapAcpUsage(null).ok).toBe(false);
    expect(mapAcpUsage("Estimated Usage | ...").ok).toBe(false);
    expect(mapAcpUsage({}).ok).toBe(false);
  });
});

describe("collectUsageViaAcp", () => {
  test("initialize → session/new → commands/execute 순서로 부르고 닫는다", async () => {
    const s = stubRpc(OK_SCRIPT);
    const r = await collectUsageViaAcp({ rpc: s.rpc });
    expect(r.ok).toBe(true);
    expect(s.calls.map((c) => c.method)).toEqual([
      "initialize",
      "session/new",
      "_kiro.dev/commands/execute",
    ]);
    // 이중 중첩된 TuiCommand — serde 가 이 모양만 받는다.
    expect(s.calls[2]?.params).toMatchObject({
      sessionId: "sess-1",
      command: { command: "usage", args: {} },
    });
    expect(s.closed()).toBe(1);
  });

  test("세션 id 를 기억하고 다음 호출은 session/load 로 재사용한다", async () => {
    const session: AcpSessionRef = {};
    const first = stubRpc(OK_SCRIPT);
    await collectUsageViaAcp({ rpc: first.rpc, session });
    expect(session.id).toBe("sess-1");

    const second = stubRpc(OK_SCRIPT);
    await collectUsageViaAcp({ rpc: second.rpc, session });
    // session/new 를 다시 부르지 않는다 — 그게 `~/.kiro/sessions/cli/` 누적을 막는 지점이다.
    expect(second.calls.map((c) => c.method)).toEqual([
      "initialize",
      "session/load",
      "_kiro.dev/commands/execute",
    ]);
  });

  test("session/load 가 실패하면 새 세션으로 한 번 되돌아간다", async () => {
    const session: AcpSessionRef = { id: "stale" };
    const s = stubRpc({ ...OK_SCRIPT, "session/load": { error: { message: "not found" } } });
    const r = await collectUsageViaAcp({ rpc: s.rpc, session });
    expect(r.ok).toBe(true);
    expect(s.calls.map((c) => c.method)).toEqual([
      "initialize",
      "session/load",
      "session/new",
      "_kiro.dev/commands/execute",
    ]);
    expect(session.id).toBe("sess-1");
  });

  test("각 단계의 JSON-RPC 오류가 사유를 밝히며 실패로 온다", async () => {
    for (const [method, needle] of [
      ["initialize", "initialize"],
      ["session/new", "session/new"],
      ["_kiro.dev/commands/execute", "/usage 실행 거부"],
    ] as const) {
      const s = stubRpc({ ...OK_SCRIPT, [method]: { error: { message: "boom" } } });
      const r = await collectUsageViaAcp({ rpc: s.rpc });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(needle);
      // 실패해도 연결은 닫는다.
      expect(s.closed()).toBe(1);
    }
  });

  test("success 가 true 가 아니면 실패로 다루고 message 를 원문으로 남긴다", async () => {
    const s = stubRpc({
      ...OK_SCRIPT,
      "_kiro.dev/commands/execute": { result: { success: false, message: "not signed in" } },
    });
    const r = await collectUsageViaAcp({ rpc: s.rpc });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.raw).toBe("not signed in");
      expect(r.reason).toContain("성공을 보고하지 않았");
    }
  });

  test("sessionId 가 없는 session/new 응답은 포맷 변경으로 실패한다", async () => {
    const s = stubRpc({ ...OK_SCRIPT, "session/new": { result: {} } });
    const r = await collectUsageViaAcp({ rpc: s.rpc });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("sessionId");
  });
});

describe("mapAcpUsage 의 결측 대 오타입", () => {
  test("결측은 null + partial 로 살린다 — 나머지 값을 버리지 않는다", () => {
    // 필드를 아예 빼서 결측을 만든다(undefined 할당이 아니라 실제 부재).
    const { planName: _p, billingCycleReset: _b, ...withoutBoth } = liveData();
    const r = mapAcpUsage(withoutBoth);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.planName).toBeNull();
    expect(r.data.resetDate).toBeNull();
    expect(r.data.usedAmount).toBe(7609.69); // 살아 있다
    expect(r.data.partial).toBe(true);
  });

  test("오타입은 손상으로 거부한다 — 조용히 null 로 접으면 포맷 변경을 못 말한다", () => {
    for (const [patch, field] of [
      [{ planName: 7 }, "planName"],
      [{ billingCycleReset: 20261001 }, "billingCycleReset"],
    ] as const) {
      const r = mapAcpUsage(liveData(patch));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(field);
    }
    for (const [key, field] of [
      ["used", "used"],
      ["limit", "limit"],
      ["percentage", "percentage"],
      ["hasLimit", "hasLimit"],
    ] as const) {
      const b = { ...(liveData().usageBreakdowns as Record<string, unknown>[])[0] };
      b[key] = "많이";
      const r = mapAcpUsage(liveData({ usageBreakdowns: [b] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(field);
    }
  });
});

describe("spawnAcpRpc (실제 프로세스)", () => {
  /** 대본을 아는 가짜 에이전트. `argv` 주입으로 끼우므로 전역을 건드리지 않는다. */
  const fakeAgent = (script: string): readonly string[] => [process.execPath, "-e", script];
  const ENV = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

  test("응답을 id 로 짝지어 돌려준다 — 알림과 비JSON 줄은 흘려보낸다", async () => {
    // stdin 을 기다리지 않고 타이머로 답한다. 검증 대상은 프레이밍·id 짝짓기이고, stdin 왕복은
    // 데드라인 테스트와 라이브 e2e 가 각각 덮는다.
    const rpc = spawnAcpRpc(
      3_000,
      ENV,
      fakeAgent(`
        const NL = String.fromCharCode(10);
        setTimeout(() => {
          process.stdout.write("이건 JSON 이 아니다" + NL);
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "_kiro.dev/notify", params: {} }) + NL);
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: { ok: 1 } }) + NL);
        }, 30);
        setTimeout(() => {}, 5000);
      `),
    );
    const r = await rpc.call("initialize", {});
    rpc.close();
    expect(r.result).toEqual({ ok: 1 });
  });

  test("한 줄이 여러 chunk 로 쪼개져 와도 조립한다 — 멀티바이트 경계 포함", async () => {
    const rpc = spawnAcpRpc(
      3_000,
      ENV,
      fakeAgent(`
        const NL = String.fromCharCode(10);
        const msg = JSON.stringify({ jsonrpc: "2.0", id: 0, result: { 값: "여러 chunk 에 걸친 한글" } });
        setTimeout(() => {
          const mid = Math.floor(msg.length / 2);
          process.stdout.write(msg.slice(0, mid));
          setTimeout(() => process.stdout.write(msg.slice(mid) + NL), 60);
        }, 30);
        setTimeout(() => {}, 5000);
      `),
    );
    const r = await rpc.call("initialize", {});
    rpc.close();
    expect(r.result).toEqual({ 값: "여러 chunk 에 걸친 한글" });
  });

  test("응답이 없으면 데드라인이 정산한다 — stdout EOF 를 기다리지 않는다", async () => {
    // 이 파일에서 가장 중요한 테스트다: 손자가 stdout 을 물고 있으면 EOF 가 오지 않고, 예전
    // 구현은 여기서 영구 대기해 스케줄러의 `inFlight` 를 세운 채 폴링을 조용히 죽였다.
    const rpc = spawnAcpRpc(600, ENV, fakeAgent("setTimeout(() => {}, 60000);"));
    const t = Date.now();
    const r = await rpc.call("initialize", {});
    const elapsed = Date.now() - t;
    rpc.close();
    expect(r.error?.message).toContain("타임아웃");
    expect(elapsed).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(3_000);
  });

  test("close() 가 대기 중인 호출을 즉시 정산하고, 이후 호출도 즉시 답한다", async () => {
    const rpc = spawnAcpRpc(30_000, ENV, fakeAgent("setTimeout(() => {}, 60000);"));
    const p = rpc.call("initialize", {});
    rpc.close();
    expect((await p).error?.message).toContain("닫혔");
    expect((await rpc.call("initialize", {})).error?.message).toContain("닫힌");
  });

  test("자식이 응답 없이 죽으면 그 사실로 정산한다 — 영구 대기 금지", async () => {
    const rpc = spawnAcpRpc(10_000, ENV, fakeAgent("process.exit(3);"));
    const r = await rpc.call("initialize", {});
    rpc.close();
    expect(r.error?.message).toBeDefined();
  });
});
