// The header's workspace switcher: the current workspace's name, and under it the
// other workspaces discovery found, each a link to `/select`.
//
// THE LIST IS FETCHED WHEN THE MENU FIRST OPENS, NOT WITH THE PAGE. Discovery walks
// up to 5,000 directories (scan/workspaces.ts) — measured on one machine, 204ms cold
// and 26–34ms warm for 749 directories — and most page loads never open the menu, so
// the page would pay for a list nobody reads. `/api/workspaces` serves this fragment,
// and the poll never touches the header, so an open menu survives a refresh.
//
// The fragment fills a SLOT inside the menu, not the whole menu. The menu's heading
// and its /pick link are in the page from the start: the link is reachable first by
// keyboard (not behind every discovered entry), works with scripts off, and keeps
// focus when the list arrives — replacing the node that held focus would drop it.
//
// The heading says these are WORKSPACES. The trigger shows the run's slug, the list
// names folders, and without the label the current row reads as a different thing
// from the name the reader just clicked.
//
// Switching goes through `/select`, the one route that moves `activeRoot`: it
// validates the path with `resolveWorkspace` and is guarded as state-changing, so a
// link here grants nothing a hand-typed URL could not.

import type { WorkspaceDiscovery } from "../scan/workspaces";
import { esc } from "./common";
import type { Strings } from "./i18n";

/** Id of the element the fetched fragment replaces. */
export const WS_SLOT = "ws-slot";

function item(name: string, dir: string, current: boolean, s: Strings): string {
  const body = `<span class="ws-name">${esc(name)}</span><span class="ws-path">${esc(dir)}</span>`;
  // The current workspace is named, not linked: selecting it again would only reload.
  return current
    ? `<li class="ws-cur" aria-current="true">${body}<span class="ws-tag">${esc(
        s.page.wsCurrent,
      )}</span></li>`
    : `<li><a href="/select?dir=${encodeURIComponent(dir)}">${body}</a></li>`;
}

/** The menu's fixed part, in the page: heading, the /pick link, and the empty slot. */
export function renderWorkspaceMenuShell(s: Strings): string {
  return `<p class="ws-h">${esc(s.page.wsHeading)}</p><a class="ws-browse" href="/pick">${esc(
    s.page.pickFolder,
  )}</a><div id="${WS_SLOT}"><p class="ws-note">${esc(s.page.wsLoading)}</p></div>`;
}

/**
 * The fragment `/api/workspaces` returns into the slot. `d.workspaces` is expected to
 * exclude the active one already — the route compares by identity (`workspaceKey`),
 * which a string match here could not. The current workspace leads even when
 * discovery did not reach it: it can live outside every searched root, and a menu
 * that omitted it would read as "you are nowhere".
 */
export function renderWorkspaceMenu(
  d: WorkspaceDiscovery,
  active: { path: string; name: string } | undefined,
  s: Strings,
): string {
  const rows: string[] = [];
  if (active) rows.push(item(active.name, active.path, true, s));
  for (const w of d.workspaces) rows.push(item(w.name, w.path, false, s));
  // "None found" under a row naming the current one would contradict it — what is
  // missing then is OTHER workspaces.
  const none =
    d.workspaces.length === 0
      ? `<p class="ws-note">${esc(active ? s.page.wsNoOthers : s.picker.noWorkspacesFound)}</p>`
      : "";
  const truncated = d.truncated ? `<p class="ws-note">${esc(s.page.wsTruncated)}</p>` : "";
  return `<ul class="ws-list">${rows.join("")}</ul>${none}${truncated}`;
}
