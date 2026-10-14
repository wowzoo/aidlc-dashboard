// Panel (a) — the overview: where the run is, how far along, and the per-unit
// Construction picture.
//
// The overall percentage comes from state.md's flat checkbox count, deliberately
// matching what the engine's own status line reports. Deriving a "truer" number
// from disk would make this dashboard disagree with the terminal and leave the
// reader unsure which to believe.

import type { DashboardModel } from "../model/types";
import type { StageArtifact } from "../scan/artifacts";
import type { CheckpointProofNote } from "../scan/checkpoint-proofs";
import type { CellState, ConstructionMatrix, ReceiptReason } from "../scan/matrix";
import type { AidlcState, StageStatus } from "../scan/parser";
import { viewLink } from "./card-kit";
import { bar, esc, pill, section, shortTs } from "./common";
import type { Strings } from "./i18n";

/** Glyph per stage status, matching the state file's checkbox vocabulary. */
export const STAGE_GLYPH: Record<StageStatus, string> = {
  done: "✔",
  active: "▶",
  awaiting: "⏸",
  revising: "↻",
  skipped: "⊘",
  pending: "·",
};

function hero(state: AidlcState, identity: DashboardModel["identity"], s: Strings): string {
  const meta = [
    identity.scope ?? state.scope,
    state.plan ? s.overview.planLabel(state.plan) : "",
    state.projectType,
    identity.status,
  ]
    .filter((x) => x && x.length > 0)
    .join(" · ");
  const now = state.complete
    ? s.overview.runComplete
    : `${state.currentStageDisplay || "—"}${
        state.activeAgentDisplay ? ` · ${state.activeAgentDisplay}` : ""
      }`;
  return `<div class="hero">
  <div class="hero-top">
    <span class="hero-phase">${esc(state.lifecyclePhase || "—")}</span>
    <span class="hero-pct">${state.overallPct}%</span>
  </div>
  ${bar(state.overallPct, "bar-overall")}
  <div class="hero-meta">${esc(meta)}</div>
  <div class="hero-now"><span class="k">${esc(s.overview.nowLabel)}</span> ${esc(now)}
    <span class="hero-count">${state.overallDone}/${state.overallTotal} stage</span></div>
  <div class="hero-meta small">${esc(identity.record)} · ${esc(s.overview.updatedLabel)} ${esc(shortTs(state.lastUpdated))}</div>
</div>`;
}

/** Badge + title per artifact kind. Questions and the diary are not contract
 *  deliverables, so they are marked rather than hidden — a stalled run is
 *  usually sitting on a question file. */
const KIND_MARK: Record<StageArtifact["kind"], string> = {
  artifact: "📄",
  questions: "💬",
  diary: "📓",
};

/** Titles live in the catalogue; the glyph above does not need translating. */
function kindTitle(kind: StageArtifact["kind"], s: Strings): string {
  return kind === "artifact"
    ? s.overview.kindArtifact
    : kind === "questions"
      ? s.overview.kindQuestions
      : s.overview.kindDiary;
}

function fileSize(n: number): string {
  if (n <= 0) return "0";
  if (n < 1024) return `${n}B`;
  return `${Math.round(n / 1024)}K`;
}

/** One stage row. Files present → a <details> the user can expand; none →
 *  a plain row, so an empty toggle never invites a dead click. */
function stageRow(
  st: AidlcState["phases"][number]["stages"][number],
  files: StageArtifact[],
  s: Strings,
): string {
  const head = `<span class="glyph">${STAGE_GLYPH[st.status]}</span>${esc(st.display)}${
    st.execute ? "" : ' <span class="skip">SKIP</span>'
  }`;
  if (files.length === 0) {
    return `<li class="stage s-${esc(st.status)} no-art">${head}</li>`;
  }
  const items = files
    .map((f) => {
      // Unit prefix is required, not cosmetic: a merged Construction row carries
      // one `code-generation-plan.md` per unit, so the basename alone is ambiguous.
      const unit = f.unit ? `<span class="art-unit">${esc(f.unit)}</span>` : "";
      return `<li class="art a-${f.kind}"><a href="/open?rel=${encodeURIComponent(
        f.rel,
      )}" class="art-link" title="${esc(s.overview.openInEditor(f.rel))}"><span class="art-mark" title="${esc(
        kindTitle(f.kind, s),
      )}">${KIND_MARK[f.kind]}</span>${unit}<span class="art-name">${esc(f.name)}</span><span class="art-size">${esc(
        fileSize(f.size),
      )}</span></a></li>`;
    })
    .join("");
  return `<li class="stage s-${esc(st.status)}"><details class="art-box">
    <summary>${head}<span class="art-count">${files.length}</span></summary>
    <ul class="arts">${items}</ul>
  </details></li>`;
}

function phaseBlocks(
  state: AidlcState,
  artifacts: DashboardModel["artifacts"],
  s: Strings,
): string {
  const rows = state.phases.map((p) => {
    const count = p.skipped ? "skipped" : `${p.done}/${p.total}`;
    const stages = p.stages
      .map((st) => {
        return stageRow(st, artifacts[`${p.key}/${st.slug}`] ?? [], s);
      })
      .join("");
    return `<details class="phase"${p.declaredStatus === "Active" ? " open" : ""}>
  <summary><span class="phase-name">${esc(p.display)}</span>
    <span class="phase-count">${esc(count)}</span>
    <span class="phase-declared">${esc(p.declaredStatus)}</span></summary>
  ${p.skipped ? "" : bar(p.pct)}
  <ul class="stages">${stages}</ul>
</details>`;
  });
  return rows.join("\n");
}

/** Cell glyph + tooltip. The tooltip is where `missing` earns its keep — the four
 *  `unverified` causes each say their own thing, which is why the catalogue keys them
 *  separately (see the ReceiptReason note in scan/matrix.ts). */
function cellHtml(
  state: CellState,
  missing: string[],
  present: string[],
  s: Strings,
  reason?: ReceiptReason,
  skipReason?: string,
): string {
  // `n/a` needs a class the CSS can target, and "/" is not usable in one.
  return `<td class="mx-cell c-${state === "n/a" ? "na" : state}" title="${esc(
    cellTip(state, missing, present, s, reason, skipReason),
  )}">${cellGlyph(state)}</td>`;
}

/** The matrix's glyph per cell state. Exported so the Unit card speaks the same vocabulary. */
export function cellGlyph(state: CellState): string {
  return state === "complete"
    ? "█"
    : state === "unsettled"
      ? "▩"
      : state === "unverified"
        ? "▤"
        : state === "partial"
          ? "▨"
          : state === "skipped"
            ? "⊘"
            : state === "n/a"
              ? "–"
              : "·";
}

/** The matrix's hover text per cell state. */
export function cellTip(
  state: CellState,
  missing: string[],
  present: string[],
  s: Strings,
  reason?: ReceiptReason,
  skipReason?: string,
): string {
  return state === "partial"
    ? s.overview.tipPartial(missing)
    : state === "complete"
      ? s.overview.tipComplete(present)
      : state === "unsettled"
        ? // Artifacts met, receipt missing. The engine treats this as UNCOVERED, so
          // the cell must not read as done — a paused/stale/reopened unit lands here.
          s.overview.tipUnsettled(present)
        : state === "unverified"
          ? // Not "not done" — "cannot be checked here". Merging this into unsettled put a
            // red cell over every gap in this reader's reproduction of the engine. Each cause
            // says its own thing, because each is a different reason the audit cannot tell.
            s.overview.tipUnverified(reason ?? "ambiguous-floor", present)
          : state === "skipped"
            ? s.overview.tipSkipped(skipReason ?? "")
            : state === "n/a"
              ? s.overview.tipNotApplicable(present)
              : s.overview.tipNotStarted;
}

function matrixTable(mx: ConstructionMatrix, s: Strings): string {
  const head = mx.units
    .map(
      (u) =>
        `<th class="mx-unit" title="${esc(u.name)}${u.kind ? ` (${u.kind})` : ""}${
          u.dependsOn.length ? ` ← ${u.dependsOn.join(", ")}` : ""
        }">${esc(u.name.replace(/^PU-/, ""))}</th>`,
    )
    .join("");

  const rows = mx.stages
    .map((st) => {
      if (!st.execute || st.status === "skipped") {
        return `<tr class="mx-skip"><th>${esc(st.display)}</th><td colspan="${mx.units.length}">SKIP</td><td class="mx-n">—</td></tr>`;
      }
      const cells = st.cells
        .map((c) => cellHtml(c.state, c.missing, c.present, s, c.receiptReason, c.skipReason))
        .join("");
      // The denominator counts only units the stage actually contracts something
      // for; n/a units would otherwise read as outstanding work.
      const applicable = st.total - st.notApplicable - st.skipped;
      const n = `${st.complete}${st.unsettled ? `+${st.unsettled}▩` : ""}${
        st.unverified ? `+${st.unverified}▤` : ""
      }${st.partial ? `+${st.partial}▨` : ""}/${applicable}${
        st.notApplicable ? ` (–${st.notApplicable})` : ""
      }${st.skipped ? ` (–${st.skipped}⊘)` : ""}`;
      return `<tr><th>${esc(st.display)}${st.provisional ? `<span class="prov-mark" title="${esc(s.overview.provisionalTip)}">~</span>` : ""}</th>${cells}<td class="mx-n">${esc(n)}</td></tr>`;
    })
    .join("");

  const anyNa = mx.stages.some((st) => st.notApplicable > 0);
  const anySkipped = mx.stages.some((st) => st.skipped > 0);
  const anyUnsettled = mx.stages.some((st) => st.unsettled > 0);
  const anyUnverified = mx.stages.some((st) => st.unverified > 0);
  // The composition is logic and stays here; the fragments are catalogue entries.
  const note = mx.contractAware
    ? `<p class="note">${esc(s.overview.legendBase)}${
        anyUnsettled ? esc(s.overview.legendUnsettled) : ""
      }${
        anyUnverified ? esc(s.overview.legendUnverified) : ""
      }${anyNa ? esc(s.overview.legendNa) : ""}${anySkipped ? esc(s.overview.legendSkipped) : ""}</p>${
        mx.stateCompat === "verified"
          ? ""
          : // Carries <b> markup, so it is interpolated raw — it is our own copy, not
            // anything read from the tree.
            `<p class="note warn">${s.overview.legendUnverifiedContract}</p>`
      }`
    : // Receipts come from the audit, not the catalogue, so ▩ can appear with no
      // catalogue at all. Claiming "file presence only" was wrong whenever it did.
      `<p class="note warn">${esc(s.overview.legendNoContract(mx.receiptAware))}${
        anySkipped ? esc(s.overview.legendSkipped) : ""
      }</p>`;

  const batches = mx.batches.length
    ? `<div class="dag">${mx.batches
        .map(
          (b, i) =>
            `<div class="batch"><span class="batch-label">B${i + 1}</span>${b
              .map((u) => `<span class="batch-unit">${esc(u.replace(/^PU-/, ""))}</span>`)
              .join("")}</div>`,
        )
        .join('<span class="batch-arrow">→</span>')}</div>
      <p class="note">${esc(s.overview.batchNote)}</p>`
    : "";

  return `<div class="mx-wrap"><table class="mx">
  <thead><tr><th></th>${head}<th class="mx-n">${esc(s.overview.totalColumn)}</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
${note}
${batches}`;
}

/**
 * Unit checkpoint proofs the engine cannot count verified, under the matrix. A unit-level
 * fact, not a cell's: one checkpoint covers every per-unit stage of the unit. Tree text
 * (the proof's output tail) goes through esc(); the proof file links to /view.
 */
function checkpointList(notes: CheckpointProofNote[], s: Strings): string {
  if (notes.length === 0) return "";
  const o = s.overview;
  const items = notes
    .map((n) => {
      const kind = o.checkpointKind(n.kind);
      const file = n.state === "unreadable" ? esc(n.rel) : viewLink(n.rel, n.rel);
      const line =
        n.state === "failed"
          ? o.checkpointFailed(
              n.unit,
              kind,
              // `verified: false` is what every other fault already implies (`verifyOnce`
              // writes it from them), so it is named only when it stands alone.
              (n.faults.length > 1 ? n.faults.filter((f) => f !== "not-verified") : n.faults)
                .map((f) => o.checkpointFault(f, n.exitCode, n.signal))
                .join(", "),
              n.startedAt,
            )
          : n.state === "malformed"
            ? o.checkpointMalformed(n.unit, kind)
            : o.checkpointUnreadable(n.unit, kind, n.cause);
      const tail = n.state === "failed" ? (n.error ?? (n.stderrTail || n.stdoutTail)) : "";
      return `<li>${n.definite ? "" : "? "}${esc(line)} · <code>${file}</code>${
        tail
          ? `<details><summary>${esc(o.checkpointOutputTail)}</summary><pre>${esc(tail)}</pre></details>`
          : ""
      }</li>`;
    })
    .join("");
  // The engine-verdict sentence is said only when a note carries it; the `?` notes get
  // their own, which claims nothing.
  const definite = notes.some((n) => n.definite)
    ? `<p class="note">${esc(o.checkpointNote)}</p>`
    : "";
  const indefinite = notes.some((n) => !n.definite)
    ? `<p class="note">${esc(o.checkpointIndefiniteNote)}</p>`
    : "";
  const undetermined = notes.some((n) => n.kindUndetermined)
    ? `<p class="note">${esc(o.checkpointKindUndetermined)}</p>`
    : "";
  return `<h4>${esc(o.checkpointHeading)}</h4><ul class="note warn">${items}</ul>
${definite}${indefinite}${undetermined}`;
}

/**
 * The state's own `## Unit Progress` table, when there is one. This is the AUTHORITY in
 * team/unit-major — an engine-owned projection of receipts, reviews and gates — so it is
 * shown before the disk matrix and labelled as such, rather than being reconstructed.
 * At stage level it is not: the engine routes that plan before any team unit router and
 * derives the table only from a Unit DAG the plan does not have, so the same rows are a
 * leftover and the note says so (`note`).
 */
function unitProgressTable(
  up: NonNullable<AidlcState["unitProgress"]>,
  s: Strings,
  note: string,
): string {
  const head = up.stageColumns.map((c) => `<th>${esc(c)}</th>`).join("");
  const rows = up.rows
    .map((r) => {
      const cells = up.stageColumns
        .map((c) => {
          const st = r.stages[c];
          return `<td class="mx-cell">${st ? esc(STAGE_GLYPH[st] ?? "·") : "·"}</td>`;
        })
        .join("");
      const owner =
        r.owner && r.owner !== "-"
          ? esc(r.owner)
          : `<span class="mute">${esc(s.overview.unassignedOwner)}</span>`;
      return `<tr><th>${esc(r.unit)}</th><td>${owner}</td>${cells}<td class="mx-cell">${
        r.gate ? esc(STAGE_GLYPH[r.gate] ?? "·") : "·"
      }</td>${r.merged ? `<td>${esc(r.merged)}</td>` : ""}</tr>`;
    })
    .join("");
  const mergedCol = up.rows.some((r) => r.merged !== undefined);
  return `<div class="mx-wrap"><table class="mx">
  <thead><tr><th>unit</th><th>owner</th>${head}<th>gate</th>${
    mergedCol ? "<th>merged</th>" : ""
  }</tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<p class="note">${note}</p>`;
}

export function renderOverview(m: DashboardModel, s: Strings): string {
  const parts: string[] = [];

  parts.push(section(s.overview.sectionProgress, hero(m.state, m.identity, s)));
  // "Phase · Stage" is engine vocabulary in both languages, so it is not a catalogue entry.
  parts.push(section("Phase · Stage", phaseBlocks(m.state, m.artifacts, s)));

  const up = m.state.unitProgress;
  if (up && !up.malformed && up.rows.length > 0) {
    const stale = m.unitProgressStale;
    const staleNote = stale
      ? `<p class="note warn">${esc(
          stale.kind === "roster"
            ? s.overview.unitProgressStaleRoster(stale.missing, stale.extra)
            : s.overview.unitProgressStaleDag,
        )}</p>`
      : "";
    const stageLevel = m.unitArtifactMode === "stage-level";
    parts.push(
      section(
        stageLevel ? s.overview.sectionUnitProgressStageLevel : s.overview.sectionUnitProgress,
        unitProgressTable(
          up,
          s,
          stageLevel ? s.overview.unitProgressStageLevelNote : s.overview.unitProgressNote,
        ) + staleNote,
        "unit-progress",
      ),
    );
  }
  if (m.matrix) {
    parts.push(
      section(
        s.overview.sectionMatrix,
        matrixTable(m.matrix, s) +
          (m.unitArtifactMode === "unknown"
            ? `<p class="note warn">${esc(s.overview.unitModeUnknown)}</p>`
            : "") +
          (m.unitDag.state === "ok" && m.unitDag.graphDiffers
            ? `<p class="note">${esc(s.overview.unitDagHealed)}</p>`
            : "") +
          checkpointList(m.checkpointProofs ?? [], s),
        "matrix",
      ),
    );
  } else {
    parts.push(
      section(
        s.overview.sectionMatrix,
        // No roster: the Unit-of-Work DAG resolved to none, or to malformed (the engine's
        // `resolveBoltDag`, scan/unit-dag.ts). The engine's name for it, `bolt_dag`, is
        // kept out of the note: it names a concept — Bolt — that this dashboard never shows.
        m.unitArtifactMode === "stage-level"
          ? `<p class="note">${esc(s.overview.stageLevelUnits)} ${pill(s.overview.stageLevelUnitsPill, "mute")}</p>`
          : m.unitDag.state === "malformed"
            ? `<p class="note warn">${esc(s.overview.unitDagMalformed(m.unitDag.reason, m.unitDag.stop))} ${pill(
                s.overview.unitDagMalformedPill(m.unitDag.stop),
                m.unitDag.stop === "construction" ? "warn" : "mute",
              )}</p>`
            : `<p class="note">${esc(s.overview.noUnits)} ${pill(s.overview.noUnitsPill, "mute")}</p>`,
      ),
    );
  }

  return parts.join("\n");
}
