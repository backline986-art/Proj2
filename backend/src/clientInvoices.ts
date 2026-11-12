// ---------------------------------------------------------------------------
// CLIENT INVOICES AND THE BILLING LEDGER (#700).
//
// invoices.ts answers "what does this payment row bill?" and never writes. This module turns that
// answer into invoices a person can see, send and track, and keeps the LEDGER: every line that went
// on an invoice, with the payment row it came from.
//
// ONE LINE, ONE INVOICE. A line key names what is billed — "<payment row id>:<kind>" — and the
// schema lets a key sit on at most one live line (ux_client_invoice_lines_live_key, migration v73).
// A statement leaves out every key already on a live invoice, so billing the same project in two
// periods, or pressing "Create invoice" twice, never repeats a charge. Voiding an invoice releases
// its lines (released_at) and a later invoice may carry them again.
//
// THE AMOUNTS ARE invoices.ts's, unchanged (#699: only what Keelix is owed, a gate payment shown as
// received, never an estimate). This module decides only WHICH lines are new and WHEN they fall due.
//
// TRUE-UP. A reimbursement billed PROVISIONALLY from the published schedule is settled when the
// portal's real figure is recorded: the next statement carries the difference as an adjustment line
// (key "<row>:reimbursement:adj:<fee_recorded_at>", so re-entering a corrected figure adjusts once
// more and the same figure never adjusts twice). A fee that was invoiced and now reads as not ours
// at all is NOT credited automatically: a credit is a person's call, so it is listed for one.
//
// PERIODS. A statement for [start, end) carries every unbilled line whose date is before `end`. A
// line from an earlier period that was never billed is carried forward and marked so: the point of
// a ledger is that nothing is missed, and a line that fell between two statements would be.
//
// Universal: nothing here is keyed to a state, utility, portal or AHJ. The inputs are the client's
// billing mode, the stamped fee responsibility and the payment rows.
//
// NOTHING HERE PAYS OR CHARGES ANYTHING (rule 1). "Mark paid" records money a person saw arrive;
// sending emails the invoice to the client's billing contact through the one client-email switch
// (clientEmailsOffFor) and records the message in the CRM either way.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import type { ClientRecord, ProjectRecord, SubmissionPaymentRecord } from "../../shared/src/types";
import { invoiceLinesForPayment, type InvoiceExclusion, type InvoiceLine, type InvoiceTrack } from "./invoices";
import { getSubmissionPayment } from "./submissionFees";
import { billedOnStatement, listFilingCharges, resolveServicePrice, TRACK_NAMES } from "./servicePrices";
import { getClient } from "./clients";
import { mapProject } from "./repository";
import { HttpError } from "./httpError";
import { id as newId } from "./ids";
import { text } from "./json";
import { nowIso } from "./time";
import { BRAND } from "./brand";

type Row = Record<string, unknown>;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export type ClientInvoiceStatus = "draft" | "sent" | "paid" | "void";
/** onboarding (#701): a line a PERSON adds to a draft invoice (the client onboarding fee, or its credit
 *  back as a negative amount). Revenue like service; never generated, never priced by code. */
export type LedgerLineKind = "reimbursement" | "service" | "received" | "onboarding";
export type LedgerLineRole = "charge" | "adjustment" | "received" | "manual";

/** One line of a statement or invoice. */
export interface LedgerLine {
  lineKey: string;
  projectId: string;
  paymentId: string;
  /** Homeowner and address, so the solar company can tell its jobs apart. */
  projectLabel: string;
  track: InvoiceTrack;
  kind: LedgerLineKind;
  role: LedgerLineRole;
  basis: string;
  provisional: boolean;
  /** Collected at the per-submission gate already: shown, never in the amount due. */
  alreadyPaid: boolean;
  amountUsd: number;
  description: string;
  paymentReference: string;
  /** The date the line falls due on: when the fee was recorded, the gate was paid, or the quote made. */
  eventAt: string;
  /** Before the statement's period: an unbilled line carried forward rather than lost. */
  carriedForward: boolean;
  /** A reimbursement's published split and reconciliation note, from invoices.ts. */
  composition: InvoiceLine["composition"];
  reconciliation: string;
  /** For an adjustment: what was billed before, and on which invoice(s). */
  adjusts: { billedUsd: number; invoiceNumbers: string[] } | null;
}

export interface StatementExclusion extends InvoiceExclusion {
  projectId: string;
  projectLabel: string;
}

export interface StatementTotals {
  /** Fees we advanced, still due, adjustments included. Pass-through. */
  reimbursementTotalUsd: number;
  /** Our own service fees still due, onboarding fees and credits included. Revenue. */
  serviceTotalUsd: number;
  /** Paid at the gate before this invoice: shown, never charged. */
  receivedTotalUsd: number;
  /** reimbursement + service. The only sum, and it is of money still owed. */
  dueTotalUsd: number;
}

export interface ClientStatement extends StatementTotals {
  clientId: string;
  clientName: string;
  billTo: string;
  billToSource: "billing_contact" | "business_email" | "primary_contact" | "none";
  billingMode: string;
  periodStart: string;
  periodEnd: string;
  lines: LedgerLine[];
  excluded: StatementExclusion[];
  /** Portal logins with no recorded fee agreement: a fee we advance through them cannot be invoiced. */
  loginsWithoutFeeAgreement: string[];
  /** Said out loud for a client not billed per submission: the monthly plan amount is not set here. */
  notes: string[];
  generatedAt: string;
}

export interface ClientInvoice extends StatementTotals {
  id: string;
  number: string;
  clientId: string;
  clientName: string;
  periodStart: string;
  periodEnd: string;
  status: ClientInvoiceStatus;
  billTo: string;
  billingMode: string;
  issuedAt: string;
  dueAt: string;
  paidAt: string;
  paidReference: string;
  voidedAt: string;
  voidReason: string;
  externalRef: string;
  /** QuickBooks (#701): who sent it there and when, and what the daily read last saw. */
  qbPushedBy: string;
  qbPushedAt: string;
  qbStatus: string;
  qbBalanceUsd: number | null;
  qbCheckedAt: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lines: LedgerLine[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A period from either {month: "YYYY-MM"} or {periodStart, periodEnd} as YYYY-MM-DD (end exclusive). */
export function resolvePeriod(input: { month?: unknown; periodStart?: unknown; periodEnd?: unknown }): { periodStart: string; periodEnd: string } {
  const month = text(input.month).trim();
  if (month) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new HttpError(400, "month must be YYYY-MM.");
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`;
    return { periodStart: `${month}-01`, periodEnd: next };
  }
  const periodStart = text(input.periodStart).trim();
  const periodEnd = text(input.periodEnd).trim();
  if (!ISO_DATE.test(periodStart) || !ISO_DATE.test(periodEnd) || Number.isNaN(Date.parse(periodStart)) || Number.isNaN(Date.parse(periodEnd))) {
    throw new HttpError(400, "Give a month (YYYY-MM) or periodStart and periodEnd (YYYY-MM-DD, end not included).");
  }
  if (periodEnd <= periodStart) throw new HttpError(400, "periodEnd must be after periodStart.");
  return { periodStart, periodEnd };
}

function billToFor(client: ClientRecord): { billTo: string; billToSource: ClientStatement["billToSource"] } {
  const billing = text(client.billingContactEmail);
  if (billing) return { billTo: billing, billToSource: "billing_contact" };
  if (text(client.businessEmail)) return { billTo: text(client.businessEmail), billToSource: "business_email" };
  if (text(client.contactEmail)) return { billTo: text(client.contactEmail), billToSource: "primary_contact" };
  return { billTo: "", billToSource: "none" };
}

function projectLabel(project: ProjectRecord): string {
  return [text(project.homeownerName), text(project.projectAddress)].filter(Boolean).join(", ") || project.id;
}

function loadClient(db: AppDb, clientId: string): ClientRecord {
  // getClient throws a 404 for an unknown id, which is what every caller wants.
  return getClient(db, clientId);
}

/** Live ledger lines (on a draft, sent or paid invoice) for these payment rows, by line key. */
function liveLinesByPayment(db: AppDb, paymentIds: string[]): Map<string, Array<{ lineKey: string; amountUsd: number; role: string; invoiceNumber: string }>> {
  const out = new Map<string, Array<{ lineKey: string; amountUsd: number; role: string; invoiceNumber: string }>>();
  if (!paymentIds.length) return out;
  // Chunked: SQLite caps bound parameters.
  for (let i = 0; i < paymentIds.length; i += 400) {
    const chunk = paymentIds.slice(i, i + 400);
    const rows = db.query<Row>(
      `SELECT l.payment_id, l.line_key, l.amount_usd, l.role, i.number
         FROM client_invoice_lines l JOIN client_invoices i ON i.id = l.invoice_id
        WHERE l.released_at IS NULL AND l.payment_id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
    for (const r of rows) {
      const key = text(r.payment_id);
      const list = out.get(key) ?? [];
      list.push({ lineKey: text(r.line_key), amountUsd: Number(r.amount_usd) || 0, role: text(r.role), invoiceNumber: text(r.number) });
      out.set(key, list);
    }
  }
  return out;
}

function totalsOf(lines: LedgerLine[]): StatementTotals {
  const due = (kind: LedgerLineKind): number =>
    round2(lines.filter((l) => l.kind === kind && !l.alreadyPaid).reduce((t, l) => t + l.amountUsd, 0));
  const reimbursementTotalUsd = due("reimbursement");
  // An onboarding line (fee or credit) is our own revenue, so it sits in the service total.
  const serviceTotalUsd = round2(due("service") + due("onboarding"));
  const receivedTotalUsd = round2(lines.filter((l) => l.kind === "received").reduce((t, l) => t + l.amountUsd, 0));
  return { reimbursementTotalUsd, serviceTotalUsd, receivedTotalUsd, dueTotalUsd: round2(reimbursementTotalUsd + serviceTotalUsd) };
}

/** The date a line falls due on. */
function eventDate(line: InvoiceLine, row: SubmissionPaymentRecord): string {
  if (line.kind === "service" && line.alreadyPaid) return text(row.paidAt) || text(row.quotedAt);
  return text(line.recordedAt) || text(row.feeRecordedAt) || text(row.paidAt) || text(row.quotedAt) || text(row.updatedAt);
}

/**
 * THE STATEMENT BUILDER: every payment row on the client's projects, through invoiceLinesForPayment,
 * minus what the ledger says is already billed. READS ONLY: previewing a statement writes nothing.
 */
export function buildClientStatement(db: AppDb, clientId: string, period: { periodStart: string; periodEnd: string }): ClientStatement {
  const client = loadClient(db, clientId);
  const { periodStart, periodEnd } = period;
  const billingMode = text(client.billingMode).toLowerCase();
  const perSubmission = billingMode === "per_submission";

  const projectRows = db.query<Row>("SELECT * FROM projects WHERE client_id = ? ORDER BY created_at", [clientId]);
  const projects = projectRows.map((r) => mapProject(r as Parameters<typeof mapProject>[0]));
  const rows: Array<{ project: ProjectRecord; row: SubmissionPaymentRecord }> = [];
  for (const project of projects) {
    for (const track of ["permit", "nem"] as const) {
      const row = getSubmissionPayment(db, project.id, track);
      if (row) rows.push({ project, row });
    }
  }
  const billed = liveLinesByPayment(db, rows.map((r) => r.row.id));

  const lines: LedgerLine[] = [];
  const excluded: StatementExclusion[] = [];
  const inPeriod = (at: string): boolean => !at || at.slice(0, 10) < periodEnd;
  const carried = (at: string): boolean => Boolean(at) && at.slice(0, 10) < periodStart;

  for (const { project, row } of rows) {
    const label = projectLabel(project);
    const out = invoiceLinesForPayment(db, project, client, row);
    const prior = billed.get(row.id) ?? [];
    const priorKeys = new Set(prior.map((p) => p.lineKey));
    const rowDate = text(row.feeRecordedAt) || text(row.paidAt) || text(row.quotedAt);

    const mk = (line: InvoiceLine, over: Partial<LedgerLine>): LedgerLine => {
      const at = over.eventAt ?? eventDate(line, row);
      return {
        lineKey: `${row.id}:${line.kind}`,
        projectId: project.id,
        paymentId: row.id,
        projectLabel: label,
        track: line.track,
        kind: line.kind,
        role: "charge",
        basis: line.basis,
        provisional: line.provisional,
        alreadyPaid: line.alreadyPaid,
        amountUsd: round2(line.amountUsd),
        description: line.description,
        paymentReference: line.paymentReference,
        eventAt: at,
        carriedForward: carried(at),
        composition: line.composition,
        reconciliation: line.reconciliation,
        adjusts: null,
        ...over,
      };
    };

    let reimbursementSeen = false;
    for (const line of out.lines) {
      if (line.kind === "service") {
        // A PER-SUBMISSION SERVICE FEE NOT YET PAID AT THE GATE IS NOT BILLED HERE. The gate collects
        // it before staging (#699), so an unpaid row is a filing that has not been staged: invoicing
        // it would bill for work not done. It is listed instead, so a person can see it.
        if (!line.alreadyPaid) {
          if (inPeriod(rowDate) && !priorKeys.has(`${row.id}:service`)) {
            excluded.push({
              track: line.track, projectId: project.id, projectLabel: label,
              reason: `The service fee of $${line.amountUsd.toFixed(2)} has not been paid at the per-submission gate, so this filing has not been staged yet.`,
              resolution: "Nothing to bill yet: the gate collects it before staging (\"Client paid us\").",
              amountSeenUsd: line.amountUsd,
            });
          }
          continue;
        }
        const ledgerLine = mk(line, {});
        if (!priorKeys.has(ledgerLine.lineKey) && inPeriod(ledgerLine.eventAt)) lines.push(ledgerLine);
        continue;
      }

      // reimbursement
      reimbursementSeen = true;
      const baseKey = `${row.id}:reimbursement`;
      const priorReimb = prior.filter((p) => p.lineKey === baseKey || p.lineKey.startsWith(`${baseKey}:adj:`));
      if (!priorReimb.some((p) => p.lineKey === baseKey)) {
        const ledgerLine = mk(line, {});
        if (inPeriod(ledgerLine.eventAt)) lines.push(ledgerLine);
        continue;
      }
      // Already invoiced. A provisional figure is settled only by a RECORDED one (true-up).
      if (line.provisional) continue;
      const billedUsd = round2(priorReimb.reduce((t, p) => t + p.amountUsd, 0));
      const diff = round2(line.amountUsd - billedUsd);
      const adjKey = `${baseKey}:adj:${text(row.feeRecordedAt) || "recorded"}`;
      if (diff === 0 || priorKeys.has(adjKey)) continue;
      const at = text(row.feeRecordedAt) || eventDate(line, row);
      if (!inPeriod(at)) continue;
      lines.push(mk(line, {
        lineKey: adjKey,
        role: "adjustment",
        amountUsd: diff,
        eventAt: at,
        carriedForward: carried(at),
        description: `${line.description} — true-up: the portal's recorded figure is $${line.amountUsd.toFixed(2)}; $${billedUsd.toFixed(2)} was invoiced before`,
        adjusts: { billedUsd, invoiceNumbers: [...new Set(priorReimb.map((p) => p.invoiceNumber))] },
      }));
    }

    // Invoiced before, and the fee no longer reads as ours to bill at all: a person decides on a credit.
    const priorReimbursement = prior.filter((p) => p.lineKey.startsWith(`${row.id}:reimbursement`));
    const priorReimbUsd = round2(priorReimbursement.reduce((t, p) => t + p.amountUsd, 0));
    if (!reimbursementSeen && priorReimbursement.length && priorReimbUsd !== 0) {
      const why = out.excluded.map((x) => x.reason).join(" ");
      excluded.push({
        track: (row.track === "nem" ? "nem" : "permit"), projectId: project.id, projectLabel: label,
        reason: `$${priorReimbUsd.toFixed(2)} was invoiced for this fee (${[...new Set(priorReimbursement.map((p) => p.invoiceNumber))].join(", ")}), and it no longer reads as ours to bill: ${why}`.trim(),
        resolution: "Decide whether the client is owed a credit. Nothing is credited automatically.",
        amountSeenUsd: priorReimbUsd,
      });
    }

    // What the client already paid at the gate, shown once, on the invoice that carries it.
    for (const r of out.received) {
      const key = `${row.id}:received`;
      const at = text(r.receivedAt) || rowDate;
      if (priorKeys.has(key) || !inPeriod(at)) continue;
      lines.push({
        lineKey: key, projectId: project.id, paymentId: row.id, projectLabel: label,
        track: r.track, kind: "received", role: "received", basis: "received",
        provisional: false, alreadyPaid: true,
        amountUsd: r.amountUsd == null ? 0 : round2(r.amountUsd),
        description: r.description,
        paymentReference: r.paymentReference,
        eventAt: at, carriedForward: carried(at),
        composition: [], reconciliation: "", adjusts: null,
      });
    }

    // Exclusions. Listed for the period they belong to, and earlier ones only while a person still
    // has something to do about them; "Nothing to do" from years ago is not news every month.
    const rowInPeriod = inPeriod(rowDate) && !carried(rowDate);
    for (const x of out.excluded) {
      const actionable = !/^Nothing to do/i.test(x.resolution);
      // A gate-paid service fee under a since-changed billing mode: the payment is on the ledger.
      if (/already paid/i.test(x.resolution) && priorKeys.has(`${row.id}:received`)) continue;
      if (rowInPeriod || (actionable && inPeriod(rowDate))) {
        excluded.push({ ...x, projectId: project.id, projectLabel: label });
      }
    }
  }

  // ── OUR PRICE PER FILING (#187) ─────────────────────────────────────────────────────────
  // Every filing recorded while this client was NOT billed per submission is one service line, at the
  // price saved on it when it was filed. A per-submission filing was paid at the gate (above) and is
  // never billed again. A filing saved with no price (none was set then) is priced from the price in
  // force now, and says so; with still no price it is listed, never billed at $0. A filing a person
  // waived is not billed. Line key "filing:<charge id>:service": one line, one invoice, as above.
  const charges = listFilingCharges(db, clientId).filter((c) => billedOnStatement(c));
  const billedCharges = liveLinesByPayment(db, charges.map((c) => c.id));
  for (const c of charges) {
    const lineKey = `filing:${c.id}:service`;
    if ((billedCharges.get(c.id) ?? []).some((p) => p.lineKey === lineKey)) continue;
    const at = c.filedAt;
    if (!inPeriod(at)) continue;
    const label = [text(c.project.homeownerName), text(c.project.projectAddress)].filter(Boolean).join(", ") || c.projectId;
    const kindName = TRACK_NAMES[c.track];
    const filing = c.permitType && c.permitType !== c.track ? `${c.permitType} ${kindName}` : kindName;
    if (c.waivedAt) {
      if (!carried(at)) {
        excluded.push({
          track: c.track, projectId: c.projectId, projectLabel: label,
          reason: `Not billed: ${c.waivedBy || "a person"} waived this ${filing} (${c.waiveReason}).`,
          resolution: "Nothing to do.",
          amountSeenUsd: c.priceUsd,
        });
      }
      continue;
    }
    let amount = c.priceUsd;
    let basis = `Price saved when it was filed: ${c.priceLabel || c.priceBasis}.`;
    if (amount == null) {
      const now = resolveServicePrice(db, clientId, c.track, c.projectId);
      amount = now.priceUsd;
      basis = `No price was set when it was filed; priced now from ${now.label}.`;
    }
    if (amount == null) {
      excluded.push({
        track: c.track, projectId: c.projectId, projectLabel: label,
        reason: `This ${filing} was filed ${at.slice(0, 10)}, and no price per ${kindName} is set for this client or on the price list.`,
        resolution: "Set the price (Clients, Billing, Prices, or this client's own price) and it is billed on the next statement.",
        amountSeenUsd: null,
      });
      continue;
    }
    if (amount === 0) {
      if (!carried(at)) {
        excluded.push({
          track: c.track, projectId: c.projectId, projectLabel: label,
          reason: `This ${filing} is priced at $0 (${basis.replace(/\.$/, "")}).`,
          resolution: "Nothing to do.",
          amountSeenUsd: 0,
        });
      }
      continue;
    }
    lines.push({
      lineKey,
      projectId: c.projectId,
      paymentId: c.id,
      projectLabel: label,
      track: c.track,
      kind: "service",
      role: "charge",
      basis: c.priceBasis,
      provisional: false,
      alreadyPaid: false,
      amountUsd: round2(amount),
      description: `Filing service fee — ${filing} filed ${at.slice(0, 10)}`,
      paymentReference: "",
      eventAt: at,
      carriedForward: carried(at),
      composition: [],
      reconciliation: basis,
      adjusts: null,
    });
  }

  lines.sort((a, b) => (a.eventAt || "").localeCompare(b.eventAt || "") || a.projectLabel.localeCompare(b.projectLabel) || a.lineKey.localeCompare(b.lineKey));

  const logins = db.query<Row>(
    "SELECT portal_type, portal_url FROM portal_credentials WHERE client_id = ? AND TRIM(COALESCE(fee_responsibility, '')) = '' ORDER BY created_at",
    [clientId],
  ).map((r) => text(r.portal_type) || text(r.portal_url));

  const notes: string[] = [];
  if (!perSubmission) {
    notes.push(billingMode
      ? `This client is billed ${billingMode}: each filing is a line at the price saved when it was filed (the client's own price, else the price list).`
      : "No billing mode is set for this client: its filings are billed here at the price saved when each was filed. Set Monthly or Per submission on the client.");
  }

  const { billTo, billToSource } = billToFor(client);
  return {
    clientId,
    clientName: text(client.companyName) || text(client.legalBusinessName),
    billTo,
    billToSource,
    billingMode: billingMode || "monthly/none",
    periodStart,
    periodEnd,
    lines,
    excluded,
    loginsWithoutFeeAgreement: logins,
    notes,
    generatedAt: nowIso(),
    ...totalsOf(lines),
  };
}

// ── invoices ─────────────────────────────────────────────────────────────────────────

function mapLine(r: Row): LedgerLine {
  const detail = (() => { try { return JSON.parse(text(r.detail_json) || "{}") as Record<string, unknown>; } catch { return {}; } })();
  return {
    lineKey: text(r.line_key),
    projectId: text(r.project_id),
    paymentId: text(r.payment_id),
    projectLabel: text(r.project_label),
    track: (text(r.track) === "nem" ? "nem" : "permit"),
    kind: text(r.kind) as LedgerLineKind,
    role: text(r.role) as LedgerLineRole,
    basis: text(r.basis),
    provisional: Number(r.provisional) === 1,
    alreadyPaid: Number(r.already_paid) === 1,
    amountUsd: Number(r.amount_usd) || 0,
    description: text(r.description),
    paymentReference: text(r.payment_reference),
    eventAt: text(r.event_at),
    carriedForward: Boolean(detail.carriedForward),
    composition: Array.isArray(detail.composition) ? (detail.composition as LedgerLine["composition"]) : [],
    reconciliation: text(detail.reconciliation),
    adjusts: (detail.adjusts as LedgerLine["adjusts"]) ?? null,
  };
}

function mapInvoice(db: AppDb, r: Row, withLines = true): ClientInvoice {
  const invoiceId = text(r.id);
  const lines = withLines
    ? db.query<Row>("SELECT * FROM client_invoice_lines WHERE invoice_id = ? ORDER BY event_at, project_label, line_key", [invoiceId]).map(mapLine)
    : [];
  const clientRow = db.get<Row>("SELECT company_name, legal_business_name FROM clients WHERE id = ?", [text(r.client_id)]);
  return {
    id: invoiceId,
    number: text(r.number),
    clientId: text(r.client_id),
    clientName: text(clientRow?.company_name) || text(clientRow?.legal_business_name),
    periodStart: text(r.period_start),
    periodEnd: text(r.period_end),
    status: text(r.status) as ClientInvoiceStatus,
    billTo: text(r.bill_to),
    billingMode: text(r.billing_mode),
    issuedAt: text(r.issued_at),
    dueAt: text(r.due_at),
    paidAt: text(r.paid_at),
    paidReference: text(r.paid_reference),
    voidedAt: text(r.voided_at),
    voidReason: text(r.void_reason),
    externalRef: text(r.external_ref),
    qbPushedBy: text(r.qb_pushed_by),
    qbPushedAt: text(r.qb_pushed_at),
    qbStatus: text(r.qb_status),
    qbBalanceUsd: r.qb_balance_usd == null || r.qb_balance_usd === "" ? null : Number(r.qb_balance_usd),
    qbCheckedAt: text(r.qb_checked_at),
    createdBy: text(r.created_by),
    createdAt: text(r.created_at),
    updatedAt: text(r.updated_at),
    reimbursementTotalUsd: Number(r.reimbursement_total_usd) || 0,
    serviceTotalUsd: Number(r.service_total_usd) || 0,
    receivedTotalUsd: Number(r.received_total_usd) || 0,
    dueTotalUsd: Number(r.due_total_usd) || 0,
    lines,
  };
}

export function listClientInvoices(db: AppDb, clientId: string): ClientInvoice[] {
  loadClient(db, clientId);
  return db.query<Row>("SELECT * FROM client_invoices WHERE client_id = ? ORDER BY created_at DESC, number DESC", [clientId])
    .map((r) => mapInvoice(db, r, false));
}

/** One invoice, only through its own client: another client's invoice id is a 404, never a read. */
export function getClientInvoice(db: AppDb, clientId: string, invoiceId: string): ClientInvoice {
  const row = db.get<Row>("SELECT * FROM client_invoices WHERE id = ? AND client_id = ?", [invoiceId, clientId]);
  if (!row) throw new HttpError(404, "Invoice not found.");
  return mapInvoice(db, row);
}

/** INV-<year>-<4-digit sequence>, one sequence per year across every client. */
function nextInvoiceNumber(db: AppDb, at: string): string {
  const year = at.slice(0, 4);
  const row = db.get<Row>("SELECT number FROM client_invoices WHERE number LIKE ? ORDER BY number DESC LIMIT 1", [`INV-${year}-%`]);
  const last = row ? Number(/-(\d+)$/.exec(text(row.number))?.[1] || 0) : 0;
  return `INV-${year}-${String(last + 1).padStart(4, "0")}`;
}

/** Payment terms in days, for the due date set when an invoice is sent. */
export function invoiceTermsDays(): number {
  const raw = Number(process.env.INVOICE_TERMS_DAYS);
  // Default Net 15: the owner's stated terms (2026-11-10). Data, not a price.
  return Number.isFinite(raw) && raw >= 0 && raw <= 365 ? Math.floor(raw) : 15;
}

/**
 * CREATE AN INVOICE (draft) from the statement for a period. The statement is rebuilt inside the
 * transaction, so what is saved is what the ledger says is unbilled at that instant; the unique index
 * refuses a line another invoice took in the meantime, and the whole invoice rolls back with it.
 */
export function createClientInvoice(db: AppDb, clientId: string, period: { periodStart: string; periodEnd: string }, by: string): ClientInvoice {
  const created = db.transaction(() => {
    const statement = buildClientStatement(db, clientId, period);
    if (!statement.lines.length) {
      throw new HttpError(409, "Nothing to invoice for this period: every billable line is already on an invoice, or nothing is billable yet. See the exclusions on the statement.");
    }
    const ts = nowIso();
    const invoiceId = newId();
    const number = nextInvoiceNumber(db, ts);
    db.run(
      `INSERT INTO client_invoices (id, number, client_id, period_start, period_end, status, bill_to, billing_mode,
         reimbursement_total_usd, service_total_usd, received_total_usd, due_total_usd, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [invoiceId, number, clientId, statement.periodStart, statement.periodEnd, statement.billTo, statement.billingMode,
        statement.reimbursementTotalUsd, statement.serviceTotalUsd, statement.receivedTotalUsd, statement.dueTotalUsd,
        text(by).slice(0, 120), ts, ts],
    );
    for (const l of statement.lines) {
      try {
        db.run(
          `INSERT INTO client_invoice_lines (id, invoice_id, line_key, project_id, payment_id, track, kind, role, basis,
             provisional, already_paid, amount_usd, description, project_label, payment_reference, event_at, detail_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId(), invoiceId, l.lineKey, l.projectId, l.paymentId, l.track, l.kind, l.role, l.basis,
            l.provisional ? 1 : 0, l.alreadyPaid ? 1 : 0, l.amountUsd, l.description, l.projectLabel, l.paymentReference, l.eventAt,
            JSON.stringify({ composition: l.composition, reconciliation: l.reconciliation, adjusts: l.adjusts, carriedForward: l.carriedForward }), ts],
        );
      } catch (err) {
        if (/UNIQUE/i.test(err instanceof Error ? err.message : String(err))) {
          throw new HttpError(409, "Another invoice took one of these lines a moment ago. Refresh the statement and try again.");
        }
        throw err;
      }
    }
    return invoiceId;
  });
  return getClientInvoice(db, clientId, created);
}

function requireStatus(inv: ClientInvoice, allowed: ClientInvoiceStatus[], action: string): void {
  if (!allowed.includes(inv.status)) {
    throw new HttpError(409, `Invoice ${inv.number} is ${inv.status}; it cannot be ${action}.`);
  }
}

/** Recompute an invoice's stored totals from its own live lines. */
function refreshInvoiceTotals(db: AppDb, invoiceId: string): void {
  const lines = db.query<Row>("SELECT * FROM client_invoice_lines WHERE invoice_id = ? AND released_at IS NULL", [invoiceId]).map(mapLine);
  const t = totalsOf(lines);
  db.run(
    "UPDATE client_invoices SET reimbursement_total_usd = ?, service_total_usd = ?, received_total_usd = ?, due_total_usd = ?, updated_at = ? WHERE id = ?",
    [t.reimbursementTotalUsd, t.serviceTotalUsd, t.receivedTotalUsd, t.dueTotalUsd, nowIso(), invoiceId],
  );
}

/**
 * A LINE A PERSON ADDS to a DRAFT invoice (#701): the client onboarding fee, or its credit back as a
 * negative amount. The amount is whatever the person types: nothing here knows a price. A draft only,
 * and never once it has gone to QuickBooks, so what was sent is what the ledger says.
 */
export function addManualInvoiceLine(
  db: AppDb,
  clientId: string,
  invoiceId: string,
  input: { kind?: unknown; amountUsd?: unknown; description?: unknown; serviceDate?: unknown },
  by: string,
): ClientInvoice {
  const inv = getClientInvoice(db, clientId, invoiceId);
  requireStatus(inv, ["draft"], "changed (only a draft takes a new line)");
  if (inv.externalRef) throw new HttpError(409, `Invoice ${inv.number} is already in QuickBooks; it cannot be changed here.`);
  const kind = text(input.kind) || "onboarding";
  if (kind !== "onboarding") throw new HttpError(400, "Only an onboarding fee or credit line can be added by hand.");
  const amount = Number(input.amountUsd);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1_000_000) {
    throw new HttpError(400, "Enter the amount: positive for a fee, negative for a credit back.");
  }
  const description = text(input.description).trim().slice(0, 300)
    || (amount < 0 ? "Client onboarding fee — credit" : "Client onboarding fee");
  const serviceDate = text(input.serviceDate).trim();
  if (serviceDate && !ISO_DATE.test(serviceDate)) throw new HttpError(400, "serviceDate must be YYYY-MM-DD.");
  const ts = nowIso();
  db.transaction(() => {
    db.run(
      `INSERT INTO client_invoice_lines (id, invoice_id, line_key, project_id, payment_id, track, kind, role, basis,
         provisional, already_paid, amount_usd, description, project_label, payment_reference, event_at, detail_json, created_at)
       VALUES (?, ?, ?, '', '', '', 'onboarding', 'manual', 'manual', 0, 0, ?, ?, ?, '', ?, ?, ?)`,
      [newId(), invoiceId, `manual:${newId()}`, round2(amount), description, inv.clientName,
        serviceDate || ts.slice(0, 10), JSON.stringify({ addedBy: text(by).slice(0, 120) }), ts],
    );
    refreshInvoiceTotals(db, invoiceId);
  });
  return getClientInvoice(db, clientId, invoiceId);
}

/** Mark sent: the invoice has gone to the client (by our email or by hand). Sets issued and due dates once. */
export function markClientInvoiceSent(db: AppDb, clientId: string, invoiceId: string): ClientInvoice {
  const inv = getClientInvoice(db, clientId, invoiceId);
  requireStatus(inv, ["draft", "sent"], "marked sent");
  if (inv.status === "sent") return inv;
  const ts = nowIso();
  const due = new Date(Date.parse(ts) + invoiceTermsDays() * 86_400_000).toISOString().slice(0, 10);
  db.run("UPDATE client_invoices SET status = 'sent', issued_at = ?, due_at = ?, updated_at = ? WHERE id = ?", [ts, due, ts, invoiceId]);
  return getClientInvoice(db, clientId, invoiceId);
}

/** Mark paid: a person saw the client's payment arrive. Records it; moves no money. */
export function markClientInvoicePaid(db: AppDb, clientId: string, invoiceId: string, reference: string): ClientInvoice {
  const inv = getClientInvoice(db, clientId, invoiceId);
  requireStatus(inv, ["draft", "sent"], "marked paid");
  const ts = nowIso();
  db.run(
    "UPDATE client_invoices SET status = 'paid', paid_at = ?, paid_reference = ?, issued_at = CASE WHEN issued_at = '' THEN ? ELSE issued_at END, updated_at = ? WHERE id = ?",
    [ts, text(reference).slice(0, 200), ts, ts, invoiceId],
  );
  return getClientInvoice(db, clientId, invoiceId);
}

/**
 * VOID releases the invoice's lines, so a later invoice may bill them. A PAID invoice is not voided
 * here: money was received against it, and undoing that is a credit or refund a person arranges.
 */
export function voidClientInvoice(db: AppDb, clientId: string, invoiceId: string, reason: string): ClientInvoice {
  const why = text(reason).trim();
  if (!why) throw new HttpError(400, "Say why the invoice is void.");
  const inv = getClientInvoice(db, clientId, invoiceId);
  requireStatus(inv, ["draft", "sent"], "voided (a paid invoice needs a credit, which a person arranges)");
  const ts = nowIso();
  db.transaction(() => {
    db.run("UPDATE client_invoices SET status = 'void', voided_at = ?, void_reason = ?, updated_at = ? WHERE id = ?", [ts, why.slice(0, 300), ts, invoiceId]);
    db.run("UPDATE client_invoice_lines SET released_at = ? WHERE invoice_id = ? AND released_at IS NULL", [ts, invoiceId]);
  });
  return getClientInvoice(db, clientId, invoiceId);
}

/** Where each of a project's lines was billed, for the project page. Live lines only. */
export function projectLedgerEntries(db: AppDb, projectId: string): Array<{ lineKey: string; track: string; kind: string; role: string; amountUsd: number; invoiceId: string; invoiceNumber: string; invoiceStatus: string }> {
  return db.query<Row>(
    `SELECT l.line_key, l.track, l.kind, l.role, l.amount_usd, i.id AS invoice_id, i.number, i.status
       FROM client_invoice_lines l JOIN client_invoices i ON i.id = l.invoice_id
      WHERE l.project_id = ? AND l.released_at IS NULL ORDER BY l.created_at`,
    [projectId],
  ).map((r) => ({
    lineKey: text(r.line_key), track: text(r.track), kind: text(r.kind), role: text(r.role), amountUsd: Number(r.amount_usd) || 0,
    invoiceId: text(r.invoice_id), invoiceNumber: text(r.number), invoiceStatus: text(r.status),
  }));
}

// ── the email ────────────────────────────────────────────────────────────────────────

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The invoice as plain text: the email body, and what the CRM records. */
export function invoiceText(inv: ClientInvoice, company: string): string {
  const out: string[] = [];
  out.push(`Invoice ${inv.number}${company ? ` from ${company}` : ""}`);
  out.push(`To: ${inv.clientName}${inv.billTo ? ` <${inv.billTo}>` : ""}`);
  out.push(`Period: ${inv.periodStart} to ${inv.periodEnd} (end not included)`);
  if (inv.issuedAt) out.push(`Issued: ${inv.issuedAt.slice(0, 10)}`);
  if (inv.dueAt) out.push(`Due: ${inv.dueAt}`);
  out.push("");
  const section = (title: string, list: LedgerLine[]): void => {
    if (!list.length) return;
    out.push(title);
    for (const l of list) {
      out.push(`  ${l.eventAt.slice(0, 10) || "          "}  ${l.projectLabel}`);
      out.push(`      ${l.description}${l.provisional ? " (provisional)" : ""}${l.alreadyPaid && l.kind !== "received" ? " (already paid)" : ""}  ${usd(l.amountUsd)}`);
    }
    out.push("");
  };
  section("Fees we paid on your behalf, billed at cost:", inv.lines.filter((l) => l.kind === "reimbursement"));
  section("Our service fees:", inv.lines.filter((l) => l.kind === "service" || l.kind === "onboarding"));
  section("Payments already received:", inv.lines.filter((l) => l.kind === "received"));
  out.push(`Fees at cost: ${usd(inv.reimbursementTotalUsd)}`);
  out.push(`Service fees: ${usd(inv.serviceTotalUsd)}`);
  out.push(`AMOUNT DUE: ${usd(inv.dueTotalUsd)}`);
  return out.join("\n");
}

export interface InvoiceSendResult {
  delivered: boolean;
  detail: string;
  invoice: ClientInvoice;
}

/**
 * EMAIL THE INVOICE to the client's billing contact, through the same switch as every client email:
 * CLIENT_NOTIFICATIONS off silences it unless the client is on CLIENT_NOTIFICATIONS_ALLOW_CLIENTS.
 * Without SMTP, or silenced, the message is recorded in the CRM as a DRAFT and the invoice stays as it
 * was, so a person can send it by hand and press "Mark sent". A delivered email marks it sent.
 * The send function is injectable so a test never opens a connection.
 */
export async function sendClientInvoice(
  db: AppDb,
  clientId: string,
  invoiceId: string,
  by: string,
  deps: { send?: (to: string, subject: string, body: string) => Promise<void> } = {},
): Promise<InvoiceSendResult> {
  const inv = getClientInvoice(db, clientId, invoiceId);
  requireStatus(inv, ["draft", "sent"], "sent");
  const client = loadClient(db, clientId);
  const { billTo } = billToFor(client);
  const { clientEmailsOffFor, smtpConfigured, sendEmail } = await import("./clientNotifier");
  const { clientLinkRefusal } = await import("./clientLinkGuard");
  const { addCommunication } = await import("./crm");
  const company = BRAND;
  const subject = `Invoice ${inv.number}: ${inv.periodStart} to ${inv.periodEnd}`;
  const body = invoiceText(inv, company);
  const orgRow = db.get<Row>("SELECT org_id FROM clients WHERE id = ?", [clientId]);
  const record = (status: string, detail: string): void => {
    addCommunication(db, {
      projectId: null, direction: "outbound", channel: "email", subject, body, loggedBy: text(by) || "invoice",
      orgId: text(orgRow?.org_id) || undefined, deliveryStatus: status, deliveryDetail: detail, recipient: billTo,
    });
  };

  // NO DEAD LINK TO A CLIENT (clientLinkGuard.ts). The invoice text builds no link from PUBLIC_BASE_URL
  // today (carriesLink false), so only a local link in its own text refuses it; one added later is caught.
  const linkRefusal = clientLinkRefusal({ body, carriesLink: false });
  let detail = "";
  if (!billTo) detail = "No billing contact, business email or primary contact on file for this client.";
  else if (clientEmailsOffFor(clientId)) detail = "Client email is switched off (CLIENT_NOTIFICATIONS) and this client is not on the allow list.";
  else if (linkRefusal) detail = linkRefusal;
  else if (!deps.send && !smtpConfigured()) detail = "SMTP is not configured; the email is saved as a draft to send by hand.";
  if (detail) {
    record("draft", detail);
    return { delivered: false, detail, invoice: inv };
  }
  try {
    await (deps.send ?? ((to, s, b) => sendEmail(to, s, b)))(billTo, subject, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record("failed", msg);
    return { delivered: false, detail: `The email did not send: ${msg}`, invoice: inv };
  }
  record("sent", "");
  return { delivered: true, detail: "", invoice: markClientInvoiceSent(db, clientId, invoiceId) };
}
