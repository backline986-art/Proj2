// A HAND RECORDING REPLAYS ON THE PERMIT IT WAS RECORDED FOR (owner 2026-11-20: "I submitted two hand
// recorded recipes that didn't work").
//
// The recorder sent no discipline, so an AHJ recording was saved under discipline "" — and a building or
// electrical stage asks findCompleteRecipeForProject for ITS discipline first, so an older auto-learned
// row of that discipline kept replaying and the recording never ran. Pins:
//   (a) MUST-EXCLUDE, the old shape: a "" recording loses to a complete learned electrical row;
//   (b) a recording keyed by recordingDisciplineOf (--discipline / the track) RE-RECORDS that row (the
//       learned steps parked as the snapshot) and is what the electrical stage replays once saved;
//   (c) recordingDisciplineOf: explicit wins, else the track, unknown is "".
//
// KILL: recordingDisciplineOf returns "" always → (b)(c) fail.
//   npx tsx backend/test/handRecordingDiscipline.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeStep } from "../../shared/src/types";

process.env.AUTOPILOT_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hand-rec-")), "t.sqlite");
const { openDatabase } = await import("../src/db");
const recipes = await import("../src/portalRecipes");
const { recordingDisciplineOf } = await import("../src/portalChannel");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); } catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};
const AHJ = { scopeType: "ahj" as const, state: "OR", ahj: "City of Alderwick" };
const learnedSteps: RecipeStep[] = [{ action: "click", selector: { role: "button", name: "Learned start" } } as RecipeStep, { action: "stopForReview" } as RecipeStep];
const handSteps: RecipeStep[] = [{ action: "click", selector: { role: "button", name: "Hand start" } } as RecipeStep, { action: "stopForReview" } as RecipeStep];
const firstName = (r: { steps: RecipeStep[] } | null): string => String((r?.steps?.[0]?.selector as { name?: string } | undefined)?.name ?? "");

const learned = recipes.startPortalRecording(db, { ...AHJ, discipline: "electrical", createdBy: "auto-learn" });
recipes.savePortalRecipeSteps(db, learned.id, learnedSteps, { status: "complete" });

check("(a) MUST-EXCLUDE: a recording saved with no discipline loses to the learned electrical row at an electrical stage", () => {
  const blank = recipes.startPortalRecording(db, { ...AHJ, createdBy: "Seamus" });
  recipes.savePortalRecipeSteps(db, blank.id, handSteps, { status: "complete" });
  assert.notEqual(blank.id, learned.id);
  assert.equal(firstName(recipes.findCompleteRecipeForProject(db, { ...AHJ, discipline: "electrical" })), "Learned start");
  recipes.deletePortalRecipe(db, blank.id);
});

check("(b) a recording keyed to the electrical permit re-records that row and is what the electrical stage replays", () => {
  const rec = recipes.startPortalRecording(db, { ...AHJ, createdBy: "Seamus", discipline: recordingDisciplineOf({ discipline: "electrical" }) });
  assert.equal(rec.id, learned.id, "the recording did not take the electrical row");
  recipes.savePortalRecipeSteps(db, rec.id, handSteps, { status: "complete" });
  assert.equal(firstName(recipes.findCompleteRecipeForProject(db, { ...AHJ, discipline: "electrical" })), "Hand start");
});

check("(c) recordingDisciplineOf: explicit wins, else the track, unknown is empty", () => {
  assert.equal(recordingDisciplineOf({ discipline: "Electrical" }), "electrical");
  assert.equal(recordingDisciplineOf({ discipline: "structural", track: "electrical" }), "structural");
  assert.equal(recordingDisciplineOf({ track: "building" }), "structural");
  assert.equal(recordingDisciplineOf({ track: "mpu" }), "electrical");
  assert.equal(recordingDisciplineOf({ track: "combo" }), "combo");
  assert.equal(recordingDisciplineOf({ discipline: "plumbing" }), "");
  assert.equal(recordingDisciplineOf({}), "");
});

if (failures) { console.error(`\n${failures} hand-recording check(s) FAILED.`); process.exit(1); }
console.log("\nAll hand-recording discipline checks passed.");
process.exit(0);
