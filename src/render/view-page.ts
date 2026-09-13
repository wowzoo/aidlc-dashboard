// The `/view` page: one record artifact's source text, escaped.
//
// WHY `<pre>` AND NOT RENDERED MARKDOWN. What this page is for is letting the reader
// see the thing a panel just named — the blank `[Answer]:` under a question heading,
// the `**Feedback**` a human wrote at a rejected gate. That is served by the source,
// and a markdown renderer would mean standing up an HTML generator over text this
// repo treats as hostile input, to buy typography. So the text goes through `esc()`
// into a `<pre>` and nothing else.
//
// THAT IS ALSO WHY `.html` IS NOT REFUSED. An artifact `.html` (the visual-mockups
// stages write them) is escaped here like every other artifact, so its `<script>` is
// text on the page, not script in our origin. Refusing it — the first design — was
// answering a threat the escaping had already removed, while dropping a real
// deliverable the artifact list and `/open` both already carry. The response still
// ships `default-src 'none'` and `nosniff` (see server.ts) as defence in depth: if an
// escaping bug ever slipped through, there is no origin left for it to act in.

import type { Locale } from "../model/types";
import type { ViewResult } from "../scan/view-file";
import { esc } from "./common";
import { type Strings, strings } from "./i18n";
import { DEFAULT_LOCALE } from "./locale";
import { refusalText } from "./warnings";

const VIEW_STYLE = `
:root {
  color-scheme:light dark;
  --bg:#101215; --panel:#181b1f; --line:#343a42; --fg:#f0f1ec;
  --mute:#979d9f; --warn:#e6ad55; --accent:#68a8ef;
}
@media (prefers-color-scheme:light) {
  :root {
    --bg:#f3f4f1; --panel:#fff; --line:#d7dad5; --fg:#191c1c;
    --mute:#687071; --warn:#946016; --accent:#2868ad;
  }
}
* { box-sizing:border-box; }
body {
  margin:0; background:var(--bg); color:var(--fg);
  font:14px/1.6 "Avenir Next","Segoe UI",sans-serif;
}
.shell { max-width:1000px; margin:0 auto; padding:28px 22px 64px; }
.crumbs { margin:0 0 14px; }
.crumbs a { color:var(--accent); font-size:12px; text-decoration:none; }
.crumbs a:hover { text-decoration:underline; }
h1 {
  margin:0 0 6px; font-size:15px; font-weight:650; overflow-wrap:anywhere;
  font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace;
}
.meta { margin:0 0 18px; color:var(--mute); font-size:12px; }
.meta a { color:var(--accent); }
.note { margin:0 0 16px; padding:9px 12px; border-left:3px solid var(--warn); color:var(--warn); }
/* The artifact's own text. pre-wrap because a questions file holds long prose lines and
   a horizontal scrollbar would hide the end of exactly the sentence being read — the
   same reason the rework panel's verbatim reasons are not in a table cell. */
pre {
  margin:0; padding:16px 18px; border:1px solid var(--line); border-radius:7px;
  background:var(--panel); white-space:pre-wrap; overflow-wrap:anywhere;
  font:12.5px/1.65 "SFMono-Regular",Consolas,"Liberation Mono",monospace;
}
.empty { margin:0; color:var(--mute); }
`;

/** Bytes as a short human figure. Not locale-split: `toLocaleString`'s thousands
 *  separator is identical for ko-KR and en-US (measured — see CLAUDE.md), and the
 *  unit letters are the same in both catalogues. */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shell(locale: Locale, s: Strings, rel: string, body: string): string {
  const t = s.viewer;
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.docTitle(rel))}</title>
<style>${VIEW_STYLE}</style>
</head>
<body>
<div class="shell">
  <p class="crumbs"><a href="/">${esc(t.back)}</a></p>
  ${body}
</div>
</body>
</html>`;
}

/**
 * Render the source page for `rel`, or the refusal that stopped it.
 *
 * `rel` is passed separately from `result` because the failure branch has no source to
 * take it from, and the page should still say which path it was asked for.
 */
export function renderViewPage(
  result: ViewResult,
  rel: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const s = strings(locale);
  const t = s.viewer;

  if (!result.ok) {
    return shell(
      locale,
      s,
      rel,
      `<h1>${esc(rel)}</h1>
  <p class="note" role="alert">${esc(t.refusalHeading)} — ${esc(refusalText(result.refusal, s))}</p>`,
    );
  }

  const src = result.source;
  const parts: string[] = [
    `<h1>${esc(rel)}</h1>`,
    `<p class="meta">${esc(t.size(fmtBytes(src.sizeBytes)))} · <a href="/open?rel=${encodeURIComponent(
      rel,
    )}">${esc(t.openInEditor)}</a></p>`,
  ];
  if (src.truncated) {
    parts.push(
      `<p class="note">${esc(t.truncated(fmtBytes(src.shownBytes), fmtBytes(src.sizeBytes)))}</p>`,
    );
  }
  parts.push(
    src.text.length > 0 ? `<pre>${esc(src.text)}</pre>` : `<p class="empty">${esc(t.empty)}</p>`,
  );

  return shell(locale, s, rel, parts.join("\n  "));
}
