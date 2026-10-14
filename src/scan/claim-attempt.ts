// Which audit rows belong to the team claim attempt this checkout is on — a
// transcription of the 2.11.0 engine's `eventMatchesClaimAttempt` (aidlc-lib.ts) with
// the readers it stands on: `isTeamUnitOwnership`, `applicableTeamUnitScopeStamp` /
// `readUnitScopeStamp`, `readClaimGenerations` / `claimGenerationKey`, and
// `activeIntentUuid` over `listIntents`.
//
// Under team ownership the engine runs the same floor and reduction over a unit's
// lifecycle rows as everywhere else, plus this one filter on those rows only. Two
// checkout-local files decide it, both under the workspace roof `aidlc/`:
//
//   - `.aidlc-unit-scope.json`, the unit scope stamp. When it is well-formed AND names
//     the active space and the active intent's uuid, it is APPLICABLE: only rows of its
//     own unit pass, and only with `Attempt Generation` equal to its generation.
//   - `.aidlc-claim-generations.json`, `{"<space>/<intent uuid|legacy>/<unit>": n}`.
//     With no applicable stamp, a row carrying `Attempt Generation` passes only when it
//     equals the unit's recorded generation; a row with none, or a unit with none
//     recorded, passes.
//
// Both readers are total in the engine: an absent, unreadable or malformed file reads
// as no stamp / no generations, and so it does here — that is the engine's own answer
// in this checkout, not a guess. The one input the engine can THROW on is the intent
// registry: `recordDirMatches` dereferences each row, so a `null` row, or a non-string
// uuid against a hex-suffixed record name, raises inside `activeIntentUuid`. Where the
// filter reaches that read, the answer is `unknown` — the engine itself cannot run there.
//
// The stamp's own claim check (`liveClaimPayload` against the claim refs in git) belongs
// to the commands that act on a claim, not to this filter, and is not read.

import * as fs from "node:fs";
import * as path from "node:path";
import { activeSpace } from "./resolve";
import { stateField } from "./unit-artifact-mode";

/** A row passes, is dropped, or reaches a read the engine would throw on. */
export type ClaimVerdict = boolean | "unknown";

/** `eventMatchesClaimAttempt(projectDir, block, unit)` over a parsed row's fields. */
export type ClaimFilter = (
  fields: Record<string, string>,
  unit: string | undefined,
) => ClaimVerdict;

/** The fields of a well-formed stamp this reader uses (`UnitScopeStamp`). */
export interface ScopeStamp {
  space: string;
  intent_uuid: string;
  unit: string;
  generation: number;
  gate_rhythm: "per-stage" | "unit-end";
}

/** The active intent's uuid as `activeIntentUuid` returns it, or a registry it throws on. */
export type IntentUuid = { ok: true; value: unknown } | { ok: false };

/** Everything the filter reads, so the rule can be exercised without a checkout. */
export interface ClaimInputs {
  /** `isTeamUnitOwnership(state)`. */
  team: boolean;
  /** `readUnitScopeStamp`: a well-formed stamp, or null. */
  stamp: ScopeStamp | null;
  /** `readClaimGenerations`: positive-integer entries only. */
  generations: Record<string, number>;
  /** `activeSpace`. */
  space: string;
  /** `activeIntentUuid` — read lazily by the engine, so only reached paths can fail. */
  uuid: () => IntentUuid;
}

/** `isTeamUnitOwnership`: `getField(state, "Unit Ownership")?.trim() === "team"`. */
export function isTeamUnitOwnership(stateText: string): boolean {
  return stateField(stateText, "Unit Ownership") === "team";
}

/** `readUnitScopeStamp`'s validation, field for field; anything else is no stamp. */
export function parseScopeStamp(text: string): ScopeStamp | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const s = parsed as Record<string, unknown>;
  const str = (k: string) => typeof s[k] === "string";
  const generation = s.generation;
  if (
    s.version !== 1 ||
    !str("space") ||
    !str("intent_uuid") ||
    !str("intent_id8") ||
    !str("unit") ||
    !str("owner") ||
    !Number.isInteger(generation) ||
    ((generation as number | undefined) ?? 0) < 1 ||
    !str("nonce") ||
    !str("claim_ref") ||
    !str("claim_oid") ||
    !str("claimed_from_oid") ||
    !str("integration_ref") ||
    (s.gate_rhythm !== "per-stage" && s.gate_rhythm !== "unit-end") ||
    (s.audit_shard !== undefined &&
      (typeof s.audit_shard !== "string" || !/^[A-Za-z0-9._-]+\.md$/.test(s.audit_shard)))
  ) {
    return null;
  }
  return {
    space: s.space as string,
    intent_uuid: s.intent_uuid as string,
    unit: s.unit as string,
    generation: generation as number,
    gate_rhythm: s.gate_rhythm,
  };
}

/** `readClaimGenerations`: the entries whose value is a positive integer; else `{}`. */
export function parseClaimGenerations(text: string): Record<string, number> {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          Number.isInteger(entry[1]) && (entry[1] as number) > 0,
      ),
    );
  } catch {
    return {};
  }
}

/**
 * `recordDirMatches` as the engine runs it on an unvalidated registry row — including the
 * dereferences that throw. Kept literal on purpose: an emulation of the coercions is where
 * a transcription goes wrong.
 */
// biome-ignore lint/suspicious/noExplicitAny: the engine's own unchecked row access
function engineRecordDirMatches(entry: any, dirName: string): boolean {
  if (entry.dirName) return entry.dirName === dirName;
  if (!dirName.startsWith(`${entry.slug}-`)) return false;
  const suffix = dirName.slice(entry.slug.length + 1);
  return (
    /^[0-9a-f]+$/.test(suffix) && entry.uuid.replace(/-/g, "").slice(-suffix.length) === suffix
  );
}

/**
 * `activeIntentUuid(projectDir, space)` for the record this page reads: `listIntents` maps
 * EVERY registry row to its first matching record dir (so any row can throw), appends the
 * orphan dirs with an empty uuid, and the first entry on the active dir gives a truthy uuid
 * or null.
 */
export function activeIntentUuid(
  registry: readonly unknown[],
  recordDirs: readonly string[],
  activeDir: string,
): IntentUuid {
  try {
    const claimed = new Set<string>();
    const infos: { uuid: unknown; dirName: string | null }[] = registry.map((entry) => {
      const dirName = recordDirs.find((d) => engineRecordDirMatches(entry, d)) ?? null;
      if (dirName) claimed.add(dirName);
      // biome-ignore lint/suspicious/noExplicitAny: the engine's own unchecked row access
      return { uuid: (entry as any).uuid, dirName };
    });
    for (const d of recordDirs) if (!claimed.has(d)) infos.push({ uuid: "", dirName: d });
    const match = infos.find((i) => i.dirName === activeDir);
    return { ok: true, value: match?.uuid ? match.uuid : null };
  } catch {
    return { ok: false };
  }
}

/** `applicableTeamUnitScopeStamp`: the stamp when team-owned and it names this intent. */
export function applicableStamp(c: ClaimInputs): ScopeStamp | null | "unknown" {
  if (!c.team || !c.stamp) return null;
  const uuid = c.uuid();
  if (!uuid.ok) return "unknown";
  if (!uuid.value || c.stamp.space !== c.space || c.stamp.intent_uuid !== uuid.value) {
    return null;
  }
  return c.stamp;
}

/** `eventMatchesClaimAttempt`, given the record's readers. */
export function claimFilter(c: ClaimInputs): ClaimFilter {
  return (fields, unit) => {
    if (!c.team) return true;
    const stamp = applicableStamp(c);
    if (stamp === "unknown") return "unknown";
    if (!stamp) {
      if (!unit) return true;
      const eventGeneration = fields["Attempt Generation"];
      if (eventGeneration === undefined) return true;
      const uuid = c.uuid();
      if (!uuid.ok) return "unknown";
      const key = `${c.space}/${String(uuid.value ?? "legacy")}/${unit}`;
      const generation = Object.hasOwn(c.generations, key) ? c.generations[key] : undefined;
      return generation === undefined ? true : eventGeneration === String(generation);
    }
    const eventUnit = fields.Unit;
    if (unit !== undefined && unit !== stamp.unit) return false;
    if (eventUnit !== undefined && eventUnit !== stamp.unit) return false;
    return fields["Attempt Generation"] === String(stamp.generation);
  };
}

/**
 * `effectiveUnitGateRhythm`: an applicable stamp's `gate_rhythm`, else the state's
 * `Unit Gate Rhythm` (`unit-end` only under team ownership, else `per-stage`).
 */
export function unitGateRhythm(
  c: ClaimInputs,
  stateText: string,
): "per-stage" | "unit-end" | "unknown" {
  const stamp = applicableStamp(c);
  if (stamp === "unknown") return "unknown";
  if (stamp) return stamp.gate_rhythm;
  if (!c.team) return "per-stage";
  return stateField(stateText, "Unit Gate Rhythm") === "unit-end" ? "unit-end" : "per-stage";
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

/** Record dirs as `listIntentDirs` lists them: those holding `aidlc-state.md`, sorted. */
function recordDirsOf(intentsDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(intentsDir);
  } catch {
    return [];
  }
  return names.filter((n) => fs.existsSync(path.join(intentsDir, n, "aidlc-state.md"))).sort();
}

/** The engine's `readIntentRegistry`: the raw array, unvalidated, or `[]`. */
function rawRegistry(intentsDir: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(intentsDir, "intents.json"), "utf-8"),
    );
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The checkout's claim inputs for the record at `recordDir` under `root`. Reads only; the
 * registry is read once, and only if the filter reaches the intent's uuid.
 */
export function readClaimInputs(root: string, recordDir: string, stateText: string): ClaimInputs {
  const roof = path.join(root, "aidlc");
  const space = activeSpace(root);
  const intentsDir = path.join(roof, "spaces", space, "intents");
  const stampText = readText(path.join(roof, ".aidlc-unit-scope.json"));
  const generationsText = readText(path.join(roof, ".aidlc-claim-generations.json"));
  let uuid: IntentUuid | undefined;
  return {
    team: isTeamUnitOwnership(stateText),
    stamp: stampText === undefined ? null : parseScopeStamp(stampText),
    generations: generationsText === undefined ? {} : parseClaimGenerations(generationsText),
    space,
    uuid: () => {
      uuid ??= activeIntentUuid(
        rawRegistry(intentsDir),
        recordDirsOf(intentsDir),
        path.basename(recordDir),
      );
      return uuid;
    },
  };
}
