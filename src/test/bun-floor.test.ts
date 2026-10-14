// The minimum Bun the launchers and installers accept, pinned to ONE number.
//
// `package.json`'s `engines.bun` is that number. It cannot simply be read at run time:
// install.sh and install.ps1 run before the archive exists (piped from curl), and a
// launcher that parses JSON in sh or cmd is more code than the check it serves. So each
// script carries a literal, and this file is what keeps the four literals and the
// manifest from drifting. The floor must also stay at or above the `@types/bun` floor:
// typecheck admits every API that version declares, so a lower runtime floor would let
// the launcher wave through a Bun the code was never checked against.
//
// The sh comparator is RUN, not just pattern-matched — a version check that compares
// strings would pass `1.10.0 < 1.4.0`. The PowerShell copy cannot be run on a machine
// without pwsh, so for it only the literal is pinned.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

const manifest = JSON.parse(read("package.json")) as {
  engines?: { bun?: string };
  devDependencies?: Record<string, string>;
};

const floorOf = (range: string | undefined): string => {
  const m = /^>=(\d+\.\d+\.\d+)$/.exec(range ?? "");
  if (!m?.[1]) throw new Error(`not a plain ">=X.Y.Z" floor: ${String(range)}`);
  return m[1];
};

const cmp = (a: string, b: string): number => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
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
  test("engines.bun is at or above the @types/bun floor", () => {
    expect(cmp(FLOOR, floorOf(manifest.devDependencies?.["@types/bun"]))).toBeGreaterThanOrEqual(0);
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

describe("the sh comparator", () => {
  const fn = shFunction("install.sh");
  const run = (min: string, version: string): number => {
    const p = Bun.spawnSync([
      "sh",
      "-c",
      `${fn}\nMIN_BUN="$1"\nbun_version_ok "$2"`,
      "sh",
      min,
      version,
    ]);
    return p.exitCode;
  };

  const cases: [min: string, version: string, exit: number][] = [
    ["1.4.0", "1.4.0", 0],
    ["1.4.0", "1.4.3", 0],
    ["1.4.0", "2.0.0", 0],
    ["1.4.0", "v1.4.0", 0],
    ["1.4.0", "1.3.14", 1],
    ["1.4.0", "0.9.99", 1],
    // Numeric, not lexical: "1.10.0" sorts before "1.4.0" as a string.
    ["1.4.0", "1.10.0", 0],
    ["1.10.0", "1.9.9", 1],
    // A canary or build suffix reads as its release number.
    ["1.4.0", "1.4.3-canary.1+abc123", 0],
    ["1.4.0", "1.3.99-canary.7", 1],
    // Not a version: unknown, never "too old".
    ["1.4.0", "", 2],
    ["1.4.0", "garbage", 2],
    ["1.4.0", "1.4", 2],
    ["1.4.0", "bun 1.4.3", 2],
  ];
  for (const [min, version, exit] of cases) {
    test(`min ${min}, bun ${JSON.stringify(version)} → ${exit}`, () => {
      expect(run(min, version)).toBe(exit);
    });
  }
});

describe("start.sh on a Bun below the floor", () => {
  // Stops before `bun install`, the browser poller and the server — so this run has no
  // side effect beyond its output. The fake bun answers only `--version` and records any
  // other call, which must not happen. Should the check ever let it through, `--port 1`
  // keeps the poller from finding (and opening a browser on) a real dashboard.
  test("refuses with the upgrade command and runs nothing else", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bun-floor-"));
    try {
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      const calls = path.join(tmp, "calls");
      fs.writeFileSync(
        path.join(bin, "bun"),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.3.14; else echo "$@" >> "${calls}"; fi\n`,
        { mode: 0o755 },
      );
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
