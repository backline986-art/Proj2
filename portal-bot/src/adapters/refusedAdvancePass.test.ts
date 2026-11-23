// ONE CLEAN PASS OF A PAGE WHOSE ADVANCE THE PORTAL REFUSED — the pure half.
//
// The learner marks an advance it SAW come back to its own form under the portal's notice
// (refusedAdvancePass.dom.smoke.ts drives that, in Chromium). withoutRefusedAdvancePasses
// (shared/src/recipeSequence.ts) then makes the recording one pass of that page: the writes the redo
// repeated and the refused advance are dropped, everything else is kept in order. This file feeds it
// recorded sequences directly, and asks the backend's own sequence check (recipeSequenceProblems,
// the same module) what it makes of the result.
//
// MUST-PASS   the reported shape (select, fill, refused advance, select, fill, advance) -> one pass,
//             and the sequence check — which objected before — finds nothing; a write the redo did
//             not repeat is kept; two refusals in a row -> the last pass; a redo that changes the
//             value keeps the later value.
// MUST-EXCLUDE an advance nobody marked (two pages that share a form and a label) -> untouched; a
//             marked advance whose redo repeated no write -> untouched; a control written twice with
//             NO advance between -> untouched; another page's writes to the same ids -> untouched; a
//             click that may have replaced the form before the redo's first write -> untouched; a
//             dialog's own writes -> untouched; two controls sharing a per-render id (their names
//             disagree) -> untouched; an index that is not an advance, the review stop and the final
//             submit -> never dropped, never crossed.
//
// Synthetic steps and names. Run: npx tsx portal-bot/src/adapters/refusedAdvancePass.test.ts
import assert from "node:assert/strict";
import type { RecipeStep } from "../../../shared/src/types";
import { recipeSequenceProblems, withoutRefusedAdvancePasses } from "../../../shared/src/recipeSequence";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${e instanceof Error ? e.message : String(e)}`); }
};

// ---- step builders (the recorder's own shapes) --------------------------------------------------
const S = (s: Record<string, unknown>): RecipeStep => s as unknown as RecipeStep;
const GOTO = S({ action: "goto", phase: "open", value: "https://permits.example.test/apply", note: "entry url" });
const fill = (id: string, value: string, label: string, extra: Record<string, unknown> = {}) =>
  S({ action: "fill", phase: "fill", selector: { label }, value, note: label, fingerprint: { id }, ...extra });
const bound = (id: string, field: string, label: string) =>
  S({ action: "fill", phase: "fill", selector: { label }, field, note: label, fingerprint: { id } });
const select = (id: string, value: string, label: string) =>
  S({ action: "select", phase: "fill", selector: { label }, value, note: label, fingerprint: { id } });
const advance = (name = "Next Step") => S({ action: "click", phase: "fill", selector: { role: "button", name }, note: `advance: ${name}` });
const click = (name: string, note = name) => S({ action: "click", phase: "fill", selector: { role: "button", name }, note });
const REVIEW = S({ action: "stopForReview", phase: "review", note: "review" });
const FINAL = S({ action: "click", phase: "review", selector: { role: "button", name: "Submit Application" }, isFinalSubmit: true, note: "final submit: Submit Application (recorded, NOT clicked)" });

const KNOWN = { owedDocuments: [] as string[] };
const refusing = (steps: RecipeStep[]) => recipeSequenceProblems(steps, KNOWN).filter((p) => p.refusesPromotion);
/** The kept steps as the ORIGINAL objects, so "kept, in order" is asked by identity. */
const same = (got: RecipeStep[], want: RecipeStep[]): void => {
  assert.equal(got.length, want.length, `kept ${got.length} step(s), wanted ${want.length}`);
  got.forEach((g, i) => assert.ok(g === want[i], `position ${i + 1} holds another step (${g.action} ${String(g.note)})`));
};

// ---- the reported shape -------------------------------------------------------------------------
{
  const name = fill("projName", "Sample Project", "Project Name");
  const adv0 = advance();
  const kind1 = select("placeKind", "Street Address", "Kind of Place to Search For");
  const query1 = bound("placeQuery", "street", "Search for place");
  const refused = advance();
  const kind2 = select("placeKind", "Street Address", "Kind of Place to Search For");
  const query2 = fill("placeQuery", "100 Test St", "Search for place");
  const worked = advance();
  const steps = [GOTO, name, adv0, kind1, query1, refused, kind2, query2, worked, REVIEW, FINAL];

  check("precondition: the sequence check objects to the recording as it was kept (the refused advance)", () => {
    assert.ok(refusing(steps).some((p) => p.kind === "refused_advance" && p.steps[0] === steps.indexOf(refused)), JSON.stringify(refusing(steps)));
  });
  const out = withoutRefusedAdvancePasses(steps, [steps.indexOf(refused)]);
  check("MUST-PASS: the superseded writes and the refused advance are dropped; the redo and the working advance stay, in order", () => {
    same(out.steps, [GOTO, name, adv0, kind2, query2, worked, REVIEW, FINAL]);
    assert.deepEqual(out.dropped, [3, 4, 5]);
  });
  check("MUST-PASS: the sequence check finds nothing to object to in the result", () => {
    assert.deepEqual(refusing(out.steps).map((p) => p.detail), []);
  });
  check("MUST-EXCLUDE: the same steps with NO advance marked are returned as they were (the steps alone never decide)", () => {
    const untouched = withoutRefusedAdvancePasses(steps, []);
    same(untouched.steps, steps);
    assert.deepEqual(untouched.dropped, []);
  });
  check("MUST-EXCLUDE: the input array is never changed", () => {
    assert.equal(steps.length, 11);
    assert.ok(steps[5] === refused);
  });
  check("MUST-EXCLUDE: an index that is a write, the review stop, the final submit or out of range marks nothing", () => {
    const out2 = withoutRefusedAdvancePasses(steps, [steps.indexOf(kind1), steps.indexOf(REVIEW), steps.indexOf(FINAL), -1, 99, 1.5]);
    same(out2.steps, steps);
  });
}

// ---- a write the redo did not repeat ------------------------------------------------------------
{
  const kind1 = select("placeKind", "Street Address", "Kind of Place");
  const query1 = fill("placeQuery", "100 Test St", "Search for place");
  const notes = fill("workNotes", "Roof work", "Work Notes");
  const refused = advance();
  const kind2 = select("placeKind", "Street Address", "Kind of Place");
  const query2 = fill("placeQuery", "100 Test St, Testville", "Search for place");
  const worked = advance();
  const steps = [GOTO, kind1, query1, notes, refused, kind2, query2, worked, REVIEW];
  const out = withoutRefusedAdvancePasses(steps, [4]);
  check("MUST-PASS: a first-attempt write the redo did not repeat is kept, in its place; the later value is the one kept", () => {
    same(out.steps, [GOTO, notes, kind2, query2, worked, REVIEW]);
    assert.equal(out.steps[3].value, "100 Test St, Testville");
    assert.deepEqual(refusing(out.steps).map((p) => p.detail), []);
  });
}

// ---- two refusals in a row ----------------------------------------------------------------------
{
  const a1 = fill("boxA", "one", "Box A");
  const b1 = fill("boxB", "one", "Box B");
  const r1 = advance();
  const a2 = fill("boxA", "two", "Box A");
  const r2 = advance();
  const a3 = fill("boxA", "three", "Box A");
  const b3 = fill("boxB", "three", "Box B");
  const worked = advance();
  const steps = [GOTO, a1, b1, r1, a2, r2, a3, b3, worked, REVIEW];
  const out = withoutRefusedAdvancePasses(steps, [3, 5]);
  check("MUST-PASS: two refusals in a row leave the last pass and the one advance that worked", () => {
    same(out.steps, [GOTO, a3, b3, worked, REVIEW]);
    assert.deepEqual(refusing(out.steps).map((p) => p.detail), []);
  });
  // The second refusal's redo repeats nothing the first pass did not also see: both marked advances
  // still go, because each has a write before it that a write after it (on the same page) replaced.
  const c2 = fill("boxC", "two", "Box C");
  const steps2 = [GOTO, a1, b1, r1, c2, r2, a3, b3, worked, REVIEW];
  const out2 = withoutRefusedAdvancePasses(steps2, [3, 5]);
  check("MUST-PASS: a middle pass that repeated nothing is kept as a write, and neither refused advance survives", () => {
    same(out2.steps, [GOTO, c2, a3, b3, worked, REVIEW]);
    assert.deepEqual(refusing(out2.steps).map((p) => p.detail), []);
  });
}

// ---- what must be left alone --------------------------------------------------------------------
{
  const h1 = fill("helperName", "ZZ Test Helper", "Helper Name");
  const adv1 = advance();
  const h2 = fill("helperName", "ZZ Test Helper", "Helper Name");
  const adv2 = advance();
  const steps = [GOTO, h1, adv1, h2, adv2, REVIEW];
  check("MUST-EXCLUDE: two pages that share a form and an advance label — nobody marked the advance — keep everything", () => {
    same(withoutRefusedAdvancePasses(steps, []).steps, steps);
  });
}
{
  const a1 = fill("boxA", "one", "Box A");
  const refused = advance();
  const c2 = fill("boxC", "two", "Box C");
  const worked = advance();
  const steps = [GOTO, a1, refused, c2, worked, REVIEW];
  check("MUST-EXCLUDE: a marked advance whose redo repeated no write is kept (for the sequence check to judge), with every write", () => {
    const out = withoutRefusedAdvancePasses(steps, [2]);
    same(out.steps, steps);
    assert.deepEqual(out.dropped, []);
  });
}
{
  const a1 = fill("boxA", "one", "Box A");
  const a1b = fill("boxA", "one again", "Box A");
  const adv = advance();
  const b = fill("boxB", "two", "Box B");
  const steps = [GOTO, a1, a1b, adv, b, advance(), REVIEW];
  check("MUST-EXCLUDE: a control written twice on one page with no refused advance between is not this rule's", () => {
    same(withoutRefusedAdvancePasses(steps, [3]).steps, steps);
  });
}
{
  const early = fill("boxA", "page one", "Box A");
  const adv0 = advance();
  const a1 = fill("boxA", "one", "Box A");
  const refused = advance();
  const a2 = fill("boxA", "two", "Box A");
  const worked = advance();
  const late = fill("boxA", "page three", "Box A");
  const steps = [GOTO, early, adv0, a1, refused, a2, worked, late, advance("Continue"), REVIEW];
  check("MUST-EXCLUDE: writes to the same id on an earlier and a later page are never touched", () => {
    same(withoutRefusedAdvancePasses(steps, [4]).steps, [GOTO, early, adv0, a2, worked, late, steps[8], REVIEW]);
  });
}
{
  const a1 = fill("boxA", "one", "Box A");
  const refused = advance();
  const back = click("Previous page", "human-patch: Previous page");
  const a2 = fill("boxA", "two", "Box A");
  const steps = [GOTO, a1, refused, back, a2, advance(), REVIEW];
  check("MUST-EXCLUDE: a click that may have replaced the form before the redo's first write — the check's own doubt — drops nothing", () => {
    same(withoutRefusedAdvancePasses(steps, [2]).steps, steps);
  });
}
{
  const frame = "ContactDialogFrame";
  const d1 = S({ action: "fill", phase: "fill", selector: { label: "Contact Name", frame }, value: "ZZ Test Owner", note: "Contact Name", fingerprint: { id: "contactName" } });
  const a1 = fill("boxA", "one", "Box A");
  const refused = advance();
  const d2 = S({ action: "fill", phase: "fill", selector: { label: "Contact Name", frame }, value: "ZZ Test Owner", note: "Contact Name", fingerprint: { id: "contactName" } });
  const a2 = fill("boxA", "two", "Box A");
  const worked = advance();
  const steps = [GOTO, d1, a1, refused, d2, a2, worked, REVIEW];
  check("MUST-EXCLUDE: a dialog's own writes are left as recorded (a re-opened dialog is a fresh form)", () => {
    same(withoutRefusedAdvancePasses(steps, [3]).steps, [GOTO, d1, d2, a2, worked, REVIEW]);
  });
}
{
  const a1 = fill("field34", "one", "Storage Model");
  const refused = advance();
  const a2 = fill("field34", "two", "Export Limit");
  const steps = [GOTO, a1, refused, a2, advance(), REVIEW];
  check("MUST-EXCLUDE: one per-render id under two different names is two controls — nothing is superseded", () => {
    same(withoutRefusedAdvancePasses(steps, [2]).steps, steps);
  });
}
{
  const a1 = fill("boxA", "one", "Box A");
  const refused = advance();
  const a2 = fill("boxA", "two", "Box A");
  const steps = [GOTO, a1, refused, REVIEW, a2, FINAL];
  check("MUST-EXCLUDE: a review stop is never crossed — a write after it supersedes nothing before it", () => {
    same(withoutRefusedAdvancePasses(steps, [2]).steps, steps);
  });
  const steps2 = [GOTO, a1, refused, a2, REVIEW, FINAL];
  check("MUST-EXCLUDE: the review stop and the final submit stay, in place and flagged, when the pass before them is cleaned", () => {
    const out = withoutRefusedAdvancePasses(steps2, [2]);
    same(out.steps, [GOTO, a2, REVIEW, FINAL]);
    assert.equal(out.steps[3].isFinalSubmit, true);
  });
}
{
  const blank = S({ action: "fill", phase: "fill", selector: { label: "Box A" }, value: "", note: "Box A", fingerprint: { id: "boxA" } });
  const a1 = fill("boxA", "one", "Box A");
  const refused = advance();
  const steps = [GOTO, a1, refused, blank, advance(), REVIEW];
  check("MUST-EXCLUDE: a redo step that writes nothing (empty, unbound) supersedes nothing", () => {
    same(withoutRefusedAdvancePasses(steps, [2]).steps, steps);
  });
  const noId = S({ action: "fill", phase: "fill", selector: { label: "Box A" }, value: "two", note: "Box A" });
  const steps2 = [GOTO, S({ action: "fill", phase: "fill", selector: { label: "Box A" }, value: "one", note: "Box A" }), refused, noId, advance(), REVIEW];
  check("MUST-EXCLUDE: writes with no recorded id are never matched by their words", () => {
    same(withoutRefusedAdvancePasses(steps2, [2]).steps, steps2);
  });
}

if (failures) { console.error(`\n${failures} refused-advance-pass unit check(s) FAILED.`); process.exit(1); }
console.log("\nAll refused-advance-pass unit checks passed.");
