// A PAID ROW LINKS ITS FILING'S CONFIRMATION SCREENSHOT (#665). When a person presses Paid on a track
// whose newest submission kept a masked confirmation screenshot (#569 / #645), the Paid row names that
// document's project-scoped route, and the track card carries it. Nothing new is captured. Without
// one the row stays '' as before. What the card may link is only this project's own confirmation
// route: a file path or another project's route stored in the column reads as nothing (rule 2).
//
// KILL TESTS: write '' again in markTrackPaid → (a) fails; drop the project check in
// paidConfirmationUrl → (c) fails.
//
// Run: npx tsx backend/test/trackPaidConfirmation.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("track-paid-confirmation");
const { db, repo } = fx;
const { getSubmittalTracks, markTrackSubmitted } = await import("../src/submittalTracks");
const { markTrackPaid } = await import("../src/trackPaid");
const { paidConfirmationUrl } = await import("../src/submissionConfirmation");
const docs = await import("../src/projectDocuments");

type Row = Record<string, unknown>;
const project = (pid: string) => repo.getProjectDetail(db, pid).project;
const combo = (pid: string) => getSubmittalTracks(db, project(pid)).find((t) => t.type === "combo")!;

/** A filed combo track, approved and ready for issue (so a fee is due and Paid is accepted). */
async function filedAndFeeDue(withConfirmation: boolean): Promise<{ pid: string; submissionId: string }> {
  const pid = fx.newProject();
  markTrackSubmitted(db, project(pid), "combo", { applicationNumber: "BLD-26-09001", submittedBy: "test" });
  const submissionId = String(db.get<Row>("SELECT id FROM submissions WHERE project_id = ? AND permit_type = 'combo' ORDER BY created_at DESC LIMIT 1", [pid])!.id);
  if (withConfirmation) {
    const doc = docs.saveProjectDocument(db, pid, {
      docType: docs.SUBMISSION_CONFIRMATION_DOC_TYPE, filename: "combo-confirmation.png", contentType: "image/png",
      buffer: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), source: "portal_run",
    });
    db.run("UPDATE submissions SET confirmation_document_id = ? WHERE id = ?", [doc.id, submissionId]);
  }
  const target = String(db.get<Row>("SELECT id FROM permit_check_targets WHERE project_id = ? AND application_number = 'BLD-26-09001'", [pid])!.id);
  await repo.recordPermitStatusCheck(db, pid, { targetId: target, source: "manual", rawStatusText: "Approved pending payment. Permit is ready to issue; issuance fees are due." });
  return { pid, submissionId };
}

await check("(a) Paid on a track whose filing kept a confirmation screenshot names its route, and the card carries it", async () => {
  const { pid, submissionId } = await filedAndFeeDue(true);
  const r = markTrackPaid(db, project(pid), "combo", { recordNumber: "BLD-26-09001", amountPaidUsd: "275" });
  const route = `/api/projects/${pid}/submissions/${submissionId}/confirmation-screenshot`;
  assert.equal(r.paid.confirmationUrl, route);
  assert.equal(db.get<Row>("SELECT confirmation_shot_path FROM track_fee_payments WHERE id = ?", [r.paid.id])!.confirmation_shot_path, route);
  assert.equal(combo(pid).paid?.[0]?.confirmationUrl, route, "the card does not link the confirmation");
});

await check("(b) Paid on a track with no confirmation screenshot stays '' as before", async () => {
  const { pid } = await filedAndFeeDue(false);
  const r = markTrackPaid(db, project(pid), "combo", { recordNumber: "BLD-26-09001", amountPaidUsd: "275" });
  assert.equal(r.paid.confirmationUrl, "");
  assert.equal(db.get<Row>("SELECT confirmation_shot_path FROM track_fee_payments WHERE id = ?", [r.paid.id])!.confirmation_shot_path, "");
  assert.equal(combo(pid).paid?.[0]?.confirmationUrl, undefined);
});

await check("(c) only this project's own confirmation route is ever linked — never a path, never another project's", () => {
  assert.equal(paidConfirmationUrl("p1", "/api/projects/p1/submissions/s1/confirmation-screenshot"), "/api/projects/p1/submissions/s1/confirmation-screenshot");
  assert.equal(paidConfirmationUrl("p1", "/api/projects/p2/submissions/s1/confirmation-screenshot"), "", "another project's confirmation was linked (rule 6)");
  assert.equal(paidConfirmationUrl("p1", "/srv/data/runs/abc/outcome.png"), "", "a file path (an unmasked outcome shot) was linked (rule 2)");
  assert.equal(paidConfirmationUrl("p1", "https://evil.example/api/projects/p1/submissions/s1/confirmation-screenshot"), "");
  assert.equal(paidConfirmationUrl("p1", ""), "");
});

finish("trackPaidConfirmation");
