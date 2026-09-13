/**
 * PollingScheduler — 기본 5분 주기로 새로고침 파이프라인을 자동 실행한다(BR4.1~BR4.4, FR5.1).
 *
 * aidlc-dashboard 네이티브 트리로 흡수한 포팅본. 파이프라인은 수동 새로고침과 공유한다(FR5.3).
 *
 * 실패 격리: 한 주기의 수집/저장이 실패해도 예외를 삼켜 다음 주기를 계속 유지한다(BR4.2).
 * `Pollable`·`SchedulerDeps`·`DEFAULT_INTERVAL_MS`는 u2 소유로 이 모듈에서 정의·export한다.
 */

import type { CaptureSource } from "../types";
import type { RefreshResult } from "./refresh-pipeline";

/** 기본 폴링 주기: 5분(FR5.1). */
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 연속 실패 몇 번에 폴링 주기를 늘릴지.
 *
 * **원래 이유는 비용이었고, 그 이유는 사라졌다.** 이 장치는 옛 수집기가 실패할 때마다 모델을
 * 호출했기 때문에 들어왔다(크레딧을 읽으려고 크레딧을 씀). ACP 로 바꾼 뒤로는 실패한 수집이
 * `kiro-cli acp` spawn 2초일 뿐 **모델 호출이 없다**. 그래서 "영구 정지"는 더 이상 정당하지
 * 않다 — 일시적인 네트워크·인증 장애가 25분 넘게 이어졌다는 이유로 자동 복구 능력을 영영
 * 버리는 셈이 된다(사람이 버튼을 눌러야 돌아온다).
 *
 * **그래서 정지가 아니라 감속이다.** 연속 실패가 임계치에 닿으면 주기를 `SLOW_INTERVAL_MS` 로
 * 늘리고, 한 번이라도 성공하면 원래 주기로 돌아온다. 깨진 상류를 5분마다 두드리지 않으면서도
 * 스스로 낫는다. 화면은 감속 사실과 마지막 사유를 말한다.
 */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

/** 감속 주기. 상류가 깨진 상태에서도 계속 살펴보되 30분에 한 번으로 줄인다. */
export const SLOW_INTERVAL_MS = 30 * 60 * 1000;

/** 자동 폴링이 감속된 사실과 그 근거. 화면이 "왜 갱신이 느려졌나"에 답하는 데 쓴다. */
export interface PollHalt {
  /** 감속하기까지 이어진 연속 실패 횟수. */
  failures: number;
  /** 마지막 실패의 사유(스냅샷의 `reason`, 없으면 tick 예외 문자열). */
  lastReason?: string;
  /** 지금 적용 중인 재시도 주기(ms). 정지가 아니라 감속임을 화면이 말할 수 있게 싣는다. */
  retryEveryMs: number;
}

/** 파이프라인의 최소 표면(테스트 주입 용이). */
export interface Pollable {
  run(source: CaptureSource): Promise<RefreshResult>;
}

export interface SchedulerDeps {
  pipeline: Pollable;
  /** 폴링 주기(ms). 기본 5분. */
  intervalMs?: number;
  /** 각 성공 tick 후 콜백(선택). */
  onTick?: (result: RefreshResult) => void;
  /** tick 중 예상 못 한 오류 콜백(선택). */
  onError?: (err: unknown) => void;
  /** 연속 실패 임계치. 기본 `DEFAULT_MAX_CONSECUTIVE_FAILURES`. 0 이하면 감속하지 않는다. */
  maxConsecutiveFailures?: number;
  /** 감속 주기(ms). 기본 `SLOW_INTERVAL_MS`. */
  slowIntervalMs?: number;
  /** 임계치에 닿아 감속할 때 한 번 호출(선택) — 운영자 로그용. */
  onHalt?: (halt: PollHalt) => void;
}

export class PollingScheduler {
  private readonly pipeline: Pollable;
  private readonly intervalMs: number;
  private readonly onTick: ((result: RefreshResult) => void) | undefined;
  private readonly onError: ((err: unknown) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 진행 중인 tick 이 있는지. 겹침 방지용(BR4.4 의 중복 시작 방지와 같은 취지). */
  private inFlight = false;
  /** 겹침 경고는 한 번만 — interval 이 수집 시간보다 짧다는 사실은 한 줄로 충분하다. */
  private warnedOverlap = false;
  private readonly maxConsecutiveFailures: number;
  private readonly slowIntervalMs: number;
  private readonly onHalt: ((halt: PollHalt) => void) | undefined;
  /** 지금 타이머가 쓰고 있는 주기. 감속하면 `slowIntervalMs`, 회복하면 `intervalMs`. */
  private activeIntervalMs: number;
  private consecutiveFailures = 0;
  private lastFailureReason: string | undefined;
  private haltState: PollHalt | null = null;

  constructor(deps: SchedulerDeps) {
    this.pipeline = deps.pipeline;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onTick = deps.onTick;
    this.onError = deps.onError;
    this.maxConsecutiveFailures = deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.slowIntervalMs = deps.slowIntervalMs ?? SLOW_INTERVAL_MS;
    this.onHalt = deps.onHalt;
    this.activeIntervalMs = this.intervalMs;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** 연속 실패로 감속된 상태면 그 근거, 아니면 null. 타이머는 계속 돈다. */
  get halt(): PollHalt | null {
    return this.haltState;
  }

  /**
   * 멈춘 폴링을 되살린다. 수동 새로고침이 성공한 뒤 서버가 호출한다 — 상류가 복구됐을 때
   * 프로세스를 재시작하지 않고 자동 수집으로 돌아오는 유일한 길이다. 멈춘 상태가 아니면 무해한
   * no-op 이다(`start()` 의 중복 방지가 타이머를 하나로 유지한다).
   */
  resume(): void {
    this.consecutiveFailures = 0;
    this.lastFailureReason = undefined;
    this.haltState = null;
    this.retime(this.intervalMs);
    this.start(false);
  }

  /** 타이머를 새 주기로 다시 건다. 돌고 있지 않으면 주기만 기억한다. */
  private retime(intervalMs: number): void {
    if (this.activeIntervalMs === intervalMs && this.timer !== null) return;
    this.activeIntervalMs = intervalMs;
    if (this.timer === null) return;
    this.stop();
    this.start(false);
  }

  /** 폴링을 시작한다. runImmediately=true면 즉시 1회 실행 후 주기 반복. */
  start(runImmediately = false): void {
    if (this.timer !== null) return; // 중복 시작 방지(BR4.4)
    if (runImmediately) void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.activeIntervalMs);
    // 타이머가 프로세스 종료를 막지 않도록(서버 수명에 종속) unref.
    if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** 폴링을 중지한다. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 한 주기 실행. 실패를 격리해 다음 주기가 계속되도록 예외를 삼킨다(BR4.2).
   *
   * **겹침 방지.** `setInterval`은 앞 tick 이 끝났는지 묻지 않으므로, interval 이 수집보다
   * 짧으면 `kiro-cli` spawn 이 무제한으로 쌓인다 — 실측: interval 20ms · 작업 200ms 에서 동시
   * 10개. 기본 5분과 15초 수집 타임아웃에서는 닿지 않지만 `--interval` 은 그보다 작은 값을
   * 받고, `start()`의 중복 방지(BR4.4)는 타이머 하나만 보장할 뿐 tick 겹침은 막지 않는다.
   *
   * 건너뛴 tick 은 조용하다(첫 회만 경고). 정보가 사라지는 게 아니라 지금 돌고 있는 수집이
   * 같은 질문에 답하고 있고, 20ms 마다 한 줄씩 찍는 로그는 그 사실을 가릴 뿐이다.
   */
  async tick(): Promise<void> {
    if (this.inFlight) {
      if (!this.warnedOverlap) {
        this.warnedOverlap = true;
        console.warn(
          `[PollingScheduler] 앞 수집이 끝나기 전에 주기가 도래해 건너뜀 — interval ${this.intervalMs}ms 가 수집 시간보다 짧다`,
        );
      }
      return;
    }
    this.inFlight = true;
    try {
      const result = await this.pipeline.run("auto");
      // 수집 실패는 예외가 아니라 `ok:false` 스냅샷으로 온다(BR1.4의 비파괴 기록). 그래서
      // 연속 실패 판정은 예외 경로가 아니라 여기서 해야 한다 — tick 은 정상 완료했지만 값을
      // 못 가져온 경우가 상류가 깨졌을 때의 정상 모습이다.
      //
      // **저장 실패도 실패로 센다.** `persisted:false` 는 수집은 됐지만 DB 에 못 넣은 상태이고,
      // 화면은 저장된 스냅샷을 읽으므로 갱신되지 않는다. 성공으로 세면 DB 가 쓰기 불능인 채로
      // 감속이 풀려 원래 주기로 계속 두드리고, 수동 새로고침은 있지도 않은 회복을 보고한다.
      if (result.snapshot.ok && result.persisted) this.noteSuccess();
      else this.noteFailure(result.snapshot.ok ? result.persistError : result.snapshot.reason);
      this.onTick?.(result);
    } catch (err) {
      console.warn(`[PollingScheduler] 폴링 tick 오류(격리됨): ${String(err)}`);
      this.noteFailure(String(err));
      this.onError?.(err);
    } finally {
      this.inFlight = false;
    }
  }

  private noteSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastFailureReason = undefined;
    // 한 번이라도 성공하면 감속을 푼다 — 이게 "스스로 낫는다"의 전부다.
    if (this.haltState !== null) {
      this.haltState = null;
      this.retime(this.intervalMs);
      console.warn("[PollingScheduler] 수집이 회복돼 원래 주기로 돌아간다");
    }
  }

  private noteFailure(reason?: string): void {
    this.consecutiveFailures++;
    if (reason !== undefined && reason.length > 0) this.lastFailureReason = reason;
    if (this.maxConsecutiveFailures <= 0) return;
    if (this.consecutiveFailures < this.maxConsecutiveFailures) return;
    if (this.haltState !== null) return; // 이미 감속 — 로그도 한 번만
    const halt: PollHalt = {
      failures: this.consecutiveFailures,
      retryEveryMs: this.slowIntervalMs,
      ...(this.lastFailureReason === undefined ? {} : { lastReason: this.lastFailureReason }),
    };
    this.haltState = halt;
    // **멈추지 않는다.** 주기만 늘린다 — ACP 수집은 실패해도 모델을 부르지 않으므로 영구
    // 정지는 값을 잃을 뿐이고, 감속은 상류가 낫는 순간 스스로 돌아온다.
    this.retime(this.slowIntervalMs);
    const why =
      this.lastFailureReason === undefined ? "" : ` (마지막 사유: ${this.lastFailureReason})`;
    console.warn(
      `[PollingScheduler] 연속 ${this.consecutiveFailures}회 실패로 재시도 주기를 ${this.slowIntervalMs}ms 로 늘린다 — 수동 새로고침은 그대로 동작하고, 한 번 성공하면 원래 주기로 돌아온다${why}`,
    );
    this.onHalt?.(halt);
  }
}
