// The two building blocks every card in the 2×2 grid is made of: a tabbed card
// shell and a list of bar-backed rows (the Plausible "top sources" shape — a faint
// bar behind the label, the number right-aligned).
//
// TABS ARE RADIO INPUTS, NOT SCRIPT. The page has no framework and the body is
// swapped wholesale on every poll, so a tab whose state lived in a JS variable would
// snap back each minute. A radio's `checked` is plain DOM state: page.ts saves it by
// group name before the swap and restores it after, exactly as it does for
// <details open>. The panels are shown by CSS alone, which also means the tabs work
// with JavaScript off and are keyboard-operable by construction (arrow keys move
// within a radio group).
//
// The CSS that pairs the n-th radio with the n-th label and panel is generated for
// MAX_TABS positions (see TAB_CSS). A card asking for more is a programming error,
// so it is clamped rather than rendered with panels no rule can show.

import { esc } from "./common";

/**
 * In-page ids the cards' "see all" links target. The first three are the KPI tiles'
 * full panels (render/kpi.ts), `matrix` is the unit matrix inside the overview panel,
 * and `deferrals` is the deferrals box, unmounted while SHOW_DEFERRALS is off
 * (render/cards.ts).
 */
export const DRILL = {
  overview: "drill-overview",
  timeline: "drill-timeline",
  usage: "drill-usage",
  matrix: "matrix",
  deferrals: "deferrals",
} as const;

/** Upper bound on tabs per card; TAB_CSS is generated for this many positions. Five
 *  because the engine has five phase directories and the Stage card tabs by phase. */
export const MAX_TABS = 5;

export type CountTone = "ok" | "warn" | "bad" | "mute";

export interface Tab {
  label: string;
  /** Optional count shown after the label, e.g. the number of open items. */
  count?: { text: string; tone?: CountTone };
  /** Panel body, already-rendered HTML. */
  body: string;
}

export interface CardOptions {
  /** Stable id: names the radio group, so a restored selection survives the poll. */
  id: string;
  /** Card title. Rendered as the card's h2. */
  title: string;
  tabs: Tab[];
  /** Index of the tab selected on first render; clamped into range. */
  selected?: number;
  /** In-page link under the panels ("see the full view"). */
  more?: { href: string; label: string };
}

export function tabbedCard(o: CardOptions): string {
  const tabs = o.tabs.slice(0, MAX_TABS);
  const sel = Math.min(Math.max(o.selected ?? 0, 0), Math.max(tabs.length - 1, 0));
  const group = `mc-${o.id}`;
  const radios = tabs
    .map(
      (_, i) =>
        `<input class="mc-r" type="radio" name="${esc(group)}" id="${esc(group)}-${i}" value="${i}"${
          i === sel ? " checked" : ""
        }>`,
    )
    .join("");
  const labels = tabs
    .map((t, i) => {
      const count = t.count
        ? ` <b class="mc-n ${t.count.tone ?? "mute"}">${esc(t.count.text)}</b>`
        : "";
      return `<label for="${esc(group)}-${i}">${esc(t.label)}${count}</label>`;
    })
    .join("");
  const panels = tabs.map((t) => `<div class="mc-p">${t.body}</div>`).join("");
  const more = o.more
    ? `<a class="mc-more" href="${esc(o.more.href)}" data-drill="${esc(
        o.more.href.replace(/^#/, ""),
      )}">${esc(o.more.label)} →</a>`
    : "";
  return `<section class="card mc" id="card-${esc(o.id)}">
${radios}<div class="mc-head"><h2>${esc(o.title)}</h2><div class="mc-tabs">${labels}</div></div>
<div class="mc-panels">${panels}</div>${more}
</section>`;
}

/**
 * Row tones map onto the page's existing status palette. `alt` is --accent2, the
 * colour the page already reserves for "neither done nor waiting" (conversation
 * time, a unit with artifacts but no receipt).
 */
export type RowTone = "ok" | "warn" | "bad" | "accent" | "alt" | "none";

export interface Row {
  /** Label HTML — callers escape their own text and may embed a link. */
  label: string;
  /** Right-aligned value, plain text. */
  value: string;
  /** Bar length 0–100. Omitted = no bar. */
  pct?: number;
  tone?: RowTone;
  tip?: string;
  /** Dashed outline: "no record", which must never read as a healthy row. */
  dashed?: boolean;
  /** Dimmed: skipped / not applicable. */
  dim?: boolean;
}

function row(r: Row): string {
  const cls = ["mr", r.dashed ? "dashed" : "", r.dim ? "dim" : ""].filter(Boolean).join(" ");
  const barW = r.pct === undefined ? 0 : Math.max(0, Math.min(100, r.pct));
  const bar =
    r.pct === undefined
      ? ""
      : `<span class="mr-b t-${r.tone ?? "accent"}" style="width:${barW.toFixed(1)}%"></span>`;
  const tip = r.tip ? ` title="${esc(r.tip)}"` : "";
  return `<div class="${cls}"${tip}>${bar}<span class="mr-l">${r.label}</span><span class="mr-v">${esc(
    r.value,
  )}</span></div>`;
}

export interface RowListOptions {
  /** Column headers, left and right. */
  head?: [string, string];
  /** Hover text on the right-hand header, when the value needs its definition stated. */
  headTip?: string;
  /** Rows beyond this are folded into a "+N more" line. */
  max?: number;
  /** "+N more" text for the folded remainder. */
  moreText?: (n: number) => string;
  /** Shown when `rows` is empty. */
  empty?: string;
  /** Small line under the rows — where the numbers came from. */
  note?: string;
}

export function rowList(rows: Row[], o: RowListOptions = {}): string {
  const head = o.head
    ? `<div class="mr-h"><span>${esc(o.head[0])}</span><span${
        o.headTip ? ` class="has-tip" title="${esc(o.headTip)}"` : ""
      }>${esc(o.head[1])}</span></div>`
    : "";
  const max = o.max ?? rows.length;
  const shown = rows.slice(0, max);
  const rest = rows.length - shown.length;
  const body =
    shown.length > 0
      ? shown.map(row).join("")
      : `<div class="mr empty"><span class="mr-l">${esc(o.empty ?? "—")}</span></div>`;
  const more = rest > 0 && o.moreText ? `<div class="mr-rest">${esc(o.moreText(rest))}</div>` : "";
  const note = o.note ? `<div class="mr-note">${esc(o.note)}</div>` : "";
  return `${head}${body}${more}${note}`;
}

/** Bar length of `v` against the largest value in a list, as a percentage. */
export function share(v: number, max: number): number {
  return max > 0 ? (v / max) * 100 : 0;
}

/** A link that opens a record file in the dashboard's source viewer. */
export function viewLink(rel: string, text: string, tip?: string): string {
  return `<a href="/view?rel=${encodeURIComponent(rel)}"${tip ? ` title="${esc(tip)}"` : ""}>${esc(
    text,
  )}</a>`;
}

/**
 * CSS that shows the selected panel and marks the selected label, one rule set per
 * tab position. Generated so the pairing cannot drift from MAX_TABS.
 */
export const TAB_CSS = Array.from({ length: MAX_TABS }, (_, k) => {
  const n = k + 1;
  return `.mc-r:nth-of-type(${n}):checked ~ .mc-panels > .mc-p:nth-child(${n}) { display:block; }
.mc-r:nth-of-type(${n}):checked ~ .mc-head .mc-tabs label:nth-of-type(${n}) { color:var(--fg); font-weight:600; border-bottom-color:var(--accent); }
.mc-r:nth-of-type(${n}):focus-visible ~ .mc-head .mc-tabs label:nth-of-type(${n}) { outline:2px solid var(--accent); outline-offset:2px; }`;
}).join("\n");
