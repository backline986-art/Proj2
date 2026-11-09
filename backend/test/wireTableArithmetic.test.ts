// THE GATE CHECKS THE WIRE TABLE'S OWN ARITHMETIC, TAG BY TAG (#334).
//
// An audit of a live line-side-tap package (NEC 2023 via the 2023 OESC) found the gate silent on a
// wire table an inspector fails as drawn: #2 THWN-2 behind 90 A fuses with a #10 ground (Table
// 250.122: #8 Cu; the tap's supply-side bonding jumper per Table 250.102(C)(1): #8 Cu), eleven #10
// THWN-2 in one 3/4" EMT (0.232 in² against 0.213 in² at 40 %), and five 2-pole breakers in an
// 8-space load center. The fixture below is that sheet E 1.1, scrubbed and rebuilt from the audit's
// numbers (no homeowner data; the real sheet text is not in the repo). Every value is printed under
// its own label, the shape the reader accepts; a table read column by column, a row with two
// ground sizes, an OCPD with no label, or a tag read twice with different values yields NOTHING.
//
// Run: npx tsx backend/test/wireTableArithmetic.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { evaluateWireTableFindings, readWireTableRows, WIRE_TABLE_FINDING_IDS } from "../src/wireTableArithmetic";
import { buildReviewerReport } from "../src/reviewerEngine";
import { MEASURED_FINDING_IDS, visionMayRelax } from "../src/reviewerVision";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const mk = (planText: string, interco = "Line-side tap", extra: Record<string, unknown> = {}): ProjectRecord => ({
  id: "wire-table", clientId: "c", homeownerName: "Synthetic Owner", projectAddress: "1 Test Way",
  city: "Testville", state: "OR", zip: "97000", ahj: "City of Testville", utility: "Test Power",
  interconnectionMethod: interco, status: "pending",
  parserSnapshot: { state: "OR", ahj: "City of Testville", mounting: "Roof mount", interco, planSetExtractedText: planText, ...extra },
} as unknown as ProjectRecord);
const ids = (fs: ReviewerFinding[]): string[] => fs.map((f) => f.id).filter((id) => (WIRE_TABLE_FINDING_IDS as readonly string[]).includes(id)).sort();
const byId = (fs: ReviewerFinding[], id: string): ReviewerFinding | undefined => fs.find((f) => f.id === id);

// Sheet E 1.1, one line per page as pdf.js extracts it.
const E11 = [
  "SHEET NUMBER: E-1.1 CONDUCTOR AND CONDUIT SCHEDULE",
  "TAG 1: MICROINVERTERS TO JUNCTION BOX (2) #12 AWG TRUNK CABLE, (1) #6 BARE CU EGC, FREE AIR, OCPD 20A",
  "TAG 2: JUNCTION BOX TO COMBINER (10) #10 THWN-2, (1) #10 THWN-2 EGC, 3/4\" EMT, OCPD 20A",
  "TAG 3: COMBINER TO FUSED DISCONNECT (3) #2 THWN-2, (1) #10 THWN-2 EGC, 1-1/4\" EMT, (2) 90A FUSES",
  "TAG 4: FUSED DISCONNECT TO LINE SIDE TAP (3) #2 THWN-2, (1) #10 THWN-2 GND, 1-1/4\" EMT, (2) 90A FUSES",
].join(" ");
const E12 = "SHEET NUMBER: E-1.2 AC COMBINER: SQUARE D BR816L125RP 125A 8-SPACE LOAD CENTER WITH (5) 20A 2P BREAKERS. GROUNDING NOTE 2: MINIMUM NEC TABLE 250.122.";
const PLAN = `${E11}\n${E12}`;

console.log("\n1. THE AUDITED TABLE: EVERY ARITHMETIC FAILURE, WITH THE VALUES READ");
const audited = buildReviewerReport(mk(PLAN)).findings;
check("MUST PASS: the reviewer gate raises the EGC, bonding jumper, fill and panel-space findings", () => {
  assert.deepEqual(ids(audited), [
    "city.elec.panel-spaces-short",
    "city.elec.wire-table-bonding-jumper-undersized",
    "city.elec.wire-table-egc-undersized",
    "city.elec.wire-table-raceway-fill",
  ]);
});
check("EGC: tag 3's #10 behind 90 A is short of Table 250.122's #8, a WARNING citing 250.122, tag and sheet", () => {
  const f = byId(audited, "city.elec.wire-table-egc-undersized");
  assert.ok(f);
  assert.equal(f.severity, "warning");
  assert.match(f.message, /Tag 3 \(E-1\.1\): #2 CU THWN-2 behind a 90 A OCPD -> Table 250\.122 requires at least #8 CU; the table shows a #10 CU EGC/);
  assert.doesNotMatch(f.message, /Tag 4/, "the tap row answers to 250.102(C)(1), not 250.122");
  assert.ok(f.codeReferences.some((r) => r.section === "250.122"));
});
check("Bonding: tag 4 (the line-side tap) is sized from the #2 ungrounded conductor, #8 required", () => {
  const f = byId(audited, "city.elec.wire-table-bonding-jumper-undersized");
  assert.ok(f);
  assert.equal(f.severity, "warning");
  assert.match(f.message, /Tag 4 \(E-1\.1\): ungrounded #2 CU THWN-2 on the supply side -> Table 250\.102\(C\)\(1\) requires at least #8 CU; the table shows a #10 CU ground/);
  assert.ok(f.codeReferences.some((r) => r.section === "250.102(C)(1)"));
});
check("Fill: tag 2's eleven #10 THWN-2 = 0.232 in² over the 3/4\" EMT's 0.213 in²", () => {
  const f = byId(audited, "city.elec.wire-table-raceway-fill");
  assert.ok(f);
  assert.equal(f.severity, "warning");
  assert.match(f.message, /Tag 2 \(E-1\.1\): 10 x #10 THWN-2 \(0\.0211 in²\) \+ 1 x #10 THWN-2 \(0\.0211 in²\) = 0\.232 in² in a 3\/4" EMT, above its 40 % allowance of 0\.213 in²/);
  assert.doesNotMatch(f.message, /Tag [134]/, "tags 1, 3 and 4 fit their raceways (or run in free air)");
});
check("Panel: 5 x 2-pole = 10 poles in an 8-space load center is a CALLOUT citing 110.3(B)", () => {
  const f = byId(audited, "city.elec.panel-spaces-short");
  assert.ok(f);
  assert.equal(f.severity, "callout");
  assert.match(f.message, /E-1\.2: load center stated as 8 spaces, listed with \(5\) 20A 2P = 10 poles/);
});
check("Tag 2's #10 at 20 A is within its ampacity after the fill adjustment: no ampacity finding", () => {
  assert.equal(byId(audited, "city.elec.wire-table-ocpd-over-ampacity"), undefined);
});

console.log("\n2. THE CORRECTED TABLE PASSES");
const FIXED = PLAN
  .replace("(10) #10 THWN-2, (1) #10 THWN-2 EGC, 3/4\" EMT", "(10) #10 THWN-2, (1) #10 THWN-2 EGC, 1\" EMT")
  .replace(/\(1\) #10 THWN-2 EGC, 1-1\/4" EMT/, "(1) #8 THWN-2 EGC, 1-1/4\" EMT")
  .replace("(1) #10 THWN-2 GND", "(1) #8 THWN-2 GND")
  .replace("8-SPACE", "12-SPACE");
check("MUST PASS: a table whose numbers add up produces no wire-table finding", () => {
  assert.deepEqual(ids(buildReviewerReport(mk(FIXED)).findings), []);
});

console.log("\n3. AN UNCERTAIN READING YIELDS NO FINDING");
check("a table pdf.js read column by column (several sizes per row span) yields nothing", () => {
  const garbled = "SHEET NUMBER: E-1.1 TAG 1 TAG 2 TAG 3 TAG 4 #12 AWG #10 THWN-2 #2 THWN-2 #2 THWN-2 GROUND #6 BARE #10 THWN-2 #10 THWN-2 #10 THWN-2 OCPD 20A 20A 90A 90A 3/4\" EMT 1-1/4\" EMT";
  assert.deepEqual(ids(evaluateWireTableFindings(mk(garbled), { supplySide: true })), []);
});
check("a row with two ground sizes, or no OCPD label, yields nothing", () => {
  const two = "TAG 3: (3) #2 THWN-2, (1) #10 THWN-2 EGC, (1) #8 THWN-2 EGC, (2) 90A FUSES";
  const unlabelled = "TAG 3: (3) #2 THWN-2, (1) #10 THWN-2 EGC, 1-1/4\" EMT, 90A";
  assert.deepEqual(ids(evaluateWireTableFindings(mk(two))), []);
  assert.deepEqual(ids(evaluateWireTableFindings(mk(unlabelled))), []);
});
check("a MAIN breaker's rating is never the row's OCPD", () => {
  assert.deepEqual(ids(evaluateWireTableFindings(mk("TAG 3: (3) #2 THWN-2, (1) #10 THWN-2 EGC, MAIN BREAKER 200A", "Load-side breaker"))), []);
});
check("a GEC (sized by 250.66) is not read as the EGC", () => {
  assert.deepEqual(ids(evaluateWireTableFindings(mk("TAG 3: (3) #2 THWN-2, (1) #6 BARE CU GEC, (1) #8 THWN-2 EGC, (2) 90A FUSES"))), []);
});
check("the same tag read twice with different values (two tables, a revision) yields nothing", () => {
  const twice = `TAG 3: (3) #2 THWN-2, (1) #10 THWN-2 EGC, (2) 90A FUSES\nTAG 3: (3) #2 THWN-2, (1) #8 THWN-2 EGC, (2) 90A FUSES`;
  assert.deepEqual(readWireTableRows(twice.split("\n").map((text) => ({ label: "Plan set", text })), false), []);
});
check("the same tag read twice with the same values (plan set + uploaded document) reports once", () => {
  const row = "TAG 3: (3) #2 THWN-2, (1) #10 THWN-2 EGC, (2) 90A FUSES";
  const fs = evaluateWireTableFindings(mk(row), { documentTexts: [{ label: "Plan set PDF", text: row }] });
  assert.equal(fs.length, 1);
  assert.equal((fs[0].message.match(/Tag 3/g) ?? []).length, 1);
});
check("fill is not computed when a conductor's count is not stated", () => {
  const noCount = "TAG 2: (10) #10 THWN-2, #10 THWN-2 EGC, 3/4\" EMT, OCPD 20A";
  assert.equal(byId(evaluateWireTableFindings(mk(noCount)), "city.elec.wire-table-raceway-fill"), undefined);
});
check("a load center listed with tandem breakers is not called short", () => {
  const tandem = "8-SPACE LOAD CENTER WITH (5) 20A 2P TANDEM BREAKERS";
  assert.equal(byId(evaluateWireTableFindings(mk(tandem)), "city.elec.panel-spaces-short"), undefined);
});

console.log("\n4. THE RULES' EDGES");
check("on a LOAD-side design a row naming a tap is measured by 250.122 (no supply-side bonding finding)", () => {
  const fs = buildReviewerReport(mk(PLAN, "Load-side breaker")).findings;
  assert.equal(byId(fs, "city.elec.wire-table-bonding-jumper-undersized"), undefined);
  assert.match(byId(fs, "city.elec.wire-table-egc-undersized")?.message ?? "", /Tag 4 \(E-1\.1\)/);
});
check("250.122(A): an EGC as large as its circuit conductors passes (#12 EGC with #12 on 30 A)", () => {
  const fs = evaluateWireTableFindings(mk("TAG 1: (2) #12 THWN-2, (1) #12 THWN-2 EGC, OCPD 30A"));
  assert.equal(byId(fs, "city.elec.wire-table-egc-undersized"), undefined);
});
check("ampacity: six #10 THWN-2 (five counted) on 40 A exceed the 240.4(D) 30 A ceiling", () => {
  const f = byId(evaluateWireTableFindings(mk("TAG 2: (6) #10 THWN-2, (1) #10 THWN-2 EGC, OCPD 40A")), "city.elec.wire-table-ocpd-over-ampacity");
  assert.ok(f);
  assert.equal(f.severity, "warning");
  assert.match(f.message, /Tag 2 \(Uploaded plan-set document text\): #10 CU THWN-2 40 A \(Table 310\.16, 90 C\) x 0\.8 for 5 current-carrying conductors = 32 A; largest permitted OCPD 30 A \(240\.4\(D\)\), but the table shows 40 A/);
});
check("ampacity: the inverter output circuit electricalSizing already recomputes is not repeated", () => {
  const row = "TAG 3: (3) #10 THWN-2, (1) #10 THWN-2 EGC, OCPD 40A";
  assert.ok(byId(evaluateWireTableFindings(mk(row)), "city.elec.wire-table-ocpd-over-ampacity"));
  assert.equal(byId(evaluateWireTableFindings(mk(row, "Line-side tap", { acConductor: "#10 AWG THWN-2", pvBreaker: "40" })), "city.elec.wire-table-ocpd-over-ampacity"), undefined);
});
check("no sheet text: no findings", () => {
  assert.deepEqual(evaluateWireTableFindings(mk("")), []);
});

console.log("\n5. MEASURED: A PICTURE OF THE TABLE NEVER RELAXES ITS ARITHMETIC");
for (const id of WIRE_TABLE_FINDING_IDS) {
  check(`MUST PASS: ${id} is in MEASURED_FINDING_IDS (vision may not relax it)`, () => {
    assert.ok(MEASURED_FINDING_IDS.has(id));
    assert.equal(visionMayRelax({ id, severity: "warning", title: "" } as never), false);
  });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nwireTableArithmetic: all checks passed");
