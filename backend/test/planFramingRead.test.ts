// THE RAFTER SPAN, LUMBER, SPACING AND PERMIT PATH ARE READ OFF THE PLANS, AND AN OUT-OF-STATE
// ENGINEER'S SEAL IS NAMED (#595, PR1).
//
// A real Oregon job filed as prescriptive solar came back from the city: non-prescriptive design, an
// engineer's seal from another state (Oregon does not accept it), structural calcs needed. Its parse
// had no rafter span and no permit path though the plans stated both, and the sealed letter in the
// package silenced "stamped engineering missing" without anyone naming its seal as the problem.
//
// These checks pin, on synthetic sheets only (no real plan text, names or addresses):
//   - supplementStructuralIntake reads span, size, grade, spacing and the stated path off plan text;
//     a rail span, a truss span and a general rule about paths are not read; two sheets that disagree
//     on size give no pick; the longest span governs; the plans only ever move the model's span and
//     path toward the stricter reading;
//   - the gate blocks on a seal (in the plan set or an uploaded letter) whose state is not the job's,
//     and never on a rule clause, a multi-state licence that includes the job's state, or no seal text;
//   - when the prescriptive span evidence is still incomplete, the finding says what the plans did not
//     state and what was read.
// Run: tsx backend/test/planFramingRead.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { ParserLlmExtraction, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { supplementStructuralIntake } from "../src/structuralIntake";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const read = (planText: string, fields: ParserLlmExtraction["fields"] = {}) =>
  supplementStructuralIntake({ provider: "stub", fields, lowConfidenceFields: [], notes: "" }, planText).fields;
const val = (f: ParserLlmExtraction["fields"], key: string) => f[key]?.value;

// ---- framing off the plans ------------------------------------------------------------------
const SHEET = [
  "S-1 STRUCTURAL NOTES.",
  `(E) 2X6 DF #2 RAFTERS @ 24" O.C., MAX SPAN 11'-6".`,
  `ROOF PLANE B: RAFTER SPAN: 9'-0".`,
  `IRONRIDGE XR100 RAIL, MAX RAIL SPAN 6'-0" BETWEEN ATTACHMENTS.`,
  `5/16" X 4" SS LAG SCREW INTO RAFTER, 2.5" MIN EMBEDMENT.`,
].join("\n");

check("span, size, grade and spacing are read off a rafter callout without inch marks", () => {
  const f = read(SHEET);
  assert.equal(val(f, "framingType"), "rafter");
  assert.equal(val(f, "roofRafterSize"), "2x6");
  assert.equal(val(f, "woodGrade"), "DF #2");
  assert.equal(val(f, "roofRafterSpacing"), 24);
  assert.equal(val(f, "lightFrame"), "yes");
  assert.equal(f.roofRafterSpan?.evidence?.source, "plan_set", "the span cites the plan set");
});

check("the LONGEST stated rafter span governs, and a rail span is never a rafter span", () => {
  assert.equal(val(read(SHEET), "roofRafterSpan"), 11.5);
  assert.equal(val(read(`MAX RAIL SPAN 6'-0". MODULE SPAN 4'-0".`), "roofRafterSpan"), undefined);
});

check("labelled framing lines are read: size, species/grade and spacing", () => {
  const f = read(`RAFTER SIZE: 2X8. LUMBER SPECIES/GRADE: DOUGLAS FIR-LARCH NO. 2. RAFTER SPACING: 16" O.C. RAFTER CLEAR SPAN: 12 FT 3 IN.`);
  assert.equal(val(f, "roofRafterSize"), "2x8");
  assert.equal(val(f, "woodGrade"), "DF-L #2");
  assert.equal(val(f, "roofRafterSpacing"), 16);
  assert.equal(val(f, "roofRafterSpan"), 12.25);
});

check("a truss's span is not the rafter span, and the old inch-mark truss callout still reads", () => {
  const f = read(`2" X 4" TRUSS @ 24" O.C., SPAN 26'-0". TRUSS SPAN: 26'-0".`);
  assert.equal(val(f, "framingType"), "truss");
  assert.equal(val(f, "roofRafterSpacing"), 24);
  assert.equal(val(f, "roofRafterSpan"), undefined);
});

check("two sheets that disagree on the member size give no pick", () => {
  const f = read(`2X6 RAFTERS @ 24" O.C. GARAGE: 2X4 RAFTERS @ 24" O.C.`);
  assert.equal(val(f, "roofRafterSize"), undefined);
  assert.equal(val(f, "roofRafterSpacing"), 24, "the spacing they agree on still reads");
});

check("the plans correct a SHORTER model span, never a longer one", () => {
  assert.equal(val(read(SHEET, { roofRafterSpan: { value: 10, confidence: 0.8 } }), "roofRafterSpan"), 11.5);
  assert.equal(val(read(SHEET, { roofRafterSpan: { value: "14'-0\"", confidence: 0.8 } }), "roofRafterSpan"), "14'-0\"");
});

// ---- the stated permit path -----------------------------------------------------------------
check("a labelled path is read; NON-PRESCRIPTIVE is the engineered path", () => {
  assert.equal(val(read("PERMIT PATH: NON-PRESCRIPTIVE"), "permitPath"), "engineered");
  assert.equal(val(read("DESIGN PATH: PRESCRIPTIVE"), "permitPath"), "prescriptive");
  assert.equal(read("PERMIT PATH: PRESCRIPTIVE").permitPath?.evidence?.excerpt, "PERMIT PATH: PRESCRIPTIVE");
});

check("the checklist question and a statement about this design are read", () => {
  assert.equal(val(read("PRESCRIPTIVE INSTALL?: NO"), "permitPath"), "engineered");
  assert.equal(val(read("PRESCRIPTIVE SOLAR INSTALLATION?: YES"), "permitPath"), "prescriptive");
  assert.equal(val(read("THIS SYSTEM IS DESIGNED PER THE ENGINEERED PATH."), "permitPath"), "engineered");
});

check("a general rule about paths, or a checklist title, is not this job's path", () => {
  assert.equal(val(read("IF THE PRESCRIPTIVE PATH CANNOT BE MET, AN ENGINEERED DESIGN PATH IS REQUIRED."), "permitPath"), undefined);
  assert.equal(val(read("CODES: 2023 ORSC; OREGON PRESCRIPTIVE SOLAR INSTALLATION CHECKLIST."), "permitPath"), undefined);
  assert.equal(val(read("PERMIT PATH: PRESCRIPTIVE. DESIGN PATH: ENGINEERED."), "permitPath"), undefined, "both stated: review, not a pick");
});

check("a stated engineered path corrects a model 'prescriptive'; a stated prescriptive never relaxes 'engineered'", () => {
  assert.equal(val(read("PERMIT PATH: ENGINEERED", { permitPath: { value: "prescriptive", confidence: 0.8 } }), "permitPath"), "engineered");
  assert.equal(val(read("PERMIT PATH: PRESCRIPTIVE", { permitPath: { value: "engineered", confidence: 0.8 } }), "permitPath"), "engineered");
});

// ---- the gate ---------------------------------------------------------------------------------
const mk = (snapshot: Record<string, unknown>, state = "OR"): ProjectRecord => ({
  id: "plan-framing", clientId: "c", homeownerName: "Framing Probe", projectAddress: "1 Test Lane",
  city: "Testville", state, zip: "97000", ahj: "City of Testville",
  utility: "Test Power", accountNumber: "", meterNumber: "",
  systemSizeDcKw: 8, systemSizeAcKw: 6, interconnectionMethod: "Load-side breaker",
  status: "pending",
  parserSnapshot: { state, ahj: "City of Testville", mounting: "Roof mount", ...snapshot },
} as unknown as ProjectRecord);
const gate = (p: ProjectRecord, docs: Array<{ label: string; text: string }> = [], docTypes: string[] = []): ReviewerFinding[] =>
  evaluateDesignCodeFindings(p, null, undefined, docTypes, docs);
const SEAL_ID = "city.struct.seal-out-of-state";
const seal = (fs: ReviewerFinding[]) => fs.find((f) => f.id === SEAL_ID);

const CA_SEAL = "REGISTERED PROFESSIONAL ENGINEER No. C00000 STATE OF CALIFORNIA EXP. 06/30/27";
const LETTER = "STRUCTURAL CERTIFICATION. I am a professional engineer licensed in the State of Colorado. The existing roof framing is adequate for the added PV load.";

check("a seal from another state in the plan set blocks, naming both states", () => {
  const f = seal(gate(mk({ permitPath: "engineered", planSetExtractedText: `PV-1 COVER. ${CA_SEAL}` }), [], ["structural_letter"]));
  assert.ok(f, "finding raised");
  assert.equal(f!.severity, "blocker");
  assert.match(f!.title, /California.*not Oregon/);
});

check("an uploaded letter licensed in another state blocks, and names the document", () => {
  const f = seal(gate(mk({}), [{ label: "Structural letter", text: LETTER }], ["structural_letter"]));
  assert.ok(f);
  assert.match(f!.message, /Colorado/);
  assert.match(f!.message, /Structural letter/);
  assert.ok(!/Framing Probe|1 Test Lane|C00000/.test(`${f!.title} ${f!.message}`), "no names, addresses or licence numbers");
});

check("no flag for the job's own state, a multi-state licence that includes it, a rule clause, or no seal text", () => {
  assert.equal(seal(gate(mk({ planSetExtractedText: "LICENSED PROFESSIONAL ENGINEER STATE OF OREGON" }))), undefined);
  assert.equal(seal(gate(mk({}), [{ label: "Structural letter", text: "Engineer licensed in the States of Utah, Idaho and Oregon." }])), undefined);
  assert.equal(seal(gate(mk({ planSetExtractedText: "CALCULATIONS SHALL BE SEALED BY A PROFESSIONAL ENGINEER REGISTERED IN THE STATE OF CALIFORNIA." }))), undefined);
  assert.equal(seal(gate(mk({ planSetExtractedText: "STRUCTURAL ENGINEER OF RECORD: TEST ENGINEERING, PHOENIX, ARIZONA" }))), undefined);
  assert.equal(seal(gate(mk({ planSetExtractedText: CA_SEAL }, ""))), undefined, "no job state: nothing to compare against");
});

check("the same seal is the job's own outside Oregon too (Utah job, Utah seal; Utah job, California seal)", () => {
  assert.equal(seal(gate(mk({ planSetExtractedText: "STATE OF UTAH LICENSED PROFESSIONAL ENGINEER" }, "UT"))), undefined);
  assert.ok(seal(gate(mk({ planSetExtractedText: CA_SEAL }, "UT"))));
});

check("incomplete span evidence says what the plans did not state, and what was read", () => {
  const f = gate(mk({ permitPath: "prescriptive", framingType: "rafter", roofRafterSize: "2x6", woodGrade: "DF #2", roofRafterSpacing: "24",
    planSetExtractedText: `2X6 DF #2 RAFTERS @ 24" O.C.` })).find((x) => x.id === "city.struct.span-table-incomplete");
  assert.ok(f, "span-table finding raised");
  assert.match(f!.message, /Not stated on the plans: rafter span\./);
  assert.match(f!.message, /Read from the plans: 2x6 DF #2 rafter, 24 in o\.c\./);
});

if (failures) {
  console.error(`\n${failures} planFramingRead check(s) failed`);
  process.exit(1);
}
console.log("\nplanFramingRead: all checks passed");
