// A REPLAY LEARNS FROM THE PERSON WHO FINISHED IT BY HAND (runFixSteps.ts; owner 2026-11-21: "the fix
// screen was hit, I approved it, then it was still getting stuck on the same run").
//
// A recipe step fails, portal-bot keeps the window open at that step and reports the person's own
// fills and clicks (browserLeftOpenForFix + fixAnchorStepIndex, onHumanFixStep). The staging code
// holds them on the run, made safe to store; "Save my fixes" (a named person) writes them into the
// recipe AT THE STUCK STEP. Every case drives the REAL prepareSubmission with only the browser stubbed.
//
// KILL TESTS (each must turn this file red):
//   K1 repository.ts: never pass onHumanFixStep to the runner           → (a) (b) (c) fail.
//   K2 runFixSteps.prepareFixStep: drop the secret-value branch           → (a) fails (account digits stored).
//   K3 runFixSteps.applyRunFixSteps: insert at the terminal tail, not the anchor → (c) fails.
//   K4 runFixSteps.applyRunFixSteps: skip the version/signature check      → (d) fails.
//   K5 runFixSteps.applyRunFixSteps: drop the "already saved" refusal      → (c) fails.
//
// Run: npx tsx backend/test/runFixSteps.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("run-fix-steps");
const { db, repo, recipes } = fx;
const fixes = await import("../src/runFixSteps");

type FixFn = (step: RecipeStep) => void;

/** Stage once against a fresh complete recipe whose step `failAt` fails with the window left open.
 *  `during` are steps the person makes before the run returns; the returned `later` sends more. */
async function stageStuckAt(failAt: number, opts: { during?: RecipeStep[]; leftOpen?: boolean; steps?: RecipeStep[]; atEnd?: boolean } = {}) {
  const recipe = fx.completeRecipe(opts.steps);
  const projectId = fx.newProject();
  let sink: FixFn | null = null;
  let sawOption = false;
  fx.stubRunner(async (_r, _p, _v, _d, _f, options) => {
    const fn = (options as { onHumanFixStep?: FixFn }).onHumanFixStep;
    sawOption = typeof fn === "function";
    sink = fn ?? null;
    for (const s of opts.during ?? []) sink?.(s);
    const r = fx.failingStep(`Recipe step failed (fill — Field ${failAt}): locator.fill: Timeout 15000ms exceeded.`, { failedStepIndex: failAt });
    const open = opts.atEnd ? { browserLeftOpenForFix: true, fixAnchorStepIndex: null, fixAnchorAtEnd: true } : { browserLeftOpenForFix: true, fixAnchorStepIndex: failAt };
    return { ...r, ...(opts.leftOpen === false ? {} : open) };
  });
  await repo.prepareSubmission(db, projectId).catch(() => undefined);
  const run = fx.latestRun(projectId)!;
  return { recipe, projectId, runId: String(run.id), sawOption, later: (s: RecipeStep) => sink?.(s) };
}

const fixRow = (runId: string) => db.get<Record<string, unknown>>("SELECT * FROM portal_run_fix_steps WHERE run_id = ?", [runId]);
const heldSteps = (runId: string): RecipeStep[] => JSON.parse(String(fixRow(runId)?.steps_json ?? "[]"));

await check("(a) the person's steps after a failed step are held on the run, safe to store", async () => {
  const owner = "Replay Owner";
  const { runId, sawOption, later, projectId } = await stageStuckAt(1, {
    during: [{ action: "click", selector: { text: "Show more" }, note: "Show more" } as RecipeStep],
  });
  assert.ok(sawOption, "the replay must be given onHumanFixStep (an own recipe, not an approved run)");
  const homeowner = repo.getProjectDetail(db, projectId).project.homeownerName;
  assert.ok(homeowner.startsWith(owner), `setup: homeowner ${homeowner}`);
  later({ action: "fill", selector: { label: "Owner name", css: "#owner" }, value: homeowner, note: "Owner name" } as RecipeStep);
  // The account number typed into a box the page did NOT flag sensitive, with separators.
  later({ action: "fill", selector: { label: "Reference" }, value: "1234-567-890", note: "Reference" } as RecipeStep);
  later({ action: "click", selector: { text: "Submit Application" }, note: "Submit Application" } as RecipeStep);
  later({ action: "click", selector: { text: "Pay Now" }, note: "Pay Now" } as RecipeStep);
  const row = fixRow(runId);
  assert.ok(row, "a row is written for a run that left its window open for a fix");
  assert.equal(Number(row!.anchor_index), 1, "anchored at the stored index of the failed step");
  const steps = heldSteps(runId);
  assert.deepEqual(steps.map((s) => s.action), ["click", "fill", "fill"], `submit and pay clicks are never held: ${JSON.stringify(steps)}`);
  const ownerStep = steps[1];
  assert.equal(ownerStep.field, "homeownerName", "a literal equal to the job's data binds to its field");
  assert.equal(ownerStep.value, undefined, "the bound literal is not kept");
  const ref = steps[2];
  assert.equal(ref.value, undefined, "a secret value is never stored");
  assert.equal(ref.sensitive, true);
  assert.equal(ref.field, "accountNumber", "the canonical account number binds by name");
  const raw = String(row!.steps_json);
  for (const secret of ["1234567890", "1234-567-890", "987654321"]) assert.ok(!raw.includes(secret), `no secret in steps_json: ${secret}`);
});

await check("(b) the run card reads the held fixes; a run that closed its window holds none", async () => {
  const { runId, projectId, later } = await stageStuckAt(2);
  later({ action: "select", selector: { label: "Permit type" }, value: "Residential Solar", note: "Permit type" } as RecipeStep);
  const run = repo.getProjectDetail(db, projectId).portalRuns.find((r) => r.id === runId)!;
  assert.equal(run.handFixes?.count, 1);
  assert.equal(run.handFixes?.stuckStep, 3, "1-based stuck step");
  assert.equal(run.handFixes?.appliedAt, null);
  assert.match(run.handFixes!.preview[0], /select "Permit type"/);
  const closed = await stageStuckAt(2, { leftOpen: false });
  closed.later({ action: "fill", selector: { label: "X" }, value: "y" } as RecipeStep);
  assert.ok(!fixRow(closed.runId), "no window left open, nothing written");
});

await check("(c) Save my fixes writes them AT the stuck step, replacing it when the person redid that control; once only", async () => {
  const { runId, recipe, later } = await stageStuckAt(1);
  later({ action: "click", selector: { text: "Applicant tab" }, note: "Applicant tab" } as RecipeStep);
  later({ action: "fill", selector: { name: "f1" }, value: "Some literal", note: "Field 1 redone" } as RecipeStep);
  const before = fx.recipeRow(recipe.id);
  const flaggedBefore = String(before.flag_reason ?? "");
  const out = fixes.applyRunFixSteps(db, runId, { appliedBy: "Dana Operator" });
  assert.equal(out.saved, 2);
  assert.equal(out.replaced, 1, "the failed control was redone, so it is replaced");
  const saved = recipes.getPortalRecipe(db, recipe.id).steps;
  assert.deepEqual(saved.map((s) => s.note), ["Field 0", "hand-fix: Applicant tab", "hand-fix: Field 1 redone", "Field 2", "Field 3", undefined, "final submit"],
    `spliced at step 2, the terminal tail untouched: ${JSON.stringify(saved.map((s) => s.note))}`);
  assert.equal(saved[saved.length - 2].action, "stopForReview");
  assert.equal(String(fixRow(runId)!.applied_by), "Dana Operator");
  assert.equal(fx.audits("portal_recipe.hand_fixes_saved").filter((a) => JSON.parse(a.details).runId === runId).length, 1);
  if (flaggedBefore) assert.equal(String(fx.recipeRow(recipe.id).flag_reason ?? ""), "", "the flag this failure raised is cleared");
  assert.throws(() => fixes.applyRunFixSteps(db, runId, { appliedBy: "Dana Operator" }), /already saved/);
  assert.throws(() => fixes.applyRunFixSteps(db, "no-such-run", { appliedBy: "Dana" }), /holds no hand fixes/);
});

await check("(c2) a fix that is not the failed control goes in before it, and the failed step stays", async () => {
  const { runId, recipe, later } = await stageStuckAt(2);
  later({ action: "click", selector: { text: "Expand section" }, note: "Expand section" } as RecipeStep);
  const out = fixes.applyRunFixSteps(db, runId, { appliedBy: "Dana" });
  assert.equal(out.replaced, 0);
  assert.deepEqual(recipes.getPortalRecipe(db, recipe.id).steps.slice(0, 4).map((s) => s.note), ["Field 0", "Field 1", "hand-fix: Expand section", "Field 2"]);
});

await check("(d) a recipe that changed since the run read it is refused, nothing written", async () => {
  const { runId, recipe, later } = await stageStuckAt(1);
  later({ action: "click", selector: { text: "Next" }, note: "Next" } as RecipeStep);
  const edited = [...recipe.steps];
  edited[0] = { ...edited[0], selector: { name: "f0-renamed" } };
  recipes.savePortalRecipeSteps(db, recipe.id, edited, { status: "complete" });
  const sig = recipes.recipeStepsSignature(recipes.getPortalRecipe(db, recipe.id).steps);
  assert.throws(() => fixes.applyRunFixSteps(db, runId, { appliedBy: "Dana" }), /recipe changed/);
  assert.equal(recipes.recipeStepsSignature(recipes.getPortalRecipe(db, recipe.id).steps), sig, "the recipe is untouched");
  assert.equal(fixRow(runId)!.applied_at, null);
});

await check("(e) 'I finished it to review' replaces the rest up to the review stop; a nameless save is refused", async () => {
  const { runId, recipe, later } = await stageStuckAt(1);
  later({ action: "fill", selector: { label: "New box" }, value: "Fixed value", note: "New box" } as RecipeStep);
  later({ action: "click", selector: { text: "Continue" }, note: "Continue" } as RecipeStep);
  assert.throws(() => fixes.applyRunFixSteps(db, runId, { appliedBy: "  " }), /who is saving/);
  const out = fixes.applyRunFixSteps(db, runId, { appliedBy: "Dana", mode: "replace_rest" });
  assert.equal(out.replaced, 3);
  const notes = recipes.getPortalRecipe(db, recipe.id).steps.map((s) => s.note);
  assert.deepEqual(notes, ["Field 0", "hand-fix: New box", "hand-fix: Continue", undefined, "final submit"]);
});

await check("(f) a recipe this same failure demoted is trusted again by its remedy; another run's demotion stays", async () => {
  // The stub's failure ("locator.fill: Timeout … exceeded") is drift: the real demotion pass blames the
  // recipe and demotes it, naming this run.
  const { runId, recipe, later } = await stageStuckAt(1);
  later({ action: "click", selector: { text: "Next page" }, note: "Next page" } as RecipeStep);
  assert.equal(fx.recipeRow(recipe.id).status, "needs_rerecord", "setup: this run's failure demoted the recipe");
  fixes.applyRunFixSteps(db, runId, { appliedBy: "Dana" });
  assert.equal(fx.recipeRow(recipe.id).status, "complete");
  const other = await stageStuckAt(1);
  other.later({ action: "click", selector: { text: "Next page" }, note: "Next page" } as RecipeStep);
  assert.equal(fx.recipeRow(other.recipe.id).status, "needs_rerecord");
  // A LATER demotion by another run of the same recipe.
  const { addAuditLog } = await import("../src/audit");
  await new Promise((r) => setTimeout(r, 5));
  addAuditLog(db, null, "system", "recipe replay", "portal_recipe.demoted", { recipeId: other.recipe.id, runId: "some-other-run" });
  fixes.applyRunFixSteps(db, other.runId, { appliedBy: "Dana" });
  assert.equal(fx.recipeRow(other.recipe.id).status, "needs_rerecord", "a demotion this run did not cause is not undone");
});

await check("(g) a run that ran every step and stopped short of review: the fixes go after the last step, before the review stop", async () => {
  const { runId, recipe, projectId, later } = await stageStuckAt(0, { atEnd: true });
  later({ action: "click", selector: { text: "Next: Documents" }, note: "Next: Documents" } as RecipeStep);
  const run = repo.getProjectDetail(db, projectId).portalRuns.find((r) => r.id === runId)!;
  assert.equal(run.handFixes?.atEnd, true);
  assert.equal(run.handFixes?.stuckStep, 0);
  const out = fixes.applyRunFixSteps(db, runId, { appliedBy: "Dana", mode: "replace_rest" });
  assert.equal(out.replaced, 0, "nothing to replace after the last step");
  assert.deepEqual(recipes.getPortalRecipe(db, recipe.id).steps.map((s) => s.note), ["Field 0", "Field 1", "Field 2", "Field 3", "hand-fix: Next: Documents", undefined, "final submit"]);
});

await check("(h) a hand upload names its document from the slot's label; one it cannot name is called out at save", async () => {
  const { runId, later } = await stageStuckAt(1);
  later({ action: "upload", selector: { label: "Site Plan" }, docType: "", note: "Site Plan — UPLOAD, set docType in the dashboard" } as RecipeStep);
  later({ action: "upload", selector: { css: "#file3" }, docType: "", note: "Browse.. — UPLOAD, set docType in the dashboard" } as RecipeStep);
  const held = heldSteps(runId);
  assert.deepEqual(held.map((s) => s.docType), ["site_plan", ""]);
  const out = fixes.applyRunFixSteps(db, runId, { appliedBy: "Dana" });
  assert.match(out.message, /^1 of your upload\(s\) did not say which document/);
});

await check("(i) a submit clicked in the fix window is recorded (row, audit, run card), never stored as a step; none clicked, none recorded", async () => {
  const SIGNAL = { action: "click", selector: {}, optional: true, note: "__human_submit_observed__", value: "Submit Application" } as RecipeStep;
  // Sighted after the run returned.
  const a = await stageStuckAt(1);
  a.later({ action: "click", selector: { text: "Next" }, note: "Next" } as RecipeStep);
  a.later(SIGNAL);
  const rowA = fixRow(a.runId)!;
  assert.ok(rowA.submit_sighted_at, "the sighting is on the run row");
  assert.equal(rowA.submit_label, "Submit Application");
  assert.deepEqual(heldSteps(a.runId).map((st) => st.note), ["hand-fix: Next"], "the signal is never a step");
  assert.equal(fx.audits("portal.fix_window_submit_sighted").filter((x) => JSON.parse(x.details).runId === a.runId).length, 1);
  const card = repo.getProjectDetail(db, a.projectId).portalRuns.find((r) => r.id === a.runId)!;
  assert.ok(card.handFixes?.submitSightedAt);
  // Sighted while the run was still returning (before the anchor): recorded once the row exists.
  const b = await stageStuckAt(1, { during: [SIGNAL] });
  assert.ok(fixRow(b.runId)!.submit_sighted_at, "an early sighting is recorded at the anchor");
  // None clicked.
  const c = await stageStuckAt(1);
  c.later({ action: "click", selector: { text: "Next" }, note: "Next" } as RecipeStep);
  assert.equal(fixRow(c.runId)!.submit_sighted_at, null);
  assert.equal(repo.getProjectDetail(db, c.projectId).portalRuns.find((r) => r.id === c.runId)!.handFixes?.submitSightedAt, null);
});

const refusals = (recipeId: string) => repo.automaticSubmitRefusals(db, { recipeId, runApproval: null, runId: "r-x", filingDoor: null })
  .filter((r) => /hand fixes/.test(r));

await check("(j) saved hand fixes refuse an automatic filing until a later replay reaches review cleanly; a failed replay proves nothing", async () => {
  const { runId, recipe, later } = await stageStuckAt(1);
  later({ action: "click", selector: { text: "Open section" }, note: "Open section" } as RecipeStep);
  fixes.applyRunFixSteps(db, runId, { appliedBy: "Dana" });
  assert.equal(fx.recipeRow(recipe.id).status, "complete", "setup: the save restored complete");
  assert.equal(refusals(recipe.id).length, 1, "the first replay after a save may not file");
  // A later replay that FAILS proves nothing.
  const p1 = fx.newProject();
  fx.stubRunner(async () => fx.failingStep("Recipe step failed (click — Open section): element is not visible"));
  await repo.prepareSubmission(db, p1).catch(() => undefined);
  assert.equal(refusals(recipe.id).length, 1, "a failed replay is no proof");
  // Re-trust the recipe the failure demoted, as a person would after looking (keeps the save unproven).
  db.run("UPDATE portal_recipes SET status = 'complete' WHERE id = ?", [recipe.id]);
  const p2 = fx.newProject();
  fx.stubRunner(async () => ({ portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null, browserLeftOpen: false,
    steps: [{ ok: true, message: "Opened stub portal." }, { ok: true, message: "Filled." }, { ok: true, message: "Staged at the review screen. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } }] }));
  await repo.prepareSubmission(db, p2).catch(() => undefined);
  assert.equal(String(fx.latestRun(p2)!.status), "awaiting_human_submit", "setup: the replay reached review");
  assert.deepEqual(refusals(recipe.id), [], "a clean review-reaching replay proves the fixes");
  assert.ok(fx.audits("portal_recipe.hand_fixes_proven").some((x) => JSON.parse(x.details).recipeId === recipe.id));
});

await check("(j2) a recipe that stayed complete at the save (keep-and-flag) is refused the same way", async () => {
  const { runId, recipe, later } = await stageStuckAt(1);
  later({ action: "click", selector: { text: "Tab two" }, note: "Tab two" } as RecipeStep);
  db.run("UPDATE portal_recipes SET status = 'complete' WHERE id = ?", [recipe.id]);
  fixes.applyRunFixSteps(db, runId, { appliedBy: "Dana" });
  assert.equal(refusals(recipe.id).length, 1);
});

await check("(k) replace_rest keeps the other path's choice right before this path's counterpart among the fixes", async () => {
  const steps = [...fx.fills(2),
    { action: "check", selector: { label: "Engineered review" }, note: "Engineered review", whenPermitPath: "engineered" } as RecipeStep,
    ...fx.fills(4).slice(2), fx.REVIEW, fx.FINAL];
  const { runId, recipe, later } = await stageStuckAt(1, { steps });
  later({ action: "click", selector: { text: "Applicant" }, note: "Applicant" } as RecipeStep);
  later({ action: "check", selector: { label: "Prescriptive (no plan review)" }, note: "Prescriptive (no plan review)" } as RecipeStep);
  later({ action: "click", selector: { text: "Next page" }, note: "Next page" } as RecipeStep);
  fixes.applyRunFixSteps(db, runId, { appliedBy: "Dana", mode: "replace_rest" });
  assert.deepEqual(recipes.getPortalRecipe(db, recipe.id).steps.map((st) => st.note),
    ["Field 0", "hand-fix: Applicant", "Engineered review", "hand-fix: Prescriptive (no plan review)", "hand-fix: Next page", undefined, "final submit"]);
});

await check("(l) the demotion read is the latest row whose PARSED recipeId is this recipe, never one that only mentions it", async () => {
  const { runId, recipe, later } = await stageStuckAt(1);
  later({ action: "click", selector: { text: "Section B" }, note: "Section B" } as RecipeStep);
  assert.equal(fx.recipeRow(recipe.id).status, "needs_rerecord", "setup: this run demoted it");
  const { addAuditLog } = await import("../src/audit");
  await new Promise((r) => setTimeout(r, 5));
  addAuditLog(db, null, "system", "recipe replay", "portal_recipe.demoted", { recipeId: "another-recipe", note: `see ${recipe.id}`, runId: "some-other-run" });
  fixes.applyRunFixSteps(db, runId, { appliedBy: "Dana" });
  assert.equal(fx.recipeRow(recipe.id).status, "complete");
});

finish("run fix steps");
