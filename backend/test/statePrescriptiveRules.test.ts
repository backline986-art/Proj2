// EACH STATE'S PRESCRIPTIVE RULES ARE CITED DATA, AND THE GATE REFUSES A PRESCRIPTIVE FILING THEY
// SEND ENGINEERED (#595 PR2).
//
// A real Oregon job filed as prescriptive solar came back from the city as non-prescriptive. Its
// racking was ballasted, which alone keeps an Oregon job off the prescriptive path (BCD 440-5952 Part
// III: attachment by direct attachment to framing / blocking or standing-seam clamps only), and the
// gate did not know it. These checks pin, on synthetic jobs only:
//   - migration v63 creates state_permit_rules; the shipped rules seed as `seeded`, every one cited;
//     re-seeding never writes a row a person verified (rule 3), and refreshes a seeded one;
//   - Utah, Idaho, Nevada, Arizona carry no prescriptive rule (nothing citable), only the seal rule;
//   - ballasted racking routes the path itself engineered (a callout names why); an operator
//     "prescriptive" over it is REFUSED (blocker) naming the reason and quoting the rule; a
//     "NON-BALLASTED" note is not ballast; plan-text ballast against flashed attachments on a shingle
//     roof is a person's question (warning), never a guess; an operator "prescriptive" against a snow
//     load over the limit is refused too;
//   - an input the rules need that the plans do not state, and an Oregon rafter span (its limits are
//     not on file), is "check with an engineer", never a pass;
//   - the out-of-state seal finding (PR1) cites the job state's own seal statute.
// Run: tsx backend/test/statePrescriptiveRules.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord, ReviewerFinding } from "../../shared/src/types";

const { openDatabase } = await import("../src/db");
const { statePermitRulesFor, seedStatePermitRules, statePrescriptiveFindings } = await import("../src/stateRules");
const { buildReviewerReport } = await import("../src/reviewerEngine");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const db = await openDatabase();

check("migration v63 + boot seed: Oregon's structural rules land seeded, each with a citation and source", () => {
  const or = statePermitRulesFor(db, "OR");
  const keys = or.map((r) => r.key);
  for (const k of ["prescriptivePath", "attachmentMethods", "maxGroundSnowPsf", "allowedWindExposures", "maxPvSystemWeightPsf", "maxFramingSpacingIn", "rafterSpanRule", "sealStateOnly"]) {
    assert.ok(keys.includes(k), `OR ${k}`);
  }
  for (const r of or) {
    assert.equal(r.confidence, "seeded", `${r.key} lands seeded`);
    assert.ok(r.citation.length > 20 && r.sourceUrl.startsWith("https://"), `${r.key} is cited`);
  }
  assert.match(or.find((r) => r.key === "attachmentMethods")!.citation, /440-5952/);
});

check("Utah, Idaho, Nevada, Arizona: no prescriptive rule (nothing citable), the seal statute only", () => {
  for (const st of ["UT", "ID", "NV", "AZ"]) {
    const keys = statePermitRulesFor(db, st).map((r) => r.key);
    assert.deepEqual(keys, ["sealStateOnly"], st);
  }
  assert.deepEqual(statePermitRulesFor(db, "Oregon").length > 0, true, "a spelled-out state name reads too");
  assert.deepEqual(statePermitRulesFor(db, "XX"), []);
});

check("rule 3: re-seeding never writes a verified row, and refreshes a seeded one", () => {
  db.run("UPDATE state_permit_rules SET verified_at = '2026-11-09T00:00:00Z', verified_by = 'Test Person', citation = 'PERSON CHECKED' WHERE state = 'OR' AND rule_key = 'maxGroundSnowPsf'");
  db.run("UPDATE state_permit_rules SET citation = 'STALE' WHERE state = 'OR' AND rule_key = 'maxPvSystemWeightPsf'");
  seedStatePermitRules(db);
  const or = statePermitRulesFor(db, "OR");
  const snow = or.find((r) => r.key === "maxGroundSnowPsf")!;
  assert.equal(snow.citation, "PERSON CHECKED");
  assert.equal(snow.confidence, "verified");
  assert.match(or.find((r) => r.key === "maxPvSystemWeightPsf")!.citation, /4\.5 psf/);
  // A reference that changes the verified rule still never reaches it.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "state-rules-")), "ref.json");
  fs.writeFileSync(tmp, JSON.stringify({ rules: [{ state: "OR", family: "structural", key: "maxGroundSnowPsf", value: 1, citation: "a different seeded citation for the test", sourceUrl: "https://example.invalid" }] }));
  seedStatePermitRules(db, tmp);
  assert.equal(statePermitRulesFor(db, "OR").find((r) => r.key === "maxGroundSnowPsf")!.value, 70);
  db.run("UPDATE state_permit_rules SET verified_at = '', verified_by = '' WHERE state = 'OR'");
  seedStatePermitRules(db);
});

const OR_RULES = statePermitRulesFor(db, "OR");
const UT_RULES = statePermitRulesFor(db, "UT");

const mk = (snapshot: Record<string, unknown>, state = "OR"): ProjectRecord => ({
  id: "state-rules", clientId: "c", homeownerName: "Rules Probe", projectAddress: "1 Test Lane",
  city: "Testville", state, zip: "97000", ahj: "City of Testville",
  utility: "Test Power", accountNumber: "", meterNumber: "",
  systemSizeDcKw: 8, systemSizeAcKw: 6, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: {
    state, mounting: "Roof mount", roofMaterial: "Composition Shingle",
    snow: "25", deadLoad: "3", wind: "B", roofRafterSpacing: "24", framingType: "truss",
    rackingSystem: "TestRack XR", attachmentHardware: "TestFoot flashing", attachmentToFraming: "yes",
    ...snapshot,
  },
} as unknown as ProjectRecord);
const byId = (fs_: ReviewerFinding[], id: string) => fs_.find((f) => f.id === id);
const REFUSED = "state.struct.prescriptive-refused";
const UNVERIFIED = "state.struct.prescriptive-unverified";

check("a clean Oregon prescriptive truss job raises nothing", () => {
  assert.deepEqual(statePrescriptiveFindings(mk({}), OR_RULES).map((f) => f.id), []);
});

check("ballasted racking: the path itself routes engineered (callout); an operator 'prescriptive' is REFUSED, naming the reason and quoting BCD 440-5952", () => {
  const p = mk({ attachmentHardware: "IronRidge BX chassis / blocks / anchors", rackingSystem: "IronRidge BX", attachmentToFraming: "" });
  // The path screen reads the racking now: the wrong (prescriptive) application is never built.
  assert.equal(byId(buildReviewerReport(p, { stateRules: OR_RULES }).findings, REFUSED), undefined);
  assert.equal(byId(statePrescriptiveFindings(p, OR_RULES), "state.struct.engineered-reasons")?.severity, "callout");
  // A person who picks prescriptive anyway is refused, with the rule quoted.
  const forced = mk({ attachmentHardware: "IronRidge BX chassis / blocks / anchors", rackingSystem: "IronRidge BX", attachmentToFraming: "", permitPathOverride: "prescriptive" });
  const f = byId(buildReviewerReport(forced, { stateRules: OR_RULES }).findings, REFUSED);
  assert.ok(f, "refused");
  assert.equal(f!.severity, "blocker");
  assert.match(f!.title, /ballasted \/ non-penetrating racking.*→ engineered/);
  assert.match(f!.message, /Direct attachment to the roof framing or blocking/);
  assert.ok(f!.codeReferences.some((r) => /440-5952/.test(r.title) && r.sourceUrl.startsWith("https://")));
  assert.equal(byId(buildReviewerReport(forced, {}).findings, REFUSED), undefined, "no rules on file: nothing new");
});

check("ballast read from the plan text; a NON-BALLASTED note is not ballast; a conflicting package is a person's question", () => {
  const flat = { attachmentHardware: "", attachmentToFraming: "", roofMaterial: "TPO membrane", permitPathOverride: "prescriptive" };
  assert.ok(byId(statePrescriptiveFindings(mk({ ...flat, planSetExtractedText: "ARRAY ON BALLASTED RACKING WITH CONCRETE BLOCKS." }), OR_RULES), REFUSED));
  assert.equal(byId(statePrescriptiveFindings(mk({ planSetExtractedText: "NON-BALLASTED SYSTEM. ALL ATTACHMENTS LAGGED TO RAFTERS." }), OR_RULES), REFUSED), undefined);
  // Ballast in the plan text while the fields say flashed attachments to the framing on a shingle
  // roof: never a guessed refusal, never a pass.
  const mixed = byId(statePrescriptiveFindings(mk({ permitPathOverride: "prescriptive", planSetExtractedText: "ARRAY ON BALLASTED RACKING WITH CONCRETE BLOCKS." }), OR_RULES), UNVERIFIED);
  assert.equal(byId(statePrescriptiveFindings(mk({ permitPathOverride: "prescriptive", planSetExtractedText: "ARRAY ON BALLASTED RACKING WITH CONCRETE BLOCKS." }), OR_RULES), REFUSED), undefined);
  assert.equal(mixed?.severity, "warning");
  assert.match(String(mixed?.message), /whether the racking is ballasted is unclear/);
});

check("an engineered job with ballast gets the reason as a callout, not a refusal", () => {
  const fs_ = statePrescriptiveFindings(mk({ permitPath: "engineered", attachmentHardware: "ballasted tray" }), OR_RULES);
  assert.equal(byId(fs_, REFUSED), undefined);
  assert.equal(byId(fs_, "state.struct.engineered-reasons")?.severity, "callout");
});

check("an operator 'prescriptive' against a snow load over the limit is refused", () => {
  const f = byId(statePrescriptiveFindings(mk({ permitPathOverride: "prescriptive", snow: "80" }), OR_RULES), REFUSED);
  assert.ok(f);
  assert.match(f!.message, /ground snow load 80 psf is over the 70 psf prescriptive limit/);
});

check("unread inputs and an Oregon rafter span are 'check with an engineer', never a pass", () => {
  const f = byId(statePrescriptiveFindings(mk({ wind: "", framingType: "rafter", roofRafterSpan: "11.5", rackingSystem: "", attachmentHardware: "", attachmentToFraming: "" }), OR_RULES), UNVERIFIED);
  assert.ok(f);
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /wind exposure/);
  assert.match(f!.message, /racking/);
  assert.match(f!.message, /rafter span 11\.5 ft read from the plans; the span limits \(ORSC R324\.4\.1 Exception 1\.4 through 1\.6\) are not on file/);
  assert.equal(byId(statePrescriptiveFindings(mk({ framingType: "rafter", rafterExceptionCompliant: "yes" }), OR_RULES), UNVERIFIED), undefined, "a person answered the exception row");
});

check("Utah publishes no prescriptive rule on file: ballast there raises nothing from this rule set", () => {
  assert.deepEqual(statePrescriptiveFindings(mk({ attachmentHardware: "ballasted" }, "UT"), UT_RULES), []);
});

check("the out-of-state seal finding cites the job state's own seal statute", () => {
  const sealText = "REGISTERED PROFESSIONAL ENGINEER STATE OF CALIFORNIA";
  const or = byId(buildReviewerReport(mk({ planSetExtractedText: sealText }), { stateRules: OR_RULES }).findings, "city.struct.seal-out-of-state");
  assert.ok(or);
  assert.match(or!.codeReferences[0].title, /ORS 672\.020/);
  const ut = byId(buildReviewerReport(mk({ planSetExtractedText: sealText }, "UT"), { stateRules: UT_RULES }).findings, "city.struct.seal-out-of-state");
  assert.match(ut!.codeReferences[0].title, /58-22-602/);
});

db.close?.();
if (failures) {
  console.error(`\n${failures} statePrescriptiveRules check(s) failed`);
  process.exit(1);
}
console.log("\nstatePrescriptiveRules: all checks passed");
