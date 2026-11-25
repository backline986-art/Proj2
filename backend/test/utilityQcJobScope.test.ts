// THE UTILITY PACKAGE QC READS WHAT THE JOB INSTALLS AND THE JOB'S OWN BATTERY MODE (soft-run drafts
// softrun-01 and softrun-02).
//   (1) softrun-01: a job that adds no modules (#673's storage-only / storage-added-to-existing-pv) is
//       never asked for a module spec, and its inverter spec is worded and read as the battery inverter /
//       PCS spec. A job with new PV (pv, pv+storage) and a battery job whose plan set does not state "no
//       new modules" keep the module spec: the strict default. The scope qc.ts resolves (a named person's
//       included) is the one used; a bare caller reads the job's own evidence.
//   (2) softrun-02: a job whose batteryMode / exportMode field classifies as an operating mode shows it
//       (the same reader QC's storage row uses); a value that does not classify still reads missing.
// Invented utility and places; no network, no model.
//   npx tsx backend/test/utilityQcJobScope.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "utility-qc-scope-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.RUN_TRIAGE = "off";
delete process.env.ANTHROPIC_API_KEY;

const { evaluateBaselineRules } = await import("../src/baselineRules");
const { openDatabase } = await import("../src/db");
const repo = await import("../src/repository");
const { runQcForProject } = await import("../src/qc");
const { setPersonJobScope } = await import("../src/jobScope");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// An invented utility no shipped record names, in a real state code, so QC checks the strict default.
const WHERE = { state: "NV", utility: "Fernvale Valley Electric" };
const RULE = "utility-requirements-not-researched";
const BATTERY = { hasBattery: "yes", batteryQty: "1" };
const SHEETS_NO = { newModulesOnSchedule: "no", newModulesOnSld: "no" };
const EXISTING = { hasExistingSystem: "yes", existingDcKw: "6.0" };
const missingOf = (payload: Record<string, unknown>, scope?: string): string => {
  const rs = evaluateBaselineRules({ ...WHERE, ...payload } as never, undefined, undefined, { reportUnresearched: true, ...(scope ? { scope: scope as never } : {}) });
  const msg = rs.find((r) => r.ruleId === RULE)?.message ?? "";
  return msg.split("may be missing: ")[1] ?? "";
};

console.log("\n(1) what the job installs");
check("a storage-only job (the plan set shows no new modules) is not asked for a module spec; its inverter is the battery inverter / PCS", () => {
  const m = missingOf({ ...BATTERY, ...SHEETS_NO });
  assert.ok(m, "the rule still reports the rest");
  assert.ok(!/module spec/.test(m), m);
  assert.match(m, /battery inverter \/ PCS spec/);
  assert.ok(!/(^|, )inverter spec/.test(m), m);
});
check("a battery added to existing PV is not asked for a module spec either", () => {
  const m = missingOf({ ...BATTERY, ...SHEETS_NO, ...EXISTING });
  assert.ok(!/module spec/.test(m), m);
});
check("a PCS sheet shows the battery inverter spec on a storage scope (and only there)", () => {
  assert.ok(!/PCS spec/.test(missingOf({ ...BATTERY, ...SHEETS_NO, splitPagesText: "ESS PCS spec sheet" })));
  assert.match(missingOf({ ...BATTERY, splitPagesText: "ESS PCS spec sheet" }), /(^|, )inverter spec/, "a PV job still needs the inverter named");
});
check("STRICT DEFAULT: a PV job, a PV + battery job and a battery job whose plan set does not say 'no new modules' keep the module spec", () => {
  assert.match(missingOf({}), /module spec/);
  assert.match(missingOf({ ...BATTERY, moduleModel: "BL-400" }), /module spec/);
  assert.match(missingOf({ ...BATTERY }), /module spec/);
});
check("the scope qc.ts resolves wins over the payload alone (a named person's storage scope; and back)", () => {
  assert.ok(!/module spec/.test(missingOf({ ...BATTERY }, "storage-only")));
  assert.match(missingOf({ ...BATTERY, ...SHEETS_NO }, "pv+storage"), /module spec/);
});

console.log("\n(2) the job's own battery mode");
check("batteryMode / exportMode that classify show the operating mode; one that does not still reads missing", () => {
  for (const mode of ["Backup only", "Non-export (zero export)", "Self-consumption with export"]) {
    assert.ok(!/battery operating mode/.test(missingOf({ ...BATTERY, batteryMode: mode })), mode);
  }
  assert.ok(!/battery operating mode/.test(missingOf({ ...BATTERY, exportMode: "non-export" })));
  assert.match(missingOf({ ...BATTERY, batteryMode: "TBD" }), /battery operating mode/);
  assert.match(missingOf({ ...BATTERY }), /battery operating mode/);
});

console.log("\nthrough QC (runQcForProject)");
const db = await openDatabase();
const BASE = {
  owner: "Juniper Okafor", street: "41 Larkspur Lane", city: "Fernvale", zip: "89999", ahj: "City of Fernvale", ...WHERE,
  account: "11122233", meter: "M445566", permitPath: "prescriptive", mounting: "Roof Mount",
};
let n = 0;
const project = (payload: Record<string, unknown>): string => {
  n += 1;
  return repo.createProject(db, { ...BASE, owner: `${BASE.owner} ${n}`, street: `${40 + n} Larkspur Lane`, ...payload } as never, undefined, { learningExcluded: true }).project.id;
};
const qcMessage = (id: string): string => db.get<{ message: string }>("SELECT message FROM qc_results WHERE project_id = ? AND rule_id = ?", [id, RULE])?.message ?? "";
const STORAGE = { ...BATTERY, batteryMake: "Stillwater", batteryModel: "SW-13", batteryCapacityKwh: "13.5", batteryOutputKw: "5", essInverterModel: "SW-PCS5", batteryMode: "Backup only", essBreaker: "30" };
check("a storage-only job with its mode set: no module spec and no operating mode in the utility row", () => {
  const id = project({ ...STORAGE, ...SHEETS_NO });
  runQcForProject(db, id);
  const msg = qcMessage(id);
  assert.ok(msg, "the utility row is there");
  assert.ok(!/module spec|battery operating mode/.test(msg), msg);
});
check("a named person's storage-only scope on a battery job reaches the utility row; clearing it brings the module spec back", () => {
  const id = project({ ...STORAGE });
  runQcForProject(db, id);
  assert.match(qcMessage(id), /module spec/);
  setPersonJobScope(db, id, "storage-only", "Pat Reviewer");
  runQcForProject(db, id);
  assert.ok(!/module spec/.test(qcMessage(id)), qcMessage(id));
  setPersonJobScope(db, id, null, "Pat Reviewer");
  runQcForProject(db, id);
  assert.match(qcMessage(id), /module spec/);
});
db.close();

console.log(failures ? `\n${failures} failed` : "\nall passed");
if (failures) process.exit(1);
