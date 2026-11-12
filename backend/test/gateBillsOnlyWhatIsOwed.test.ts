// #699 — THE PER-SUBMISSION GATE COLLECTS ONLY WHAT IS OURS, AND NOTHING IS BILLED TWICE.
//
// The gate used to ask a per-submission client for permit fee + service fee before staging,
// whoever the permit fee belonged to (a 'card-on-file' fee the client pays on its own portal
// account sat in "Client total"), and the invoice then billed the same service fee and
// reimbursement again because it skipped only WAIVED rows.
//
//   MUST: the gate's amount is the service fee only, whatever the fee responsibility;
//         totalUsd (the filing's whole cost) is unchanged, so existing quotes keep their values;
//         a gate payment is stamped with what it took and shows on the invoice as a payment
//         RECEIVED, its service line marked already paid and out of the amounts due;
//         the reimbursement is billed exactly once, after the real fee is recorded;
//         a row paid through the OLD gate (nothing stamped) never re-bills the fee automatically;
//         an unpaid row invoices exactly as before.
//
//   npx tsx backend/test/gateBillsOnlyWhatIsOwed.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProjectRecord } from "../../shared/src/types";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-owed-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.SUBMISSION_SERVICE_FEE_USD = "100";
  process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
  const { openDatabase } = await import("../src/db");
  const { createClient } = await import("../src/clients");
  const { createPortalCredential } = await import("../src/portalCredentials");
  const {
    buildPaymentQuote, markSubmissionPaid, recordActualPermitFee, assertSubmissionPaid,
  } = await import("../src/submissionFees");
  const { buildProjectInvoice } = await import("../src/invoices");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   - ${name}`);
  };

  // Synthetic clients and a synthetic portal host. One credential per client, so the agreement
  // stamped on a recorded fee is unambiguous (submissionFees.feeResponsibilityNow).
  const PORTAL = "https://permits.example.test/portal/";
  const cardClient = createClient(db, { companyName: "Card Solar", billingMode: "per_submission", serviceFeeUsd: "175" });
  const keelixClient = createClient(db, { companyName: "Advance Solar", billingMode: "per_submission", serviceFeeUsd: "175" });
  const monthlyClient = createClient(db, { companyName: "Monthly Solar", billingMode: "monthly", serviceFeeUsd: "175" });
  createPortalCredential(db, cardClient.id, { portalUrl: PORTAL, username: "u", password: "p", feeResponsibility: "card-on-file" });
  createPortalCredential(db, keelixClient.id, { portalUrl: PORTAL, username: "u", password: "p", feeResponsibility: "keelix-pays" });
  createPortalCredential(db, monthlyClient.id, { portalUrl: PORTAL, username: "u", password: "p", feeResponsibility: "keelix-pays" });

  // A jurisdiction with no published schedule, so the only fee numbers are the valuation
  // heuristic (a quote) and what a person records.
  const now = new Date().toISOString();
  let n = 0;
  const mkProject = (clientId: string): ProjectRecord => {
    const pid = `gate-${++n}`;
    db.run(
      `INSERT INTO projects (id, client_id, homeowner_name, state, ahj, utility, system_size_dc_kw, status, parser_json, created_at, updated_at)
       VALUES (?, ?, 'Test Owner', 'OR', 'City of No Schedule', 'Test Utility', 10.12, 'ready_to_stage', '{}', ?, ?)`,
      [pid, clientId, now, now],
    );
    return {
      id: pid, clientId, state: "OR", ahj: "City of No Schedule", utility: "Test Utility",
      systemSizeDcKw: 10.12, homeownerName: "Test Owner", parserSnapshot: {},
    } as unknown as ProjectRecord;
  };

  // ---------------------------------------------------------------------
  // 0. The column the gate stamps exists (migration).
  // ---------------------------------------------------------------------
  const cols = db.query<{ name: string }>("PRAGMA table_info(submission_payments)").map((c) => c.name);
  check("submission_payments carries gate_collected_usd", cols.includes("gate_collected_usd"), cols.join(","));

  // ---------------------------------------------------------------------
  // 1. THE GATE ASKS FOR THE SERVICE FEE ONLY — whoever the permit fee belongs to.
  // ---------------------------------------------------------------------
  // First, before any fee is recorded here: a recorded fee teaches later quotes (learned history).
  const est = mkProject(keelixClient.id);
  const estQuote = buildPaymentQuote(db, est, "permit");
  check("a valuation ESTIMATE is never collected at the gate",
    estQuote.permitFeeSource === "valuation_estimate" && estQuote.gateAmountUsd === 175
    && estQuote.totalUsd === 357.16,
    JSON.stringify([estQuote.permitFeeSource, estQuote.gateAmountUsd, estQuote.totalUsd]));

  const card = mkProject(cardClient.id);
  recordActualPermitFee(db, card, "permit", 287.5);   // the client pays this on its own card
  const cardQuote = buildPaymentQuote(db, card, "permit");
  check("card-on-file fee: the quote still states the filing's whole cost (unchanged)",
    cardQuote.totalUsd === 462.5 && cardQuote.permitFeeUsd === 287.5 && cardQuote.serviceFeeUsd === 175,
    JSON.stringify([cardQuote.totalUsd, cardQuote.permitFeeUsd, cardQuote.serviceFeeUsd]));
  check("card-on-file fee: the gate amount is the service fee only",
    cardQuote.required === true && cardQuote.gateAmountUsd === 175, String(cardQuote.gateAmountUsd));
  let gateMessage = "";
  try { assertSubmissionPaid(db, card, "permit"); } catch (err) { gateMessage = (err as Error).message; }
  check("the 402 asks for the service fee and not the permit fee",
    /\$175\.00/.test(gateMessage) && !/287\.50|462\.50/.test(gateMessage), gateMessage);

  const monthly = mkProject(monthlyClient.id);
  const monthlyQuote = buildPaymentQuote(db, monthly, "permit");
  check("a client that is not gated owes nothing at the gate",
    monthlyQuote.required === false && monthlyQuote.gateAmountUsd === 0, String(monthlyQuote.gateAmountUsd));

  // ---------------------------------------------------------------------
  // 2. AN UNPAID ROW INVOICES EXACTLY AS BEFORE.
  // ---------------------------------------------------------------------
  const unpaid = mkProject(keelixClient.id);
  recordActualPermitFee(db, unpaid, "permit", 360);
  const unpaidInv = buildProjectInvoice(db, unpaid);
  check("unpaid: reimbursement and service both due, nothing received",
    unpaidInv.reimbursementTotalUsd === 360 && unpaidInv.serviceTotalUsd === 175
    && unpaidInv.paymentsReceived.length === 0 && unpaidInv.lines.every((l) => !l.alreadyPaid),
    JSON.stringify([unpaidInv.reimbursementTotalUsd, unpaidInv.serviceTotalUsd, unpaidInv.paymentsReceived]));

  // ---------------------------------------------------------------------
  // 3. GATE PAID, REAL FEE RECORDED LATER: service shown as paid, reimbursement exactly once.
  // ---------------------------------------------------------------------
  const gated = mkProject(keelixClient.id);
  buildPaymentQuote(db, gated, "permit");
  const paidQuote = markSubmissionPaid(db, gated, "permit", { paymentReference: "GATE-1" });
  check("Client paid us stamps what the gate took: the service fee",
    paidQuote.payment?.status === "paid" && paidQuote.payment.gateCollectedUsd === 175,
    JSON.stringify(paidQuote.payment));
  let passes = true;
  try { assertSubmissionPaid(db, gated, "permit"); } catch { passes = false; }
  check("the gate passes once the service fee is paid", passes);

  recordActualPermitFee(db, gated, "permit", 360);    // we paid the portal; the real fee is known
  const gatedInv = buildProjectInvoice(db, gated);
  const reimb = gatedInv.lines.filter((l) => l.kind === "reimbursement");
  const service = gatedInv.lines.filter((l) => l.kind === "service");
  check("the reimbursement appears exactly once, at the recorded figure, and is due",
    reimb.length === 1 && reimb[0].amountUsd === 360 && !reimb[0].alreadyPaid && gatedInv.reimbursementTotalUsd === 360,
    JSON.stringify(reimb.map((l) => [l.amountUsd, l.alreadyPaid])));
  check("the service line is shown as ALREADY PAID and is not due again",
    service.length === 1 && service[0].alreadyPaid === true && gatedInv.serviceTotalUsd === 0,
    JSON.stringify([service.map((l) => [l.amountUsd, l.alreadyPaid]), gatedInv.serviceTotalUsd]));
  check("the gate payment is listed as a payment RECEIVED",
    gatedInv.paymentsReceived.length === 1 && gatedInv.paymentsReceived[0].amountUsd === 175
    && gatedInv.paymentsReceived[0].paymentReference === "GATE-1",
    JSON.stringify(gatedInv.paymentsReceived));

  // Recording the fee at the same press as "Client paid us" still takes only the service fee.
  const together = mkProject(keelixClient.id);
  const togetherQuote = markSubmissionPaid(db, together, "permit", { paymentReference: "GATE-2", actualPermitFeeUsd: "360" });
  const togetherInv = buildProjectInvoice(db, together);
  check("fee typed at the same press: gate still took the service fee only, fee billed once",
    togetherQuote.payment?.gateCollectedUsd === 175 && togetherInv.reimbursementTotalUsd === 360
    && togetherInv.serviceTotalUsd === 0,
    JSON.stringify([togetherQuote.payment?.gateCollectedUsd, togetherInv.reimbursementTotalUsd, togetherInv.serviceTotalUsd]));

  // ---------------------------------------------------------------------
  // 4. A ROW PAID THROUGH THE OLD GATE (nothing stamped) never re-bills the fee by itself.
  // ---------------------------------------------------------------------
  const legacy = mkProject(keelixClient.id);
  recordActualPermitFee(db, legacy, "permit", 360);
  db.run(
    "UPDATE submission_payments SET status = 'paid', paid_at = ?, payment_reference = 'OLD-1', gate_collected_usd = NULL WHERE project_id = ?",
    [now, legacy.id],
  );
  const legacyInv = buildProjectInvoice(db, legacy);
  check("old-gate payment: the advanced fee is held for a person, not billed",
    legacyInv.reimbursementTotalUsd === 0 && legacyInv.lines.every((l) => l.kind !== "reimbursement")
    && legacyInv.notInvoiceable.some((x) => /gate/i.test(x.reason) && x.amountSeenUsd === 360),
    JSON.stringify(legacyInv.notInvoiceable));
  check("old-gate payment: the service fee is already paid and listed as received, amount not on file",
    legacyInv.serviceTotalUsd === 0 && legacyInv.paymentsReceived.length === 1
    && legacyInv.paymentsReceived[0].amountUsd === null,
    JSON.stringify([legacyInv.serviceTotalUsd, legacyInv.paymentsReceived]));

  // ---------------------------------------------------------------------
  // 5. Billing mode changed after the gate was paid: still never charged twice.
  // ---------------------------------------------------------------------
  const switched = mkProject(keelixClient.id);
  markSubmissionPaid(db, switched, "permit", { paymentReference: "GATE-3" });
  db.run("UPDATE clients SET billing_mode = 'monthly' WHERE id = ?", [keelixClient.id]);
  const switchedInv = buildProjectInvoice(db, switched);
  check("mode switched to monthly: the paid service fee is received, not a line due",
    switchedInv.serviceTotalUsd === 0 && switchedInv.paymentsReceived.length === 1
    && switchedInv.notInvoiceable.some((x) => /paid at the per-submission gate/i.test(x.reason)),
    JSON.stringify([switchedInv.notInvoiceable, switchedInv.paymentsReceived]));
  db.run("UPDATE clients SET billing_mode = 'per_submission' WHERE id = ?", [keelixClient.id]);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) { console.error(`\n${failures} gate/invoice check(s) FAILED.`); process.exit(1); }
  console.log("\ngateBillsOnlyWhatIsOwed: all checks passed.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
