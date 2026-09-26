// The header workspace switcher (render/workspace-menu.ts) and `/api/workspaces`.
//
// Discovery is always SYNTHETIC here. The real one walks the home directory, and a
// test that ran it would put this machine's directory names into test output —
// measured: the first cut of this file printed them on failure. The route test
// injects its result through `handle`'s `deps.discover`.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "../cli";
import { assemble } from "../model/assemble";
import { strings } from "../render/i18n";
import { renderPage } from "../render/page";
import { WS_SLOT, renderWorkspaceMenu, renderWorkspaceMenuShell } from "../render/workspace-menu";
import { workspaceKey } from "../scan/browse";
import type { WorkspaceDiscovery } from "../scan/workspaces";
import { handle } from "../server";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const ko = strings("ko");
const en = strings("en");

const found = (paths: string[], truncated = false): WorkspaceDiscovery => ({
  workspaces: paths.map((p) => ({ name: path.basename(p), path: p })),
  searchedRoots: ["/home/u"],
  scannedDirectories: 10,
  truncated,
});

describe("workspace menu fragment", () => {
  test("the current workspace leads, named but not linked; the others link to /select", () => {
    const html = renderWorkspaceMenu(found(["/w/a", "/w/c"]), { path: "/w/b", name: "b" }, ko);
    const items = html.match(/<li[^>]*>.*?<\/li>/g) ?? [];
    expect(items.length).toBe(3);
    expect(items[0]).toContain('aria-current="true"');
    expect(items[0]).toContain(ko.page.wsCurrent);
    expect(items[0]).not.toContain("<a ");
    expect(items[1]).toContain(`href="/select?dir=${encodeURIComponent("/w/a")}"`);
    expect(items[2]).toContain(`href="/select?dir=${encodeURIComponent("/w/c")}"`);
  });

  test("only the current workspace found: 'no OTHER workspaces', never 'none found'", () => {
    const html = renderWorkspaceMenu(found([]), { path: "/w/a", name: "a" }, ko);
    expect(html).toContain(ko.page.wsNoOthers);
    expect(html).not.toContain(ko.picker.noWorkspacesFound);
    // With no current workspace at all, plain "none found" is the true statement.
    expect(renderWorkspaceMenu(found([]), undefined, ko)).toContain(ko.picker.noWorkspacesFound);
  });

  test("a truncated search says so", () => {
    const cut = renderWorkspaceMenu(found(["/w/b"], true), { path: "/w/a", name: "a" }, ko);
    expect(cut).toContain(ko.page.wsTruncated);
  });

  test("names and paths from the disk are escaped", () => {
    const html = renderWorkspaceMenu(found(['/w/<img src=x onerror="1">']), undefined, ko);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;1&quot;&gt;");
  });

  test("English renders with no Hangul", () => {
    const html =
      renderWorkspaceMenuShell(en) +
      renderWorkspaceMenu(found(["/w/b"], true), { path: "/w/a", name: "a" }, en) +
      renderWorkspaceMenu(found([]), { path: "/w/a", name: "a" }, en);
    expect(/[가-힣]/.test(html)).toBe(false);
  });
});

describe("workspace menu on the page", () => {
  const m = assemble(FIXTURE);
  const header = () => {
    const html = renderPage(m, 60000, "ko");
    return html.slice(html.indexOf('<header class="top">'), html.indexOf("</header>"));
  };

  test("the header name opens a menu labelled as workspaces", () => {
    const h = header();
    expect(h).toContain('<details class="ws-menu" id="ws-menu">');
    expect(h).toContain(`<h1>${m.identity.slug ?? m.identity.record}</h1>`);
    expect(h).toContain(`<p class="ws-h">${ko.page.wsHeading}</p>`);
  });

  test("the /pick link comes BEFORE the slot, so the list never pushes it back or takes its node", () => {
    const h = header();
    const link = h.indexOf('<a class="ws-browse" href="/pick">');
    const slot = h.indexOf(`<div id="${WS_SLOT}">`);
    expect(link).toBeGreaterThan(0);
    expect(slot).toBeGreaterThan(link);
    // The list is fetched on open, not rendered into the page.
    expect(h).not.toContain("ws-list");
  });

  test("the script fills the slot, not the whole menu", () => {
    const html = renderPage(m, 60000, "ko");
    expect(html).toContain("fetch('/api/workspaces'");
    expect(html).toContain(`getElementById("${WS_SLOT}")`);
    expect(html).not.toContain("pop.innerHTML");
  });
});

describe("/api/workspaces", () => {
  const OPTS = parseArgs(["--root", FIXTURE]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-menu-"));
  const alias = path.join(tmp, "alias");
  fs.symlinkSync(FIXTURE, alias);
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const get = (p: string, discovered: string[]) =>
    handle(new Request(`http://127.0.0.1${p}`), OPTS, {}, { discover: () => found(discovered) });

  test("serves the fragment uncached, from the injected discovery", async () => {
    const res = await get("/api/workspaces", ["/w/one", "/w/two"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain(`href="/select?dir=${encodeURIComponent("/w/one")}"`);
    expect(body).toContain(`href="/select?dir=${encodeURIComponent("/w/two")}"`);
  });

  test("the active workspace reached through a symlink is listed once, as current", async () => {
    await get(`/select?dir=${encodeURIComponent(FIXTURE)}`, []);
    const body = await (await get("/api/workspaces", [alias, "/w/other"])).text();
    expect(body.split('aria-current="true"').length - 1).toBe(1);
    expect(body).not.toContain(`/select?dir=${encodeURIComponent(alias)}`);
    expect(body).toContain(`/select?dir=${encodeURIComponent("/w/other")}`);
    // Named after the discovered entry, which is what the picker would call it.
    expect(body).toContain('<span class="ws-name">alias</span>');
  });

  test("is refused on a non-loopback Host like every route", async () => {
    const res = await handle(
      new Request("http://evil.example.com/api/workspaces"),
      OPTS,
      {},
      { discover: () => found(["/w/x"]) },
    );
    expect(res.status).toBe(403);
  });
});

describe("workspaceKey", () => {
  test("a symlink and its target are the same workspace", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-key-"));
    const link = path.join(tmp, "l");
    fs.symlinkSync(FIXTURE, link);
    try {
      expect(workspaceKey(link)).toBe(workspaceKey(FIXTURE));
      expect(workspaceKey(`${FIXTURE}/`)).toBe(workspaceKey(FIXTURE));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("case is folded on Windows only, and a missing path still keys", () => {
    expect(workspaceKey("/No/Such/Dir", "win32")).toBe(path.resolve("/No/Such/Dir").toLowerCase());
    expect(workspaceKey("/No/Such/Dir", "darwin")).toBe(path.resolve("/No/Such/Dir"));
  });
});
