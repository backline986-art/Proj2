// POWERCLERK STAGES READ AS WHAT THEY MEAN (#170).
//
// The NEM status read gets PowerClerk's stage outright — a grid row "APP-**0001 PP - AHJ Inspection
// And Signatures Needed 10/02/2026", a record page "Status marked as PP - … on 10/30/2026". The
// classifier knew "Application Submitted" and "Engineering Review" only by luck of wording, and read
// "AHJ Inspection And Signatures Needed" — the stage a live PacifiCorp filing sat in — as "Needs
// human review" at 0.45: a generic review item for a stage that names exactly what is owed.
//
// MUST-PASS: the issue's three rows. One platform mapping by meaning (another utility's program
// prefix and wording read the same); the record page's tab strip ("Application Received",
// "Technical Review") and its forms list ("PP - Cancellation Form") never speak for the stage; each
// new label has vetted client wording. Through the real writer, the inspection stage writes no
// human-review item.
// MUST-EXCLUDE: a permit reading, or text with no PowerClerk shape, using the same words keeps
// today's classification; a stage nobody knows stays "Needs human review"; a stage the general rules
// already answer ("Application Approved") reads exactly as before.
//   npx tsx backend/test/powerClerkStages.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "powerclerk-stages-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { classifyPermitStatusText, powerClerkStageOf, POWERCLERK_STAGE_LABELS } = await import("../src/permitMonitor");
const { publicCheckLabel } = await import("../src/clientPortal");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Synthetic rows in PowerClerk's shapes (masked record ids; no real application).
const row = (stage: string, program = "PP"): string => `APP-**0001 ${program} - ${stage} 10/02/2026 Residential Solar`;
const recordPage = (stage: string): string =>
  "Home Projects Tools View/Edit: APP-**3456 Application Received Technical Review Current Status "
  + `Status marked as ${stage} on 10/30/2026 at 9:31 AM Project Owner Forms `
  + "PP - Suspended - Changes Needed From Customer Begin PP - Cancellation Form Begin";
const read = (text: string, track: "nem" | "permit" = "nem"): [string, string] => {
  const c = classifyPermitStatusText(text, track);
  return [c.outcome, c.statusLabel];
};

await check("MUST-PASS: the issue's three rows", () => {
  assert.deepEqual(read(row("Engineering Review")), ["waiting", "In review"]);
  assert.deepEqual(read(row("Application Submitted")), ["waiting", "In review"]);
  const c = classifyPermitStatusText(row("AHJ Inspection And Signatures Needed"), "nem");
  assert.notEqual(c.statusLabel, "Needs human review", "the known stage fell through to the generic review again");
  assert.deepEqual([c.outcome, c.statusLabel], ["waiting", POWERCLERK_STAGE_LABELS.inspectionAndSignatures]);
  assert.ok(c.confidence >= 0.8, `confidence ${c.confidence}`);
  assert.match(c.message, /final inspection/i);
  assert.match(c.message, /signatures/i);
});

await check("the stage is read without the tenant's program prefix, and the tab strip / forms list never speak for it", () => {
  assert.equal(powerClerkStageOf(row("AHJ Inspection And Signatures Needed")), "AHJ Inspection And Signatures Needed");
  assert.equal(powerClerkStageOf(recordPage("PP - AHJ Inspection And Signatures Needed")), "AHJ Inspection And Signatures Needed");
  assert.equal(powerClerkStageOf("PP - Engineering Review as of 9/2/2026 (APP-111651). Verified logged-in on the PowerClerk Projects grid."), "Engineering Review");
  // The tabs say "Application Received" / "Technical Review" on every record: the stage wins.
  assert.deepEqual(read(recordPage("PP - AHJ Inspection And Signatures Needed")), ["waiting", POWERCLERK_STAGE_LABELS.inspectionAndSignatures]);
  assert.deepEqual(read(recordPage("PP - Application Submitted")), ["waiting", "In review"]);
});

await check("one mapping by MEANING: another utility's prefix and wording read the same", () => {
  assert.deepEqual(read(row("Final Inspection Required", "RMP")), ["waiting", POWERCLERK_STAGE_LABELS.inspection]);
  assert.deepEqual(read(row("Pending Customer Signature", "PSE")), ["waiting", POWERCLERK_STAGE_LABELS.signatures]);
  assert.deepEqual(read(recordPage("Signatures and AHJ Inspection Pending")), ["waiting", POWERCLERK_STAGE_LABELS.inspectionAndSignatures]);
  assert.deepEqual(read(row("Supplemental Review")), ["waiting", "In review"]);
  assert.deepEqual(read(row("Suspended - Changes Needed From Customer")), ["needs_human_review", POWERCLERK_STAGE_LABELS.changesNeeded]);
  assert.deepEqual(read(row("Withdrawn")), ["needs_human_review", POWERCLERK_STAGE_LABELS.closed]);
});

await check("a stage that is DONE is not owed: 'Signatures Received' is not waiting on signatures", () => {
  assert.notEqual(read(row("Signatures Received"))[1], POWERCLERK_STAGE_LABELS.signatures);
  assert.notEqual(read(row("AHJ Inspection Complete"))[1], POWERCLERK_STAGE_LABELS.inspection);
});

await check("MUST-EXCLUDE: a stage nobody knows stays 'Needs human review'", () => {
  for (const s of ["Meter Set", "Field Verification", "Draft"]) assert.deepEqual(read(row(s)), ["needs_human_review", "Needs human review"], s);
});

await check("MUST-EXCLUDE: stages the general rules answer read exactly as before", () => {
  assert.deepEqual(read(row("Application Approved")), ["nem_approved", "NEM / interconnection approved"]);
  assert.deepEqual(read(row("Permission to Operate")), ["nem_approved", "NEM / interconnection approved"]);
  assert.deepEqual(read(row("Incomplete Application")), ["correction_flagged", "Correction flagged"]);
});

await check("MUST-EXCLUDE: non-PowerClerk text and permit readings with the same words keep today's classification", () => {
  const accela = (status: string): string =>
    `Record 187-26-000999-STR: Residential Structural Record Status: ${status} Expiration Date: 03/16/2027 Processing Status`;
  for (const s of ["AHJ Inspection And Signatures Needed", "Signatures Needed", "Withdrawn"]) {
    assert.deepEqual(read(accela(s), "permit"), ["needs_human_review", "Needs human review"], `permit Accela "${s}"`);
    assert.deepEqual(read(accela(s), "nem"), ["needs_human_review", "Needs human review"], `nem Accela "${s}"`);
    assert.deepEqual(read(s, "nem"), ["needs_human_review", "Needs human review"], `bare "${s}" with no PowerClerk shape`);
  }
  // A PowerClerk-shaped row on a PERMIT target is not read with the utility's vocabulary.
  assert.deepEqual(read(row("AHJ Inspection And Signatures Needed"), "permit"), ["needs_human_review", "Needs human review"]);
  assert.equal(powerClerkStageOf("Record 187-26-000999-STR Status: STR - Signatures Needed"), "", "no PowerClerk record id or wording");
});

await check("a grid of several applications in different stages is not one stage", () => {
  assert.equal(powerClerkStageOf(`${row("Application Submitted")} APP-**0002 PP - Engineering Review 10/03/2026`), "");
});

await check("every new label has vetted client wording on both tracks (never the raw label)", () => {
  for (const [outcome, label] of [
    ["waiting", POWERCLERK_STAGE_LABELS.inspectionAndSignatures],
    ["waiting", POWERCLERK_STAGE_LABELS.inspection],
    ["waiting", POWERCLERK_STAGE_LABELS.signatures],
    ["needs_human_review", POWERCLERK_STAGE_LABELS.changesNeeded],
    ["needs_human_review", POWERCLERK_STAGE_LABELS.closed],
  ] as const) {
    for (const track of ["nem", "permit"] as const) {
      const words = publicCheckLabel(outcome, label, track);
      assert.ok(words && words !== label, `${outcome}::${label} (${track}) passes through raw: "${words}"`);
      assert.match(words, /utility/, `${outcome}::${label} (${track}) does not name who holds it: "${words}"`);
    }
  }
  assert.match(publicCheckLabel("waiting", POWERCLERK_STAGE_LABELS.inspectionAndSignatures, "nem"), /final inspection and signatures/);
});

await check("through the real writer: the inspection stage is a named wait, with no generic human-review item", async () => {
  const pid = R.createProject(db, {
    owner: "Stage Probe Owner", state: "OR", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
    street: "1 Test Way", city: "Testville", zip: "97000", ahj: "City of Testville", utility: "Pacific Power",
  } as never).project.id;
  const detail = R.createPermitCheckTarget(db, pid, {
    jurisdiction: "Pacific Power", portalName: "Pacific Power NEM portal (PowerClerk)",
    portalUrl: "", applicationNumber: "APP-**0001", permitType: "nem", targetType: "nem",
  } as never) as unknown as { permitCheckTargets: Array<{ id: string; targetType: string }> };
  const tid = detail.permitCheckTargets.find((t) => t.targetType === "nem")!.id;
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [pid]);
  await R.recordPermitStatusCheck(db, pid, { targetId: tid, source: "manual", rawStatusText: row("AHJ Inspection And Signatures Needed") });
  const target = db.get<{ latest_outcome: string; latest_status_label: string }>("SELECT latest_outcome, latest_status_label FROM permit_check_targets WHERE id = ?", [tid])!;
  assert.deepEqual([target.latest_outcome, target.latest_status_label], ["waiting", POWERCLERK_STAGE_LABELS.inspectionAndSignatures]);
  const items = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM human_review_items WHERE project_id = ? AND field_name = 'permit_status' AND status = 'pending'", [pid])?.n ?? 0);
  assert.equal(items, 0, "a known PowerClerk stage raised a generic 'Permit monitor status review' item");
});

if (failures) { console.error(`\n${failures} PowerClerk stage test(s) failed.`); process.exit(1); }
console.log("\nAll PowerClerk stage tests passed.");
