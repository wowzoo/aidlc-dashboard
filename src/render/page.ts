// The page shell: CSS, layout, and the poll script.
//
// One self-contained HTML document, no framework and no build step — the whole
// dashboard is a string. Collapsible sections are native <details> and card tabs are
// radio inputs shown by CSS, so the client-side JavaScript is only the refresh poll
// (which restores open sections and picked tabs across the swap), opening a
// drill-down from a card link, and the event-stream filter.
//
// Refresh model: the browser re-fetches the rendered body every `pollMs` and
// swaps it in. Deliberately NOT a file watcher — the inspected tree is usually a
// synced copy, and sync tools write via atomic rename, which kqueue/FSEvents can
// miss. A poll cannot miss anything; the whole read costs ~10ms.

import type { DashboardModel, Locale } from "../model/types";
import { VERSION } from "../version";
import { DRILL, TAB_CSS } from "./card-kit";
import { renderCards, renderDrills, renderSources } from "./cards";
import { esc } from "./common";
import { type Strings, strings } from "./i18n";
import { KPI_CSS, renderKpis } from "./kpi";
import { DEFAULT_LOCALE } from "./locale";
import { renderRunLine } from "./status";
import { warningTextIn } from "./warnings";
import { WS_SLOT, renderWorkspaceMenuShell } from "./workspace-menu";

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #12141a; --card: #1a1d26; --line: #2b3040; --fg: #e6e9f0; --mute: #8b93a7;
  --ok: #4ec98b; --warn: #e5a54b; --bad: #e2685f; --accent: #5b9cf8; --accent2: #7fd1c1;

  /* Type scale. Six steps, floor 11px. Before this there were thirteen sizes
     between 9px and 23px, including 9/9.5/10/10.5/11/11.5 all at once — half-pixel
     steps that cost maintenance without ever reading as hierarchy. 9px also sits
     below any defensible minimum. Body stays 14px; these are the steps around it. */
  --fs-1: 11px;   /* micro: pills, unit tags, legends, table headers */
  --fs-2: 12px;   /* small: notes, stage rows, table cells, diary text */
  --fs-3: 13px;   /* card headings, lead paragraphs, blocker questions */
  --fs-4: 15px;   /* page title, matrix glyphs */
  --fs-5: 19px;   /* stat numbers, phase name */
  --fs-6: 23px;   /* the one hero percentage */

  /* Radius. Three tiers with a stated rule, replacing nine ad-hoc values
     (2/3/4/5/6/7/8/9/10px) where a 3px-vs-4px difference conveyed nothing:
       box  = containers that hold other things
       ctl  = things you click or that label something
       pill = anything whose height is its identity (badges, bars, swatches) */
  --r-box: 8px;
  --r-ctl: 5px;
  --r-pill: 999px;
}
/* Light values are NOT the dark ones brightened — they are picked so every status
   colour clears WCAG AA (4.5:1) against BOTH surfaces, because status is carried by
   10px pills and 10px is normal text, not large. Measured on #fff / #f6f7fa:
   ok 4.83/4.51, warn 4.85/4.53, accent2 4.83/4.51, bad 4.83/4.51, accent 4.88/4.55.
   Darkening only the lightness keeps each hue recognisable as the same signal. */
@media (prefers-color-scheme: light) {
  :root { --bg:#f6f7fa; --card:#fff; --line:#e2e5ec; --fg:#1b1f2a; --mute:#697086;
          --ok:#178252; --warn:#9c6617; --bad:#c8443a; --accent:#2f6fd0; --accent2:#237f71; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; }
code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.92em; }
a { color: var(--accent); }

/* Keyboard focus, stated rather than left to the UA. Nothing here suppressed the
   default ring, so keyboard nav was never broken — but the default ring's contrast
   against #12141a is not something this page controls, and there is a lot to tab
   through: the refresh button, the window toggles, artifact links, and 16 <details>
   summaries. :focus-visible so a mouse click does not leave a ring behind. */
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }

/* The one animation on the page is the refresh spinner, and an infinite loop has to
   collapse under reduced motion. Losing it costs nothing: the spinning state is
   already carried by colour and the disabled/wait cursor, so the button still reads
   as busy without moving. */
@media (prefers-reduced-motion: reduce) {
  button.reload.spin .reload-icon { animation:none; }
}

header.top { position:sticky; top:0; z-index:5; background:var(--bg); border-bottom:1px solid var(--line);
  padding:10px 18px; display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
header.top h1 { font-size:var(--fs-4); margin:0; font-weight:650; }
/* Workspace switcher: the name is the trigger. The list is fetched on first open into
   a slot (render/workspace-menu.ts); the heading and the /pick link are in the markup
   from the start, so the menu still offers a way out with scripts off. */
.ws-menu { position:relative; }
.ws-menu > summary { list-style:none; display:flex; align-items:baseline; gap:6px; cursor:pointer; }
.ws-menu > summary::-webkit-details-marker { display:none; }
.ws-menu > summary:hover h1 { text-decoration:underline; text-underline-offset:3px; }
.ws-caret { color:var(--mute); font-size:var(--fs-2); }
.ws-pop { position:absolute; top:calc(100% + 6px); left:0; z-index:10; min-width:320px;
  max-width:min(560px, 90vw); max-height:60vh; overflow:auto; background:var(--card);
  border:1px solid var(--line); border-radius:var(--r-box); padding:6px;
  box-shadow:0 8px 24px rgba(0,0,0,.25); }
.ws-list { list-style:none; margin:0; padding:0; }
.ws-list li > a, .ws-cur { position:relative; display:flex; flex-direction:column; padding:6px 9px;
  border-radius:var(--r-ctl); text-decoration:none; color:var(--fg); }
.ws-list li > a:hover, .ws-list li > a:focus-visible { background:color-mix(in srgb, var(--accent) 12%, transparent); }
.ws-tag { position:absolute; right:9px; top:7px; font-size:var(--fs-1); color:var(--accent); }
.ws-name { font-weight:600; font-size:var(--fs-2); padding-right:48px; }
.ws-path { color:var(--mute); font-size:var(--fs-1); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ws-note { color:var(--mute); font-size:var(--fs-1); margin:6px 9px; }
.ws-note.err { color:var(--bad); }
.ws-h { margin:4px 9px 2px; color:var(--mute); font-size:var(--fs-1); font-weight:600; }
.ws-browse { display:block; border-bottom:1px solid var(--line); margin-bottom:4px; padding:4px 9px 8px;
  font-size:var(--fs-2); text-decoration:none; }
header.top .path { color:var(--mute); font-size:var(--fs-2); }
header.top nav { margin-left:auto; display:flex; gap:12px; align-items:center; font-size:var(--fs-2); }
header.top nav a { text-decoration:none; }
header.top nav a.pickbtn, header.top nav button.pickbtn {
  border:1px solid var(--line); border-radius:var(--r-ctl); padding:2px 9px; color:var(--fg);
  background:transparent; font:inherit; font-size:var(--fs-2); cursor:pointer; }
header.top nav a.pickbtn:hover, header.top nav button.pickbtn:hover {
  border-color:var(--accent); color:var(--accent); }
button.reload { display:inline-flex; align-items:center; justify-content:center; gap:5px; min-width:92px; }
button.reload .reload-icon { display:inline-block; width:1em; height:1em; line-height:1; transform-origin:50% 50%; }
button.reload.spin { border-color:var(--accent2); color:var(--accent2); cursor:wait; }
button.reload.spin .reload-icon { animation:reload-spin .7s linear infinite; }
button.reload:disabled { opacity:.9; }
@keyframes reload-spin { to { transform:rotate(360deg); } }
#poll-state.err { color:var(--bad); }

main { padding:16px 18px 60px; max-width:1500px; margin:0 auto; display:flex;
  flex-direction:column; gap:14px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:var(--r-box); padding:13px 15px;
  min-width:0; overflow:hidden; }
.card h2 { font-size:var(--fs-3); margin:0 0 10px; font-weight:650; letter-spacing:.01em;
  display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.note { color:var(--mute); font-size:var(--fs-2); margin:7px 0 0; }
/* A caveat is flagged by a rule in the warning colour, not by painting the paragraph:
   whole orange paragraphs read as a second, louder page. Still visible, and still
   the same colour as every other warning signal. */
.note.warn { color:var(--fg); border-left:2px solid var(--warn); padding-left:9px; }
.lead { margin:0 0 10px; font-size:var(--fs-3); }
.mute { color:var(--mute); }
.bad { color:var(--bad); }

.hero-top { display:flex; align-items:baseline; justify-content:space-between; }
.hero-phase { font-size:var(--fs-5); font-weight:650; }
.hero-pct { font-size:var(--fs-6); font-weight:700; font-variant-numeric:tabular-nums; }
.hero-meta { color:var(--mute); font-size:var(--fs-2); margin-top:5px; }
.hero-meta.small { font-size:var(--fs-1); }
.hero-now { margin-top:7px; font-size:var(--fs-3); }
.hero-now .k { color:var(--mute); margin-right:5px; }
.hero-count { color:var(--mute); font-size:var(--fs-2); margin-left:7px; }

.bar { height:7px; background:var(--line); border-radius:var(--r-pill); overflow:hidden; margin:7px 0 2px; }
/* Flat, like every other bar on the page. The gradient ran accent → accent2, and
   accent2 is the colour this page reserves for conversation time and unsettled units,
   so a progress bar was borrowing a signal it does not carry. */
.bar-fill { height:100%; background:var(--accent); }
.bar-overall { height:9px; }

details.phase { border-top:1px solid var(--line); padding:7px 0 3px; }
details.phase:first-of-type { border-top:0; }
details.phase summary { cursor:pointer; display:flex; align-items:center; gap:9px; font-size:var(--fs-3); }
.phase-name { font-weight:600; }
.phase-count { color:var(--mute); }
.phase-declared { margin-left:auto; color:var(--mute); font-size:var(--fs-1); }
ul.stages { list-style:none; margin:5px 0 4px; padding:0 0 0 3px;
  display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:1px 10px; }
ul.stages li { font-size:var(--fs-2); color:var(--mute); display:flex; gap:6px; align-items:baseline; }
.glyph { width:11px; display:inline-block; text-align:center; }
li.s-done { color:var(--ok); } li.s-active { color:var(--accent); font-weight:600; }
li.s-awaiting { color:var(--warn); font-weight:600; } li.s-revising { color:var(--warn); }
li.s-skipped { opacity:.45; text-decoration:line-through; }
.skip { font-size:var(--fs-1); background:color-mix(in srgb, var(--mute) 14%, transparent); border-radius:var(--r-ctl); padding:0 5px; }

/* Expandable stage rows. A stage with files gets a <details>; one without stays
   a plain <li> (.no-art) so an empty toggle never invites a dead click. The
   <details> must fill its grid cell, hence the flex:1 1 100% / min-width:0. */
ul.stages li.stage { align-items:flex-start; }
details.art-box { flex:1 1 100%; min-width:0; }
details.art-box > summary { display:flex; gap:6px; align-items:baseline; cursor:pointer;
  list-style:none; }
details.art-box > summary::-webkit-details-marker { display:none; }
details.art-box > summary::after { content:'▾'; font-size:var(--fs-1); opacity:.5; }
details.art-box[open] > summary::after { content:'▴'; }
li.no-art { padding-right:13px; }        /* keep text aligned with toggled rows */
.art-count { font-size:var(--fs-1); color:var(--mute); background:color-mix(in srgb, var(--mute) 14%, transparent);
  border-radius:var(--r-ctl); padding:0 5px; margin-left:auto; }
ul.arts { list-style:none; margin:3px 0 6px; padding:0 0 0 17px;
  display:flex; flex-direction:column; gap:1px; }
ul.arts li.art { display:block; }
a.art-link { display:flex; gap:5px; align-items:baseline; font-size:var(--fs-2);
  color:var(--fg); text-decoration:none; border-radius:var(--r-ctl); padding:1px 4px; }
a.art-link:hover { background:var(--line); }
.art-mark { width:13px; flex:none; font-size:var(--fs-1); }
.art-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.art-unit { font-size:var(--fs-1); color:var(--mute); background:color-mix(in srgb, var(--mute) 14%, transparent);
  border-radius:var(--r-ctl); padding:0 4px; flex:none; max-width:132px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.art-size { margin-left:auto; font-size:var(--fs-1); color:var(--mute); flex:none; }
li.a-questions a.art-link, li.a-diary a.art-link { color:var(--mute); }
a.art-link.busy { opacity:.5; }
a.art-link.opened { background:var(--ok); color:#fff; }
a.art-link.failed { color:var(--warn); text-decoration:underline wavy; }

.mx-wrap { overflow-x:auto; }
table.mx { border-collapse:collapse; font-size:var(--fs-2); }
table.mx th, table.mx td { padding:3px 5px; text-align:center; }
table.mx tbody th { text-align:left; white-space:nowrap; font-weight:500; }
/* Vertical unit labels are capped at 96px, and real unit names run past it — the
   engine's own example, PU-1-walking-skeleton, needs ~143px. Without an overflow
   rule the cap only bounds the box, so the text either spills or turns the matrix
   into a vertical scroller. Ellipsis instead; the full name stays in the title
   attribute. (No backticks in this comment: the whole stylesheet is a template
   literal, so one would terminate the string.) */
.mx-unit { writing-mode:vertical-rl; transform:rotate(180deg); font-weight:500;
  color:var(--mute); max-height:96px; overflow:hidden; text-overflow:ellipsis;
  font-size:var(--fs-1); cursor:help; }
.mx-cell { font-size:var(--fs-4); line-height:1; cursor:help; }
.c-complete { color:var(--ok); } .c-partial { color:var(--warn); } .c-absent { color:var(--line); }
/* Artifacts met, receipt missing — the engine calls this UNCOVERED, so it must not wear
   the completed colour. --accent2 is its own hue for the same reason 대화 has one. */
.c-unsettled { color:var(--accent2); }
/* "cannot be checked here" is not "not done" — its own mute tone, so it never reads as a
   blocker the way .c-unsettled deliberately does. */
.c-unverified { color:var(--mute); }
.c-na { color:var(--muted); }
.mx-n { color:var(--mute); font-variant-numeric:tabular-nums; padding-left:9px !important; }
tr.mx-skip { opacity:.4; } tr.mx-skip td { font-size:var(--fs-1); color:var(--mute); }
.prov-mark { color:var(--warn); margin-left:3px; cursor:help; }

.dag { display:flex; align-items:center; gap:5px; flex-wrap:wrap; margin-top:9px; }
.batch { border:1px solid var(--line); border-radius:var(--r-ctl); padding:3px 6px; display:flex; gap:4px; align-items:center; }
.batch-label { color:var(--mute); font-size:var(--fs-1); }
.batch-unit { background:var(--line); border-radius:var(--r-pill); padding:1px 5px; font-size:var(--fs-1); }
.batch-arrow { color:var(--mute); }

/* The window total is a HEADLINE, not a tile. It used to sit in a strip of six equal
   tiles beside the five buckets, which read as six comparable numbers and invited an
   addition that does not work — the five sum to the classified span, not to the window.
   Its parts now live in the bar's legend, where the share is. */
/* Still used by the rework strip (재작업 / 반려 / 승인 / 수정 회차 + two optional tiles).
   auto-fit rather than a fixed 5, because at six tiles a fixed count leaves the last
   one orphaned on a row of its own — the same defect the time buckets just shed. */
/* Same tile as the KPI strip (.kpi): its own rounded box, a gap between tiles. It was a
   ruled band split by vertical lines, a third tile shape on one page. */
.time-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(112px,1fr));
  gap:10px; margin-bottom:10px; }
.time-stats > div { min-width:0; padding:8px 12px; border:1px solid var(--line); border-radius:var(--r-box); }
.time-stat-n { display:block; font-size:var(--fs-5); line-height:1.2; font-weight:680;
  font-variant-numeric:tabular-nums; white-space:nowrap; }
.time-stat-l { display:block; color:var(--mute); font-size:var(--fs-1); margin-top:2px; }
.time-stats .unknown .time-stat-n { color:var(--mute); }

.time-head { display:flex; align-items:baseline; gap:9px; flex-wrap:wrap; margin-bottom:9px;
  padding-bottom:9px; border-bottom:1px solid var(--line); }
.time-head-n { font-size:var(--fs-6); line-height:1.1; font-weight:700;
  font-variant-numeric:tabular-nums; white-space:nowrap; }
.time-head-l { font-size:var(--fs-2); color:var(--mute); }
.time-head-sub { margin-left:auto; font-size:var(--fs-1); color:var(--mute); }
.g-n.wait { color:var(--warn); }
.g-n.parked { color:var(--accent); }
/* 대화 gets --accent2, its own hue: it is neither wait (--warn) nor observed execution
   (--ok) nor unexplained (--mute), and borrowing any of those three would make the
   colour claim the attribution the bucket exists to refuse. */
.g-n.conv { color:var(--accent2); }
.g-n.unknown { color:var(--mute); }
.time-breakdown { display:flex; width:100%; height:8px; overflow:hidden; background:var(--line);
  border-radius:var(--r-pill); }
.time-breakdown > span { display:block; min-width:1px; }
.time-breakdown .wait, .time-legend i.wait { background:var(--warn); }
.time-breakdown .parked, .time-legend i.parked { background:var(--accent); }
.time-breakdown .observed, .time-legend i.observed { background:var(--ok); }
.time-breakdown .conv, .time-legend i.conv { background:var(--accent2); }
.time-breakdown .unknown, .time-legend i.unknown { background:var(--mute); }
/* A GRID, not a flex wrap: the legend now carries hours + label + share per entry, and
   flex-wrapping five of those clipped the last one off the card edge. auto-fill lays
   them out 2–3 per row at any card width with nothing cut. */
.time-legend { display:grid; grid-template-columns:repeat(auto-fill,minmax(158px,1fr));
  gap:3px 13px; margin-top:7px; color:var(--mute); font-size:var(--fs-2); }
.time-legend .lgi { display:flex; align-items:baseline; gap:5px; min-width:0; cursor:help; }
.time-legend i { width:7px; height:7px; border-radius:var(--r-pill); flex:none;
  align-self:center; }
.time-legend b { font-weight:660; font-variant-numeric:tabular-nums; white-space:nowrap; }
.time-legend b.wait { color:var(--warn); }
.time-legend b.parked { color:var(--accent); }
.time-legend b.observed { color:var(--ok); }
.time-legend b.conv { color:var(--accent2); }
.time-legend b.unknown { color:var(--fg); }
.time-legend .mute { margin-left:auto; font-size:var(--fs-1); }
.worker-stats { display:flex; flex-wrap:wrap; gap:4px 14px; margin:8px 0 3px; color:var(--mute);
  font-size:var(--fs-1); }
.worker-stats b { color:var(--fg); font-size:var(--fs-2); font-variant-numeric:tabular-nums; }
.timeline-table-wrap { overflow-x:auto; }

.diary-stats { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border-block:1px solid var(--line);
  margin:0 0 13px; }
.diary-stat { min-width:0; padding:8px 10px; border-left:1px solid var(--line); }
.diary-stat:first-child { border-left:0; }
.diary-stat-n { display:block; font-size:var(--fs-5); line-height:1.2; font-weight:680;
  font-variant-numeric:tabular-nums; }
.diary-stat-l { display:block; color:var(--mute); font-size:var(--fs-1); margin-top:2px; }
.diary-stat.ok .diary-stat-n { color:var(--ok); }
.diary-stat.warn .diary-stat-n { color:var(--warn); }
.diary-focus > h3, .diary-group > h3 { margin:0 0 7px; font-size:var(--fs-2); font-weight:650; }
.diary-focus { padding-bottom:12px; }
.diary-columns { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 16px;
  border-top:1px solid var(--line); }
.diary-group { min-width:0; padding-top:11px; }
.diary-group + .diary-group { border-left:1px solid var(--line); padding-left:16px; }
.diary-list { list-style:none; margin:0; padding:0; }
.diary-item { padding:7px 0; border-bottom:1px solid var(--line); min-width:0; }
.diary-item:last-child { border-bottom:0; }
.diary-meta { display:flex; align-items:center; gap:7px; min-width:0; font-size:var(--fs-1); }
.diary-where { color:var(--mute); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.diary-time { color:var(--mute); margin-left:auto; white-space:nowrap; font-variant-numeric:tabular-nums; }
.diary-source { flex:none; font-size:var(--fs-1); text-decoration:none; }
.diary-text { margin-top:4px; font-size:var(--fs-2); line-height:1.45; overflow-wrap:anywhere; }
.diary-more > summary, .diary-resolved > summary, .diary-audit > summary { padding-top:7px; }
.diary-resolved, .diary-audit { border-top:1px solid var(--line); margin-top:11px; padding-top:2px; }
.diary-table-wrap { overflow-x:auto; }
.diary-table { min-width:520px; }
.diary-table .g-name { max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media (max-width:700px) {
  /* The headline's context line drops under the number instead of being pushed right. */
  .time-head-sub { margin-left:0; flex-basis:100%; }
  .diary-stats { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .diary-stat:nth-child(3) { border-left:0; border-top:1px solid var(--line); }
  .diary-stat:nth-child(4) { border-top:1px solid var(--line); }
  /* The ledger rows already stack; only the big number needs to stop reserving width. */
  .dfr-ledger { gap:9px; }
  .diary-columns { grid-template-columns:1fr; }
  .diary-group + .diary-group { border-left:0; border-top:1px solid var(--line); padding-left:0; }
}

/* 미뤄둔 결정. Reuses the four-tile / list / details rhythm the diary card established
   (render/health.ts, now unmounted — its .diary-* rules stay for that reason). Two
   things here are deliberate: a tile's colour encodes urgency and a ZERO tile goes
   mute, so an empty "지난 단계" does not shout in red; and every row carries its own
   route — origin stage → assigned stage — which is how the reader judges direction
   without the panel asserting one. */
/* One ROW per ledger, not a tile strip — see ledgerRows() in render/deferrals.ts for
   why (six equal tiles asserted six comparable numbers; only the first four are one
   measurement, and the sixth wrapped alone and took the divider with it). */
.dfr-ledgers { list-style:none; margin:0 0 9px; padding:0;
  border-block:1px solid var(--line); }
.dfr-ledger { display:flex; gap:13px; align-items:baseline; padding:9px 2px; }
.dfr-ledger + .dfr-ledger { border-top:1px solid var(--line); }
.dfr-ledger-n { flex:0 0 auto; min-width:2ch; text-align:right; font-size:var(--fs-5);
  line-height:1.2; font-weight:680; font-variant-numeric:tabular-nums; }
.dfr-ledger-body { min-width:0; }
.dfr-ledger-h { font-size:var(--fs-2); font-weight:600; }
.dfr-ledger-src { color:var(--mute); font-weight:400; font-size:var(--fs-1); }
.dfr-chips { display:flex; flex-wrap:wrap; gap:5px; margin-top:5px; }
.dfr-chip { font-size:var(--fs-1); color:var(--mute); background:color-mix(in srgb, var(--mute) 12%, transparent);
  border-radius:var(--r-ctl); padding:1px 8px; white-space:nowrap; cursor:help; }
.dfr-chip b { font-variant-numeric:tabular-nums; }
.dfr-ledger-n.t-bad, .dfr-chip.t-bad b { color:var(--bad); }
.dfr-ledger-n.t-warn, .dfr-chip.t-warn b { color:var(--warn); }
.dfr-ledger-n.t-ok, .dfr-chip.t-ok b { color:var(--ok); }
.dfr-ledger-n.t-mute, .dfr-chip.t-mute b, .dfr-chip.t-zero b { color:var(--mute); }
.dfr-chip.t-bad { color:var(--fg); background:color-mix(in srgb, var(--bad) 14%, transparent); }
.dfr-chip.t-warn { color:var(--fg); background:color-mix(in srgb, var(--warn) 14%, transparent); }
.dfr-focus > h3 { margin:11px 0 7px; font-size:var(--fs-2); font-weight:650; }
.dfr-focus:first-of-type > h3 { margin-top:0; }
.dfr-list { list-style:none; margin:0; padding:0; }
.dfr-item { padding:7px 0; border-bottom:1px solid var(--line); min-width:0; }
.dfr-item:last-child { border-bottom:0; }
.dfr-meta { display:flex; align-items:center; gap:7px; min-width:0; font-size:var(--fs-1); flex-wrap:wrap; }
.dfr-route { color:var(--mute); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.dfr-route .dfr-to { color:var(--fg); }
.dfr-fan { color:var(--mute); background:color-mix(in srgb, var(--mute) 14%, transparent); border-radius:var(--r-ctl);
  padding:0 5px; flex:none; }
.dfr-age { color:var(--mute); margin-left:auto; white-space:nowrap; font-variant-numeric:tabular-nums;
  cursor:help; }
.dfr-source { flex:none; font-size:var(--fs-1); text-decoration:none; }
.dfr-text { margin-top:4px; font-size:var(--fs-2); line-height:1.45; overflow-wrap:anywhere; }
.dfr-assign { margin-top:3px; font-size:var(--fs-1); color:var(--mute); overflow-wrap:anywhere; }
.dfr-more > summary, .dfr-ahead > summary, .dfr-rest > summary, .dfr-assum > summary,
.dfr-owners > summary { padding-top:7px; }
.dfr-ahead, .dfr-rest, .dfr-assum, .dfr-owners { border-top:1px solid var(--line); margin-top:11px;
  padding-top:2px; }

/* ONE chip shape across the page: a tint of its own colour, no outline — the same
   vocabulary as the cards' bar-backed rows. The outlined pill and the six other
   bordered badges (.skip, .art-count, .art-unit, .dfr-chip, .dfr-fan, .tag-lead) were a
   second visual language sitting inside the first. */
.pill { font-size:var(--fs-1); font-weight:600; border-radius:var(--r-ctl); padding:1px 7px; border:0;
  background:color-mix(in srgb, currentColor 13%, transparent); white-space:nowrap; }
.pill.has-help { cursor:help; text-decoration:underline dotted; text-underline-offset:2px; }
.pill.ok { color:var(--ok); } .pill.warn { color:var(--warn); }
.pill.bad { color:var(--bad); } .pill.mute { color:var(--mute); }

table.tbl { width:100%; border-collapse:collapse; font-size:var(--fs-2); margin-top:8px; }
table.tbl th, table.tbl td { text-align:left; padding:3px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
table.tbl thead th { color:var(--mute); font-weight:600; font-size:var(--fs-1); white-space:nowrap; }
td.ts, .g-n { font-variant-numeric:tabular-nums; white-space:nowrap; }
.g-n { text-align:right; }
.g-n.idle { color:var(--warn); } .g-n.work { color:var(--ok); }
td.out { max-width:170px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
td.det { color:var(--mute); }
ul.errs { margin:0; padding-left:15px; } ul.errs li { margin:1px 0; }
ul.errs .more { color:var(--mute); list-style:none; }
ul.per-stage { list-style:none; margin:9px 0 0; padding:0; font-size:var(--fs-2); }
ul.per-stage li { padding:2px 0; } .per-stage .st { display:inline-block; min-width:160px; }
details summary { cursor:pointer; font-size:var(--fs-2); color:var(--mute); margin-top:9px; }

.gantt .g-name { white-space:nowrap; font-weight:500; max-width:170px; overflow:hidden; text-overflow:ellipsis; }
.g-track-h { width:44%; }
.g-track { width:44%; padding:4px 6px !important; }
.g-track-line { position:relative; height:11px; min-width:260px; }
/* Bar LENGTH is calendar occupancy; the FILL is that stretch's split, so a long bar
   made of waiting cannot look like a long bar of work. End kind is the outline. */
.g-bar { position:absolute; top:0; height:11px; border-radius:var(--r-pill); background:var(--line);
  min-width:2px; cursor:help; display:flex; overflow:hidden;
  box-shadow:0 0 0 1px var(--mute) inset; }
.g-bar > i { display:block; height:100%; min-width:1px; }
.g-bar > i.wait { background:var(--warn); } .g-bar > i.parked { background:var(--accent); }
.g-bar > i.observed { background:var(--ok); } .g-bar > i.conv { background:var(--accent2); }
.g-bar > i.unknown { background:var(--mute); }
.g-bar.k-done { box-shadow:0 0 0 1px var(--accent2) inset; }
.g-bar.k-skip { box-shadow:0 0 0 1px var(--mute) inset; opacity:.55; }
.g-bar.k-await { box-shadow:0 0 0 1px var(--warn) inset; }
.g-bar.k-live { box-shadow:0 0 0 1px var(--accent) inset; }
/* A superseded attempt is over: dashed outline, dimmed, never the "running" colour. */
.g-bar.k-sup { box-shadow:none; outline:1px dashed var(--mute); outline-offset:-1px; opacity:.6; }
/* Track axis: dates under the header, plus the unrecorded tail as a shaded band. */
.g-axis { position:relative; height:14px; min-width:260px; margin-top:3px; font-weight:400; }
.ax-t { position:absolute; top:0; transform:translateX(-50%); color:var(--mute);
  font-size:var(--fs-1); font-variant-numeric:tabular-nums; white-space:nowrap; }
.ax-t:first-of-type { transform:none; } .ax-t:last-of-type { transform:translateX(-100%); }
.ax-gap { position:absolute; top:0; height:14px; background:repeating-linear-gradient(45deg,
  var(--line) 0 3px, transparent 3px 6px); cursor:help; }
/* A 0-second stage: a tick at its instant, never a bar wide enough to read as time. */
.g-tick { position:absolute; top:-1px; width:2px; height:13px; background:var(--mute); cursor:help; }
.g-tick.k-done { background:var(--accent2); } .g-tick.k-live { background:var(--accent); }
.g-tick.k-await { background:var(--warn); }
.g-n.attn { color:var(--fg); }
.g-where { color:var(--accent); font-size:var(--fs-1); }
i.lg { display:inline-block; width:9px; height:9px; border-radius:2px; vertical-align:-1px; }
i.lg.wait { background:var(--warn); } i.lg.parked { background:var(--accent); }
i.lg.observed { background:var(--ok); } i.lg.conv { background:var(--accent2); }
i.lg.unknown { background:var(--mute); }
.g-load { color:var(--mute); font-size:var(--fs-1); max-width:150px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
/* The human's rejection reason, in full, BELOW the numeric table rather than inside
   it. One measured rejection is 1042 characters with no line breaks: in a cell beside
   five numeric columns it was clamped by .g-load's 150px nowrap (the clip landing on a
   nested <li>, where text-overflow cannot reach) and sliced at 400 characters on top.
   Full card width is what "shown verbatim" actually requires. */
.why-all { margin-top:9px; }
.why-list { list-style:none; margin:6px 0 0; padding:0; display:grid; gap:9px; }
.why-item { border-left:2px solid var(--line); padding-left:11px; }
.why-head { display:flex; gap:9px; align-items:baseline; font-size:var(--fs-1); }
.why-text { margin:3px 0 0; font-size:var(--fs-2); line-height:1.65;
  white-space:pre-wrap; overflow-wrap:anywhere; }
.tag-lead { font-size:var(--fs-1); font-weight:600; color:var(--accent);
  background:color-mix(in srgb, currentColor 13%, transparent);
  border-radius:var(--r-ctl); padding:0 5px; white-space:nowrap; cursor:help; }
.gantt tbody td, .gantt tbody th { line-height:1.35; }
ul.gaps, ul.oq { margin:6px 0 0; padding-left:17px; font-size:var(--fs-2); }
ul.gaps li, ul.oq li { margin:2px 0; }
table.tbl td code { white-space:nowrap; }
.filter-row { display:flex; gap:11px; align-items:center; font-size:var(--fs-2); margin-top:6px; flex-wrap:wrap; }
.filter-row select { background:var(--card); color:var(--fg); border:1px solid var(--line);
  border-radius:var(--r-ctl); padding:2px 5px; font-size:var(--fs-2); max-width:260px; }
.stream code.ev { font-size:var(--fs-1); }
.warnbox { border:1px solid var(--warn); border-radius:var(--r-ctl); padding:8px 11px; margin-bottom:12px;
  font-size:var(--fs-2); color:var(--warn); grid-column:1/-1; }
.warnbox ul { margin:4px 0 0; padding-left:17px; }

/* Run line: the phase/stage the run is on and how long since the audit last wrote. */
.runline { display:flex; align-items:center; gap:9px; flex-wrap:wrap; font-size:var(--fs-3); }
.rl-dot { width:9px; height:9px; border-radius:var(--r-pill); flex:none; }
.rl-dot.run { background:var(--accent); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent); }
.rl-dot.ok { background:var(--ok); }
.rl-dot.mute { border:1px dashed var(--mute); }
.rl-sub { color:var(--mute); font-size:var(--fs-2); }

/* KPI strip: three tiles, the checked one drives the chart below them. The radios are
   hidden the same way the card tabs' are (.mc-r). */
.kpis { display:flex; flex-direction:column; gap:10px; }
.kpi-tiles { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
@media (max-width:700px) { .kpi-tiles { grid-template-columns:1fr; } }
.kpi { display:flex; flex-direction:column; gap:2px; cursor:pointer; padding:10px 14px;
  border:1px solid var(--line); border-radius:var(--r-box); background:transparent; }
.kpi:hover { border-color:var(--mute); }
.kpi.missing { border-style:dashed; }
.kpi-l { color:var(--mute); font-size:var(--fs-2); font-weight:600; }
.kpi-v { font-size:1.6rem; font-weight:700; font-variant-numeric:tabular-nums; line-height:1.2; }
.kpi.missing .kpi-v { color:var(--mute); }
.kpi-s { color:var(--mute); font-size:var(--fs-1); }
/* The same caveat treatment as .note.warn: a rule in the warning colour, not coloured text. */
.kpi-n { color:var(--fg); border-left:2px solid var(--warn); padding-left:6px; margin-top:3px; }
.kpi-c { display:none; background:var(--card); border:1px solid var(--line); border-radius:var(--r-box);
  padding:11px 15px; }
.kpi-c h3 { margin:0 0 6px; font-size:var(--fs-3); }
.kpi-svg { display:block; height:auto; }
.kpi-svg .k-work, .kpi-legend .k-work { fill:var(--accent); background:var(--accent); }
.kpi-svg .k-chat, .kpi-legend .k-chat { fill:var(--accent2); background:var(--accent2); }
.kpi-svg .kpi-silence { fill:var(--mute); opacity:.12; }
.kpi-legend .k-silence { background:var(--mute); opacity:.35; }
.kpi-legend { display:flex; gap:14px; flex-wrap:wrap; margin-top:4px; color:var(--mute); font-size:var(--fs-1); }
.kpi-legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
${KPI_CSS}

/* The 2×2 cards. Two columns down to 900px, then one. */
.cards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; align-items:stretch; }
@media (max-width:900px) { .cards { grid-template-columns:1fr; } }
.card.mc { display:flex; flex-direction:column; padding:13px 15px 11px; }
/* The radios are the tab state, not something to look at: visually hidden, still
   focusable, so Tab reaches the group and the arrow keys move the selection. */
.mc-r { position:absolute; width:1px; height:1px; opacity:0; margin:0; pointer-events:none; }
.mc-head { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
.mc-head h2 { margin:0; font-size:var(--fs-4); }
.mc-tabs { margin-left:auto; display:flex; gap:12px; flex-wrap:wrap; justify-content:flex-end; }
.mc-tabs label { cursor:pointer; font-size:var(--fs-2); color:var(--mute); padding-bottom:2px;
  border-bottom:2px solid transparent; white-space:nowrap; }
.mc-tabs label:hover { color:var(--fg); }
.mc-n { font-weight:700; font-variant-numeric:tabular-nums; }
.mc-n.ok { color:var(--ok); } .mc-n.warn { color:var(--warn); } .mc-n.bad { color:var(--bad); }
.mc-n.mute { color:var(--mute); }
.mc-p { display:none; }
${TAB_CSS}
.mc-more { margin-top:auto; padding-top:9px; font-size:var(--fs-2); text-align:center; text-decoration:none; }
.mc-more:hover { text-decoration:underline; }
/* Bar-backed rows: a faint bar in the row's status colour behind the label, the value
   right-aligned. The bar is tinted, never solid, so the text stays readable on it. */
.mr-h { display:flex; justify-content:space-between; gap:10px; padding:0 8px 4px; color:var(--mute);
  font-size:var(--fs-1); font-weight:600; }
.mr-h .has-tip { cursor:help; text-decoration:underline dotted; text-underline-offset:2px; }
.mr { position:relative; display:flex; justify-content:space-between; align-items:center; gap:10px;
  min-height:30px; padding:4px 8px; margin:2px 0; border-radius:var(--r-ctl); font-size:var(--fs-2); }
.mr-b { position:absolute; left:0; top:0; bottom:0; border-radius:var(--r-ctl); opacity:.2; }
.mr-b.t-ok { background:var(--ok); } .mr-b.t-warn { background:var(--warn); }
.mr-b.t-bad { background:var(--bad); } .mr-b.t-accent { background:var(--accent); }
.mr-b.t-alt { background:var(--accent2); } .mr-b.t-none { background:var(--mute); opacity:.14; }
.mr-l { position:relative; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mr-l > a { color:inherit; text-decoration:none; }
.mr-l > a:hover { text-decoration:underline; }
.mr-sub { color:var(--mute); }
.mr-sub a { text-decoration:none; }
.mr-v { position:relative; flex:none; font-weight:650; font-variant-numeric:tabular-nums; }
/* "No record" is outlined, never tinted green. */
.mr.dashed { border:1px dashed var(--mute); }
.mr.dim { opacity:.55; }
.mr.empty { color:var(--mute); }
.mr-rest, .mr-note { padding:4px 8px 0; color:var(--mute); font-size:var(--fs-1); }

/* Drill-downs: the full panels, one closed <details> each. */
.drills { display:flex; flex-direction:column; gap:8px; }
.drills-h { margin:6px 0 0; font-size:var(--fs-3); font-weight:600; color:var(--mute); }
/* A drill-down is ONE surface. The panels inside were written as cards of their own, so
   mounting them unchanged put a card inside a card and repeated the title the summary
   had just given. Inside a drill they lose their chrome and become sections split by a
   rule; the first one's h2 is the summary's own title, so it is not shown twice. */
details.drill { border:1px solid var(--line); border-radius:var(--r-box); background:var(--card); }
details.drill > summary { list-style:none; display:flex; align-items:center; gap:8px; margin:0;
  padding:12px 15px; font-size:var(--fs-4); font-weight:650; color:var(--fg); }
details.drill > summary::-webkit-details-marker { display:none; }
details.drill > summary::before { content:'▸'; color:var(--mute); font-size:var(--fs-2); width:10px; }
details.drill[open] > summary::before { content:'▾'; }
details.drill[open] > summary { border-bottom:1px solid var(--line); }
.drill-body { display:flex; flex-direction:column; padding:0 15px 13px; }
.drill-body > section.card { border:0; border-radius:0; background:none; padding:13px 0 0; overflow:visible; }
.drill-body > section.card + section.card { border-top:1px solid var(--line); margin-top:13px; }
.drill-body > section.card:first-child > h2:first-child { display:none; }
.drill-body > section.card > h2 { font-size:var(--fs-3); color:var(--mute); }

/* Sources: every input's age on one line; a stale one is outlined and explains itself. */
.sources { display:flex; flex-wrap:wrap; gap:6px 14px; color:var(--mute); font-size:var(--fs-1); }
.src-l { font-weight:600; }
.src.stale { color:var(--warn); border:1px dashed var(--warn); border-radius:var(--r-ctl); padding:0 5px; cursor:help; }
.src.missing { opacity:.75; }

/* Credit view (u3) — first card in the primary column. Uses host tokens only.
   The u3 view emits .card via section(); these style its inner blocks. */
.credit-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
/* Label and value side by side, not stretched to the card's width: at full width the
   value sat 500px from its label. */
.credit-current table.tbl { max-width:520px; margin-top:0; }
.credit-progress { margin-top:10px; }
.credit-progress .note { margin-top:4px; }
.credit-trend { margin-top:12px; }
.credit-chart { margin:8px 0 4px; overflow-x:auto; }
/* Claude token panel — shares the credit card's layout; only the model
   breakdown table is extra. The share cell stacks a bar over its own number so
   the column reads without relying on the bar's length alone. */
.token-models { margin-top:12px; }
.token-models th, .token-models td { white-space:nowrap; }
.token-share { min-width:110px; }
.token-share .note { margin-top:2px; }
/* The window toggle only ever inherited the plain link colour — .pickbtn's chip
   border is scoped to header.top nav, so the three windows rendered as three bare
   blue words and "7일 30일 전체" read as a date ("7월 30일") at a glance. A period
   selector cannot afford that misreading, so each label gets its own outline. The
   selected chip is filled and bolder rather than merely recoloured, so which window
   is active survives a colour-blind read. */
.window-toggle { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.window-toggle a { text-decoration:none; color:var(--fg); font-size:var(--fs-2); line-height:1.4;
  border:1px solid var(--line); border-radius:var(--r-pill); padding:3px 11px; white-space:nowrap; }
.window-toggle a:hover { border-color:var(--accent); color:var(--accent); }
.window-toggle a[aria-checked="true"] { border-color:var(--accent); background:var(--accent);
  color:var(--bg); font-weight:600; }
.window-toggle.lang a { padding:2px 9px; font-size:var(--fs-1); }
footer { color:var(--mute); font-size:var(--fs-1); text-align:center; padding:0 0 26px; }
`;

/** The refresh poll + stream filter. Kept tiny and dependency-free. */
const SCRIPT = (pollMs: number, s: Strings) => {
  // JSON.stringify, not quotes: `Couldn't` would otherwise end the JS literal it lands in.
  const j = (v: string) => JSON.stringify(v);
  return `
(function () {
  var wrap = document.getElementById('body-wrap');
  var btn = document.getElementById('reload-btn');
  var state = document.getElementById('poll-state');

  function bindFilter() {
    var sel = document.getElementById('ev-filter');
    if (!sel) return;
    sel.addEventListener('change', function () {
      var v = sel.value;
      document.querySelectorAll('#ev-table tbody tr').forEach(function (tr) {
        tr.style.display = !v || tr.dataset.ev === v ? '' : 'none';
      });
    });
  }
  bindFilter();

  // Card tabs the reader chose, by radio-group name. Delegated on document because the
  // poll replaces every radio.
  var pickedTabs = {};
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('mc-r')) pickedTabs[t.name] = t.value;
  });

  // Header workspace switcher: fetch the list the first time it opens, into its slot
  // only — the heading and the /pick link stay put, so focus on the link survives. A
  // failed fetch is retried by reopening.
  var ws = document.getElementById('ws-menu');
  var wsLoaded = false;
  if (ws) {
    ws.addEventListener('toggle', function () {
      if (!ws.open || wsLoaded) return;
      wsLoaded = true;
      var slot = document.getElementById(${j(WS_SLOT)});
      fetch('/api/workspaces', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
        .then(function (h) { slot.innerHTML = h; })
        .catch(function () {
          wsLoaded = false;
          slot.innerHTML = '<p class="ws-note err">' + ${j(esc(s.page.wsLoadFailed))} + '</p>';
        });
    });
    document.addEventListener('click', function (e) {
      if (ws.open && !ws.contains(e.target)) ws.open = false;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ws.open) { ws.open = false; ws.querySelector('summary').focus(); }
    });
  }

  // A card's "see all" link targets a closed <details>; an anchor alone would scroll
  // to it without opening it.
  function openDrill(id) {
    var d = document.getElementById(id);
    if (!d || d.tagName !== 'DETAILS') return false;
    d.open = true;
    d.scrollIntoView({ block: 'start' });
    return true;
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[data-drill]');
    if (a && openDrill(a.dataset.drill)) e.preventDefault();
  });
  // The usage panel's window toggle and its refresh redirect both land on \`?cw=\`, and
  // that panel now sits in a closed drill-down — without this, choosing a window would
  // reload onto a page with the panel it just changed folded away.
  if (location.hash) openDrill(location.hash.slice(1));
  else if (/[?&]cw=/.test(location.search)) openDrill(${j(DRILL.usage)});

  // One refresh path for every trigger — the button, the timer and the
  // tab-focus handler all call this, so they can never drift apart.
  var busy = false;
  async function refresh(manual) {
    if (busy) return;
    busy = true;
    if (manual && btn) {
      btn.classList.add('spin');
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      var reloadLabel = btn.querySelector('.reload-label');
      if (reloadLabel) reloadLabel.textContent = ${j(s.page.jsReloading)};
    }
    try {
      // The single manual control refreshes both credit usage and the workspace.
      // A degraded credit subsystem (503) must not block the workspace refresh.
      if (manual) {
        var creditRes = await fetch('/api/refresh', { method: 'POST', cache: 'no-store' });
        if (!creditRes.ok && creditRes.status !== 503) throw new Error(creditRes.status);
      }
      var res = await fetch('/api/body' + window.location.search, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      var html = await res.text();
      // Preserve which <details> the reader had open across the swap.
      var open = new Set();
      document.querySelectorAll('details[data-key]').forEach(function (d) {
        if (d.open) open.add(d.dataset.key);
      });
      var y = window.scrollY;
      wrap.innerHTML = html;
      document.querySelectorAll('details[data-key]').forEach(function (d) {
        if (open.size) d.open = open.has(d.dataset.key);
      });
      // Re-apply the tabs the reader picked. Only picked ones: a card's default tab
      // is chosen by the server (Run Health opens on its first problem), and that
      // choice must be free to move when the run changes.
      Object.keys(pickedTabs).forEach(function (name) {
        var r = document.querySelector('input.mc-r[name="' + name + '"][value="' + pickedTabs[name] + '"]');
        if (r) r.checked = true;
      });
      window.scrollTo(0, y);
      bindFilter();
      if (state) {
        state.textContent = ${j(s.page.jsRefreshedPrefix)} + new Date().toLocaleTimeString();
        state.classList.remove('err');
      }
    } catch (e) {
      // Server down, or a sync replacing files mid-read. Say so rather than
      // leaving a stale page that looks current.
      if (state) {
        state.textContent = ${j(s.page.jsRefreshFailed)};
        state.classList.add('err');
      }
    } finally {
      busy = false;
      if (manual && btn) setTimeout(function () {
        btn.classList.remove('spin');
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        var reloadLabel = btn.querySelector('.reload-label');
        if (reloadLabel) reloadLabel.textContent = ${j(s.page.reloadLabel)};
      }, 300);
    }
  }

  // Manual reload. Needed because a change the poll cannot see coming — a stage
  // flipped between SKIP and EXECUTE, a hand-edited state file — should be
  // observable on demand rather than after waiting out the interval.
  if (btn) {
    btn.addEventListener('click', function (e) { e.preventDefault(); refresh(true); });
  }
  // Artifact links open in the user's editor, so the page must NOT navigate.
  // Delegated on document: the refresh swaps innerHTML, and a listener bound to
  // each link would die with the old nodes (the same reason the poll re-renders
  // rather than patches). Also keeps <details> state out of the click path —
  // the toggle is native, this only intercepts the anchors inside it.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a.art-link');
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains('busy')) return;
    a.classList.add('busy');
    fetch(a.getAttribute('href'), { method: 'GET' })
      .then(function (r) {
        if (r.ok) { a.classList.add('opened'); return; }
        return r.json().catch(function () { return {}; }).then(function (j) {
          a.classList.add('failed');
          a.setAttribute('title', (j && j.error) || ${j(s.page.jsOpenFailedStatus)}.replace('{status}', r.status));
        });
      })
      .catch(function () {
        a.classList.add('failed');
        a.setAttribute('title', ${j(s.page.jsOpenFailedUnreachable)});
      })
      .then(function () {
        a.classList.remove('busy');
        setTimeout(function () { a.classList.remove('opened'); }, 1200);
      });
  });

  // r / F5-like shortcut, ignored while typing in the event filter.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'r' || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target && e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    e.preventDefault();
    refresh(true);
  });
${
  pollMs > 0
    ? `  setInterval(function () {
    if (document.hidden) return;               // don't poll a background tab
    refresh(false);
  }, ${pollMs});

  // Coming back to the tab refreshes at once. Without this the hidden-tab guard
  // above leaves the page up to one full interval stale on return, which reads
  // as "the dashboard did not notice my change".
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh(false);
  });`
    : "  /* auto-poll disabled (--poll 0) — the reload button still works */"
}
})();
`;
};

/**
 * Language chips in the header.
 *
 * Reuses `.window-toggle` deliberately: the content has the same SHAPE as the trend
 * window picker — two or three short mutually-exclusive chips in a radiogroup — which is
 * the test for reaching at an existing class rather than merely sharing a container.
 * `.lang` only tightens the padding for the header's denser row.
 *
 * `?lang=` is a plain link, so this works with JavaScript off, and the server persists
 * the choice in a cookie — every other link on the page therefore needs no `lang` param,
 * unlike `?cw=`.
 */
function langToggle(current: Locale, s: Strings): string {
  const chip = (l: Locale, label: string) =>
    `<a role="radio" aria-checked="${l === current ? "true" : "false"}" href="?lang=${l}">${esc(
      label,
    )}</a>`;
  return `<span class="window-toggle lang" role="radiogroup" aria-label="${esc(
    s.page.langGroupLabel,
  )}">${chip("ko", s.page.langKo)}${chip("en", s.page.langEn)}</span>`;
}

function warnings(m: DashboardModel, s: Strings): string {
  if (m.warnings.length === 0) return "";
  return `<div class="warnbox"><b>${esc(s.page.warningsHeading)}</b><ul>${m.warnings
    .map((w) => `<li>${esc(warningTextIn(w, s))}</li>`)
    .join("")}</ul></div>`;
}

/**
 * The refreshable part of the page: everything inside #body-wrap. Served on its
 * own at /api/body so the poll swaps only this.
 *
 * Top to bottom: the run line (is it moving), the warnings (what this read could not
 * do — degradation stays visible above everything it degrades), the 2×2 cards (the
 * summary), the drill-downs (the full panels, closed), and the sources line (how old
 * each input is).
 *
 * The unanswered asks and the deferral ledger are BOTH reachable because they answer
 * different questions from different files: a blank `[Answer]:` in `*-questions.md`
 * stops the run now (Run Health), while `## Assumptions & Open Questions` records debt
 * a later stage owes (Unresolved). Measured on run C — 0 blockers and 230 open items —
 * so neither count implies the other and neither card can stand in for the other.
 */
export function renderBody(m: DashboardModel, locale: Locale = DEFAULT_LOCALE): string {
  const s = strings(locale);
  // Tag details elements so the poll can restore what the reader had open.
  const keyed = (html: string, prefix: string): string => {
    let i = 0;
    return html.replace(/<details/g, () => `<details data-key="${prefix}-${i++}"`);
  };
  return `${renderRunLine(m, s)}
${warnings(m, s)}
${renderKpis(m, s)}
${renderCards(m, s)}
${keyed(renderDrills(m, s), "x")}
${renderSources(m, s)}`;
}

/**
 * The full document.
 *
 * `locale` threads through every panel via `strings(locale)` and reaches the markup
 * as `<html lang>` — what a screen reader picks a voice from and what a browser's
 * translate prompt reads. `langToggle` puts the switch in the header, naming each
 * language in its own language so a reader who cannot read this page can find the
 * way out.
 */
export function renderPage(
  m: DashboardModel,
  pollMs: number,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const s = strings(locale);
  const title = `AI-DLC · ${m.identity.slug ?? m.identity.record}`;
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <details class="ws-menu" id="ws-menu">
    <summary title="${esc(s.page.wsMenuTip)}"><h1>${esc(
      m.identity.slug ?? m.identity.record,
    )}</h1><span class="ws-caret" aria-hidden="true">▾</span></summary>
    <div class="ws-pop" id="ws-pop">${renderWorkspaceMenuShell(s)}</div>
  </details>
  <span class="path">${esc(m.identity.root)} · space ${esc(m.identity.space)} · harness ${esc(
    m.identity.harnessDir ?? s.page.harnessNotFound,
  )}</span>
  <nav>
    ${langToggle(locale, s)}
    <button id="reload-btn" class="pickbtn reload" type="button"
            title="${esc(s.page.reloadTitle)}">
      <span class="reload-icon" aria-hidden="true">⟳</span><span class="reload-label">${esc(
        s.page.reloadLabel,
      )}</span>
    </button>
    <span id="poll-state" class="mute">${esc(m.generatedAt)}</span>
  </nav>
</header>
<main id="body-wrap">
${renderBody(m, locale)}
</main>
<footer>${esc(s.page.footer)} · v${esc(VERSION)}</footer>
<script>${SCRIPT(pollMs, s)}</script>
</body>
</html>`;
}
