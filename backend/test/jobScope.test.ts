// ISSUE #673 — battery-only and battery-added-to-existing-solar jobs. QC assumed new PV on every job:
// a battery-only job blocked on DC kW, AC kW, module make / model / wattage / quantity, inverter output
// and the PV breaker (roadmap's scratch run). This pins:
//   (1) a PV job's QC is UNCHANGED: the same rows, and today's module blockers still fail;
//   (2) a storage-only job (plan set: battery, no new modules on BOTH the schedule and the SLD) passes
//       with battery facts and is BLOCKED without them — equal strictness, one blocker per fact;
//   (3) an ambiguous battery job (no sheet statement) stays pv: the 8 PV blockers stay;
//   (4) the evidence wins: new-module fields keep the PV rows, even against a person's storage scope;
//   (5) a person's scope: storage-only on a clean battery job swaps the rows; an existing PV system
//       makes it an addition, which owes the existing-system disclosure (size + tariff);
//   (6) the operating mode must classify (self-consumption alone does not);
//   (7) a scope change closes the pending items the out-of-scope rows filed, and only those;
//   (8) the utility track stays on for storage; a storage-mode exemption is only a person's cited
//       record on the utility's row, and it never applies to a job with new PV.
// Invented names; no network, no browser, no LLM.
//
// KILL TEST: make checksForScope return criticalChecks for every scope → (2), (5) fail; make
// deriveJobScope trust a person's storage scope over module evidence → (4) fails.
//
// Run: npx tsx backend/test/jobScope.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-scope-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.RUN_TRIAGE = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const repo = await import("../src/repository");
const { runQcForProject, checksForScope } = await import("../src/qc");
const { deriveJobScope, setPersonJobScope, classifyStorageMode } = await import("../src/jobScope");
const { recordUtilityStorageModes, nemStorageExemption, storageModeRecordUsable, quoteNamesStorageMode } = await import("../src/utilityStorageModes");
const { saveUtilityFilingLookup } = await import("../src/utilityFilingLookup");
const { requiredTracks } = await import("../src/submittalTracks");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const BASE = {
  owner: "Juniper Okafor", street: "41 Larkspur Lane", city: "Fernvale", state: "ZZ", zip: "00041",
  ahj: "City of Fernvale", utility: "Fernvale Valley Electric", account: "11122233", meter: "M445566",
  interco: "Load-side breaker", busRating: "200", mainBreaker: "200",
  permitPath: "prescriptive", locateCalloutText: "N/A - roof mount, no excavation", mounting: "Roof Mount",
};
const PV = { dcKw: "8.0", acKw: "6.4", moduleMake: "Brightleaf", moduleModel: "BL-400", moduleWattage: "400", moduleQty: "20", invModel: "MX-300", invQty: "20", invOutputW: "1.2", pvBreaker: "40" };
const BATTERY = { batteryMake: "Stillwater", batteryModel: "SW-13", batteryQty: "1", batteryCapacityKwh: "13.5", batteryOutputKw: "5", essInverterModel: "SW-PCS5", batteryMode: "Backup only", essBreaker: "30" };
const SHEETS_NO = { newModulesOnSchedule: "no", newModulesOnSld: "no" };

let n = 0;
function project(payload: Record<string, unknown>): string {
  n += 1;
  return repo.createProject(db, { ...BASE, owner: `${BASE.owner} ${n}`, street: `${40 + n} Larkspur Lane`, ...payload } as never, undefined, { learningExcluded: true }).project.id;
}
function rows(projectId: string): Map<string, { status: string; severity: string; message: string }> {
  return new Map(db.query<{ rule_id: string; qc_status: string; severity: string; message: string }>(
    "SELECT rule_id, qc_status, severity, message FROM qc_results WHERE project_id = ?", [projectId])
    .map((r) => [r.rule_id, { status: r.qc_status, severity: r.severity, message: r.message }]));
}
const failing = (projectId: string): string[] => [...rows(projectId)].filter(([, r]) => r.status === "fail").map(([k]) => k).sort();

const PV_EIGHT = ["critical.ac_kw", "critical.dc_kw", "critical.inverter_output", "critical.module_make", "critical.module_model", "critical.module_qty", "critical.module_wattage", "critical.pv_breaker"];
const TODAY = [
  "critical.homeowner", "critical.address", "critical.utility", "critical.ahj", "critical.account", "critical.meter",
  "critical.dc_kw", "critical.ac_kw", "critical.module_make", "critical.module_model", "critical.module_wattage", "critical.module_qty",
  "critical.inverter_model", "critical.inverter_qty", "critical.inverter_output", "critical.interconnection", "critical.bus",
  "critical.main_breaker", "critical.pv_breaker", "critical.permit_path", "critical.locates", "critical.required_files",
];

// (1) PV job unchanged.
check("(1) the pv and pv+storage scopes run exactly today's rows, in today's order", () => {
  assert.deepEqual(checksForScope("pv").map((c) => c.ruleId), TODAY);
  assert.deepEqual(checksForScope("pv+storage").map((c) => c.ruleId), TODAY);
});
const pvOk = project({ ...PV });
check("(1) a complete PV job passes, scoped pv from the plan set", () => {
  assert.deepEqual(failing(pvOk), []);
  assert.equal(repo.getProjectDetail(db, pvOk).jobScope?.scope, "pv");
});
const pvMissing = project({ ...PV, moduleModel: "", moduleWattage: "" });
check("(1) a PV job missing module facts still fails today's module blockers", () => {
  assert.deepEqual(failing(pvMissing), ["critical.module_model", "critical.module_wattage"]);
});

// (2) storage-only from the plan set's own two sheets.
const storageOk = project({ ...BATTERY, ...SHEETS_NO });
check("(2) storage-only with battery facts: scoped from the plan set, passes, no PV module rows", () => {
  const view = repo.getProjectDetail(db, storageOk).jobScope!;
  assert.equal(view.scope, "storage-only");
  assert.equal(view.basis, "plan_set");
  assert.deepEqual(failing(storageOk), []);
  const r = rows(storageOk);
  for (const pvRule of PV_EIGHT) assert.ok(!r.has(pvRule), `${pvRule} should not run`);
  for (const s of ["battery_make", "battery_model", "battery_qty", "usable_kwh", "power_kw", "pcs_model", "operating_mode", "ess_breaker"]) {
    assert.equal(r.get(`critical.storage.${s}`)?.status, "pass", s);
  }
});
const storageBare = project({ batteryMake: "Stillwater", batteryModel: "SW-13", ...SHEETS_NO, batteryQty: "1" });
check("(2) storage-only without its battery facts is BLOCKED, one blocker per missing fact", () => {
  assert.equal(repo.getProjectDetail(db, storageBare).jobScope?.scope, "storage-only");
  assert.deepEqual(failing(storageBare), [
    "critical.storage.ess_breaker", "critical.storage.operating_mode", "critical.storage.pcs_model", "critical.storage.power_kw", "critical.storage.usable_kwh",
  ]);
  for (const id of failing(storageBare)) assert.equal(rows(storageBare).get(id)?.severity, "blocker");
});
const storageZero = project({ ...BATTERY, ...SHEETS_NO, batteryCapacityKwh: "0", batteryModel: "N/A", batteryQty: "2" });
check("(2) a zero kWh or a placeholder battery model is not a battery fact", () => {
  const f = failing(storageZero);
  assert.ok(f.includes("critical.storage.usable_kwh"), f.join(","));
  assert.ok(f.includes("critical.storage.battery_model"), f.join(","));
});

// (3) ambiguous stays pv.
const ambiguous = project({ ...BATTERY });
check("(3) a battery job with no sheet statement stays pv: the roadmap's 8 PV blockers stay", () => {
  const view = repo.getProjectDetail(db, ambiguous).jobScope!;
  assert.equal(view.scope, "pv");
  assert.equal(view.basis, "default");
  for (const rule of PV_EIGHT) assert.ok(failing(ambiguous).includes(rule), rule);
});
const halfStated = project({ ...BATTERY, newModulesOnSchedule: "no" });
check("(3) the schedule alone saying no new modules is not enough (both sheets must)", () => {
  assert.equal(repo.getProjectDetail(db, halfStated).jobScope?.scope, "pv");
});

// (4) evidence wins.
const conflicting = project({ ...BATTERY, ...SHEETS_NO, moduleModel: "BL-400" });
check("(4) a new-module field anywhere keeps the PV rows, whatever the sheet answers say", () => {
  const view = repo.getProjectDetail(db, conflicting).jobScope!;
  assert.equal(view.scope, "pv+storage");
  assert.ok(view.newModuleEvidence.includes("moduleModel"));
  assert.ok(failing(conflicting).includes("critical.module_make"));
});
check("(4) a person's storage scope against new-module fields is a conflict: PV rows stay, QC warns", () => {
  setPersonJobScope(db, conflicting, "storage-only", "Pat Reviewer");
  runQcForProject(db, conflicting);
  const view = repo.getProjectDetail(db, conflicting).jobScope!;
  assert.ok(view.conflict.includes("Pat Reviewer"), view.conflict);
  assert.equal(view.personScope, "storage-only");
  assert.ok(failing(conflicting).includes("critical.module_make"));
  assert.equal(rows(conflicting).get("qc.job_scope")?.status, "warning");
});
check("(4) the DC size counts as new PV unless it is the existing system's own size", () => {
  assert.equal(deriveJobScope({ ...BATTERY, ...SHEETS_NO, dcKw: "7.2" } as never).scope, "pv+storage");
  assert.equal(deriveJobScope({ ...BATTERY, ...SHEETS_NO, dcKw: "7.2", existingDcKw: "7.2" } as never).scope, "storage-added-to-existing-pv");
});

// (5) a person's scope.
const personStorage = project({ ...BATTERY });
check("(5) a person's storage-only on a clean battery job swaps the rows", () => {
  assert.ok(failing(personStorage).includes("critical.module_make"));
  setPersonJobScope(db, personStorage, "storage-only", "Pat Reviewer");
  runQcForProject(db, personStorage);
  const view = repo.getProjectDetail(db, personStorage).jobScope!;
  assert.equal(view.basis, "person");
  assert.equal(view.scope, "storage-only");
  assert.deepEqual(failing(personStorage), []);
});
check("(7) the scope change closed the pending module items QC had filed", () => {
  const pending = db.query<{ field_name: string }>("SELECT field_name FROM human_review_items WHERE project_id = ? AND status = 'pending'", [personStorage]).map((r) => r.field_name);
  for (const f of ["moduleMake", "moduleModel", "moduleWattage", "moduleQty", "pvBreaker"]) assert.ok(!pending.includes(f), `${f} still pending`);
});
check("(7) clearing the scope brings the PV rows and their items back", () => {
  setPersonJobScope(db, personStorage, null, "Pat Reviewer");
  runQcForProject(db, personStorage);
  assert.ok(failing(personStorage).includes("critical.module_make"));
  const pending = db.query<{ field_name: string }>("SELECT field_name FROM human_review_items WHERE project_id = ? AND status = 'pending'", [personStorage]).map((r) => r.field_name);
  assert.ok(pending.includes("moduleMake"));
});
const parserItem = project({ ...BATTERY });
check("(7) a pending item another door filed on the same field is not closed by a scope change", () => {
  db.run(`INSERT INTO human_review_items (id, project_id, issue_type, field_name, parser_value, llm_suggested_value, source_excerpt, status, notes, created_at, updated_at)
          VALUES ('hri-parser-1', ?, 'Low-confidence parser field', 'pvBreaker', '', '', '', 'pending', '', ?, ?)`, [parserItem, new Date().toISOString(), new Date().toISOString()]);
  setPersonJobScope(db, parserItem, "storage-only", "Pat Reviewer");
  runQcForProject(db, parserItem);
  assert.equal(db.get<{ status: string }>("SELECT status FROM human_review_items WHERE id = 'hri-parser-1'")?.status, "pending");
});
const addition = project({ ...BATTERY, existingSystem: "yes" });
check("(5) storage on a site with existing PV is an addition: the existing-system disclosure is owed", () => {
  setPersonJobScope(db, addition, "storage-only", "Pat Reviewer");
  runQcForProject(db, addition);
  assert.equal(repo.getProjectDetail(db, addition).jobScope?.scope, "storage-added-to-existing-pv");
  assert.deepEqual(failing(addition), ["critical.storage.existing_size", "critical.storage.existing_tariff"]);
});
const additionOk = project({ ...BATTERY, ...SHEETS_NO, existingSystem: "yes", existingDcKw: "6.0", nemTariff: "Schedule NM-2" });
check("(5) an addition with its existing size and tariff passes, scoped from the plan set", () => {
  assert.equal(repo.getProjectDetail(db, additionOk).jobScope?.scope, "storage-added-to-existing-pv");
  assert.deepEqual(failing(additionOk), []);
});

// (6) operating mode.
check("(6) the operating mode classifies export / non-export / backup-only, and nothing vaguer", () => {
  assert.equal(classifyStorageMode("Backup only"), "backup-only");
  assert.equal(classifyStorageMode("Non-export (PCS limited)"), "non-export");
  assert.equal(classifyStorageMode("export"), "export");
  assert.equal(classifyStorageMode("self-consumption"), "");
});
const vagueMode = project({ ...BATTERY, ...SHEETS_NO, batteryMode: "self-consumption" });
check("(6) a storage job whose mode does not say export / non-export / backup-only is blocked", () => {
  assert.deepEqual(failing(vagueMode), ["critical.storage.operating_mode"]);
});
const exportModeOnly = project({ ...BATTERY, ...SHEETS_NO, batteryMode: "", exportMode: "non-export-pcs" });
check("(6) the job's exportMode answers the mode when batteryMode is blank", () => {
  assert.deepEqual(failing(exportModeOnly), []);
});

// (8) the utility track and the storage-mode record.
check("(8) the utility track stays on for every storage scope", () => {
  for (const id of [storageOk, additionOk]) assert.ok(requiredTracks(repo.getProjectDetail(db, id).project).includes("nem"));
});
check("(8) no record without the utility's filing row (never invented)", () => {
  const r = recordUtilityStorageModes(db, { state: "ZZ", utility: "Fernvale Valley Electric" }, { modesWithoutApplication: ["backup-only"], sourceUrl: "https://fernvale-electric.invalid/storage", quote: "Backup-only battery systems do not need an interconnection application.", verifiedBy: "Pat Reviewer" });
  assert.equal(r.saved, false);
});
saveUtilityFilingLookup(db, {
  state: "ZZ", utility: "Fernvale Valley Electric", lookedUpAt: new Date().toISOString(),
  filing: { value: { name: "Interconnection portal", url: null }, sourceUrl: "https://fernvale-electric.invalid/apply", quote: "Apply on our Interconnection portal.", origin: "lookup" } as never,
  program: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not stated" } as never,
});
check("(8) a record whose words do not name the mode is refused", () => {
  const r = recordUtilityStorageModes(db, { state: "ZZ", utility: "Fernvale Valley Electric" }, { modesWithoutApplication: ["backup-only"], sourceUrl: "https://fernvale-electric.invalid/storage", quote: "Battery systems are reviewed case by case.", verifiedBy: "Pat Reviewer" });
  assert.equal(r.saved, false);
  assert.equal(storageModeRecordUsable({ modesWithoutApplication: ["backup-only"], sourceUrl: "https://x.invalid", quote: "Backup-only battery systems need no application.", verifiedBy: "", verifiedAt: "2026-11-10" }), false, "unnamed person");
});
check("(8) words about NON-export storage never name the export mode", () => {
  for (const q of [
    "Non-export battery systems do not need an interconnection application.",
    "Zero-export storage with a PCS needs no application.",
    "Batteries that do not export to the grid are exempt.",
    "Export-limited energy storage is reviewed without an application.",
  ]) {
    assert.equal(quoteNamesStorageMode.export(q), false, q);
    assert.equal(quoteNamesStorageMode["non-export"](q), true, q);
  }
  assert.equal(quoteNamesStorageMode.export("Battery systems that export to the grid need no separate application."), true);
  const r = recordUtilityStorageModes(db, { state: "ZZ", utility: "Fernvale Valley Electric" }, { modesWithoutApplication: ["export"], sourceUrl: "https://fernvale-electric.invalid/storage", quote: "Non-export battery systems do not need an interconnection application.", verifiedBy: "Pat Reviewer" });
  assert.equal(r.saved, false, "a non-export quote recorded the export mode");
});
check("(8) no exemption before a person records one (the default files)", () => {
  assert.equal(nemStorageExemption(db, repo.getProjectDetail(db, storageOk).project), null);
});
check("(8) a person's cited record exempts a backup-only storage job, and QC says so; the track stays", () => {
  const r = recordUtilityStorageModes(db, { state: "ZZ", utility: "Fernvale Valley Electric" }, { modesWithoutApplication: ["backup-only"], sourceUrl: "https://fernvale-electric.invalid/storage", quote: "Backup-only battery systems that never operate in parallel do not need an interconnection application.", verifiedBy: "Pat Reviewer" });
  assert.equal(r.saved, true, r.reason);
  const p = repo.getProjectDetail(db, storageOk).project;
  assert.equal(nemStorageExemption(db, p)?.mode, "backup-only");
  runQcForProject(db, storageOk);
  assert.ok(rows(storageOk).get("qc.nem_storage_mode")?.message.includes("Pat Reviewer"));
  assert.ok(requiredTracks(p).includes("nem"));
});
check("(8) the record never exempts a job with new PV, or a mode it does not list", () => {
  assert.equal(nemStorageExemption(db, repo.getProjectDetail(db, conflicting).project), null);
  assert.equal(nemStorageExemption(db, repo.getProjectDetail(db, exportModeOnly).project), null);
});

if (failures) { console.error(`\n${failures} jobScope check(s) FAILED.`); process.exit(1); }
console.log("\nAll jobScope checks passed.");
process.exit(0);
