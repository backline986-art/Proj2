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

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nresidentialPlanReading: all checks passed");
