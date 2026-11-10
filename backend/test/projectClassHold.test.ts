// A COMMERCIAL OR OVERSIZE JOB IS HELD FOR A PERSON (#688).
//
// The commercial soft run (invented jobs, 30 to 750 kW) showed every one passing intake QC, a 750 kW
// ground mount resolving to a residential net-metering portal and replaying a residential recipe,
// and a job with every occupancy field set to "Commercial" producing byte-identical output. This
// pins the hold at every door, through the REAL code (browser and learner stubbed):
//
//   PURE SCREEN (shared/src/projectClass.ts)
//     s1 an 8 kW single-family job raises nothing; residential evidence (R-3, "Occupancy Category II",
//        120/240 V, single-phase) raises nothing.
//     s2 the 750 kW three-phase 480 V warehouse raises occupancy, service and size signals.
//     s3 the control job (8 kW, occupancyType "Commercial") raises the occupancy signal.
//     s4 a verbatim-cited cap BLOCKS; a cap whose quote lacks its value WARNS; no cited cap → the
//        strict 25 kW default WARNS; a cited cap replaces the default (30 kW under a cited 50 passes).
//     s5 a person's confirmation covers exactly the signals they saw; changed evidence re-raises.
//   DOORS (a Portland/PGE job that clears every gate — _stageFixture)
//     d1 MUST-PASS: the 8 kW job stages through the recipe exactly as before — no class QC row, no
//        class gate check, no class next step, its track card names the recipe.
//     d2 the 750 kW job is refused at prepareSubmission (409, nothing run, no portal_runs row), its
//        QC carries the cited-cap blocker (Oregon's shipped OAR row), the gate holds it, the next step
//        names the hold, its cards name no recipe and say why, Segment A refuses it.
//     d3 the control job (occupancy "Commercial") is held the same way.
//     d4 commercial at intake (createProject's option) is held from birth.
//     d5 a named person confirming "residential" releases the control job (it stages); a change in
//        its evidence afterwards holds it again; a bad class / no name writes nothing.
//     d6 THE LEARN DOOR: a held job's auto/supervised learn is refused before any launch and leaves
//        the portal's residential recipe row BYTE-IDENTICAL; MUST-PASS a residential job's learn
//        reaches the launcher.
//     d7 the correction reopen replays no recipe for a held job (and still does for a residential one).
//
// KILL TESTS (each verified by hand): drop the prepareSubmission refusal → d2/d3/d4 fail; drop the
// autoLearnPortal refusal → d6 fails (recipe reset); drop the reopen skip → d7 fails.
//
//   npx tsx backend/test/projectClassHold.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("project-class-hold");
const { db, repo, recipes } = fx;
const pc = await import("../../shared/src/projectClass");
const nextStep = await import("../src/nextStep");
const tracks = await import("../src/submittalTracks");
const autopilot = await import("../src/autopilot");
const autoLearn = await import("../src/autoLearn");

let runs = 0;
fx.stubRunner(async () => { runs++; return { ok: true, finalSubmitClicked: false, steps: [{ ok: true, message: "reached review" }] } as never; });
let launches = 0;
autoLearn.setAutoLearnSeamsForTests({
  learnPortal: (async () => {
    launches++;
    return { ok: false, portalName: "stub", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 0, pauseReason: null, message: "stub learn: nothing walked" };
  }) as never,
});

const WAREHOUSE = { dcKw: "750", acKw: "600", servicePhase: "three-phase", serviceVoltage: "480", occupancy: "Commercial - S-1 warehouse" };
const CONTROL = { occupancyType: "Commercial" };
const job = (snapshot: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  systemSizeDcKw: snapshot.dcKw != null ? Number(snapshot.dcKw) : null,
  systemSizeAcKw: snapshot.acKw != null ? Number(snapshot.acKw) : null,
  parserSnapshot: snapshot as never,
  ...extra,
});
const codes = (sigs: Array<{ code: string }>) => sigs.map((s) => s.code).sort();
const qcClassRows = (pid: string) => db.query<{ rule_id: string; qc_status: string; severity: string }>(
  "SELECT rule_id, qc_status, severity FROM qc_results WHERE project_id = ? AND rule_id LIKE 'project-class.%' ORDER BY rule_id", [pid]);
const gateIds = (pid: string) => repo.getSubmitGateReport(db, pid).checks.map((c) => `${c.id}:${c.status}`);
const runRows = (pid: string) => Number(db.get<{ n: number }>("SELECT COUNT(*) n FROM portal_runs WHERE project_id = ?", [pid])?.n ?? 0);
const refusedAsHeld = async (pid: string) => {
  const before = runs;
  await assert.rejects(repo.prepareSubmission(db, pid), (err: { status?: number; details?: { classHeld?: boolean } }) => err.status === 409 && err.details?.classHeld === true);
  assert.equal(runs, before, "the browser ran for a held job");
  assert.equal(runRows(pid), 0, "a portal_runs row was written for a held job");
};

// ── PURE SCREEN ──────────────────────────────────────────────────────────────────────────────
await check("s1 an 8 kW single-family job, and residential evidence, raise no signal", () => {
  assert.deepEqual(pc.screenProjectClass(job({ dcKw: "8.6", acKw: "6.5" })), []);
  assert.deepEqual(pc.screenProjectClass(job({
    dcKw: "8", acKw: "7", occupancy: "R-3", occupancyType: "Residential", structureDescription: "Single-family dwelling",
    sitePlanNotesText: "Risk / Occupancy Category II. Single family residence.", servicePhase: "single-phase", serviceVoltage: "120/240V",
  })), []);
  const st = pc.projectClassStatus(job({ dcKw: "8.6" }));
  assert.equal(st.held, false);
  assert.equal(st.projectClass, "residential");
});
await check("s2 the 750 kW three-phase 480 V warehouse raises occupancy, service and size signals", () => {
  const st = pc.projectClassStatus(job(WAREHOUSE));
  assert.deepEqual(codes(st.signals), ["occupancy.non_dwelling", "service.three_phase", "size.ac_over_cap", "size.dc_over_cap"]);
  assert.equal(st.held, true);
  assert.match(String(st.holdReason), /^Probably commercial — confirm class/);
});
await check("s3 the control job (occupancyType Commercial, 8 kW) raises the occupancy signal; plan notes naming group B do too", () => {
  assert.deepEqual(codes(pc.screenProjectClass(job({ dcKw: "8", ...CONTROL }))), ["occupancy.non_dwelling"]);
  assert.deepEqual(codes(pc.screenProjectClass(job({ dcKw: "8", sitePlanNotesText: "Building occupancy group S-1 / B, Type II-B." }))), ["occupancy.non_dwelling"]);
  assert.deepEqual(codes(pc.screenProjectClass(job({ dcKw: "8", serviceVoltage: "208Y/120V" }))), ["service.three_phase"]);
});
await check("s4 a verbatim-cited cap blocks, an unquoted one warns, the strict default warns, a cited cap replaces the default", () => {
  const cited = { basis: "dc" as const, valueKw: 25, sourceName: "Program rule 1", sourceUrl: "https://rules.example.gov/r1", quote: "facilities with a generating capacity of 25 kilowatts or less" };
  assert.deepEqual(pc.screenProjectClass(job({ dcKw: "30" }), [cited]).map((s) => s.severity), ["blocker"]);
  assert.deepEqual(pc.screenProjectClass(job({ dcKw: "30" }), [{ ...cited, quote: "small facilities only" }]).map((s) => s.severity), ["warning"]);
  assert.deepEqual(pc.screenProjectClass(job({ dcKw: "30" }), [{ ...cited, sourceUrl: "" }]).map((s) => s.severity), ["warning"]);
  const dflt = pc.screenProjectClass(job({ dcKw: "30" }));
  assert.deepEqual(dflt.map((s) => [s.code, s.severity]), [["size.dc_over_cap", "warning"]]);
  assert.equal(pc.DEFAULT_RESIDENTIAL_CAP_KW, 25);
  assert.deepEqual(pc.screenProjectClass(job({ dcKw: "30" }), [{ ...cited, valueKw: 50, quote: "50 kilowatts or less" }]), []);
  assert.deepEqual(pc.screenProjectClass(job({ dcKw: "25" })), [], "the cap is inclusive");
  assert.deepEqual(codes(pc.screenProjectClass(job({ dcKw: "8", combinedDcKw: "31" }))), ["size.dc_over_cap"], "an addition is screened on the combined size");
});
await check("s5 a confirmation covers exactly the signals a person saw; changed evidence re-raises; commercial always holds", () => {
  const sigs = pc.screenProjectClass(job({ dcKw: "30" }));
  const confirmation = { by: "Dana Reviewer", at: "2026-11-10", projectClass: "residential" as const, signalKeys: sigs.map((s) => s.key) };
  assert.equal(pc.projectClassStatus(job({ dcKw: "30" }, { projectClassConfirmation: confirmation })).held, false);
  assert.equal(pc.projectClassStatus(job({ dcKw: "400" }, { projectClassConfirmation: confirmation })).held, true, "a re-drawn 400 kW job slipped through a 30 kW confirmation");
  assert.equal(pc.projectClassStatus(job({ dcKw: "8" }, { projectClass: "commercial" })).held, true);
  assert.match(String(pc.projectClassStatus(job({ dcKw: "8" }, { projectClass: "commercial" })).holdReason), /^Commercial job — held for a person/);
});

// ── DOORS ────────────────────────────────────────────────────────────────────────────────────
const recipe = fx.completeRecipe();

await check("d1 MUST-PASS: the 8 kW single-family job stages through the recipe as before, with no class artifact anywhere", async () => {
  const pid = fx.newProject();
  assert.deepEqual(qcClassRows(pid), []);
  assert.ok(!gateIds(pid).some((g) => g.startsWith("project-class-hold")), gateIds(pid).join(", "));
  assert.notEqual(nextStep.computeNextStep(db, pid).key, "class_held");
  const card = tracks.getSubmittalTracks(db, repo.getProjectDetail(db, pid).project);
  assert.ok(card.every((t) => !String(t.stageBlocked ?? "").includes("commercial")), JSON.stringify(card.map((t) => t.stageBlocked)));
  assert.equal(repo.getProjectDetail(db, pid).classStatus?.held, false);
  const before = runs;
  await repo.prepareSubmission(db, pid);
  assert.equal(runs, before + 1, "the residential job did not reach the runner");
  assert.equal(String(fx.latestRun(pid)?.recipe_id ?? ""), recipe.id, "recipe choice changed for a residential job");
});

await check("d2 the 750 kW warehouse is held at every door (staging, QC, gate, next step, cards, Segment A)", async () => {
  const pid = fx.newProject(WAREHOUSE as never);
  await refusedAsHeld(pid);
  const rows = qcClassRows(pid);
  assert.ok(rows.some((r) => r.rule_id === "project-class.size.dc_over_cap" && r.qc_status === "fail" && r.severity === "blocker"),
    `Oregon's verbatim-cited 25 kW row must block: ${JSON.stringify(rows)}`);
  assert.ok(rows.some((r) => r.rule_id === "project-class.service.three_phase" && r.qc_status === "warning"), JSON.stringify(rows));
  assert.ok(gateIds(pid).includes("project-class-hold:blocker"), gateIds(pid).join(", "));
  assert.equal(repo.getSubmitGateReport(db, pid).canPrepareSubmission, false);
  assert.equal(nextStep.computeNextStep(db, pid).key, "class_held");
  const cards = tracks.getSubmittalTracks(db, repo.getProjectDetail(db, pid).project);
  assert.ok(cards.length > 0 && cards.every((t) => /Probably commercial/.test(String(t.stageBlocked ?? ""))), JSON.stringify(cards.map((t) => t.stageBlocked)));
  assert.ok(cards.every((t) => !t.recipe), "a held job's card named a recipe it would never replay");
  const seg = await autopilot.runAutopilotSegmentA(db, pid);
  assert.equal(seg.blocked, true);
  assert.deepEqual(seg.blockers.map((b) => b.code), ["class_held"]);
  assert.equal(runRows(pid), 0);
});

let controlId = "";
await check("d3 the control job (8 kW, occupancyType Commercial) is held — occupancy is no longer inert", async () => {
  controlId = fx.newProject(CONTROL as never);
  await refusedAsHeld(controlId);
  assert.deepEqual(qcClassRows(controlId).map((r) => `${r.rule_id}:${r.qc_status}`), ["project-class.occupancy.non_dwelling:warning"]);
  assert.equal(nextStep.computeNextStep(db, controlId).key, "class_held");
});

await check("d4 a job set commercial at intake is held from birth", async () => {
  const created = repo.createProject(db, { clientId: fx.client.id, owner: "Intake Owner", street: "9 Intake Way", city: "Portland", state: "OR", zip: "97201", ahj: "Portland", utility: "PGE", dcKw: "8" } as never, undefined, { projectClass: "commercial" });
  assert.equal(created.project.projectClass, "commercial");
  assert.equal(created.classStatus?.held, true);
  await refusedAsHeld(created.project.id);
  assert.deepEqual(qcClassRows(created.project.id).map((r) => r.rule_id), ["project-class.commercial"]);
  // The intake form sends it in the payload (POST /api/projects): the class column, never a parser key.
  const viaForm = repo.createProject(db, { clientId: fx.client.id, owner: "Form Owner", street: "10 Intake Way", city: "Portland", state: "OR", zip: "97201", ahj: "Portland", utility: "PGE", dcKw: "8", projectClass: "commercial" } as never);
  assert.equal(viaForm.project.projectClass, "commercial");
  assert.equal("projectClass" in (viaForm.project.parserSnapshot as Record<string, unknown>), false, "the class leaked into the parser snapshot");
  assert.equal(db.query("SELECT 1 FROM extracted_fields WHERE project_id = ? AND field_name = 'projectClass'", [viaForm.project.id]).length, 0, "the class was stored as an extracted field");
  const residentialForm = repo.createProject(db, { clientId: fx.client.id, owner: "Form Owner 2", street: "11 Intake Way", city: "Portland", state: "OR", zip: "97201", ahj: "Portland", utility: "PGE", dcKw: "8", projectClass: "residential" } as never);
  assert.equal(residentialForm.classStatus?.held, false);
});

await check("d5 a named person confirming residential releases the control job; changed evidence holds it again; bad input writes nothing", async () => {
  assert.throws(() => repo.setProjectClass(db, controlId, { projectClass: "industrial", by: "Dana Reviewer" }), (e: { status?: number }) => e.status === 400);
  assert.throws(() => repo.setProjectClass(db, controlId, { projectClass: "residential", by: "  " }), (e: { status?: number }) => e.status === 400);
  assert.equal(repo.getProjectDetail(db, controlId).project.projectClassConfirmation, null, "a refused confirmation was written");
  const detail = repo.setProjectClass(db, controlId, { projectClass: "residential", by: "Dana Reviewer" });
  assert.equal(detail.classStatus?.held, false);
  assert.equal(detail.project.projectClassConfirmation?.by, "Dana Reviewer");
  assert.deepEqual(qcClassRows(controlId), [], "QC still flags a confirmed job");
  const audit = db.get<{ details: string; actor_name: string }>("SELECT details, actor_name FROM audit_logs WHERE project_id = ? AND action = 'project.class_set'", [controlId]);
  assert.equal(audit?.actor_name, "Dana Reviewer");
  const before = runs;
  await repo.prepareSubmission(db, controlId);
  assert.equal(runs, before + 1, "a confirmed residential job did not stage");
  db.run("UPDATE projects SET system_size_dc_kw = 40 WHERE id = ?", [controlId]);
  assert.equal(repo.getProjectDetail(db, controlId).classStatus?.held, true, "a 40 kW re-draw slipped through an 8 kW confirmation");
  repo.setProjectClass(db, controlId, { projectClass: "commercial", by: "Dana Reviewer" });
  assert.match(String(repo.getProjectDetail(db, controlId).classStatus?.holdReason), /^Commercial job/);
});

await check("d6 THE LEARN DOOR: a held job's learn is refused before any launch and the residential recipe stays byte-identical", async () => {
  const PGE_NM = "https://pgenm.powerclerk.com/MvcAccount/Login";
  const r = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "PGE", portalUrl: PGE_NM, createdBy: "test" });
  recipes.savePortalRecipeSteps(db, r.id, [{ action: "fill", selector: { name: "a" }, field: "homeownerName" }, { action: "stopForReview", selector: {} }] as RecipeStep[], { status: "complete" });
  const rowJson = () => JSON.stringify(db.query("SELECT * FROM portal_recipes ORDER BY id"));
  const before = rowJson();
  const launchesBefore = launches;
  const held = fx.newProject(WAREHOUSE as never);
  for (const scope of ["utility", "ahj"] as const) {
    await assert.rejects(
      autoLearn.autoLearnPortal(db, held, { scope, portalUrl: scope === "utility" ? PGE_NM : "https://permits.portland.example/apply", createdBy: "operator (supervised)", headless: false }),
      (err: { status?: number; details?: { classHeld?: boolean } }) => err.status === 409 && err.details?.classHeld === true,
    );
  }
  assert.equal(launches, launchesBefore, "a learn launched for a held job");
  assert.equal(rowJson(), before, "a held job's learn changed portal_recipes");
  assert.equal(db.query("SELECT 1 FROM audit_logs WHERE project_id = ? AND action = 'portal.learn_refused_class_hold'", [held]).length, 2);
  // MUST-PASS: a residential job's learn still reaches the launcher.
  await autoLearn.autoLearnPortal(db, fx.newProject(), { scope: "ahj", portalUrl: "https://devhub.portlandoregon.gov/", createdBy: "operator" });
  assert.equal(launches, launchesBefore + 1, "a residential job's learn no longer reaches the launcher");
});

await check("d7 the correction reopen replays no recipe for a held job, and still does for a residential one", async () => {
  const seen: Array<{ steps: number }> = [];
  const runner = (async (rec: { steps?: unknown[] }) => {
    seen.push({ steps: Array.isArray(rec?.steps) ? rec.steps.length : -1 });
    return { ok: true, needsHuman: false, finalSubmitClicked: false, finalSubmitClickedByAutomation: false, reopenedForm: "", attachedDocs: 0, browserLeftOpen: false, message: "", offeredForms: [] };
  }) as never;
  const reopen = async (pid: string) => {
    db.run(`INSERT INTO submissions (id, project_id, submission_type, status, application_number, permit_type, created_at)
            VALUES (?, ?, 'permit', 'submitted', ?, 'combo', ?)`, [`sub-${pid.slice(0, 8)}`, pid, `APP-${pid.slice(0, 6)}`, new Date().toISOString()]);
    repo.createPermitCheckTarget(db, pid, { targetType: "permit", permitType: "combo", applicationNumber: `APP-${pid.slice(0, 6)}`, portalName: "Portland", checkFrequencyDays: 14 });
    const corr = repo.addManualCorrection(db, pid, "Provide the rafter span calculation for the north roof plane.");
    await repo.reopenCorrectionOnPortal(db, corr.corrections[0].id, { runner });
  };
  const residential = fx.newProject();
  await reopen(residential);
  const held = fx.newProject(WAREHOUSE as never);
  await reopen(held);
  assert.equal(db.query("SELECT 1 FROM audit_logs WHERE project_id = ? AND action = 'portal.recipe_skipped_class_hold'", [held]).length, 1, "the held job's reopen did not skip the recipe");
  assert.equal(db.query("SELECT 1 FROM audit_logs WHERE project_id = ? AND action = 'portal.recipe_skipped_class_hold'", [residential]).length, 0);
  if (seen.length === 2) {
    assert.ok(seen[0].steps > 0, `the residential reopen lost its recipe: ${JSON.stringify(seen)}`);
    assert.ok(seen[1].steps <= 0, `the held reopen replayed recipe steps: ${JSON.stringify(seen)}`);
  }
});

finish("project-class-hold");
