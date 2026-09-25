import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverWorkspaces } from "./workspaces";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-dashboard-workspaces-"));
  tempDirs.push(dir);
  return dir;
}

function createWorkspace(root: string): string {
  fs.mkdirSync(path.join(root, "aidlc"), { recursive: true });
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("discoverWorkspaces", () => {
  test("finds workspaces under common development locations and the home tree", () => {
    const home = tempDir();
    const development = createWorkspace(path.join(home, "Development", "team", "alpha"));
    const homeTree = createWorkspace(path.join(home, "clients", "beta"));

    const result = discoverWorkspaces({ homeDir: home });

    expect(result.workspaces.map((workspace) => workspace.path)).toEqual([development, homeTree]);
    expect(result.truncated).toBe(false);
  });

  test("searches USERPROFILE and OneDrive locations on Windows", () => {
    const root = tempDir();
    const profile = path.join(root, "profile");
    const oneDrive = path.join(root, "OneDrive - Example");
    fs.mkdirSync(profile, { recursive: true });
    const workspace = createWorkspace(path.join(oneDrive, "Documents", "Projects", "gamma"));

    const result = discoverWorkspaces({
      homeDir: profile,
      platform: "win32",
      env: { USERPROFILE: profile, OneDriveCommercial: oneDrive },
    });

    expect(result.workspaces).toEqual([{ name: "gamma", path: workspace }]);
    expect(result.searchedRoots).toContain(oneDrive);
  });

  test("does not descend into hidden, dependency, or symlink directories", () => {
    const home = tempDir();
    const external = createWorkspace(path.join(tempDir(), "external"));
    createWorkspace(path.join(home, ".secret", "hidden"));
    createWorkspace(path.join(home, "__backup", "archived"));
    createWorkspace(path.join(home, "node_modules", "package"));
    fs.symlinkSync(external, path.join(home, "linked"), "dir");

    const result = discoverWorkspaces({ homeDir: home });

    expect(result.workspaces).toEqual([]);
  });

  test("lists workspaces under the launch dir first, and the launch dir itself leading", () => {
    const home = tempDir();
    const alpha = createWorkspace(path.join(home, "Development", "alpha"));
    const launch = path.join(home, "clients");
    const zeta = createWorkspace(path.join(launch, "zeta"));
    const beta = createWorkspace(path.join(launch, "sub", "beta"));

    const result = discoverWorkspaces({ homeDir: home, launchDir: launch });

    // Near group first (sorted by name inside it), the rest after.
    expect(result.workspaces.map((w) => w.path)).toEqual([beta, zeta, alpha]);
    expect(result.workspaces.map((w) => Boolean(w.nearLaunch))).toEqual([true, true, false]);
    expect(result.searchedRoots[0]).toBe(launch);

    // Launched from inside a workspace: that one leads even against an earlier name.
    const inside = discoverWorkspaces({ homeDir: home, launchDir: zeta });
    expect(inside.workspaces.map((w) => w.path)).toEqual([zeta, alpha, beta]);

    // Launched from a subfolder of a workspace: the enclosing workspace is "here".
    fs.mkdirSync(path.join(zeta, "aidlc", "spaces"), { recursive: true });
    const sub = discoverWorkspaces({
      homeDir: home,
      launchDir: path.join(zeta, "aidlc", "spaces"),
    });
    expect(sub.workspaces[0]).toEqual({ name: "zeta", path: zeta, nearLaunch: true });
  });

  test("prefers workspaces below the launch dir over a parent that merely holds an aidlc/ folder", () => {
    // A folder of projects named `aidlc` makes its parent look like a workspace. Launched
    // from inside that folder, the projects are what the user means, not the parent.
    const home = tempDir();
    const projects = path.join(home, "labs", "aidlc");
    const one = createWorkspace(path.join(projects, "one"));
    const two = createWorkspace(path.join(projects, "two"));

    const result = discoverWorkspaces({ homeDir: home, launchDir: projects });

    expect(result.workspaces.slice(0, 2)).toEqual([
      { name: "one", path: one, nearLaunch: true },
      { name: "two", path: two, nearLaunch: true },
    ]);
    expect(result.workspaces.map((w) => w.path)).toEqual([one, two, path.join(home, "labs")]);
    expect(result.workspaces[2]?.nearLaunch).toBeUndefined();
  });

  test("finds a launch-dir workspace deeper than the home scan would reach", () => {
    const home = tempDir();
    const launch = path.join(home, "clients", "acme");
    // Depth 5 from home: past the home scan's depth 3, inside the launch pass's depth 4.
    const deep = createWorkspace(path.join(launch, "a", "b", "run"));

    expect(discoverWorkspaces({ homeDir: home }).workspaces).toEqual([]);
    expect(discoverWorkspaces({ homeDir: home, launchDir: launch }).workspaces).toEqual([
      { name: "run", path: deep, nearLaunch: true },
    ]);
  });

  test("a launch dir inside a common location does not cut that location's deeper scan", () => {
    const home = tempDir();
    const launch = path.join(home, "workspaces");
    // Depth 5 below `workspaces`: beyond the launch pass, inside the common-dir pass.
    const deep = createWorkspace(path.join(launch, "a", "b", "c", "d", "run"));

    const result = discoverWorkspaces({ homeDir: home, launchDir: launch });

    expect(result.workspaces).toEqual([{ name: "run", path: deep, nearLaunch: true }]);
  });

  test("ignores a launch dir that is the home dir, an ancestor of it, or missing", () => {
    const home = tempDir();
    const ws = createWorkspace(path.join(home, "Development", "alpha"));
    const plain = [{ name: "alpha", path: ws }];

    expect(discoverWorkspaces({ homeDir: home, launchDir: home }).workspaces).toEqual(plain);
    expect(discoverWorkspaces({ homeDir: home, launchDir: path.dirname(home) }).workspaces).toEqual(
      plain,
    );
    expect(
      discoverWorkspaces({ homeDir: home, launchDir: path.join(home, "nope") }).workspaces,
    ).toEqual(plain);
  });

  test("reports when the directory ceiling truncates discovery", () => {
    const home = tempDir();
    for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(home, name), { recursive: true });

    const result = discoverWorkspaces({ homeDir: home, maxDirectories: 1 });

    expect(result.scannedDirectories).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
