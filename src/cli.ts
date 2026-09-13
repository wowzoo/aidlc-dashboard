// Command-line surface: `bun run src/server.ts --root <path> [--port N]`.
//
// The root is required and validated up front rather than on first request: a
// typo'd path should fail at startup with a usable message, not render an empty
// dashboard that looks like a finished run.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Locale, UsageMode } from "./model/types";
import { type Strings, strings } from "./render/i18n";
import { DEFAULT_LOCALE, isLocale } from "./render/locale";

/**
 * Resolve a path, expanding a leading `~`. The shell does this for a typed
 * command, but the picker's text field reaches us verbatim, so both entry points
 * go through here to behave the same way.
 */
export function expandHome(p: string): string {
  const trimmed = p.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.resolve(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

export interface Options {
  /**
   * Absolute path of the workspace holding the `aidlc/` tree. Undefined when the
   * user did not pass one — the server then opens the folder picker instead of
   * refusing to start.
   */
  root?: string;
  port: number;
  /** Milliseconds between browser polls; 0 disables auto-refresh. */
  pollMs: number;
  /** Milliseconds between credit collection runs. */
  intervalMs: number;
  /**
   * Harness dir to read the stage catalogue from (e.g. ".claude"). Normally
   * discovered — set this only when a tree holds several harness dirs and the
   * probe order would pick the wrong one.
   */
  harnessDir?: string;
  /**
   * Which usage panel to show. Default `auto` — resolved from the harness dir,
   * since a Kiro run's usage lives in a remote quota and a Claude Code run's
   * lives in local transcripts.
   */
  usageMode: UsageMode;
  /**
   * DEFAULT reading language, not the language. A reader's own `?lang=` / cookie /
   * `Accept-Language` outranks this, because one server is read by both audiences —
   * see `render/locale.ts`. This is only what an unadorned first request gets.
   */
  locale: Locale;
}

export const DEFAULT_PORT = 4321;
// Screen refresh cadence, unified to 1 minute across the integrated tree (BR4.1).
// This is the browser poll interval for /api/body; credit COLLECTION runs on its
// own 5-minute schedule (u2 PollingScheduler) and is deliberately separate.
export const DEFAULT_POLL_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
export const HOST = "127.0.0.1";
export const ENV_PORT = "AIDLC_DASHBOARD_PORT";
export const ENV_INTERVAL_MS = "AIDLC_DASHBOARD_INTERVAL_MS";

export const USAGE = `aidlc-dashboard — AI-DLC v2 run dashboard + credit usage

usage:
  bun run src/server.ts [--root <workspace>] [--port ${DEFAULT_PORT}] [--poll <ms>] [--interval <ms>]

  --root <path>     workspace holding the aidlc/ tree. OPTIONAL — omit it and the
                    browser opens a folder picker instead
  --port <n>        HTTP port (default ${DEFAULT_PORT}, env ${ENV_PORT})
  --poll <ms>       browser refresh interval, 0 to disable (default ${DEFAULT_POLL_MS})
  --interval <ms>   credit collection interval (default ${DEFAULT_INTERVAL_MS},
                    env ${ENV_INTERVAL_MS})
  --harness <dir>   harness dir for the stage catalogue (e.g. .kiro / .claude /
                    .aidlc). Auto-discovered; pass this only when a tree holds
                    several and the probe picks the wrong one.
  --usage <mode>    usage panel: auto (default) | kiro | claude. auto follows the
                    harness dir — .claude shows Claude Code token counts read from
                    local transcripts, anything else shows kiro-cli credit quota.
  --lang <ko|en>    DEFAULT page language (default ko). A reader overrides it per
                    request with ?lang=, which then sticks in a cookie; their
                    Accept-Language is consulted before this default.
  --help            this message

Harness-agnostic: the dashboard reads the aidlc/ docs tree, which is identical
across Kiro CLI, Kiro IDE and Claude Code. The one panel that differs is usage,
because the two harnesses expose it differently — see --usage. The workspace is
read-only; credit snapshots are stored separately under data/.`;

export class UsageError extends Error {}

/**
 * A millisecond flag below this is a unit mistake, not a choice — someone typed the
 * number of seconds. `--interval 1` used to be accepted as one millisecond, which is
 * how a scheduler with no overlap guard ended up spawning ten collections at once.
 */
const MIN_MS = 1000;
const MAX_PORT = 65_535;

/**
 * `--lang` is read by a PRE-PASS over argv, before anything else is parsed.
 *
 * Otherwise a parse error would have to answer in whatever language the default happens
 * to be, which is the one message a reader of the other language most needs. The pre-pass
 * is deliberately forgiving — an invalid value falls back to the default and the real
 * flag loop reports it properly a moment later.
 */
function preScanLocale(argv: string[], fallback: Locale): Strings {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--lang" && isLocale(argv[i + 1])) return strings(argv[i + 1] as Locale);
  }
  return strings(fallback);
}

function intArg(raw: string | undefined, flag: string, t: Strings): number {
  if (raw === undefined) throw new UsageError(t.cli.needValue(flag));
  if (!/^\d+$/.test(raw)) throw new UsageError(t.cli.mustBeNumber(flag, raw));
  return Number(raw);
}

/** Bounds a millisecond flag. `zeroOk` is for `--poll`, where 0 disables the timer. */
function msArg(raw: string | undefined, flag: string, zeroOk: boolean, t: Strings): number {
  const v = intArg(raw, flag, t);
  if (zeroOk && v === 0) return v;
  if (v < MIN_MS) throw new UsageError(t.cli.msFloor(flag, MIN_MS, zeroOk, v));
  return v;
}

/**
 * An env var is a second entry to the same option, so it gets the same bounds — an
 * out-of-range `AIDLC_DASHBOARD_INTERVAL_MS` would otherwise walk straight past the
 * flag's floor. It falls back to the default rather than throwing: a bad flag is a
 * typo the user is watching for, a bad env var is often inherited from a shell.
 */
function intEnv(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < min || value > max) return undefined;
  return value;
}

/**
 * Parse argv (without the runtime/script entries). Throws UsageError with a
 * human message; the caller prints USAGE and exits.
 */
export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Options {
  let root: string | undefined;
  const t = preScanLocale(argv, DEFAULT_LOCALE);
  let port = intEnv(env[ENV_PORT], 1, MAX_PORT) ?? DEFAULT_PORT;
  let pollMs = DEFAULT_POLL_MS;
  let intervalMs =
    intEnv(env[ENV_INTERVAL_MS], MIN_MS, Number.MAX_SAFE_INTEGER) ?? DEFAULT_INTERVAL_MS;
  let harnessDir: string | undefined;
  let usageMode: UsageMode = "auto";
  let locale: Locale = DEFAULT_LOCALE;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--root":
        root = argv[++i];
        if (root === undefined) throw new UsageError(t.cli.needRoot);
        break;
      case "--port": {
        port = intArg(argv[++i], "--port", t);
        // Validated here rather than at bind time: `Bun.serve` would throw an English
        // message about a port this file already knows is out of range, and the whole
        // point of parsing up front is a usable one.
        if (port < 1 || port > MAX_PORT) throw new UsageError(t.cli.portRange(MAX_PORT, port));
        break;
      }
      case "--poll":
        pollMs = msArg(argv[++i], "--poll", true, t);
        break;
      case "--interval":
        intervalMs = msArg(argv[++i], "--interval", false, t);
        break;
      case "--harness":
        harnessDir = argv[++i];
        if (harnessDir === undefined) throw new UsageError(t.cli.needValue("--harness"));
        break;
      case "--usage": {
        const raw = argv[++i];
        if (raw === undefined) throw new UsageError(t.cli.needUsage);
        if (raw !== "auto" && raw !== "kiro" && raw !== "claude") {
          throw new UsageError(t.cli.badUsage(raw));
        }
        usageMode = raw;
        break;
      }
      case "--lang": {
        const raw = argv[++i];
        if (raw === undefined) throw new UsageError(t.cli.needLang);
        if (!isLocale(raw)) throw new UsageError(t.cli.badLang(raw));
        locale = raw;
        break;
      }
      case "--help":
      case "-h":
        throw new UsageError("");
      default:
        throw new UsageError(t.cli.unknownArg(String(a)));
    }
  }

  // No --root: start anyway and let the user pick in the browser.
  if (root === undefined) {
    return { root: undefined, port, pollMs, intervalMs, harnessDir, usageMode, locale };
  }

  const abs = expandHome(root);
  if (!fs.existsSync(abs)) throw new UsageError(t.cli.pathMissing(abs));
  // `aidlc/` is the ONLY hard requirement — the harness dir is optional, because
  // the docs tree is what this dashboard reads and it is identical on every
  // harness.
  if (!fs.existsSync(path.join(abs, "aidlc"))) {
    throw new UsageError(t.cli.notAWorkspace(abs));
  }
  if (harnessDir !== undefined && !fs.existsSync(path.join(abs, harnessDir))) {
    throw new UsageError(t.cli.harnessMissing(path.join(abs, harnessDir)));
  }

  return { root: abs, port, pollMs, intervalMs, harnessDir, usageMode, locale };
}
