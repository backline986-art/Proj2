// BALLASTED RACKING IS FOUND RELIABLY, AND THE PERMIT PATH ROUTES ON IT FROM CITED DATA.
//
// The owner, 2026-11-20: the last projects had a ballasted system, and the city treats that as a
// non-prescriptive project; find those better and make sure it is accurate. Two gaps:
//   1. the reading needed the word "ballast": a plan set that names only the product ("UNIRAC RM10
//      EVO", "ECOFOOT2+") was read as attached, and every mention of ballast counted, even a
//      conditional note or the ROOFING's gravel ballast;
//   2. the permit-path screen never read the racking, so a ballasted job with clean numbers routed
//      PRESCRIPTIVE; only the reviewer's later refusal caught it, after the wrong application was built.
// This pins, on synthetic jobs only (no network, no portal):
//   - readBallastedRacking: ballasted / unclear / none, with the evidence quoted and, when unclear,
//     what points the other way; a ballasted product named in the data file counts without the word;
//   - resolvePermitPath: a ballasted roof job where the record carries a cited ballast rule routes
//     ENGINEERED, quoting the rule (and a city's own words where its AHJ matches a local reading); an
//     unclear one is UNKNOWN (a person confirms), never a guess; no rule on file changes nothing;
//   - the record's rule is dropped at load without a verbatim quote, a source and an https URL;
//   - the reviewer raises city.struct.ballast-unclear (warning) for an unclear package.
//   npx tsx backend/test/ballastedRacking.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord } from "../../shared/src/types";

const { readBallastedRacking, ballastedProductNamed, roofRisePer12, ballastedRackingEvidence } = await import("../src/ballastRacking");
const { resolvePermitPath } = await import("../src/permitPath");
const { shippedPermitPathRecords } = await import("../src/jurisdictionPermitPaths");
const { buildReviewerReport } = await import("../src/reviewerEngine");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// A clean Oregon-shaped roof job: every number inside the record's limits and no roofing named (a
// membrane is already off that path by the roofing row), so only the racking decides.
const job = (snapshot: Record<string, unknown>, extra: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: "ballast-probe", clientId: "c", homeownerName: "Ballast Probe", projectAddress: "1 Test Lane",
  city: "Testville", state: "OR", zip: "97000", ahj: "City of Testville",
  utility: "Test Power", accountNumber: "", meterNumber: "",
  systemSizeDcKw: 8, systemSizeAcKw: 6, interconnectionMethod: "Load-side breaker", status: "pending",
  parserSnapshot: {
    state: "OR", mounting: "Roof mount", roofMaterial: "",
    snow: "25", deadLoad: "3", wind: "B", roofRafterSpacing: "24", framingType: "truss",
    pvMicroMake: "TestMicro", pvMicroModel: "TM-1",
    ...snapshot,
  },
  ...extra,
} as unknown as ProjectRecord);

// ---- the reading ------------------------------------------------------------------------------------
check("a ballasted product named without the word 'ballast' is ballasted (data file)", () => {
  assert.match(ballastedProductNamed("RACKING: UNIRAC RM10 EVO, 10 DEG TILT"), /Unirac/);
  assert.match(ballastedProductNamed("ECOFOOT2+ BASE"), /EcoFoot/);
  assert.equal(ballastedProductNamed("IRONRIDGE XR100 RAIL"), "");
  const r = readBallastedRacking(job({ rackingSystem: "Unirac RM10 EVO" }));
  assert.equal(r.verdict, "ballasted");
  assert.match(r.evidence, /rackingSystem: Unirac RM10 EVO \(Unirac .*: a ballasted system\)/);
  const t = readBallastedRacking(job({ planSetExtractedText: "SHEET S-1. MODULES ON IRONRIDGE BX CHASSIS." }));
  assert.equal(t.verdict, "ballasted");
  assert.match(t.evidence, /^Plan set: "MODULES ON IRONRIDGE BX CHASSIS"/);
});

check("the word in a field, or a clear plan-text clause on a flat roof, is ballasted", () => {
  assert.equal(readBallastedRacking(job({ mounting: "Roof - ballasted, low-slope" })).verdict, "ballasted");
  assert.equal(readBallastedRacking(job({ planSetExtractedText: "ARRAY ON BALLASTED RACKING WITH CONCRETE BLOCKS." })).verdict, "ballasted");
  assert.equal(readBallastedRacking(job({ planSetExtractedText: "4 BALLAST BLOCKS PER BAY." })).verdict, "ballasted", "plural / 'ballast blocks'");
  assert.equal(readBallastedRacking(job({ attachmentHardware: "Non-penetrating base" })).verdict, "ballasted");
});

check("a denial is never evidence", () => {
  assert.equal(readBallastedRacking(job({ planSetExtractedText: "NON-BALLASTED SYSTEM. ALL ATTACHMENTS LAGGED TO RAFTERS." })).verdict, "none");
  assert.equal(readBallastedRacking(job({ rackingSystem: "Rail system, no ballast" })).verdict, "none");
  assert.equal(readBallastedRacking(job({})).verdict, "none");
});

check("plan-text ballast against an attachment to the framing, a shingle roof or a pitched slope is UNCLEAR, saying why", () => {
  const text = { planSetExtractedText: "ARRAY ON BALLASTED RACKING WITH CONCRETE BLOCKS." };
  const attached = readBallastedRacking(job({ ...text, attachmentHardware: "FlashFoot2 lag to rafter" }));
  assert.equal(attached.verdict, "unclear");
  assert.match(attached.doubt, /attachmentHardware: FlashFoot2/);
  const yesRow = readBallastedRacking(job({ ...text, attachmentToFraming: "yes" }));
  assert.match(yesRow.doubt, /attachment-to-framing row Yes/);
  const shingle = readBallastedRacking(job({ ...text, roofMaterial: "Composition Shingle" }));
  assert.equal(shingle.verdict, "unclear");
  assert.match(shingle.doubt, /Composition Shingle, a pitched-roof covering/);
  const pitched = readBallastedRacking(job({ ...text, roofSlope: "6:12" }));
  assert.equal(pitched.verdict, "unclear");
  assert.match(pitched.doubt, /6:12/);
  // A low-slope statement is no contradiction.
  assert.equal(readBallastedRacking(job({ ...text, roofSlope: "1/4:12" })).verdict, "ballasted");
});

check("a FIELD that says ballasted stands, unless the stated slope is a pitched roof", () => {
  assert.equal(readBallastedRacking(job({ rackingSystem: "IronRidge BX", roofMaterial: "Composition Shingle" })).verdict, "ballasted");
  assert.equal(readBallastedRacking(job({ rackingSystem: "IronRidge BX", roofSlope: "25 deg" })).verdict, "unclear");
});

check("a conditional note or the ROOFING's ballast alone is UNCLEAR, never ballasted", () => {
  const cond = readBallastedRacking(job({ planSetExtractedText: "IF BALLASTED, PROVIDE BALLAST LAYOUT FROM MANUFACTURER." }));
  assert.equal(cond.verdict, "unclear");
  assert.match(cond.doubt, /conditional/);
  const roofing = readBallastedRacking(job({ planSetExtractedText: "EXISTING GRAVEL BALLAST OVER EPDM ROOF TO REMAIN." }));
  assert.equal(roofing.verdict, "unclear");
  assert.match(roofing.doubt, /ROOFING/);
  assert.equal(ballastedRackingEvidence(job({ planSetExtractedText: "IF BALLASTED, PROVIDE BALLAST LAYOUT." })), "", "the strict evidence helper stays strict");
  // A clear clause elsewhere in the set settles it.
  assert.equal(readBallastedRacking(job({ planSetExtractedText: "IF BALLASTED, SEE S-2. ARRAY ON UNIRAC RM5 RACKING." })).verdict, "ballasted");
});

check("roof slope: ratio, fraction and degrees", () => {
  assert.equal(roofRisePer12("4:12"), 4);
  assert.equal(roofRisePer12("4/12"), 4);
  assert.equal(roofRisePer12("1/4:12"), 0.25);
  assert.ok(Math.abs((roofRisePer12("18.43°") ?? 0) - 4) < 0.01);
  assert.equal(roofRisePer12("flat"), null);
  assert.equal(roofRisePer12(""), null);
});

// ---- the permit path ---------------------------------------------------------------------------------
check("the shipped record carries a cited ballast rule (quote, source, https URL) and a city's own reading", () => {
  const or = shippedPermitPathRecords().find((r) => r.state === "OR" && !r.ahj);
  assert.ok(or?.ballastedRacking, "OR record carries the rule");
  assert.match(or!.ballastedRacking!.quote, /Direct attachment to the roof framing or blocking/);
  assert.ok(or!.ballastedRacking!.sourceUrl.startsWith("https://"));
  const local = or!.ballastedRacking!.localReadings?.[0];
  assert.ok(local && /ballasted roof system/.test(local.quote) && local.sourceUrl.startsWith("https://"));
});

check("a ballasted roof job with clean numbers routes ENGINEERED, quoting the rule (no longer prescriptive)", () => {
  const before = resolvePermitPath(job({}));
  assert.equal(before.path, "prescriptive", "baseline: the same job without ballast is prescriptive");
  const r = resolvePermitPath(job({ rackingSystem: "Unirac RM10 EVO" }));
  assert.equal(r.path, "engineered");
  assert.equal(r.source, "structural-screen");
  const basis = r.basis.join(" ");
  assert.match(basis, /ballasted \/ non-penetrating racking \(rackingSystem: Unirac RM10 EVO/);
  assert.match(basis, /BCD Form 440-5952 .*"PV modules or racking will be attached to the roof using one of the following methods/);
  assert.doesNotMatch(basis, /Solar Worksheet/, "a city's own reading is printed only for that city");
});

check("where the job's AHJ matches a local reading, the city's own words are printed too", () => {
  const r = resolvePermitPath(job({ planSetExtractedText: "ARRAY ON BALLASTED RACKING." }, { ahj: "City of Portland" }));
  assert.equal(r.path, "engineered");
  assert.match(r.basis.join(" "), /Solar Worksheet .*"Is this a ballasted roof system\? .*STOP! Take the engineered path\."/);
});

check("an UNCLEAR reading leaves the path UNKNOWN with the reason (a person confirms), never prescriptive", () => {
  const r = resolvePermitPath(job({ planSetExtractedText: "ARRAY ON BALLASTED RACKING.", roofMaterial: "Composition Shingle", attachmentToFraming: "yes" }));
  assert.equal(r.path, "unknown");
  assert.match(r.basis.join(" "), /Ballasted racking unclear: the plan text names ballast, but .*Manual entry → Permit path/);
  // The person's answer decides.
  assert.equal(resolvePermitPath(job({ planSetExtractedText: "ARRAY ON BALLASTED RACKING.", roofMaterial: "Composition Shingle", permitPathOverride: "prescriptive" })).path, "prescriptive");
  // A screen that already failed routes engineered regardless.
  assert.equal(resolvePermitPath(job({ planSetExtractedText: "ARRAY ON BALLASTED RACKING.", roofMaterial: "Composition Shingle", attachmentToFraming: "yes", snow: "90" })).path, "engineered");
});

check("no ballast rule on file for the jurisdiction: ballast changes nothing in the path", () => {
  // A state with no permit-path record routes to its standard review exactly as before.
  const ut = resolvePermitPath(job({ state: "UT", rackingSystem: "Unirac RM10 EVO" }, { state: "UT" }));
  const utPlain = resolvePermitPath(job({ state: "UT" }, { state: "UT" }));
  assert.equal(ut.path, utPlain.path);
  assert.deepEqual(ut.basis, utPlain.basis);
});

check("a record's ballast rule without a quote, source or https URL is dropped at load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ballast-rule-"));
  const file = path.join(dir, "paths.json");
  const base = { state: "NV", ahj: "", displayName: "Test State", ahjNames: [], split: true, code: "TEST", source: "Test", limits: {} };
  fs.writeFileSync(file, JSON.stringify({ records: [
    { ...base, ballastedRacking: { source: "Test form", sourceUrl: "https://example.invalid/form", quote: "" } },
    { ...base, state: "AZ", ballastedRacking: { source: "Test form", sourceUrl: "http://example.invalid/form", quote: "attach to framing" } },
    { ...base, state: "UT", ballastedRacking: { source: "Test form", sourceUrl: "https://example.invalid/form", quote: "attach to framing" } },
  ] }));
  const recs = shippedPermitPathRecords(file);
  assert.equal(recs.find((r) => r.state === "NV")?.ballastedRacking, undefined, "no quote");
  assert.equal(recs.find((r) => r.state === "AZ")?.ballastedRacking, undefined, "not https");
  assert.equal(recs.find((r) => r.state === "UT")?.ballastedRacking?.quote, "attach to framing");
});

check("a ground mount the field names keeps its own route (step 5), not the ballast rule", () => {
  const r = resolvePermitPath(job({ mounting: "Ballasted ground" }));
  assert.equal(r.path, "engineered");
  assert.doesNotMatch(r.basis.join(" "), /non-penetrating racking/);
});

// ---- the reviewer ----------------------------------------------------------------------------------
check("the reviewer asks a person when the package is unclear (warning), and stays quiet when it is clear", () => {
  const unclear = buildReviewerReport(job({ planSetExtractedText: "IF BALLASTED, PROVIDE BALLAST LAYOUT." })).findings.find((f) => f.id === "city.struct.ballast-unclear");
  assert.equal(unclear?.severity, "warning");
  assert.match(String(unclear?.message), /conditional/);
  assert.equal(buildReviewerReport(job({ rackingSystem: "Unirac RM10 EVO" })).findings.find((f) => f.id === "city.struct.ballast-unclear"), undefined);
  assert.equal(buildReviewerReport(job({})).findings.find((f) => f.id === "city.struct.ballast-unclear"), undefined);
});

if (failures) {
  console.error(`\n${failures} ballastedRacking check(s) failed`);
  process.exit(1);
}
console.log("\nballastedRacking: all checks passed");
