// The page's own poll script, run in a DOM (happy-dom), against a stubbed server.
//
// The string tests elsewhere prove the script CONTAINS the restore code; they would
// pass if that code never ran or restored the wrong thing. This runs it: the reader
// picks tabs and opens a tile's panel, the server then sends a body whose default tab
// has moved, and the swap must keep exactly what the READER chose — and nothing the
// server chose, because a server-picked default (Run Health opens on its first
// problem) has to be free to move when the run changes.
//
// JavaScript evaluation is enabled for this window only, and only ever runs markup
// this repository renders itself.

import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Window } from "happy-dom";
import { assemble } from "../model/assemble";
import type { DashboardModel } from "../model/types";
import { renderBody, renderPage } from "../render/page";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
const before = assemble(FIXTURE);
// No asks and no block → Run Health's first problem, and so its default tab, moves
// from "answers" (0) to "failed checks" (2). The same variant status.test.ts uses.
const after: DashboardModel = {
  ...before,
  blockers: [],
  health: { ...before.health, stopGuard: { signature: "code-generation::40", count: 0 } },
};

let win: Window | undefined;
afterEach(async () => {
  await win?.happyDOM.close();
  win = undefined;
});

/** Load the page with its script running and `fetch` answered by `body`. */
async function load(
  body: () => string,
  bodyStatus = 200,
  url = "http://127.0.0.1/",
): Promise<Window> {
  const w = new Window({
    url,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  win = w;
  const fetches: string[] = [];
  (w as unknown as { fetch: unknown }).fetch = async (url: string) => {
    fetches.push(url);
    return url.startsWith("/api/body")
      ? new w.Response(body(), { status: bodyStatus })
      : new w.Response("{}", { status: 200 });
  };
  (w as unknown as { fetches: string[] }).fetches = fetches;
  // pollMs 0: no timer — the test drives the one refresh path through the button.
  w.document.write(renderPage(before, 0, "ko"));
  await w.happyDOM.waitUntilComplete();
  return w;
}

/**
 * The checked radio's value, read from the PROPERTY. happy-dom's `:checked` can still
 * match a radio whose `checked` attribute the server rendered after a script moved the
 * pick, so a selector would report the server's default instead of the reader's.
 */
const checked = (w: Window, group: string) =>
  (
    [...w.document.querySelectorAll(`input.mc-r[name="${group}"]`)] as unknown as {
      checked: boolean;
      value: string;
    }[]
  ).find((r) => r.checked)?.value;

function pick(w: Window, group: string, value: string): void {
  const r = w.document.querySelector(
    `input.mc-r[name="${group}"][value="${value}"]`,
  ) as unknown as {
    checked: boolean;
    dispatchEvent(e: unknown): void;
  };
  r.checked = true;
  r.dispatchEvent(new w.Event("change", { bubbles: true }));
}

/** The one <details> holding the KPI tiles' full panels. */
const more = (w: Window) => w.document.getElementById("kpi-more") as unknown as { open: boolean };

/** Click an element the way a reader does. */
const click = (w: Window, selector: string) =>
  (w.document.querySelector(selector) as unknown as { click(): void }).click();

/** Click reload and wait until the swap has landed. */
async function refresh(w: Window): Promise<void> {
  (w.document.getElementById("reload-btn") as unknown as { click(): void }).click();
  const state = w.document.getElementById("poll-state");
  for (let i = 0; i < 100 && !state?.textContent?.startsWith("갱신"); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("poll swap in a real DOM", () => {
  test("the reader's tab picks and open tile panel survive; the server's defaults move", async () => {
    const w = await load(() => renderBody(after, "ko"));
    expect(checked(w, "mc-health")).toBe("0");
    expect(w.document.getElementById("card-health")?.innerHTML).toContain(
      '<label for="mc-health-0">내 답변 <b class="mc-n warn">1</b></label>',
    );
    const stageDefault = checked(w, "mc-stage");

    pick(w, "mc-unresolved", "1");
    pick(w, "mc-kpi", "2");
    more(w).open = true;

    await refresh(w);
    const fetches = (w as unknown as { fetches: string[] }).fetches;
    expect(fetches.some((u) => u.startsWith("/api/body"))).toBe(true);
    // The body really was swapped: Run Health's answers count went from 1 to 0.
    const health = () => w.document.getElementById("card-health")?.innerHTML ?? "";
    expect(health()).toContain('<label for="mc-health-0">내 답변 <b class="mc-n ok">0</b></label>');

    // Restored: what the reader chose.
    expect(checked(w, "mc-unresolved")).toBe("1");
    expect(checked(w, "mc-kpi")).toBe("2");
    expect(more(w).open).toBe(true);
    // Not restored: what the server chose. Run Health follows the run.
    expect(checked(w, "mc-health")).toBe("2");
    expect(checked(w, "mc-stage")).toBe(stageDefault);
  });

  test("with nothing picked, every group takes the new body's defaults", async () => {
    const w = await load(() => renderBody(after, "ko"));
    await refresh(w);
    expect(checked(w, "mc-health")).toBe("2");
    expect(checked(w, "mc-unresolved")).toBe("0");
    expect(checked(w, "mc-kpi")).toBe("0");
  });
});

describe("a KPI tile opens its full panel", () => {
  test("the chosen tile folds and unfolds; another tile is picked and unfolds", async () => {
    const w = await load(() => renderBody(before, "ko"));
    // Closed on load, on the progress tile.
    expect(more(w).open).toBe(false);
    expect(checked(w, "mc-kpi")).toBe("0");
    click(w, 'label[for="mc-kpi-0"]');
    expect(more(w).open).toBe(true);
    expect(checked(w, "mc-kpi")).toBe("0");
    click(w, 'label[for="mc-kpi-0"]');
    expect(more(w).open).toBe(false);
    // Closed, another tile: picked AND unfolded in one click.
    click(w, 'label[for="mc-kpi-2"]');
    expect(checked(w, "mc-kpi")).toBe("2");
    expect(more(w).open).toBe(true);
    // Open, another tile: the panel switches and stays open.
    click(w, 'label[for="mc-kpi-1"]');
    expect(checked(w, "mc-kpi")).toBe("1");
    expect(more(w).open).toBe(true);
  });

  test("only the chosen tile's panel is shown — the cascade, not just the markup", async () => {
    // .drill-body (the panels' inner layout) sets display AFTER the hide rule; at equal
    // specificity it won and all three panels showed at once in a real browser.
    const w = await load(() => renderBody(before, "ko"));
    const shown = () =>
      ["drill-overview", "drill-usage", "drill-timeline"].map(
        (id) => w.getComputedStyle(w.document.getElementById(id) as never).display !== "none",
      );
    expect(shown()).toEqual([true, false, false]);
    click(w, 'label[for="mc-kpi-2"]');
    expect(shown()).toEqual([false, false, true]);
  });

  test("a card link picks the tile its target is under and unfolds it", async () => {
    const w = await load(() => renderBody(before, "ko"));
    // The Unit card's matrix link: inside the progress panel.
    click(w, "#card-unit a.mc-more");
    expect(checked(w, "mc-kpi")).toBe("0");
    expect(more(w).open).toBe(true);
    // Run Health's link: the timing panel, under the time tile.
    more(w).open = false;
    click(w, "#card-health a.mc-more");
    expect(checked(w, "mc-kpi")).toBe("2");
    expect(more(w).open).toBe(true);
    // A link pick is a reader's pick: the poll keeps it.
    await refresh(w);
    expect(checked(w, "mc-kpi")).toBe("2");
    expect(more(w).open).toBe(true);
    // And after the swap the chosen tile still folds on the FIRST click: the pick lives
    // in the script, which the swap does not replace, and the poll restores the same radio.
    click(w, 'label[for="mc-kpi-2"]');
    expect(more(w).open).toBe(false);
  });

  test("a usage window reload (?cw=) lands on the usage panel, unfolded", async () => {
    const w = await load(() => renderBody(before, "ko"), 200, "http://127.0.0.1/?cw=30d");
    expect(checked(w, "mc-kpi")).toBe("1");
    expect(more(w).open).toBe(true);
  });
});

describe("a body that is gone reloads the page", () => {
  /** Click reload and wait until the refresh settled one way or the other. */
  async function settle(w: Window, reloaded: () => boolean): Promise<void> {
    (w.document.getElementById("reload-btn") as unknown as { click(): void }).click();
    const state = w.document.getElementById("poll-state");
    for (let i = 0; i < 100 && !reloaded() && !state?.classList.contains("err"); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  test("404 — the run is gone (e.g. its last intent archived): reload for the server's own page", async () => {
    const w = await load(() => "<p>not found</p>", 404);
    let reloads = 0;
    Object.defineProperty(w.location, "reload", { value: () => reloads++, configurable: true });
    await settle(w, () => reloads > 0);
    expect(reloads).toBe(1);
  });

  test("500 — still a failed refresh, not a reload", async () => {
    const w = await load(() => "boom", 500);
    let reloads = 0;
    Object.defineProperty(w.location, "reload", { value: () => reloads++, configurable: true });
    await settle(w, () => reloads > 0);
    expect(reloads).toBe(0);
    expect(w.document.getElementById("poll-state")?.classList.contains("err")).toBe(true);
  });
});
