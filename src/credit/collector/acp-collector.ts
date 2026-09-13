/**
 * AcpUsageCollector — ACP(Agent Client Protocol)로 Kiro 크레딧 잔량을 읽는다.
 *
 * **왜 `chat --no-interactive /usage` 를 버렸는가.** Kiro 문서가 그 조합을 지원하지 않는다고
 * 명시한다 — `reference/slash-commands.md`: *"Slash commands are only available in interactive
 * chat mode"*, `cli/headless.md` Limitations: *"Interactive slash commands are not available"*.
 * 한동안 우연히 동작했을 뿐이고, `kiro-cli 2.21.4`(KAS 0.63.3)에서는 `/usage` 가 **모델에게
 * 프롬프트로** 전달된다(실측: 산문 응답 "I don't have a direct meter to report", 9.4s, exit 0).
 * 즉 옛 경로는 크레딧을 읽으려고 크레딧을 썼다.
 *
 * **ACP 는 문서화된 경로다.** `cli/acp.md` — `kiro-cli acp` 가 stdin/stdout JSON-RPC 2.0 서버로
 * 뜨고, Kiro 확장 `_kiro.dev/commands/execute` 가 슬래시 명령을 실행한다. `/usage` 는
 * `_kiro.dev/commands/available` 목록에 있고(25개 중 하나, `inputType: "panel"`), 실행하면
 * **구조화된 데이터**가 온다 — 산문 파싱이 사라진다.
 *
 * 실측 비교 (2026-09-12):
 *
 *   | | 옛 경로 | ACP |
 *   |---|---|---|
 *   | 모델 호출 | 매번 | 없음 |
 *   | 응답 | 9.4s+ / 타임아웃 | 2.1s(콜드) · 0.9s(세션 재사용) |
 *   | 출력 | 산문 | JSON |
 *
 * **호출 규약은 문서에 없어 serde 오류로 역추적했다.** `command` 는 adjacently tagged enum
 * `TuiCommand` 이고 태그 필드가 `command`, 내용 필드가 `args` 다. 그래서 중첩이 두 번이다:
 *
 *   params = { sessionId, command: { command: "usage", args: {} } }
 *
 * `args: null` 은 거부된다(*"invalid type: null, expected struct UsageArgs"*) — 빈 객체여야 한다.
 *
 * **세션을 재사용한다.** `session/new` 는 `~/.kiro/sessions/cli/` 최상위에 파일 2개를 남긴다
 * (`<id>.json` + `<id>.jsonl`). 실측으로 못 박은 값 — 수집 3회에 **공유 세션은 +2 파일, 세션을
 * 공유하지 않으면 +6**. 즉 재사용이 없으면 5분 폴링에서 하루 576개가 쌓이고, 재사용하면
 * **서버 재시작당 2개**다. `session/load` 로 같은 id 를 다시 열 수 있고(실측 OK, load+exec
 * 932ms 대 콜드 2.1s) 그때는 아무것도 늘지 않는다. Kiro 의 디렉터리를 우리가 청소하지는 않는다 —
 * 남의 도구 상태이고, 만드는 양을 줄이는 것이 우리가 할 수 있는 정직한 몫이다.
 *
 * 하드 계약(옛 수집기와 동일): 인자 배열 spawn(`shell: true` 금지, NFR1.1) · 최소 환경변수
 * (NFR1.2) · 타임아웃(BR1.3) · 원문을 파일로 남기지 않음(휘발성, BR3.3).
 *
 * **실험적 확장이라는 사실을 잊지 말 것.** `cli/acp.md` 가 *"These extensions are experimental
 * and subject to change"* 라고 적어 두었다. 그래서 스키마가 바뀌면 **크게** 실패해야 한다 —
 * 옛 경로의 실패 모드가 나빴던 이유가 정확히 이것이었다: 산문을 받아도 실패인 줄 모르고
 * 타임아웃으로 오진됐다. 다만 "크게"의 뜻은 `mapAcpUsage` 주석에 적은 대로 **결측과 오타입을
 * 가르는** 것이고, 둘을 뭉쳐 다 거부하는 것이 아니다.
 */

import type { ParseResult } from "../parser/usage-parser";
import type { ParsedUsage } from "../types";

/** ACP 서버 기동 argv. 옛 `USAGE_ARGV` 와 같은 규율로 이 모듈이 소유한다. */
export const ACP_ARGV: readonly string[] = ["kiro-cli", "acp"];

/** 전체 왕복 타임아웃. 콜드 스타트 실측 2.1s + MCP 서버 초기화 여유. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 진단 detail 최대 길이(과도한 블롭 방지) — 옛 수집기와 같은 상한. */
const MAX_DETAIL_LEN = 4_000;

/** 프로세스 수명 동안 재사용하는 세션 id 홀더. 호출자(bootCredit)가 들고 있는다. */
export interface AcpSessionRef {
  id?: string;
}

export interface AcpCollectorDeps {
  timeoutMs?: number;
  envSource?: Record<string, string | undefined>;
  /** 세션 재사용 홀더. 없으면 매 호출이 새 세션을 만든다(테스트 편의). */
  session?: AcpSessionRef;
  /** JSON-RPC 왕복을 대신할 주입 지점 — 테스트가 실제 CLI 를 부르지 않게 한다. */
  rpc?: AcpRpc;
  /** `session/new` 에 넘길 cwd. 기본은 프로세스 cwd. */
  cwd?: string;
}

/** 한 번의 ACP 세션에서 필요한 왕복만 노출하는 최소 표면. */
export interface AcpRpc {
  call(method: string, params?: unknown): Promise<AcpResponse>;
  close(): void;
}

export interface AcpResponse {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** 최소 환경변수(NFR1.2). 옛 수집기와 같은 허용 목록. */
function buildMinimalEnv(src: Record<string, string | undefined>): Record<string, string> {
  const allow = ["PATH", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];
  const env: Record<string, string> = {};
  for (const key of allow) {
    const v = src[key];
    if (typeof v === "string" && v.length > 0) env[key] = v;
  }
  return env;
}

function clip(s: string): string {
  return s.length > MAX_DETAIL_LEN ? `${s.slice(0, MAX_DETAIL_LEN)}…` : s;
}

/** stdout 버퍼 상한. 개행 없는 출력이 무한히 쌓이는 것을 막는다(프로토콜 오류로 취급). */
const MAX_LINE_BYTES = 1024 * 1024;

/**
 * 실제 JSON-RPC 클라이언트. 한 줄 = 한 메시지(JSON Lines).
 *
 * **미해결 호출은 stdout EOF 가 아니라 벽시계 데드라인으로 정산한다.** 이게 이 함수에서 가장
 * 중요한 한 줄이고, 처음엔 틀렸다: `pending` 해제를 stdout 반복문의 종료에만 묶어 두었다.
 * 그런데 EOF 는 **직접 자식이 아니라 FD 를 물고 있는 손자**의 수명을 따른다 — `kiro-cli acp` 는
 * KAS(node) 를 띄우므로 실측에서 자식은 SIGKILL 로 1,512ms 에 죽고 stdout 반복문은 1,923ms 에야
 * 끝났다(다른 관측에서는 34ms 대 1,025ms). 손자가 살아 있으면 EOF 가 아예 오지 않을 수 있고,
 * 그러면 `call()` 이 영구 대기하고 → `collectUsageViaAcp` 가 반환하지 않고 → `PollingScheduler`
 * 의 `inFlight` 가 영원히 서서 **폴링이 조용히 죽는다**(연속 실패 카운터에도 닿지 못한다).
 * 옛 수집기가 `DRAIN_GRACE_MS` 를 따로 둔 이유가 정확히 이것이다.
 *
 * **reader 의 오류는 반드시 삼킨다.** 처음엔 `void (async () => …)()` 로 버려 두었는데, 스트림
 * 반복이 throw 하면 그 promise 가 unhandled rejection 이 되고 **Bun 은 프로세스를 종료한다**
 * (실측: exit 1, 뒤에 걸어둔 타이머 미실행). 크레딧 실패가 대시보드를 죽이지 않는다는 계약의
 * 정면 위반이며, `/open` 의 spawn `error` 리스너가 막는 것과 같은 부류다.
 */
export function spawnAcpRpc(
  timeoutMs: number,
  env: Record<string, string>,
  /** 기동 argv. 기본은 `ACP_ARGV`; 테스트가 대본을 아는 가짜 에이전트를 끼울 수 있게 열어 둔다
   *  (전역 `Bun.spawn` 을 몽키패치하는 것보다 낫다). */
  argv: readonly string[] = ACP_ARGV,
): AcpRpc {
  const proc = Bun.spawn([...argv], {
    stdin: "pipe",
    stdout: "pipe",
    // stderr 는 버린다: KAS 는 여기에 INFO 로그를 쏟아내고, 우리는 stdout 의 JSON 만 읽는다.
    stderr: "ignore",
    env,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });

  const enc = new TextEncoder();
  let nextId = 0;
  const pending = new Map<number, (r: AcpResponse) => void>();
  let closed = false;

  const settleAll = (message: string) => {
    for (const [, resolve] of pending) resolve({ error: { message } });
    pending.clear();
  };

  const killChild = () => {
    try {
      proc.stdin.end();
    } catch {
      // 이미 닫혔으면 할 일이 없다.
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      // 이미 죽었으면 할 일이 없다.
    }
  };

  // 데드라인: 자식·손자 상태와 무관하게 이 시점에 반드시 정산된다.
  const deadline = setTimeout(() => {
    settleAll(`ACP 응답 타임아웃(${timeoutMs}ms 초과)`);
    killChild();
  }, timeoutMs);
  // 이 타이머가 프로세스 종료를 붙잡지 않도록(서버 수명에 종속).
  if (typeof deadline === "object" && deadline !== null && "unref" in deadline) {
    (deadline as unknown as { unref: () => void }).unref();
  }

  // reader promise 를 소유하고 **모든** 오류를 정산으로 바꾼다 — 버려진 rejection 금지.
  const reader = (async () => {
    // `{ stream: true }` — 멀티바이트 문자가 chunk 경계에 걸리면 그냥 decode 하면 U+FFFD 로
    // 깨진다. 마지막 flush 는 반복문 뒤에서 한 번 한다.
    const dec = new TextDecoder("utf-8");
    let buf = "";
    const drain = () => {
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.length === 0) continue;
        try {
          const msg = JSON.parse(line) as { id?: number } & AcpResponse;
          // 알림(id 없음)은 버린다 — 이 수집기가 쓰는 것은 요청 응답뿐이다.
          if (typeof msg.id !== "number") continue;
          const resolve = pending.get(msg.id);
          if (resolve !== undefined) {
            pending.delete(msg.id);
            resolve(msg);
          }
        } catch {
          // JSON 이 아닌 줄은 무시한다(로그가 stdout 으로 새는 경우).
        }
      }
    };
    for await (const chunk of proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      drain();
      if (buf.length > MAX_LINE_BYTES) {
        // 개행 없이 상한을 넘겼다 = JSON Lines 가 아니다. 붙들고 있을 이유가 없다.
        settleAll("ACP 출력이 줄 상한을 넘었습니다 (프로토콜 오류)");
        killChild();
        return;
      }
    }
    buf += dec.decode();
    drain();
  })()
    .catch((err) => {
      // 스트림 오류도 그냥 실패한 왕복이다 — 프로세스를 죽게 두지 않는다.
      settleAll(`ACP 출력 읽기 실패: ${String(err)}`);
    })
    .finally(() => {
      settleAll("ACP 프로세스가 응답 전에 종료되었습니다");
    });

  return {
    call(method, params) {
      if (closed) {
        return Promise.resolve({ error: { message: "닫힌 ACP 연결에 호출했습니다" } });
      }
      const id = nextId++;
      return new Promise<AcpResponse>((resolve) => {
        pending.set(id, resolve);
        try {
          proc.stdin.write(
            enc.encode(
              `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
            ),
          );
          proc.stdin.flush();
        } catch (err) {
          pending.delete(id);
          resolve({ error: { message: `stdin 쓰기 실패: ${String(err)}` } });
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      // 대기 중인 호출을 **즉시** 정산한다 — 손자가 stdout 을 물고 있어도 호출자는 풀려난다.
      settleAll("ACP 연결이 닫혔습니다");
      killChild();
      // reader 는 스스로 끝나며 모든 오류를 위에서 삼킨다. 기다리지 않는 이유는 그 대기가
      // 곧 손자 수명에 매달리는 일이고, 그게 이 함수가 피하려는 바로 그 결합이다.
      void reader;
    },
  };
}

/** ACP `initialize` 파라미터. 파일·터미널 능력은 모두 false — 우리는 명령 하나만 부른다. */
const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  },
  clientInfo: { name: "aidlc-dashboard", version: "1" },
} as const;

function errText(e: AcpResponse["error"]): string {
  if (e === undefined) return "알 수 없는 오류";
  const detail = e.data === undefined ? "" : ` ${JSON.stringify(e.data)}`;
  return clip(`${e.message ?? "오류"}${detail}`);
}

/**
 * `/usage` 응답의 `data` → `ParsedUsage`.
 *
 * **결측과 오타입을 다르게 다룬다.** 이 머리주석은 한때 "필드가 없거나 타입이 다르면 크게
 * 실패한다"고 적혀 있었는데, 코드는 `used` 하나만 그렇게 다뤘다 — 주석이 코드보다 강하게
 * 주장하는 상태였고, 이 저장소 기준으로 그건 결함이다. 지금은 `normalizeUsage` 가 이미 정한
 * 규율(CLAUDE.md)을 그대로 따른다:
 *
 *   - **결측 → null + `partial`.** 화면은 부분 데이터라고 말하고, 나머지 값은 살린다.
 *   - **오타입 → 손상된 응답으로 거부.** 숫자 자리에 문자열이 오면 그건 스키마가 바뀐 것이고,
 *     조용히 null 로 접으면 "포맷이 바뀌었다"고 말할 기회를 잃는다.
 *
 * `CREDIT` breakdown 을 이름으로 찾는 이유도 같다: 배열의 첫 항목을 집으면 Kiro 가 항목을
 * 추가한 날 다른 자원의 수치를 크레딧이라고 우기게 된다.
 */
export function mapAcpUsage(data: unknown): ParseResult {
  const raw = clip(JSON.stringify(data ?? null));
  if (typeof data !== "object" || data === null) {
    return {
      ok: false,
      raw,
      reason: "인식 가능한 크레딧 지표를 찾지 못했습니다 (포맷 변경 가능성).",
    };
  }
  const d = data as Record<string, unknown>;
  const breakdowns = d.usageBreakdowns;
  if (!Array.isArray(breakdowns)) {
    return {
      ok: false,
      raw,
      reason: "인식 가능한 크레딧 지표를 찾지 못했습니다 (포맷 변경 가능성).",
    };
  }
  const credit = breakdowns.find(
    (b): b is Record<string, unknown> =>
      typeof b === "object" &&
      b !== null &&
      (b as Record<string, unknown>).resourceType === "CREDIT",
  );
  if (credit === undefined) {
    return {
      ok: false,
      raw,
      reason: "usageBreakdowns 에 CREDIT 항목이 없습니다 (포맷 변경 가능성).",
    };
  }

  // 결측(undefined/null) 은 null, **오타입은 예외적 신호** — 아래에서 손상으로 거부한다.
  const BAD = Symbol("wrong-type");
  const num = (v: unknown): number | null | typeof BAD => {
    if (v === undefined || v === null) return null;
    return typeof v === "number" && Number.isFinite(v) ? v : BAD;
  };
  const str = (v: unknown): string | null | typeof BAD => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return BAD;
    return v.length > 0 ? v : null;
  };
  const malformed = (field: string): ParseResult => ({
    ok: false,
    raw,
    reason: `${field} 의 타입이 예상과 다릅니다 (포맷 변경 가능성).`,
  });

  // `hasLimit` 은 boolean 이어야 한다. 예전 코드는 `!== false` 라서 `"false"` 나 `0` 도 "한도
  // 있음"으로 읽었고, 그러면 없는 한도로 게이지를 그린다.
  const hasLimitRaw = credit.hasLimit;
  if (hasLimitRaw !== undefined && typeof hasLimitRaw !== "boolean") {
    return malformed("hasLimit");
  }
  const hasLimit = hasLimitRaw !== false;

  const used = num(credit.used);
  if (used === BAD) return malformed("used");
  const limitRead = num(credit.limit);
  if (limitRead === BAD) return malformed("limit");
  const limit = hasLimit ? limitRead : null;
  // 사용률은 Kiro 가 준 percentage 를 쓴다(0~100 → 0~1). 우리가 used/limit 로 다시 계산하면
  // 초과분·애드온이 섞인 그쪽 셈과 어긋날 수 있다. 100 으로 나눈 뒤 소수 6자리로 맞추는 것은
  // `remainingAmount` 와 같은 이유다 — `76.5006 / 100` 이 `0.7650060000000001` 을 내는데,
  // 그 꼬리는 원본에 없던 자리다(percentage 는 소수 4자리).
  const pct = num(credit.percentage);
  if (pct === BAD) return malformed("percentage");
  const planName = str(d.planName);
  if (planName === BAD) return malformed("planName");
  const resetDate = str(d.billingCycleReset);
  if (resetDate === BAD) return malformed("billingCycleReset");

  // 잔량은 두 실측값의 차다 — 옛 파서는 원문에서 읽었지만 ACP 는 주지 않는다. 소수 2자리로
  // 맞추는 것은 정밀도를 **버리는** 쪽이다: Kiro 가 주는 값이 `7609.69` 이므로 뺄셈이 만든
  // `2390.3100000000004` 는 원본에 없던 자리이고, 화면에 그대로 내면 없는 정밀도를 주장한다.
  const remaining = used !== null && limit !== null ? Math.round((limit - used) * 100) / 100 : null;

  const parsed: ParsedUsage = {
    planName,
    usedAmount: used,
    remainingAmount: remaining,
    planLimit: limit,
    usageRatio: pct === null ? null : Math.round((pct / 100) * 1e6) / 1e6,
    resetDate,
    partial: false,
  };
  parsed.partial = Object.entries(parsed).some(([k, v]) => k !== "partial" && v === null);

  // 사용량 자체를 못 읽었으면 성공이라고 부르지 않는다 — 게이지의 분자다.
  if (used === null) {
    return {
      ok: false,
      raw,
      reason: "인식 가능한 크레딧 지표를 찾지 못했습니다 (포맷 변경 가능성).",
    };
  }
  return { ok: true, data: parsed };
}

/**
 * ACP 로 `/usage` 를 한 번 실행해 `ParseResult` 를 낸다. 던지지 않는다.
 *
 * 세션은 `deps.session` 에 캐시된 id 를 `session/load` 로 재사용하고, 실패하면(삭제됨·id 낡음)
 * `session/new` 로 한 번 되돌아간다.
 */
export async function collectUsageViaAcp(deps: AcpCollectorDeps = {}): Promise<ParseResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = buildMinimalEnv(deps.envSource ?? process.env);
  const cwd = deps.cwd ?? process.cwd();
  const sessionRef = deps.session;

  let rpc: AcpRpc;
  try {
    rpc = deps.rpc ?? spawnAcpRpc(timeoutMs, env);
  } catch (err) {
    return {
      ok: false,
      raw: "",
      reason: `수집 실패: ACP 기동 불가 (${clip(String(err))})`,
    };
  }

  try {
    const init = await rpc.call("initialize", INIT_PARAMS);
    if (init.error !== undefined) {
      return { ok: false, raw: "", reason: `수집 실패: initialize (${errText(init.error)})` };
    }

    let sessionId: string | undefined;
    const cached = sessionRef?.id;
    if (cached !== undefined) {
      const loaded = await rpc.call("session/load", { sessionId: cached, cwd, mcpServers: [] });
      if (loaded.error === undefined) sessionId = cached;
    }
    if (sessionId === undefined) {
      const created = await rpc.call("session/new", { cwd, mcpServers: [] });
      if (created.error !== undefined) {
        return { ok: false, raw: "", reason: `수집 실패: session/new (${errText(created.error)})` };
      }
      const r = created.result;
      const id =
        typeof r === "object" && r !== null ? (r as Record<string, unknown>).sessionId : undefined;
      if (typeof id !== "string" || id.length === 0) {
        return {
          ok: false,
          raw: clip(JSON.stringify(r ?? null)),
          reason: "session/new 응답에 sessionId 가 없습니다 (포맷 변경 가능성).",
        };
      }
      sessionId = id;
      if (sessionRef !== undefined) sessionRef.id = id;
    }

    const exec = await rpc.call("_kiro.dev/commands/execute", {
      sessionId,
      // 이중 중첩이 맞다 — 위 머리주석의 TuiCommand 설명 참조. `args: {}` 이지 null 이 아니다.
      command: { command: "usage", args: {} },
    });
    if (exec.error !== undefined) {
      // 메서드·스키마가 바뀌면 여기로 온다. 실험적 확장이므로 이 경로가 정상적으로 발생한다.
      return {
        ok: false,
        raw: "",
        reason: `수집 실패: /usage 실행 거부 (${errText(exec.error)})`,
      };
    }
    const res = exec.result;
    if (typeof res !== "object" || res === null) {
      return {
        ok: false,
        raw: clip(JSON.stringify(res ?? null)),
        reason: "인식 가능한 크레딧 지표를 찾지 못했습니다 (포맷 변경 가능성).",
      };
    }
    const r = res as Record<string, unknown>;
    // `!== false` 로는 부족하다 — 필드가 사라지거나 `"false"` 문자열이 오면 통과해 버린다.
    // 관측된 응답은 항상 `success: true` 이므로, 그게 아니면 성공이라고 부르지 않는다.
    if (r.success !== true) {
      return {
        ok: false,
        raw: clip(typeof r.message === "string" ? r.message : JSON.stringify(r)),
        reason: "수집 실패: /usage 가 성공을 보고하지 않았습니다.",
      };
    }
    return mapAcpUsage(r.data);
  } finally {
    rpc.close();
  }
}
