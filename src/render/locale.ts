// Which language the page is written in, and how a request's language is decided.
//
// WHY THIS IS NOT A FIELD ON THE MODEL. `DashboardModel` is what the workspace says;
// a locale is how the reader wants to read it. Putting it on the model would make
// `/api/model` carry a presentation field and would force `assemble` to take a
// locale — which is the same move as building display strings in the scan layer, the
// mistake that put an English `(unassigned)` on a Korean screen. So the locale is
// threaded to the render entry points as an argument and never enters assembly.
//
// WHY IT IS NOT A MODULE VARIABLE EITHER. `activeRoot` in `server.ts` is the one
// mutable thing in this process, deliberately. A shared server is read by a Korean
// teammate and a non-Korean one at the same time, so the language belongs to the
// REQUEST, not to the process — same shape as `?cw=`, which is resolved per request
// and never stored.
//
// RESOLUTION ORDER, most explicit first:
//
//   1. `?lang=` — the reader just asked, on this request.
//   2. the `aidlc_lang` cookie — the reader asked earlier and it stuck.
//   3. `Accept-Language` — what their browser says, by q-value.
//   4. the `--lang` default (`ko` unless the operator changed it).
//
// A value that is not a supported locale falls THROUGH to the next source rather
// than resolving to the default, so a stale cookie cannot pin a reader whose
// `?lang=` was a typo.

import type { Locale } from "../model/types";

/** The supported set. Two, because the audience splits Korean / non-Korean and
 *  English is the lingua franca for the second — not a list of regional locales. */
export const LOCALES: readonly Locale[] = ["ko", "en"];

export const DEFAULT_LOCALE: Locale = "ko";

/** Cookie name. Prefixed so it cannot collide with a cookie some other loopback
 *  service on a sibling port set for `127.0.0.1` — cookies ignore the port. */
export const LOCALE_COOKIE = "aidlc_lang";

/** One year: a reading-language preference has no reason to expire sooner. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** `?lang=` value. Unsupported or absent → undefined (fall through). */
export function localeFromQuery(raw: string | null | undefined): Locale | undefined {
  return isLocale(raw) ? raw : undefined;
}

/** The `aidlc_lang` cookie out of a `Cookie` header, if it holds a supported value. */
export function localeFromCookie(header: string | null | undefined): Locale | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== LOCALE_COOKIE) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    if (isLocale(value)) return value;
  }
  return undefined;
}

/**
 * Best supported language in an `Accept-Language` header.
 *
 * Matched on the PRIMARY SUBTAG, so `ko-KR` and `en-GB` both land — the split this
 * serves is Korean / not-Korean, and refusing `en-GB` because it is not `en` would
 * be pedantry with a real cost. `q` defaults to 1 and orders the candidates; `*` is
 * skipped rather than treated as a match, since it says "anything" and the default
 * already answers that.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | undefined {
  if (!header) return undefined;
  const candidates: { tag: string; q: number }[] = [];
  for (const entry of header.split(",")) {
    const [rawTag, ...params] = entry.split(";");
    const tag = (rawTag ?? "").trim().toLowerCase();
    if (tag === "" || tag === "*") continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m?.[1] !== undefined) {
        const parsed = Number.parseFloat(m[1]);
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    candidates.push({ tag, q });
  }
  // Stable by q so equal weights keep header order, which is the client's own ranking.
  candidates.sort((a, b) => b.q - a.q);
  for (const { tag } of candidates) {
    const primary = tag.split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return undefined;
}

export interface LocaleRequest {
  /** `?lang=` search param, verbatim. */
  query?: string | null;
  /** The request's `Cookie` header, verbatim. */
  cookie?: string | null;
  /** The request's `Accept-Language` header, verbatim. */
  acceptLanguage?: string | null;
  /** The operator's `--lang` default. */
  fallback?: Locale;
}

/** Resolve one request's language. Never throws, always returns a supported locale. */
export function resolveLocale(req: LocaleRequest): Locale {
  return (
    localeFromQuery(req.query) ??
    localeFromCookie(req.cookie) ??
    localeFromAcceptLanguage(req.acceptLanguage) ??
    req.fallback ??
    DEFAULT_LOCALE
  );
}

/**
 * `Set-Cookie` value that makes an explicit `?lang=` stick.
 *
 * `SameSite=Lax` is not boilerplate here: it keeps the cookie off cross-site POSTs,
 * which is the same threat the `Sec-Fetch-Site` guard in `server.ts` answers. No
 * `Secure`, because this server is plain HTTP on loopback by design and `Secure`
 * would stop the cookie being stored at all.
 */
export function localeCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}
