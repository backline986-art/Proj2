// THE FIRE READER READS THE WORDS REAL PLAN SETS USE (2026-11-23).
//
// Measured on 269 of the operator's own plan sets (read on his computer; only counts and wording
// shapes left it): 155 label the roof plan "36\" FIRE SETBACK" — a legend that names no roof line —
// and the reader read none of them, so most jobs fell to "not measured". In about one set in six the
// framing callout "2\" X 8\" RIDGE BEAM" read as an 8 in ridge setback and warned. Fixtures here are
// SYNTHETIC strings in those shapes: no names, addresses or real plan text.
//
//   THE READER   — "FIRE SETBACK" (and the split forms text extraction makes of it) is read as an
//                  unqualified fire setback; "... FIRE SETBACK FROM RIDGE" stays a ridge setback; a
//                  ridge beam / board, a lumber size, attachment spacing and a legend's "=" are not
//                  roof-plan dimensions.
//   THE RULE     — an unqualified fire setback answers a requirement only where the plan states none
//                  of that kind: the LARGEST is the pathway; a ridge setback is met only when every one
//                  meets it, short only when even the largest is short, otherwise "not said". It never
//                  blocks, even against a human-verified AHJ rule.
//
// Run: npx tsx backend/test/firePlanWording.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-plan-wording-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { buildCodeContext } = await import("../src/codeProfiles");
const { evaluateDesignCodeFindings } = await import("../src/codeReviewRules");
const { readRoofPlanDimensions, resolveRoofPlanReadings } = await import("../src/designCriteria");

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const BELOW = "city.fire.pathway-below-required";
const UNMEASURED = "city.fire.pathway-unmeasured";
const AHJ_RULE = "Minimum 36-inch fire access pathways on each roof plane; arrays shall be set back three (3) feet from the ridge.";

const project = (snapshot: Record<string, unknown> = {}): ProjectRecord => ({
  id: "fire-plan-wording-test", state: "OR", ahj: "City of Testport", utility: "Test Power",
  homeownerName: "Test Owner", projectAddress: "1 Test St", interconnectionMethod: "Load-side breaker",
  parserSnapshot: { mounting: "Roof mount", ...snapshot },
} as unknown as ProjectRecord);
const profile = (over: Partial<JurisdictionCodeProfile>): JurisdictionCodeProfile => ({
  key: "or|city of testport|unknown", state: "OR", ahj: "City of Testport", confidence: "seeded",
  adoptedCodes: [{ code: "IRC", edition: "2021" }, { code: "NEC", edition: "2023" }],
  amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  ...over,
});
const modelCode = () => buildCodeContext("OR", "City of Testport", profile({}));
const verifiedRule = () => buildCodeContext("OR", "City of Testport", profile({
  confidence: "verified", verifiedBy: "operator", fireSetbacks: [{ id: "fire-1", description: AHJ_RULE }],
}));
const run = (ctx: ReturnType<typeof modelCode>, text: string): ReviewerFinding[] =>
  evaluateDesignCodeFindings(project(), null, ctx, [], [{ label: "Plan set", text }]);
const get = (fs: ReviewerFinding[], id: string) => fs.find((f) => f.id === id);
const read = (t: string) => readRoofPlanDimensions(t).map((d) => `${d.kind}=${d.inches}`);

console.log("\n1. THE READER — the operator's plan-set wording");
await check("MUST PASS: a roof-plan legend's \"FIRE SETBACK\" reads, in its common shapes", () => {
  assert.deepEqual(read('36" FIRE SETBACK'), ["fireSetback=36"]);
  assert.deepEqual(read("3' FIRE SETBACK (TYP.)"), ["fireSetback=36"]);
  assert.deepEqual(read('36" FIRE CLEARANCE'), ["fireSetback=36"]);
  assert.deepEqual(read("FIRE CODE SETBACK 3'"), ["fireSetback=36"]);
});
await check("MUST PASS: the split forms text extraction makes of the word", () => {
  assert.deepEqual(read('36" FIRE SETBAC'), ["fireSetback=36"]);
  assert.deepEqual(read('12" FIRE SETB K MODULE WEIGHT 48 LBS'), ["fireSetback=12"]);
  assert.deepEqual(read('36" FIR SETBACK'), ["fireSetback=36"]);
});
await check("MUST PASS: a fire setback that names its roof line is that line's", () => {
  assert.deepEqual(read('18" FIRE SETBACK FROM RIDGE'), ["ridgeSetback=18"]);
  assert.deepEqual(read('FIRE SETBACK 36" FROM RIDGE'), ["ridgeSetback=36"]);
  assert.deepEqual(read('18" FIRE SETBACK FROM HIPS AND VALLEYS'), []);
});
await check("MUST PASS: a legend with both sizes reads both", () => {
  assert.deepEqual(read('36" FIRE SETBACK 12" FIRE SETBACK'), ["fireSetback=36", "fireSetback=12"]);
});
await check("MUST EXCLUDE: a ridge beam, a lumber size, attachment spacing, a legend's \"=\"", () => {
  assert.deepEqual(read('2" X 8" RIDGE BEAM'), []);
  assert.deepEqual(read('TRUSS SIZE 2" X 6" RIDGE BOARD'), []);
  assert.deepEqual(read("FIRE PATHWAY ROOF ATTACHMENTS SHALL BE SPACED NO GREATER THAN 48 IN."), []);
  assert.deepEqual(read('12" ROOF OVERHANG = FIRE PATHWAY'), []);
});
await check("MUST PASS: what already read still reads", () => {
  assert.deepEqual(read('36" FIRE ACCESS PATHWAY'), ["pathwayWidth=36"]);
  assert.deepEqual(read('18" SETBACK FROM RIDGE'), ["ridgeSetback=18"]);
  assert.deepEqual(read("3' RIDGE CLEARANCE"), ["ridgeSetback=36"]);
});

console.log("\n2. THE RULE — how an unqualified fire setback counts");
const stated = (...ins: Array<[string, number]>) => ins.map(([kind, inches]) => ({ kind: kind as "fireSetback", inches, source: "Plan set", excerpt: `${inches}" FIRE SETBACK`, derived: false }));
const req = (kind: "pathwayWidth" | "ridgeSetback", inches: number) => ({ kind, inches, basis: "model_code" as const, verified: false, source: "test" });
await check("MUST PASS: the largest is the pathway; a ridge setback needs every one to meet it", () => {
  const s = stated(["fireSetback", 36], ["fireSetback", 12]);
  assert.equal(resolveRoofPlanReadings(req("pathwayWidth", 36), s).met.length, 1);
  const ridge = resolveRoofPlanReadings(req("ridgeSetback", 18), s);
  assert.equal(ridge.met.length + ridge.below.length, 0);
  assert.match(ridge.unresolved, /36 in and 12 in "FIRE SETBACK" without naming the roof line/);
  assert.equal(resolveRoofPlanReadings(req("ridgeSetback", 12), s).met.length, 2);
});
await check("MUST PASS: a reading of the requirement's own kind wins over an unqualified one", () => {
  const s = [...stated(["fireSetback", 36]), { kind: "ridgeSetback" as const, inches: 12, source: "Plan set", excerpt: '12" FROM RIDGE', derived: false }];
  assert.equal(resolveRoofPlanReadings(req("ridgeSetback", 18), s as never).below.length, 1);
});

console.log("\n3. THE GATE — measured now, never a blocker on an unqualified label");
await check("MUST PASS: \"36\\\" FIRE SETBACK\" alone meets the model code's 36 in pathway and ridge — no finding", () => {
  const fs = run(modelCode(), 'ROOF PLAN 36" FIRE SETBACK (TYP.)');
  assert.equal(get(fs, BELOW), undefined, get(fs, BELOW)?.message);
  assert.equal(get(fs, UNMEASURED), undefined, "it was measured");
});
await check("MUST PASS: a 36 in + 12 in legend meets the pathway; the ridge stays not checked, saying why", () => {
  const fs = run(modelCode(), 'LEGEND 36" FIRE SETBACK 12" FIRE SETBACK');
  assert.equal(get(fs, BELOW), undefined, get(fs, BELOW)?.message);
  assert.equal(get(fs, UNMEASURED), undefined);
  assert.match(JSON.stringify(fs), /without naming the roof line/);
});
await check("MUST PASS: only a 12 in fire setback, against a VERIFIED 36 in AHJ rule — a WARNING, never a blocker", () => {
  const f = get(run(verifiedRule(), 'LEGEND 12" FIRE SETBACK'), BELOW);
  assert.ok(f, "a 12 in fire setback against a 36 in rule is short whichever it is");
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /names no roof line/);
});
await check("MUST PASS: a ridge-qualified short setback against the verified rule still BLOCKS (unchanged)", () => {
  assert.equal(get(run(verifiedRule(), '36" FIRE SETBACK. 12" SETBACK FROM RIDGE.'), BELOW)?.severity, "blocker");
});
await check("MUST PASS: a ridge beam no longer warns as a short ridge setback", () => {
  const fs = run(modelCode(), '36" FIRE ACCESS PATHWAY. 2" X 8" RIDGE BEAM.');
  assert.equal(get(fs, BELOW), undefined, get(fs, BELOW)?.message);
});

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
