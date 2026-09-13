// u4-host-integration wiring tests (Step 8).
//
// Covers the host↔credit seam that assemble/model tests cannot: the credit slot
// in `assemble`, the request handler's routing and the ONE write exception
// (manual refresh POST), the `?cw=` window thread, and the boot/shutdown
// lifecycle. No real kiro-cli and no real SQLite are touched — every dependency
// is an injected stub, and the one live server is bound to 127.0.0.1:0 (an
// ephemeral loopback port) purely to prove the binding and routing over HTTP.

import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { type Options, parseArgs } from "../cli";
import type { Pollable } from "../credit/pipeline/polling-scheduler";
import type { RefreshResult } from "../credit/pipeline/refresh-pipeline";
import type { CaptureSource, CreditSnapshot, ParsedUsage } from "../credit/types";
import type { CreditReadStore, CreditViewModel } from "../credit/view/credit-model";
import { type UsageContext, assemble } from "../model/assemble";
import type { DashboardModel } from "../model/types";
import { type CreditRuntime, bootCredit, handle, shutdownCredit } from "../server";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const OPTS: Options = parseArgs(["--root", FIXTURE]);

function usage(overrides: Partial<ParsedUsage> = {}): ParsedUsage {
  return {
    planName: "Pro",
    usedAmount: 120,
    remainingAmount: 380,
    planLimit: 500,
    usageRatio: 0.24,
    resetDate: "2026-09-01",
    partial: false,
    ...overrides,
  };
}

/** A success snapshot captured "now", so assembleCredit sees it as fresh (ok). */
function freshOkSnapshot(): CreditSnapshot {
  return {
    sequence: 1,
    capturedAt: new Date().toISOString(),
    source: "auto",
    ok: true,
    data: usage(),
  };
}

/** A read store stub returning the given snapshots. Never touches SQLite. */
function stubStore(snapshots: CreditSnapshot[]): CreditReadStore {
  return {
    readAll: () => snapshots,
    latest: () => (snapshots.length > 0 ? snapshots[snapshots.length - 1]! : null),
  };
}

/** A read store whose reads throw — drives the assemble degrade path (BR1.4). */
function throwingStore(): CreditReadStore {
  return {
    readAll: () => {
      throw new Error("store boom");
    },
    latest: () => {
      throw new Error("store boom");
    },
  };
}

/**
 * Narrow `model.usage` to the Kiro credit view. The reference fixture ships a
 * `.kiro` harness dir, so `auto` resolves to the credit panel — asserting the
 * discriminant here keeps that assumption honest instead of casting past it.
 */
function creditOf(m: DashboardModel): CreditViewModel {
  if (m.usage.kind !== "kiro")
    throw new Error(`expected the kiro usage panel, got ${m.usage.kind}`);
  return m.usage.credit;
}

// ── assemble usage slot (kiro side) ─────────────────────────────────────────

describe("assemble credit slot", () => {
  test("no usageCtx → status 'none' (existing callers unaffected)", () => {
    const m = assemble(FIXTURE);
    expect(creditOf(m).status).toBe("none");
    expect(creditOf(m).current).toBeNull();
    // The rest of the model still assembles.
    expect(m.identity.record).toBe("260101-demo-migration");
  });

  test("creditCtx with a fresh success snapshot → status reflects the store", () => {
    const ctx: UsageContext = { store: stubStore([freshOkSnapshot()]), window: "30d" };
    const m = assemble(FIXTURE, undefined, ctx);
    expect(creditOf(m).status).toBe("ok");
    expect(creditOf(m).current).not.toBeNull();
    expect(creditOf(m).current?.planName).toBe("Pro");
    expect(creditOf(m).trend.window).toBe("30d");
  });

  test("store throw → degrade to none + warning, rest of model intact (BR1.4)", () => {
    const ctx: UsageContext = { store: throwingStore(), window: "7d" };
    const m = assemble(FIXTURE, undefined, ctx);
    expect(creditOf(m).status).toBe("none");
    expect(creditOf(m).trend.window).toBe("7d"); // degrade preserves the asked window
    expect(m.warnings.some((w) => w.code === "credit-assembly-failed")).toBe(true);
    // Non-credit sections are unharmed.
    expect(m.state.overallPct).toBe(80);
  });

  test("the ?cw window is threaded into the assembled trend", () => {
    const ctx: UsageContext = { store: stubStore([freshOkSnapshot()]), window: "all" };
    expect(creditOf(assemble(FIXTURE, undefined, ctx)).trend.window).toBe("all");
  });
});

// ── request handler routing & the single write exception ─────────────────────

describe("handle routing", () => {
  const get = (p: string, credit?: CreditRuntime) =>
    handle(new Request(`http://127.0.0.1${p}`), OPTS, credit);

  // The loopback bind stops a remote socket, not a page in the user's own browser.
  // Both guards were added after all three of these succeeded against the handler.
  describe("browser-mediated request guards", () => {
    const refresh = (headers: Record<string, string>, pipeline?: Pollable) =>
      handle(
        new Request("http://127.0.0.1/api/credit/refresh", { method: "POST", headers }),
        OPTS,
        {
          pipeline,
        },
      );

    test("a non-loopback Host is refused on every route (DNS rebinding)", async () => {
      // A domain resolving to 127.0.0.1 is same-origin to the browser, so without this
      // an attacker's script could READ /api/model — paths, artifact names, questions.
      for (const p of ["/", "/api/model", "/api/body", "/healthz"]) {
        const res = await handle(
          new Request(`http://evil.example.com${p}`, {
            headers: { "sec-fetch-site": "same-origin" },
          }),
          OPTS,
        );
        expect(res.status).toBe(403);
        expect(await res.text()).toBe("bad host");
      }
    });

    test("a cross-site caller cannot reach a state-changing route", async () => {
      const ran: CaptureSource[] = [];
      const pipeline: Pollable = {
        run: (s) => {
          ran.push(s);
          return Promise.resolve({ snapshot: freshOkSnapshot(), persisted: true } as RefreshResult);
        },
      };
      // `same-site` counts as cross-site here: a sibling port is somebody else's page.
      for (const site of ["cross-site", "same-site"]) {
        const res = await refresh({ "sec-fetch-site": site }, pipeline);
        expect(res.status).toBe(403);
      }
      const byOrigin = await refresh({ origin: "https://evil.example.com" }, pipeline);
      expect(byOrigin.status).toBe(403);
      // The point of the guard: the pipeline never ran, so no kiro-cli was spawned.
      expect(ran).toEqual([]);
    });

    test("the side-effecting GETs are guarded too, not just the POSTs", async () => {
      for (const p of ["/select?dir=/tmp", "/open?rel=x.md"]) {
        const res = await handle(
          new Request(`http://127.0.0.1${p}`, { headers: { "sec-fetch-site": "cross-site" } }),
          OPTS,
        );
        expect(res.status).toBe(403);
      }
    });

    test("same-origin, address bar, Origin-only and header-less callers all pass", async () => {
      const ran: CaptureSource[] = [];
      const pipeline: Pollable = {
        run: (s) => {
          ran.push(s);
          return Promise.resolve({ snapshot: freshOkSnapshot(), persisted: true } as RefreshResult);
        },
      };
      const allowed: Record<string, string>[] = [
        { "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:4321" }, // our page
        { "sec-fetch-site": "none" }, // typed into the address bar
        { origin: "http://localhost:4321" }, // browser too old for Sec-Fetch-Site
        {}, // curl — not the threat model, must keep working
      ];
      for (const headers of allowed) {
        expect((await refresh(headers, pipeline)).status).toBe(303);
      }
      expect(ran.length).toBe(allowed.length);
    });
  });

  // The locale-wiring step: `?lang=`/cookie/Accept-Language reach `<html lang>` and an
  // explicit `?lang=` sticks. The COPY is still Korean in both languages — that is why
  // there is no toggle on screen yet.
  describe("page language", () => {
    const page = (query: string, headers: Record<string, string> = {}) =>
      handle(new Request(`http://127.0.0.1/${query}`, { headers }), OPTS);

    test("the --lang default reaches <html lang> when the reader asks for nothing", async () => {
      expect(await (await page("")).text()).toContain('<html lang="ko"');
      const en = await handle(new Request("http://127.0.0.1/"), { ...OPTS, locale: "en" });
      expect(await en.text()).toContain('<html lang="en"');
    });

    test("?lang= wins and is persisted; the cookie then answers on its own", async () => {
      const explicit = await page("?lang=en");
      expect(await explicit.text()).toContain('<html lang="en"');
      // Persisted, so the next click needs no param — unlike `?cw=`, which every
      // link has to carry.
      expect(explicit.headers.get("set-cookie")).toContain("aidlc_lang=en");

      const viaCookie = await page("", { cookie: "aidlc_lang=en" });
      expect(await viaCookie.text()).toContain('<html lang="en"');
      // Nothing was asked this time, so nothing is re-set.
      expect(viaCookie.headers.get("set-cookie")).toBeNull();
    });

    test("Accept-Language is consulted before the --lang default", async () => {
      const res = await page("", { "accept-language": "en-GB,en;q=0.9" });
      expect(await res.text()).toContain('<html lang="en"');
    });

    test("the error page is marked up in the reader's language too", async () => {
      // A root with no resolvable record → NoRunError → the 404 error page.
      const res = await handle(new Request("http://127.0.0.1/?lang=en"), {
        ...OPTS,
        root: import.meta.dir,
      });
      // Either the page rendered or the error page did; both must carry the lang.
      expect(await res.text()).toContain('<html lang="en"');
    });

    test("the picker carries it as well, not just the dashboard", async () => {
      const res = await handle(new Request("http://127.0.0.1/pick?lang=en"), OPTS);
      expect(await res.text()).toContain('<html lang="en"');
      expect(res.headers.get("set-cookie")).toContain("aidlc_lang=en");
    });
  });

  test("non-GET/HEAD (POST/PUT/DELETE) on a normal path → 405 read-only", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await handle(new Request("http://127.0.0.1/api/body", { method }), OPTS);
      expect(res.status).toBe(405);
      expect(await res.text()).toBe("read-only");
    }
  });

  test("manual refresh POST → pipeline.run('manual') exactly once, then redirects", async () => {
    const calls: CaptureSource[] = [];
    const pipeline: Pollable = {
      run: (source) => {
        calls.push(source);
        return Promise.resolve({ snapshot: freshOkSnapshot(), persisted: true } as RefreshResult);
      },
    };
    const res = await handle(
      new Request("http://127.0.0.1/api/credit/refresh", { method: "POST" }),
      OPTS,
      { pipeline },
    );
    expect(calls).toEqual(["manual"]);
    expect(res.status).toBe(303); // redirect back so the no-JS form re-renders
  });

  test("manual refresh POST with ?cw preserves the window on the redirect", async () => {
    const pipeline: Pollable = {
      run: () => Promise.resolve({ snapshot: freshOkSnapshot(), persisted: true } as RefreshResult),
    };
    const res = await handle(
      new Request("http://127.0.0.1/api/credit/refresh?cw=7d", { method: "POST" }),
      OPTS,
      { pipeline },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?cw=7d");
  });

  test("manual refresh POST is safe when the subsystem is degraded (no pipeline)", async () => {
    const res = await handle(
      new Request("http://127.0.0.1/api/credit/refresh", { method: "POST" }),
      OPTS,
      {},
    );
    expect(res.status).toBe(303); // still redirects; simply nothing to re-collect
  });

  test("POST /api/refresh returns the refresh result as JSON", async () => {
    const calls: CaptureSource[] = [];
    let collecting = true;
    const pipeline: Pollable = {
      run: (source) => {
        calls.push(source);
        return Promise.resolve({ snapshot: freshOkSnapshot(), persisted: true } as RefreshResult);
      },
    };
    const res = await handle(
      new Request("http://127.0.0.1/api/refresh", { method: "POST" }),
      OPTS,
      {
        pipeline,
        isCollecting: () => collecting,
        markCollectionDone: () => {
          collecting = false;
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(calls).toEqual(["manual"]);
    expect(collecting).toBe(false);
    expect((await res.json()) as RefreshResult).toMatchObject({ persisted: true });
  });

  test("GET /api/current exposes loading and GET /api/trend honors the window", async () => {
    const store = stubStore([]);
    const runtime: CreditRuntime = { store, isCollecting: () => true };
    const current = await get("/api/current", runtime);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      state: "loading",
      status: "loading",
      freshness: { stale: false, lastSuccessAt: null },
    });

    const trend = await get("/api/trend?window=7d", runtime);
    expect(trend.status).toBe(200);
    expect(await trend.json()).toMatchObject({ window: "7d", points: [] });
  });

  test("credit JSON APIs return 503 when the subsystem is unavailable", async () => {
    expect((await get("/api/current")).status).toBe(503);
    expect((await get("/api/trend")).status).toBe(503);
    expect(
      (await handle(new Request("http://127.0.0.1/api/refresh", { method: "POST" }), OPTS)).status,
    ).toBe(503);
  });

  test("GET /browse serves the primary folder explorer", async () => {
    const res = await get(`/browse?dir=${encodeURIComponent(FIXTURE)}`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("폴더 탐색");
    expect(body).toContain('aria-label="탐색 루트"');
    expect(body).toContain('aria-label="현재 경로"');
    expect(body).toContain('id="directory-filter"');
  });

  test("?cw=7d threads the window through to the rendered credit view", async () => {
    // Select the fixture workspace first so /api/body has something to render.
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    const res = await get("/api/body?cw=7d", { store: stubStore([]) });
    const body = await res.text();
    expect(body).toContain('aria-checked="true" href="?cw=7d"');
    expect(body).toContain('aria-checked="false" href="?cw=30d"');
  });

  test("?cw invalid → 30d fallback in the rendered view", async () => {
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    const res = await get("/api/body?cw=bogus", { store: stubStore([]) });
    const body = await res.text();
    expect(body).toContain('aria-checked="true" href="?cw=30d"');
  });

  test("/api/model includes the wired credit model", async () => {
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    const res = await get("/api/model", { store: stubStore([freshOkSnapshot()]) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      usage: { kind: "kiro", credit: { status: "ok", current: { planName: "Pro" } } },
    });
  });

  test("the /open record-dir jail is preserved (traversal rejected)", async () => {
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    const res = await get(`/open?rel=${encodeURIComponent("../../../../etc/passwd")}`);
    expect(res.status).toBe(403);
  });

  test("/api/summary answers for a validated workspace and leaves activeRoot alone", async () => {
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    const res = await get(`/api/summary?dir=${encodeURIComponent(FIXTURE)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: "ok",
      progress: { source: "state.md" },
      blockers: { source: "disk" },
    });
    // Reading a workspace and SELECTING one are different acts. `/select` is the only
    // writer of the process's one mutable variable, and this must not become a second.
    expect(await (await get("/healthz")).json()).toMatchObject({ root: FIXTURE });
  });

  test("/api/summary refuses a path that is not a workspace", async () => {
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    // A client string becomes a path only through resolveWorkspace, so an arbitrary dir
    // cannot make this read something that is not an AI-DLC tree.
    expect((await get(`/api/summary?dir=${encodeURIComponent(os.tmpdir())}`)).status).toBe(400);
    expect((await get("/api/summary")).status).toBe(400);
    // …and the refusal did not move the active root either.
    expect(await (await get("/healthz")).json()).toMatchObject({ root: FIXTURE });
  });

  test("/view renders the artifact source, escaped, with the page locked down", async () => {
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    const res = await get(`/view?rel=${encodeURIComponent("ideation/intent-capture/memory.md")}`);
    expect(res.status).toBe(200);
    // The page is built from file contents, so it ships with no origin to act in.
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toContain("<pre>");
    expect(body).toContain("ideation/intent-capture/memory.md");
    // The artifact's own markdown must arrive escaped, never as live markup.
    expect(body).not.toContain("<h2>");
  });

  test("/view shares the /open jail (traversal rejected) and says why", async () => {
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    const res = await get(`/view?rel=${encodeURIComponent("../../../../etc/passwd")}`);
    expect(res.status).toBe(403);
    // A refusal is a PAGE here, not JSON: the reader clicked a link and must land
    // somewhere that says what happened.
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("원문을 보여줄 수 없습니다");
  });

  test("/view answers in the reader's language", async () => {
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`);
    const res = await handle(
      new Request(`http://127.0.0.1/view?lang=en&rel=${encodeURIComponent("nope.md")}`),
      OPTS,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Cannot show this source");
  });
});

// ── boot & shutdown lifecycle ────────────────────────────────────────────────

describe("credit subsystem lifecycle", () => {
  test("bootCredit wires store→pipeline→scheduler and starts immediately", () => {
    const events: string[] = [];
    const sub = bootCredit({
      createStore: () => ({
        init: () => events.push("store.init"),
        latest: () => null,
        readAll: () => [],
        maxSequence: () => 0,
        append: () => {},
      }),
      createPipeline: () => ({
        init: () => events.push("pipeline.init"),
        run: () =>
          Promise.resolve({ snapshot: freshOkSnapshot(), persisted: true } as RefreshResult),
      }),
      createScheduler: () => ({
        start: (runImmediately: boolean) => events.push(`scheduler.start(${runImmediately})`),
        stop: () => events.push("scheduler.stop"),
      }),
    });
    expect(sub.degraded).toBe(false);
    expect(events).toEqual(["store.init", "pipeline.init", "scheduler.start(true)"]);
  });

  test("bootCredit passes the configured collection interval to the scheduler", () => {
    let receivedInterval: number | undefined;
    const sub = bootCredit({
      intervalMs: 12_345,
      createStore: () => ({
        init: () => {},
        latest: () => null,
        readAll: () => [],
        maxSequence: () => 0,
        append: () => {},
      }),
      createPipeline: () => ({
        init: () => {},
        run: () =>
          Promise.resolve({ snapshot: freshOkSnapshot(), persisted: true } as RefreshResult),
      }),
      createScheduler: (_pipeline, onSettled, intervalMs) => {
        receivedInterval = intervalMs;
        return {
          start: () => onSettled(),
          stop: () => {},
        };
      },
    });
    expect(receivedInterval).toBe(12_345);
    expect(sub.isCollecting()).toBe(false);
  });

  test("a boot init failure is isolated → degraded, no store, server still starts", () => {
    const sub = bootCredit({
      createStore: () => {
        throw new Error("sqlite open failed");
      },
    });
    expect(sub.degraded).toBe(true);
    expect(sub.store).toBeUndefined();
    expect(sub.pipeline).toBeUndefined();
    expect(sub.scheduler).toBeUndefined();
  });

  test("shutdownCredit stops the scheduler (SIGINT/SIGTERM path) and tolerates absence", () => {
    let stopped = 0;
    shutdownCredit({ stop: () => stopped++ });
    expect(stopped).toBe(1);
    expect(() => shutdownCredit(undefined)).not.toThrow();
  });

  test("shutdownCredit closes the store so the WAL is folded back in, and tolerates its absence", () => {
    let stopped = 0;
    let closed = 0;
    shutdownCredit({ stop: () => stopped++ }, () => {
      closed++;
    });
    expect(stopped).toBe(1);
    expect(closed).toBe(1);
    // A degraded boot has neither field.
    expect(() => shutdownCredit(undefined, undefined)).not.toThrow();
  });

  test("bootCredit exposes closeStore, which no-ops for a store that cannot be closed", () => {
    // The injected stub store has no close(); shutdown must not care.
    const sub = bootCredit({
      createStore: () => ({
        init: () => {},
        append: () => {},
        maxSequence: () => 0,
        latest: () => null,
        readAll: () => [],
      }),
      createPipeline: () => ({ init: () => {}, run: async () => ({}) as never }),
      createScheduler: () => ({ start: () => {}, stop: () => {} }),
    });
    expect(sub.degraded).toBe(false);
    expect(() => shutdownCredit(sub.scheduler, sub.closeStore)).not.toThrow();
  });
});

// ── loopback binding + routing over real HTTP ────────────────────────────────

describe("server binds loopback and routes over HTTP", () => {
  test("127.0.0.1:0 serves /healthz and rejects non-GET with 405", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => handle(req, OPTS, {}),
    });
    try {
      expect(server.hostname).toBe("127.0.0.1");
      const base = `http://127.0.0.1:${server.port}`;

      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      const healthBody = (await health.json()) as { ok: boolean };
      expect(healthBody.ok).toBe(true);

      const rejected = await fetch(`${base}/api/body`, { method: "DELETE" });
      expect(rejected.status).toBe(405);
    } finally {
      server.stop(true);
    }
  });
});
