// A RUN WHOSE FINAL SUBMIT WAS CLICKED IS NEVER RETRIED IN A SECOND BROWSER (Helm, #254 follow-up).
//
// The staging path retries a bot-walled headless run with a headed window. A run that clicked the
// final submit may already have filed; a second browser would start the application again. The draft
// click and a person's stop were excluded by name; the final-submit click now is too, read off the
// result and off every step's data. Drives the REAL prepareSubmission with only the browser stubbed.
//
//   (a) a bot-wall-looking failure after a final-submit click (on the result): one browser only;
//   (b) the same with the click only on a step's data: one browser only;
//   (c) GUARD: the same failure with no click IS retried (the exclusion is not a blanket off).
//
// KILL: drop `!finalClickInResult` from the retry condition → (a) (b) fail.
//   npx tsx backend/test/headedRetryAfterFinalSubmit.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

process.env.PORTAL_HEADLESS = "true";
const fx = await setupStageFixture("headed-retry-final");
const { db, repo } = fx;
const WALL = "Recipe step failed (click — Next): 403 Forbidden — Access Denied";

async function calls(shape: "result" | "step" | "none"): Promise<number> {
  fx.completeRecipe();
  const projectId = fx.newProject();
  let n = 0;
  fx.stubRunner(async () => {
    n += 1;
    const r = fx.failingStep(WALL, shape === "step" ? { finalSubmitClicked: true } : {}) as Record<string, unknown>;
    return { ...r, ...(shape === "result" ? { finalSubmitClicked: true } : {}) };
  });
  await repo.prepareSubmission(db, projectId).catch(() => undefined);
  fx.stubRunner(null);
  return n;
}

await check("(a) a final-submit click on the result: never a second browser", async () => {
  assert.equal(await calls("result"), 1);
});
await check("(b) a final-submit click on a step's data only: never a second browser", async () => {
  assert.equal(await calls("step"), 1);
});
await check("(c) GUARD: the same bot wall with no click is retried headed", async () => {
  assert.equal(await calls("none"), 2);
});

finish("headed retry after final submit");
