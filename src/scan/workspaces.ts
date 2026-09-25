// Bounded workspace discovery for the picker.
//
// The scan is intentionally synchronous: it runs only when the picker is
// rendered, and a directory-count ceiling keeps a large home directory from
// delaying the server indefinitely. Common development locations are searched
// first and more deeply than the rest of the home directory.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isWorkspaceDir } from "./browse";

const COMMON_DIRS = [
  "Development",
  "Developer",
  "Projects",
  "Project",
  "Code",
  "Repos",
  "Repositories",
  "Source",
  "Sources",
  "workspace",
  "workspaces",
] as const;

const SKIP_DIRS = new Set([
  "$recycle.bin",
  "__backup",
  ".git",
  ".hg",
  ".svn",
  "appdata",
  "applications",
  "build",
  "coverage",
  "data",
  "dist",
  "library",
  "movies",
  "music",
  "node_modules",
  "pictures",
  "target",
  "vendor",
]);

export interface WorkspaceMatch {
  name: string;
  path: string;
  /** True when the workspace is the launch dir or lies under it; listed first. */
  nearLaunch?: boolean;
}

export interface WorkspaceDiscovery {
  workspaces: WorkspaceMatch[];
  searchedRoots: string[];
  scannedDirectories: number;
  truncated: boolean;
}

export interface DiscoveryOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Maximum number of directories read across all roots. */
  maxDirectories?: number;
  /**
   * The directory the user launched the command from. Scanned first, on its own
   * budget, and its workspaces lead the list. Ignored when it is the home dir or an
   * ancestor of it — "here" would then mean "everything" and ranks nothing.
   */
  launchDir?: string;
}

/** Depth and budget of the launch-dir pass. Its own budget, so it cannot starve the main scan. */
const LAUNCH_MAX_DEPTH = 4;
const LAUNCH_MAX_DIRECTORIES = 1_000;

interface SearchRoot {
  path: string;
  maxDepth: number;
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function oneDriveRoots(home: string, env: Record<string, string | undefined>): string[] {
  const roots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial, env.ONEDRIVE].filter(
    (value): value is string => Boolean(value?.trim()),
  );

  try {
    for (const entry of fs.readdirSync(home, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.toLowerCase().startsWith("onedrive")) {
        roots.push(path.join(home, entry.name));
      }
    }
  } catch {
    // The home root itself will be reported as unavailable by the main scan.
  }
  return roots;
}

function searchRoots(
  home: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): SearchRoot[] {
  const bases = platform === "win32" ? [home, ...oneDriveRoots(home, env)] : [home];
  const candidates: SearchRoot[] = [];

  // Search likely project containers first. A global visited set prevents the
  // later home scan from reading them twice.
  for (const base of bases) {
    for (const name of COMMON_DIRS) {
      candidates.push({ path: path.join(base, name), maxDepth: 5 });
    }
    candidates.push({ path: path.join(base, "Documents"), maxDepth: 4 });
  }
  for (const base of bases) candidates.push({ path: base, maxDepth: 3 });

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = pathKey(candidate.path, platform);
    if (seen.has(key) || !directoryExists(candidate.path)) return false;
    seen.add(key);
    return true;
  });
}

function shouldSkip(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name.toLowerCase());
}

/**
 * Find directories that directly contain an `aidlc/` directory.
 *
 * Discovery never follows symlinks. It searches the launch dir first (when given)
 * to depth four, then common development locations to depth five and the
 * remaining home/OneDrive roots to depth three.
 */
export function discoverWorkspaces(options: DiscoveryOptions = {}): WorkspaceDiscovery {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = path.resolve(
    options.homeDir ??
      (platform === "win32" && env.USERPROFILE ? env.USERPROFILE : undefined) ??
      os.homedir(),
  );
  const maxDirectories = Math.max(1, options.maxDirectories ?? 5_000);
  const roots = searchRoots(home, env, platform);
  const found = new Map<string, WorkspaceMatch>();

  // The launch-dir pass runs FIRST and with its OWN visited set and budget. Sharing
  // the main scan's visited set would be wrong in both directions: a launch dir
  // under ~/workspaces would mark that subtree visited at depth 4 and the main scan
  // would then skip the depth-5 part of it.
  //
  // Downward before upward. Only when nothing is found at or below the launch dir is
  // it read as a subfolder of an enclosing workspace (`~/ws/aidlc/spaces` → `~/ws`).
  // The other order is wrong on a real tree: a folder of projects that happens to be
  // named `aidlc` makes its PARENT look like a workspace, and climbing first would
  // rank that parent and hide every project the user is standing over.
  let launch = launchRoot(options.launchDir, home, platform);
  let launchPass = { scanned: 0, truncated: false };
  if (launch) {
    launchPass = walk(
      [{ path: launch, maxDepth: LAUNCH_MAX_DEPTH }],
      LAUNCH_MAX_DIRECTORIES,
      found,
      platform,
    );
    if (found.size === 0) {
      // No enclosing workspace keeps the launch dir: the main scan may still find
      // something under it deeper than this pass reached.
      const enclosing = enclosingWorkspace(launch, pathKey(home, platform), platform);
      if (enclosing) {
        launch = enclosing;
        found.set(pathKey(enclosing, platform), {
          name: path.basename(enclosing),
          path: enclosing,
        });
      }
    }
  }
  const mainPass = walk(roots, maxDirectories, found, platform);

  // A workspace the main scan found is still "near" when it lies under the launch
  // dir — the pass that found it does not change where it is.
  const launchKey = launch ? pathKey(launch, platform) : undefined;
  const isNear = (p: string): boolean => {
    if (!launchKey) return false;
    const key = pathKey(p, platform);
    return key === launchKey || key.startsWith(launchKey + path.sep);
  };
  const workspaces = [...found.values()].map((w) =>
    isNear(w.path) ? { ...w, nearLaunch: true } : w,
  );

  return {
    // Near first; within the near group the launch dir itself leads, because that
    // is the one the user is standing in.
    workspaces: workspaces.sort(
      (a, b) =>
        Number(Boolean(b.nearLaunch)) - Number(Boolean(a.nearLaunch)) ||
        Number(pathKey(b.path, platform) === launchKey) -
          Number(pathKey(a.path, platform) === launchKey) ||
        a.name.localeCompare(b.name) ||
        a.path.localeCompare(b.path),
    ),
    searchedRoots: [...(launch ? [launch] : []), ...roots.map((root) => path.resolve(root.path))],
    scannedDirectories: launchPass.scanned + mainPass.scanned,
    truncated: launchPass.truncated || mainPass.truncated,
  };
}

/**
 * The launch dir as a search root, or undefined when it adds no ranking: missing,
 * not a directory, or the home dir / an ancestor of it (launching from `~` or `/`).
 */
function launchRoot(
  launchDir: string | undefined,
  home: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (!launchDir?.trim()) return undefined;
  const dir = path.resolve(launchDir);
  if (!directoryExists(dir)) return undefined;
  const dirKey = pathKey(dir, platform);
  const homeKey = pathKey(home, platform);
  const root = path.parse(dirKey).root;
  const prefix = dirKey === root ? dirKey : dirKey + path.sep;
  if (homeKey === dirKey || homeKey.startsWith(prefix)) return undefined;
  return dir;
}

/**
 * The workspace the launch dir sits INSIDE, if any — launching from `~/ws/aidlc/spaces`
 * means `~/ws`. Stops below the home dir, so a stray `~/aidlc` never claims the machine.
 */
function enclosingWorkspace(
  dir: string,
  homeKey: string,
  platform: NodeJS.Platform,
): string | undefined {
  for (let cur = path.dirname(dir); cur !== path.dirname(cur); cur = path.dirname(cur)) {
    if (pathKey(cur, platform) === homeKey) return undefined;
    if (isWorkspaceDir(cur)) return cur;
  }
  return undefined;
}

/** Breadth-first walk over `roots`, adding every workspace it meets to `found`. */
function walk(
  roots: SearchRoot[],
  maxDirectories: number,
  found: Map<string, WorkspaceMatch>,
  platform: NodeJS.Platform,
): { scanned: number; truncated: boolean } {
  const visited = new Set<string>();
  let scannedDirectories = 0;
  let truncated = false;

  for (const root of roots) {
    const queue: { dir: string; depth: number }[] = [{ dir: root.path, depth: 0 }];

    for (let index = 0; index < queue.length; index++) {
      if (scannedDirectories >= maxDirectories) {
        truncated = true;
        break;
      }

      const item = queue[index]!;
      const key = pathKey(item.dir, platform);
      if (visited.has(key)) continue;
      visited.add(key);
      scannedDirectories++;

      if (isWorkspaceDir(item.dir)) {
        found.set(key, { name: path.basename(item.dir), path: path.resolve(item.dir) });
        continue;
      }
      if (item.depth >= root.maxDepth) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(item.dir, { withFileTypes: true });
      } catch {
        continue;
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || shouldSkip(entry.name)) continue;
        queue.push({ dir: path.join(item.dir, entry.name), depth: item.depth + 1 });
      }
    }

    if (truncated) break;
  }

  return { scanned: scannedDirectories, truncated };
}
