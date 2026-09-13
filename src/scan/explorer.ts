// Cross-platform roots and breadcrumbs for the workspace explorer.
//
// Platform differences stop here. The renderer receives one uniform model,
// while tests can inject filesystem probes to exercise Windows on any host.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ExplorerRootKind = "home" | "current" | "filesystem" | "volume" | "drive" | "cloud";

/**
 * A root chip's label, split so the SYNTHESISED part is copy and the read part is data.
 *
 * `홈`/`현재`/`볼륨 …` were built here, which is the display-string-in-the-scan-layer
 * mistake this repo already records (`byOwner`'s `(unassigned)`). A volume's own name and
 * a OneDrive folder's name come off the filesystem, so they stay verbatim under `raw`.
 */
export type ExplorerRootLabel =
  | { key: "home" }
  | { key: "current" }
  | { key: "volume"; name: string }
  | { key: "mount"; name: string }
  | { key: "media"; name: string }
  | { key: "raw"; name: string };

export interface ExplorerRoot {
  label: ExplorerRootLabel;
  path: string;
  kind: ExplorerRootKind;
  active: boolean;
}

export interface ExplorerCrumb {
  label: string;
  path: string;
  current: boolean;
}

export interface ExplorerModel {
  roots: ExplorerRoot[];
  breadcrumbs: ExplorerCrumb[];
}

export interface ExplorerOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  activeRoot?: string;
  directoryExists?: (dir: string) => boolean;
  listDirectories?: (dir: string) => string[];
}

interface RootCandidate {
  label: ExplorerRootLabel;
  path: string;
  kind: ExplorerRootKind;
}

function defaultDirectoryExists(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function defaultListDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  const normalized = pathApi(platform).normalize(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function containsPath(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  const relative = api.relative(parent, child);
  const comparison = platform === "win32" ? relative.toLowerCase() : relative;
  return (
    comparison === "" ||
    (!api.isAbsolute(relative) && !comparison.startsWith(`..${api.sep}`) && comparison !== "..")
  );
}

function addListedDirectories(
  candidates: RootCandidate[],
  parent: string,
  kind: ExplorerRootKind,
  labelKey: "volume" | "mount" | "media",
  exists: (dir: string) => boolean,
  list: (dir: string) => string[],
  api: typeof path.posix | typeof path.win32,
): string[] {
  const found: string[] = [];
  for (const name of list(parent).sort((a, b) => a.localeCompare(b))) {
    const dir = api.join(parent, name);
    if (!exists(dir)) continue;
    candidates.push({ label: { key: labelKey, name }, path: dir, kind });
    found.push(dir);
  }
  return found;
}

function rootCandidates(options: ExplorerOptions): {
  candidates: RootCandidate[];
  platform: NodeJS.Platform;
} {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const api = pathApi(platform);
  const exists = options.directoryExists ?? defaultDirectoryExists;
  const list = options.listDirectories ?? defaultListDirectories;
  const home =
    options.homeDir ??
    (platform === "win32" && env.USERPROFILE ? env.USERPROFILE : undefined) ??
    os.homedir();
  const candidates: RootCandidate[] = [{ label: { key: "home" }, path: home, kind: "home" }];

  if (options.activeRoot) {
    candidates.push({ label: { key: "current" }, path: options.activeRoot, kind: "current" });
  }

  if (platform === "win32") {
    for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      // A drive letter is read from the filesystem, not copy.
      if (exists(drive))
        candidates.push({ label: { key: "raw", name: drive }, path: drive, kind: "drive" });
    }

    for (const value of [
      env.OneDrive,
      env.OneDriveConsumer,
      env.OneDriveCommercial,
      env.ONEDRIVE,
    ]) {
      if (!value?.trim() || !exists(value)) continue;
      candidates.push({
        label: { key: "raw", name: api.basename(api.normalize(value)) || "OneDrive" },
        path: value,
        kind: "cloud",
      });
    }
    for (const name of list(home)) {
      if (!name.toLowerCase().startsWith("onedrive")) continue;
      const oneDrive = api.join(home, name);
      if (exists(oneDrive)) {
        candidates.push({ label: { key: "raw", name }, path: oneDrive, kind: "cloud" });
      }
    }
  } else {
    candidates.push({ label: { key: "raw", name: "/" }, path: "/", kind: "filesystem" });

    if (platform === "darwin") {
      addListedDirectories(candidates, "/Volumes", "volume", "volume", exists, list, api);
    } else if (platform === "linux") {
      addListedDirectories(candidates, "/mnt", "volume", "mount", exists, list, api);
      const mediaRoots = addListedDirectories(
        candidates,
        "/media",
        "volume",
        "media",
        exists,
        list,
        api,
      );
      for (const mediaRoot of mediaRoots) {
        addListedDirectories(candidates, mediaRoot, "volume", "media", exists, list, api);
      }
    }
  }

  return { candidates, platform };
}

/** Return existing, de-duplicated navigation roots with the best active match. */
export function explorerRoots(currentDir: string, options: ExplorerOptions = {}): ExplorerRoot[] {
  const { candidates, platform } = rootCandidates(options);
  const exists = options.directoryExists ?? defaultDirectoryExists;
  const api = pathApi(platform);
  const current = api.resolve(currentDir);
  const seen = new Set<string>();
  const roots = candidates
    .filter((candidate) => {
      const key = pathKey(candidate.path, platform);
      if (seen.has(key) || !exists(candidate.path)) return false;
      seen.add(key);
      return true;
    })
    .map((candidate) => ({ ...candidate, path: api.normalize(candidate.path), active: false }));

  let activeIndex = -1;
  let activeLength = -1;
  for (const [index, root] of roots.entries()) {
    if (!containsPath(root.path, current, platform)) continue;
    if (root.path.length > activeLength) {
      activeIndex = index;
      activeLength = root.path.length;
    }
  }
  if (activeIndex >= 0) roots[activeIndex]!.active = true;
  return roots;
}

/** Split an absolute path into clickable crumbs using the target OS semantics. */
export function explorerBreadcrumbs(
  currentDir: string,
  platform: NodeJS.Platform = process.platform,
): ExplorerCrumb[] {
  const api = pathApi(platform);
  const resolved = api.resolve(currentDir);
  const parsed = api.parse(resolved);
  const tail = resolved.slice(parsed.root.length);
  const parts = tail.split(api.sep).filter(Boolean);
  const crumbs: ExplorerCrumb[] = [
    {
      label: parsed.root || api.sep,
      path: parsed.root || api.sep,
      current: parts.length === 0,
    },
  ];
  let accumulated = parsed.root;

  for (const [index, part] of parts.entries()) {
    accumulated = api.join(accumulated, part);
    crumbs.push({
      label: part,
      path: accumulated,
      current: index === parts.length - 1,
    });
  }
  return crumbs;
}

export function buildExplorer(currentDir: string, options: ExplorerOptions = {}): ExplorerModel {
  const platform = options.platform ?? process.platform;
  return {
    roots: explorerRoots(currentDir, options),
    breadcrumbs: explorerBreadcrumbs(currentDir, platform),
  };
}
