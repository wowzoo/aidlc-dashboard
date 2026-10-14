// The single source of truth for the build's version — and its Bun floor: `package.json`.
//
// Read from disk at import rather than imported as JSON. Importing the JSON would
// need `resolveJsonModule` in tsconfig and an import attribute, and would bake the
// value into the module graph; reading it keeps the packaged copy and the repo copy
// honest with one file. It is read once at startup, so the cost is a single stat.
//
// Never throws. A build whose package.json is missing or malformed still serves the
// dashboard — it just reports `unknown`, which is a truthful answer and better than
// a boot failure over a display string. A missing or malformed floor means no floor.

import * as fs from "node:fs";
import * as path from "node:path";

const manifest = readManifest();

/** Version reported on screen, in the startup log and by the packaging script. */
export const VERSION: string =
  typeof manifest.version === "string" && manifest.version.length > 0
    ? manifest.version
    : "unknown";

/**
 * The oldest Bun this build runs on: `engines.bun`'s `>=X.Y.Z`, else undefined. The
 * launchers carry the same number as a literal (they run before any JS does); the
 * server checks it too, because `bun run src/server.ts` and `bun run start` bypass
 * every launcher. `src/test/bun-floor.test.ts` pins the copies together.
 */
export const BUN_FLOOR: string | undefined = (() => {
  const range = manifest.engines?.bun;
  const m = typeof range === "string" ? /^>=(\d+\.\d+\.\d+)$/.exec(range) : null;
  return m?.[1];
})();

/**
 * Whether `have` (a `bun --version` / `Bun.version` string) is below `floor`:
 * `undefined` when it is not a version, which is never read as "too old". Only the
 * leading X.Y.Z counts, except that a prerelease of exactly the floor
 * (`1.4.0-canary.1`) is below it, as semver orders it — a canary of a later release
 * reads as that release. The launchers' sh and PowerShell comparators follow the
 * same rule.
 */
export function belowFloor(have: string, floor: string): boolean | undefined {
  const h = /^v?(\d+)\.(\d+)\.(\d+)(-)?/.exec(have);
  const f = /^(\d+)\.(\d+)\.(\d+)$/.exec(floor);
  if (!h || !f) return undefined;
  for (let i = 1; i <= 3; i++) {
    const d = Number(h[i]) - Number(f[i]);
    if (d !== 0) return d < 0;
  }
  return h[4] === "-";
}

/** The two fields read, typed as loosely as a hand-edited file can make them. */
type Manifest = { version?: unknown; engines?: { bun?: unknown } | null };

function readManifest(): Manifest {
  const p = path.join(import.meta.dir, "..", "package.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Manifest) : {};
  } catch {
    return {};
  }
}
