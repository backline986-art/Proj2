// A NEM CORRECTION NAMES THE UTILITY, NOT THE CITY (#617).
//
// clientUpdateFor's correction headline always read "<AHJ> has sent <the application> back with a
// correction". On the interconnection track the client was told the CITY returned a filing the city
// never saw. The filed event and nem_approved already ask the track; the correction did not. That is
// also why #170 held PowerClerk's "Suspended - Changes Needed From Customer" as a human-review
// reading: as a correction it would have sent this wrong-agency email. It is a correction now.
//
// MUST-PASS: a NEM correction names project.utility (else "the utility") and "the interconnection
// application", never the AHJ — including a legacy 'permit'-typed NEM filing (trackKind). Through
// the real writer, the PowerClerk changes-needed stage opens a correction (no generic review item)
// and the client's update note names the utility.
// MUST-EXCLUDE: a permit correction's update is byte-identical to main.
//   npx tsx backend/test/nemCorrectionUpdate.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nem-correction-update-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
// Client notifications ON (the note is the thing under test); no mail server, so nothing is sent.
delete process.env.CLIENT_NOTIFICATIONS;
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const { createClient } = await import("../src/clients");
const { clientUpdateFor } = await import("../src/clientUpdates");
const { POWERCLERK_STAGE_LABELS } = await import("../src/permitMonitor");

const db = await openDatabase();
let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// Synthetic project: a city and a utility with no words in common, so a leak of either is visible.
// A client, so the notifier writes its update note (a project with no client is silenced).
const client = createClient(db, { companyName: "Probe Solar", ccbLicenseNumber: "343434", businessEmail: "ops@probe.test" });
const project = R.createProject(db, {
  clientId: client.id, owner: "Correction Probe Owner", state: "UT", dcKw: "8.4", acKw: "7.7", permitPath: "prescriptive",
  street: "1 Test Way", city: "Testville", zip: "84000", ahj: "City of Testville", utility: "Mountain Grid Power",
} as never).project;

const ROUTINE = "The reviewer wants changes before it can go further. This is routine and it is not a rejection.";
const NOTHING_YET = "Nothing for you to do yet. We are reading exactly what they asked for and will come back to you with it — and tell you if we need anything from your designer.";

await check("MUST-PASS: a NEM correction names the utility and the interconnection application, never the AHJ", () => {
  const u = clientUpdateFor(db, project, "correction_flagged", { targetType: "nem", applicationNumber: "APP-**0001" })!;
  assert.ok(u, "no wording for a NEM correction");
  assert.equal(u.headline, "Mountain Grid Power has sent the interconnection application back with a correction, reference APP-**0001.");
  assert.doesNotMatch(`${u.subject} ${u.headline} ${u.meaning} ${u.action}`, /Testville/, "the city is named on a utility's correction");
});

await check("MUST-PASS: no utility on the project reads 'the utility', never the AHJ", () => {
  const u = clientUpdateFor(db, { ...project, utility: "" }, "correction_flagged", { targetType: "nem" })!;
  assert.equal(u.headline, "the utility has sent the interconnection application back with a correction.");
});

await check("MUST-PASS: a legacy 'permit'-typed NEM filing is the utility's too (trackKind, the one track answer)", () => {
  const u = clientUpdateFor(db, project, "correction_flagged", { targetType: "permit", permitType: "nem" })!;
  assert.match(u.headline, /^Mountain Grid Power has sent the interconnection application back/, u.headline);
});

await check("MUST-EXCLUDE: a permit correction's update is byte-identical to main", () => {
  assert.deepEqual(clientUpdateFor(db, project, "correction_flagged", { targetType: "permit", permitType: "building", permitNumber: "STR-26-0001" }), {
    subject: "Correction requested",
    headline: "City of Testville has sent the building permit application back with a correction, reference STR-26-0001.",
    meaning: ROUTINE,
    action: NOTHING_YET,
  });
  assert.deepEqual(clientUpdateFor(db, project, "correction_flagged", { targetType: "permit" }), {
    subject: "Correction requested",
    headline: "City of Testville has sent the application back with a correction.",
    meaning: ROUTINE,
    action: NOTHING_YET,
  });
});

await check("through the real writer: PowerClerk 'Changes Needed' opens a correction and the client note names the utility", async () => {
  const detail = R.createPermitCheckTarget(db, project.id, {
    jurisdiction: "Mountain Grid Power", portalName: "Mountain Grid Power NEM portal (PowerClerk)",
    portalUrl: "", applicationNumber: "APP-**0001", permitType: "nem", targetType: "nem",
  } as never) as unknown as { permitCheckTargets: Array<{ id: string; targetType: string }> };
  const tid = detail.permitCheckTargets.find((t) => t.targetType === "nem")!.id;
  db.run("UPDATE projects SET status = 'submitted' WHERE id = ?", [project.id]);
  await R.recordPermitStatusCheck(db, project.id, {
    targetId: tid, source: "manual",
    rawStatusText: "APP-**0001 PP - Suspended - Changes Needed From Customer 10/02/2026 Residential Solar",
  });
  // The notifier is fired without await by the writer; let it run.
  await new Promise((r) => setTimeout(r, 200));
  const target = db.get<{ latest_outcome: string; latest_status_label: string }>("SELECT latest_outcome, latest_status_label FROM permit_check_targets WHERE id = ?", [tid])!;
  assert.deepEqual([target.latest_outcome, target.latest_status_label], ["correction_flagged", POWERCLERK_STAGE_LABELS.changesNeeded]);
  const corrections = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM corrections WHERE project_id = ?", [project.id])?.n ?? 0);
  assert.equal(corrections, 1, "the changes-needed stage opened no correction");
  const items = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM human_review_items WHERE project_id = ? AND field_name = 'permit_status' AND status = 'pending'", [project.id])?.n ?? 0);
  assert.equal(items, 0, "a correction stage still raised a generic 'Permit monitor status review' item");
  const notes = db.query<{ body: string }>("SELECT body FROM project_notes WHERE project_id = ? AND note_type = 'client_update'", [project.id]);
  assert.equal(notes.length, 1, `expected one client update note, got ${notes.length}`);
  assert.match(notes[0].body, /^Mountain Grid Power has sent the interconnection application back with a correction, reference APP-\*\*0001\./, notes[0].body);
  assert.doesNotMatch(notes[0].body, /Testville/, "the client note names the city");
});

if (failures) { console.error(`\n${failures} NEM correction update test(s) failed.`); process.exit(1); }
console.log("\nAll NEM correction update tests passed.");
