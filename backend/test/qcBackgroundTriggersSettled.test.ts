// QC'S BACKGROUND TRIGGERS CAN BE WAITED ON (CI stability round, worker-flakes).
//
// runQcForProject ends with a fire-and-forget research trigger (permit-process lookup, fee research,
// state fee rules, parcel check). It reads the process's switches only after an `await import()`, so
// a caller that changed a switch right after QC raced it: qcRejudgedOnLookup check 4 went red under
// --concurrency 4 when a late trigger read the lookup as ON and queued a lookup the test said must
// not exist. qc.qcBackgroundTriggersSettled() is the real condition to wait on instead of a sleep.
//
// Pinned:
//   1 ASYNC          — straight after a QC run its trigger has not landed yet (no fee_research row):
//                      the race the hook exists for is real, not hypothetical.
//   2 SETTLED        — once the hook resolves, the trigger's work is on file (both fee_research rows).
//   3 IDLE           — with nothing in flight the hook resolves at once (it never hangs a caller).
//   4 PRODUCTION     — QC itself still returns before the trigger lands (nothing waits on it).
//
// KILLS (verified by hand): drop trackQcBackgroundTrigger around the trigger in qc.ts -> 2 FAILS;
// without the hook (staging 1472b867) the suite fails on the missing export.
//
//   npx tsx backend/test/qcBackgroundTriggersSettled.test.ts
import "./_isolate"; // FIRST: temp cwd, so filled/ docs/ never land in the repo's backend/data
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qc-trigger-settle-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.BACKUP_DIR = path.join(tmp, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmp, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmp, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.CODE_RESEARCH = "off";
process.env.SKIP_CODE_RESEARCH = "1";
process.env.DOCUMENT_FETCH = "off";
process.env.AHJ_FORM_DOWNLOADS = "off";
process.env.PORTAL_AUTOMATION = "off";
process.env.PERMIT_PROCESS_LOOKUP = "off";
delete process.env.FEE_RESEARCH;
delete process.env.AUTO_STAGE_STEPS;
delete process.env.SMTP_HOST;
delete process.env.CLIENT_NOTIFICATIONS;

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail.slice(0, 600)}` : ""}`); }
  else console.log(`ok   - ${name}`);
};

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const qc = await import("../src/qc");

const jobQueue = await import("../src/jobQueue");
const db = await openDatabase();
// Fee research queues only while a job worker runs; its 30 s poll is stopped, so the only drains are
// enqueueJob's own kicks (keyless: the researcher is a no-op, and the row stays on file either way).
clearInterval(jobQueue.startJobWorker(db));
const client = createClient(db, { companyName: "Trigger Settle Solar", ccbLicenseNumber: "113113" });
// Synthetic jurisdiction (no shipped profile); field set from qcRejudgedOnLookup's COMPLETE job.
const d = createProject(db, {
  clientId: client.id, owner: "Settle Owner", street: "7 Settle Way", zip: "99999",
  state: "PA", city: "Quill Ridge", ahj: "City of Quill Ridge", utility: "Quill Ridge Power",
  dcKw: "8.6", acKw: "6.5", moduleMake: "Qcells", moduleModel: "Q.TRON BLK M-G2.C1+/AC", moduleWattage: "430", moduleQty: "20",
  invMake: "SolarEdge", invModel: "SE7600H-US", invQty: "1", invOutputW: "7600", interco: "Load-side breaker",
  busRating: "200", mainBreaker: "200", pvBreaker: "40", permitPath: "engineered",
} as never);
const pid = d.project.id;
const feeRows = () => db.query<{ payload: string }>("SELECT payload FROM job_queue WHERE job_type = 'fee_research' AND payload LIKE ?", ["%Quill Ridge%"]);

// createProject ran QC once; let that trigger land and clear its rows, so the run below is measured alone.
await qc.qcBackgroundTriggersSettled();
db.run("DELETE FROM job_queue");
db.run("DELETE FROM fee_schedules");

qc.runQcForProject(db, pid);
check("1. ASYNC: straight after QC returns, its research trigger has not landed (no fee_research row)",
  feeRows().length === 0, JSON.stringify(feeRows()));
check("4. PRODUCTION: QC itself returned without waiting on the trigger", feeRows().length === 0);

await qc.qcBackgroundTriggersSettled();
const rows = feeRows();
check("2. SETTLED: once the hook resolves, the trigger's fee research is on file (permit + nem)",
  rows.some((r) => /"track":"permit"/.test(r.payload)) && rows.some((r) => /"track":"nem"/.test(r.payload)), JSON.stringify(rows));

const t0 = Date.now();
const idle = await Promise.race([qc.qcBackgroundTriggersSettled().then(() => "settled"), new Promise((r) => setTimeout(() => r("hung"), 2000))]);
check("3. IDLE: with nothing in flight the hook resolves at once", idle === "settled" && Date.now() - t0 < 500, `${idle} after ${Date.now() - t0}ms`);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nqcBackgroundTriggersSettled: all checks passed");
process.exit(0);
