// ONE LINE, ONE INVOICE (#700): the billing ledger, the client statement and the invoice lifecycle.
//
// invoices.ts says what a payment row bills (#699: only what Keelix is owed, a gate payment shown as
// received). This file pins what the LEDGER adds on top:
//
//   - billing the same project twice yields no repeated line (a second statement, a second invoice,
//     a later period), and the schema itself refuses a second live line for one key;
//   - a paid gate shows as a payment received, never a charge;
//   - a provisional (published-schedule) line is trued up by an adjustment when the real figure is
//     recorded, once per recorded figure;
//   - a monthly client is not charged a per-submission service fee; an unpaid per-submission gate is
//     not billed (the filing has not been staged);
//   - voiding releases the lines; a paid invoice cannot be voided;
//   - a statement preview writes nothing; another client's invoice is a 404;
//   - sending goes through the client-email switch, and a silenced send leaves the invoice a draft.
//
//   npx tsx backend/test/clientInvoiceLedger.test.ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProjectRecord } from "../../shared/src/types";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-invoice-ledger-test-"));
  process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
  process.env.SUBMISSION_SERVICE_FEE_USD = "100";
  process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;
  delete process.env.CLIENT_NOTIFICATIONS;
  delete process.env.CLIENT_NOTIFICATIONS_ALLOW_CLIENTS;
  const { openDatabase } = await import("../src/db");
  const { createClient } = await import("../src/clients");
  const { createPortalCredential } = await import("../src/portalCredentials");
  const { buildPaymentQuote, recordActualPermitFee, markSubmissionPaid } = await import("../src/submissionFees");
  const { saveFeeSchedule } = await import("../src/feeSchedules");
  const L = await import("../src/clientInvoices");
  const db = await openDatabase();

  let failures = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
    else console.log(`ok   - ${name}`);
  };
  const expectThrow = (fn: () => unknown, re: RegExp): string => {
    try { fn(); return "did not throw"; } catch (err) { const m = err instanceof Error ? err.message : String(err); return re.test(m) ? "" : m; }
  };

  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const period = L.resolvePeriod({ month });
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
  const nextPeriod = L.resolvePeriod({ periodStart: period.periodEnd, periodEnd: L.resolvePeriod({ month: period.periodEnd.slice(0, 7) }).periodEnd });

  const PORTAL = "https://aca-oregon.accela.com/oregon/";
  const perSub = createClient(db, { companyName: "PerSub Solar", billingMode: "per_submission", serviceFeeUsd: "175", businessEmail: "ops@persub.test" });
  db.run("UPDATE clients SET billing_contact_email = ? WHERE id = ?", ["ap@persub.test", perSub.id]);
  createPortalCredential(db, perSub.id, { portalUrl: PORTAL, username: "u", password: "p", feeResponsibility: "keelix-pays" });
  const monthly = createClient(db, { companyName: "Monthly Solar", billingMode: "monthly", serviceFeeUsd: "175", businessEmail: "ops@monthly.test" });
  createPortalCredential(db, monthly.id, { portalUrl: PORTAL, username: "u", password: "p", feeResponsibility: "keelix-pays" });
  createPortalCredential(db, monthly.id, { portalUrl: "https://permits.example.test/", username: "u2", password: "p2" });

  // Same fixture shape as projectInvoice.test.ts: a Coos Bay roof mount that resolves prescriptive.
  const SNAP = { mounting: "Roof mount", pvMicroMake: "Enphase", pvMicroModel: "IQ8PLUS-72-2-US" };
  const iso = now.toISOString();
  let n = 0;
  const mkProject = (clientId: string): ProjectRecord => {
    const pid = `ledger-${++n}`;
    db.run(
      `INSERT INTO projects (id, client_id, homeowner_name, project_address, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'OR', 'City of Coos Bay', 'Pacific Power', 11.7, 9, 'ready_to_stage', ?, ?, ?)`,
      [pid, clientId, `Test Owner ${n}`, `${n} Example St`, JSON.stringify(SNAP), iso, iso],
    );
    return {
      id: pid, clientId, state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power",
      systemSizeDcKw: 11.7, systemSizeAcKw: 9, totalExportKw: null,
      homeownerName: `Test Owner ${n}`, parserSnapshot: { ...SNAP },
    } as unknown as ProjectRecord;
  };
  const count = (table: string): number => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0);

  // ---------------------------------------------------------------------
  // 1. A PAID GATE IS A PAYMENT RECEIVED, and the advanced fee is billed once.
  // ---------------------------------------------------------------------
  const p1 = mkProject(perSub.id);
  recordActualPermitFee(db, p1, "permit", 360);
  markSubmissionPaid(db, p1, "permit", { paymentReference: "gate-001" });

  const before = [count("client_invoices"), count("client_invoice_lines")];
  const s1 = L.buildClientStatement(db, perSub.id, period);
  check("a statement PREVIEW writes nothing",
    count("client_invoices") === before[0] && count("client_invoice_lines") === before[1]);
  const reimb1 = s1.lines.filter((l) => l.kind === "reimbursement");
  const svc1 = s1.lines.filter((l) => l.kind === "service");
  const rcv1 = s1.lines.filter((l) => l.kind === "received");
  check("the advanced fee is billed at its recorded figure",
    reimb1.length === 1 && reimb1[0].amountUsd === 360 && !reimb1[0].provisional, JSON.stringify(reimb1));
  check("the gate's service fee is on the statement as ALREADY PAID, not due",
    svc1.length === 1 && svc1[0].alreadyPaid && s1.serviceTotalUsd === 0, JSON.stringify(svc1));
  check("the gate payment shows as a payment RECEIVED",
    rcv1.length === 1 && rcv1[0].amountUsd === 175 && s1.receivedTotalUsd === 175 && rcv1[0].paymentReference === "gate-001",
    JSON.stringify(rcv1));
  check("amount due = the advanced fee only", s1.dueTotalUsd === 360, String(s1.dueTotalUsd));
  check("addressed to the billing contact", s1.billTo === "ap@persub.test" && s1.billToSource === "billing_contact");

  // ---------------------------------------------------------------------
  // 2. ONE LINE, ONE INVOICE.
  // ---------------------------------------------------------------------
  const inv1 = L.createClientInvoice(db, perSub.id, period, "Test Person");
  check("an invoice is created as a DRAFT with a number and the statement's lines",
    inv1.status === "draft" && /^INV-\d{4}-0001$/.test(inv1.number) && inv1.lines.length === s1.lines.length && inv1.dueTotalUsd === 360,
    `${inv1.status} ${inv1.number} ${inv1.lines.length}/${s1.lines.length} due ${inv1.dueTotalUsd}`);
  const s1b = L.buildClientStatement(db, perSub.id, period);
  check("BILLING THE SAME PROJECT TWICE YIELDS NO REPEATED LINE (same period)",
    s1b.lines.length === 0 && s1b.dueTotalUsd === 0, JSON.stringify(s1b.lines.map((l) => l.lineKey)));
  check("  …and a second invoice for it is refused",
    expectThrow(() => L.createClientInvoice(db, perSub.id, period, "Test Person"), /Nothing to invoice/) === "");
  const sNext = L.buildClientStatement(db, perSub.id, nextPeriod);
  check("  …and the next period does not bill it again",
    sNext.lines.length === 0, JSON.stringify(sNext.lines.map((l) => l.lineKey)));
  const liveLine = db.get<Record<string, unknown>>("SELECT * FROM client_invoice_lines WHERE invoice_id = ? LIMIT 1", [inv1.id])!;
  check("THE SCHEMA refuses a second live line with the same key",
    expectThrow(() => db.run(
      `INSERT INTO client_invoice_lines (id, invoice_id, line_key, project_id, payment_id, track, kind, amount_usd, created_at)
       VALUES ('dup-line', ?, ?, ?, ?, 'permit', 'reimbursement', 1, ?)`,
      [inv1.id, liveLine.line_key, liveLine.project_id, liveLine.payment_id, iso],
    ), /UNIQUE/i) === "");

  // ---------------------------------------------------------------------
  // 3. VOID RELEASES ITS LINES; A PAID INVOICE IS NOT VOIDED.
  // ---------------------------------------------------------------------
  check("a void needs a reason", expectThrow(() => L.voidClientInvoice(db, perSub.id, inv1.id, " "), /why/i) === "");
  const voided = L.voidClientInvoice(db, perSub.id, inv1.id, "wrong period");
  check("void marks the invoice void", voided.status === "void" && voided.voidReason === "wrong period");
  const s1c = L.buildClientStatement(db, perSub.id, period);
  check("VOID RELEASES the lines to the next statement",
    s1c.lines.length === s1.lines.length && s1c.dueTotalUsd === 360, `${s1c.lines.length} lines, due ${s1c.dueTotalUsd}`);
  const inv2 = L.createClientInvoice(db, perSub.id, period, "Test Person");
  check("  …and a new invoice carries them, numbered next", /-0002$/.test(inv2.number) && inv2.dueTotalUsd === 360, inv2.number);
  check("a voided invoice cannot be marked paid", expectThrow(() => L.markClientInvoicePaid(db, perSub.id, inv1.id, ""), /void/) === "");

  // ---------------------------------------------------------------------
  // 4. ANOTHER CLIENT'S INVOICE IS A 404.
  // ---------------------------------------------------------------------
  check("an invoice is read only through its own client",
    expectThrow(() => L.getClientInvoice(db, monthly.id, inv2.id), /not found/i) === "");

  // ---------------------------------------------------------------------
  // 5. SENDING goes through the client-email switch.
  // ---------------------------------------------------------------------
  const comms0 = count("communications");
  const noSmtp = await L.sendClientInvoice(db, perSub.id, inv2.id, "Test Person");
  check("without SMTP the email is a DRAFT and the invoice stays a draft",
    !noSmtp.delivered && noSmtp.invoice.status === "draft" && /SMTP/.test(noSmtp.detail) && count("communications") === comms0 + 1,
    `${noSmtp.delivered} ${noSmtp.invoice.status} ${noSmtp.detail}`);
  process.env.CLIENT_NOTIFICATIONS = "off";
  const sent: string[] = [];
  const fakeSend = async (to: string): Promise<void> => { sent.push(to); };
  const silenced = await L.sendClientInvoice(db, perSub.id, inv2.id, "Test Person", { send: fakeSend });
  check("CLIENT_NOTIFICATIONS=off SILENCES it: nothing sent, invoice still a draft",
    !silenced.delivered && sent.length === 0 && silenced.invoice.status === "draft", silenced.detail);
  process.env.CLIENT_NOTIFICATIONS_ALLOW_CLIENTS = perSub.id;
  const allowed = await L.sendClientInvoice(db, perSub.id, inv2.id, "Test Person", { send: fakeSend });
  check("an allow-listed client is emailed at the billing contact, and the invoice is marked sent with a due date",
    allowed.delivered && sent[0] === "ap@persub.test" && allowed.invoice.status === "sent" && /^\d{4}-\d{2}-\d{2}$/.test(allowed.invoice.dueAt),
    `${allowed.delivered} ${sent.join(",")} ${allowed.invoice.status} ${allowed.invoice.dueAt}`);
  delete process.env.CLIENT_NOTIFICATIONS;
  delete process.env.CLIENT_NOTIFICATIONS_ALLOW_CLIENTS;
  const paid = L.markClientInvoicePaid(db, perSub.id, inv2.id, "ach-778");
  check("mark paid records the reference", paid.status === "paid" && paid.paidReference === "ach-778");
  check("a PAID invoice cannot be voided (a credit is a person's step)",
    expectThrow(() => L.voidClientInvoice(db, perSub.id, inv2.id, "oops"), /paid/) === "");

  // ---------------------------------------------------------------------
  // 6. TRUE-UP: a provisional line settled by the recorded figure, once per figure.
  // ---------------------------------------------------------------------
  saveFeeSchedule(db, { state: "OR", ahj: "City of Coos Bay", track: "permit", discipline: "structural" }, {
    found: true, reason: "", basis: "flat",
    brackets: [{ feeUsd: 200, label: "Prescriptive path system (includes plan review)" }],
    notes: "", sourceUrl: "https://www.coosbayor.gov/fees.pdf",
    sourceQuote: "Solar Permit (when required) – Prescriptive Path System | $200.00",
    sourceKind: "official",
  });
  const p2 = mkProject(monthly.id);
  buildPaymentQuote(db, p2, "permit");
  db.run("UPDATE submission_payments SET fee_responsibility = 'keelix-pays' WHERE project_id = ?", [p2.id]);
  const s2 = L.buildClientStatement(db, monthly.id, period);
  const prov = s2.lines.filter((l) => l.projectId === p2.id && l.kind === "reimbursement");
  check("a published-schedule fee bills PROVISIONALLY",
    prov.length === 1 && prov[0].provisional && prov[0].amountUsd === 200, JSON.stringify(prov));
  // A quote is not a filing: a monthly client is billed our fee per filing RECORDED (#187,
  // filingServiceCharges.test), never per quote, and the statement says how.
  check("MONTHLY client: a quoted, unfiled job has no service-fee line, and the statement says how filings bill",
    !s2.lines.some((l) => l.kind === "service") && s2.notes.some((x) => /each filing is a line at the price saved/.test(x)), JSON.stringify(s2.notes));
  check("a login with no fee agreement is listed", s2.loginsWithoutFeeAgreement.length === 1, JSON.stringify(s2.loginsWithoutFeeAgreement));
  const inv3 = L.createClientInvoice(db, monthly.id, period, "Test Person");
  check("the provisional line is invoiced", inv3.reimbursementTotalUsd === 200, String(inv3.reimbursementTotalUsd));
  check("  …and nothing more is billed while the fee stays provisional",
    L.buildClientStatement(db, monthly.id, period).lines.length === 0);

  recordActualPermitFee(db, p2, "permit", 214.5);
  const s3 = L.buildClientStatement(db, monthly.id, period);
  const adj = s3.lines.filter((l) => l.role === "adjustment");
  check("THE TRUE-UP: the recorded figure brings an ADJUSTMENT for the difference, not a second full line",
    s3.lines.length === 1 && adj.length === 1 && adj[0].amountUsd === 14.5 && adj[0].adjusts?.billedUsd === 200
    && adj[0].adjusts.invoiceNumbers.includes(inv3.number),
    JSON.stringify(s3.lines.map((l) => [l.lineKey, l.amountUsd, l.role])));
  L.createClientInvoice(db, monthly.id, period, "Test Person");
  check("  …billed once: the next statement is empty", L.buildClientStatement(db, monthly.id, period).lines.length === 0);
  // A corrected figure re-entered later adjusts again, by the new difference.
  recordActualPermitFee(db, p2, "permit", 210);
  db.run("UPDATE submission_payments SET fee_recorded_at = ? WHERE project_id = ? AND track = 'permit'", [new Date(Date.now() + 1000).toISOString().replace(/^\d{4}-\d{2}/, month), p2.id]);
  const s4 = L.buildClientStatement(db, monthly.id, period);
  check("a corrected figure adjusts by the new difference (-4.50)",
    s4.lines.length === 1 && s4.lines[0].role === "adjustment" && s4.lines[0].amountUsd === -4.5,
    JSON.stringify(s4.lines.map((l) => [l.lineKey, l.amountUsd])));

  // ---------------------------------------------------------------------
  // 7. AN UNPAID PER-SUBMISSION GATE IS NOT BILLED; EARLIER UNBILLED LINES ARE CARRIED FORWARD.
  // ---------------------------------------------------------------------
  const p3 = mkProject(perSub.id);
  buildPaymentQuote(db, p3, "permit");
  const s5 = L.buildClientStatement(db, perSub.id, period);
  check("an UNPAID per-submission service fee is not billed (the filing is not staged)",
    !s5.lines.some((l) => l.projectId === p3.id && l.kind === "service")
    && s5.excluded.some((x) => x.projectId === p3.id && /not been paid at the per-submission gate/.test(x.reason)),
    JSON.stringify(s5.excluded.filter((x) => x.projectId === p3.id).map((x) => x.reason)));

  const p4 = mkProject(perSub.id);
  recordActualPermitFee(db, p4, "permit", 120);
  db.run("UPDATE submission_payments SET fee_recorded_at = ? WHERE project_id = ? AND track = 'permit'", [lastMonthDate, p4.id]);
  const s6 = L.buildClientStatement(db, perSub.id, period);
  const carried = s6.lines.filter((l) => l.projectId === p4.id);
  check("a line from an earlier period that was never billed is CARRIED FORWARD, not lost",
    carried.length === 1 && carried[0].carriedForward && carried[0].amountUsd === 120, JSON.stringify(carried));
  const lastPeriod = L.resolvePeriod({ month: lastMonthDate.slice(0, 7) });
  const sLast = L.buildClientStatement(db, perSub.id, lastPeriod);
  check("  …and a later line is not pulled into an earlier period's statement",
    !sLast.lines.some((l) => l.projectId === p1.id), JSON.stringify(sLast.lines.map((l) => l.projectId)));

  // ---------------------------------------------------------------------
  // 8. Period input.
  // ---------------------------------------------------------------------
  check("a bad month is a 400", expectThrow(() => L.resolvePeriod({ month: "2026-13" }), /YYYY-MM/) === "");
  check("December rolls into the next year", L.resolvePeriod({ month: "2026-12" }).periodEnd === "2027-01-01");

  if (failures) { console.error(`\nclientInvoiceLedger: ${failures} check(s) failed`); process.exit(1); }
  console.log("\nclientInvoiceLedger: all checks passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
