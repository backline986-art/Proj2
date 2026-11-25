// A RECORDED CHOICE THAT NAMES A PERMIT PATH REPLAYS ONLY ON JOBS OF THAT PATH (owner 2026-11-21: "how do
// we differenciate if its a prescriptive non prescirptive ... with the manual recordings?").
//
// A recipe is per portal and permit type, not per path. A person recording on a prescriptive job saved
// "Prescriptive" as a fixed answer, and every engineered job replayed it. Pins:
//   (a) namesPermitPath: path-naming choices only (select / check / click), never a fill, an upload or
//       the final submit, never a choice that names no path;
//   (b) stampPermitPathSteps stamps only those, with the job's path; an unsettled path stamps nothing;
//       a step already stamped keeps its stamp;
//   (c) bindRecipeForReplay R14: a step stamped for the other path is left out (and reported); the
//       job's own path and unstamped steps replay; an unknown path leaves everything in;
//   (d) the REAL prepareSubmission passes the job's path: a prescriptive job's replay never receives a
//       step stamped engineered, and does receive one stamped prescriptive;
//   (e) a hand fix that picks a path is stamped with the run's job path.
//
// KILLS: K1 recipeReplayBinding R14 removed → (c) (d) fail. K2 repository.ts: no permitPath passed to
// the binding → (d) fails. K3 runFixSteps.prepareFixStep: no stampPermitPathSteps → (e) fails.
//   npx tsx backend/test/permitPathSteps.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { namesPermitPath, stampPermitPathSteps } from "../../shared/src/permitPathSteps";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("permit-path-steps");
const { db, repo } = fx;
const { bindRecipeForReplay } = await import("../src/recipeReplayBinding");
const { resolvePermitPath } = await import("../src/permitPath");
const fixes = await import("../src/runFixSteps");

const S = (o: Partial<RecipeStep>): RecipeStep => ({ action: "click", selector: {}, ...o } as RecipeStep);
const prescriptivePick = S({ action: "check", selector: { label: "Prescriptive (no plan review)" }, note: "Prescriptive (no plan review)" });
const engineeredPick = S({ action: "select", selector: { label: "Review type" }, value: "Engineered - structural review", note: "Review type" });
const nonPrescriptive = S({ action: "click", selector: { role: "radio", name: "Non-prescriptive" } });
const plainNext = S({ action: "click", selector: { role: "button", name: "Next" }, note: "Next" });
const typedNotes = S({ action: "fill", selector: { label: "Prescriptive notes" }, value: "x" });
const upload = S({ action: "upload", selector: { label: "Structural engineering letter" }, docType: "structural_letter" });
const finalSubmit = S({ action: "click", selector: { text: "Submit prescriptive application" }, isFinalSubmit: true });

await check("(a) only a choice that names a permit path counts", () => {
  assert.equal(namesPermitPath(prescriptivePick), true);
  assert.equal(namesPermitPath(engineeredPick), true);
  assert.equal(namesPermitPath(nonPrescriptive), true);
  assert.equal(namesPermitPath(plainNext), false);
  assert.equal(namesPermitPath(typedNotes), false, "typing binds to data; never stamped");
  assert.equal(namesPermitPath(upload), false, "which document goes in a slot is the document gate's call");
  assert.equal(namesPermitPath(finalSubmit), false);
});

await check("(b) the stamp is the job's path, only on those steps; an unsettled path stamps nothing", () => {
  const out = stampPermitPathSteps([prescriptivePick, plainNext, typedNotes, { ...engineeredPick, whenPermitPath: "engineered" }], "prescriptive");
  assert.deepEqual(out.map((s) => s.whenPermitPath), ["prescriptive", undefined, undefined, "engineered"]);
  assert.deepEqual(stampPermitPathSteps([prescriptivePick], "unknown").map((s) => s.whenPermitPath), [undefined]);
});

const bind = (steps: RecipeStep[], permitPath: string | null) => bindRecipeForReplay({
  steps, project: { state: "OR", ahj: "Portland" }, fieldValues: {}, track: "building", borrowed: null, agency: null, permitPath,
});

await check("(c) R14: the other path's choice is left out and reported; the job's own and unstamped steps replay", () => {
  const steps = [
    { ...prescriptivePick, whenPermitPath: "prescriptive" as const },
    { ...engineeredPick, whenPermitPath: "engineered" as const },
    plainNext,
  ];
  const eng = bind(steps, "engineered");
  assert.deepEqual(eng.steps.map((s) => s.note), ["Review type", "Next"]);
  assert.deepEqual(eng.originalIndex, [1, 2], "heals and fixes map back past the left-out step");
  assert.ok(eng.changes.some((c) => c.index === 0 && c.kind === "stripped" && /prescriptive job/.test(c.reason)), JSON.stringify(eng.changes));
  assert.deepEqual(bind(steps, "prescriptive").steps.map((s) => s.note), ["Prescriptive (no plan review)", "Next"]);
  assert.equal(bind(steps, "unknown").steps.length, 3, "an unsettled path leaves every step in");
  assert.equal(bind(steps, null).steps.length, 3);
});

await check("(d) the real stage passes the job's path to the binding", async () => {
  const recipe = fx.completeRecipe([
    ...fx.fills(2),
    { ...prescriptivePick, whenPermitPath: "prescriptive" },
    { ...engineeredPick, whenPermitPath: "engineered" },
    fx.REVIEW, fx.FINAL,
  ]);
  const projectId = fx.newProject();
  assert.equal(resolvePermitPath(repo.getProjectDetail(db, projectId).project).path, "prescriptive", "setup: the fixture job is prescriptive");
  let seen: RecipeStep[] = [];
  fx.stubRunner(async (r) => { seen = r.steps; return fx.failingStep("stub stop"); });
  await repo.prepareSubmission(db, projectId).catch(() => undefined);
  assert.ok(seen.length, `setup: the replay ran (recipe ${recipe.id})`);
  assert.ok(seen.some((s) => s.note === "Prescriptive (no plan review)"), "the job's own path is replayed");
  assert.ok(!seen.some((s) => s.note === "Review type"), "the engineered choice never reaches a prescriptive job's replay");
});

await check("(e) a hand fix that picks a path is stamped with the run's job path", () => {
  const out = fixes.prepareFixStep(db, S({ action: "click", selector: { role: "radio", name: "Prescriptive path" }, note: "Prescriptive path" }),
    { fields: {}, secretValues: [], permitPath: "prescriptive" });
  assert.equal(out[0]?.whenPermitPath, "prescriptive");
  const plain = fixes.prepareFixStep(db, plainNext, { fields: {}, secretValues: [], permitPath: "prescriptive" });
  assert.equal(plain[0]?.whenPermitPath, undefined);
});

finish("permit path steps");
