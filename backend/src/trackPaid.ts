// ---------------------------------------------------------------------------------------------
// "PAID" (#576 item 4): ONE action a person presses after paying a track's fee ON THE PORTAL.
//
//  - A track whose staging run stopped on a fee (awaiting_payment): the person paid and the portal
//    filed it. Paid records the filing (markTrackSubmitted, which closes the waiting run and its
//    submission) with the record number the portal showed.
//  - A track whose fee is due after approval, or because the agency emailed a fee request
//    (fee_due, feeDue.ts): Paid clears it. A later fee reading makes it due again.
//
// Either way the amount actually paid is kept (track_fee_payments, migration v62) and the track's
// billing-track sum becomes the actual fee (recordActualPermitFee), which fee accuracy (#494) and
// the fee history (#421) read. Nothing on a portal is touched: automation never pays (rule 1), and
// this is a person's record of their own payment.
// ---------------------------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { ProjectRecord, SubmittalTrackType } from "../../shared/src/types";
import { HttpError } from "./httpError";
import { parseMoney } from "./valuation";
import { nowIso } from "./time";
import { randomUUID } from "node:crypto";
import { AWAITING_PAYMENT, usd } from "./feePause";
import { billingTrack, recordActualPermitFee } from "./submissionFees";
import { markTrackFirstStage, markTrackSubmitted, requiredTracks, trackFeeDue, trackHasSecondStage, trackPermitTypes } from "./submittalTracks";
import { paidConfirmationUrl, trackConfirmationView } from "./submissionConfirmation";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v));
const round2 = (n: number): number => Math.round(n * 100) / 100;

export type TrackPaidKind = "filing" | "issuance";

export interface TrackPaidRecord {
  id: string;
  track: string;
  kind: TrackPaidKind;
  amountUsd: number;
  recordNumber: string;
  paidBy: string;
  paidAt: string;
  /** #665: the project-scoped route of the filing's masked confirmation screenshot (#569), when the
   *  track's newest submission kept one at the time of the Paid; '' otherwise. Never a file path. */
  confirmationUrl: string;
}

export interface TrackPaidResult {
  paid: TrackPaidRecord;
  /** The billing track's actual fee after this Paid (the sum of every Paid on it). */
  actualFeeUsd: number;
  /** A sentence for the toast and the audit row. */
  message: string;
}

/** The newest staging run of the family, when it waits on payment. */
function waitingRun(db: AppDb, projectId: string, family: string[]): Row | null {
  const run = db.get<Row>(
    `SELECT id, status FROM portal_runs
      WHERE project_id = ? AND permit_type IN (${family.map(() => "?").join(",")}) AND run_type = 'prepare_submit'
      ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    [projectId, ...family],
  );
  return run && s(run.status) === AWAITING_PAYMENT ? run : null;
}

/** Every Paid a person recorded on this project, newest first. A read. */
export function listTrackPaid(db: AppDb, projectId: string): TrackPaidRecord[] {
  return db.query<Row>(
    "SELECT * FROM track_fee_payments WHERE project_id = ? ORDER BY paid_at DESC, rowid DESC",
    [projectId],
  ).map((r) => ({
    id: s(r.id),
    track: s(r.track),
    kind: (s(r.kind) === "filing" ? "filing" : "issuance") as TrackPaidKind,
    amountUsd: Number(r.amount_usd),
    recordNumber: s(r.record_number),
    paidBy: s(r.paid_by),
    paidAt: s(r.paid_at),
    confirmationUrl: paidConfirmationUrl(projectId, r.confirmation_shot_path),
  }));
}

/** The confirmation the Paid points at: the track's NEWEST submission, when it links a masked
 *  confirmation screenshot (#569 / #645). Links what is already saved; captures nothing. */
function newestSubmissionConfirmationUrl(db: AppDb, projectId: string, family: string[]): string {
  const newest = db.get<Row>(
    `SELECT id FROM submissions WHERE project_id = ? AND permit_type IN (${family.map(() => "?").join(",")})
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [projectId, ...family],
  );
  const conf = trackConfirmationView(db, projectId, family);
  return newest && conf && conf.submissionId === s(newest.id) ? paidConfirmationUrl(projectId, conf.url) : "";
}

/**
 * A person paid this track's fee on the portal. Refuses (409) when nothing on the track waits on a
 * payment, and (400) without the record number or a positive amount — the two facts the action
 * exists to keep. Validated before anything is written.
 */
export function markTrackPaid(
  db: AppDb,
  project: ProjectRecord,
  type: SubmittalTrackType,
  input: { recordNumber?: unknown; amountPaidUsd?: unknown; paidBy?: unknown },
): TrackPaidResult {
  const required = requiredTracks(project);
  if (!required.includes(type)) throw new HttpError(400, `This project does not require a "${type}" submittal track.`);
  const recordNumber = s(input.recordNumber).trim().slice(0, 80);
  if (!recordNumber) throw new HttpError(400, "Enter the record or permit number the portal shows for this payment.");
  const amount = parseMoney(input.amountPaidUsd);
  if (amount == null || !(amount > 0)) throw new HttpError(400, "Enter the amount paid on the portal (a positive dollar amount).");
  const amountUsd = round2(amount);
  const paidBy = s(input.paidBy).trim().slice(0, 120);

  const family = trackPermitTypes(type);
  const run = waitingRun(db, project.id, family);
  const kind: TrackPaidKind | null = run ? "filing" : trackFeeDue(db, project.id, type, required) ? "issuance" : null;
  if (!kind) {
    throw new HttpError(409, `Nothing on the ${type} track is waiting on a payment: it has no fee stop and no fee due. Record a filing with "I submitted it" instead.`);
  }

  // The filing the payment completed: the portal filed it once paid (markTrackSubmitted closes the
  // waiting run and turns its awaiting_payment submission into the filing). First, in its own
  // transaction: it tells the client after committing, and the filing is the fact that matters.
  //
  // A TWO-STAGE FILING (#28): where a named person confirmed that this agency takes the plans in a
  // second system after the fee, paying does NOT file. The application is recorded as waiting on its
  // second stage (the run that waited is closed the same way), and the track is filed only when a
  // person marks the plan upload done.
  const twoStage = kind === "filing" && trackHasSecondStage(db, project, type);
  if (twoStage) {
    markTrackFirstStage(db, project, type, {
      recordNumber, by: paidBy, via: "paid",
      note: `Paid ${usd(amountUsd)} on the portal; the plans go into the second system by hand. Not filed until that upload is marked done.`,
    });
  } else if (kind === "filing") {
    markTrackSubmitted(db, project, type, {
      applicationNumber: recordNumber,
      submittedBy: paidBy || undefined,
      notes: `Paid ${usd(amountUsd)} on the portal; filed when paid.`,
    });
  }

  // The Paid row and the actual fee land together.
  const paidAt = nowIso();
  const confirmationUrl = newestSubmissionConfirmationUrl(db, project.id, family);
  const paid: TrackPaidRecord = { id: randomUUID(), track: type, kind, amountUsd, recordNumber, paidBy, paidAt, confirmationUrl };
  const bill = billingTrack(type);
  const tracksOfBill = required.filter((t) => billingTrack(t) === bill);
  let sum = 0;
  db.transaction(() => {
    db.run(
      `INSERT INTO track_fee_payments (id, project_id, track, kind, amount_usd, record_number, run_id, confirmation_shot_path, paid_by, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [paid.id, project.id, type, kind, amountUsd, recordNumber, run ? s(run.id) : "", confirmationUrl, paidBy, paidAt],
    );

    // THE ACTUAL FEE: every Paid on the billing track (a filing fee then an issuance fee, or two
    // permits of one track) summed — the whole bill, which fee accuracy grades the quote against.
    sum = round2(Number(db.get<Row>(
      `SELECT COALESCE(SUM(amount_usd), 0) AS total FROM track_fee_payments
        WHERE project_id = ? AND track IN (${tracksOfBill.map(() => "?").join(",")})`,
      [project.id, ...tracksOfBill],
    )?.total ?? 0));
    recordActualPermitFee(db, project, bill, sum, "operator");
  });

  const message = twoStage
    ? `Paid ${usd(amountUsd)}: the ${type} application is on record as ${recordNumber}. It is NOT filed yet: this agency takes the plans in a second system, so the track waits for the plan-upload invite and the hand upload.`
    : kind === "filing"
    ? `Paid ${usd(amountUsd)}: the ${type} track is filed as ${recordNumber} and tracked.`
    : `Paid ${usd(amountUsd)}: the ${type} fee is recorded against ${recordNumber}.`;
  return { paid, actualFeeUsd: sum, message };
}
