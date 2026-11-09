// FOUR RESIDENTIAL PLAN-READING BUGS THE COMMERCIAL SOFT RUN FOUND (#689). Each section pins one:
//   3a  the worksheets read the parser's servicePhase / serviceVoltage keys (they printed [verify]);
//   3b  a blank projectType describes the mount the plans state, never "roof-mounted" by default;
//   3c  the DC-size check forgives the declared figure's own rounding, never a module miscount;
//   3d  a ballasted, non-penetrating roof array is asked for its ballast plan, not lag screws.
// Invented jobs only. The jurisdiction below is a seeded profile that prints both worksheets; nothing
// under test is keyed to it.
//   npx tsx backend/test/residentialPlanReading.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "residential-plan-reading-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "test.db");

const { buildApplicationDocumentPackage } = await import("../src/applicationDocs");
const { buildReviewerReport } = await import("../src/reviewerEngine");
const { dcSizeAgrees } = await import("../src/codeReviewRules");
type ProjectRecord = import("../../shared/src/types").ProjectRecord;

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const project = (snapshot: Record<string, unknown>, extra: Partial<ProjectRecord> = {}): ProjectRecord =>
  ({
    id: "p-689", clientId: "client-x", name: "Example", homeownerName: "Example Owner",
    address: "1 Example St", projectAddress: "1 Example St", city: "Oregon City", state: "OR", zip: "97000",
    ahj: "Clackamas County", utility: "Example Utility", systemSizeDcKw: 8, systemSizeAcKw: 7.6,
    interconnectionMethod: "Load-side breaker", status: "pending",
    parserSnapshot: { hasBattery: "No", ...snapshot },
    ...extra,
  }) as unknown as ProjectRecord;

const docText = (p: ProjectRecord, id: string): string => {
  const doc = buildApplicationDocumentPackage(p).docs.find((d) => d.id === id);
  assert.ok(doc, `the package has no ${id} document`);
  return doc.markdown;
};
const line = (markdown: string, prefix: string): string =>
  markdown.split("\n").find((l) => l.startsWith(prefix)) ?? `(no line starting "${prefix}")`;

// ---- 3a: the parser's service keys ----------------------------------------------------------------
check("3a: a wye service from the parser's keys prints its phase and line-to-line voltage on the transfer sheet", () => {
  const p = project({ servicePhase: "three-phase", serviceVoltage: "277/480Y" });
  assert.equal(line(docText(p, "ahj-worksheet"), "- Service phase/voltage:"), "- Service phase/voltage: three-phase / 277/480Y (480 V line to line)");
});
check("3a: a split-phase service from the parser's keys prints on the electrical worksheet", () => {
  const p = project({ servicePhase: "single-phase", serviceVoltage: "120/240" });
  assert.equal(line(docText(p, "electrical"), "- Service:"), "- Service: single-phase, 120/240 (240 V line to line)");
});
check("3a: a bare voltage is printed as a voltage, not echoed twice", () => {
  const p = project({ servicePhase: "single-phase", serviceVoltage: "240V" });
  assert.equal(line(docText(p, "ahj-worksheet"), "- Service phase/voltage:"), "- Service phase/voltage: single-phase / 240 V");
});
check("3a: the legacy phase / voltage keys still read when the parser's keys are absent", () => {
  const p = project({ phase: "single-phase", voltage: "120/240V" });
  assert.equal(line(docText(p, "ahj-worksheet"), "- Service phase/voltage:"), "- Service phase/voltage: single-phase / 120/240V (240 V line to line)");
});
check("3a: the parser's key wins over a stale legacy key", () => {
  const p = project({ servicePhase: "three-phase", phase: "single-phase", serviceVoltage: "120/208", voltage: "120/240" });
  assert.equal(line(docText(p, "electrical"), "- Service:"), "- Service: three-phase, 120/208 (208 V line to line)");
});
check("3a: text that is not a voltage is shown for a person to verify, never passed off as one", () => {
  const p = project({ servicePhase: "single-phase", serviceVoltage: "200A" });
  assert.match(line(docText(p, "ahj-worksheet"), "- Service phase/voltage:"), /\[verify\] "200A" does not read as a service voltage/);
});
check("3a: nothing stated is still [verify]", () => {
  assert.equal(line(docText(project({}), "ahj-worksheet"), "- Service phase/voltage:"), "- Service phase/voltage: [verify] / [verify]");
});

// ---- 3b: the mount on the AHJ transfer sheet ------------------------------------------------------
const MOUNTS: Array<[string, string, string]> = [
  ["Roof mount, comp shingle", "Roof-mounted solar PV", "Install roof-mounted photovoltaic system."],
  ["Ground mount", "Ground-mounted solar PV", "Install ground-mounted photovoltaic system."],
  ["Carport", "Carport-mounted solar PV", "Install carport-mounted photovoltaic system."],
];
for (const [mounting, type, scope] of MOUNTS) {
  check(`3b: blank projectType + mounting "${mounting}" -> "${type}"`, () => {
    const md = docText(project({ mounting }), "ahj-worksheet");
    assert.equal(line(md, "Project type:"), `Project type: ${type}`);
    assert.ok(line(md, "Install ").startsWith(scope), line(md, "Install "));
  });
}
check("3b: the older mountType key answers the same way", () => {
  assert.equal(line(docText(project({ mountType: "Ground mount" }), "ahj-worksheet"), "Project type:"), "Project type: Ground-mounted solar PV");
});
check("3b: a mount the plans never state is not written as roof-mounted", () => {
  const md = docText(project({}), "ahj-worksheet");
  assert.doesNotMatch(md, /roof-mounted/i);
  assert.match(line(md, "Project type:"), /\[verify\] roof, ground or carport mount/);
});
check("3b: a stated projectType still wins over the mount", () => {
  const md = docText(project({ projectType: "Solar PV + battery storage", mounting: "Carport" }), "ahj-worksheet");
  assert.equal(line(md, "Project type:"), "Project type: Solar PV + battery storage");
  assert.ok(line(md, "Install ").startsWith("Install solar pv + battery storage."), line(md, "Install "));
});

// ---- 3c: the DC-size tolerance is the declared figure's own rounding -------------------------------
const findingIds = (p: ProjectRecord): string[] => buildReviewerReport(p).findings.map((f) => f.id);
const dcJob = (dcKw: number, dcText: string, qty: number, watts: number): ProjectRecord =>
  project({ dcKw: dcText, moduleQty: String(qty), moduleWattage: String(watts), mounting: "Roof mount" }, { systemSizeDcKw: dcKw });
check("3c: 455 x 550 W (250.25 kW) against a declared \"250\" kW is rounding, not a mismatch", () => {
  assert.ok(!findingIds(dcJob(250, "250", 455, 550)).includes("city.elec.dc-size-mismatch"));
});
check("3c: the same set read as a parser number (250) passes too", () => {
  assert.ok(!findingIds(project({ dcKw: 250, moduleQty: "455", moduleWattage: "550" }, { systemSizeDcKw: 250 })).includes("city.elec.dc-size-mismatch"));
});
check("3c: a one-module miscount on an 8 kW job still BLOCKS (21 x 400 W = 8.4 kW vs \"8\")", () => {
  const f = buildReviewerReport(dcJob(8, "8", 21, 400)).findings.find((x) => x.id === "city.elec.dc-size-mismatch");
  assert.equal(f?.severity, "blocker", JSON.stringify(f));
});
check("3c: a one-module miscount against a figure written to the hundredth still blocks (8.40 vs 20 x 400 W)", () => {
  const f = buildReviewerReport(dcJob(8.4, "8.40", 20, 400)).findings.find((x) => x.id === "city.elec.dc-size-mismatch");
  assert.equal(f?.severity, "blocker", JSON.stringify(f));
});
check("3c: ten modules short on a 250 kW job still blocks", () => {
  assert.ok(findingIds(dcJob(250, "250", 445, 550)).includes("city.elec.dc-size-mismatch"));
});
check("3c: the arithmetic: the 0.15 kW floor, the declared rounding, the one-module bound, ties", () => {
  assert.equal(dcSizeAgrees(8.12, 8.0, "8.0", 0.4), true, "inside the 0.15 kW floor");
  assert.equal(dcSizeAgrees(8.2, 8, "8", 0.41), true, "20 x 410 W written to the kilowatt");
  assert.equal(dcSizeAgrees(8.2, 8, "8.00", 0.41), false, "the same set written to the hundredth");
  assert.equal(dcSizeAgrees(8.4, 8, "8", 0.4), false, "a whole module is never rounding");
  assert.equal(dcSizeAgrees(250.5, 250, "250", 0.55), false, "a tie rounds away (250.5 -> 251)");
  assert.equal(dcSizeAgrees(250.25, 250, "250 kW", 0.55), true, "units on the written figure");
  assert.equal(dcSizeAgrees(1250.4, 1250, "1,250", 0.55), true, "a thousands separator is not a decimal point");
});

// ---- 3d: a ballasted roof is asked for its ballast plan, not lag screws ----------------------------
const BASE = '36" FIRE ACCESS PATHWAY PER IFC 1205.2. RAPID SHUTDOWN PER NEC 690.12. SITE PLAN AND ROOF PLAN. SINGLE LINE DIAGRAM.';
const roofJob = (snap: Record<string, unknown>): ProjectRecord => project({ mounting: "Roof mount", ...snap });
const finding = (p: ProjectRecord, id: string) => buildReviewerReport(p).findings.find((f) => f.id === id);
check("3d: ballasted racking with no ballast plan -> a ballast/anchorage WARNING, not the attachment blocker", () => {
  const p = roofJob({ mounting: "Roof - ballasted, low-slope", planSetExtractedText: `${BASE} LOW-SLOPE MEMBRANE ROOF.` });
  assert.equal(finding(p, "city.struct.attachment-detail-missing"), undefined, "the lag-screw detail was demanded of a ballasted array");
  const f = finding(p, "city.struct.ballast-plan-missing");
  assert.equal(f?.severity, "warning", JSON.stringify(f));
  assert.match(String(f?.message), /mounting: Roof - ballasted/);
});
check("3d: ballast evidence in the plan text answers the same way as the field", () => {
  const p = roofJob({ planSetExtractedText: `${BASE} PV ARRAY ON NON-PENETRATING RACKING. MEMBRANE ROOF.` });
  assert.equal(finding(p, "city.struct.attachment-detail-missing"), undefined);
  assert.equal(finding(p, "city.struct.ballast-plan-missing")?.severity, "warning");
});
check("3d: a ballasted set that shows its ballast layout raises neither", () => {
  const p = roofJob({ rackingSystem: "Example ballasted flat-roof racking", planSetExtractedText: `${BASE} BALLAST LAYOUT: 4 BLOCKS PER BAY AT 32 LBS EACH.` });
  assert.equal(finding(p, "city.struct.attachment-detail-missing"), undefined);
  assert.equal(finding(p, "city.struct.ballast-plan-missing"), undefined);
});
check("3d: the word 'ballasted' alone is not the plan", () => {
  const p = roofJob({ rackingSystem: "Ballasted racking", planSetExtractedText: `${BASE} BALLASTED RACKING SYSTEM.` });
  assert.equal(finding(p, "city.struct.ballast-plan-missing")?.severity, "warning");
});
check("3d: no ballast evidence -> today's attachment BLOCKER stands", () => {
  const f = finding(roofJob({ planSetExtractedText: `${BASE} ROOF MOUNT SOLAR ARRAY.` }), "city.struct.attachment-detail-missing");
  assert.equal(f?.severity, "blocker", JSON.stringify(f));
  assert.equal(finding(roofJob({ planSetExtractedText: `${BASE} ROOF MOUNT SOLAR ARRAY.` }), "city.struct.ballast-plan-missing"), undefined);
});
check("3d: a denied ballast ('NON-BALLASTED') is not ballast evidence: the blocker stands", () => {
  const f = finding(roofJob({ rackingSystem: "Non-ballasted rail system", planSetExtractedText: `${BASE} ROOF MOUNT SOLAR ARRAY.` }), "city.struct.attachment-detail-missing");
  assert.equal(f?.severity, "blocker", JSON.stringify(f));
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nresidentialPlanReading: all checks passed");
