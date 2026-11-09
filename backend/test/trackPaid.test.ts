// "PAID" (#576 acceptance item 4). ONE action a person presses after paying a track's fee ON THE
// PORTAL — automation never pays (rule 1):
//
//   FILING     a track waiting on payment (a pay-to-file stop): Paid with the record number and the
//              amount records the filing (the run and its submission close, a tracking target is
//              born), the payment card goes, and the amount becomes the actual fee fee accuracy reads.
//   REFUSALS   no number / no amount is a 400; a track with nothing waiting on a payment is a 409,
//              and nothing is written.
//   FEE DUE    approved and ready for issue → fee_due; Paid with the permit number clears it, and the
//              actual fee is the sum of every Paid on the billing track. A newer fee reading makes it
//              due again.
//   EMAIL      an agency's emailed fee request reads as fee_due ("Fee requested"), not a generic
//              needs_human_review item; the same text without the bucket stays a review.
//
// KILL TESTS: drop the Paid row from feeDue.trackFeeDueFrom → FEE DUE fails (fee_due never clears);
// drop recordPermitStatusCheck's feeRequested branch → EMAIL fails; drop the markTrackSubmitted call
// in markTrackPaid → FILING fails (the run stays awaiting_payment).
//
// Run: npx tsx backend/test/trackPaid.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "track-paid-test-key-not-a-real-secret";
const fx = await setupStageFixture("track-paid");
const { db, repo } = fx;
const { computeNextStep } = await import("../src/nextStep");
const { getSubmittalTracks, markTrackSubmitted } = await import("../src/submittalTracks");
const { markTrackPaid } = await import("../src/trackPaid");
const { getSubmissionPayment } = await import("../src/submissionFees");

type Row = Record<string, unknown>;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 25)); };
const project = (pid: string) => repo.getProjectDetail(db, pid).project;
const combo = (pid: string) => getSubmittalTracks(db, project(pid)).find((t) => t.type === "combo")!;
const status = (e: unknown): number | undefined => (e as { status?: number } | null)?.status;
const attempt = (fn: () => unknown): unknown => { try { fn(); return null; } catch (e) { return e; } };

fx.completeRecipe();

// ── FILING: a pay-to-file stop, then Paid ───────────────────────────────────────────────────────
const pid = fx.newProject();
fx.stubRunner(async () => ({
  portalName: "Portland permits", ok: false, finalSubmitClicked: false, pauseReason: "fee_payment",
  feeStop: { read: true, totalUsd: 412.5, lines: [], unreadReason: "", where: "pay_to_file", shotPath: "", pageLink: "", pageRef: "" },
  steps: [{ ok: false, pauseReason: "fee_payment", message: "Submit & Pay is a payment control — automation never pays.", data: {} }],
}) as never);
await repo.prepareSubmission(db, pid, "combo").catch((e) => e);
await settle();

await check("premise: the track waits on payment", () => {
  assert.equal(fx.latestRun(pid)!.status, "awaiting_payment");
  assert.ok(combo(pid).payment);
});
await check("REFUSALS: Paid needs the record number and a positive amount; nothing is written", () => {
  for (const input of [{ amountPaidUsd: "412.50" }, { recordNumber: "BLD-26-1", amountPaidUsd: "" }, { recordNumber: "BLD-26-1", amountPaidUsd: "-5" }, { recordNumber: "BLD-26-1", amountPaidUsd: "abc" }]) {
    assert.equal(status(attempt(() => markTrackPaid(db, project(pid), "combo", input))), 400, JSON.stringify(input));
  }
  assert.equal(fx.latestRun(pid)!.status, "awaiting_payment");
  assert.equal(db.get<Row>("SELECT COUNT(*) AS n FROM track_fee_payments WHERE project_id = ?", [pid])!.n, 0);
});
await check("FILING: Paid records the filing, closes the wait, and keeps the amount as the actual fee", () => {
  const r = markTrackPaid(db, project(pid), "combo", { recordNumber: "BLD-26-04120", amountPaidUsd: "$412.50", paidBy: "Pat Payer" });
  assert.equal(r.paid.kind, "filing");
  assert.match(r.message, /^Paid \$412\.50: the combo track is filed as BLD-26-04120/);
  assert.equal(fx.latestRun(pid)!.status, "submitted");
  const sub = db.get<Row>("SELECT * FROM submissions WHERE project_id = ? AND permit_type = 'combo' ORDER BY created_at DESC LIMIT 1", [pid])!;
  assert.equal(sub.status, "submitted");
  assert.equal(sub.application_number, "BLD-26-04120");
  assert.ok(db.get<Row>("SELECT id FROM permit_check_targets WHERE project_id = ? AND application_number = 'BLD-26-04120' AND active = 1", [pid]), "a tracking target follows the filing");
  const t = combo(pid);
  assert.equal(t.payment, undefined, "the payment card goes");
  assert.deepEqual(t.paid?.map((p) => [p.kind, p.amountUsd, p.recordNumber, p.paidBy]), [["filing", 412.5, "BLD-26-04120", "Pat Payer"]]);
  assert.equal(getSubmissionPayment(db, pid, "permit")?.permitFeeActualUsd, 412.5, "the actual fee fee accuracy reads");
  assert.ok(db.get<Row>("SELECT id FROM permit_fee_history WHERE project_id = ? AND fee_usd = 412.5", [pid]), "the fee history learns the real fee");
  assert.notEqual(computeNextStep(db, pid).key, "payment_needed");
});
await check("REFUSALS: a track with nothing waiting on a payment is a 409, and nothing is written", () => {
  const before = db.get<Row>("SELECT COUNT(*) AS n FROM track_fee_payments WHERE project_id = ?", [pid])!.n;
  const err = attempt(() => markTrackPaid(db, project(pid), "combo", { recordNumber: "BLD-26-04120", amountPaidUsd: "10" }));
  assert.equal(status(err), 409, String(err));
  assert.match(String((err as Error).message), /Nothing on the combo track is waiting on a payment/);
  assert.equal(db.get<Row>("SELECT COUNT(*) AS n FROM track_fee_payments WHERE project_id = ?", [pid])!.n, before);
});

// ── FEE DUE: approved, ready for issue; Paid clears it ──────────────────────────────────────────
const pid2 = fx.newProject();
markTrackSubmitted(db, project(pid2), "combo", { applicationNumber: "BLD-26-07001", submittedBy: "fee test" });
const target2 = String(db.get<Row>("SELECT id FROM permit_check_targets WHERE project_id = ? AND application_number = 'BLD-26-07001'", [pid2])!.id);
await repo.recordPermitStatusCheck(db, pid2, { targetId: target2, source: "manual", rawStatusText: "Approved pending payment. Permit is ready to issue; issuance fees are due." });

await check("FEE DUE: ready for issue is fee_due on nextStep and on the card, which offers Paid", () => {
  const step = computeNextStep(db, pid2);
  assert.equal(step.key, "fee_due", `${step.key}: ${step.headline}`);
  assert.match(step.headline, /approved the .*press Paid/i, step.headline);
  const t = combo(pid2);
  assert.ok(t.feeDue, JSON.stringify(t).slice(0, 300));
  assert.equal(t.feeDue!.approved, true);
  assert.match(t.feeDue!.sentence, /press Paid/);
});
await check("FEE DUE: Paid with the permit number clears fee_due; the actual fee is the sum of the track's Paid", () => {
  const r = markTrackPaid(db, project(pid2), "combo", { recordNumber: "BLD-26-07001", amountPaidUsd: "275" });
  assert.equal(r.paid.kind, "issuance");
  assert.notEqual(computeNextStep(db, pid2).key, "fee_due");
  assert.equal(combo(pid2).feeDue, undefined);
  assert.equal(getSubmissionPayment(db, pid2, "permit")?.permitFeeActualUsd, 275);
});
await check("FEE DUE: a newer reading asking for a fee is due again, and a second Paid adds to the actual fee", async () => {
  await new Promise((r) => setTimeout(r, 5));
  await repo.recordPermitStatusCheck(db, pid2, {
    targetId: target2, source: "email", feeRequested: true,
    rawStatusText: "Email bucket: fee_request\nPlease remit the outstanding re-inspection fee for this record.",
  });
  assert.equal(computeNextStep(db, pid2).key, "fee_due");
  markTrackPaid(db, project(pid2), "combo", { recordNumber: "BLD-26-07001", amountPaidUsd: "50.25" });
  assert.notEqual(computeNextStep(db, pid2).key, "fee_due");
  assert.equal(getSubmissionPayment(db, pid2, "permit")?.permitFeeActualUsd, 325.25);
});

// ── EMAIL: a fee request is fee_due, not a generic review ───────────────────────────────────────
const FEE_EMAIL = "Email bucket: fee_request\nPlease remit the outstanding plan review fee for this record.";
const pid3 = fx.newProject();
markTrackSubmitted(db, project(pid3), "combo", { applicationNumber: "BLD-26-08002", submittedBy: "fee test" });
const target3 = String(db.get<Row>("SELECT id FROM permit_check_targets WHERE project_id = ? AND application_number = 'BLD-26-08002'", [pid3])!.id);
const reviewItems = (p: string) => db.get<Row>("SELECT COUNT(*) AS n FROM human_review_items WHERE project_id = ? AND field_name = 'permit_status'", [p])!.n;
await repo.recordPermitStatusCheck(db, pid3, { targetId: target3, source: "email", feeRequested: true, rawStatusText: FEE_EMAIL });

await check("EMAIL: the fee request reads 'Fee requested' with the fee due — no generic review item", () => {
  const c = db.get<Row>("SELECT * FROM permit_status_checks WHERE target_id = ? ORDER BY rowid DESC LIMIT 1", [target3])!;
  assert.equal(c.status_label, "Fee requested");
  assert.equal(c.issue_fee_due, 1);
  assert.equal(reviewItems(pid3), 0);
  const step = computeNextStep(db, pid3);
  assert.equal(step.key, "fee_due", `${step.key}: ${step.headline}`);
  assert.match(step.headline, /^Fee due: .*asked for the .*fee .*press Paid/i, step.headline);
  assert.doesNotMatch(step.headline, /approved/i, "a fee request is not an approval");
  assert.equal(combo(pid3).feeDue?.approved, false);
});
await check("EMAIL kill: the same words without the fee-request bucket stay a review, never a fee due", async () => {
  const pid4 = fx.newProject();
  markTrackSubmitted(db, project(pid4), "combo", { applicationNumber: "BLD-26-09003", submittedBy: "fee test" });
  const t4 = String(db.get<Row>("SELECT id FROM permit_check_targets WHERE project_id = ? AND application_number = 'BLD-26-09003'", [pid4])!.id);
  await repo.recordPermitStatusCheck(db, pid4, { targetId: t4, source: "email", rawStatusText: FEE_EMAIL });
  assert.notEqual(computeNextStep(db, pid4).key, "fee_due");
  assert.equal(combo(pid4).feeDue, undefined);
});

finish("track paid");
