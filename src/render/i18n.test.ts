// The catalogue's two invariants.
//
// Completeness is already a TYPE property — `KO` and `EN` both have to satisfy `Strings`,
// so a missing entry fails `bun run typecheck`, not this file. What a test can add is the
// thing the type cannot see: that an entry which was *declared* in English actually IS in
// English. A copy-paste from the Korean side typechecks perfectly and is exactly the
// failure mode a hand-maintained second language has.

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { assemble } from "../model/assemble";
import { EN } from "./i18n-en";
import { KO } from "./i18n-ko";
import { renderBody } from "./page";

const HANGUL = /[가-힣]/;

/**
 * Entries in `EN` that are Hangul ON PURPOSE.
 *
 * `langKo` is the only one: a language switcher names each language in its own language,
 * which is the point — a reader who cannot read the current page has to recognise the
 * chip that gets them out of it.
 */
const HANGUL_BY_DESIGN = new Set(["page.langKo"]);

/** Walk a catalogue and yield every string leaf with its dotted path. */
function* leaves(value: unknown, at = ""): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [at, value];
    return;
  }
  if (typeof value === "function") {
    // A parameterised entry: call it with placeholder arguments so its literal text is
    // exercised. Arity is known from the function itself; every parameter in this
    // catalogue is a string, a number, an array or a boolean, and each of those tolerates
    // the probes below.
    const fn = value as (...args: unknown[]) => unknown;
    for (const probe of [
      Array.from({ length: fn.length }, () => "X"),
      Array.from({ length: fn.length }, () => 1),
      Array.from({ length: fn.length }, () => ["X"]),
      Array.from({ length: fn.length }, () => true),
      Array.from({ length: fn.length }, () => undefined),
    ]) {
      try {
        const out = fn(...probe);
        if (typeof out === "string") yield [at, out];
      } catch {
        // A probe of the wrong shape — another one in the list will fit.
      }
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      yield* leaves(v, at ? `${at}.${k}` : k);
    }
  }
}

describe("the English catalogue is actually English", () => {
  test("no entry contains Hangul, apart from the language chip", () => {
    const offenders: string[] = [];
    for (const [at, text] of leaves(EN)) {
      if (HANGUL_BY_DESIGN.has(at)) continue;
      if (HANGUL.test(text)) offenders.push(`${at}: ${text.slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });

  test("and the Korean catalogue still is Korean — a wholesale swap would pass the above", () => {
    // The mirror assertion, so "EN has no Hangul" cannot be satisfied by making both
    // sides English.
    const korean = [...leaves(KO)].filter(([, t]) => HANGUL.test(t));
    expect(korean.length).toBeGreaterThan(200);
  });

  test("the two catalogues carry the same keys", () => {
    // Redundant with the typecheck for MISSING keys, but it also catches an extra one
    // that only exists on one side because a rename was applied to a single file.
    const keys = (c: unknown) => [...leaves(c)].map(([at]) => at).sort();
    expect(new Set(keys(EN))).toEqual(new Set(keys(KO)));
  });
});

describe("rendered output follows the locale", () => {
  const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
  const m = assemble(FIXTURE);

  test("?lang=en renders the panels in English", () => {
    const html = renderBody(m, "en");
    for (const marker of [
      "Progress",
      "Construction unit matrix",
      "Time analysis",
      "Deferred decisions",
      "work estimate",
    ]) {
      expect(html).toContain(marker);
    }
  });

  test("and drops the Korean panel headings it replaced", () => {
    const html = renderBody(m, "en");
    for (const gone of [
      "진행 개요",
      "시간 분석",
      "미뤄둔 결정",
      "작업 추정",
      "Construction 유닛",
    ]) {
      expect(html).not.toContain(gone);
    }
  });

  test("Korean is unchanged — the same panels, in Korean", () => {
    const html = renderBody(m, "ko");
    for (const marker of ["진행 개요", "시간 분석", "미뤄둔 결정", "작업 추정"]) {
      expect(html).toContain(marker);
    }
  });

  test("text READ FROM THE TREE stays verbatim in both", () => {
    // The boundary that matters most: a deferral item is measured data, and translating it
    // would put words in the run's mouth. The fixture's items are Korean, so they are
    // visible in the English page — deliberately.
    const item = "두 유닛의 공통 타입을 어디에 두는가";
    expect(renderBody(m, "ko")).toContain(item);
    expect(renderBody(m, "en")).toContain(item);
  });
});
