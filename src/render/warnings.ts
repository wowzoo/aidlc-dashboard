// A `Warning` becomes words here — by looking the code up in the catalogue.
//
// `assemble` emits a code and its facts (see the `Warning` doc in model/types.ts); the
// sentence lives in `i18n-ko.ts` / `i18n-en.ts`. That split is what the rest of the
// render layer already obeys — the scan and model layers name nothing they did not read
// from the tree — and these twelve warnings were the last places building prose upstream
// of here.
//
// The switch is EXHAUSTIVE by construction: the `never` assignment at the end fails to
// typecheck if a union member has no case, and `Strings` fails to typecheck if a language
// has no copy for it. A warning cannot reach the screen as a blank bullet.

import type { Locale, Warning } from "../model/types";
import type { OpenRefusal } from "../scan/open-file";
import type { ViewRefusal } from "../scan/view-file";
import { type Strings, strings } from "./i18n";

/** `s` is the resolved catalogue; `warningText` takes a locale for callers that have one. */
export function warningTextIn(w: Warning, s: Strings): string {
  const t = s.warn;
  switch (w.code) {
    case "catalog-read-failed":
      return t.catalogReadFailed(w.harnessDir);
    case "catalog-not-found":
      return t.catalogNotFound;
    case "audit-empty":
      return t.auditEmpty;
    case "state-version-mismatch":
      return t.stateVersionMismatch(w.stateVersion, w.harnessVersion, w.harnessDir);
    case "state-version-unreadable":
      return t.stateVersionUnreadable(w.stateVersion);
    case "team-without-unit-major":
      return t.teamWithoutUnitMajor(w.constructionIteration);
    case "unit-progress-malformed":
      return t.unitProgressMalformed;
    case "unit-progress-missing":
      return t.unitProgressMissing;
    case "roster-mismatch":
      return t.rosterMismatch(w.stateVersion, w.unknownToCatalog, w.missingFromState);
    case "harness-coexist":
      return t.harnessCoexist(w.harnesses, w.chosen);
    case "token-usage-failed":
      return t.tokenUsageFailed(w.detail);
    case "credit-assembly-failed":
      return t.creditAssemblyFailed(w.detail);
    default: {
      // Exhaustiveness guard — a new Warning member without a case fails here.
      const unhandled: never = w;
      return unhandled;
    }
  }
}

export function warningText(w: Warning, locale: Locale = "ko"): string {
  return warningTextIn(w, strings(locale));
}

/**
 * A refusal → words. Reaches the page as a link tooltip (`/open`) or as the body of the
 * viewer's error page (`/view`), so it belongs here rather than in `scan/open-file.ts` —
 * that module names the CAUSE, this one says it.
 *
 * Takes BOTH unions rather than duplicating the eight shared jail cases per caller: the
 * two overlap on `JailRefusal` exactly because the path checks are shared.
 */
export function refusalText(r: OpenRefusal | ViewRefusal, s: Strings): string {
  const t = s.openFile;
  switch (r.code) {
    case "bad-rel":
      return t.badRel;
    case "bad-chars":
      return t.badChars;
    case "outside-record":
      return t.outsideRecord;
    case "extension":
      return t.extension(r.allowed);
    case "symlink-escape":
      return t.symlinkEscape;
    case "not-found":
      return t.notFound;
    case "stat-failed":
      return t.statFailed;
    case "not-a-file":
      return t.notAFile;
    case "platform-unsupported":
      return t.platformUnsupported(r.platform);
    case "interpreter-metachars":
      return t.interpreterMetachars;
    case "opener-missing":
      return t.openerMissing(r.cmd);
    case "spawn-failed":
      return t.spawnFailed(r.detail);
    case "read-failed":
      return t.readFailed(r.detail);
    default: {
      const unhandled: never = r;
      return unhandled;
    }
  }
}
