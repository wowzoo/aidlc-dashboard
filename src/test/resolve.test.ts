// Which intent the dashboard resolves (scan/resolve.ts) — the engine's `activeSpace` /
// `activeIntent` (2.11 aidlc-lib.ts, aidlc-runtime-paths.ts) transcribed. Each case is
// a tree the engine resolves one way and this reader used to resolve another.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NoRunError, assemble, noRunText } from "../model/assemble";
import { strings } from "../render/i18n";
import { recordDirMatches, resolveState } from "../scan/resolve";
import { readWorkspaceSummary } from "../scan/summary";

/** A workspace with the given intents; `cursor` is the active-intent pointer's text. */
function workspace(opts: {
  space?: string;
  spaceCursor?: string;
  records: string[];
  registry?: unknown[];
  cursor?: string;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-res-"));
  const space = opts.space ?? "default";
  const intents = path.join(root, "aidlc", "spaces", space, "intents");
  fs.mkdirSync(intents, { recursive: true });
  for (const r of opts.records) {
    fs.mkdirSync(path.join(intents, r), { recursive: true });
    fs.writeFileSync(path.join(intents, r, "aidlc-state.md"), "# state\n");
  }
  if (opts.registry)
    fs.writeFileSync(path.join(intents, "intents.json"), JSON.stringify(opts.registry));
  if (opts.cursor !== undefined) fs.writeFileSync(path.join(intents, "active-intent"), opts.cursor);
  if (opts.spaceCursor !== undefined)
    fs.writeFileSync(path.join(root, "aidlc", "active-space"), opts.spaceCursor);
  return root;
}
const rel = (record: string, space = "default") =>
  `aidlc/spaces/${space}/intents/${record}/aidlc-state.md`;
const row = (dirName: string, status: string, slug = dirName) => ({
  uuid: "0".repeat(32),
  slug,
  dirName,
  status,
});

describe("archived intents never resolve implicitly", () => {
  test("a lone record that was archived is not the active intent", () => {
    // Before: the archived record came back as the run on screen.
    const root = workspace({ records: ["260101-old"], registry: [row("260101-old", "archived")] });
    expect(resolveState(root)).toEqual({ kind: "archived", count: 1 });
  });

  test("archived records do not make the live one ambiguous", () => {
    const root = workspace({
      records: ["260101-old", "260201-new"],
      registry: [row("260101-old", "Archived "), row("260201-new", "in-flight")],
    });
    expect(resolveState(root)).toEqual({ kind: "ok", rel: rel("260201-new") });
  });

  test("an unregistered record has no status, so it stays live work", () => {
    const root = workspace({
      records: ["260101-old", "260201-orphan"],
      registry: [row("260101-old", "archived")],
    });
    expect(resolveState(root)).toEqual({ kind: "ok", rel: rel("260201-orphan") });
  });

  test("a cursor naming an archived record still resolves it — the engine explains, not guesses", () => {
    const root = workspace({
      records: ["260101-old"],
      registry: [row("260101-old", "archived")],
      cursor: "260101-old\n",
    });
    expect(resolveState(root)).toEqual({ kind: "ok", rel: rel("260101-old") });
  });
});

describe("registry rows join to dirs the engine's way", () => {
  test("a stored dirName matches exactly", () => {
    expect(recordDirMatches({ slug: "x", uuid: "", dirName: "260101-x" }, "260101-x")).toBe(true);
    expect(recordDirMatches({ slug: "x", uuid: "", dirName: "260101-x" }, "260101-y")).toBe(false);
  });

  test("a pre-date-prefix row falls back to `<slug>-<id8>` against the uuid's tail", () => {
    const uuid = "019fa168-8d45-7aef-a383-0000abcd1234";
    expect(recordDirMatches({ slug: "demo", uuid }, "demo-abcd1234")).toBe(true);
    expect(recordDirMatches({ slug: "demo", uuid }, "demo-1234")).toBe(true);
    expect(recordDirMatches({ slug: "demo", uuid }, "demo-ffff1234")).toBe(false);
    expect(recordDirMatches({ slug: "demo", uuid }, "demo-notahex")).toBe(false);
  });

  test("a legacy row archives its record too", () => {
    const uuid = "019fa168-8d45-7aef-a383-0000abcd1234";
    const root = workspace({
      records: ["demo-abcd1234", "260201-new"],
      registry: [{ uuid, slug: "demo", status: "archived" }, row("260201-new", "in-flight")],
    });
    expect(resolveState(root)).toEqual({ kind: "ok", rel: rel("260201-new") });
  });
});

describe("the space cursor is validated as the engine validates it", () => {
  test("a name outside the space grammar, or a space with no dir, reads as default", () => {
    for (const cursor of ["Bad_Name", "../escape", "missing-space", ""]) {
      const root = workspace({ records: ["260101-a"], spaceCursor: cursor });
      expect(resolveState(root)).toEqual({ kind: "ok", rel: rel("260101-a") });
    }
  });

  test("a valid cursor naming a real space is followed", () => {
    const root = workspace({ space: "team-b", records: ["260101-b"], spaceCursor: "team-b\n" });
    expect(resolveState(root)).toEqual({ kind: "ok", rel: rel("260101-b", "team-b") });
  });
});

// ── End to end: what each reader shows for an archived-only space ─────────────────

describe("archived-only, on every surface", () => {
  const root = workspace({ records: ["260101-old"], registry: [row("260101-old", "archived")] });

  test("the run cannot be assembled, and the sentence says only archived intents are left", () => {
    let err: unknown;
    try {
      assemble(root);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NoRunError);
    expect((err as NoRunError).kind).toBe("archived");
    // The server re-says it in the reader's language through the same function.
    expect(noRunText(strings("en").cli, "archived", root)).toContain("Only archived intents");
  });

  test("the picker card carries the reason, not a blank 'no run'", () => {
    expect(readWorkspaceSummary(root)).toEqual({ kind: "no-run", reason: "archived", archived: 1 });
    expect(strings("ko").picker.summaryNoRunArchived("1")).toContain("1개");
  });
});

describe("identity joins a legacy registry row", () => {
  test("a row with no dirName names the record through `<slug>-<id8>`", () => {
    const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-res-fx-"));
    fs.cpSync(FIXTURE, root, { recursive: true });
    const intents = path.join(root, "aidlc", "spaces", "default", "intents");
    const uuid = "019fa168-8d45-7aef-a383-0000abcd1234";
    fs.renameSync(
      path.join(intents, "260101-demo-migration"),
      path.join(intents, "demo-migration-abcd1234"),
    );
    fs.writeFileSync(path.join(intents, "active-intent"), "demo-migration-abcd1234");
    fs.writeFileSync(
      path.join(intents, "intents.json"),
      JSON.stringify([
        { uuid, slug: "demo-migration", scope: "demo-migration", status: "in-flight" },
      ]),
    );
    const m = assemble(root);
    expect(m.identity.slug).toBe("demo-migration");
    expect(m.identity.status).toBe("in-flight");
  });
});

describe("the state's Plan is said beside the scope", () => {
  test("present only when written", async () => {
    const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-res-plan-"));
    fs.cpSync(FIXTURE, root, { recursive: true });
    const statePath = path.join(
      root,
      "aidlc/spaces/default/intents/260101-demo-migration/aidlc-state.md",
    );
    const { renderBody } = await import("../render/page");
    expect(renderBody(assemble(root), "ko")).not.toContain("계획: ");
    fs.writeFileSync(
      statePath,
      fs
        .readFileSync(statePath, "utf-8")
        .replace(
          "- **Scope**: demo-migration",
          "- **Scope**: demo-migration\n- **Plan**: tailored plan",
        ),
    );
    expect(renderBody(assemble(root), "ko")).toContain("계획: tailored plan");
  });
});

describe("second-review regressions — malformed registry rows", () => {
  test("a wrong-typed uuid cannot throw from resolution", () => {
    // Before: `uuid.replace` on a number threw out of resolveState (a 500 page).
    for (const record of ["demo-abcd1234", "demo-other"]) {
      const root = workspace({
        records: [record],
        registry: [{ slug: "demo", uuid: 42, status: "archived" }],
      });
      expect(resolveState(root)).toEqual({ kind: "ok", rel: rel(record) });
    }
  });

  test("identity cannot read a malformed dirName as absent when the resolver did not", () => {
    const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-res-bad-"));
    fs.cpSync(FIXTURE, root, { recursive: true });
    const intents = path.join(root, "aidlc", "spaces", "default", "intents");
    fs.renameSync(
      path.join(intents, "260101-demo-migration"),
      path.join(intents, "demo-migration-abcd1234"),
    );
    fs.writeFileSync(path.join(intents, "active-intent"), "demo-migration-abcd1234");
    fs.writeFileSync(
      path.join(intents, "intents.json"),
      JSON.stringify([
        {
          slug: "demo-migration",
          uuid: "019fa168-8d45-7aef-a383-0000abcd1234",
          dirName: 42,
          status: "archived",
        },
      ]),
    );
    expect(resolveState(root).kind).toBe("ok");
    expect(assemble(root).identity.status).toBeUndefined();
  });
});
