// THE NAME RESCUE'S MATCH AND THE DISMISSAL PREDICATE, PINNED (#233). Browser-free; the
// real-Chromium behaviour is rescueAndDismissal.dom.smoke.ts.
//
//   labelHasWholeWords / wholeWordsPattern — the name rescue's match (findEnabledControlByName,
//     and revealMenuAndPick's trigger search). It was `label.includes(wants)`, so with Bend's
//     upload-error popup absent "OK" matched "Book an Inspection" and the run navigated off the
//     application. A fragment never matches; the whole label, or words on token boundaries, do.
//   isDialogDismissalStep — a recorded click that only closed a popup: its WHOLE label is a
//     dismissal word (the dismisser's DISMISS_LABEL — one vocabulary) AND a recorded handle names a
//     popup. Bend step 22 is one; Accela's dialog "Continue" / "Select" / "Look Up" (ids carrying
//     "phPopup") and a bare role=button "Close" are not. Never the flagged final submit.
//
// Imported as a namespace and checked per case, so a build without the predicates FAILS each case
// rather than throwing at load (a file that cannot load proves nothing about the fix).
//
// Run: npx tsx portal-bot/src/adapters/rescueAndDismissal.test.ts
import assert from "node:assert/strict";
import type { RecipeStep } from "../../../shared/src/types";
import * as ra from "./recipeAdapter";
import * as al from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const mod = ra as unknown as {
  labelHasWholeWords?: (label: string, wants: string) => boolean;
  wholeWordsPattern?: (wants: string) => string;
  isDialogDismissalStep?: (step: RecipeStep) => boolean;
};
const DISMISS_LABEL = (al as unknown as { DISMISS_LABEL?: RegExp }).DISMISS_LABEL;
const whole = (label: string, wants: string): boolean => {
  assert.equal(typeof mod.labelHasWholeWords, "function", "labelHasWholeWords is not exported");
  return mod.labelHasWholeWords!(label, wants);
};
const dismissal = (step: Partial<RecipeStep>): boolean => {
  assert.equal(typeof mod.isDialogDismissalStep, "function", "isDialogDismissalStep is not exported");
  return mod.isDialogDismissalStep!({ phase: "fill", ...step } as RecipeStep);
};

// --- whole words ------------------------------------------------------------------------------
check("THE REGRESSION: 'ok' is not inside 'book an inspection', 'lookup', 'look up record', 'smoke detector permit'", () => {
  for (const label of ["book an inspection", "lookup", "look up record", "smoke detector permit", "bookmarks"]) {
    assert.equal(whole(label, "ok"), false, label);
  }
});

check("MUST EXCLUDE: 'search' inside 'research', 'apply' inside 'reapply' / 'applying', 'step 1' inside 'step 10'", () => {
  assert.equal(whole("research", "search"), false);
  assert.equal(whole("reapply", "apply"), false);
  assert.equal(whole("applying", "apply"), false);
  assert.equal(whole("step 10", "step 1"), false);
});

check("MUST PASS: the whole label, and words on token boundaries, match", () => {
  assert.equal(whole("ok", "ok"), true);
  // Oregon ePermitting's link after the ligature strip ("check_circleApply" -> "Apply"), and "Apply Now".
  assert.equal(whole("apply", "apply"), true);
  assert.equal(whole("apply now", "apply"), true);
  assert.equal(whole("apply for a licence", "apply"), true);
  assert.equal(whole("search records", "search"), true);
  assert.equal(whole("ok, continue", "ok"), true);
  assert.equal(whole("next »", "next"), true);
  assert.equal(whole("continue application »", "continue application »"), true);
  // Saratoga's recorded name keeps its ligature behind a space; equality is what preserves it.
  assert.equal(whole("folder building permits", "folder building permits"), true);
  // A later occurrence on a boundary still counts when the first is a fragment.
  assert.equal(whole("lookup ok", "ok"), true);
  // Non-ASCII letters are letters: no boundary inside "café".
  assert.equal(whole("cafés", "café"), false);
  assert.equal(whole("le café", "café"), true);
});

check("a wanted name with regex syntax characters is literal, and compiles under the 'u' flag", () => {
  assert.equal(whole("browse..", "browse.."), true);
  assert.equal(whole("browseab", "browse.."), false); // an unescaped '.' would match any character
  assert.equal(whole("my shopping cart (0)", "cart (0)"), true);
  assert.equal(whole("a+b", "a+b"), true);
  assert.equal(whole("[x] close", "[x]"), true);
  assert.equal(whole("e-mail us", "e-mail"), true); // '-' is not escaped: an identity escape throws under 'u'
  assert.equal(typeof mod.wholeWordsPattern, "function", "wholeWordsPattern is not exported");
  for (const w of ["browse..", "cart (0)", "a+b", "$5 fee?", "a|b", "{x}", "\\", "^start$", "e-mail", "×"]) {
    assert.doesNotThrow(() => new RegExp(mod.wholeWordsPattern!(w), "u"), w);
  }
});

check("nothing matches nothing", () => {
  assert.equal(whole("", "ok"), false);
  assert.equal(whole("ok", ""), false);
});

// --- the dismissal predicate ------------------------------------------------------------------
check("MUST PASS: Bend's electrical step 22, verbatim from recipe 8bbd9a74", () => {
  assert.equal(dismissal({ action: "click", selector: { role: "button", name: "OK", exact: true, fallbacks: [{ css: "#uploadErrorPopupOk" }] }, note: "advance: OK" }), true);
});

check("MUST PASS: a Close in a .modal-footer, a × whose recorded id names a popup, a css-only OK, a Close in a dialog frame, a section that is a dialog", () => {
  assert.equal(dismissal({ action: "click", selector: { role: "button", name: "Close", fallbacks: [{ css: ".modal-footer button.btn-secondary" }] }, note: "human-patch: Close" }), true);
  assert.equal(dismissal({ action: "click", selector: { text: "×" }, note: "human-patch: ×", fingerprint: { id: "popupMoreInfoClose" } }), true);
  assert.equal(dismissal({ action: "click", selector: { css: "#errorDialogOk" }, note: "advance: OK" }), true);
  assert.equal(dismissal({ action: "click", selector: { role: "button", name: "Close", frame: "ACADialogFrame" }, note: "human-patch: Close" }), true);
  assert.equal(dismissal({ action: "click", selector: { role: "button", name: "Dismiss" }, note: "advance: Dismiss", fingerprint: { section: "Upload Error Dialog" } }), true);
});

check("MUST EXCLUDE: Accela's dialog controls (ids carry 'phPopup'), verbatim from the Corvallis and Boise recipes", () => {
  assert.equal(dismissal({ action: "click", selector: { role: "link", name: "Continue", exact: true, fallbacks: [{ css: "#ctl00_phPopup_btnSave", frame: "ACADialogFrame" }], frame: "ACADialogFrame" }, note: "advance: Continue" }), false);
  assert.equal(dismissal({ action: "click", selector: { role: "link", name: "Look Up", exact: true, fallbacks: [{ css: "#ctl00_phPopup_btnSearch", frame: "ACADialogFrame" }], frame: "ACADialogFrame" }, note: "advance: Look Up" }), false);
  assert.equal(dismissal({ action: "click", selector: { css: "[id=\"ctl00_phPopup_btnSelect\"]", frame: "ACADialogFrame", fallbacks: [{ role: "link", name: "Select", exact: true, frame: "ACADialogFrame" }, { css: "a[title=\"Select\"], input[value=\"Select\"]", frame: "ACADialogFrame" }] }, note: "lookup: Select [address list]" }), false);
  assert.equal(dismissal({ action: "click", selector: { frame: "ACADialogFrame", role: "link", name: "Continue" }, note: "human-patch: Continue" }), false);
});

check("MUST EXCLUDE: a dismissal word with no recorded popup handle keeps main's path", () => {
  assert.equal(dismissal({ action: "click", selector: { role: "button", name: "Close", exact: true }, note: "human-patch: Close" }), false);
  assert.equal(dismissal({ action: "click", selector: { role: "button", name: "OK", exact: true, fallbacks: [{ css: "#btnOk" }] }, note: "advance: OK" }), false);
});

check("MUST EXCLUDE: a label that only CONTAINS a dismissal word, a non-click, and the flagged final submit", () => {
  assert.equal(dismissal({ action: "click", selector: { role: "link", name: "Book an Inspection", fallbacks: [{ css: "#popupBook" }] }, note: "advance: Book an Inspection" }), false);
  assert.equal(dismissal({ action: "click", selector: { role: "button", name: "OK, submit my application", fallbacks: [{ css: "#submitPopupOk" }] }, note: "advance: OK, submit my application" }), false);
  assert.equal(dismissal({ action: "check", selector: { label: "OK", fallbacks: [{ css: "#popupOk" }] }, note: "OK" }), false);
  assert.equal(dismissal({ action: "click", selector: { role: "button", name: "OK", fallbacks: [{ css: "#popupOk" }] }, note: "final submit: OK", isFinalSubmit: true } as Partial<RecipeStep>), false);
});

check("ONE VOCABULARY: with a popup handle, a recorded click is a dismissal exactly when the dismisser's DISMISS_LABEL says its label is one", () => {
  assert.ok(DISMISS_LABEL instanceof RegExp, "DISMISS_LABEL is not exported by autoLearnAdapter");
  for (const label of ["OK", "ok", "Close", "Dismiss", "Got it", "Accept", "Accept All", "×", "x", "Okay", "Continue", "Book an Inspection", "OK, submit"]) {
    assert.equal(dismissal({ action: "click", selector: { role: "button", name: label, fallbacks: [{ css: "#messagePopupBtn" }] }, note: `human-patch: ${label}` }), DISMISS_LABEL!.test(label), label);
  }
});

check("THE WAIT FOR A LATE POPUP: long enough for a 4 s showModal, and shorter than main's 30 s click wait", () => {
  const ms = (ra.RecipeAdapter as unknown as { DISMISSAL_DIALOG_WAIT_MS?: number }).DISMISSAL_DIALOG_WAIT_MS;
  assert.equal(typeof ms, "number", "RecipeAdapter.DISMISSAL_DIALOG_WAIT_MS is not defined");
  assert.ok(ms! >= 4000 && ms! < 30000, `${ms} ms`);
});

if (failures) { console.error(`\n${failures} rescue/dismissal check(s) FAILED.`); process.exit(1); }
console.log("\nAll rescue/dismissal predicate checks passed.");
process.exit(0);
