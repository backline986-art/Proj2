// THE ONBOARDING FEE AND ITS CREDIT BACK (#208). Owner: "$500 credited back in projects" (2026-11-10);
// "Covers the first filings' fees" (2026-11-13): once the client has PAID its onboarding fee, the credit
// covers each new filing's up-front fee until it is used up; a filing billed on a statement takes what
// is left there.
//
//   - the fee is DATA (the price list's onboarding item per tier): unset, nothing is added;
//   - a NEW client's first statement carries it, once; an older client's does not;
//   - no credit until the fee is PAID; then the gate quote takes it off the fee, and a filing it covers
//     in full goes ahead with no click (recorded paid, "Onboarding credit", audited);
//   - a QUOTED row never holds credit, a WAIVED row never spends it; a partly covered filing asks only
//     for the rest; once used up the full fee is back;
//   - the cap counts the filing's price, credit or not;
//   - a monthly client's statement takes the credit off its filing lines with one negative line, billed
//     once; voiding that invoice frees the credit again; a person's own credit line counts as used.
//
//   npx tsx backend/test/onboardingCredit.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-credit-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
for (const k of ["BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH", "CLIENT_NOTIFICATIONS", "CODE_RESEARCH"]) process.env[k] = "off";
for (const k of ["SMTP_HOST", "SMTP_FROM", "ANTHROPIC_API_KEY", "SUBMISSION_SERVICE_FEE_USD"]) delete process.env[k];

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject } = await import("../src/repository");
const { markTrackSubmitted } = await import("../src/submittalTracks");
const { buildPaymentQuote, assertSubmissionPaid, markSubmissionPaid, waiveSubmissionPayment, getSubmissionPayment } = await import("../src/submissionFees");
const P = await import("../src/servicePrices");
const L = await import("../src/clientInvoices");
const C = await import("../src/onboardingCredit");

const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const period = L.resolvePeriod({ month: new Date().toISOString().slice(0, 7) });
let n = 0;
const mk = (clientId: string) => createProject(db, {
  clientId, owner: `Sample Owner ${++n}`, street: `${n} Sample St`, city: "Sampleville",
  state: "OR", ahj: "City of Sampleton", utility: "Sample Power", dcKw: "8", acKw: "6.4",
}).project;
const remaining = (clientId: string) => C.onboardingCredit(db, clientId).remainingUsd;
const statement = (clientId: string) => L.buildClientStatement(db, clientId, period);
/** Invoice the client's statement and mark it paid: how the onboarding fee gets paid. */
const invoiceAndPay = (clientId: string): string => {
  const inv = L.createClientInvoice(db, clientId, period, "Pat Tester");
  L.markClientInvoicePaid(db, clientId, inv.id, "ach-test");
  return inv.id;
};

// Prices as DATA, the way a person sets them: $99 permit, $79 NEM, $230 cap, $500 onboarding.
P.setServicePrices(db, DEFAULT_ORG_ID, { standard: { permitUsd: 99, nemUsd: 79, capUsd: 230 } }, "Pat Tester");
const early = createClient(db, { companyName: "Early Sample Solar", billingMode: "per_submission", businessEmail: "ap@early.test" });

check("1a. no onboarding price: nothing is added and no credit exists", () => {
  assert.equal(C.onboardingFeeDue(db, early.id), null);
  assert.ok(!statement(early.id).lines.some((l) => l.kind === "onboarding"));
  assert.deepEqual(C.onboardingCredit(db, early.id), { paidUsd: 0, usedUsd: 0, remainingUsd: 0 });
});

P.setServicePrices(db, DEFAULT_ORG_ID, { standard: { onboardingUsd: 500 } }, "Pat Tester");
// An older client: signed up before the onboarding price existed.
const older = createClient(db, { companyName: "Older Sample Solar", billingMode: "monthly", businessEmail: "ap@older.test" });
db.run("UPDATE clients SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [older.id]);
const gate = createClient(db, { companyName: "Gate Sample Solar", billingMode: "per_submission", businessEmail: "ap@gate.test" });
const monthly = createClient(db, { companyName: "Monthly Sample Solar", billingMode: "monthly", businessEmail: "ap@monthly.test" });

check("1b. a new client's first statement carries the onboarding fee, once; an older client's does not", () => {
  const st = statement(gate.id);
  const fee = st.lines.filter((l) => l.kind === "onboarding");
  assert.equal(fee.length, 1);
  assert.equal(fee[0].amountUsd, 500);
  assert.match(st.notes.join(" "), /new client's first statement/);
  assert.equal(C.onboardingFeeDue(db, older.id), null);
  assert.ok(!statement(older.id).lines.some((l) => l.kind === "onboarding"));
});

const j1 = mk(gate.id);
check("2a. no credit until the fee is paid: an invoiced but unpaid fee leaves the gate at the full price", () => {
  const inv = L.createClientInvoice(db, gate.id, period, "Pat Tester");
  assert.equal(remaining(gate.id), 0);
  assert.equal(buildPaymentQuote(db, j1, "permit").gateAmountUsd, 99);
  assert.ok(!statement(gate.id).lines.some((l) => l.kind === "onboarding"), "the fee is not put on a second invoice");
  L.markClientInvoicePaid(db, gate.id, inv.id, "ach-test");
  assert.equal(remaining(gate.id), 500);
});
check("2b. a filing the credit covers in full goes ahead with no click: recorded paid, 'Onboarding credit', audited", () => {
  const q = buildPaymentQuote(db, j1, "permit");
  assert.equal(q.gateAmountUsd, 0);
  assert.equal(q.onboardingCreditUsd, 99);
  assert.match(String(q.serviceFeeSource), /\$99\.00 taken from the onboarding credit, so nothing is due/);
  assertSubmissionPaid(db, j1, "permit");
  const row = getSubmissionPayment(db, j1.id, "permit")!;
  assert.equal(row.status, "paid");
  assert.equal(row.paymentReference, "Onboarding credit");
  assert.equal(row.creditAppliedUsd, 99);
  assert.equal(row.gateCollectedUsd, 0);
  assert.ok(db.get("SELECT 1 FROM audit_logs WHERE project_id = ? AND action = 'billing.gate_paid_by_credit'", [j1.id]));
  assert.equal(remaining(gate.id), 401);
});
check("2c. the cap counts the filing's price, credit or not", () => {
  // Under a $150 cap the permit's $99 (paid all by credit) still counts: the NEM is cut to $51.
  P.setServicePrices(db, DEFAULT_ORG_ID, { standard: { capUsd: 150 } }, "Pat Tester");
  assert.equal(buildPaymentQuote(db, j1, "nem").onboardingCreditUsd, 51);
  P.setServicePrices(db, DEFAULT_ORG_ID, { standard: { capUsd: 230 } }, "Pat Tester");
  // Back at $230: permit $99 + NEM $79 = $178, under the cap, so the NEM keeps its full price.
  assert.equal(buildPaymentQuote(db, j1, "nem").onboardingCreditUsd, 79);
  assertSubmissionPaid(db, j1, "nem");
  assert.equal(remaining(gate.id), 322);
});
check("2d. a QUOTED row holds no credit, a WAIVED row spends none", () => {
  const a = mk(gate.id), b = mk(gate.id);
  assert.equal(buildPaymentQuote(db, a, "permit").onboardingCreditUsd, 99);
  assert.equal(buildPaymentQuote(db, b, "permit").onboardingCreditUsd, 99);
  assert.equal(remaining(gate.id), 322, "two quotes have spent nothing");
  waiveSubmissionPayment(db, b, "permit");
  assert.equal(remaining(gate.id), 322, "a waived filing spends nothing");
  markSubmissionPaid(db, a, "permit", { paymentReference: "x" });
  assert.equal(remaining(gate.id), 223);
});
check("2e. partly covered: the gate asks only for the rest; used up, the full fee is back", () => {
  const j = mk(gate.id);
  assertSubmissionPaid(db, j, "permit"); // 99 of 223 -> 124 left
  assertSubmissionPaid(db, j, "nem"); //   79 of 124 -> 45 left
  assert.equal(remaining(gate.id), 45);
  const k = mk(gate.id);
  const q = buildPaymentQuote(db, k, "permit");
  assert.equal(q.onboardingCreditUsd, 45);
  assert.equal(q.gateAmountUsd, 54);
  assert.throws(() => assertSubmissionPaid(db, k, "permit"), (e: unknown) => (e as { status?: number }).status === 402 && /\$54\.00/.test(String((e as Error).message)));
  markSubmissionPaid(db, k, "permit", { paymentReference: "card-1" });
  assert.equal(getSubmissionPayment(db, k.id, "permit")!.gateCollectedUsd, 54);
  assert.equal(remaining(gate.id), 0);
  const last = mk(gate.id);
  const full = buildPaymentQuote(db, last, "permit");
  assert.equal(full.gateAmountUsd, 99);
  assert.equal(full.onboardingCreditUsd, undefined);
});

// ── a monthly client: the credit comes off statement lines ───────────────────────────────────
check("3a. a monthly client's statement takes the credit off its filing lines with one negative line", () => {
  invoiceAndPay(monthly.id); // the onboarding fee, alone, on the first invoice
  assert.equal(remaining(monthly.id), 500);
  const job = mk(monthly.id);
  markTrackSubmitted(db, job, "building", { applicationNumber: "BLD-26-0501" });
  markTrackSubmitted(db, job, "electrical", { applicationNumber: "ELE-26-0501" });
  const st = statement(monthly.id);
  const filings = st.lines.filter((l) => l.lineKey.startsWith("filing:"));
  assert.equal(filings.reduce((t, l) => t + l.amountUsd, 0), 198);
  const credit = st.lines.filter((l) => l.kind === "onboarding");
  assert.equal(credit.length, 1);
  assert.equal(credit[0].amountUsd, -198);
  assert.equal(st.serviceTotalUsd, 0);
  assert.match(st.notes.join(" "), /\$500\.00 paid, \$198\.00 applied here, \$302\.00 left/);
});
check("3b. invoiced once; voiding that invoice frees the credit again", () => {
  const inv = L.createClientInvoice(db, monthly.id, period, "Pat Tester");
  assert.equal(remaining(monthly.id), 302, "a live invoice's credit line counts as used");
  assert.ok(!statement(monthly.id).lines.some((l) => l.kind === "onboarding"), "not credited twice");
  L.voidClientInvoice(db, monthly.id, inv.id, "test");
  assert.equal(remaining(monthly.id), 500);
  assert.equal(statement(monthly.id).lines.filter((l) => l.kind === "onboarding")[0]?.amountUsd, -198);
});
check("3c. a person's own credit line counts as used", () => {
  const inv = L.createClientInvoice(db, monthly.id, period, "Pat Tester"); // takes 198
  L.addManualInvoiceLine(db, monthly.id, inv.id, { kind: "onboarding", amountUsd: -100, description: "Goodwill credit" }, "Pat Tester");
  assert.equal(remaining(monthly.id), 202);
});
check("3d. the credit never reaches another client", () => {
  assert.equal(remaining(older.id), 0);
  assert.equal(remaining(early.id), 0);
});

if (failures) {
  console.error(`\nonboardingCredit: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nonboardingCredit: all checks passed");
