// A NAMED PERSON OVERRIDES ONE REVIEWER BLOCKER, WITH A REASON (issue #640; owner request 2026-11-09).
//
// The escape hatch past a reviewer blocker. Defaults stay strict; an override is folded into the gate
// by repository.reviewerGateReportFor alone (after the cached vision verdicts), so every reader gives
// one answer (#214), and an override recorded after an Approve & auto-submit click does not let that
// run file (#226).
//
// Fixtures are SYNTHETIC: the stage fixture's Portland/PGE job and one-page pdf-lib plan sets. No names,
// addresses or real plan sets. Overrides are written by the PRODUCTION writer
// (reviewerOverrides.overrideReviewerBlocker, which the route calls after resolving WHO); the route's
// own rules (session name vs body, placeholders, sign-in, another org's project) are pinned against a
// real server in reviewerBlockerOverrideRoute.test.ts. The final submit is decided by the REAL
// prepareSubmission; the bot is stubbed and only reports what it was allowed.
//
//   (a) MUST-PASS    an overridden blocker reads as a callout carrying "Overridden by <name> on
//                    <date>: <reason>", identically at the gate, the submit gate's holds, the correction
//                    notice, reviewerBlockerList, getReviewerReport, the page-load read, Run Reviewer Gate
//                    (?vision=1) and the printable packet; staging proceeds (no 409) and is audited, and so
//                    is Approve.
//   (b) MUST-STOP    an override recorded AFTER a claimed approval: that run stages, does not auto-submit,
//                    automaticSubmitRefusals names the override, the approval is burned.
//       MUST-STOP    REVIVAL: an override VOID at the approval (a field edit changed the finding, so the
//                    approver saw the blocker) that applies again after the field is edited back — that
//                    run does not file either, and only the revived finding is named.
//       MUST-STOP    an override in force at the click but WITHDRAWN (or void on a replaced plan set)
//                    since, then a vision verdict cached after the approval relaxes the same findings:
//                    the run does not file; the verdict is named.
//       MUST-PASS    the same, with the override still standing: the run files (no false stop).
//       MUST-PASS    the same override recorded BEFORE the approval: the run is allowed.
//   (c) MUST-EXCLUDE a replaced plan set (new PDF bytes) voids it: the blocker blocks again and says why.
//                    So does an edit that changes the finding's own content (the DC size it computed).
//   (d) MUST-EXCLUDE overriding X never releases a different blocker Y; overriding the permit-only RSD
//                    finding leaves the NEM filing's holds exactly as they were.
//   (e) MUST-EXCLUDE the stamped-structural finding, and its tile twin, each a LIVE blocker on its own
//                    project, are refused 409 naming /structural-letter/confirm; the fold never releases
//                    them even from a tampered row; an empty reason is refused; only a current blocker can
//                    be overridden; a stale or missing page token (seenAs) is refused.
//   (f)              withdraw restores the blocker; override and withdraw are audited; reads write nothing
//                    (a write trap over standing AND void overrides); deleting the project takes its
//                    override rows with it (the FK on projects would otherwise refuse the delete).
//
// Run: npx tsx backend/test/reviewerBlockerOverride.test.ts
import "./_isolate"; // FIRST: generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import type { ReviewerReport } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("reviewer-blocker-override");
const { db, repo } = fx;
const { PDFDocument, StandardFonts } = await import("pdf-lib");
const docs = await import("../src/projectDocuments");
const { findPlanSetPdf } = await import("../src/pageImages");
const ov = await import("../src/reviewerOverrides");
const { reviewerBlockerList, reviewerBlockersFor } = await import("../src/nextStep");
const { readCorrectionNotice } = await import("../src/correctionNotice");
const { runAutopilotApproval } = await import("../src/autopilot");
const { findingHoldScope, scopeHoldsTrack } = await import("../src/gateScope");
const { planSetIdentity, applyVisionToReviewerReport } = await import("../src/reviewerVision");
const { computeNextStep } = await import("../src/nextStep");

const RSD = "city.elec.rapid-shutdown-missing"; // electrical, permit-only scope (gateScope ELECTRICAL_PERMIT_ONLY)
const DC = "city.elec.dc-size-mismatch"; // holds every filing, the utility's included
const STRUCT = "city.struct.stamped-engineering-missing";
const TILE_STRUCT = "city.struct.tile-stamped-engineering-missing"; // released by the same structural-letter door
// The fixture names rapid shutdown in three fields and runs micro-inverters (RSD only a warning).
// Without the words and with a string inverter RSD is a text BLOCKER.
const RSD_BLOCKER = {
  electricalCalcText: "NEC 705.12 load-side calculation: 200A bus x 120 percent = 240A, 200A main + 40A PV breaker = 240A.",
  labelsText: "PV label schedule includes service power source directory, disconnect labels, and backfed breaker warning.",
  splitPagesText: "01 Site/Roof Plan and PV layout with fire pathway: pages 1-2\n02 SLD 3-Line Diagram with NEC 705.12 calculation: page 3\n03 Roof framing and racking attachment detail: pages 4-5\n04 Module spec UL 61730: pages 6-8\n05 Inverter spec UL 1741 SB: pages 9-11\n06 Label schedule and placards: page 12",
  invModel: "Sunny Boy SB7.7-1SP-US-41", invQty: "1",
};
const PERSON = "Jane Example";
const REASON = "Engineer of record confirmed the rapid shutdown device on sheet E-2 by phone";

async function planSetPdf(extra = ""): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  ["PV-1 SITE PLAN", "ROOF MOUNTED PV ARRAY", "E-1 SINGLE LINE DIAGRAM", ...(extra ? [extra] : [])].forEach((line, i) =>
    page.drawText(line, { x: 40, y: 740 - i * 18, size: 11, font }));
  return Buffer.from(await pdf.save());
}

/** Attach a real plan-set PDF and make it the one every reader judges, with its text extracted. */
async function attachPlanSet(projectId: string, extra = ""): Promise<string> {
  const doc = docs.saveProjectDocument(db, projectId, {
    docType: "plan_set", filename: "plan-set.pdf", contentType: "application/pdf", buffer: await planSetPdf(extra), source: "upload",
  });
  const stored = db.get<{ stored_path: string }>("SELECT stored_path FROM project_documents WHERE id = ?", [doc.id])!.stored_path;
  // Earlier plan sets (the fixture's placeholder, or the one this replaces) could tie on the
  // millisecond; date them back (test arrangement only) and prove the choice.
  db.run("UPDATE project_documents SET uploaded_at = '2000-01-01T00:00:00.000Z' WHERE project_id = ? AND id <> ?", [projectId, doc.id]);
  assert.equal(findPlanSetPdf(db, projectId), stored, "setup: the gate would judge another plan set");
  const deadline = Date.now() + 20_000;
  while (db.get("SELECT 1 FROM project_documents WHERE project_id = ? AND content_type LIKE '%pdf%' AND extracted_text = ''", [projectId])) {
    if (Date.now() > deadline) throw new Error("plan-set text extraction did not land within 20 s");
    await new Promise((r) => setTimeout(r, 50));
  }
  return stored;
}

async function projectWith(over: Record<string, string>): Promise<string> {
  const id = fx.newProject(over as never);
  await attachPlanSet(id);
  return id;
}

const gate = (id: string): ReviewerReport => repo.reviewerGateReportFor(db, repo.getProjectDetail(db, id).project);
const blockersOf = (report: ReviewerReport): string[] => report.findings.filter((f) => f.severity === "blocker").map((f) => f.id).sort();
const findingIn = (report: ReviewerReport, fid: string) => report.findings.find((f) => f.id === fid);
const override = (projectId: string, fid: string, reason = REASON, by = PERSON) => ov.overrideReviewerBlocker(db, projectId, fid, { reason, by, userId: "" });
const today = () => new Date().toISOString().slice(0, 10);
const line = () => `Overridden by ${PERSON} on ${today()}: ${REASON}`;
const auditsFor = (action: string, projectId: string) =>
  fx.audits(action).filter((a) => a.project_id === projectId).map((a) => ({ actor: a.actor_name, ...(JSON.parse(String(a.details)) as Record<string, unknown>) }));
/** Wait until the ISO clock has moved on, so "before" and "after" are different instants. */
const tick = async () => { const t = new Date().toISOString(); while (new Date().toISOString() === t) await new Promise((r) => setTimeout(r, 2)); };
const statusOf = async (p: Promise<unknown> | (() => unknown)): Promise<{ status: number; message: string } | null> => {
  try { await (typeof p === "function" ? p() : p); return null; } catch (err) { return { status: (err as { status?: number }).status ?? 0, message: err instanceof Error ? err.message : String(err) }; }
};

type Seen = { autoSubmit?: boolean; runId?: string };
async function stage(projectId: string, opts: { approvalId?: string | null; final: boolean }): Promise<Seen> {
  process.env.PORTAL_ALLOW_FINAL_SUBMIT = "1";
  let seen: Seen | null = null;
  fx.stubRunner(async (_r, _p, _f, _d, _files, options) => {
    seen = { autoSubmit: options?.autoSubmit, runId: options?.runId };
    return { portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, steps: [{ ok: true, message: "staged" }] };
  });
  try {
    await repo.prepareSubmission(db, projectId, undefined, opts.final ? true : undefined, undefined, opts.approvalId ?? null);
  } finally {
    delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
  }
  assert.ok(seen, "the run never reached the bot");
  return seen as unknown as Seen;
}
/** The reviewer titles prepareSubmission's 409 names for this track (it must refuse AT the reviewer gate). */
async function stagingRefusal(projectId: string, track?: "nem" | "electrical"): Promise<string[]> {
  fx.stubRunner(async () => { throw new Error("the run reached the bot: staging should have been refused"); });
  try {
    await repo.prepareSubmission(db, projectId, track);
  } catch (err) {
    const details = (err as { details?: { reviewerBlockers?: string[] } }).details;
    assert.ok(details && Array.isArray(details.reviewerBlockers), `staging refused before the reviewer gate: ${err instanceof Error ? err.message : String(err)}`);
    return details.reviewerBlockers!;
  }
  throw new Error("prepareSubmission staged a project the reviewer holds");
}
const approve = (projectId: string) => repo.createRunApproval(db, { projectId, track: "permit", approver: "A. Person", approverUserId: null });

console.log("reviewer blocker override: a named person pushes past one blocker, with a reason (#640)");

fx.completeRecipe(); // [...fills, stopForReview, final submit click]

// (a) ---------------------------------------------------------------------------------------------
let aId = "";
let BLOCKERS: string[] = [];
await check("(a) setup: the project is held by RSD (and only by blockers a person may override); each is overridden", async () => {
  aId = await projectWith(RSD_BLOCKER);
  BLOCKERS = blockersOf(gate(aId));
  assert.ok(BLOCKERS.includes(RSD), `setup: RSD should be a blocker, got ${BLOCKERS.join(", ")}`);
  assert.ok(!BLOCKERS.includes(STRUCT), "setup: the stamped-structural hold cannot be overridden");
  for (const fid of BLOCKERS) {
    const out = await override(aId, fid);
    assert.equal(out.override.by, PERSON);
    assert.equal(out.override.reason, REASON);
  }
});

await check("(a) MUST-PASS every reader: the overridden blockers read as callouts carrying who, when and why", async () => {
  assert.ok(aId, "setup failed");
  const project = repo.getProjectDetail(db, aId).project;
  const g = gate(aId);
  assert.deepEqual(blockersOf(g), [], `the gate still holds on ${blockersOf(g).join(", ")}`);
  const rsd = findingIn(g, RSD)!;
  assert.equal(rsd.severity, "callout");
  assert.equal(rsd.overriddenFrom, "blocker");
  assert.equal(rsd.override?.by, PERSON);
  assert.equal(rsd.override?.reason, REASON);
  assert.ok(rsd.designTeamAction.startsWith(line()), `designTeamAction: ${rsd.designTeamAction}`);
  assert.deepEqual(ov.overriddenBlockers(g).map((f) => f.id).sort(), BLOCKERS);

  // The submit gate's permit-requirements holds name none of them.
  const titles = new Set(BLOCKERS.map((fid) => findingIn(g, fid)!.title));
  const holds = (repo.getSubmitGateReport(db, aId).checks.find((c) => c.id === "permit-requirements")?.holds ?? []).map((h) => h.label);
  assert.deepEqual(holds.filter((h) => titles.has(h)), [], `the submit gate still holds on ${holds.join(", ")}`);

  // The correction notice: info, with the override as the required action.
  const notice = readCorrectionNotice(db, aId);
  const item = notice.items.find((i) => i.findingId === RSD)!;
  assert.equal(item.weight, "info");
  assert.equal(item.required, rsd.designTeamAction, "the notice words the override differently from the gate");
  assert.deepEqual(notice.items.filter((i) => i.weight === "hold" && BLOCKERS.includes(i.findingId)), []);

  // Approve / next step.
  assert.deepEqual(reviewerBlockerList(db, project).map((b) => b.code).filter((c) => BLOCKERS.includes(c)), []);

  // The plain report, the page-load read, Run Reviewer Gate (?vision=1): the same finding, word for word.
  const plain = repo.getReviewerReport(db, aId);
  const pageLoad = (await repo.readStageResults(db, aId)).reviewerReport!;
  const vision = await repo.getReviewerReportWithVision(db, aId);
  for (const [name, report] of Object.entries({ plain, pageLoad, vision })) {
    assert.deepEqual(blockersOf(report), [], `${name} still holds on ${blockersOf(report).join(", ")}`);
    const f = findingIn(report, RSD)!;
    assert.equal(f.severity, "callout", `${name}: RSD reads as ${f.severity}`);
    assert.equal(f.designTeamAction, rsd.designTeamAction, `${name} words the override differently`);
    assert.deepEqual(f.override, rsd.override, `${name} carries a different override`);
  }

  // The printable packet.
  const html = await repo.getReviewerReportHtml(db, aId);
  assert.ok(html.includes(line()), "the printable packet does not show the override");
  const opened = auditsFor("reviewer_report.html_opened", aId).at(-1)!;
  assert.equal(opened.blockerCount, 0);
});

let aRunId = "";
await check("(a) MUST-PASS staging proceeds past the overridden blockers (no 409) and the stage is audited with who and why", async () => {
  assert.ok(aId, "setup failed");
  const seen = await stage(aId, { final: false });
  assert.equal(seen.autoSubmit, false);
  aRunId = String(seen.runId);
  const rows = auditsFor(ov.REVIEWER_OVERRIDE_RELAXED_AT_STAGE_ACTION, aId);
  assert.equal(rows.length, 1, "staging past an override wrote no audit row");
  assert.equal(rows[0].via, "stage");
  assert.equal(rows[0].runId, aRunId);
  assert.equal("recordedAfterApproval" in rows[0], false, "an ordinary run recorded an approval comparison");
  const findings = rows[0].findings as Array<{ findingId: string; by: string; reason: string; overrideId: string }>;
  assert.deepEqual(findings.map((f) => f.findingId).sort(), BLOCKERS);
  assert.ok(findings.every((f) => f.by === PERSON && f.reason === REASON && f.overrideId), JSON.stringify(findings));
  assert.equal(auditsFor("reviewer_gate.vision_relaxed_at_stage", aId).length, 0, "an override was audited as a vision read");
});

await check("(a) MUST-PASS Approve past the overridden blockers writes the row, naming the staged run", async () => {
  assert.ok(aRunId, "setup failed");
  const run = fx.latestRun(aId)!;
  await runAutopilotApproval(db, aId, { approverName: "A. Person", approverUserId: null });
  const rows = auditsFor(ov.REVIEWER_OVERRIDE_RELAXED_AT_STAGE_ACTION, aId).filter((r) => r.via === "approve");
  assert.equal(rows.length, 1, "Approve past an override wrote no audit row");
  assert.equal(rows[0].runId, String(run.id));
  assert.ok((rows[0].findings as Array<{ findingId: string }>).some((f) => f.findingId === RSD), "the Approve row does not name RSD");
});

// (b) ---------------------------------------------------------------------------------------------
await check("(b) MUST-STOP an override recorded AFTER the approval: staged, final submit refused naming the override, approval burned", async () => {
  const projectId = await projectWith(RSD_BLOCKER);
  const blockers = blockersOf(gate(projectId));
  const approval = approve(projectId);
  await tick();
  for (const fid of blockers) await override(projectId, fid);
  const seen = await stage(projectId, { approvalId: approval.id, final: true });
  assert.equal(seen.autoSubmit, false, "an override recorded after the approval let the run's final submit through");
  const declined = auditsFor("portal.auto_submit_declined", projectId);
  assert.equal(declined.length, 1, "no decline was recorded");
  const reasons = (declined[0].reasons as string[]).join(" | ");
  assert.match(reasons, /blocker override not in force at the approval \(recorded after it, or void then\) released .*city\.elec\.rapid-shutdown-missing/);
  assert.doesNotMatch(reasons, /vision verdict cached after the approval/, "the override was named as a vision verdict");
  const consumed = db.get<{ consumed_at: string | null }>("SELECT consumed_at FROM portal_run_approvals WHERE id = ?", [approval.id]);
  assert.ok(consumed?.consumed_at, "the approval survived its refused run");
  const rows = auditsFor(ov.REVIEWER_OVERRIDE_RELAXED_AT_STAGE_ACTION, projectId);
  assert.equal(rows.length, 1);
  assert.deepEqual((rows[0].recordedAfterApproval as string[]).sort(), blockers);
});

await check("(b) the one door: automaticSubmitRefusals refuses overriddenSinceApproval on its own", () => {
  const recipe = fx.completeRecipe();
  const ok = { recipeId: recipe.id, runApproval: { approver: "A. Person", runId: "r1" }, runId: "r1", env: { PORTAL_ALLOW_FINAL_SUBMIT: "1" } };
  assert.deepEqual(repo.automaticSubmitRefusals(db, { ...ok, overriddenSinceApproval: [] }), [], "setup: the clean inputs must pass");
  const refusals = repo.automaticSubmitRefusals(db, { ...ok, overriddenSinceApproval: [RSD] });
  assert.equal(refusals.length, 1);
  assert.match(refusals[0], /blocker override not in force at the approval \(recorded after it, or void then\) released city\.elec\.rapid-shutdown-missing — the approver saw it as a blocker; approve again to file/);
  assert.equal(repo.maySubmitAutomatically(db, { ...ok, overriddenSinceApproval: [RSD] }), false);
});

await check("(b) MUST-STOP revival across an approval: an override VOID at the click that applies again after an edit-back does not let the run file", async () => {
  // RSD and DC both block, so the approval has an override in force to record (RSD's) beside the void one.
  const projectId = await projectWith({ ...RSD_BLOCKER, dcKw: "10.0" });
  const blockers = blockersOf(gate(projectId));
  assert.ok(blockers.includes(DC) && blockers.includes(RSD), `setup: DC and RSD should both block, got ${blockers.join(", ")}`);
  for (const fid of blockers) await override(projectId, fid);
  assert.deepEqual(blockersOf(gate(projectId)), [], "setup: the overrides did not release every blocker");
  // A field edit changes DC's content: its override is void, so DC BLOCKS when the approver clicks.
  repo.updateProject(db, projectId, { dcKw: "12.0", systemSizeDcKw: "12.0" } as never);
  await tick();
  const atClick = gate(projectId);
  assert.deepEqual(blockersOf(atClick), [DC], `setup: at the click only DC should block, got ${blockersOf(atClick).join(", ")}`);
  assert.match(findingIn(atClick, DC)?.overrideVoided?.why ?? "", /finding changed/, "setup: DC's override is not void at the click");
  const approval = approve(projectId);
  const snapshot = db.get<{ released_overrides_json: string }>("SELECT released_overrides_json FROM portal_run_approvals WHERE id = ?", [approval.id])!;
  const released = (JSON.parse(snapshot.released_overrides_json) as Array<{ findingId: string }>).map((r) => r.findingId).sort();
  assert.ok(released.length > 0, "setup: no override was in force at the click — the precision check proves nothing");
  assert.deepEqual(released, blockers.filter((fid) => fid !== DC), "the approval recorded a different set of overrides in force");
  await tick();
  // The field is edited back: DC's override matches again and DC reads as a callout.
  repo.updateProject(db, projectId, { dcKw: "10.0", systemSizeDcKw: "10.0" } as never);
  assert.equal(findingIn(gate(projectId), DC)?.severity, "callout", "setup: the edit-back did not revive DC's override — this proves nothing");
  const seen = await stage(projectId, { approvalId: approval.id, final: true });
  assert.equal(seen.autoSubmit, false, "ESCAPE: the approver saw DC as a blocker, yet the run was allowed to file on the revived override");
  const declined = auditsFor("portal.auto_submit_declined", projectId);
  assert.equal(declined.length, 1, "no decline was recorded");
  assert.match((declined[0].reasons as string[]).join(" | "), /blocker override not in force at the approval .* released city\.elec\.dc-size-mismatch — the approver saw it as a blocker/);
  const rows = auditsFor(ov.REVIEWER_OVERRIDE_RELAXED_AT_STAGE_ACTION, projectId);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].recordedAfterApproval, [DC], "only the revived finding should be named; the others were in force at the click");
});

// AN OVERRIDE ON THE APPROVAL'S LIST SHIELDS A LATER VISION VERDICT ONLY WHILE IT STILL STANDS (#226).
// The override released every blocker at the click; then it stops releasing (withdrawn, or void on a
// replaced plan set), and a stage_step caches vision verdicts AFTER the approval that relax the same
// findings. The approver never saw that verdict: the run stops at review, naming it as a vision verdict.
/** The vision pass a stage_step runs (approvalGateSnapshot.test's): present/high for every question. */
const fakeVision = {
  async visionExtract(input: { prompt: string }): Promise<Record<string, unknown>> {
    if (/Read the DIMENSIONS/.test(input.prompt)) return { confidence: "low" };
    return { present: true, confidence: "high", observed: "synthetic sheet shows the item", missing: "" };
  },
} as never;
async function visionPassAfter(projectId: string): Promise<string[]> {
  await applyVisionToReviewerReport(db, fakeVision, repo.buildReviewerReportFor(db, repo.getProjectDetail(db, projectId).project));
  const g = gate(projectId);
  assert.deepEqual(blockersOf(g), [], "setup: the vision verdicts left a blocker");
  return g.findings.filter((f) => f.visionRelaxedFrom === "blocker").map((f) => f.id).sort();
}
const OVERRIDE_STOPS_SHIELDING: Array<[string, (projectId: string) => Promise<void>]> = [
  ["withdrawn", async (projectId) => { for (const fid of blockersOf(repo.buildReviewerReportFor(db, repo.getProjectDetail(db, projectId).project))) ov.withdrawReviewerBlockerOverride(db, projectId, fid, PERSON); }],
  ["void on a replaced plan set", async (projectId) => { await attachPlanSet(projectId, "REVISION 2 - E-1 UPDATED"); }],
];
for (const [how, stopShielding] of OVERRIDE_STOPS_SHIELDING) {
  await check(`(b) MUST-STOP an override in force at the click but ${how} since: a vision verdict cached after the approval does not let the run file`, async () => {
    const projectId = await projectWith(RSD_BLOCKER);
    const blockers = blockersOf(gate(projectId));
    for (const fid of blockers) await override(projectId, fid);
    assert.deepEqual(blockersOf(gate(projectId)), [], "setup: the overrides did not release every blocker");
    await tick();
    const approval = approve(projectId);
    const listed = db.get<{ released_overrides_json: string }>("SELECT released_overrides_json FROM portal_run_approvals WHERE id = ?", [approval.id])!;
    assert.deepEqual((JSON.parse(listed.released_overrides_json) as Array<{ findingId: string }>).map((r) => r.findingId).sort(), blockers,
      "setup: the approval did not list every override in force at the click — this proves nothing");
    await tick();
    await stopShielding(projectId);
    assert.deepEqual(blockersOf(gate(projectId)), blockers, `setup: the ${how} overrides still release a blocker`);
    await tick();
    const relaxedNow = await visionPassAfter(projectId);
    assert.ok(relaxedNow.length > 0 && relaxedNow.every((fid) => blockers.includes(fid)), `setup: vision relaxed ${relaxedNow.join(", ")}`);
    const seen = await stage(projectId, { approvalId: approval.id, final: true });
    assert.equal(seen.autoSubmit, false, `ESCAPE: a vision verdict cached AFTER the approval let the run file, because a since-${how} override was on the approval's list`);
    const declined = auditsFor("portal.auto_submit_declined", projectId);
    assert.equal(declined.length, 1, "no decline was recorded");
    assert.match((declined[0].reasons as string[]).join(" | "), new RegExp(`vision verdict cached after the approval relaxed .*${RSD.replace(/\./g, "\\.")}`));
  });
}

await check("(b) MUST-PASS an override in force at the click that STILL stands: a vision verdict cached after the approval does not stop the run", async () => {
  const projectId = await projectWith(RSD_BLOCKER);
  for (const fid of blockersOf(gate(projectId))) await override(projectId, fid);
  await tick();
  const approval = approve(projectId);
  await tick();
  assert.ok((await visionPassAfter(projectId)).includes(RSD), "setup: the vision pass did not relax RSD");
  const seen = await stage(projectId, { approvalId: approval.id, final: true });
  assert.equal(seen.autoSubmit, true, "the approver saw these findings released by a standing override, yet the run was stopped — a false stop");
  assert.equal(auditsFor("portal.auto_submit_declined", projectId).length, 0);
});

await check("(b) MUST-PASS the same override recorded BEFORE the approval → the run is allowed", async () => {
  const projectId = await projectWith(RSD_BLOCKER);
  for (const fid of blockersOf(gate(projectId))) await override(projectId, fid);
  await tick();
  const approval = approve(projectId);
  const seen = await stage(projectId, { approvalId: approval.id, final: true });
  assert.equal(seen.autoSubmit, true, "an approval that saw the overridden gate was refused — a gate nothing passes is an outage");
  assert.equal(auditsFor("portal.auto_submit_declined", projectId).length, 0);
  const rows = auditsFor(ov.REVIEWER_OVERRIDE_RELAXED_AT_STAGE_ACTION, projectId);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].recordedAfterApproval, []);
});

// (c) ---------------------------------------------------------------------------------------------
await check("(c) MUST-EXCLUDE a replaced plan set (new PDF bytes) voids the override: RSD blocks again everywhere and says why", async () => {
  const projectId = await projectWith(RSD_BLOCKER);
  await override(projectId, RSD);
  assert.equal(findingIn(gate(projectId), RSD)?.severity, "callout", "setup: the override did not release RSD");
  await tick();
  await attachPlanSet(projectId, "REVISION 2 - E-1 UPDATED");
  const g = gate(projectId);
  const rsd = findingIn(g, RSD)!;
  assert.equal(rsd.severity, "blocker", "an override of the old plan set released the new one");
  assert.equal(rsd.override, undefined);
  assert.equal(rsd.overrideVoided?.by, PERSON);
  assert.match(rsd.overrideVoided?.why ?? "", /plan set was replaced/);
  assert.ok(reviewerBlockerList(db, repo.getProjectDetail(db, projectId).project).some((b) => b.code === RSD), "Approve / next step reads the void override as standing");
  assert.ok((await stagingRefusal(projectId)).includes(rsd.title), "staging reads the void override as standing");
  assert.equal(readCorrectionNotice(db, projectId).items.find((i) => i.findingId === RSD)?.weight, "hold");
});

await check("(c) MUST-EXCLUDE an edit that changes the finding's content voids it: the DC size override no longer holds after the DC size changes", async () => {
  const projectId = await projectWith({ dcKw: "10.0" });
  const before = findingIn(gate(projectId), DC)!;
  assert.equal(before.severity, "blocker", "setup: DC should be a blocker");
  await override(projectId, DC, "Designer confirmed the module count; the portal value is updated at filing");
  assert.equal(findingIn(gate(projectId), DC)?.severity, "callout", "setup: the override did not release DC");
  repo.updateProject(db, projectId, { dcKw: "12.0", systemSizeDcKw: "12.0" } as never);
  const after = findingIn(gate(projectId), DC)!;
  assert.notEqual(after.message, before.message, "setup: the edit did not change what the finding says — this proves nothing");
  assert.equal(after.severity, "blocker", "an override of the 10 kW finding released the 12 kW one");
  assert.match(after.overrideVoided?.why ?? "", /finding changed/);
  // The fingerprint ignores provenance: the same finding hashes the same however it was folded.
  assert.equal(ov.findingFingerprint({ ...before, designTeamAction: "x", evidenceStatus: "verified" }), ov.findingFingerprint(before));
  assert.notEqual(ov.findingFingerprint(after), ov.findingFingerprint(before));
});

await check("(c) MUST-PASS a provenance-only change keeps the override: re-verifying the code profile (seeded -> human-verified, or a new verifier/date) does not void it; a plan-content change does", () => {
  // The live case behind #596: approving the Oregon profile's edition proposal rewrites only the
  // provenance a code-basis message carries. A person's override of that blocker must survive it.
  const basis = (provenance: string, plan = "OESC 2026") => ({
    id: "city.code.basis-mismatch", category: "plan_set", severity: "blocker" as const,
    title: "Plan's code basis differs from the jurisdiction's adopted codes",
    message: `plan states ${plan} (Plan set) — profile records OESC 2023. Profile: OR state-level code profile (${provenance}; source https://example.gov/codes) for OESC 2023, inherited by Testington County.`,
    evidenceNeeded: ["Governing-codes block on the cover sheet"],
    evidenceFound: [{ kind: "source_excerpt" as const, label: plan, source: "Plan set", excerpt: `GOVERNING CODES: ${plan}`, confidence: "high" as const, pageHint: "", screenshotPath: "", verifier: "rule_engine" as const, note: "" }],
  }) as unknown as Parameters<typeof ov.findingFingerprint>[0];
  const seeded = ov.findingFingerprint(basis("seeded from research 2026-09-24"));
  const verifiedA = ov.findingFingerprint(basis("human-verified by Operator A on 2026-10-06"));
  const verifiedB = ov.findingFingerprint(basis("human-verified by Operator B on 2026-11-09"));
  assert.equal(verifiedA, seeded, "seeded -> human-verified voided the override");
  assert.equal(verifiedB, verifiedA, "a new verifier/date voided the override");
  assert.notEqual(ov.findingFingerprint(basis("human-verified by Operator A on 2026-10-06", "OESC 2029")), verifiedA, "a different plan edition must void it");
});

// (d) ---------------------------------------------------------------------------------------------
await check("(d) MUST-EXCLUDE overriding X (RSD) never releases Y (DC, or any other blocker); the NEM filing's holds are untouched", async () => {
  const projectId = await projectWith({ ...RSD_BLOCKER, dcKw: "10.0" });
  const project = () => repo.getProjectDetail(db, projectId).project;
  const before = blockersOf(gate(projectId));
  assert.ok(before.includes(RSD) && before.includes(DC), `setup: ${before.join(", ")}`);
  const rsdScope = findingHoldScope(findingIn(gate(projectId), RSD)!);
  assert.equal(scopeHoldsTrack(rsdScope, "nem"), false, `setup: RSD (${rsdScope}) should be a permit-only finding`);
  const nemBefore = reviewerBlockersFor(reviewerBlockerList(db, project()), "nem").map((b) => b.code).sort();
  assert.ok(nemBefore.includes(DC), `setup: DC should hold the NEM filing, got ${nemBefore.join(", ")}`);
  const nemRefusedBefore = await stagingRefusal(projectId, "nem");

  await override(projectId, RSD);
  const after = gate(projectId);
  assert.deepEqual(blockersOf(after), before.filter((fid) => fid !== RSD), "overriding RSD changed another finding's severity");
  assert.equal(findingIn(after, RSD)?.severity, "callout");
  for (const fid of before.filter((f) => f !== RSD)) assert.equal(findingIn(after, fid)?.override, undefined, `${fid} carries RSD's override`);
  assert.deepEqual(reviewerBlockersFor(reviewerBlockerList(db, project()), "nem").map((b) => b.code).sort(), nemBefore, "the NEM filing's holds moved");
  assert.deepEqual(await stagingRefusal(projectId, "nem"), nemRefusedBefore, "NEM staging is held differently");
  const electrical = await stagingRefusal(projectId, "electrical");
  assert.ok(electrical.includes(findingIn(after, DC)!.title), "the electrical filing lost the DC hold");
  assert.ok(!electrical.includes(findingIn(after, RSD)!.title), "the electrical filing still holds on the overridden RSD");
});

// (e) ---------------------------------------------------------------------------------------------
// Each stamped-structural hold as a LIVE blocker on its own project: the engineered permit path with no
// sealed letter raises STRUCT; a concrete-tile roof raises the tile twin.
const STRUCT_LIVE: Array<[string, Record<string, string>]> = [
  [STRUCT, { permitPath: "Engineered (non-prescriptive)" }],
  [TILE_STRUCT, { roofMaterial: "Concrete Tile" }],
];
for (const [fid, over] of STRUCT_LIVE) {
  await check(`(e) MUST-EXCLUDE ${fid}, a LIVE blocker here, is refused 409 naming its own door, and nothing is written`, async () => {
    const projectId = fx.newProject(over as never);
    const live = findingIn(gate(projectId), fid);
    assert.equal(live?.severity, "blocker", `setup: ${fid} is not a live blocker (${live?.severity ?? "absent"}) — this proves nothing`);
    assert.equal(live?.overrideSeenAs, undefined, "the gate offers an override token on a hold no override may release");
    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviewer_blocker_overrides")!.n;
    const refused = await statusOf(override(projectId, fid));
    assert.equal(refused?.status, 409);
    assert.match(refused!.message, /structural-letter\/confirm/);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviewer_blocker_overrides")!.n, before);
    assert.equal(findingIn(gate(projectId), fid)?.severity, "blocker");
  });
}

await check("(e) MUST-EXCLUDE TAMPER TEST (raw SQL on purpose: no writer can make this row): the fold never releases a stamped-structural blocker", () => {
  const projectId = fx.newProject({ permitPath: "Engineered (non-prescriptive)" } as never);
  const live = findingIn(gate(projectId), STRUCT)!;
  assert.equal(live?.severity, "blocker", "setup: STRUCT is not a live blocker");
  // A row that would match in every other respect: this finding's own fingerprint and plan set.
  db.run(
    `INSERT INTO reviewer_blocker_overrides (id, project_id, finding_id, fingerprint, plan_set_sig, reason, overridden_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'tampered', 'Tamper Test', ?)`,
    [`tamper-${projectId}`, projectId, STRUCT, ov.findingFingerprint(live), planSetIdentity(db, projectId), new Date(Date.now() - 1000).toISOString()],
  );
  const after = findingIn(gate(projectId), STRUCT)!;
  assert.equal(after.severity, "blocker", "a tampered override row released the stamped-structural hold");
  assert.equal(after.overriddenFrom, undefined);
  // The fold itself, on a hand-built report (with an overridable blocker beside it, so the fold walks
  // every finding): STRUCT stays a blocker and gets no token.
  const other = { ...live, id: "city.test.other-blocker", overrideSeenAs: undefined };
  const handBuilt: ReviewerReport = { ...gate(projectId), findings: [{ ...live, overrideSeenAs: undefined }, other] };
  const folded = ov.applyReviewerBlockerOverrides(db, handBuilt).findings;
  assert.equal(folded[0].severity, "blocker");
  assert.equal(folded[0].overrideSeenAs, undefined);
  assert.ok(folded[1].overrideSeenAs, "setup: the fold did not walk the findings");
});

await check("(e) MUST-EXCLUDE the page token binds the override: a missing token → 400, a stale one (the finding changed) → 409, the current one → 200", async () => {
  const projectId = await projectWith({ dcKw: "10.0" });
  const seenThen = findingIn(gate(projectId), DC)?.overrideSeenAs ?? "";
  assert.ok(seenThen, "setup: the DC blocker carries no override token");
  const byRoute = (seenAs: string) => ov.overrideReviewerBlocker(db, projectId, DC, { reason: REASON, by: PERSON, userId: "", seenAs });
  assert.equal((await statusOf(byRoute("")))?.status, 400, "an override with no page token was accepted");
  repo.updateProject(db, projectId, { dcKw: "12.0", systemSizeDcKw: "12.0" } as never);
  const stale = await statusOf(byRoute(seenThen));
  assert.equal(stale?.status, 409, "an override bound to content the person never saw was accepted");
  assert.match(stale!.message, /changed since you looked/);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviewer_blocker_overrides WHERE project_id = ?", [projectId])!.n, 0, "a refused override wrote a row");
  const seenNow = findingIn(gate(projectId), DC)!.overrideSeenAs!;
  assert.notEqual(seenNow, seenThen);
  await byRoute(seenNow);
  assert.equal(findingIn(gate(projectId), DC)?.severity, "callout");
});

await check("(e) MUST-EXCLUDE an empty reason, a non-blocker, an already-overridden blocker and a missing finding are refused", async () => {
  const projectId = await projectWith(RSD_BLOCKER);
  assert.equal((await statusOf(override(projectId, RSD, "")))?.status, 400, "an empty reason was accepted");
  assert.equal((await statusOf(override(projectId, RSD, "   \n ")))?.status, 400, "a blank reason was accepted");
  assert.equal((await statusOf(override(projectId, RSD, REASON, " ")))?.status, 400, "no person was accepted");
  const notBlocker = gate(projectId).findings.find((f) => f.severity === "warning" || f.severity === "callout")!;
  assert.ok(notBlocker, "setup: no non-blocker finding to try");
  assert.equal((await statusOf(override(projectId, notBlocker.id)))?.status, 409, "a non-blocker was overridden");
  assert.equal((await statusOf(override(projectId, "city.no.such-finding")))?.status, 409, "a finding not on the gate was overridden");
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviewer_blocker_overrides WHERE project_id = ?", [projectId])!.n, 0, "a refused override wrote a row");
  await override(projectId, RSD);
  assert.equal((await statusOf(override(projectId, RSD)))?.status, 409, "an already-overridden blocker was overridden again");
});

// (f) ---------------------------------------------------------------------------------------------
// A write trap (nextStep.test's shape): every write the AppDb can make goes through run / exec /
// transaction, so an UPDATE that changes no row count is caught too.
const trapWrites = <T>(fn: () => T): { value: T; writes: string[] } => {
  const writes: string[] = [];
  const orig = { run: db.run, exec: db.exec, transaction: db.transaction };
  db.run = ((sql: string) => { writes.push(sql.trim().slice(0, 80)); }) as typeof db.run;
  db.exec = ((sql: string) => { writes.push(sql.trim().slice(0, 80)); }) as typeof db.exec;
  db.transaction = (<R>(f: () => R): R => { writes.push("transaction"); return f(); }) as typeof db.transaction;
  try {
    return { value: fn(), writes };
  } finally {
    db.run = orig.run; db.exec = orig.exec; db.transaction = orig.transaction;
  }
};

await check("(f) reads write nothing: the gate, the notice, the blocker list and next-step, over a standing override AND two void ones", async () => {
  assert.ok(aId, "setup failed");
  // Two fresh void overrides whose FIRST read after the voiding change is inside the trap, so a read
  // that stamped a void (the forbidden write) is caught here and not hidden by an earlier read.
  const planSetVoid = await projectWith(RSD_BLOCKER);
  await override(planSetVoid, RSD);
  await tick();
  await attachPlanSet(planSetVoid, "REVISION 2 - E-1 UPDATED");
  const fieldVoid = await projectWith({ dcKw: "10.0" });
  await override(fieldVoid, DC, "Designer confirmed the module count");
  repo.updateProject(db, fieldVoid, { dcKw: "12.0", systemSizeDcKw: "12.0" } as never);
  const cases = [
    ["standing", aId, RSD, (f: ReviewerReport["findings"][number] | undefined) => f?.overriddenFrom === "blocker"],
    ["plan-set void", planSetVoid, RSD, (f: ReviewerReport["findings"][number] | undefined) => /plan set was replaced/.test(f?.overrideVoided?.why ?? "")],
    ["field void", fieldVoid, DC, (f: ReviewerReport["findings"][number] | undefined) => /finding changed/.test(f?.overrideVoided?.why ?? "")],
  ] as const;
  for (const [label, pid, fid, exercised] of cases) {
    const project = repo.getProjectDetail(db, pid).project;
    const first = trapWrites(() => repo.reviewerGateReportFor(db, project));
    assert.deepEqual(first.writes, [], `reviewerGateReportFor over a ${label} override wrote: ${first.writes.join(" | ")}`);
    assert.ok(exercised(findingIn(first.value, fid)), `setup: the ${label} case is not what the gate shows: ${JSON.stringify(findingIn(first.value, fid)?.overrideVoided ?? findingIn(first.value, fid)?.override ?? null)}`);
    for (const [reader, fn] of [
      ["readCorrectionNotice", () => readCorrectionNotice(db, pid)],
      ["reviewerBlockerList", () => reviewerBlockerList(db, project)],
      ["computeNextStep", () => computeNextStep(db, pid)],
    ] as const) {
      const t = trapWrites(fn as () => unknown);
      assert.deepEqual(t.writes, [], `${reader} over a ${label} override wrote: ${t.writes.join(" | ")}`);
    }
  }
});

await check("(f) withdraw restores the blocker; override and withdraw are both in the audit trail under the person", async () => {
  assert.ok(aId, "setup failed");
  const out = ov.withdrawReviewerBlockerOverride(db, aId, RSD, PERSON);
  assert.equal(out.withdrawn, true);
  const rsd = findingIn(gate(aId), RSD)!;
  assert.equal(rsd.severity, "blocker", "a withdrawn override still releases RSD");
  assert.equal(rsd.overrideVoided, undefined, "a withdrawn override reads as a void one");
  assert.ok(reviewerBlockerList(db, repo.getProjectDetail(db, aId).project).some((b) => b.code === RSD));
  const row = db.get<{ withdrawn_by: string; withdrawn_at: string }>("SELECT withdrawn_by, withdrawn_at FROM reviewer_blocker_overrides WHERE id = ?", [out.overrideId])!;
  assert.equal(row.withdrawn_by, PERSON);
  assert.ok(row.withdrawn_at);
  const overridden = auditsFor(ov.REVIEWER_BLOCKER_OVERRIDDEN_ACTION, aId);
  assert.deepEqual(overridden.map((r) => r.findingId).sort(), BLOCKERS);
  assert.ok(overridden.every((r) => r.actor === PERSON && r.reason === REASON && r.planSetSig && r.fingerprint), JSON.stringify(overridden[0]));
  const withdrawn = auditsFor(ov.REVIEWER_BLOCKER_OVERRIDE_WITHDRAWN_ACTION, aId);
  assert.equal(withdrawn.length, 1);
  assert.equal(withdrawn[0].actor, PERSON);
  assert.equal(withdrawn[0].overrideId, out.overrideId);
  assert.equal((await statusOf(() => ov.withdrawReviewerBlockerOverride(db, aId, RSD, PERSON)))?.status, 409, "withdrawing twice was accepted");
  // A new override after a withdraw is a new row; the withdrawn one stays in the table.
  await override(aId, RSD, "Second look: device confirmed on the revised cut sheet");
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviewer_blocker_overrides WHERE project_id = ? AND finding_id = ?", [aId, RSD])!.n, 2);
  assert.equal(findingIn(gate(aId), RSD)?.severity, "callout");
});

await check("(f) deleting a project with override rows (standing and withdrawn) succeeds and takes them with it", async () => {
  const projectId = await projectWith(RSD_BLOCKER);
  await override(projectId, RSD);
  ov.withdrawReviewerBlockerOverride(db, projectId, RSD, PERSON);
  await override(projectId, RSD, "Second look: device confirmed on the revised cut sheet");
  const count = () => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reviewer_blocker_overrides WHERE project_id = ?", [projectId])!.n;
  assert.equal(count(), 2, "setup: expected a withdrawn and a standing override row");
  const err = await statusOf(() => repo.deleteProject(db, projectId));
  assert.equal(err, null, `deleteProject failed on a project with overrides: ${err?.message}`);
  assert.equal(count(), 0, "the project's override rows outlived it");
  assert.ok(!db.get("SELECT 1 FROM projects WHERE id = ?", [projectId]), "the project was not deleted");
});

finish("reviewerBlockerOverride");
