// ---------------------------------------------------------------------------
// THE CLIENT ONBOARDING FEE AND ITS CREDIT BACK (#208).
//
// The owner's rules: "$500 credited back in projects" (2026-11-10), and on 2026-11-13, "Covers the
// first filings' fees": once a client has PAID its onboarding fee, the credit covers each new filing's
// up-front fee (the per-submission gate) until it is used up. A filing billed on a statement instead
// (a monthly client, a second permit on a gated job) takes what is left there.
//
//   - The fee is DATA: the price list's "onboarding" item per pricing tier (servicePrices.ts). With no
//     onboarding price for the client's tier, nothing is added and no credit exists.
//   - The fee is put on a NEW client's first statement on its own: a client created on or after the
//     day the onboarding price was set, with no onboarding fee on any live invoice yet. An older client
//     gets it only when a person adds it by hand (the existing "add onboarding line" on a draft).
//   - THE CREDIT IS DERIVED, NEVER STORED AS A BALANCE: what the client paid in onboarding fees (the
//     positive onboarding lines on PAID invoices) less what has been used (each PAID gate row's
//     credit_applied_usd, and every negative onboarding line on a live invoice, a person's own credit
//     line included). So a QuickBooks paid-sync, a hand mark-paid and a void all move it with no hook,
//     and nothing can spend the same dollar twice: a quoted gate row only ever claims what the paid
//     rows and the invoices have not.
//   - The credit only ever reduces KEELIX'S OWN fees. It never pays a permit or portal fee (those are
//     the client's, or ours to re-bill at cost) and it is never money handed back.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import { text } from "./json";
import { resolveOnboardingFee } from "./servicePrices";

type Row = Record<string, unknown>;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface OnboardingCredit {
  /** Onboarding fees the client has PAID (positive onboarding lines on paid invoices). */
  paidUsd: number;
  /** Used: paid gate rows' credit, and negative onboarding lines on live invoices. */
  usedUsd: number;
  /** What is left to take off Keelix's fees. Never below 0. */
  remainingUsd: number;
}

/** The client's onboarding credit now. `exceptPaymentId` leaves one gate row out of "used" (the row
 *  being re-quoted). Reads only. */
export function onboardingCredit(db: AppDb, clientId: string | null | undefined, exceptPaymentId = ""): OnboardingCredit {
  if (!clientId) return { paidUsd: 0, usedUsd: 0, remainingUsd: 0 };
  const paid = Number(db.get<Row>(
    `SELECT COALESCE(SUM(l.amount_usd), 0) AS n FROM client_invoice_lines l JOIN client_invoices i ON i.id = l.invoice_id
      WHERE i.client_id = ? AND i.status = 'paid' AND l.kind = 'onboarding' AND l.amount_usd > 0 AND l.released_at IS NULL`,
    [clientId],
  )?.n ?? 0);
  const onInvoices = Number(db.get<Row>(
    `SELECT COALESCE(SUM(-l.amount_usd), 0) AS n FROM client_invoice_lines l JOIN client_invoices i ON i.id = l.invoice_id
      WHERE i.client_id = ? AND i.status <> 'void' AND l.kind = 'onboarding' AND l.amount_usd < 0 AND l.released_at IS NULL`,
    [clientId],
  )?.n ?? 0);
  const atGate = Number(db.get<Row>(
    `SELECT COALESCE(SUM(sp.credit_applied_usd), 0) AS n FROM submission_payments sp JOIN projects p ON p.id = sp.project_id
      WHERE p.client_id = ? AND sp.status = 'paid' AND sp.id <> ?`,
    [clientId, exceptPaymentId],
  )?.n ?? 0);
  const usedUsd = round2(onInvoices + atGate);
  const paidUsd = round2(paid);
  return { paidUsd, usedUsd, remainingUsd: Math.max(0, round2(paidUsd - usedUsd)) };
}

/** The onboarding fee line a NEW client's statement carries, or null. Reads only. */
export function onboardingFeeDue(db: AppDb, clientId: string): { amountUsd: number; tier: string } | null {
  const fee = resolveOnboardingFee(db, clientId);
  if (fee.feeUsd == null || fee.feeUsd <= 0) return null;
  const client = db.get<Row>("SELECT created_at FROM clients WHERE id = ?", [clientId]);
  // New clients only: one created before the price was set signed up on other terms.
  if (!client || text(client.created_at).slice(0, 10) < fee.setAt.slice(0, 10)) return null;
  const already = db.get<Row>(
    `SELECT 1 AS x FROM client_invoice_lines l JOIN client_invoices i ON i.id = l.invoice_id
      WHERE i.client_id = ? AND i.status <> 'void' AND l.kind = 'onboarding' AND l.amount_usd > 0 AND l.released_at IS NULL LIMIT 1`,
    [clientId],
  );
  if (already) return null;
  return { amountUsd: fee.feeUsd, tier: fee.tier };
}

export function creditSentence(c: OnboardingCredit): string {
  return `Onboarding credit: $${c.remainingUsd.toFixed(2)} left of $${c.paidUsd.toFixed(2)} paid.`;
}
