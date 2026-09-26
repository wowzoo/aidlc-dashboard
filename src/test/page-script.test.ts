// The page's own poll script, run in a DOM (happy-dom), against a stubbed server.
//
// The string tests elsewhere prove the script CONTAINS the restore code; they would
// pass if that code never ran or restored the wrong thing. This runs it: the reader
// picks tabs and opens a drill-down, the server then sends a body whose default tab
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
async function load(body: () => string): Promise<Window> {
  const w = new Window({
    url: "http://127.0.0.1/",
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  win = w;
  const fetches: string[] = [];
  (w as unknown as { fetch: unknown }).fetch = async (url: string) => {
    fetches.push(url);
    return new w.Response(url.startsWith("/api/body") ? body() : "{}", { status: 200 });
  };
  (w as unknown as { fetches: string[] }).fetches = fetches;
  // pollMs 0: no timer — the test drives the one refresh path through the button.
  w.document.write(renderPage(before, 0, "ko"));
  await w.happyDOM.waitUntilComplete();
  return w;
}

const checked = (w: Window, group: string) =>
  (
    w.document.querySelector(`input.mc-r[name="${group}"]:checked`) as unknown as {
      value: string;
    } | null
  )?.value;

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

/** Click reload and wait until the swap has landed. */
async function refresh(w: Window): Promise<void> {
  (w.document.getElementById("reload-btn") as unknown as { click(): void }).click();
  const state = w.document.getElementById("poll-state");
  for (let i = 0; i < 100 && !state?.textContent?.startsWith("갱신"); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("poll swap in a real DOM", () => {
  test("the reader's tab picks and open drill-down survive; the server's defaults move", async () => {
    const w = await load(() => renderBody(after, "ko"));
    expect(checked(w, "mc-health")).toBe("0");
    expect(w.document.getElementById("card-health")?.innerHTML).toContain(
      '<label for="mc-health-0">내 답변 <b class="mc-n warn">1</b></label>',
    );
    const stageDefault = checked(w, "mc-stage");

    pick(w, "mc-unresolved", "1");
    pick(w, "mc-kpi", "2");
    const usage = w.document.getElementById("drill-usage") as unknown as { open: boolean };
    usage.open = true;

    await refresh(w);
    const fetches = (w as unknown as { fetches: string[] }).fetches;
    expect(fetches.some((u) => u.startsWith("/api/body"))).toBe(true);
    // The body really was swapped: Run Health's answers count went from 1 to 0.
    const health = () => w.document.getElementById("card-health")?.innerHTML ?? "";
    expect(health()).toContain('<label for="mc-health-0">내 답변 <b class="mc-n ok">0</b></label>');

    // Restored: what the reader chose.
    expect(checked(w, "mc-unresolved")).toBe("1");
    expect(checked(w, "mc-kpi")).toBe("2");
    expect((w.document.getElementById("drill-usage") as unknown as { open: boolean }).open).toBe(
      true,
    );
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
