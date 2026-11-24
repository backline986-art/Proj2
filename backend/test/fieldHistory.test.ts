// WHAT INTAKE READ FOR EACH FIELD, AND WHO CHANGED IT (field history, migration v92; fieldHistory.ts).
//
//   (I) creation records intake's read of EVERY short field (not only the 27 aliased ones) as "intake";
//       a narrative over the cap is not a field.
//   (C) a later save records ONLY the fields it changed, with the value before; a re-sent snapshot
//       that changes nothing records nothing.
//   (W) who: a named person's save is human-verified and names them; the client form, the bill reader
//       and an unnamed dashboard save are recorded by source, never as a person.
//   (A) the audit row lists the changed field NAMES and never a value.
//   (H) projectFieldHistory folds pre-v92 full re-writes (same value again) out of the changes.
//   (R) intakeFieldAccuracy returns counts only and leaves fixtures (learning_excluded) out.
//
// KILL TESTS: write every field on every save → C fails; mark an unnamed save human_verified → W
// fails; put values in the audit row → A fails.
//
// Run: npx tsx backend/test/fieldHistory.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "field-history-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createProject, updateProject } = await import("../src/repository");
const { projectFieldHistory, intakeFieldAccuracy } = await import("../src/fieldHistory");
const db = await openDatabase();

let failed = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) console.log(`ok   - ${name}`);
  else { failed++; console.log(`FAIL - ${name}${detail === undefined ? "" : ` (got ${JSON.stringify(detail)})`}`); }
};

type FieldRow = { field_name: string; field_value: string; previous_value: string | null; source_method: string; human_verified: number; changed_by: string };
const rows = (projectId: string): FieldRow[] =>
  db.query<FieldRow>("SELECT field_name, field_value, previous_value, source_method, human_verified, changed_by FROM extracted_fields WHERE project_id = ? ORDER BY created_at, rowid", [projectId]);

const base = {
  owner: "Test Owner", street: "100 Example St", city: "Testville", state: "OR", zip: "97000",
  ahj: "City of Testville", utility: "Test Utility", dcKw: 8, acKw: 7.6, account: "1234567890",
  moduleMake: "TestSolar", moduleModel: "TS-400", moduleQty: "20", busRating: "200", mainBreaker: "200",
  roofMaterial: "Comp shingle", homeownerEmail: "",
  sitePlanNotesText: "x".repeat(800),
};

const created = createProject(db, { ...base });
const pid = created.project.id;

// (I)
{
  const intake = rows(pid);
  const names = new Set(intake.map((r) => r.field_name));
  check("I1 every intake row is source 'intake', unverified, unnamed", intake.length > 0 && intake.every((r) => r.source_method === "intake" && r.human_verified === 0 && r.changed_by === ""), intake.slice(0, 3));
  check("I2 an aliased field is recorded (owner)", names.has("owner"));
  check("I3 a field outside the 27 aliases is recorded too (roofMaterial)", names.has("roofMaterial"));
  check("I4 a blank value is not a read", !names.has("homeownerEmail"));
  check("I5 a narrative over the cap is not a field", !names.has("sitePlanNotesText"));
}

// (C) + (W): an unnamed dashboard save
{
  const before = rows(pid).length;
  updateProject(db, pid, { ...base }, { changeSource: "dashboard" });
  check("C1 a re-sent snapshot that changes nothing records nothing", rows(pid).length === before, rows(pid).length - before);

  updateProject(db, pid, { mainBreaker: "225" }, { changeSource: "dashboard" });
  const added = rows(pid).slice(before);
  check("C2 one save, one changed field, one row", added.length === 1 && added[0].field_name === "mainBreaker", added);
  check("C3 the row carries the value before and after", added[0]?.previous_value === "200" && added[0]?.field_value === "225", added[0]);
  check("W1 an unnamed save is recorded by its source, not as a person", added[0]?.source_method === "dashboard" && added[0]?.human_verified === 0 && added[0]?.changed_by === "", added[0]);
}

// (W): a named person, the client form, the bill reader
{
  const before = rows(pid).length;
  updateProject(db, pid, { moduleModel: "TS-410" }, { editedBy: "Dana Staff", changeSource: "dashboard" });
  updateProject(db, pid, { homeownerEmail: "owner@example.test" }, { changeSource: "client form" });
  updateProject(db, pid, { account: "1234567899" }, { changeSource: "bill reader" });
  const added = rows(pid).slice(before);
  const by = (f: string) => added.find((r) => r.field_name === f);
  check("W2 a named person's change is human-verified and names them", by("moduleModel")?.source_method === "human" && by("moduleModel")?.human_verified === 1 && by("moduleModel")?.changed_by === "Dana Staff", by("moduleModel"));
  check("W3 the client form fills a field intake left blank: no value before", by("homeownerEmail")?.source_method === "client form" && by("homeownerEmail")?.previous_value === null && by("homeownerEmail")?.human_verified === 0, by("homeownerEmail"));
  check("W4 the bill reader is recorded by source", by("account")?.source_method === "bill reader" && by("account")?.previous_value === "1234567890", by("account"));
}

// (A)
{
  const audit = db.query<{ actor_type: string; actor_name: string; details: string }>(
    "SELECT actor_type, actor_name, details FROM audit_logs WHERE project_id = ? AND action = 'project.updated_from_parser_snapshot' ORDER BY created_at, rowid", [pid]);
  const named = audit.find((a) => a.actor_name === "Dana Staff");
  check("A1 the person's save is audited as theirs, with the changed field name", named?.actor_type === "human" && JSON.parse(named.details).changed?.includes("moduleModel"), named);
  const bill = audit.find((a) => a.actor_name === "bill reader");
  check("A2 a reader's save is audited as the reader", bill?.actor_type === "system" && JSON.stringify(JSON.parse(bill.details).changed) === JSON.stringify(["account"]), bill);
  check("A3 no audit row carries a value", audit.every((a) => !a.details.includes("1234567899") && !a.details.includes("owner@example.test") && !a.details.includes("TS-410")), audit.map((a) => a.details));
}

// (H)
{
  // A pre-v92 save re-wrote every field, same value, as "human": folded out of the changes.
  db.run(`INSERT INTO extracted_fields (id, project_id, field_name, field_value, source_method, human_verified, notes, created_at)
          VALUES ('legacy-1', ?, 'roofMaterial', 'Comp shingle', 'human', 1, '', '2999-01-01T00:00:00.000Z')`, [pid]);
  const h = projectFieldHistory(db, pid);
  const f = (n: string) => h.find((x) => x.field === n);
  check("H1 a field nobody changed has intake's read and no changes", f("roofMaterial")?.intakeValue === "Comp shingle" && f("roofMaterial")?.changes.length === 0, f("roofMaterial"));
  check("H2 a person's change: intake value, current value, who", f("moduleModel")?.intakeValue === "TS-400" && f("moduleModel")?.currentValue === "TS-410" && f("moduleModel")?.changedByPerson === true && f("moduleModel")?.changes[0]?.by === "Dana Staff", f("moduleModel"));
  check("H3 a field filled later has no intake value", f("homeownerEmail")?.intakeValue === null && f("homeownerEmail")?.currentValue === "owner@example.test", f("homeownerEmail"));
}

// (R)
{
  const fixture = createProject(db, { ...base, moduleModel: "TS-999" }, undefined, { learningExcluded: true });
  updateProject(db, fixture.project.id, { moduleModel: "TS-998" }, { editedBy: "Dana Staff" });
  const report = intakeFieldAccuracy(db, DEFAULT_ORG_ID);
  const r = (n: string) => report.fields.find((x) => x.field === n);
  check("R1 the fixture is left out", report.projects === 1, report.projects);
  check("R2 counts per field", r("moduleModel")?.read === 1 && r("moduleModel")?.changedByPerson === 1
    && r("mainBreaker")?.changedOtherwise === 1 && r("homeownerEmail")?.filledLater === 1 && r("roofMaterial")?.changedByPerson === 0, report.fields.slice(0, 6));
  const json = JSON.stringify(report);
  check("R3 the report carries no value", !json.includes("TS-410") && !json.includes("1234567") && !json.includes("owner@example.test") && !json.includes(pid), json.slice(0, 200));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall field history checks passed");
process.exit(failed ? 1 : 0);
