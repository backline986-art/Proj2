// WHICH STEPS A REPLAY MAY SKIP AS LEARN STATE, AND WHICH IT NEVER DOES (#237).
//
// The DOM smoke (learnStateSteps.dom.smoke.ts) drives the four live shapes end to end. This pins
// the one decision underneath them, learnStateSkippable + learnStateSkipKind, in both directions:
// what is skipped when its control does not show, and the list that never is — an advance off the
// review page, a link or recorded navigation, the final submit, a submit/pay-worded click, an upload
// commit, an opener, a compute, a consent/attestation, who is filing. A skip there would aim the
// steps after it at the wrong page or leave a filing without its attestation, so each keeps today's
// behaviour (it runs, and fails named).
//
//   npx tsx portal-bot/src/adapters/learnStateSteps.test.ts
import assert from "node:assert/strict";
import type { RecipeStep } from "../../../shared/src/types";
import { bareTestHook, identifyingLevels, inRecipeReviewTail, isCommitWordedClick, isDialogDismissalClick, learnStateNeverSkipped, learnStateSkipKind, learnStateSkippable } from "./recipeAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const click = (note: string, selector: RecipeStep["selector"] = {}, extra: Partial<RecipeStep> = {}): RecipeStep => ({ action: "click", note, selector, ...extra } as RecipeStep);
const OFF = { onReviewPage: false, inReviewTail: false };
const REVIEW = { onReviewPage: true, inReviewTail: false };
const TAIL = { onReviewPage: false, inReviewTail: true };
const kind = (s: RecipeStep, seen: "shown" | "hidden" | "absent", page = OFF) => learnStateSkipKind(learnStateSkippable(s), seen, page);

// ---- MUST-PASS: the four live shapes ---------------------------------------------------------
const pager = click("human-patch: Next page", { css: "#HeaderNextBtn", fallbacks: [{ role: "button", name: "Next page" }] });
check("PGE 68-72: a hand-patched Next page hidden on the review page is skipped (review_patch)", () => {
  assert.equal(kind(pager, "hidden", REVIEW), "review_patch");
  assert.equal(kind(pager, "absent", REVIEW), "review_patch");
  assert.equal(kind(pager, "hidden", TAIL), "review_patch");
  // b16d667e 68-72 as recorded: role/name only (getByRole leaves the invisible button out: ABSENT).
  assert.equal(kind(click("human-patch: Next page", { role: "button", name: "Next page" }), "absent", TAIL), "review_patch");
});
check("Bend 22: the learn's popup OK, absent or hidden, is skipped as a dialog dismissal", () => {
  const ok = click("human-patch: OK", { role: "button", name: "OK" });
  assert.equal(isDialogDismissalClick(ok), true);
  assert.equal(kind(ok, "absent"), "dialog");
  assert.equal(kind(ok, "hidden"), "dialog");
  // 8bbd9a74 22 as recorded: "advance: OK", exact, with the popup's id as a fallback.
  assert.equal(kind(click("advance: OK", { role: "button", name: "OK", exact: true, fallbacks: [{ css: "#uploadErrorPopupOk" }] }), "hidden"), "dialog");
  for (const w of ["Close", "Dismiss", "Got it", "Cancel", "×", "Okay"]) assert.equal(isDialogDismissalClick(click(`human-patch: ${w}`)), true, w);
  assert.equal(isDialogDismissalClick(click("human-patch", { css: "div.modal button.btn-close" })), true, "icon-only close by class");
});
check("PacifiCorp 102 / Ameren 25: a conditional write, absent or hidden, is skipped", () => {
  const c = { action: "select", note: "Battery Inverter Manufacturer", conditional: true, selector: { label: "Manufacturer" } } as RecipeStep;
  assert.equal(kind(c, "absent"), "conditional");
  assert.equal(kind(c, "hidden"), "conditional");
});
check("a non-advancing click whose only matches are hidden is skipped (non_advancing)", () => {
  assert.equal(kind(click("human-patch: Show Details", { css: "#more" }), "hidden"), "non_advancing");
  assert.equal(kind(click("toggle: Expand all", { role: "button", name: "Expand all" }), "hidden"), "non_advancing");
});

// ---- MUST-EXCLUDE: shown is always acted on; the never-skip list ---------------------------------
check("a control that SHOWS is never skipped, whatever its kind", () => {
  for (const s of [pager, click("human-patch: OK"), click("human-patch: Show Details")]) assert.equal(kind(s, "shown", REVIEW), null);
  assert.equal(kind({ action: "fill", note: "County", conditional: true, selector: { label: "County" } } as RecipeStep, "shown"), null);
});
check("an ADVANCE off the review page is never skipped (hidden or absent)", () => {
  assert.equal(kind(pager, "hidden", OFF), null, "hand-patched Next page off review");
  assert.equal(kind(click("advance: Continue", { role: "button", name: "Continue" }), "hidden", OFF), null);
  assert.equal(kind(click("advance: Save and Continue", { role: "button", name: "Save and Continue" }), "hidden", REVIEW), null, "a recorder advance is not a hand patch");
});
check("an ABSENT non-advancing click is not this rule's (it is #232's bounded failure, and may be the rescue's)", () => {
  assert.equal(kind(click("human-patch: Show Details", { css: "#more" }), "absent", OFF), null);
});
check("a link or a recorded navigation is never a non-advancing click (a closed menu may hold it)", () => {
  assert.equal(kind(click("human-patch: Building Permits", { role: "link", name: "Building Permits" }), "hidden", OFF), null);
  assert.equal(kind(click("human-patch: Apply", { css: "nav a.apply-link" }), "hidden", OFF), null);
  assert.equal(kind(click("application entry: Apply", { role: "button", name: "Apply" }), "hidden", OFF), null);
  assert.equal(kind(click("choice tile: Solar PV", { css: "[data-al-tile='3']" }), "hidden", OFF), null);
});
check("the final submit, a submit- or pay-worded click and a signature request are never skipped", () => {
  assert.ok(learnStateNeverSkipped(click("final submit: Submit", { css: "#go" }, { isFinalSubmit: true })));
  for (const n of ["human-patch: Submit Application", "human-patch: Pay Fees", "human-patch: Request Signatures", "human-patch: Finish"]) {
    assert.ok(learnStateNeverSkipped(click(n)), n);
    assert.equal(kind(click(n), "hidden", REVIEW), null, n);
  }
});
check("an upload commit (save / upload / attach / commit) and an upload are never skipped", () => {
  for (const n of ["attachment: Save", "human-patch: Upload", "human-patch: Attach file", "human-patch: Save"]) {
    assert.equal(isCommitWordedClick(click(n)), true, n);
    assert.equal(kind(click(n), "hidden", REVIEW), null, n);
  }
  assert.ok(learnStateNeverSkipped({ action: "upload", docType: "sld", conditional: true, selector: { css: "input[type=file]" } } as RecipeStep));
});
check("an opener or a compute is never skipped (the steps after it fill what it makes)", () => {
  for (const n of ["human-patch: Add New", "human-patch: Add Array", "compute totals: Calculate"]) assert.equal(kind(click(n), "hidden", REVIEW), null, n);
});
check("a consent / attestation / signature is never skipped, not even when conditional", () => {
  assert.equal(kind(click("human-patch: I agree to the terms and conditions"), "hidden", REVIEW), null);
  assert.equal(kind({ action: "check", note: "I certify the above is true", conditional: true, selector: { label: "I certify the above is true" } } as RecipeStep, "absent"), null);
  assert.equal(kind({ action: "check", note: "Company is licensed", conditional: true, companyFactOf: "abc", selector: { label: "Licensed" } } as RecipeStep, "absent"), null);
  assert.equal(kind({ action: "fill", note: "Signature", field: "authorizedSignerName", conditional: true, selector: { label: "Signature" } } as RecipeStep, "absent"), null);
});
check("a learn session's record number is never skipped (it is re-anchored to this run's record)", () => {
  const rn = click("human-patch: 999-26-000001-STR", { role: "link", name: "999-26-000001-STR" });
  assert.ok(learnStateNeverSkipped(rn));
  assert.equal(kind(rn, "absent", TAIL), null);
  assert.equal(kind(rn, "absent", REVIEW), null);
});
check("who is filing is never skipped, not even when conditional", () => {
  assert.equal(kind({ action: "select", note: "Installer Company", field: "installerCompanyName", conditional: true, selector: { label: "Installer Company" } } as RecipeStep, "absent"), null);
});
check("an unflagged ordinary write is never skipped (conditional is what licenses it)", () => {
  assert.equal(kind({ action: "select", note: "County", selector: { label: "County" } } as RecipeStep, "absent"), null);
  assert.equal(kind({ action: "fill", note: "County", optional: true, selector: { label: "County" } } as RecipeStep, "absent"), null);
});
check("a dismissal is the WHOLE label: Book an Inspection, Lookup and Accept are not one", () => {
  for (const n of ["human-patch: Book an Inspection", "human-patch: Lookup", "human-patch: Accept", "human-patch: OK to proceed"]) assert.equal(isDialogDismissalClick(click(n)), false, n);
});

// ---- the levels a probe judges ------------------------------------------------------------------
check("PacifiCorp 111's shape: the bare generic hook is passed over, the label and the id are judged", () => {
  const sel = { label: "Battery Inverter Manufacturer", fallbacks: [{ css: "#A1B2C3D4E5F6Input" }, { css: "[data-test-role=\"textbox-element\"]" }] };
  assert.deepEqual(identifyingLevels(sel).map((l) => l.label ?? l.css), ["Battery Inverter Manufacturer", "#A1B2C3D4E5F6Input"]);
  for (const css of ["[data-test-role=\"dropdownlist-element\"]", "[data-testid='text-field']", "[data-test=input]", "[data-cy=\"box\"]", "[data-qa=\"field\"]"]) {
    assert.notEqual(bareTestHook({ css }), null, css);
    assert.equal(identifyingLevels({ label: "Model", fallbacks: [{ css }] }).length, 1, css);
  }
});
check("a hook-only step is judged on its hook (all the learner had); a hook inside a richer css is not bare", () => {
  const only = { css: "[data-test-role=\"inverter-model-select\"]" };
  assert.deepEqual(identifyingLevels(only).map((l) => l.css), [only.css]);
  assert.equal(bareTestHook({ css: "[data-test-role=\"pv-array\"] input" }), null);
  assert.equal(bareTestHook({ css: "#pcInputBase14" }), null);
  // A level that locates by its label never locates by the css riding along with it.
  assert.equal(identifyingLevels({ css: "#x", fallbacks: [{ label: "County", css: "[data-test-role=\"textbox-element\"]" }] }).length, 2);
});
check("the PV-array row hook reads the same shape (rowScopedStep keeps data-test-role only, as before)", () => {
  assert.deepEqual(bareTestHook({ css: "[data-test-role=\"pv-array-qty\"]" }), { attr: "data-test-role", value: "pv-array-qty" });
  assert.deepEqual(bareTestHook({ css: "[data-testid=\"qty\"]" }), { attr: "data-testid", value: "qty" });
});

// ---- the review tail ---------------------------------------------------------------------------
check("the review tail: only clicks between the step and a recorded review stop / final submit", () => {
  const s = (action: string, extra: Partial<RecipeStep> = {}): RecipeStep => ({ action, ...extra } as RecipeStep);
  const steps = [s("fill"), s("click"), s("click"), s("stopForReview"), s("click", { isFinalSubmit: true })];
  assert.equal(inRecipeReviewTail(steps, 1), true);
  assert.equal(inRecipeReviewTail(steps, 2), true);
  assert.equal(inRecipeReviewTail([s("click"), s("fill"), s("stopForReview")], 0), false, "a write follows");
  assert.equal(inRecipeReviewTail([s("click"), s("goto"), s("stopForReview")], 0), false, "a goto follows");
  assert.equal(inRecipeReviewTail([s("click"), s("click")], 0), false, "a recipe that simply ends is not a review");
  assert.equal(inRecipeReviewTail([s("click")], 0), false, "a one-click recipe is not a review");
  assert.equal(inRecipeReviewTail([s("click"), s("click", { isFinalSubmit: true })], 0), true, "the final submit");
});

if (failures) { console.error(`\n${failures} learn-state predicate check(s) FAILED.`); process.exit(1); }
console.log("\nAll learn-state predicate checks passed.");
