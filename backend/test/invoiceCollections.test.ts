// CHASING LATE INVOICES (#199). The owner's rule, 2026-11-12: "Remind, then hold at 30 days" — a
// reminder on a staff click at the due date and 7 days later; at 30 days late the client's NEW filings
// wait until the invoice is paid, voided, or a named person lifts the hold.
//
//   - the overdue list shows only SENT invoices at or past due, most late first, with days late, the
//     reminder due next and whether it holds filings; a draft, paid or void invoice never shows;
//   - the list is per org (rule 6);
//   - a reminder needs a named person, goes through the client-email switch, and counts as sent only
//     when delivered (a silenced send is a draft and the reminder is still owed);
//   - the staging door (prepareSubmission) refuses a held client with a 402 naming the invoice, and
//     lets it through once the invoice is paid, voided, or a named person lifts the hold (with a reason);
//   - the day counts are settings, not code.
//
//   npx tsx backend/test/invoiceCollections.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "invoice-collections-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
for (const k of ["BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH", "CODE_RESEARCH"]) process.env[k] = "off";
for (const k of ["SMTP_HOST", "SMTP_FROM", "ANTHROPIC_API_KEY", "SUBMISSION_SERVICE_FEE_USD", "CLIENT_NOTIFICATIONS", "CLIENT_NOTIFICATIONS_ALLOW_CLIENTS", "INVOICE_HOLD_DAYS", "INVOICE_REMINDER_LATE_DAYS"]) delete process.env[k];

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createProject, prepareSubmission } = await import("../src/repository");
const L = await import("../src/clientInvoices");
const C = await import("../src/invoiceCollections");

const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const ORG_B = "org-collections-b";
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES (?, 'Other Co', 'full', ?)", [ORG_B, new Date().toISOString()]);
const late = createClient(db, { companyName: "Late Sample Solar", billingMode: "monthly", businessEmail: "ap@late.test" });
const fine = createClient(db, { companyName: "Paying Sample Solar", billingMode: "monthly", businessEmail: "ap@paying.test" });
const other = createClient(db, { companyName: "Other Org Solar", billingMode: "monthly", businessEmail: "ap@other.test" }, ORG_B);

const dayOffset = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
let seq = 0;
/** An invoice in a given state with a due date `dueInDays` from today (negative = past). */
const invoice = (clientId: string, status: string, dueInDays: number | null, dueUsd = 230): string => {
  const id = `inv-${++seq}`;
  const ts = new Date().toISOString();
  db.run(
    `INSERT INTO client_invoices (id, number, client_id, period_start, period_end, status, bill_to, billing_mode,
       reimbursement_total_usd, service_total_usd, received_total_usd, due_total_usd, issued_at, due_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, '2026-10-01', '2026-11-01', ?, 'ap@example.test', 'monthly', 0, ?, 0, ?, ?, ?, 'Pat Tester', ?, ?)`,
    [id, `INV-2026-${String(9000 + seq)}`, clientId, status, dueUsd, dueUsd, ts, dueInDays == null ? "" : dayOffset(dueInDays), ts, ts],
  );
  return id;
};

const dueToday = invoice(late.id, "sent", 0, 99);
const sevenLate = invoice(late.id, "sent", -7, 178);
const notYet = invoice(late.id, "sent", 3);
const draftOld = invoice(late.id, "draft", -60);
const paidOld = invoice(fine.id, "paid", -60);
const voidOld = invoice(fine.id, "void", -60);
const otherLate = invoice(other.id, "sent", -45);

await check("1a. the list: only SENT invoices at or past due, most late first, per org", () => {
  const list = C.listOverdueInvoices(db, DEFAULT_ORG_ID);
  assert.deepEqual(list.map((x) => x.invoiceId), [sevenLate, dueToday]);
  assert.ok(!list.some((x) => [notYet, draftOld, paidOld, voidOld, otherLate].includes(x.invoiceId)));
  assert.deepEqual(C.listOverdueInvoices(db, ORG_B).map((x) => x.invoiceId), [otherLate]);
  assert.equal(C.listOverdueInvoices(db, null).length, 3, "superadmin reads every org");
});
await check("1b. due today wants the due-date reminder; 7 days late wants the late one; neither holds yet", () => {
  const list = C.listOverdueInvoices(db, DEFAULT_ORG_ID);
  const today = list.find((x) => x.invoiceId === dueToday)!;
  const week = list.find((x) => x.invoiceId === sevenLate)!;
  assert.equal(today.daysLate, 0);
  assert.equal(today.reminderDue, "due");
  assert.equal(week.daysLate, 7);
  assert.equal(week.reminderDue, "late");
  assert.ok(!today.holdsFilings && !week.holdsFilings);
  assert.deepEqual(C.clientBillingHold(db, late.id), []);
});

const sent: Array<{ to: string; subject: string }> = [];
const send = async (to: string, subject: string): Promise<void> => { sent.push({ to, subject }); };

await check("2a. a reminder needs a named person, and a silenced send is a draft that leaves the reminder owed", async () => {
  await assert.rejects(C.sendInvoiceReminder(db, late.id, dueToday, "  ", { send }), /Name the person/);
  process.env.CLIENT_NOTIFICATIONS = "off";
  try {
    const r = await C.sendInvoiceReminder(db, late.id, dueToday, "Pat Tester", { send });
    assert.equal(r.delivered, false);
    assert.match(r.detail, /switched off/);
  } finally { delete process.env.CLIENT_NOTIFICATIONS; }
  assert.equal(sent.length, 0, "nothing was emailed");
  const row = C.listOverdueInvoices(db, DEFAULT_ORG_ID).find((x) => x.invoiceId === dueToday)!;
  assert.equal(row.reminderDue, "due", "a draft does not count as sent");
  assert.equal(row.reminders.length, 1);
});
await check("2b. a delivered reminder is recorded, says it is a reminder, and the next one is not due until 7 days late", async () => {
  const r = await C.sendInvoiceReminder(db, late.id, dueToday, "Pat Tester", { send });
  assert.equal(r.delivered, true);
  assert.equal(r.kind, "due");
  assert.equal(sent.at(-1)?.to, "ap@example.test");
  assert.match(String(sent.at(-1)?.subject), /Reminder: invoice INV-2026-\d+ is due today/);
  const row = C.listOverdueInvoices(db, DEFAULT_ORG_ID).find((x) => x.invoiceId === dueToday)!;
  assert.equal(row.reminderDue, null);
  const week = await C.sendInvoiceReminder(db, late.id, sevenLate, "Pat Tester", { send });
  assert.equal(week.kind, "late");
  assert.match(String(sent.at(-1)?.subject), /is past due/);
  assert.equal(C.listOverdueInvoices(db, DEFAULT_ORG_ID).find((x) => x.invoiceId === sevenLate)!.reminderDue, null);
});
await check("2c. nothing to chase: not yet due, a draft, another client's invoice", async () => {
  await assert.rejects(C.sendInvoiceReminder(db, late.id, notYet, "Pat Tester", { send }), /not due until/);
  await assert.rejects(C.sendInvoiceReminder(db, late.id, draftOld, "Pat Tester", { send }), /is draft/);
  await assert.rejects(C.sendInvoiceReminder(db, fine.id, dueToday, "Pat Tester", { send }), /not found/);
});

// ── 3. the hold ──────────────────────────────────────────────────────────────────────────────
const held = createClient(db, { companyName: "Held Sample Solar", billingMode: "monthly", businessEmail: "ap@held.test" });
const job = createProject(db, {
  clientId: held.id, owner: "Sample Owner", street: "1 Sample St", city: "Sampleville",
  state: "OR", ahj: "City of Sampleton", utility: "Sample Power", dcKw: "8", acKw: "6.4",
}).project;
const thirtyLate = invoice(held.id, "sent", -30, 230);

await check("3a. 30 days late holds the client's new filings: the list says so and the staging door refuses with a 402", async () => {
  const holds = C.clientBillingHold(db, held.id);
  assert.deepEqual(holds.map((h) => h.invoiceId), [thirtyLate]);
  assert.ok(C.listOverdueInvoices(db, DEFAULT_ORG_ID).find((x) => x.invoiceId === thirtyLate)!.holdsFilings);
  await assert.rejects(prepareSubmission(db, job.id, "building" as never), (err: unknown) => {
    const e = err as { status?: number; message?: string };
    return e.status === 402 && /New filings for this client wait: invoice INV-2026-\d+ \(\$230\.00, 30 days late\)/.test(String(e.message));
  });
});
await check("3b. 29 days late does not hold; the hold day is a setting", () => {
  const p = invoice(fine.id, "sent", -29);
  assert.deepEqual(C.clientBillingHold(db, fine.id), []);
  process.env.INVOICE_HOLD_DAYS = "20";
  try { assert.deepEqual(C.clientBillingHold(db, fine.id).map((h) => h.invoiceId), [p]); }
  finally { delete process.env.INVOICE_HOLD_DAYS; }
  L.voidClientInvoice(db, fine.id, p, "test cleanup");
});
await check("3c. a lift needs a named person and a reason; it ends the hold, and the invoice stays on the list as owed", async () => {
  assert.throws(() => C.liftBillingHold(db, held.id, thirtyLate, "payment plan", ""), /Name the person/);
  assert.throws(() => C.liftBillingHold(db, held.id, thirtyLate, "", "Pat Tester"), /Say why/);
  assert.throws(() => C.liftBillingHold(db, fine.id, thirtyLate, "x", "Pat Tester"), /not found/);
  assert.deepEqual(C.liftBillingHold(db, held.id, thirtyLate, "payment plan agreed", "Pat Tester"), []);
  const row = C.listOverdueInvoices(db, DEFAULT_ORG_ID).find((x) => x.invoiceId === thirtyLate)!;
  assert.equal(row.holdsFilings, false);
  assert.equal(row.holdLifted?.by, "Pat Tester");
  assert.equal(row.holdLifted?.reason, "payment plan agreed");
  // The door no longer refuses for the hold (anything it refuses now is not the billing hold).
  await prepareSubmission(db, job.id, "building" as never).catch((err: unknown) => {
    assert.ok(!/New filings for this client wait/.test(String((err as Error).message)), String((err as Error).message));
  });
});
await check("3d. paying or voiding a held invoice clears the hold", () => {
  const a = invoice(held.id, "sent", -40);
  assert.equal(C.clientBillingHold(db, held.id).length, 1);
  L.markClientInvoicePaid(db, held.id, a, "ach-1");
  assert.equal(C.clientBillingHold(db, held.id).length, 0);
  const b = invoice(held.id, "sent", -40);
  assert.equal(C.clientBillingHold(db, held.id).length, 1);
  L.voidClientInvoice(db, held.id, b, "billed in error");
  assert.equal(C.clientBillingHold(db, held.id).length, 0);
});
await check("3e. a hold names only its own client: another client's late invoice holds nothing here", () => {
  assert.deepEqual(C.clientBillingHold(db, late.id), []);
  assert.deepEqual(C.clientBillingHold(db, null), []);
});
await check("4a. reading the list writes nothing", () => {
  const count = () => db.get<{ n: number }>("SELECT (SELECT COUNT(*) FROM invoice_reminders) + (SELECT COUNT(*) FROM invoice_hold_lifts) + (SELECT COUNT(*) FROM client_invoices) AS n")?.n;
  const before = count();
  C.listOverdueInvoices(db, DEFAULT_ORG_ID);
  C.clientBillingHold(db, held.id);
  assert.equal(count(), before);
});

if (failures) {
  console.error(`\ninvoiceCollections: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\ninvoiceCollections: all checks passed");
