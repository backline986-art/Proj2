// A PORTAL'S OWN RECORD-NUMBER FORMAT IS LEARNED FROM A NUMBER A PERSON CONFIRMED (#448).
//
// On the REAL prepareSubmission with only the browser stubbed (as submitCaptureLink.test does),
// synthetic values:
//   (a) an unsure capture holds candidates; a person confirms one through the next-step panel's door
//       (captureConfirmation) → its SHAPE ("SOL-####-######") is stored on the recipe that filed it,
//       `seeded`, and the next replay of that recipe receives it (PortalRecipe.recordNumberShapes).
//   (b) a number TYPED in the manual form (not one of the run's held candidates) teaches nothing, and
//       neither does the automatic confident read (it held no candidates).
//   (c) rule 3: an existing entry (a `verified` one) is never rewritten or dropped; the shape is only
//       ever appended, and only once.
//   (d) a recipe of ANOTHER entity (a borrowed donor) never learns this project's format, and a
//       borrowed recipe never carries its donor's shapes.
//   (e) a bare digit run or a phone-shaped number is no format.
//
// KILLS (on main 7f108f47): there is no record_number_formats_json and no learnRecordNumberFormat, so
// (a) fails (and the file does not typecheck).
// Run: npx tsx backend/test/recordNumberFormatLearn.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("record-number-format-learn");
const { db, repo, recipes } = fx;

type Capture = Parameters<NonNullable<Parameters<typeof repo.setRecipeStageRunnerForTests>[0]>>[5] extends infer O
  ? O extends { onSubmitCaptured?: infer F } ? F : never : never;

let lastReplayedShapes: string[] | undefined;
async function stageAndHoldWindow(projectId: string): Promise<NonNullable<Capture>> {
  let captured: Capture | undefined;
  fx.stubRunner(async (recipe, _project, _values, _docs, _files, opts) => {
    lastReplayedShapes = (recipe as { recordNumberShapes?: string[] }).recordNumberShapes;
    captured = opts?.onSubmitCaptured as Capture;
    return {
      portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null,
      steps: [
        { ok: true, message: "Opened stub portal." },
        { ok: true, message: "Human review required. AUTOMATION HAS STOPPED.", data: { finalSubmitClicked: false } },
      ],
    };
  });
  await repo.prepareSubmission(db, projectId);
  assert.ok(captured, "the stage handed the runner no onSubmitCaptured");
  return captured!;
}
const formatsOf = (recipeId: string) => recipes.recordNumberFormatsOf(fx.recipeRow(recipeId).record_number_formats_json);
const unsure = (n: string) => ({
  recordNumber: "", confidence: "low" as const, source: "none", reason: "Found beside a label — a person should confirm it.",
  recordLink: "", candidates: [{ recordNumber: n, recordLink: "", source: "completion_page" }],
});

const recipe = fx.completeRecipe([...fx.fills(3), fx.REVIEW, fx.FINAL]);
const recipeId = String((recipe as { id: string }).id);

await check("(a) a confirmed candidate teaches its shape to the recipe that filed it, seeded", async () => {
  const projectId = fx.newProject();
  const capture = await stageAndHoldWindow(projectId);
  assert.deepEqual(lastReplayedShapes ?? [], [], "a fresh recipe already carried shapes");
  const run = fx.latestRun(projectId)!;
  assert.equal(String(run.recipe_id), recipeId, "the run does not name the recipe it replayed");
  capture(unsure("SOL-2026-000123"));
  repo.captureConfirmation(db, String(run.id), { applicationNumber: "SOL-2026-000123", submittedBy: "confirmed from the next-step panel" });
  const formats = formatsOf(recipeId);
  assert.deepEqual(formats.map((f) => [f.shape, f.status]), [["SOL-####-######", "seeded"]], JSON.stringify(formats));
  // Shapes only, never the number.
  assert.ok(formats.every((f) => !/\d/.test(f.shape)), "a stored shape carries a digit");
  assert.doesNotMatch(String(fx.recipeRow(recipeId).record_number_formats_json), /000123/);
  assert.equal(fx.audits("portal.record_number_format_learned").filter((a) => a.project_id === projectId).length, 1);
});

await check("(a) the next replay of that recipe receives the learned shape", async () => {
  const projectId = fx.newProject();
  await stageAndHoldWindow(projectId);
  assert.deepEqual(lastReplayedShapes, ["SOL-####-######"]);
});

await check("(b) a typed number, or the automatic read, teaches nothing", async () => {
  const before = JSON.stringify(formatsOf(recipeId));
  const typed = fx.newProject();
  await stageAndHoldWindow(typed);
  repo.captureConfirmation(db, String(fx.latestRun(typed)!.id), { applicationNumber: "BLD-26-00123", submittedBy: "Operator" });
  const auto = fx.newProject();
  const capture = await stageAndHoldWindow(auto);
  capture({ recordNumber: "PC-0042199", confidence: "high", source: "account_list", reason: "Exactly one new application appeared.", recordLink: "" });
  // A confirmed number that is NOT the held candidate is typed, not read off the page.
  const other = fx.newProject();
  const cap2 = await stageAndHoldWindow(other);
  cap2(unsure("SOL-2026-000124"));
  repo.captureConfirmation(db, String(fx.latestRun(other)!.id), { applicationNumber: "XYZ-26-00999", submittedBy: "Operator" });
  assert.equal(JSON.stringify(formatsOf(recipeId)), before, "a number nobody read off the page taught a shape");
});

await check("(c) rule 3: a verified entry is never rewritten; a shape is appended once", async () => {
  const verified = [{ shape: "SOL-####-######", status: "verified", learnedAt: "2026-10-01T00:00:00Z" }];
  db.run("UPDATE portal_recipes SET record_number_formats_json = ? WHERE id = ?", [JSON.stringify(verified), recipeId]);
  const projectId = fx.newProject();
  const capture = await stageAndHoldWindow(projectId);
  capture(unsure("SOL-2026-000125"));
  repo.captureConfirmation(db, String(fx.latestRun(projectId)!.id), { applicationNumber: "SOL-2026-000125", submittedBy: "confirmed from the next-step panel" });
  assert.deepEqual(formatsOf(recipeId), verified, "the verified entry was rewritten or duplicated");
  const p2 = fx.newProject();
  const cap2 = await stageAndHoldWindow(p2);
  cap2(unsure("SR-2026-0042"));
  repo.captureConfirmation(db, String(fx.latestRun(p2)!.id), { applicationNumber: "SR-2026-0042", submittedBy: "confirmed from the next-step panel" });
  const after = formatsOf(recipeId);
  assert.deepEqual(after[0], verified[0], "the verified entry moved or changed");
  assert.deepEqual(after.slice(1).map((f) => [f.shape, f.status]), [["SR-####-####", "seeded"]]);
});

await check("(d) another entity's recipe never learns this project's format", async () => {
  const other = recipes.startPortalRecording(db, {
    scopeType: "ahj", state: "OR", ahj: "Tigard", utility: "PGE",
    portalUrl: "https://permits.portland.example/apply", portalPlatform: "accela", createdBy: "test",
  });
  const learned = recipes.learnRecordNumberFormat(db, other.id, "SOL-2026-000126", { state: "OR", ahj: "Portland", utility: "PGE" });
  assert.equal(learned, null);
  assert.deepEqual(formatsOf(other.id), []);
});

await check("(d) a borrowed recipe never carries its donor's shapes", async () => {
  // A donor recorded for one city on the shared statewide Accela portal, with a learned shape.
  const ACA = "https://aca-oregon.accela.com/oregon/";
  const steps = [
    { action: "goto", value: `${ACA}Dashboard.aspx`, note: "entry url" },
    { action: "fill", selector: { name: "f1" }, field: "streetNumber", note: "work location: street number" },
    { action: "check", selector: { label: "Residential - Structural" }, note: "record type: Residential - Structural" },
    { action: "click", selector: { text: "Continue Application »" }, note: "record type: continue" },
    { action: "stopForReview", selector: {} },
  ] as never;
  const r = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", portalUrl: ACA, discipline: "structural", portalPlatform: "accela", createdBy: "test" });
  const donor = recipes.savePortalRecipeSteps(db, r.id, steps, { status: "complete" });
  db.run("UPDATE portal_recipes SET record_number_formats_json = ? WHERE id = ?", [JSON.stringify([{ shape: "###-##-######-STR", status: "seeded", learnedAt: "" }]), donor.id]);
  assert.deepEqual(recipes.getPortalRecipe(db, donor.id)?.recordNumberShapes, ["###-##-######-STR"], "the donor's own read lost its shape");
  const d = recipes.findBorrowableRecipe(db, {
    track: "building", state: "OR", ahj: "City of Birchport", targetPortalUrl: ACA, targetSource: "statewide",
    entity: recipes.portalEntityEvidence(db, { scope: "ahj", state: "OR", name: "City of Birchport" }),
  });
  assert.equal(d.choice?.recipe.id, donor.id, `the fixture did not borrow: ${d.reason} ${JSON.stringify(d.rejected)}`);
  assert.deepEqual(d.choice?.recipe.recordNumberShapes, [], "the borrow handed the donor's learned shapes to another entity");
});

await check("(e) a bare digit run or a phone-shaped number is no format", async () => {
  const entity = { state: "OR", ahj: "Portland", utility: "PGE" };
  const before = JSON.stringify(formatsOf(recipeId));
  assert.equal(recipes.learnRecordNumberFormat(db, recipeId, "8830012", entity), null);
  assert.equal(recipes.learnRecordNumberFormat(db, recipeId, "503-555-0199", entity), null);
  assert.equal(recipes.learnRecordNumberFormat(db, recipeId, "2026-11-09", entity), null);
  assert.equal(JSON.stringify(formatsOf(recipeId)), before);
});

finish("recordNumberFormatLearn");
