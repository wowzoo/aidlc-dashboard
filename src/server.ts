// HTTP entry point.
//
// Every request re-reads the workspace. That is deliberate: the whole read costs
// ~10ms on one real run (4,228 audit blocks across 2 shards) and ~87ms on a bigger
// one (4,604 blocks over 3 shards, 326 files), so caching would only add a
// staleness window to a dashboard whose entire purpose is not being stale.
//
// The selected workspace lives in ONE mutable variable here. That is the only
// mutable state in the process, and it is the price of letting the user pick a
// folder in the browser instead of restarting with a different --root. It holds a
// path the server validated itself (see /select), never a raw client string.
//
// Read-only with respect to the workspace: no route writes to it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HOST, type Options, USAGE, UsageError, expandHome, parseArgs } from "./cli";
import { createMemo } from "./credit/claude/transcript-reader";
import { type AcpSessionRef, collectUsageViaAcp } from "./credit/collector/acp-collector";
import type { ParseResult } from "./credit/parser/usage-parser";
import {
  type PollHalt,
  type Pollable,
  PollingScheduler,
} from "./credit/pipeline/polling-scheduler";
import { type PipelineStore, RefreshPipeline } from "./credit/pipeline/refresh-pipeline";
import { SnapshotStore } from "./credit/storage/snapshot-store";
import { type CreditReadStore, assembleCredit } from "./credit/view/credit-model";
import { resolveWindow } from "./credit/view/credit-view";
import { NoRunError, type UsageContext, assemble } from "./model/assemble";
import type { Locale } from "./model/types";
import { esc } from "./render/common";
import { type Strings, strings } from "./render/i18n";
import { DEFAULT_LOCALE, localeCookie, localeFromQuery, resolveLocale } from "./render/locale";
import { renderBody, renderPage } from "./render/page";
import { renderPicker } from "./render/picker";
import { renderViewPage } from "./render/view-page";
import { refusalText, warningText } from "./render/warnings";
import { browse, resolveWorkspace } from "./scan/browse";
import { buildExplorer } from "./scan/explorer";
import { openArtifact } from "./scan/open-file";
import { resolveState } from "./scan/resolve";
import { readWorkspaceSummary } from "./scan/summary";
import { readArtifactSource } from "./scan/view-file";
import { discoverWorkspaces } from "./scan/workspaces";
import { VERSION } from "./version";

/** Path the u3 credit view's no-JS refresh form POSTs to (must match verbatim). */
const REFRESH_PATH = "/api/credit/refresh";

/**
 * Routes that change something, so a cross-site caller must not reach them. Two are
 * GETs on purpose — the browser cannot POST from an `<a>` — and both have side
 * effects: `/select` moves `activeRoot`, `/open` launches an OS process.
 */
const STATE_CHANGING = new Set(["/api/refresh", REFRESH_PATH, "/select", "/open"]);

/** Loopback, in the forms a Host or Origin header actually arrives in. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * True when the request came from a page on some OTHER origin.
 *
 * `Sec-Fetch-Site` is the answer when the browser sends it (every current one does):
 * `same-origin` is our own page, `none` is the address bar. Anything else — including
 * `same-site`, which a sibling port is — is somebody else's page. `Origin` is the
 * fallback for an older browser.
 *
 * NEITHER header means NOT A BROWSER. curl and the test suite send no `Sec-Fetch-Site`
 * and no `Origin`, they are not the threat this guards against, and they must keep
 * working — CSRF is a browser-mediated attack by definition.
 */
function crossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  try {
    return !isLoopbackHost(new URL(origin).hostname);
  } catch {
    return true; // unparseable Origin is not something to give the benefit of the doubt
  }
}

/**
 * `setCookie` is only ever the locale cookie, set when a reader passed `?lang=`.
 * `extra` is per-route hardening — only `/view` uses it, and only to lock down a page
 * built from file contents (see that case).
 */
function html(
  body: string,
  status = 200,
  setCookie?: string,
  extra?: Record<string, string>,
): Response {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  };
  if (setCookie !== undefined) headers["set-cookie"] = setCookie;
  return new Response(body, { status, headers });
}

/**
 * The record dir of the active intent, without assembling the whole model.
 *
 * `/open` and `/view` need exactly one field — the jail root — and reaching it through
 * `assemble` was expensive in a way that did not show: on a `.claude` tree `assemble`
 * reads the transcripts whether or not a `UsageContext` was passed, and the bare call
 * `/open` used carried no memo, so every artifact click paid a COLD transcript read
 * (measured worst case in transcript-reader.ts's header: 268ms for a 30-day window).
 * `resolveState` is a handful of `readFileSync`/`existsSync` calls and answers the same
 * question — it is the same function `assemble` itself starts from.
 *
 * Carries the resolve KIND on failure rather than `undefined`: `none` and `ambiguous` are
 * different sentences (`NoRunError` keeps them apart for exactly that reason), and the
 * caller has no way to recover the distinction once it is flattened.
 */
type RecordDirResult = { ok: true; recordDir: string } | { ok: false; kind: "none" | "ambiguous" };

function activeRecordDir(root: string): RecordDirResult {
  const resolved = resolveState(root);
  if (resolved.kind !== "ok") return { ok: false, kind: resolved.kind };
  return { ok: true, recordDir: path.dirname(path.join(root, resolved.rel)) };
}

function json(value: unknown, status = 200): Response {
  // Map is not JSON-serialisable; the scan layer uses it for per-stage tallies,
  // so convert on the way out rather than distorting the internal types.
  const body = JSON.stringify(value, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v), 2);
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

/** An error page that still says which workspace was being read. */
function errorPage(root: string, message: string, locale: Locale = DEFAULT_LOCALE): string {
  const t = strings(locale).errorPage;
  return `<!DOCTYPE html><html lang="${locale}"><head><meta charset="utf-8">
<title>${esc(t.docTitle)}</title>
<style>body{font:14px/1.6 ui-sans-serif,-apple-system,sans-serif;margin:40px auto;max-width:640px;
padding:0 18px;color:#1b1f2a}code{background:#eef0f4;padding:1px 5px;border-radius:4px}
h1{font-size:17px}a{color:#2f6fd0}</style></head>
<body><h1>${esc(t.heading)}</h1>
<p>${esc(message)}</p>
<p>${esc(t.triedPathLabel)}<code>${esc(root)}</code></p>
<p>${t.checkThis}</p>
<p><a href="/pick">${esc(t.pickAnother)}</a></p>
</body></html>`;
}

/** The workspace currently being shown. Mutated only by /select. */
let activeRoot: string | undefined;

/**
 * Per-file memo for the Claude transcript reader, held for the process lifetime.
 *
 * This is NOT a second piece of mutable state in the sense `activeRoot` is: its
 * keys are `(path, size, mtimeMs)`, so it cannot answer differently from a cold
 * read of the same files. Claude Code transcripts are append-only, which means an
 * edit always moves size and mtime and therefore always misses the memo. It buys
 * back the cost of re-parsing unchanged transcripts on every 60s poll (measured:
 * 410ms for a 217MB 30-day window) without introducing a staleness window.
 */
const transcriptMemo = createMemo();

/**
 * The credit subsystem the request handler sees. Both fields are optional: when
 * the subsystem failed to boot the dashboard still serves everything else, and
 * the credit slot degrades to a `none` view (NFR1.5). `store` is read by
 * `assemble` (u1 read contract); `pipeline` is triggered by the manual refresh
 * POST (u2 run contract). Injected explicitly so `handle` stays testable.
 */
export interface CreditRuntime {
  store?: CreditReadStore;
  pipeline?: Pollable;
  /**
   * Why automatic collection stopped, or null while it is running. Read on every render
   * so the panel can say "the timer is off, and here is what it last saw" rather than
   * leaving a stale figure to look like a live one.
   *
   * Optional like the other fields here: a test injects the seams it needs.
   */
  pollHalt?: () => PollHalt | null;
  /** Restart a halted timer. Called after a MANUAL refresh succeeds — the path back to
   *  automatic collection when upstream recovers, with no process restart. */
  resumePolling?: () => void;
  isCollecting?: () => boolean;
  markCollectionDone?: () => void;
}

export async function handle(
  req: Request,
  opts: Options,
  credit: CreditRuntime = {},
): Promise<Response> {
  const url = new URL(req.url);

  // ---- browser-mediated request guards -------------------------------------
  //
  // The loopback BIND stops a remote socket. It does not stop a page already open in
  // the user's own browser from reaching this server, and that leaves two separate
  // holes — measured, all three exploits below succeeded before these checks:
  //
  //   HOST — DNS rebinding. A domain the attacker controls that resolves to 127.0.0.1
  //     is SAME-ORIGIN as far as the browser is concerned, so their script can read
  //     the response. `/api/model` is the whole assembled model: workspace paths,
  //     artifact names, question text. Answering only to a loopback Host closes it,
  //     and it costs nothing because there is no legitimate non-loopback name for a
  //     server bound to 127.0.0.1.
  //   ORIGIN — CSRF. A cross-site form POST needs no preflight, so any page could fire
  //     `/api/credit/refresh` and make this process spawn `kiro-cli`; a bare `<img>`
  //     could hit GET `/select` (moves activeRoot under the user's feet) or GET
  //     `/open` (launches an editor). Read-only with respect to the workspace is not
  //     the same as harmless.
  //
  // The Host check covers every route; the Origin check only the state-changing ones,
  // because a cross-site GET of a page it cannot read is not worth refusing.
  if (!isLoopbackHost(url.hostname)) {
    return new Response("bad host", { status: 403 });
  }
  if (STATE_CHANGING.has(url.pathname) && crossSiteRequest(req)) {
    return new Response("cross-site request refused", { status: 403 });
  }

  if (url.pathname === "/api/refresh") {
    if (req.method !== "POST") return new Response("read-only", { status: 405 });
    if (!credit.pipeline) return json({ error: "credit runtime unavailable" }, 503);
    try {
      const result = await credit.pipeline.run("manual");
      // A manual success is the path back: automatic collection slows itself after N
      // consecutive failures (see polling-scheduler), and this clears that immediately.
      // `persisted` is part of "success" — the page reads STORED snapshots, so a collection
      // that could not be written has not refreshed anything and must not clear the backoff.
      if (result.snapshot.ok && result.persisted) credit.resumePolling?.();
      return json(result);
    } catch (err) {
      return json(
        {
          error: "credit refresh failed",
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    } finally {
      credit.markCollectionDone?.();
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    // The ONE write exception to the read-only policy: the manual credit refresh
    // POST triggers a single re-collection, then redirects back so the no-JS
    // form re-renders the full page with the fresh snapshot (BR3.1, BR6.2,
    // NFR1.2). Every other non-GET/HEAD request stays 405.
    if (req.method === "POST" && url.pathname === REFRESH_PATH) {
      if (credit.pipeline) {
        try {
          const result = await credit.pipeline.run("manual");
          if (result.snapshot.ok && result.persisted) credit.resumePolling?.();
        } catch (err) {
          // Collection failures are already captured as failure snapshots by u2;
          // a throw here would only be an unexpected defect. Isolate it — the
          // refresh must never 500 the page.
          console.warn(
            `[aidlc-dashboard] ${strings(opts.locale).cli.manualRefreshFailed(
              err instanceof Error ? err.message : String(err),
            )}`,
          );
        } finally {
          credit.markCollectionDone?.();
        }
      }
      const cw = url.searchParams.get("cw");
      return redirect(cw ? `/?cw=${encodeURIComponent(cw)}` : "/");
    }
    return new Response("read-only", { status: 405 });
  }

  const showHidden = url.searchParams.get("hidden") === "1";

  // Resolved OUTSIDE the try so the catch's error page can be marked up in the
  // reader's language too. Per request, never stored on the server — `activeRoot` is
  // the one mutable thing in this process and a language is not workspace state
  // (`render/locale.ts`). An explicit `?lang=` also gets a cookie so it survives the
  // next click without every link having to carry the param, which is what `?cw=`
  // has to do.
  const langParam = url.searchParams.get("lang");
  const locale = resolveLocale({
    query: langParam,
    cookie: req.headers.get("cookie"),
    acceptLanguage: req.headers.get("accept-language"),
    fallback: opts.locale,
  });
  const stickyLocale = localeFromQuery(langParam) !== undefined ? localeCookie(locale) : undefined;
  const s: Strings = strings(locale);

  try {
    // Usage context for the rendering routes: the Kiro store (when wired) plus the
    // sanitised trend window from `?cw=` (invalid/absent → 30d, BR5.2). Always
    // built now, not only when a store exists — the Claude token panel needs no
    // store, so gating the whole context on `credit.store` would silently disable
    // it. `assemble` still degrades the Kiro side to a `none` view on its own.
    //
    // Built INSIDE the try: `credit.isCollecting` is injected, so a throw here has
    // to land on the error page like any other read failure rather than escaping
    // to Bun's default 500 (NFR1.5 — credit never takes the dashboard down).
    const usageCtx: UsageContext = {
      store: credit.store,
      window: resolveWindow(url.searchParams.get("cw")),
      collecting: credit.isCollecting?.() ?? false,
      pollHalt: credit.pollHalt?.() ?? null,
      mode: opts.usageMode,
      memo: transcriptMemo,
    };

    switch (url.pathname) {
      // ---- folder picker ----------------------------------------------------
      case "/pick":
      case "/browse": {
        // Default to the parent of the active workspace so the picker opens
        // somewhere useful rather than at the home dir every time.
        const dirParam = url.searchParams.get("dir");
        const fallback = activeRoot ? path.dirname(activeRoot) : os.homedir();
        const dir = dirParam ? expandHome(dirParam) : expandHome(fallback);
        const listing = browse(dir, showHidden);
        return html(
          renderPicker(
            listing,
            showHidden,
            activeRoot,
            discoverWorkspaces(),
            buildExplorer(listing.dir, { activeRoot }),
            locale,
          ),
          200,
          stickyLocale,
        );
      }

      case "/select": {
        const raw = url.searchParams.get("dir");
        if (!raw) return redirect("/pick");
        // Validate on the SERVER: accept only a path that really is a workspace
        // (or the `aidlc/` dir inside one). A client string never becomes the
        // active root unvalidated.
        const picked = resolveWorkspace(expandHome(raw));
        if (!picked) {
          const dir = expandHome(raw);
          const listing = browse(dir, showHidden);
          return html(
            renderPicker(
              { ...listing, error: s.errorPage.notAWorkspace(dir) },
              showHidden,
              activeRoot,
              discoverWorkspaces(),
              buildExplorer(listing.dir, { activeRoot }),
              locale,
            ),
            400,
            stickyLocale,
          );
        }
        activeRoot = picked;
        return redirect("/");
      }

      // ---- dashboard -------------------------------------------------------
      case "/": {
        // No workspace chosen yet → the picker IS the landing page.
        if (!activeRoot) {
          const listing = browse(os.homedir(), showHidden);
          return html(
            renderPicker(
              listing,
              showHidden,
              undefined,
              discoverWorkspaces(),
              buildExplorer(listing.dir),
              locale,
            ),
            200,
            stickyLocale,
          );
        }
        return html(
          renderPage(assemble(activeRoot, opts.harnessDir, usageCtx), opts.pollMs, locale),
          200,
          stickyLocale,
        );
      }

      case "/api/body": {
        if (!activeRoot) return html(`<p class="note">${esc(s.errorPage.noWorkspaceSelected)}</p>`);
        // Just the refreshable region — what the browser poll swaps in.
        return html(renderBody(assemble(activeRoot, opts.harnessDir, usageCtx), locale));
      }

      case "/api/current": {
        if (!credit.store) return json({ error: "credit runtime unavailable" }, 503);
        const model = assembleCredit(
          credit.store,
          new Date(),
          "30d",
          credit.isCollecting?.() ?? false,
          credit.pollHalt?.() ?? null,
        );
        const state =
          model.status === "loading"
            ? "loading"
            : model.current !== null || model.warning !== null
              ? "populated"
              : "empty";
        return json({
          state,
          status: model.status,
          current: model.current,
          warning: model.warning,
          freshness: model.freshness,
          // The page says "collection slowed"; a JSON consumer that cannot see that field would
          // read these figures as still being refreshed on the normal cadence.
          pollHalt: model.pollHalt,
        });
      }

      case "/api/trend": {
        if (!credit.store) return json({ error: "credit runtime unavailable" }, 503);
        const window = resolveWindow(url.searchParams.get("window"));
        return json(assembleCredit(credit.store, new Date(), window).trend);
      }

      case "/api/model": {
        if (!activeRoot) return json({ error: "no workspace selected" }, 409);
        return json(assemble(activeRoot, opts.harnessDir, usageCtx));
      }

      // ---- open an artifact in the user's editor ----------------------------
      // The browser cannot launch a local app; this server can, because the user
      // started it. `rel` is hostile input — openArtifact jails it under the
      // record dir before anything is spawned (see scan/open-file.ts).
      case "/open": {
        if (!activeRoot) return json({ error: "no workspace selected" }, 409);
        const rel = url.searchParams.get("rel");
        if (!rel) return json({ error: s.cli.needValue("rel") }, 400);
        const record = activeRecordDir(activeRoot);
        if (!record.ok) throw new NoRunError(record.kind, activeRoot);
        const res = openArtifact(record.recordDir, rel, s);
        if (!res.ok)
          return json(
            { error: refusalText(res.refusal, s), code: res.refusal.code, rel },
            res.status,
          );
        // 204: the click opened an editor, so the page must NOT navigate away.
        return new Response(null, { status: 204 });
      }

      // ---- one workspace's headline numbers, for the picker's cards ----------
      // The picker renders labelled empty slots and the page fills them in, one fetch
      // per card, so discovery still paints immediately (see render/picker.ts).
      //
      // `dir` is a CLIENT STRING and is treated as one: it becomes a path only through
      // `resolveWorkspace`, the same validator `/select` uses, so this can only ever read
      // something that really is an AI-DLC workspace. It never touches `activeRoot` —
      // reading a workspace and selecting one are different acts.
      //
      // On cost: this is deliberately NOT `assemble` (see scan/summary.ts for the measured
      // 5–16x), which also means it is cheaper than `/api/body`, an unguarded GET that has
      // always run a full assemble. So this adds no new exposure class, and the check that
      // matters — loopback `Host` — covers it like every route.
      case "/api/summary": {
        const raw = url.searchParams.get("dir");
        if (!raw) return json({ error: s.cli.needValue("dir") }, 400);
        const picked = resolveWorkspace(expandHome(raw));
        if (!picked) return json({ error: "not a workspace" }, 400);
        return json(readWorkspaceSummary(picked));
      }

      // ---- show an artifact's source in the dashboard ------------------------
      // Read-only and side-effect free, which is why it is NOT in STATE_CHANGING:
      // unlike `/open` it launches nothing. `rel` goes through the same jail
      // (`resolveArtifact`), so the two readers cannot diverge on what is in bounds.
      case "/view": {
        if (!activeRoot) {
          const noRoot = s.errorPage;
          return html(errorPage(noRoot.noSelection, noRoot.noWorkspaceSelected, locale), 409);
        }
        const rel = url.searchParams.get("rel");
        if (!rel) return html(errorPage(activeRoot, s.cli.needValue("rel"), locale), 400);
        const record = activeRecordDir(activeRoot);
        if (!record.ok) throw new NoRunError(record.kind, activeRoot);
        const result = readArtifactSource(record.recordDir, rel);
        return html(
          renderViewPage(result, rel, locale),
          result.ok ? 200 : result.status,
          stickyLocale,
          // The page shows a file this dashboard treats as hostile input. It is escaped,
          // so nothing here executes — this is the second line: with `default-src 'none'`
          // an escaping bug has no origin left to act in, and `nosniff` stops the browser
          // second-guessing the content type of an artifact whose name we do not control.
          {
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
            "x-content-type-options": "nosniff",
          },
        );
      }

      case "/healthz":
        return json({ ok: true, root: activeRoot ?? null });

      default:
        return new Response("not found", { status: 404 });
    }
  } catch (err) {
    const root = activeRoot ?? s.errorPage.noSelection;
    if (err instanceof NoRunError) {
      // Re-said in the reader's language from the FACTS the error carries, not from its
      // own `message` — that one was built with the default catalogue for the terminal.
      const said =
        err.kind === "ambiguous" ? s.cli.intentAmbiguous(err.root) : s.cli.noWorkflow(err.root);
      return html(errorPage(root, said, locale), 404);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[aidlc-dashboard] ${s.cli.routeFailed(url.pathname)}`, err);
    return html(errorPage(root, s.errorPage.readFailed(message), locale), 500);
  }
}

// ---- credit subsystem boot & lifecycle ------------------------------------

/** The booted credit subsystem, or a degraded shell when boot failed. */
export interface CreditSubsystem extends CreditRuntime {
  store?: CreditReadStore;
  pipeline?: Pollable;
  scheduler?: { stop(): void };
  /**
   * Closes the booted store, if it can be closed. A separate field rather than a
   * method on `CreditReadStore`: that interface is the read contract `assembleCredit`
   * consumes, and shutdown is not its business. No-ops for an injected test store.
   */
  closeStore?: () => void;
  degraded: boolean;
  isCollecting: () => boolean;
  markCollectionDone: () => void;
}

/** Minimal shapes the boot sequence needs, so tests can inject failing seams. */
interface StoreForBoot extends CreditReadStore, PipelineStore {
  init(): void;
  close?(): void;
}
interface PipelineForBoot extends Pollable {
  init(): void;
}
interface SchedulerForBoot {
  start(runImmediately: boolean): void;
  stop(): void;
  /** Optional so an existing test stub stays valid; the real scheduler has both. */
  readonly halt?: PollHalt | null;
  resume?(): void;
}

/** Injectable factories — real constructors by default, stubs in tests. */
export interface CreditBootDeps {
  intervalMs?: number;
  /** Language for the isolated-boot-failure line. Defaults to `ko` for a bare test call. */
  locale?: Locale;
  createStore?: () => StoreForBoot;
  createPipeline?: (store: StoreForBoot) => PipelineForBoot;
  createScheduler?: (
    pipeline: PipelineForBoot,
    onSettled: () => void,
    intervalMs: number | undefined,
  ) => SchedulerForBoot;
}

/**
 * Boot the credit subsystem: open the store, seed the pipeline's sequence
 * counter, and start the 5-minute polling scheduler with an immediate first
 * collection (BR2.1). ANY failure here is isolated — the dashboard must start
 * regardless, with credit degraded (NFR1.5). Factories are injectable so a test
 * can drive the init-failure path without a real SQLite handle.
 */
export function bootCredit(deps: CreditBootDeps = {}): CreditSubsystem {
  const locale = deps.locale ?? DEFAULT_LOCALE;
  let collecting = true;
  const markCollectionDone = () => {
    collecting = false;
  };
  const isCollecting = () => collecting;

  try {
    const store = (
      deps.createStore ??
      (() => {
        // bun:sqlite (unlike the former JSONL writer) does NOT create the parent
        // directory, so ensure the default `./data` dir exists before opening the
        // DB. This is part of the credit snapshot-storage write path — the one
        // write exception the read-only dashboard allows (BR6.4).
        fs.mkdirSync("data", { recursive: true });
        return new SnapshotStore();
      })
    )();
    store.init();
    // ACP 세션은 프로세스 수명 동안 하나만 만든다(acp-collector 머리주석의 세션 파일 실측).
    //
    // 획득은 SERIALISED 되어야 한다. 파이프라인은 자동·수동 동시 실행을 허용하는데(BR3.2 의
    // pre-await sequence 가 그걸 전제한다), `AcpSessionRef` 는 잠금 없는 가변 객체다. 첫 두
    // 호출이 겹치면 둘 다 `session/new` 를 실행해 "재시작당 세션 1개" 라는 근거가 깨지고, 그
    // 뒤로는 서로 다른 ACP 프로세스 둘이 같은 세션을 동시에 load 한다. 꼬리물기 promise 하나로
    // 충분하다 — 수집은 5분에 한 번이고 2초 걸린다.
    const acpSession: AcpSessionRef = {};
    let acpChain: Promise<unknown> = Promise.resolve();
    const acquireSerially = (): Promise<ParseResult> => {
      const next = acpChain.then(() => collectUsageViaAcp({ session: acpSession }));
      // 앞 호출의 실패가 뒤 호출을 막지 않도록 체인은 실패를 삼킨다.
      acpChain = next.catch(() => undefined);
      return next;
    };
    const pipeline = (
      deps.createPipeline ??
      ((s) =>
        new RefreshPipeline({
          store: s,
          acquire: acquireSerially,
        }))
    )(store);
    pipeline.init();
    const scheduler = (
      deps.createScheduler ??
      ((p, onSettled, intervalMs) =>
        new PollingScheduler({
          pipeline: p,
          intervalMs,
          onTick: onSettled,
          onError: onSettled,
        }))
    )(pipeline, markCollectionDone, deps.intervalMs);
    scheduler.start(true);
    return {
      store,
      pipeline,
      scheduler,
      pollHalt: () => scheduler.halt ?? null,
      resumePolling: () => scheduler.resume?.(),
      closeStore: () => store.close?.(),
      degraded: false,
      isCollecting,
      markCollectionDone,
    };
  } catch (err) {
    console.error(
      `[aidlc-dashboard] ${strings(locale).cli.creditBootFailed(
        err instanceof Error ? err.message : String(err),
      )}`,
    );
    markCollectionDone();
    return {
      degraded: true,
      isCollecting,
      markCollectionDone,
      pollHalt: () => null,
      resumePolling: () => {},
    };
  }
}

/**
 * Stop the polling scheduler's timer on shutdown (BR2.2), then close the store so
 * SQLite folds its WAL back into the DB file. Both are optional: a degraded boot
 * has neither, and an injected test store need not be closable — no-op then.
 */
export function shutdownCredit(scheduler?: { stop(): void }, closeStore?: () => void): void {
  scheduler?.stop();
  closeStore?.();
}

// ---- process entry point --------------------------------------------------

if (import.meta.main) {
  let opts: Options;
  try {
    opts = parseArgs(Bun.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      if (err.message) console.error(`error: ${err.message}\n`);
      console.error(USAGE);
      process.exit(err.message ? 2 : 0);
    }
    throw err;
  }

  const cliStrings = strings(opts.locale).cli;
  activeRoot = opts.root;

  // With a --root, fail loudly at startup rather than on first request. Without
  // one, there is nothing to validate yet — the picker will do it.
  if (activeRoot) {
    try {
      const m = assemble(activeRoot, opts.harnessDir);
      console.log(
        `[aidlc-dashboard] ${m.identity.slug ?? m.identity.record} · ${m.state.lifecyclePhase} ${m.state.overallPct}% · ` +
          `blockers ${m.blockers.length} · ${cliStrings.startupSummary(
            m.totalEvents,
            opts.locale,
          )} · harness ${m.identity.harnessDir ?? cliStrings.harnessNotFound}`,
      );
      for (const w of m.warnings) console.warn(`[warn] ${w.code} — ${warningText(w)}`);
    } catch (err) {
      console.error(`[aidlc-dashboard] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    console.log(`[aidlc-dashboard] ${cliStrings.noRootPicker}`);
  }

  // Boot credit AFTER the workspace check so a --root typo still fails fast, and
  // isolate it so a credit boot failure never blocks the server (NFR1.5).
  const credit = bootCredit({ intervalMs: opts.intervalMs, locale: opts.locale });

  // Clean up the polling timer and close the store on termination (BR2.2). The
  // timer is unref'd, so the process can exit on its own; stopping is explicit
  // belt-and-braces. Closing is not — it is what checkpoints the WAL.
  process.on("SIGINT", () => {
    shutdownCredit(credit.scheduler, credit.closeStore);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdownCredit(credit.scheduler, credit.closeStore);
    process.exit(0);
  });

  const server = Bun.serve({
    hostname: HOST, // loopback-only bind (BR6.1, NFR1.1) — Bun's own default is 0.0.0.0
    port: opts.port,
    fetch: (req) => handle(req, opts, credit),
    // `handle` already turns read failures into the Korean error page. This is the
    // last line: anything thrown outside its try (or while streaming a response)
    // would otherwise leave through Bun's built-in 500, which is English and says
    // nothing about which workspace was being read.
    error(err) {
      console.error(`[aidlc-dashboard] ${strings(opts.locale).cli.unhandled}`, err);
      const message = err instanceof Error ? err.message : String(err);
      const t = strings(opts.locale).errorPage;
      return html(errorPage(activeRoot ?? t.noSelection, t.readFailed(message), opts.locale), 500);
    },
  });

  console.log(
    `[aidlc-dashboard] v${VERSION} · http://${HOST}:${server.port}  (poll ${opts.pollMs}ms, collect ${opts.intervalMs}ms, lang ${opts.locale}, workspace read-only${credit.degraded ? ", credit degraded" : ""})`,
  );
}
