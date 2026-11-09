// ---------------------------------------------------------------------------------------------
// PAYMENT NEEDED (#576): one state and one sentence for a filing the portal wants paid for.
//
// A staging run that stops with pauseReason "fee_payment" (a pay-to-file "Submit & Pay", a pay-now
// dialog, or a fee page after the approved click) ends 'awaiting_payment' — one state, in place of
// the 'paused_for_human' / 'submitted_unconfirmed' it used to split into. Every surface (the run
// row, nextStep, the autopilot rail and segment blocker, the toast, the staff alert, the track
// card) words it from HERE, so none of them can say "complete the challenge" or "stage again":
// staging again would open a second application beside the one waiting to be paid.
//
// Hard rule 1 is unchanged: this is wording and state only. Automation never pays.
// ---------------------------------------------------------------------------------------------
// A LEAF (no imports): the run writer, nextStep, autopilot and the staff alert all read it.

/** The run state a fee_payment stop ends in. */
export const AWAITING_PAYMENT = "awaiting_payment" as const;

/** What the run row's result_json.feeStop carries (portal-bot/src/feeStop.ts FeeStopReading). */
export interface FeeStopRecord {
  read: boolean;
  totalUsd: number | null;
  lines: Array<{ label: string; amountUsd: number }>;
  unreadReason: string;
  where: string;
  shotPath: string;
  pageLink: string;
}

export type Row = Record<string, unknown>;
export const str = (v: unknown): string => (v == null ? "" : String(v));

/** The fee stop on a run's result, normalised; null when the run carries none. Never invents an
 *  amount: a non-positive or non-numeric total is unread. */
export function feeStopOf(result: unknown): FeeStopRecord | null {
  let r: Row | null = null;
  if (typeof result === "string") { try { r = JSON.parse(result) as Row; } catch { r = null; } } else if (result && typeof result === "object") r = result as Row;
  const f = r && typeof r.feeStop === "object" && r.feeStop ? (r.feeStop as Row) : null;
  if (!f) return null;
  const total = typeof f.totalUsd === "number" && Number.isFinite(f.totalUsd) && f.totalUsd > 0 ? f.totalUsd : null;
  const lines = Array.isArray(f.lines)
    ? (f.lines as Row[]).map((l) => ({ label: str(l?.label).slice(0, 120), amountUsd: Number(l?.amountUsd) }))
      .filter((l) => l.label && Number.isFinite(l.amountUsd) && l.amountUsd > 0).slice(0, 24)
    : [];
  return {
    read: f.read === true && total !== null,
    totalUsd: f.read === true ? total : null,
    lines,
    unreadReason: str(f.unreadReason).slice(0, 200),
    where: str(f.where),
    shotPath: str(f.shotPath),
    pageLink: str(f.pageLink),
  };
}

export function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * THE SENTENCE. "Payment needed: $X on <portal>. Pay there, then press Paid." An
 * amount that could not be read is said to be unread — never $0. Never MFA wording, never "stage
 * again". Paid (trackPaid.ts, #576 item 4) records the payment and the filing it completed.
 */
export function paymentNeededSentence(input: { feeStop: FeeStopRecord | null; portalName?: string | null }): string {
  const portal = str(input.portalName).trim() || "the portal";
  const fee = input.feeStop;
  const what = fee?.read && fee.totalUsd !== null
    ? `Payment needed: ${usd(fee.totalUsd)} on ${portal}.`
    : `Payment needed on ${portal} (the amount could not be read from the page${fee?.shotPath ? "; see the screenshot" : ""}).`;
  return `${what} Pay there, then press Paid on the track with the record number and the amount paid. Do not stage this track again: the application is waiting on the portal.`;
}

/** The sentence for a run row (its result_json and portal name). */
export function paymentNeededForRun(result: unknown, portalName?: string | null): string {
  let r: unknown = result;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch { r = null; } }
  let name = str(portalName).trim();
  if (!name && r && typeof r === "object") name = str((r as Row).portalName).trim();
  return paymentNeededSentence({ feeStop: feeStopOf(r), portalName: name });
}
