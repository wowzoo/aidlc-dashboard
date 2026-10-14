// The minimum Bun the launchers, installers and server accept, pinned to ONE number.
//
// `package.json`'s `engines.bun` is that number, and the server reads it at run time
// (`src/version.ts`). The four scripts cannot: start.sh / start.ps1 check before any JS
// runs, and a JSON reader in sh or PowerShell is more code than the check it serves —
// so each carries a literal, and this file keeps the literals, README and the manifest
// from drifting. The installers are judged against the release they were cut with; a
// script cannot pin another release's archive, and the launcher in that archive has the
// final say.
//
// What this does NOT prove is that the floor still runs the code. 1.4.0 was measured
// (the full suite passes on it, 2026-10-14) and is the declared `@types/bun` floor, but
// typecheck runs against the LOCKED types (`bun.lock`, matching the dev's Bun), so a
// later-only API would pass every gate here. The `>=` check against the types floor only
// keeps the runtime floor from undercutting what the manifest itself declares.
//
// The comparators are RUN over one table — the sh one through `sh`, the server's through
// `belowFloor` — not pattern-matched: a check that compares strings would pass
// `1.10.0 < 1.4.0`. The PowerShell copy cannot run on a machine without pwsh, so for it
// only the literal is pinned. The sh runs need a POSIX shell and are skipped on win32.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BUN_FLOOR, belowFloor } from "../version";

const ROOT = path.join(import.meta.dir, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");
const POSIX = process.platform !== "win32";

const manifest = JSON.parse(read("package.json")) as {
  engines?: { bun?: string };
  devDependencies?: Record<string, string>;
};

const floorOf = (range: string | undefined): string => {
  const m = /^>=(\d+\.\d+\.\d+)$/.exec(range ?? "");
  if (!m?.[1]) throw new Error(`not a plain ">=X.Y.Z" floor: ${String(range)}`);
  return m[1];
};

const FLOOR = floorOf(manifest.engines?.bun);

/** Every literal `pattern` captures in `rel` — exactly one is expected. */
const literals = (rel: string, pattern: RegExp): string[] =>
  [...read(rel).matchAll(pattern)].map((m) => m[1] ?? "");

/** `bun_version_ok() { … }` as it stands in a script, closing brace included. */
function shFunction(rel: string): string {
  const text = read(rel);
  const start = text.indexOf("bun_version_ok() {");
  const end = text.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`bun_version_ok not found in ${rel}`);
  return text.slice(start, end + 2);
}

describe("one Bun floor", () => {
  test("engines.bun does not undercut the @types/bun floor", () => {
    const types = floorOf(manifest.devDependencies?.["@types/bun"]);
    expect(belowFloor(FLOOR, types)).toBe(false);
  });

  test("the server reads the same floor", () => {
    expect(BUN_FLOOR).toBe(FLOOR);
  });

  test("the Bun running this suite is not below it", () => {
    expect(belowFloor(Bun.version, FLOOR)).toBe(false);
  });

  for (const rel of ["start.sh", "install.sh"]) {
    test(`${rel} carries MIN_BUN=${FLOOR}`, () => {
      expect(literals(rel, /^MIN_BUN=(\S+)$/gm)).toEqual([FLOOR]);
    });
  }
  for (const rel of ["start.ps1", "install.ps1"]) {
    test(`${rel} carries $minBun = ${FLOOR}`, () => {
      expect(literals(rel, /^\$minBun = \[version\]'([^']+)'\r?$/gm)).toEqual([FLOOR]);
    });
  }

  test("README states the same floor wherever it names one", () => {
    const named = literals("README.md", /bun(?: 이)? (\d+\.\d+\.\d+) (?:이상|보다)/g);
    expect(named.length).toBe(3);
    expect(new Set(named)).toEqual(new Set([FLOOR]));
  });

  test("start.sh and install.sh share one comparator, byte for byte", () => {
    expect(shFunction("install.sh")).toBe(shFunction("start.sh"));
  });
});

/** [floor, version, below] — `undefined` is "not a version", never "too old". */
const CASES: [floor: string, version: string, below: boolean | undefined][] = [
  ["1.4.0", "1.4.0", false],
  ["1.4.0", "1.4.3", false],
  ["1.4.0", "2.0.0", false],
  ["1.4.0", "v1.4.0", false],
  ["1.4.0", "1.3.14", true],
  ["1.4.0", "0.9.99", true],
  // Numeric, not lexical: "1.10.0" sorts before "1.4.0" as a string.
  ["1.4.0", "1.10.0", false],
  ["1.10.0", "1.9.9", true],
  // A canary of a later release reads as that release; one of the floor itself is
  // below it, as semver orders a prerelease. Build metadata does not order.
  ["1.4.0", "1.4.3-canary.1+abc123", false],
  ["1.4.0", "1.3.99-canary.7", true],
  ["1.4.0", "1.4.0-canary.1", true],
  ["1.4.0", "1.4.0+abc123", false],
  ["1.4.0", "", undefined],
  ["1.4.0", "garbage", undefined],
  ["1.4.0", "1.4", undefined],
  ["1.4.0", "bun 1.4.3", undefined],
];

describe("the comparators agree on one table", () => {
  const fn = shFunction("install.sh");
  const sh = (floor: string, version: string): number =>
    Bun.spawnSync(["sh", "-c", `${fn}\nMIN_BUN="$1"\nbun_version_ok "$2"`, "sh", floor, version])
      .exitCode;

  for (const [floor, version, below] of CASES) {
    const exit = below === undefined ? 2 : below ? 1 : 0;
    test(`floor ${floor}, bun ${JSON.stringify(version)} → ${String(below)}`, () => {
      expect(belowFloor(version, floor)).toBe(below);
    });
    test.skipIf(!POSIX)(`sh: floor ${floor}, bun ${JSON.stringify(version)} → exit ${exit}`, () => {
      expect(sh(floor, version)).toBe(exit);
    });
  }
});

describe.skipIf(!POSIX)("start.sh on a Bun below the floor", () => {
  // Stops before `bun install`, the browser poller and the server, so this run has no
  // side effect beyond its output. The fake bun answers only `--version` and records any
  // other call, which must not happen. Should the check ever let it through, curl and
  // the openers are fakes too (first on PATH), so the poller can neither find a real
  // listener nor open a browser.
  test("refuses with the upgrade command and runs nothing else", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bun-floor-"));
    try {
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      const calls = path.join(tmp, "calls");
      const fake = (name: string, body: string) =>
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      fake(
        "bun",
        `if [ "$1" = "--version" ]; then echo 1.3.14; else echo "bun $*" >> "${calls}"; fi`,
      );
      for (const name of ["curl", "open", "xdg-open"])
        fake(name, `echo "${name} $*" >> "${calls}"; exit 7`);
      const p = Bun.spawnSync(["bash", path.join(ROOT, "start.sh"), "--port", "1"], {
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: tmp, AIDLC_DASHBOARD_LAUNCH_DIR: tmp },
        timeout: 4_000,
      });
      const err = p.stderr.toString();
      expect(p.exitCode).toBe(1);
      expect(err).toContain(`bun 1.3.14 은 너무 오래됐다 — ${FLOOR} 이상이 필요하다.`);
      expect(err).toContain("upgrade");
      expect(fs.existsSync(calls)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
