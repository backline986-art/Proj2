// THE FEES WE CARRY FOR A CLIENT (owner, 2026-11-13: new logins start on "Keelix pays, bills at cost";
// "Both": bill each job's paid fees right away, due on receipt, and limit what we carry per client).
//
//   - recording a fee we paid puts the job's re-billable fees on that job's own DRAFT invoice; a second
//     fee on the job joins the same draft; the month-end statement no longer carries them;
//   - a job fee invoice marked sent is due that day; a period statement keeps its terms;
//   - a job with no fee we paid gets no invoice;
//   - the limit counts fees we paid not yet paid back (unbilled, draft or sent); a paid invoice drops out;
//   - at or over the limit, a filing whose fee WE would pay is refused at the staging door (402), and one
//     whose fee the client pays is not; the limit is data (the client's own, else FEE_FLOAT_LIMIT_USD,
//     else $2,500).
//
//   npx tsx backend/test/feeFloat.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fee-float-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
for (const k of ["BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH", "CLIENT_NOTIFICATIONS", "CODE_RESEARCH"]) process.env[k] = "off";
for (const k of ["SMTP_HOST", "SMTP_FROM", "ANTHROPIC_API_KEY", "SUBMISSION_SERVICE_FEE_USD", "FEE_FLOAT_LIMIT_USD", "INVOICE_TERMS_DAYS"]) delete process.env[k];

const { openDatabase } = await import("../src/db");
const { createClient, updateClient } = await import("../src/clients");
const { createPortalCredential } = await import("../src/portalCredentials");
const { createProject, prepareSubmission } = await import("../src/repository");
const { recordActualPermitFee } = await import("../src/submissionFees");
const L = await import("../src/clientInvoices");
const F = await import("../src/feeFloat");

const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const PORTAL = "https://permits.sample.test/";
const client = createClient(db, { companyName: "Carry Sample Solar", billingMode: "monthly", businessEmail: "ap@carry.test" });
const cred = createPortalCredential(db, client.id, { portalUrl: PORTAL, username: "u", password: "p", feeResponsibility: "keelix-pays" });
let n = 0;
const mk = () => createProject(db, {
  clientId: client.id, owner: `Sample Owner ${++n}`, street: `${n} Sample St`, city: "Sampleville",
  state: "OR", ahj: "City of Sampleton", utility: "Sample Power", dcKw: "8", acKw: "6.4",
}).project;
const period = L.resolvePeriod({ month: new Date().toISOString().slice(0, 7) });
const today = new Date().toISOString().slice(0, 10);

const j1 = mk();
let jobInv = "";
await check("1a. a fee we paid goes on the job's own draft invoice; a second fee joins the same draft", () => {
  recordActualPermitFee(db, j1, "permit", 1300);
  const a = F.afterFeeRecorded(db, j1, "Pat Tester")!;
  assert.equal(a.status, "draft");
  assert.equal(a.projectId, j1.id);
  assert.equal(a.lines.length, 1);
  assert.equal(a.dueTotalUsd, 1300);
  recordActualPermitFee(db, j1, "nem", 200);
  const b = F.afterFeeRecorded(db, j1, "Pat Tester")!;
  assert.equal(b.id, a.id);
  assert.equal(b.dueTotalUsd, 1500);
  jobInv = a.id;
  assert.ok(!L.buildClientStatement(db, client.id, period).lines.some((l) => l.projectId === j1.id && l.kind === "reimbursement"),
    "the month-end statement no longer carries them");
});
await check("1b. a job fee invoice marked sent is due that day", () => {
  assert.equal(L.markClientInvoiceSent(db, client.id, jobInv).dueAt, today);
});
await check("1c. a job with no fee we paid gets no invoice", () => {
  assert.equal(F.afterFeeRecorded(db, mk(), "Pat Tester"), null);
});

const j2 = mk();
const j3 = mk();
await check("2a. the limit counts fees we paid not yet paid back; under it, filings go ahead", () => {
  assert.deepEqual(F.feeFloat(db, client.id), { owedUsd: 1500, limitUsd: 2500, over: false });
  F.assertUnderFeeLimit(db, j3, "permit");
});
await check("2b. at the limit, a filing whose fee we would pay is refused at the staging door", async () => {
  recordActualPermitFee(db, j2, "permit", 1100); // not invoiced yet: still counts
  assert.deepEqual(F.feeFloat(db, client.id), { owedUsd: 2600, limitUsd: 2500, over: true });
  assert.throws(() => F.assertUnderFeeLimit(db, j3, "permit"), (e: unknown) => (e as { status?: number }).status === 402);
  await assert.rejects(prepareSubmission(db, j3.id, "building" as never), (err: unknown) =>
    (err as { status?: number }).status === 402 && /New filings whose fee we pay wait for this client: .*\$2600\.00 of its \$2500\.00 limit/.test(String((err as Error).message)));
});
await check("2c. a filing whose fee the client pays is not held", () => {
  db.run("UPDATE portal_credentials SET fee_responsibility = 'card-on-file' WHERE id = ?", [cred.id]);
  try { F.assertUnderFeeLimit(db, j3, "permit"); }
  finally { db.run("UPDATE portal_credentials SET fee_responsibility = 'keelix-pays' WHERE id = ?", [cred.id]); }
});
await check("2d. the limit is data: the client's own, else FEE_FLOAT_LIMIT_USD", () => {
  updateClient(db, client.id, { feeLimitUsd: "5000" });
  assert.equal(F.feeFloat(db, client.id).limitUsd, 5000);
  F.assertUnderFeeLimit(db, j3, "permit");
  updateClient(db, client.id, { feeLimitUsd: "" });
  process.env.FEE_FLOAT_LIMIT_USD = "3000";
  try { assert.equal(F.feeFloat(db, client.id).over, false); }
  finally { delete process.env.FEE_FLOAT_LIMIT_USD; }
  assert.equal(F.feeFloat(db, client.id).limitUsd, 2500);
});
await check("2e. a paid invoice drops out: back under the limit", () => {
  L.markClientInvoicePaid(db, client.id, jobInv, "ach-1");
  assert.deepEqual(F.feeFloat(db, client.id), { owedUsd: 1100, limitUsd: 2500, over: false });
  F.assertUnderFeeLimit(db, j3, "permit");
});
await check("3a. a period statement keeps its terms (not due on receipt)", () => {
  const inv = L.createClientInvoice(db, client.id, period, "Pat Tester");
  assert.equal(inv.projectId, "");
  assert.ok(L.markClientInvoiceSent(db, client.id, inv.id).dueAt > today);
});

if (failures) {
  console.error(`\nfeeFloat: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nfeeFloat: all checks passed");
