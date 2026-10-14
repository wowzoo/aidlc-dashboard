// The claim-attempt readers (scan/claim-attempt.ts) transcribe the engine's
// `readUnitScopeStamp`, `readClaimGenerations`, `activeIntentUuid` and
// `eventMatchesClaimAttempt`. Each expectation below is what the 2.11.0 functions return
// for the same input, checked by extraction on 2026-10-14.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  activeIntentUuid,
  claimFilter,
  parseClaimGenerations,
  parseScopeStamp,
  readClaimInputs,
  unitGateRhythm,
} from "../scan/claim-attempt";

const STAMP = {
  version: 1,
  space: "default",
  intent_uuid: "019fa168-8d45-7aef-a383-000000000001",
  intent_id8: "00000001",
  unit: "PU-A-core",
  owner: "someone",
  generation: 2,
  nonce: "n",
  claim_ref: "refs/heads/claim/00000001/PU-A-core",
  claim_oid: "0",
  claimed_from_oid: "0",
  integration_ref: "refs/heads/main",
  gate_rhythm: "unit-end",
};

describe("claim-attempt readers", () => {
  test("a scope stamp is read field for field, anything else is no stamp", () => {
    expect(parseScopeStamp(JSON.stringify(STAMP))).toEqual({
      space: "default",
      intent_uuid: STAMP.intent_uuid,
      unit: "PU-A-core",
      generation: 2,
      gate_rhythm: "unit-end",
    });
    for (const bad of [
      { ...STAMP, version: 2 },
      { ...STAMP, generation: 0 },
      { ...STAMP, generation: 1.5 },
      { ...STAMP, gate_rhythm: "weekly" },
      { ...STAMP, nonce: undefined },
      { ...STAMP, audit_shard: "../x.md" },
    ]) {
      expect(parseScopeStamp(JSON.stringify(bad))).toBeNull();
    }
    expect(parseScopeStamp(JSON.stringify({ ...STAMP, audit_shard: "host-1.md" }))).not.toBeNull();
    expect(parseScopeStamp("{}")).toBeNull();
    expect(parseScopeStamp("not json")).toBeNull();
  });

  test("claim generations keep positive integers only; a malformed file is none", () => {
    expect(parseClaimGenerations('{"a":1,"b":0,"c":-2,"d":1.5,"e":"3","f":4}')).toEqual({
      a: 1,
      f: 4,
    });
    expect(parseClaimGenerations("[5,0]")).toEqual({ "0": 5 });
    expect(parseClaimGenerations("null")).toEqual({});
    expect(parseClaimGenerations("{")).toEqual({});
  });

  test("the active intent's uuid follows listIntents, throws included", () => {
    const dirs = ["260101-demo", "demo-1a2b3c4d"];
    const row = { slug: "demo", dirName: "260101-demo", uuid: "u-new" };
    expect(activeIntentUuid([row], dirs, "260101-demo")).toEqual({ ok: true, value: "u-new" });
    // The legacy `<slug>-<hex>` join reads the uuid's own hex tail.
    const legacy = { slug: "demo", uuid: "0000-0000-1a2b-3c4d" };
    expect(activeIntentUuid([legacy], dirs, "demo-1a2b3c4d")).toEqual({
      ok: true,
      value: "0000-0000-1a2b-3c4d",
    });
    // An orphan record has an empty uuid, which is no uuid; so is a first row with none.
    expect(activeIntentUuid([], dirs, "260101-demo")).toEqual({ ok: true, value: null });
    expect(
      activeIntentUuid(
        [
          { ...row, uuid: "" },
          { ...row, uuid: "later" },
        ],
        dirs,
        "260101-demo",
      ),
    ).toEqual({ ok: true, value: null });
    // A `null` row, or a non-string uuid against a hex-suffixed record, throws in the engine.
    expect(activeIntentUuid([row, null], dirs, "260101-demo")).toEqual({ ok: false });
    expect(activeIntentUuid([{ slug: "demo", uuid: 7 }], dirs, "260101-demo")).toEqual({
      ok: false,
    });
  });

  test("a stamp applies only to its own space and intent, and gives the gate scope", () => {
    const base = {
      team: true,
      generations: {},
      space: "default",
      uuid: () => ({ ok: true as const, value: STAMP.intent_uuid }),
    };
    const stamp = parseScopeStamp(JSON.stringify(STAMP));
    const own = { ...base, stamp };
    const filter = claimFilter(own);
    expect(filter({ Unit: "PU-A-core", "Attempt Generation": "2" }, "PU-A-core")).toBe(true);
    expect(filter({ Unit: "PU-A-core" }, "PU-A-core")).toBe(false);
    expect(filter({ Unit: "PU-B-ui", "Attempt Generation": "2" }, "PU-B-ui")).toBe(false);
    expect(unitGateRhythm(own, "- **Unit Gate Rhythm**: per-stage\n")).toBe("unit-end");
    // Another intent's stamp is no stamp: rows pass, the state's rhythm decides.
    const other = { ...base, stamp: stamp && { ...stamp, intent_uuid: "elsewhere" } };
    expect(claimFilter(other)({ Unit: "PU-B-ui" }, "PU-B-ui")).toBe(true);
    expect(unitGateRhythm(other, "- **Unit Gate Rhythm**: unit-end\n")).toBe("unit-end");
    expect(unitGateRhythm(other, "")).toBe("per-stage");
    // Outside team ownership the rhythm is per-stage whatever the state says.
    expect(unitGateRhythm({ ...other, team: false }, "- **Unit Gate Rhythm**: unit-end\n")).toBe(
      "per-stage",
    );
  });

  test("the checkout's files are read in place, and the registry only when reached", () => {
    const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-claim-"));
    try {
      fs.cpSync(FIXTURE, root, { recursive: true });
      const team = "- **Unit Ownership**: team\n";
      fs.writeFileSync(
        path.join(root, "aidlc", ".aidlc-claim-generations.json"),
        JSON.stringify({ [`default/${STAMP.intent_uuid}/PU-B-ui`]: 3 }),
      );
      const filter = claimFilter(readClaimInputs(root, team));
      expect(filter({ "Attempt Generation": "3" }, "PU-B-ui")).toBe(true);
      expect(filter({ "Attempt Generation": "2" }, "PU-B-ui")).toBe(false);
      // A registry the engine would throw on matters only where the filter needs it.
      const registry = path.join(root, "aidlc/spaces/default/intents/intents.json");
      fs.writeFileSync(registry, "[null]");
      const broken = claimFilter(readClaimInputs(root, team));
      expect(broken({}, "PU-B-ui")).toBe(true);
      expect(broken({ "Attempt Generation": "3" }, "PU-B-ui")).toBe("unknown");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the active intent is the engine's: the raw cursor, and a lone record it can read", () => {
    // Codex review, each reproduced against the 2.11.0 functions on a fixture copy.
    const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "reference");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aidlc-claim-"));
    const intents = path.join(root, "aidlc/spaces/default/intents");
    const team = "- **Unit Ownership**: team\n";
    try {
      fs.cpSync(FIXTURE, root, { recursive: true });
      fs.writeFileSync(
        path.join(root, "aidlc", ".aidlc-unit-scope.json"),
        JSON.stringify({ ...STAMP, unit: "PU-B-ui" }),
      );
      // A `./<dir>` cursor names the same state, but `activeIntentUuid` compares it with
      // the dir name exactly and finds no uuid: the stamp does not apply.
      fs.writeFileSync(path.join(intents, "active-intent"), "./260101-demo-migration\n");
      const dotted = claimFilter(readClaimInputs(root, team));
      expect(dotted({ Unit: "PU-A-core" }, "PU-A-core")).toBe(true);
      // With no cursor, a lone record whose registry row has no string status makes the
      // engine's `activeIntent` throw: no engine verdict, so none is claimed.
      fs.rmSync(path.join(intents, "active-intent"));
      const registry = JSON.parse(fs.readFileSync(path.join(intents, "intents.json"), "utf-8"));
      registry[0].status = undefined; // JSON drops the key: a row with no status
      fs.writeFileSync(path.join(intents, "intents.json"), JSON.stringify(registry));
      expect(claimFilter(readClaimInputs(root, team))({}, "PU-A-core")).toBe("unknown");
      expect(claimFilter(readClaimInputs(root, ""))({}, "PU-A-core")).toBe(true);
      // A uuid the generation key cannot stringify is unknown, never a thrown page.
      fs.rmSync(path.join(root, "aidlc", ".aidlc-unit-scope.json"));
      registry[0].status = "in-flight";
      registry[0].uuid = { toString: null };
      fs.writeFileSync(path.join(intents, "intents.json"), JSON.stringify(registry));
      const odd = claimFilter(readClaimInputs(root, team));
      expect(odd({ "Attempt Generation": "1" }, "PU-A-core")).toBe("unknown");
      expect(odd({}, "PU-A-core")).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
