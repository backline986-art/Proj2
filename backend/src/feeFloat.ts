// ---------------------------------------------------------------------------
// THE FEES WE CARRY FOR A CLIENT (owner, 2026-11-13).
//
// New portal logins start on "Keelix pays, bills at cost": a person on our side pays the portal or
// permit fee with the company card so filings move at a predictable speed, and the client is billed
// that exact amount after. Some fees run to $1,300 and one month ran ~$15k, so the owner chose "Both":
//
//   1. BILL EACH JOB'S PAID FEES RIGHT AWAY, DUE ON RECEIPT. Recording a fee paid on a job puts the job's
//      re-billable fee lines on that job's own draft invoice (clientInvoices.draftJobFeeInvoice), not the
//      month-end statement. Sending it stays a person's click; marked sent, it is due that day.
//   2. A LIMIT PER CLIENT on what we carry: fees we paid that the client has not paid us back for (on no
//      invoice yet, or on a draft or sent one). At or over the limit, a filing whose fee WE would pay
//      waits at the staging door until the client pays, a person raises the limit, or the portal login
//      is switched to the client's own card. A filing whose fee the client pays is never held here.
//
// The limit is data: the client's own (clients.fee_limit_usd), else FEE_FLOAT_LIMIT_USD, else $2,500.
// Nothing here pays, charges or sends anything.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import type { ProjectRecord } from "../../shared/src/types";
import { buildClientStatement, draftJobFeeInvoice, type ClientInvoice } from "./clientInvoices";
import { billingTrack, feeResponsibilityNow } from "./submissionFees";
import { HttpError } from "./httpError";
import { text } from "./json";
import { logger } from "./logger";

type Row = Record<string, unknown>;
const round2 = (n: number): number => Math.round(n * 100) / 100;
export const DEFAULT_FEE_LIMIT_USD = 2500;

/** The limit for this client: its own, else the server's, else $2,500. */
export function feeLimitUsd(db: AppDb, clientId: string): number {
  const own = db.get<Row>("SELECT fee_limit_usd FROM clients WHERE id = ?", [clientId])?.fee_limit_usd;
  if (own != null && own !== "" && Number.isFinite(Number(own)) && Number(own) >= 0) return Number(own);
  const env = Number(process.env.FEE_FLOAT_LIMIT_USD);
  return process.env.FEE_FLOAT_LIMIT_USD && Number.isFinite(env) && env >= 0 ? env : DEFAULT_FEE_LIMIT_USD;
}

export interface FeeFloat { owedUsd: number; limitUsd: number; over: boolean }

/** What the client owes us back for fees we paid, against its limit. Reads only. */
export function feeFloat(db: AppDb, clientId: string): FeeFloat {
  const onInvoices = Number(db.get<Row>(
    `SELECT COALESCE(SUM(l.amount_usd), 0) AS n FROM client_invoice_lines l JOIN client_invoices i ON i.id = l.invoice_id
      WHERE i.client_id = ? AND i.status IN ('draft', 'sent') AND l.kind = 'reimbursement' AND l.already_paid = 0 AND l.released_at IS NULL`,
    [clientId],
  )?.n ?? 0);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const unbilled = buildClientStatement(db, clientId, { periodStart: "2000-01-01", periodEnd: tomorrow }).lines
    .filter((l) => l.kind === "reimbursement" && !l.alreadyPaid)
    .reduce((t, l) => t + l.amountUsd, 0);
  const owedUsd = round2(onInvoices + unbilled);
  const limitUsd = feeLimitUsd(db, clientId);
  return { owedUsd, limitUsd, over: owedUsd >= limitUsd && owedUsd > 0 };
}

export function feeFloatSentence(f: FeeFloat): string {
  return `Fees we paid for this client and have not been paid back for: $${f.owedUsd.toFixed(2)} of its $${f.limitUsd.toFixed(2)} limit.`;
}

/** THE STAGING DOOR: refuses (402) a filing whose fee WE would pay while the client is at or over its
 *  limit. A track whose fee the client pays, or with no agreement recorded, is not held here. */
export function assertUnderFeeLimit(db: AppDb, project: ProjectRecord, trackInput?: string | null): void {
  const clientId = text(project.clientId);
  if (!clientId) return;
  const track = billingTrack(trackInput);
  if (feeResponsibilityNow(db, project, track) !== "keelix-pays") return;
  const f = feeFloat(db, clientId);
  if (!f.over) return;
  throw new HttpError(402,
    `New filings whose fee we pay wait for this client: ${feeFloatSentence(f)} `
    + "Send and collect its fee invoices, raise the client's limit, or switch this portal login to the client's own card.",
    { feeLimit: true, owedUsd: f.owedUsd, limitUsd: f.limitUsd });
}

/** After a person records a fee paid on a job: put the job's fees we paid on its own draft invoice.
 *  Never throws: the fee is recorded either way, and the month-end statement still has the line. */
export function afterFeeRecorded(db: AppDb, project: ProjectRecord, by: string): ClientInvoice | null {
  const clientId = text(project.clientId);
  if (!clientId) return null;
  try {
    return draftJobFeeInvoice(db, clientId, project.id, by);
  } catch (err) {
    logger.warn("feeFloat", `could not draft the job fee invoice for project ${project.id}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
