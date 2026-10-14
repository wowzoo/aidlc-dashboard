// Parse the audit ledger into one time-ordered event list.
//
// LAYOUT. The ledger is per-clone SHARDED: <record>/audit/<host>-<clone12hex>.md,
// one file per machine/clone that ran the workflow. A parallel run therefore has
// several shards and no single file holds the whole story, so every shard is read
// and the merged blocks re-sorted by timestamp. Reading only the biggest shard
// would silently drop another developer's work.
//
// BLOCK FORMAT (aidlc-audit.ts: renderAuditBlock). Blocks are separated by a bare
// `---` line; each is a `## Human Heading` followed by `**Key**: value` lines, of
// which `**Timestamp**` (ISO, second precision, UTC) and `**Event**` are always
// present. The remaining keys vary per event type and are kept verbatim in a map
// rather than typed per event — 72 event types exist and the dashboard reads a
// handful of keys off a few of them.
//
// WHY FULL RE-PARSE, NO INCREMENTAL OFFSETS. Measured on a real run: 2 shards
// (1.1MB + 792B), 4,228 blocks, parse + sort in 7.5ms. Tracking byte offsets to
// append-parse would add mutable cross-request state for no perceptible gain, and
// would be unsound here anyway — the inspected tree is typically a SYNCED copy,
// so a shard can be replaced wholesale rather than appended to.
//
// STAGE ATTRIBUTION. Most stage-scoped events carry `**Stage**` (or `**Stage
// slug**` for sensors), but ARTIFACT_CREATED/ARTIFACT_UPDATED carry NO stage
// field — the stage is only recoverable from `**Context**`. Ignoring that zeroes
// out per-stage artifact counts (a defect the Python reader hit first time).
//
// ⚠️ Context has FOUR-SEGMENT forms that mean DIFFERENT things, and position
// alone cannot tell them apart:
//
//   inception > practices-discovery > contributions > x.md    stage=slot1, slot2=SUBDIR
//   construction > PU-1-walking-skeleton > functional-design > x.md
//                                                             stage=slot2, slot1=UNIT
//
// Taking slot1 always (what harness_timing_report.py does) undercounts every
// per-unit Construction stage; taking slot2 whenever there are four segments
// mis-attributes a stage that merely has a subdirectory. So the segment is
// resolved against the workspace's own stage catalogue — `isStage` below — and
// only falls back to position when no catalogue was supplied.
//
// COPIED SHARDS ARE READ ONCE. A sync tool's conflict copy (`<shard> 2.md`) or a hand
// copy repeats rows another shard already holds; read twice, every copied row ties
// with itself across two files, doubles the counts and reads as causally unordered,
// which stops every receipt stamped before the copy from settling. `copiedAuditBlocks`
// is the engine's rule, transcribed, and the ledger skips what it names.
//
// A SHARD REACHED THROUGH A SYMLINK IS REFUSED, as the engine's `auditShards` and
// `readAuditShardTexts` refuse it (2.11.0 aidlc-lib.ts — `assertNoSymlinkInChainOrThrow`,
// `boundaryRelativePartsOrThrow`, `readAppendOnlyFileNoFollowOrThrow`): no directory
// between the workspace root and the shard, and not the shard itself, may be a
// symlink; a shard must be a regular file, still the one its pathname names; and the
// chain is checked again after the read. The root is the anchor, not part of the
// chain, so a symlinked workspace root is still read — the engine never checks its
// anchor. A reader that followed links counted rows the engine never sees. Refusals
// are listed in `refused`; other failures (a shard that vanished, one unreadable for
// another reason) are skipped as before. This is parity for the AUDIT only: the
// engine's own state, questions and heartbeat reads follow links, and so do ours.
// Measured 2026-10-14 over the 150 records on this machine: events and shards read
// are identical to the reader before, and nothing is refused.
//
// Node fs only, never throws: an unreadable shard is skipped, not fatal.

import * as fs from "node:fs";
import * as path from "node:path";

/** One audit block. */
export interface AuditEvent {
  /** ISO 8601, second precision, UTC — verbatim from the ledger. */
  ts: string;
  /** Canonical event type, e.g. "STAGE_COMPLETED". */
  event: string;
  /** Stage slug when attributable (direct field, else parsed from Context). */
  stage?: string;
  /** Unit of work, only when a per-unit Context named one. */
  unit?: string;
  /** Every `**Key**: value` line of the block, keys verbatim. */
  fields: Record<string, string>;
  /** Basename of the shard this block came from — which clone did it. */
  shard: string;
  /**
   * The block's index in its shard, counting every `---`-separated block (title and
   * notes included), and the shard's index among the shards read, by sorted name —
   * the engine's `pos` / `shardIndex`. Same-second rows are ordered by them, and the
   * engine's `AMBIGUOUS` attempt floor is a digest over them, so a reader without
   * them cannot rebuild that floor. Optional for events built by hand in tests.
   */
  pos?: number;
  shardIndex?: number;
}

export interface AuditLedger {
  /** All blocks from all shards, ascending by timestamp. */
  events: AuditEvent[];
  /** event type → count, for the stream filter and the health panel. */
  counts: Map<string, number>;
  /** Shard basenames read, for provenance ("2 clones"). */
  shards: string[];
  /**
   * Paths (relative to the anchor) this reader refused, by the engine's rules (see the
   * header): a shard or audit dir reached through a symlink or outside the anchor, or
   * a `.md` that is not a regular file. A refused audit dir appears once, standing for
   * every shard beneath it — none is listed.
   * Always set by `readAuditLedger`; optional for ledgers built by hand in tests.
   */
  refused?: string[];
  /** Earliest / latest timestamp seen, undefined for an empty ledger. */
  firstTs?: string;
  lastTs?: string;
}

const FIELD_RE = /^\*\*([^*]+)\*\*:[ \t]*(.*)$/;

/**
 * Tells whether a Context segment is a real stage slug. Supply
 * `(s) => catalog.bySlug.has(s)`; omit to fall back to positional guessing.
 */
export type IsStage = (slug: string) => boolean;

/**
 * Resolve `**Context**` into { stage, unit }.
 *
 * With an `isStage` oracle the shape is read rather than guessed: scan the
 * segments (skipping the leading phase) for the first that is a known stage; a
 * segment before it is the unit of work. Without the oracle, fall back to
 * position — 4 segments means unit at slot 1 and stage at slot 2, which is right
 * for per-unit Construction writes and wrong for a stage with a subdirectory.
 */
export function parseContext(ctx: string, isStage?: IsStage): { stage?: string; unit?: string } {
  const segs = ctx
    .split(">")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segs.length < 2) return {};

  if (isStage) {
    for (let i = 1; i < segs.length; i++) {
      const seg = segs[i]!;
      if (!isStage(seg)) continue;
      // Anything between the phase and the stage is the unit of work.
      return { stage: seg, unit: i > 1 ? segs[i - 1] : undefined };
    }
    // No known stage in the path (e.g. `verification > phase-check-ideation.md`,
    // a phase-level write). Leave unattributed rather than guess.
    return {};
  }

  if (segs.length >= 4) return { stage: segs[2], unit: segs[1] };
  if (segs.length === 3) return { stage: segs[1] };
  return {};
}

/**
 * Parse one shard's text into blocks. Exported for tests: it is the whole format
 * contract in one function, testable from a string with no filesystem.
 */
export function parseAuditShard(
  text: string,
  shard: string,
  isStage?: IsStage,
  shardIndex = 0,
  skip?: ReadonlySet<number>,
): AuditEvent[] {
  const out: AuditEvent[] = [];
  const blocks = shardBlocks(text);
  for (let pos = 0; pos < blocks.length; pos++) {
    // A skipped copy keeps its neighbours' positions: `pos` is the block's index in
    // the file, never renumbered, as the engine's `parseAuditShardEvents` keeps it.
    if (skip?.has(pos)) continue;
    const block = blocks[pos] ?? "";
    // The engine's `auditBlockField`: an optional leading `- ` is stripped, and a
    // duplicated field keeps its FIRST value. Keeping the last one let a repeated
    // `**Fingerprint**:` line hold open a decision the engine had closed.
    const fields: Record<string, string> = {};
    for (const raw of block.split("\n")) {
      const m = FIELD_RE.exec(raw.startsWith("- ") ? raw.slice(2) : raw);
      if (m && !Object.hasOwn(fields, m[1]!)) fields[m[1]!] = (m[2] ?? "").trim();
    }
    const ts = fields.Timestamp;
    const event = fields.Event;
    // A block without both is not an event block (the file's `# AI-DLC Audit Log`
    // title, or a trailing fragment).
    if (!ts || !event) continue;

    // Sensors use `Stage slug`; everything else `Stage`. ARTIFACT_* has neither.
    let stage = fields.Stage || fields["Stage slug"] || undefined;
    // A DIRECT `Unit` field beats anything inferred from `Context`, and dropping it lost
    // a whole class of event. `audit-format.md` gives `UNIT_STARTED` / `UNIT_PAUSED` /
    // `UNIT_RESUMED` / `UNIT_COMPLETED` the fields `Timestamp, Stage, Unit, Run floor`
    // — no `Context` at all — and team gate rows carry `Unit` the same way. Reading only
    // `Context` therefore left `event.unit` undefined on exactly the events that say
    // which unit finished, which is also what the completion receipts are (see
    // scan/matrix.ts): the ledger was carrying the answer and this parser threw it away.
    let unit = fields.Unit || undefined;

    const ctx = fields.Context;
    if (ctx) {
      const resolved = parseContext(ctx, isStage);
      if (!unit) unit = resolved.unit;
      if (!stage) stage = resolved.stage;
    }

    out.push({ ts, event, stage, unit, fields, shard, pos, shardIndex });
  }
  return out;
}

/**
 * The block sequence of one shard. CRLF is normalised first so the `---` split and the
 * line regex both hold on a shard that travelled through a Windows clone.
 */
function shardBlocks(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n---\n");
}

/** The engine's `auditBlockField(block, name) !== null`: first line carrying the field. */
function hasField(block: string, name: string): boolean {
  const prefix = `**${name}**:`;
  return block
    .split("\n")
    .some((raw) => (raw.startsWith("- ") ? raw.slice(2) : raw).startsWith(prefix));
}

/** The engine's `AUDIT_SHARD_FILE_RE`: `<host>-<token>.md`, which a `"x 2.md"` copy is not. */
const AUDIT_SHARD_FILE_RE = /^[a-z0-9][a-z0-9-]*-[a-z0-9]{1,32}\.md$/;

/**
 * Per shard, the block positions that are copies of a better-ranked shard's blocks —
 * a transcription of the engine's `copiedAuditBlocks` (`tools/aidlc-lib.ts`, 2.11.0).
 *
 * Only shards whose FIRST block is identical and timestamped are compared, because a
 * copy starts with its source's header and first row; a row two independent clones
 * happen to write alike is therefore never taken for a copy. Within such a group a
 * timestamped block found byte-identical in two or more files is read once, from the
 * best of them: a file with a shard name, then the one with more timestamped blocks,
 * then filename order. Repeats inside one file are not copies and stay.
 *
 * The engine ranks "this clone's own shard" first. A reader has no clone of its own —
 * the same answer `aidlc-attest.ts` gives for a committed tree (`() => null`) — and the
 * kept row's text is identical either way; only which file lends it a name differs.
 */
export function copiedAuditBlocks(
  shards: readonly { shard: string; content: string }[],
): Set<number>[] {
  const skip = shards.map(() => new Set<number>());
  if (shards.length < 2) return skip;
  const groups = new Map<string, number[]>();
  shards.forEach(({ content }, index) => {
    const end = content.search(/\r?\n---\r?\n/);
    const head = (end < 0 ? content : content.slice(0, end)).replace(/\r\n/g, "\n");
    if (!hasField(head, "Timestamp")) return;
    const members = groups.get(head);
    if (members) members.push(index);
    else groups.set(head, [index]);
  });
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const blocks = members.map((index) =>
      shardBlocks(shards[index]!.content).map((block) =>
        hasField(block, "Timestamp") ? block : null,
      ),
    );
    const holders = new Map<string, Set<number>>();
    blocks.forEach((memberBlocks, member) => {
      for (const block of memberBlocks) {
        if (block === null) continue;
        const found = holders.get(block);
        if (found) found.add(member);
        else holders.set(block, new Set([member]));
      }
    });
    const counts = blocks.map((memberBlocks) => memberBlocks.filter((b) => b !== null).length);
    const isShardName = (member: number): boolean =>
      AUDIT_SHARD_FILE_RE.test(path.basename(shards[members[member]!]!.shard));
    const order = members
      .map((_, member) => member)
      .sort((a, b) => {
        if (isShardName(a) !== isShardName(b)) return isShardName(a) ? -1 : 1;
        if (counts[a] !== counts[b]) return counts[b]! - counts[a]!;
        return a - b;
      });
    const rank = new Map(order.map((member, position) => [member, position]));
    blocks.forEach((memberBlocks, member) => {
      memberBlocks.forEach((block, pos) => {
        const found = block === null ? undefined : holders.get(block);
        if (!found || found.size < 2) return;
        for (const holder of found) {
          if (rank.get(holder)! < rank.get(member)!) {
            skip[members[member]!]!.add(pos);
            return;
          }
        }
      });
    });
  }
  return skip;
}

/**
 * The components of `rel`, or `undefined` when it escapes its anchor — the engine's
 * `boundaryRelativePartsOrThrow`, which splits on BOTH slash families (`win32.parse`)
 * on every platform, so a POSIX name holding `\` is cut there as the engine cuts it.
 */
function boundaryParts(rel: string): string[] | undefined {
  if (path.win32.parse(rel).root !== "") return undefined;
  const parts: string[] = [];
  let cursor = rel;
  while (cursor !== "" && cursor !== ".") {
    const parsed = path.win32.parse(cursor);
    if (parsed.root !== "") return undefined;
    if (parsed.base !== "" && parsed.base !== ".") parts.unshift(parsed.base);
    if (parsed.dir === "" || parsed.dir === ".") break;
    if (parsed.dir === cursor) return undefined;
    cursor = parsed.dir;
  }
  return parts.includes("..") ? undefined : parts;
}

/**
 * Is the chain from `anchor` down `rel` clean — inside the anchor, and with no
 * component that exists as a symlink? `assertNoSymlinkInChainOrThrow`: a component
 * that does not exist redirects nothing.
 */
export function chainIsClean(anchor: string, rel: string): boolean {
  const parts = boundaryParts(rel);
  if (parts === undefined) return false;
  let current = anchor;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    } catch {}
  }
  return true;
}

/** Does anything — a dangling link included — sit at `p`? */
function present(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `.md` files of `recordDir/audit/`, sorted, unless the chain from `anchor` to that
 * dir is not clean, in which case the dir is refused whole (`auditShards`).
 */
function shardPaths(recordDir: string, anchor: string, refused: string[]): string[] {
  const dir = path.join(recordDir, "audit");
  const rel = path.relative(anchor, dir);
  if (!chainIsClean(anchor, rel)) {
    if (present(dir)) refused.push(rel);
    return [];
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(dir, f));
}

const NO_FOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

type ShardRead = { kind: "read"; content: string } | { kind: "refused" } | { kind: "failed" };

/**
 * One shard, read as `readAuditShardTexts` reads it: opened without following a link
 * (`lstat` covers a platform without `O_NOFOLLOW`), a regular file, the descriptor
 * still the file the pathname names (a replaced file is refused, not read through the
 * old descriptor), and — after the read — the chain from the RESOLVED anchor still
 * clean, so a directory swapped for a link after the listing does not lend its rows.
 * The chain is also checked before the open. `failed` for anything else — a vanished shard is skipped, as before.
 */
function readShard(p: string, anchor: string): ShardRead {
  // Checked first as well, so a name the chain refuses is named rather than lost to a
  // failure further on (Bun's `realpathSync` cuts a POSIX name at `\` too).
  if (!chainIsClean(anchor, path.relative(anchor, p))) return { kind: "refused" };
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | NO_FOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ELOOP" ? { kind: "refused" } : { kind: "failed" };
  }
  let content: string;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || fs.lstatSync(p).isSymbolicLink()) return { kind: "refused" };
    const current = fs.statSync(fs.realpathSync(p));
    if (current.dev !== st.dev || current.ino !== st.ino) return { kind: "refused" };
    content = fs.readFileSync(fd, "utf-8");
  } catch {
    return { kind: "failed" };
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (!chainIsClean(fs.realpathSync(anchor), path.relative(anchor, p)))
      return { kind: "refused" };
  } catch {
    return { kind: "failed" };
  }
  return { kind: "read", content };
}

/**
 * Read every shard under `recordDir/audit/` and return the merged, time-ordered
 * ledger. Pass `isStage` (from the workspace's stage catalogue) so Context-only
 * events attribute to the right stage; without it attribution falls back to
 * positional guessing. `anchor` is the workspace root the symlink chain is checked
 * from (see the header); without one it is checked from `recordDir` down. An
 * unreadable shard is skipped, a refused one listed. Never throws; an absent audit
 * dir yields an empty ledger.
 */
export function readAuditLedger(
  recordDir: string,
  isStage?: IsStage,
  anchor: string = recordDir,
): AuditLedger {
  const events: AuditEvent[] = [];
  const read: { shard: string; content: string }[] = [];
  const refused: string[] = [];

  for (const p of shardPaths(recordDir, anchor, refused)) {
    const r = readShard(p, anchor);
    if (r.kind === "refused") refused.push(path.relative(anchor, p));
    else if (r.kind === "read") read.push({ shard: path.basename(p), content: r.content });
  }
  const copied = copiedAuditBlocks(read);
  read.forEach(({ shard, content }, index) => {
    // A loop, not `push(...)`: spreading a large shard's events overflows the stack.
    for (const e of parseAuditShard(content, shard, isStage, index, copied[index])) events.push(e);
  });
  const shards = read.map((r) => r.shard);

  // ISO second-precision UTC strings sort lexicographically == chronologically.
  // Ties keep insertion order (shard-sorted), which is stable in V8's sort.
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.event, (counts.get(e.event) ?? 0) + 1);

  return {
    events,
    counts,
    shards,
    refused,
    firstTs: events.length > 0 ? events[0]?.ts : undefined,
    lastTs: events.length > 0 ? events[events.length - 1]?.ts : undefined,
  };
}
