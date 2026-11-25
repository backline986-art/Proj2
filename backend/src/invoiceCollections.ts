// ---------------------------------------------------------------------------
// CHASING LATE INVOICES (#199): the overdue list, reminders on a person's click, and the filing hold.
//
// The owner's rule (2026-11-12, "Remind, then hold at 30 days"): a sent invoice past its due date gets
// a reminder at the due date and again 7 days later, each sent by a staff click; once it is 30 days
// late, that client's NEW filings wait until it is paid, voided, or a named person lifts the hold.
//
// The day counts are SETTINGS (INVOICE_REMINDER_LATE_DAYS, INVOICE_HOLD_DAYS), defaulting to the owner's
// 7 and 30; nothing here knows a price.
//
// WHAT HOLDS. Only an invoice with status 'sent' and a due date: a draft has not gone to the client, a
// paid or void one is settled. "Days late" counts whole days after the due date, in UTC.
//
// THE HOLD ADDS A STOP ONLY. assertNoBillingHold sits at the staging door beside the per-submission
// gate (repository.prepareSubmission) and throws 402, which the autopilot already reports as a payment
// blocker and resumes from when it clears. Filings already staged or filed are not touched, and nothing
// here pays, charges or files anything (rule 1).
//
// A REMINDER IS A PERSON'S CLICK, never scheduled: it goes through the one client-email switch
// (clientEmailsOffFor), is recorded in the CRM either way, and counts as sent only when delivered.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import { HttpError } from "./httpError";
import { id as newId } from "./ids";
import { text } from "./json";
import { nowIso } from "./time";
import { BRAND } from "./brand";
// clientInvoices and clients are imported inside the functions that send: repository (the staging
// door) imports this module, and clientInvoices imports repository.
import type { ClientInvoice } from "./clientInvoices";

type Row = Record<string, unknown>;

export type ReminderKind = "due" | "late";

export interface InvoiceReminder {
  kind: ReminderKind;
  sentBy: string;
  sentAt: string;
  delivered: boolean;
  detail: string;
}

export interface OverdueInvoice {
  invoiceId: string;
  number: string;
  clientId: string;
  clientName: string;
  billTo: string;
  dueAt: string;
  dueTotalUsd: number;
  /** Whole days after the due date (0 = due today). */
  daysLate: number;
  /** The reminder a person should send now, or null when both are sent or it is too early for the next. */
  reminderDue: ReminderKind | null;
  reminders: InvoiceReminder[];
  /** This invoice holds the client's new filings now. */
  holdsFilings: boolean;
  /** A named person lifted the hold for this invoice. */
  holdLifted: { by: string; at: string; reason: string } | null;
  qbStatus: string;
}

function daysSetting(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 && raw <= 365 ? Math.floor(raw) : fallback;
}

/** Days after the due date for the second reminder (owner: 7). */
export function reminderLateDays(): number { return daysSetting("INVOICE_REMINDER_LATE_DAYS", 7); }
/** Days after the due date when the client's new filings wait (owner: 30). */
export function holdDays(): number { return daysSetting("INVOICE_HOLD_DAYS", 30); }

const today = (now = new Date()): string => now.toISOString().slice(0, 10);

/** Whole days from the due date to today (UTC); negative before it. */
export function daysLateOf(dueAt: string, now = new Date()): number {
  const due = Date.parse(`${text(dueAt).slice(0, 10)}T00:00:00Z`);
  const t = Date.parse(`${today(now)}T00:00:00Z`);
  if (!Number.isFinite(due)) return -1;
  return Math.round((t - due) / 86_400_000);
}

function remindersFor(db: AppDb, invoiceIds: string[]): Map<string, InvoiceReminder[]> {
  const out = new Map<string, InvoiceReminder[]>();
  for (let i = 0; i < invoiceIds.length; i += 400) {
    const chunk = invoiceIds.slice(i, i + 400);
    if (!chunk.length) continue;
    const rows = db.query<Row>(
      `SELECT invoice_id, kind, sent_by, sent_at, delivered, detail FROM invoice_reminders
        WHERE invoice_id IN (${chunk.map(() => "?").join(",")}) ORDER BY sent_at`,
      chunk,
    );
    for (const r of rows) {
      const list = out.get(text(r.invoice_id)) ?? [];
      list.push({ kind: text(r.kind) as ReminderKind, sentBy: text(r.sent_by), sentAt: text(r.sent_at), delivered: Number(r.delivered) === 1, detail: text(r.detail) });
      out.set(text(r.invoice_id), list);
    }
  }
  return out;
}

function liftsFor(db: AppDb, invoiceIds: string[]): Map<string, { by: string; at: string; reason: string }> {
  const out = new Map<string, { by: string; at: string; reason: string }>();
  for (let i = 0; i < invoiceIds.length; i += 400) {
    const chunk = invoiceIds.slice(i, i + 400);
    if (!chunk.length) continue;
    for (const r of db.query<Row>(
      `SELECT invoice_id, lifted_by, lifted_at, reason FROM invoice_hold_lifts WHERE invoice_id IN (${chunk.map(() => "?").join(",")})`, chunk,
    )) out.set(text(r.invoice_id), { by: text(r.lifted_by), at: text(r.lifted_at), reason: text(r.reason) });
  }
  return out;
}

/** The next reminder due: the due-date one from the due date, the late one from N days after. Only a
 *  DELIVERED reminder counts as sent: a draft (email off, no SMTP) is still owed. */
function nextReminder(daysLate: number, reminders: InvoiceReminder[]): ReminderKind | null {
  const sent = (k: ReminderKind): boolean => reminders.some((r) => r.kind === k && r.delivered);
  if (daysLate >= reminderLateDays() && !sent("late")) return "late";
  if (daysLate >= 0 && !sent("due") && !sent("late")) return "due";
  return null;
}

/**
 * Every sent invoice at or past its due date, most late first. `orgId` null = every org (superadmin);
 * a string = that org's clients only (rule 6). READS ONLY.
 */
export function listOverdueInvoices(db: AppDb, orgId: string | null, now = new Date()): OverdueInvoice[] {
  const rows = db.query<Row>(
    `SELECT i.id, i.number, i.client_id, i.bill_to, i.due_at, i.due_total_usd, i.qb_status, c.company_name, c.legal_business_name
       FROM client_invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.status = 'sent' AND i.due_at != '' AND i.due_at <= ? ${orgId == null ? "" : "AND c.org_id = ?"}
      ORDER BY i.due_at, i.number`,
    orgId == null ? [today(now)] : [today(now), orgId],
  );
  const ids = rows.map((r) => text(r.id));
  const reminders = remindersFor(db, ids);
  const lifts = liftsFor(db, ids);
  return rows.map((r) => {
    const invoiceId = text(r.id);
    const daysLate = daysLateOf(text(r.due_at), now);
    const list = reminders.get(invoiceId) ?? [];
    const lifted = lifts.get(invoiceId) ?? null;
    return {
      invoiceId,
      number: text(r.number),
      clientId: text(r.client_id),
      clientName: text(r.company_name) || text(r.legal_business_name),
      billTo: text(r.bill_to),
      dueAt: text(r.due_at),
      dueTotalUsd: Number(r.due_total_usd) || 0,
      daysLate,
      reminderDue: nextReminder(daysLate, list),
      reminders: list,
      holdsFilings: daysLate >= holdDays() && !lifted,
      holdLifted: lifted,
      qbStatus: text(r.qb_status),
    };
  }).sort((a, b) => b.daysLate - a.daysLate || a.number.localeCompare(b.number));
}

/** The invoices holding this client's new filings now (empty = no hold). READS ONLY. */
export function clientBillingHold(db: AppDb, clientId: string | null, now = new Date()): OverdueInvoice[] {
  if (!clientId) return [];
  const org = db.get<Row>("SELECT org_id FROM clients WHERE id = ?", [clientId]);
  if (!org) return [];
  return listOverdueInvoices(db, text(org.org_id), now).filter((x) => x.clientId === clientId && x.holdsFilings);
}

/** One sentence naming what holds the client's filings, or "" when nothing does. */
export function billingHoldSentence(holds: OverdueInvoice[]): string {
  if (!holds.length) return "";
  const list = holds.map((h) => `${h.number} ($${h.dueTotalUsd.toFixed(2)}, ${h.daysLate} days late)`).join(", ");
  return `New filings for this client wait: invoice ${list} is ${holdDays()}+ days past due. `
    + "Record the payment (\"Mark paid\"), void the invoice, or have a named person lift the hold under Clients, Billing.";
}

/** THE STAGING STOP: throws 402 while an invoice of this project's client holds its filings. */
export function assertNoBillingHold(db: AppDb, project: { clientId: string | null }): void {
  const holds = clientBillingHold(db, project.clientId);
  if (!holds.length) return;
  throw new HttpError(402, billingHoldSentence(holds), { billingHold: true, invoices: holds.map((h) => h.number) });
}

/** The invoice through its own client only (another client's invoice is a 404), past due and still
 *  open; returns how late it is. */
function requireOverdue(db: AppDb, clientId: string, invoiceId: string, now = new Date()): { row: Row; daysLate: number } {
  const row = db.get<Row>("SELECT id, number, status, due_at FROM client_invoices WHERE id = ? AND client_id = ?", [invoiceId, clientId]);
  if (!row) throw new HttpError(404, "Invoice not found.");
  const number = text(row.number);
  const status = text(row.status);
  const dueAt = text(row.due_at);
  if (status !== "sent" || !dueAt) throw new HttpError(409, `Invoice ${number} is ${status}${dueAt ? "" : " with no due date"}: there is nothing to chase.`);
  const daysLate = daysLateOf(dueAt, now);
  if (daysLate < 0) throw new HttpError(409, `Invoice ${number} is not due until ${dueAt}.`);
  return { row, daysLate };
}

/** The reminder email's text: the invoice, with one line on top saying how late it is. */
export function reminderText(inv: ClientInvoice, daysLate: number, invoiceBody: string): { subject: string; body: string } {
  const when = daysLate === 0 ? "is due today" : `was due ${inv.dueAt} (${daysLate} day${daysLate === 1 ? "" : "s"} ago)`;
  return {
    subject: `Reminder: invoice ${inv.number} ${daysLate === 0 ? "is due today" : "is past due"}`,
    body: `A reminder that invoice ${inv.number} ${when}. The amount due is $${inv.dueTotalUsd.toFixed(2)}.\n`
      + "If you have already paid, thank you, and please reply with the payment reference so we can match it.\n\n"
      + invoiceBody,
  };
}

export interface ReminderResult { delivered: boolean; detail: string; kind: ReminderKind; invoice: ClientInvoice }

/**
 * A NAMED PERSON SENDS A REMINDER. Through the one client-email switch; recorded on the invoice and in
 * the CRM either way. The kind is the one due now (the late one from N days after the due date).
 * The send function is injectable so a test never opens a connection.
 */
export async function sendInvoiceReminder(
  db: AppDb,
  clientId: string,
  invoiceId: string,
  by: string,
  deps: { send?: (to: string, subject: string, body: string) => Promise<void>; now?: Date } = {},
): Promise<ReminderResult> {
  const who = text(by).trim().slice(0, 120);
  if (!who) throw new HttpError(400, "Name the person sending the reminder.");
  const { daysLate } = requireOverdue(db, clientId, invoiceId, deps.now);
  const { getClientInvoice, invoiceText } = await import("./clientInvoices");
  const { getClient } = await import("./clients");
  const inv = getClientInvoice(db, clientId, invoiceId);
  const kind: ReminderKind = daysLate >= reminderLateDays() ? "late" : "due";
  const client = getClient(db, clientId);
  const billTo = text(inv.billTo) || text(client.billingContactEmail) || text(client.businessEmail) || text(client.contactEmail);
  const { clientEmailsOffFor, smtpConfigured, sendEmail } = await import("./clientNotifier");
  const { clientLinkRefusal } = await import("./clientLinkGuard");
  const { addCommunication } = await import("./crm");
  const { subject, body } = reminderText(inv, daysLate, invoiceText(inv, BRAND));
  const orgRow = db.get<Row>("SELECT org_id FROM clients WHERE id = ?", [clientId]);
  const ts = nowIso();
  const record = (delivered: boolean, status: string, detail: string): void => {
    addCommunication(db, {
      projectId: null, direction: "outbound", channel: "email", subject, body, loggedBy: who,
      orgId: text(orgRow?.org_id) || undefined, deliveryStatus: status, deliveryDetail: detail, recipient: billTo,
    });
    db.run(
      "INSERT INTO invoice_reminders (id, invoice_id, kind, sent_by, sent_at, delivered, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [newId(), invoiceId, kind, who, ts, delivered ? 1 : 0, detail.slice(0, 500)],
    );
  };
  let detail = "";
  const linkRefusal = clientLinkRefusal({ body, carriesLink: false });
  if (!billTo) detail = "No billing contact, business email or primary contact on file for this client.";
  else if (clientEmailsOffFor(clientId)) detail = "Client email is switched off (CLIENT_NOTIFICATIONS) and this client is not on the allow list.";
  else if (linkRefusal) detail = linkRefusal;
  else if (!deps.send && !smtpConfigured()) detail = "SMTP is not configured; the reminder is saved as a draft to send by hand.";
  if (detail) {
    record(false, "draft", detail);
    return { delivered: false, detail, kind, invoice: inv };
  }
  try {
    await (deps.send ?? ((to, s, b) => sendEmail(to, s, b)))(billTo, subject, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record(false, "failed", msg);
    return { delivered: false, detail: `The reminder did not send: ${msg}`, kind, invoice: inv };
  }
  record(true, "sent", "");
  return { delivered: true, detail: "", kind, invoice: inv };
}

/**
 * A NAMED PERSON LIFTS THE HOLD for one invoice, with a reason (a payment plan, a dispute being
 * settled). The invoice stays owed and on the overdue list; only its hold on new filings ends. Once.
 */
export function liftBillingHold(db: AppDb, clientId: string, invoiceId: string, reason: unknown, by: string): OverdueInvoice[] {
  const who = text(by).trim().slice(0, 120);
  if (!who) throw new HttpError(400, "Name the person lifting the hold.");
  const why = text(reason).trim().slice(0, 300);
  if (!why) throw new HttpError(400, "Say why the hold is lifted.");
  requireOverdue(db, clientId, invoiceId);
  db.run(
    `INSERT INTO invoice_hold_lifts (id, invoice_id, client_id, lifted_by, lifted_at, reason) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(invoice_id) DO NOTHING`,
    [newId(), invoiceId, clientId, who, nowIso(), why],
  );
  return clientBillingHold(db, clientId);
}

/** The client's projects an autopilot run may have stopped on: resumed when a hold clears. */
export function clientProjectIds(db: AppDb, clientId: string): string[] {
  return db.query<Row>("SELECT id FROM projects WHERE client_id = ?", [clientId]).map((r) => text(r.id));
}
