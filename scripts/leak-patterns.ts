// What must never appear in anything this repository publishes.
//
// ⚠️ THIS FILE IS EXEMPT FROM THE AUDIT THAT USES IT. A denylist of the things you
// are hiding is itself the secret, so `audit-repo.ts` skips this path by name — and
// skips itself too, since it names the exemption. Those two are the files no automated
// check reads; a human has to, and the audit prints both names on every run so the
// obligation is visible. Never put a real customer name, hostname, repo owner or token
// in here as a literal — not even in a comment explaining a pattern, which is a
// mistake this file has already had to correct once. Everything below is either a
// shape (`AKIA…`) or derived at runtime from the machine (`operatorNames()`,
// `siblingRemoteOwners()`, `customerNames()` — none hardcodes a name).
//
// WHY THIS EXISTS SEPARATELY FROM THE ARCHIVE AUDIT. `package.ts` inspects the staged
// zip, which by design excludes `*.test.ts` and `fixtures/`. That is correct for the
// archive and wrong for the repository: the repo is a second exposure surface and had
// nothing checking it. Measured cost of the gap — a real customer name once survived
// in `transcript-reader.test.ts` after being removed from the module beside it, and
// four run-specific strings (a retail domain noun, a registry id, a team name, a
// project name) reached test fixtures and this module's own header comments before
// anyone looked. The archive audit passed every time, and passing was read as clean.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LeakPattern {
  pattern: RegExp;
  why: string;
}

/**
 * Strings that would leak the operator's machine.
 *
 * `/Users/me/` is exempt because it is this codebase's documented placeholder (the
 * picker's input hint, the slug example). Exempting it matters: an audit that cries
 * wolf on every intended example gets silenced wholesale, and then it catches
 * nothing. It earned its keep by flagging a real customer name sitting in a slug
 * example — so read every hit, never blanket-suppress one.
 */
export const MACHINE: readonly LeakPattern[] = [
  {
    pattern: /\/Users\/(?!me\/)[a-z0-9._-]+\/(Development|Desktop|Documents)\//i,
    why: "다른 사람의 홈 경로",
  },
  ...siblingRemoteOwners().map((n) => ({
    pattern: new RegExp(
      `(^|[^a-z0-9가-힣])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
      "i",
    ),
    why: "비공개 형제 저장소 소유자",
  })),
  ...operatorNames().map((n) => ({
    // Same boundary as the customer patterns: a hyphen COUNTS as a boundary, because
    // the shape that actually leaks is the hyphenated slug
    // (`-Users-<name>-Development-…`) and an earlier version excluded `-`, which made
    // the pattern silently miss it. Probed both forms after fixing.
    pattern: new RegExp(
      `(^|[^a-z0-9가-힣])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
      "i",
    ),
    why: "운영자 계정명",
  })),
];

/**
 * The operator's own account name, derived at runtime — never written here.
 *
 * It used to be a literal, which meant this file published the very string the audit
 * was looking for. That was not a leak (21 commit author lines carry the same name),
 * but it was incoherent: the check flagged its own repository. Deriving it also makes
 * the audit correct on someone else's machine instead of only on one.
 *
 * The generic home-path pattern above already catches `/Users/<anyone>/Development/`
 * regardless of name; these add the BARE name, which is how a username reaches a
 * comment or a slug without a slash in front of it.
 */
function operatorNames(): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined) => {
    const n = (v ?? "").trim().toLowerCase();
    // 4 chars is the floor that keeps `ci`, `me` and `dev` out of the pattern set.
    if (n.length >= 4 && /^[a-z0-9][a-z0-9._-]*$/.test(n) && n !== "user" && n !== "root")
      out.add(n);
  };
  try {
    add(os.userInfo().username);
  } catch {
    // No passwd entry (some containers). The home-path pattern still applies.
  }
  for (const key of ["user.name", "user.email"]) {
    const r = spawnSync("git", ["config", "--get", key], { encoding: "utf-8" });
    const v = r.status === 0 ? r.stdout : "";
    add(key === "user.email" ? v.split("@")[0] : v);
  }
  return [...out].sort();
}

/**
 * GitHub owners of every remote EXCEPT `origin` — the private siblings this public
 * repository must not name. Derived, never written here, for the same reason the
 * operator name is: a literal would publish the string the audit looks for.
 *
 * `origin` is the published remote, so its owner is public by definition and is
 * excluded (it is also already covered by `operatorNames()` when the two coincide).
 * Any OTHER remote is a sibling — a private archive, a fork, a mirror — and naming it
 * in a public file discloses a repository the reader was not meant to know exists.
 *
 * This gap was found by a note file, not by the audit: an untracked `MIGRATION.md` at
 * the root recorded the private archive remote as its origin and the audit passed it,
 * while the history finding in `CLAUDE.md` treats a private-sibling repo name as
 * sensitive. The file is ignored now; this is the pattern that would have caught it.
 * (The owner is deliberately not quoted here — writing it would be the leak.)
 *
 * Blind on a fresh clone with only `origin`, exactly like the customer list — the
 * count printed by `audit-repo.ts` is what says so.
 */
function siblingRemoteOwners(): string[] {
  const r = spawnSync("git", ["remote", "-v"], {
    cwd: path.join(import.meta.dir, ".."),
    encoding: "utf-8",
  });
  if (r.status !== 0) return [];
  // Both SSH (`git@host:owner/repo.git`) and HTTPS (`https://host/owner/repo`).
  const ownerOf = (url: string): string | undefined =>
    /[:/]([a-z0-9][a-z0-9._-]*)\/[^/]+?(?:\.git)?$/i.exec(url)?.[1]?.toLowerCase();
  const published = new Set<string>();
  const siblings = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const [name, url] = line.trim().split(/\s+/);
    if (!name || !url) continue;
    const owner = ownerOf(url);
    // 4 chars is the same floor operatorNames() uses — keeps a stub owner out.
    if (owner === undefined || owner.length < 4) continue;
    (name === "origin" ? published : siblings).add(owner);
  }
  for (const o of published) siblings.delete(o);
  return [...siblings].sort();
}

/**
 * Credential SHAPES, not values. Cheap to check and the one class of leak that is
 * immediately exploitable rather than merely embarrassing.
 */
export const CREDENTIALS: readonly LeakPattern[] = [
  { pattern: /\bghp_[A-Za-z0-9]{20,}/, why: "GitHub personal access token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/, why: "GitHub fine-grained token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, why: "AWS access key id" },
  { pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, why: "API 키" },
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, why: "사설 키" },
];

/** Where customer work trees live. Machine-local; absent on a fresh clone. */
const ACCOUNT_ROOTS = [
  path.join(os.homedir(), "Development", "ai-dlc", "_accounts"),
  path.join(os.homedir(), "Documents", "AI-DLC", "_accounts"),
];

/**
 * Names too short or generic to match on without drowning the report in noise.
 *
 * The list is short on purpose. The real defence against noise is matching only the
 * FULL directory name — see the note in `customerNames()` about the stem split that
 * had to be removed.
 */
const TOO_GENERIC = new Set(["update", "schema", "word-book", "aidlc-faq", "aidlc-demo-showcase"]);

/**
 * A trailing version or qualifier segment, stripped so a name written without it is
 * still caught: `bookclub-3.0` → `bookclub`. Deliberately narrow — it fires on digits
 * and on `old`, never on a second word, because `table-order` must not become `table`.
 */
const VERSION_SUFFIX = /[-_](?:v?\d[\d.]*|old)$/i;

export interface CustomerSource {
  /** Directory names found, lower-cased and de-duplicated. NEVER printed. */
  names: string[];
  /** Roots that existed. Empty means the audit is running blind. */
  rootsFound: string[];
  /** Roots probed but missing, so the report can say what it could not read. */
  rootsMissing: string[];
}

/**
 * Read customer names from the work-tree roots rather than from a literal list.
 *
 * The list cannot live in this repository: it is public, and an inventory of
 * customer names is precisely the thing being protected. So the audit is only as
 * complete as the machine it runs on — which is why `audit-repo.ts` prints the
 * COUNT it loaded and says loudly when it loaded none. A blind pass is not a pass.
 *
 * ONLY FULL DIRECTORY NAMES MATCH. The first version also added each name's stem
 * before the first `-`/`_`, so that a document writing `woongjin` would be caught
 * alongside `woongjin_thinkbig`. That turned a real account dir named `table-order`
 * into the pattern `table`, which hit **57 lines** of ordinary HTML and CSS on the
 * first run — the exact "audit that cries wolf gets silenced" failure the note on
 * `/Users/me/` above warns about, walked into within the hour. The stem was also
 * unnecessary: every account whose stem mattered (`armiq`, `woongjin`) already has a
 * bare directory of its own, so the full-name match covers it. Only a trailing
 * version segment is stripped.
 */
export function customerNames(): CustomerSource {
  const names = new Set<string>();
  const rootsFound: string[] = [];
  const rootsMissing: string[] = [];
  for (const root of ACCOUNT_ROOTS) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      rootsMissing.push(root);
      continue;
    }
    rootsFound.push(root);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const n = e.name.toLowerCase();
      if (n.startsWith(".") || TOO_GENERIC.has(n) || n.length < 4) continue;
      names.add(n);
      const base = n.replace(VERSION_SUFFIX, "");
      if (base !== n && base.length >= 4 && !TOO_GENERIC.has(base)) names.add(base);
    }
  }
  return { names: [...names].sort(), rootsFound, rootsMissing };
}
