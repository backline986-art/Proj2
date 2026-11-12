// REVIEW DRAFT 06 (follow-on to #673) — the reviewer gate reads #673's one job scope. A storage-only
// retrofit got reviewer BLOCKERS no AHJ raises on that job (DC/AC size, fire pathways, framing,
// attachment detail, rapid shutdown, PV breaker, module schedule) plus the roof-framing and module
// cut-sheet documents, so the gate held it forever once QC let it through. This pins:
//   (a) a storage-only job runs none of the array findings, and the job's own facts clear it;
//   (b) the storage facts are BLOCKERS when missing (one finding naming each), and the AC rating is the
//       battery inverter / PCS output; an addition also owes the existing size and tariff;
//   (c) the busbar door reads the battery inverter's breaker on a storage scope;
//   (d) unknown scope stays pv: today's PV blockers, exactly the report an explicit pv scope builds;
//   (e) new modules anywhere keep EVERY reviewer finding, even against a person's storage scope;
//   (f) the required documents: no roof framing / module sheet on a storage scope; a PV job keeps them.
// Invented names; no network, no browser, no LLM.
//
// KILL TEST: make buildReviewerReport ignore the scope (newArray = true) → (a), (b) and (f) fail.
//
// Run: npx tsx backend/test/reviewerJobScope.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-job-scope-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.RUN_TRIAGE = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const repo = await import("../src/repository");
const { buildReviewerReport } = await import("../src/reviewerEngine");
const { setPersonJobScope } = await import("../src/jobScope");
const { documentInventory } = await import("../src/requiredDocuments");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const BASE = {
  owner: "Rowan Achebe", street: "9 Thistle Row", city: "Marrowby", state: "ZZ", zip: "00009",
  ahj: "City of Marrowby", utility: "Marrowby Light & Water", account: "55566677", meter: "M889900",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200", permitPath: "prescriptive", mounting: "Roof Mount",
};
const PV = { dcKw: "8.0", acKw: "6.4", moduleMake: "Brightleaf", moduleModel: "BL-400", moduleWattage: "400", moduleQty: "20", invModel: "MX-300", invQty: "20", invOutputW: "1.2", pvBreaker: "40" };
const BATTERY = { batteryMake: "Stillwater", batteryModel: "SW-13", batteryQty: "1", batteryCapacityKwh: "13.5", batteryOutputKw: "5", essInverterModel: "SW-PCS5", batteryMode: "Backup only", essBreaker: "30" };
const SHEETS_NO = { newModulesOnSchedule: "no", newModulesOnSld: "no" };

let n = 0;
function project(payload: Record<string, unknown>): string {
  n += 1;
  return repo.createProject(db, { ...BASE, owner: `${BASE.owner} ${n}`, street: `${n} Thistle Row`, ...payload } as never, undefined, { learningExcluded: true }).project.id;
}
const report = (id: string) => repo.getReviewerReport(db, id);
const ids = (id: string, severity?: string): string[] => report(id).findings.filter((f) => !severity || f.severity === severity).map((f) => f.id).sort();
const shape = (findings: Array<{ id: string; severity: string }>): string[] => findings.map((f) => `${f.severity}:${f.id}`).sort();

const ARRAY_FINDINGS = [
  "reviewer.core.dc", "city.fire.pathways-missing", "city.struct.framing-missing", "city.struct.attachment-detail-missing",
  "city.elec.rapid-shutdown-missing", "city.elec.equipment-specs-incomplete", "city.plan.site-roof-missing",
  "reviewer.plan.fire-path", "reviewer.plan.rapid-shutdown", "city.plan.ul-listings-missing", "reviewer.plan.ground-array-site",
];
const PV_BLOCKERS = [
  "city.elec.equipment-specs-incomplete", "city.elec.rapid-shutdown-missing", "city.fire.pathways-missing",
  "city.struct.attachment-detail-missing", "city.struct.framing-missing", "reviewer.core.ac", "reviewer.core.dc",
];

// (a)
const storage = project({ ...BATTERY, ...SHEETS_NO });
check("(a) a storage-only job runs none of the array findings", () => {
  const all = ids(storage);
  for (const a of ARRAY_FINDINGS) assert.ok(!all.includes(a), `${a} ran on a storage-only job`);
  assert.ok(!all.includes("reviewer.storage.facts-missing"));
  assert.ok(!all.includes("reviewer.core.ac"), "the PCS output answers the AC rating");
});
check("(a) what remains holds a storage job for real reasons only (the SLD and site plan are owed)", () => {
  const blockers = ids(storage, "blocker");
  for (const b of blockers) assert.ok(["city.plan.sld-missing", "reviewer.plan.sld", "reviewer.plan.site"].includes(b), `unexpected blocker ${b}`);
});

// (b)
const bare = project({ batteryMake: "Stillwater", batteryModel: "SW-13", batteryQty: "1", ...SHEETS_NO });
check("(b) missing storage facts are ONE blocker naming each, and the AC rating is the PCS output", () => {
  const f = report(bare).findings.find((x) => x.id === "reviewer.storage.facts-missing");
  assert.equal(f?.severity, "blocker");
  for (const label of ["usable energy (kWh)", "battery inverter / PCS power (kW)", "battery inverter / PCS model", "operating mode"]) assert.ok(f!.message.includes(label), `${label}: ${f!.message}`);
  const ac = report(bare).findings.find((x) => x.id === "reviewer.core.ac");
  assert.equal(ac?.severity, "blocker");
  assert.match(ac!.message, /PCS/);
  assert.ok(!ids(bare).includes("reviewer.core.dc"));
});
const addition = project({ ...BATTERY, ...SHEETS_NO, existingSystem: "yes" });
check("(b) a storage addition also owes the existing system's size and tariff", () => {
  const f = report(addition).findings.find((x) => x.id === "reviewer.storage.facts-missing");
  assert.ok(f && /existing PV system size/.test(f.message) && /tariff/.test(f.message), f?.message);
});

// (c)
const noBreaker = project({ ...BATTERY, ...SHEETS_NO, essBreaker: "" });
check("(c) the busbar door reads the battery inverter's breaker: none on file is a blocker", () => {
  assert.equal(report(noBreaker).findings.find((x) => x.id === "city.elec.load-side-calc-missing")?.severity, "blocker");
  assert.notEqual(report(storage).findings.find((x) => x.id === "city.elec.load-side-calc-missing")?.severity, "blocker");
});

// (d)
const ambiguous = project({ ...BATTERY });
check("(d) unknown scope stays pv: today's PV blockers stay", () => {
  const blockers = ids(ambiguous, "blocker");
  for (const b of PV_BLOCKERS) assert.ok(blockers.includes(b), b);
});
check("(d) …and the report is exactly the one an explicit pv scope builds", () => {
  const p = repo.getProjectDetail(db, ambiguous).project;
  assert.deepEqual(shape(buildReviewerReport(p).findings), shape(buildReviewerReport(p, { jobScope: "pv" }).findings));
});

// (e)
const withModules = project({ ...BATTERY, ...SHEETS_NO, moduleModel: "BL-400" });
check("(e) new modules anywhere keep every finding, even against a person's storage scope", () => {
  const before = shape(report(withModules).findings);
  setPersonJobScope(db, withModules, "storage-only", "Pat Reviewer");
  const after = shape(report(withModules).findings);
  assert.deepEqual(after, before);
  const p = repo.getProjectDetail(db, withModules).project;
  assert.deepEqual(shape(buildReviewerReport(p, { jobScope: "pv+storage" }).findings), shape(buildReviewerReport(p, { jobScope: "pv" }).findings));
  assert.ok(after.includes("blocker:city.fire.pathways-missing"));
});
const pvJob = project({ ...PV });
check("(e) a PV job's report is unchanged by the scope plumbing (derived = explicit pv)", () => {
  const p = repo.getProjectDetail(db, pvJob).project;
  assert.deepEqual(shape(buildReviewerReport(p).findings), shape(buildReviewerReport(p, { jobScope: "pv" }).findings));
  assert.ok(!ids(pvJob).includes("reviewer.storage.facts-missing"));
});

// (f)
check("(f) a storage scope owes no roof framing or module cut sheet; the ESS rows and a relabelled site plan instead", () => {
  const inv = documentInventory(db, repo.getProjectDetail(db, storage).project);
  const types = inv.required.map((r) => r.docType);
  assert.ok(!types.includes("structural") && !types.includes("module_spec"), types.join(","));
  assert.ok(types.includes("battery_spec") && types.includes("site_plan") && types.includes("sld"));
  assert.match(inv.required.find((r) => r.docType === "site_plan")!.label, /ESS location/);
});
check("(f) a PV job and an unknown-scope battery job keep the roof framing and module sheet", () => {
  for (const id of [pvJob, ambiguous, withModules]) {
    const types = documentInventory(db, repo.getProjectDetail(db, id).project).required.map((r) => r.docType);
    assert.ok(types.includes("structural") && types.includes("module_spec"), `${id}: ${types.join(",")}`);
  }
});

if (failures) { console.error(`\n${failures} reviewerJobScope check(s) FAILED.`); process.exit(1); }
console.log("\nAll reviewerJobScope checks passed.");
process.exit(0);
