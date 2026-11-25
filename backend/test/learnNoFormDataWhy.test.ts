// THE STAGING GATE SAYS WHAT A SIGNER-ONLY RUN DID — NOT "FILLED FIELDS" (#131 round 2).
//
// City of Star: the learner typed only the e-signature on a page it never read, and reported
// "filled 1 page(s)". The learner's honesty fix makes filledSomething false for that run; the
// backend's staging gate then refuses it (no review screen), and its `why` must not re-make the
// false claim one layer up. Through the REAL autoLearnPortal with the browser stubbed:
//
//   (1) reachedReview false, filledSomething false -> "entered no form data and never reached the
//       portal's review screen", in the result's message AND the saved stub recipe's notes;
//   (2) reachedReview false, filledSomething true  -> "filled fields but never reached ..." (the
//       pre-existing wording for a run that did enter data).
//
// KILL TEST: in autoLearn's gate, collapse the `why` ternary to the old
//   "filled fields but never reached the portal's review screen" -> (1) fails.
//
// Run: npx tsx backend/test/learnNoFormDataWhy.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("learn-no-form-data-why");
const { db, recipes } = fx;
const autoLearn = await import("../src/autoLearn");

let nextLearn: Record<string, unknown> = {};
const baseLearn = { ok: false, portalName: "stub", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 0, pauseReason: null, message: "stub learn: nothing walked" };
autoLearn.setAutoLearnSeamsForTests({ learnPortal: (async () => ({ ...baseLearn, ...nextLearn })) as never });

const portalUrl = "https://permits.star.example/portalhome";
// The City of Star walk: a type tile, the type-signature switch, two signer boxes, the agree box.
const signerOnlySteps = [
  { action: "goto", value: portalUrl, note: "entry url" },
  { action: "click", phase: "open", selector: { text: "Solar Permit" }, note: "permit type: Solar Permit" },
  { action: "check", selector: { css: "#typeSig" }, note: "e-signature: enable type signature" },
  { action: "fill", selector: { css: "#consentName" }, field: "authorizedSignerName", note: "e-signature: signer name (consent)" },
  { action: "fill", selector: { css: "#signer" }, field: "authorizedSignerName", note: "e-signature: typed signature" },
  { action: "check", selector: { label: "I agree to the terms and conditions" } },
];
const SIGNER_ONLY_MESSAGE = "Auto-learn walked 2 page(s) and recorded 6 step(s), none of which entered form data (the e-signature, navigation and acknowledgments only); it did not reach a review screen.";

async function learnWith(extra: Record<string, unknown>) {
  const projectId = fx.newProject();
  nextLearn = {
    ok: true, portalName: "City of Star", pageCount: 2, pauseReason: null, finalSubmitRecorded: false,
    reachedReview: false, filledSomething: false, message: SIGNER_ONLY_MESSAGE, steps: signerOnlySteps,
    requiredFieldMisses: [], missingRequiredDocs: [], validationBlocks: [], pageExitReads: { read: [2], unread: [] },
    ...extra,
  };
  const result = await autoLearn.autoLearnPortal(db, projectId, { scope: "ahj", portalUrl, createdBy: "operator" });
  const recipe = result.recipe ? recipes.getPortalRecipe(db, result.recipe.id) : null;
  return { result, recipe };
}

await check("(1) a run whose only fills were the e-signature is refused as 'entered no form data', never 'filled fields'", async () => {
  const r = await learnWith({});
  assert.equal(r.result.status, "failed");
  assert.match(r.result.message, /Nothing was staged — entered no form data and never reached the portal's review screen\./, r.result.message);
  assert.doesNotMatch(r.result.message, /filled fields/i, "the gate must not re-make the claim the learner withdrew");
  assert.ok(r.recipe, "the walk is kept as a needs_rerecord stub");
  assert.equal(r.recipe?.status, "needs_rerecord");
  assert.match(String(r.recipe?.notes ?? ""), /did not stage cleanly: entered no form data and never reached the portal's review screen/i, String(r.recipe?.notes));
  assert.match(r.result.message, /none of which entered form data/, "the run's own words travel with the refusal");
});

await check("(2) a run that DID enter data but never reached review keeps the 'filled fields' wording", async () => {
  const r = await learnWith({
    filledSomething: true,
    steps: [...signerOnlySteps, { action: "fill", selector: { label: "Description of Work" }, field: "projectDescription" }],
    message: "Auto-learn walked 2 page(s) and filled 1 of 2 page(s); it did not reach a review screen.",
  });
  assert.equal(r.result.status, "failed");
  assert.match(r.result.message, /Nothing was staged — filled fields but never reached the portal's review screen\./, r.result.message);
});

finish("learn-no-form-data-why");
