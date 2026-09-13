/**
 * PollingScheduler 테스트 — 즉시1회·tick 실패 격리·중복 start 무시·start/stop 정리를 검증한다.
 * 실제 시각·CLI를 호출하지 않도록 pipeline 스텁과 짧은 intervalMs를 주입한다(NFR5).
 * aidlc-dashboard 네이티브 트리로 흡수한 포팅본.
 */

import { describe, expect, test } from "bun:test";
import type { CaptureSource } from "../types";
import { type Pollable, PollingScheduler } from "./polling-scheduler";
import type { RefreshResult } from "./refresh-pipeline";

function fakeResult(): RefreshResult {
  return {
    snapshot: {
      capturedAt: "2026-08-01T00:00:00.000Z",
      sequence: 0,
      source: "auto",
      ok: false,
      raw: "",
      reason: "x",
    },
    persisted: true,
  };
}

/** 성공 스냅샷 결과. `fakeResult()` 는 실패(ok:false)이므로 대비용으로 둔다. */
function okResult(): RefreshResult {
  return {
    snapshot: {
      capturedAt: "2026-08-01T00:00:00.000Z",
      sequence: 1,
      source: "auto",
      ok: true,
      data: {} as never,
    },
    persisted: true,
  };
}

/** 다음 마이크로태스크/타이머 큐를 비우기 위한 짧은 지연. */
function tickDelay(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PollingScheduler", () => {
  test("tick은 파이프라인을 source='auto'로 호출한다", async () => {
    const calls: CaptureSource[] = [];
    const pipeline: Pollable = {
      run: async (source) => {
        calls.push(source);
        return fakeResult();
      },
    };
    const scheduler = new PollingScheduler({ pipeline });
    await scheduler.tick();
    expect(calls).toEqual(["auto"]);
  });

  test("start(runImmediately=true)는 즉시 1회 tick을 실행한다", async () => {
    let count = 0;
    const pipeline: Pollable = {
      run: async () => {
        count += 1;
        return fakeResult();
      },
    };
    // 즉시 실행만 관측하도록 주기는 크게 잡는다.
    const scheduler = new PollingScheduler({ pipeline, intervalMs: 60_000 });
    scheduler.start(true);
    await tickDelay();
    scheduler.stop();
    expect(count).toBe(1);
  });

  test("파이프라인이 throw해도 tick은 예외를 격리한다(onError 호출, 다음 주기 지속)", async () => {
    let errored = false;
    const pipeline: Pollable = {
      run: async () => {
        throw new Error("boom");
      },
    };
    const scheduler = new PollingScheduler({
      pipeline,
      onError: () => {
        errored = true;
      },
    });
    // tick 자체가 reject하지 않아야 한다.
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(errored).toBe(true);
  });

  test("중복 start는 무시된다(단일 타이머, stop 한 번으로 정지)", () => {
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({ pipeline, intervalMs: 60_000 });
    scheduler.start();
    scheduler.start(); // 무시되어야 함
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    // 중복 타이머가 남아있지 않으므로 stop 한 번으로 정지.
    expect(scheduler.running).toBe(false);
  });

  test("start/stop이 running 상태를 토글한다", () => {
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({ pipeline, intervalMs: 60_000 });
    expect(scheduler.running).toBe(false);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  test("onTick 콜백이 성공 결과를 받는다", async () => {
    let received: RefreshResult | null = null;
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({
      pipeline,
      onTick: (r) => {
        received = r;
      },
    });
    await scheduler.tick();
    expect(received).not.toBeNull();
  });

  // 실패한 수집은 공짜가 아니다 — kiro-cli 기동 + 모델 호출을 부른다(모듈 주석의 실측).
  // 그래서 상류가 깨진 상태에서 5분마다 영원히 재시도하지 않는다.
  test("연속 실패가 임계치에 닿으면 멈추지 않고 감속한다 — 스스로 낫기 위해서다", async () => {
    const halts: unknown[] = [];
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({
      pipeline,
      intervalMs: 60_000,
      slowIntervalMs: 600_000,
      maxConsecutiveFailures: 3,
      onHalt: (h) => halts.push(h),
    });
    scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.halt).toBeNull();
    await scheduler.tick();
    // ACP 실패는 모델을 부르지 않으므로 영구 정지는 값만 잃는다 — 타이머는 계속 돈다.
    expect(scheduler.running).toBe(true);
    expect(scheduler.halt).toEqual({
      failures: 3,
      retryEveryMs: 600_000,
      lastReason: "x",
    });
    expect(halts).toHaveLength(1);
    // 이미 감속한 뒤의 추가 실패가 콜백을 다시 부르지 않는다.
    await scheduler.tick();
    expect(halts).toHaveLength(1);
    scheduler.stop();
  });

  test("감속 뒤 한 번 성공하면 감속이 풀린다", async () => {
    let ok = false;
    const pipeline: Pollable = { run: async () => (ok ? okResult() : fakeResult()) };
    const scheduler = new PollingScheduler({
      pipeline,
      intervalMs: 60_000,
      slowIntervalMs: 600_000,
      maxConsecutiveFailures: 2,
    });
    scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.halt?.retryEveryMs).toBe(600_000);
    ok = true;
    await scheduler.tick();
    expect(scheduler.halt).toBeNull();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
  });

  test("성공이 끼면 연속 카운터가 초기화된다 — 일시적 실패로는 멈추지 않는다", async () => {
    let succeed = false;
    const pipeline: Pollable = { run: async () => (succeed ? okResult() : fakeResult()) };
    const scheduler = new PollingScheduler({ pipeline, maxConsecutiveFailures: 3 });
    scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    succeed = true;
    await scheduler.tick();
    succeed = false;
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.running).toBe(true);
    expect(scheduler.halt).toBeNull();
  });

  test("tick 이 예외로 끝나도 연속 실패로 센다 — 값을 못 가져온 건 같다", async () => {
    const pipeline: Pollable = {
      run: () => Promise.reject(new Error("boom")),
    };
    const scheduler = new PollingScheduler({ pipeline, maxConsecutiveFailures: 2 });
    scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.halt?.failures).toBe(2);
    scheduler.stop();
  });

  test("저장 실패(persisted:false)는 성공으로 세지 않는다", async () => {
    // 화면은 갱신되지 않으므로 수집이 성공했다고 말할 수 없다. 그러지 않으면 DB 가 쓰기
    // 불능인 채로 감속이 풀리고 원래 주기로 계속 두드린다.
    const pipeline: Pollable = {
      run: async () => ({ ...okResult(), persisted: false, persistError: "disk full" }),
    };
    const scheduler = new PollingScheduler({ pipeline, maxConsecutiveFailures: 2 });
    scheduler.start();
    await scheduler.tick();
    await scheduler.tick();
    expect(scheduler.halt?.failures).toBe(2);
    scheduler.stop();
  });

  test("maxConsecutiveFailures<=0 이면 멈추지 않는다", async () => {
    const pipeline: Pollable = { run: async () => fakeResult() };
    const scheduler = new PollingScheduler({ pipeline, maxConsecutiveFailures: 0 });
    scheduler.start();
    for (let i = 0; i < 20; i++) await scheduler.tick();
    expect(scheduler.running).toBe(true);
    expect(scheduler.halt).toBeNull();
    scheduler.stop();
  });
});
