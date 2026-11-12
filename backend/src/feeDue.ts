// ---------------------------------------------------------------------------------------------
// FEE DUE, AND WHAT CLEARS IT (#576 item 4). ONE answer for nextStep (rule 12, batch) and the track
// card (getSubmittalTracks), so the banner and the card cannot disagree.
//
// A track's fee is due when one of its own tracking targets (its tag, or the kind's unclaimed pool:
// nextStep's ownsTarget rule) reads
//   - ready_for_issue (the agency approved; the issuance fee is paid before the permit issues), or
//   - a fee asked for: the target's newest reading carries issue_fee_due (an agency's emailed fee
//     request is recorded that way, recordPermitStatusCheck's feeRequested),
// and no person has pressed Paid for that track SINCE that reading (track_fee_payments, migration
// v62). A reading newer than the Paid (a second fee asked for) is due again.
//
// Reads only; writes nothing. Automation never pays (rule 1): Paid is a person's record.
// ---------------------------------------------------------------------------------------------

import type { AppDb } from "./db";
import { trackKind } from "./permitMonitor";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v));

/** A target whose newest reading asks for a fee. */
export interface FeeDueReading {
  targetType: string;
  permitType: string;
  /** When the reading that asks for the fee was recorded ('' when no check row is on file). */
  readAt: string;
  label: string;
  /** The agency approved (ready_for_issue); false = a fee was asked for without an approval. */
  approved: boolean;
}

/** A person's Paid on a track. */
export interface FeePaidMark {
  track: string;
  paidAt: string;
}

function placeholders(ids: readonly string[]): string {
  return ids.map(() => "?").join(", ");
}

/** Per project: the active targets whose newest reading asks for a fee. */
export function feeDueReadings(db: AppDb, projectIds: readonly string[]): Map<string, FeeDueReading[]> {
  const out = new Map<string, FeeDueReading[]>();
  if (!projectIds.length) return out;
  const rows = db.query<Row>(
    `SELECT project_id, target_type, permit_type, latest_outcome, latest_status_label, read_at, fee_asked FROM (
       SELECT t.project_id, t.target_type, t.permit_type, t.latest_outcome, t.latest_status_label,
              (SELECT c.created_at FROM permit_status_checks c WHERE c.target_id = t.id ORDER BY c.rowid DESC LIMIT 1) AS read_at,
              (SELECT c.issue_fee_due FROM permit_status_checks c WHERE c.target_id = t.id ORDER BY c.rowid DESC LIMIT 1) AS fee_asked
         FROM permit_check_targets t
        WHERE t.project_id IN (${placeholders(projectIds)}) AND t.active = 1
     ) WHERE latest_outcome = 'ready_for_issue' OR COALESCE(fee_asked, 0) = 1`,
    [...projectIds],
  );
  for (const r of rows) {
    const pid = s(r.project_id);
    const list = out.get(pid) ?? [];
    list.push({ targetType: s(r.target_type), permitType: s(r.permit_type), readAt: s(r.read_at), label: s(r.latest_status_label), approved: s(r.latest_outcome) === "ready_for_issue" });
    out.set(pid, list);
  }
  return out;
}

/** Per project: every Paid a person recorded. */
export function feePaidMarks(db: AppDb, projectIds: readonly string[]): Map<string, FeePaidMark[]> {
  const out = new Map<string, FeePaidMark[]>();
  if (!projectIds.length) return out;
  for (const r of db.query<Row>(
    `SELECT project_id, track, paid_at FROM track_fee_payments WHERE project_id IN (${placeholders(projectIds)})`,
    [...projectIds],
  )) {
    const pid = s(r.project_id);
    const list = out.get(pid) ?? [];
    list.push({ track: s(r.track), paidAt: s(r.paid_at) });
    out.set(pid, list);
  }
  return out;
}

/**
 * Is a fee due on this track? `family` is the track's permit types (trackPermitTypes), `kind` its
 * target kind, `claimed` every permit type the project's required tracks tag. Returns the reading
 * that asks for it (the newest unpaid one), or null.
 */
export function trackFeeDueFrom(
  readings: readonly FeeDueReading[],
  paid: readonly FeePaidMark[],
  track: string,
  family: readonly string[],
  kind: "permit" | "nem",
  claimed: ReadonlySet<string>,
): FeeDueReading | null {
  const owns = (r: FeeDueReading): boolean => family.includes(r.permitType)
    || (trackKind(r.targetType, r.permitType) === kind && !claimed.has(r.permitType));
  const paidSince = (r: FeeDueReading): boolean => paid.some((p) => p.track === track && p.paidAt >= r.readAt);
  const due = readings.filter((r) => owns(r) && !paidSince(r)).sort((a, b) => b.readAt.localeCompare(a.readAt));
  return due[0] ?? null;
}
