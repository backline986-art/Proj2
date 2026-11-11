// TWO-STAGE PERMIT FILINGS, PART 1 (#28): THE SECOND STAGE IS A TRACKED HUMAN STEP.
//
// Some agencies take the application and its fee in one portal and the PLANS in a second system,
// opened by an invite email. Automation never reaches that second system here: no recipe, no door,
// nothing opened. What this pins, on INVENTED agencies (a synthetic reference file; nothing depends
// on a real row), through the real doors with only the browser stubbed:
//
//   DESCRIBED   a cited description (reference citation `secondStage`, or the lookup's answer) is
//               shown for a person to Confirm and changes NOTHING: Paid at the fee stop files as ever.
//               A citation whose quote never names the system is not a description.
//   CONFIRM     only a NAMED person's Confirm makes the track ask for the second stage. No name, an
//               address as the "system", or the utility's track: refused. A track that filed before
//               the Confirm stays filed.
//   FEE STOP → PAID   on a confirmed agency Paid records "application made, NOT filed":
//               submission `awaiting_second_stage`, the run closed, NO tracking target, NO client
//               "filed" notice, the track "staged" reading "waiting for the plan-upload invite",
//               next step `second_stage_invite`, the client timeline says not filed in plain words,
//               and the documents to upload come from the job's required-documents list.
//   DOORS       nothing else calls it filed: "I submitted it" 409s, Stage is refused, a confirmation
//               captured on a run records the APPLICATION, and an approved run's gate refuses the
//               final submit (it stops at review).
//   INVITE      the email the tracker places on the job (by the application number) is shown on the
//               track; next step `second_stage_upload`. Its link on a host that is not this agency's
//               person-verified permit portal is HIDDEN (host and reason only); a link on that portal
//               is shown. A utility portal and an information page never fit. An email older than
//               the application is not its invite. Nothing opens any of it.
//   MARK        a named person marks the upload done with the confirmation number or a screenshot
//               (PNG/JPEG by its bytes): audited, and only then is the track filed (submission
//               `submitted`, tracking target, client notice).
//   PIN         a single-stage agency is unchanged: Paid files, an approved run is allowed.
//
// KILL TESTS (each run against the mutated source, then restored):
//   K1 trackPaid: drop the `twoStage` branch (always markTrackSubmitted) → FEE STOP → PAID fails.
//   K2 submittalTracks.markTrackSubmitted: drop the secondStageHold refusal → DOORS ("I submitted it") fails.
//   K3 secondStage.noteSecondStageInvite: show the first link without inviteLinkFit → INVITE (hidden) fails.
//   K4 secondStage.beginSecondStageUpload: drop the confirmation-or-screenshot check → MARK fails.
//   K5 secondStage.trackSecondStage: treat a cited description as a person's Confirm → DESCRIBED fails.
//   K6 repository.prepareSubmission: drop the secondStageHold refusal at the gate → DOORS (approved run) fails.
//   K7 repository.captureConfirmation: drop the two-stage branch → DOORS (capture) fails.
//
// Run: npx tsx backend/test/secondStageFiling.test.ts
import { ISOLATED_CWD } from "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupStageFixture, check, finish } from "./_stageFixture";
import type { SubmittalTrackType } from "../../shared/src/types";

const flags = {
  timeline: "", requiresElectricianSign: false, requiresElectricalStamp: false, requiresStructuralStamp: false,
  requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false, requiresSolarChecklist: false,
  requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false, requiresFloodplainCheck: false,
  requiresJurisdictionCheck: false, otherRequirements: "", sourceSheet: "synthetic test rows",
};
const ST = "OR"; // the stage fixture's job is an OR prescriptive job; the agencies below are invented
const TWO = "City of Twostep", ONE = "City of Onestep", MUMBLE = "City of Mumbleton";
const TWO_DOOR = "https://permits.twostep.example.gov/apply";
const ONE_DOOR = "https://permits.onestep.example.gov/apply";
const SYSTEM = "PlanDesk Review";
const QUOTE = "After the fee is paid you will receive an email invitation to upload your plans in PlanDesk Review.";
const PAGE = "https://www.twostep.example.gov/solar";
const profiles = [
  { ...flags, state: ST, ahj: TWO, submissionMethod: TWO_DOOR, reviewerNotes: "",
    citations: [{ field: "secondStage", value: SYSTEM, trigger: "an invite email after the fee is paid", sourceUrl: PAGE, quote: QUOTE, fetchedAt: "2026-11-11T08:00:00Z" }] },
  { ...flags, state: ST, ahj: ONE, submissionMethod: ONE_DOOR, reviewerNotes: "" },
  // A citation whose quote never names the system it claims: not a description.
  { ...flags, state: ST, ahj: MUMBLE, submissionMethod: "https://permits.mumbleton.example.gov/apply", reviewerNotes: "",
    citations: [{ field: "secondStage", value: "PlanVault", trigger: "", sourceUrl: "https://www.mumbleton.example.gov/solar", quote: "Plans are reviewed electronically after payment.", fetchedAt: "2026-11-11T08:00:00Z" }] },
];
const refPath = path.join(ISOLATED_CWD, "synthetic-ahj-processes.json");
fs.writeFileSync(refPath, JSON.stringify({ generatedFrom: "test", redaction: "", count: profiles.length, profiles }));
process.env.AHJ_PROCESS_REFERENCE_PATH = refPath;
process.env.PERMIT_PROCESS_LOOKUP = "off";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "second-stage-test-key-not-a-real-secret";

const fx = await setupStageFixture("second-stage");
const { db, repo } = fx;
const docs = await import("../src/projectDocuments");
const { computeNextStep } = await import("../src/nextStep");
const { getSubmittalTracks, markTrackSubmitted, markSecondStageUploaded, markTrackFirstStage, secondStageHold, trackHasSecondStage } = await import("../src/submittalTracks");
const { markTrackPaid } = await import("../src/trackPaid");
const ss = await import("../src/secondStage");
const { acceptSecondStage } = await import("../src/permitProcessLookup");
const { buildClientTimeline } = await import("../src/clientTimeline");
const { FILING_ANNOUNCED_ACTION } = await import("../src/clientFilingUpdate");

type Row = Record<string, unknown>;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 25)); };
const project = (pid: string) => repo.getProjectDetail(db, pid).project;
const track = (pid: string, type: SubmittalTrackType) => getSubmittalTracks(db, project(pid)).find((t) => t.type === type)!;
const status = (e: unknown): number | undefined => (e as { status?: number } | null)?.status;
const attempt = (fn: () => unknown): unknown => { try { fn(); return null; } catch (e) { return e; } };
const sub = (pid: string, type: string) => db.get<Row>("SELECT * FROM submissions WHERE project_id = ? AND permit_type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [pid, type])!;
const targets = (pid: string) => Number(db.get<Row>("SELECT COUNT(*) AS n FROM permit_check_targets WHERE project_id = ?", [pid])!.n);
const audits = (pid: string, action: string) => db.query<Row>("SELECT details, actor_name FROM audit_logs WHERE project_id = ? AND action = ?", [pid, action]);
const permitFiled = (pid: string) => buildClientTimeline(db, project(pid)).steps.find((s) => s.key === "permit_filed")!;

for (const [ahj, door] of [[TWO, TWO_DOOR], [ONE, ONE_DOOR]] as const) {
  const r = fx.recipes.startPortalRecording(db, { scopeType: "ahj", state: ST, ahj, utility: "PGE", portalUrl: door, portalPlatform: "accela", createdBy: "test" });
  fx.recipes.savePortalRecipeSteps(db, r.id, [...fx.fills(4), fx.REVIEW, fx.FINAL], { status: "complete", notes: "Auto-learned and verified (high confidence)." });
}
/** A job at an invented agency that clears every staging gate (the fixture's own job, plus the
 *  application forms an unknown agency has no template for). */
const newJob = (ahj: string): string => {
  const pid = fx.newProject({ ahj, city: ahj.replace(/^City of /, "") });
  for (const docType of ["building_application", "electrical_application", "solar_checklist"]) {
    docs.saveProjectDocument(db, pid, { docType, filename: `${docType}.pdf`, contentType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${docType}\n`, "utf8"), source: "upload" });
  }
  return pid;
};
const FEE_STOP = async () => ({
  portalName: "stub permits", ok: false, finalSubmitClicked: false, pauseReason: "fee_payment",
  feeStop: { read: true, totalUsd: 412.5, lines: [], unreadReason: "", where: "pay_to_file", shotPath: "", pageLink: "", pageRef: "" },
  steps: [{ ok: false, pauseReason: "fee_payment", message: "Submit & Pay is a payment control — automation never pays.", data: {} }],
}) as never;
const REVIEW_STOP = async () => ({ portalName: "stub permits", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] }) as never;
const stage = async (pid: string, type: SubmittalTrackType, runner: typeof FEE_STOP = FEE_STOP) => {
  fx.stubRunner(runner);
  const err: unknown = await repo.prepareSubmission(db, pid, type).then(() => null, (e) => e);
  await settle();
  return err;
};

// ── DESCRIBED: shown, and it changes nothing ────────────────────────────────────────────────────
const j1 = newJob(TWO);
await check("DESCRIBED: the cited description is on the card for a person to confirm; the track asks for nothing", () => {
  const t = track(j1, "building");
  assert.equal(t.status, "not_started");
  assert.equal(t.secondStage?.basis, "described");
  assert.equal(t.secondStage?.state, "described");
  assert.equal(t.secondStage?.pending, false);
  assert.equal(t.secondStage?.system, SYSTEM);
  assert.equal(t.secondStage?.sourceUrl, PAGE);
  assert.equal(t.secondStage?.quote, QUOTE);
  assert.match(t.secondStage!.sentence, /Not confirmed by a person/);
  assert.equal(trackHasSecondStage(db, project(j1), "building"), false);
  assert.equal(secondStageHold(db, project(j1), "building"), null);
  assert.equal(track(j1, "nem").secondStage, undefined, "the utility's track never has a second stage");
});
await check("DESCRIBED: a citation whose quote never names the system is not a description", () => {
  const jm = newJob(MUMBLE);
  assert.equal(track(jm, "building").secondStage, undefined);
  assert.equal(ss.quoteNamesSystem("PlanDesk Review", QUOTE), true);
  assert.equal(ss.quoteNamesSystem("PlanVault", "Plans are reviewed electronically after payment."), false);
});
await check("DESCRIBED: the lookup keeps a second stage only with a fetched page's quote that names the system, never an address", () => {
  const seen = [PAGE];
  const ok = acceptSecondStage({ value: { system: SYSTEM, trigger: "invite email after the fee is paid" }, sourceUrl: PAGE, quote: QUOTE } as never, seen);
  assert.deepEqual(ok.value, { system: SYSTEM, trigger: "invite email after the fee is paid" });
  assert.equal(acceptSecondStage({ value: { system: "PlanVault", trigger: "" }, sourceUrl: PAGE, quote: QUOTE } as never, seen).value, null, "a quote that does not name the system");
  assert.equal(acceptSecondStage({ value: { system: "https://plandesk.example.com/login", trigger: "" }, sourceUrl: PAGE, quote: QUOTE } as never, seen).value, null, "an address is not a system name");
  assert.equal(acceptSecondStage({ value: { system: SYSTEM, trigger: "" }, sourceUrl: "https://elsewhere.example.com/x", quote: QUOTE } as never, seen).value, null, "a page that was never fetched");
});
await check("DESCRIBED: Paid at the fee stop of a described-only agency FILES, exactly as before", async () => {
  assert.equal(await stage(j1, "building"), null);
  assert.equal(fx.latestRun(j1)!.status, "awaiting_payment");
  const r = markTrackPaid(db, project(j1), "building", { recordNumber: "BLD-26-00001", amountPaidUsd: "412.50", paidBy: "Pat Payer" });
  assert.match(r.message, /the building track is filed as BLD-26-00001/);
  assert.equal(sub(j1, "building").status, "submitted");
  assert.equal(targets(j1), 1);
  assert.equal(track(j1, "building").status, "submitted");
});

// ── PIN: a single-stage agency is unchanged ─────────────────────────────────────────────────────
const j0 = newJob(ONE);
await check("PIN: a single-stage agency: no second-stage block, Paid files, the client hears filed", async () => {
  assert.equal(track(j0, "building").secondStage, undefined);
  assert.equal(await stage(j0, "building"), null);
  const r = markTrackPaid(db, project(j0), "building", { recordNumber: "ONE-26-00001", amountPaidUsd: "300", paidBy: "Pat Payer" });
  assert.match(r.message, /the building track is filed as ONE-26-00001/);
  assert.equal(sub(j0, "building").status, "submitted");
  assert.ok(db.get<Row>("SELECT id FROM permit_check_targets WHERE project_id = ? AND application_number = 'ONE-26-00001' AND active = 1", [j0]));
  assert.equal(audits(j0, FILING_ANNOUNCED_ACTION).length, 1);
  assert.equal(computeNextStep(db, j0).key.startsWith("second_stage"), false);
});

// ── CONFIRM: only a named person ────────────────────────────────────────────────────────────────
await check("CONFIRM: no name, an address as the system, and the utility's track are refused; nothing is written", () => {
  assert.equal(status(attempt(() => ss.confirmSecondStage(db, project(j1), "electrical", {}, ""))), 400);
  assert.equal(status(attempt(() => ss.confirmSecondStage(db, project(j1), "electrical", { system: "https://plandesk.example.com" }, "Vera Verifier"))), 400);
  assert.equal(status(attempt(() => ss.confirmSecondStage(db, project(j1), "nem", { system: SYSTEM }, "Vera Verifier"))), 400);
  assert.equal(Number(db.get<Row>("SELECT COUNT(*) AS n FROM permit_second_stages")!.n), 0);
});
await check("CONFIRM: a named person's Confirm is recorded and audited; the unfiled track now owes its application, the filed one stays filed", () => {
  const v = ss.confirmSecondStage(db, project(j1), "electrical", {}, "Vera Verifier");
  assert.equal(v.system, SYSTEM);
  assert.equal(v.verifiedBy, "Vera Verifier");
  assert.equal(v.quote, QUOTE);
  const a = audits(j1, "second_stage.confirmed");
  assert.equal(a.length, 1);
  assert.equal(a[0].actor_name, "Vera Verifier");
  const e = track(j1, "electrical");
  assert.equal(e.secondStage?.basis, "verified");
  assert.equal(e.secondStage?.state, "before_application");
  assert.equal(e.secondStage?.pending, false);
  assert.equal(secondStageHold(db, project(j1), "electrical")?.owed, "application");
  // filed before anyone confirmed the stage: still filed, and its numbers can still be updated
  assert.equal(track(j1, "building").status, "submitted");
  assert.equal(secondStageHold(db, project(j1), "building"), null);
  assert.equal(attempt(() => markTrackSubmitted(db, project(j1), "building", { applicationNumber: "BLD-26-00001", submittedBy: "numbers update" })), null);
  assert.equal(secondStageHold(db, project(j0), "electrical"), null, "another agency is untouched");
});

// ── FEE STOP → PAID on the confirmed agency ─────────────────────────────────────────────────────
const j2 = newJob(TWO);
await check("DOORS: \"I submitted it\" on a confirmed two-stage agency is refused before any application is on record", () => {
  const err = attempt(() => markTrackSubmitted(db, project(j2), "building", { applicationNumber: "BLD-26-04120", submittedBy: "Pat" }));
  assert.equal(status(err), 409, String(err));
  assert.match(String((err as Error).message), /second system \(PlanDesk Review\)/);
  assert.ok(!db.get<Row>("SELECT id FROM submissions WHERE project_id = ? AND status = 'submitted'", [j2]));
});
await check("FEE STOP → PAID: the application is on record and the track is NOT filed", async () => {
  assert.equal(await stage(j2, "building"), null);
  assert.equal(fx.latestRun(j2)!.status, "awaiting_payment");
  const r = markTrackPaid(db, project(j2), "building", { recordNumber: "BLD-26-04120", amountPaidUsd: "$412.50", paidBy: "Pat Payer" });
  assert.equal(r.paid.kind, "filing");
  assert.match(r.message, /application is on record as BLD-26-04120\. It is NOT filed yet/);
  const row = sub(j2, "building");
  assert.equal(row.status, "awaiting_second_stage");
  assert.equal(row.application_number, "BLD-26-04120");
  assert.equal(row.submitted_at, null, "no filing date: nothing is filed");
  assert.equal(fx.latestRun(j2)!.status, "submitted", "the run that waited on the fee is closed");
  assert.equal(targets(j2), 0, "no tracking target while the plans are out");
  assert.equal(audits(j2, FILING_ANNOUNCED_ACTION).length, 0, "the client is not told it is filed");
  assert.equal(audits(j2, "second_stage.first_stage_recorded").length, 1);
  const t = track(j2, "building");
  assert.equal(t.status, "staged");
  assert.equal(t.statusLabel, "Application made — waiting for the plan-upload invite");
  assert.match(t.nextAction, /NOT filed yet/);
  assert.equal(t.payment, undefined, "the payment card goes");
  assert.equal(t.secondStage?.state, "waiting_invite");
  assert.equal(t.secondStage?.pending, true);
  assert.equal(t.secondStage?.application?.number, "BLD-26-04120");
  assert.equal(t.secondStage?.invite, undefined);
  assert.notEqual(project(j2).status, "submitted");
});
await check("FEE STOP → PAID: the next step, the client's page and the documents to upload all say what is owed", () => {
  const step = computeNextStep(db, j2);
  assert.equal(step.key, "second_stage_invite", `${step.key}: ${step.headline}`);
  const filed = permitFiled(j2);
  assert.notEqual(filed.state, "done");
  assert.match(filed.detail, /^Application made and fee paid\. Waiting on the invitation from City of Twostep to upload the plans\. Not filed until the plans are in\.$/);
  const list = track(j2, "building").secondStage!.documents!;
  assert.ok(list.length > 0, "the documents to upload are listed");
  const plans = list.find((d) => d.docType === "plan_set");
  assert.ok(plans?.present, JSON.stringify(list));
});
await check("DOORS: while the upload is owed, \"I submitted it\", Stage and a second Paid are refused; nothing files", async () => {
  const err = attempt(() => markTrackSubmitted(db, project(j2), "building", { applicationNumber: "BLD-26-04120", submittedBy: "Pat" }));
  assert.equal(status(err), 409, String(err));
  assert.match(String((err as Error).message), /plans are not marked as uploaded in PlanDesk Review/);
  const staged = await stage(j2, "building", REVIEW_STOP);
  assert.ok(staged instanceof Error, "Stage must be refused while the application waits on its upload");
  assert.equal(status(attempt(() => markTrackPaid(db, project(j2), "building", { recordNumber: "BLD-26-04120", amountPaidUsd: "10" }))), 409);
  assert.equal(sub(j2, "building").status, "awaiting_second_stage");
  assert.equal(targets(j2), 0);
});

// ── DOORS: the confirmation capture and the approved run ────────────────────────────────────────
await check("DOORS: a confirmation captured on a run records the APPLICATION on a two-stage agency, never the filing", async () => {
  assert.equal(await stage(j2, "electrical", REVIEW_STOP), null);
  const run = fx.latestRun(j2)!;
  assert.equal(run.status, "awaiting_human_submit");
  assert.equal(status(attempt(() => repo.captureConfirmation(db, String(run.id), { confirmationNumber: "RCPT-1", submittedBy: "Pat" }))), 400, "a receipt number alone is not the record");
  assert.equal(sub(j2, "electrical").status, "awaiting_human_submit");
  repo.captureConfirmation(db, String(run.id), { applicationNumber: "ELE-26-00077", submittedBy: "Pat Payer" });
  assert.equal(sub(j2, "electrical").status, "awaiting_second_stage");
  assert.equal(fx.latestRun(j2)!.status, "submitted");
  assert.equal(targets(j2), 0);
  assert.equal(audits(j2, FILING_ANNOUNCED_ACTION).length, 0);
  assert.equal(track(j2, "electrical").secondStage?.state, "waiting_invite");
  assert.notEqual(project(j2).status, "submitted");
  assert.equal(status(attempt(() => repo.captureConfirmation(db, String(run.id), { applicationNumber: "ELE-26-00077", submittedBy: "Pat" }))), 409, "a second capture while the upload is owed");
});
fx.verifyDoor({ ahj: TWO, portalUrl: TWO_DOOR });
fx.verifyDoor({ ahj: ONE, portalUrl: ONE_DOOR });
await check("DOORS: an approved run may file a single-stage agency, and is refused the final submit on a two-stage one", async () => {
  const asking = async (pid: string, type: SubmittalTrackType) => {
    const approval = repo.createRunApproval(db, { projectId: pid, track: type, approver: "A. Person", approverUserId: null, acknowledgements: fx.acknowledgeAll(pid, type) });
    let allowed: boolean | undefined;
    fx.stubRunner(async (_r, _p, _f, _d, _files, options) => {
      allowed = options?.autoSubmit;
      return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] } as never;
    });
    process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
    try { await repo.prepareSubmission(db, pid, type, true, undefined, approval.id); } finally { delete process.env.PORTAL_ALLOW_FINAL_SUBMIT; }
    await settle();
    return allowed;
  };
  assert.equal(await asking(j0, "electrical"), true, "premise: every other gate is clear, so a single-stage agency's approved run is allowed");
  const j3 = newJob(TWO);
  assert.equal(await asking(j3, "building"), false, "an approved run was allowed to click the first portal's submit on a two-stage agency");
  const declined = fx.audits("portal.auto_submit_declined").filter((a) => a.project_id === j3);
  assert.match(JSON.parse(declined[0].details).reasons.join(" | "), /second system \(PlanDesk Review\) by hand/);
  assert.equal(fx.latestRun(j3)!.status, "awaiting_human_submit", "the run stops at review");
});

// ── INVITE ──────────────────────────────────────────────────────────────────────────────────────
const mbox = (name: string, subject: string, body: string[]): string => {
  const file = path.join(ISOLATED_CWD, `${name}.mbox`);
  const date = new Date().toUTCString();
  fs.writeFileSync(file, [
    `From permits@twostep.example.gov ${date}`,
    "From: Twostep Permit Desk <permits@twostep.example.gov>",
    "To: filings@installer.test",
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${name}@twostep.example.gov>`,
    "",
    ...body,
    "",
  ].join("\n"));
  return file;
};
await check("INVITE: an email older than the application is not its invite", () => {
  const noted = ss.noteSecondStageInvite(db, project(j2), {
    subject: "Invitation to upload plans", from: "permits@twostep.example.gov", text: "You are invited to upload your plans in PlanDesk Review.",
    occurredAt: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(), signature: "old-email",
  }, "building");
  assert.deepEqual(noted, []);
  assert.equal(track(j2, "building").secondStage?.invite, undefined);
});
await check("INVITE: the tracker places the invite on the job and the track shows it; a link on a foreign host is hidden", async () => {
  const p = project(j2);
  const file = mbox("invite-building", "Invitation to upload plans for record BLD-26-04120", [
    `Record BLD-26-04120 at ${p.projectAddress}.`,
    "You are invited to upload your plans in PlanDesk Review: https://plandesk.example.com/invite/abc123",
  ]);
  const result = await repo.runEmailTracker(db, { filePath: file, orgId: String(p.orgId || "org-default") });
  assert.equal(result.sourceErrors.length, 0, result.sourceErrors.join("; "));
  const t = track(j2, "building");
  assert.equal(t.secondStage?.state, "upload");
  assert.equal(t.statusLabel, "Invite received — upload the plans by hand");
  assert.match(t.secondStage!.invite!.subject, /Invitation to upload plans/);
  assert.equal(t.secondStage!.invite!.link, undefined, "a link on a host that is not this agency's verified permit portal was shown");
  assert.equal(t.secondStage!.invite!.linkHidden?.host, "plandesk.example.com");
  assert.match(t.secondStage!.invite!.linkHidden!.why, /not the portal a person verified/);
  assert.doesNotMatch(JSON.stringify(t.secondStage), /invite\/abc123/, "the hidden link itself must not reach the card");
  assert.equal(db.get<Row>("SELECT invite_link FROM track_second_stages WHERE project_id = ? AND track = 'building'", [j2])!.invite_link, "", "nor is it stored");
  assert.equal(track(j2, "electrical").secondStage?.invite, undefined, "an email naming the building application's number is not the electrical application's invite");
  assert.equal(Number(db.get<Row>("SELECT COUNT(*) AS n FROM human_review_items WHERE project_id = ? AND field_name = 'permit_status'", [j2])!.n), 0, "an invite is not a status reading: no review item is raised in front of the upload");
});
await check("INVITE: next step and the client's page move to the upload; still not filed, still no tracking target", () => {
  const step = computeNextStep(db, j2);
  assert.equal(step.key, "second_stage_upload", `${step.key}: ${step.headline}`);
  assert.match(permitFiled(j2).detail, /has invited us to upload the plans, and we are uploading them\. Not filed until the plans are in\./);
  assert.equal(sub(j2, "building").status, "awaiting_second_stage");
  assert.equal(targets(j2), 0);
  assert.equal(audits(j2, "second_stage.invite_matched").length >= 1, true);
});
await check("INVITE: a link on the agency's own person-verified permit portal is shown; a utility portal and an information page never fit", async () => {
  const j4 = newJob(TWO);
  markTrackFirstStage(db, project(j4), "building", { recordNumber: "BLD-26-05555", by: "Pat Payer", via: "by_hand" });
  const p = project(j4);
  const file = mbox("invite-own-host", "Upload invitation for BLD-26-05555", [
    `Permit application BLD-26-05555 at ${p.projectAddress} has been received and is under review.`,
    "You are invited to upload your plans in PlanDesk Review.",
    "Start here: https://permits.twostep.example.gov/plandesk/upload?record=BLD-26-05555",
  ]);
  const result = await repo.runEmailTracker(db, { filePath: file, orgId: String(p.orgId || "org-default") });
  assert.equal(result.sourceErrors.length, 0, result.sourceErrors.join("; "));
  // This one the classifier DID bucket (a status email): it is placed as ever, shown as the invite,
  // and not read as a status of a filing that does not exist yet.
  assert.ok(result.matches.find((m) => m.projectId === j4), `premise: a bucketed email (matches ${result.projectMatches})`);
  assert.equal(Number(db.get<Row>("SELECT COUNT(*) AS n FROM permit_status_checks WHERE project_id = ?", [j4])!.n), 0, "an invite is not a status reading");
  const inv = track(j4, "building").secondStage!.invite!;
  assert.equal(inv.link, "https://permits.twostep.example.gov/plandesk/upload?record=BLD-26-05555");
  assert.equal(inv.linkHidden, undefined);
  assert.match(permitFiled(j4).detail, /^Application made\. /, "made by hand: the client is not told a fee was paid");
  assert.equal(ss.inviteLinkFit(db, p, "building", "https://twostep.powerclerk.com/MvcAccount/Login").fits, false, "a utility interconnection portal on a permit track");
  assert.equal(ss.inviteLinkFit(db, p, "building", "https://www.twostep.example.gov/docs/how-to-upload.pdf").fits, false, "an information page");
});

// ── MARK ────────────────────────────────────────────────────────────────────────────────────────
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
await check("MARK: needs a named person and the confirmation number or a real screenshot; nothing files until then", () => {
  assert.equal(status(attempt(() => markSecondStageUploaded(db, project(j2), "building", { confirmationNumber: "PD-9911" }))), 400, "no name");
  assert.equal(status(attempt(() => markSecondStageUploaded(db, project(j2), "building", { uploadedBy: "Uma Uploader" }))), 400, "no number and no screenshot");
  assert.equal(status(attempt(() => ss.saveSecondStageScreenshot(db, project(j2), "building", Buffer.from("not an image"), "Uma Uploader"))), 400, "a file that is not an image");
  assert.equal(sub(j2, "building").status, "awaiting_second_stage");
  assert.equal(targets(j2), 0);
});
await check("MARK: the person's mark with the confirmation number files the track: submitted, tracked, the client hears filed, audited", () => {
  markSecondStageUploaded(db, project(j2), "building", { confirmationNumber: "PD-9911", uploadedBy: "Uma Uploader" });
  const row = sub(j2, "building");
  assert.equal(row.status, "submitted");
  assert.equal(row.application_number, "BLD-26-04120");
  assert.ok(row.submitted_at, "the filing date is the upload's");
  assert.ok(db.get<Row>("SELECT id FROM permit_check_targets WHERE project_id = ? AND application_number = 'BLD-26-04120' AND active = 1", [j2]), "tracking starts with the filing");
  assert.equal(audits(j2, FILING_ANNOUNCED_ACTION).length, 1);
  const a = audits(j2, "second_stage.upload_marked_done");
  assert.equal(a.length, 1);
  assert.equal(a[0].actor_name, "Uma Uploader");
  const t = track(j2, "building");
  assert.equal(t.status, "submitted");
  assert.equal(t.secondStage?.state, "uploaded");
  assert.equal(t.secondStage?.pending, false);
  assert.equal(t.secondStage?.uploaded?.confirmationNumber, "PD-9911");
  assert.equal(status(attempt(() => markSecondStageUploaded(db, project(j2), "building", { confirmationNumber: "PD-9911", uploadedBy: "Uma Uploader" }))), 409, "marked once");
});
await check("MARK: a screenshot (PNG by its bytes) stands in for the number; with every permit in, the client's page reads filed", () => {
  assert.notEqual(permitFiled(j2).state, "done", "one permit of two is still owed its upload");
  ss.saveSecondStageScreenshot(db, project(j2), "electrical", PNG, "Uma Uploader");
  const shot = ss.secondStageScreenshotFile(db, j2, "electrical");
  assert.ok(shot && fs.existsSync(shot.path));
  assert.equal(shot!.contentType, "image/png");
  assert.ok(!db.get<Row>("SELECT id FROM project_documents WHERE project_id = ? AND stored_path = ?", [j2, shot!.path]), "the screenshot is evidence, never a project document a filing carries");
  markSecondStageUploaded(db, project(j2), "electrical", { uploadedBy: "Uma Uploader" });
  assert.equal(sub(j2, "electrical").status, "submitted");
  assert.equal(track(j2, "electrical").status, "submitted");
  assert.equal(permitFiled(j2).state, "done");
  assert.equal(computeNextStep(db, j2).key.startsWith("second_stage"), false);
});

// ── A person can take the stage away again ──────────────────────────────────────────────────────
await check("CONFIRM: a named person removes the stage; new applications at that agency file as ever", () => {
  assert.equal(status(attempt(() => ss.removeSecondStage(db, project(j1), "electrical", ""))), 400);
  assert.equal(ss.removeSecondStage(db, project(j1), "electrical", "Vera Verifier"), true);
  assert.equal(audits(j1, "second_stage.removed").length, 1);
  assert.equal(secondStageHold(db, project(j1), "electrical"), null);
  assert.equal(track(j1, "electrical").secondStage?.basis, "described", "back to a description awaiting a person");
});

finish("secondStageFiling");
