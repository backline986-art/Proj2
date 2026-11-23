// ONE ROLE TABLE (#228): the role a click step records is the role replay asks for.
//
// The learner writes a click step's role through recordedRoleOf (toExtractedField). Replay's
// recorded-identity check asks the same function of the element a step's recorded id names now,
// after running the learner's own extractFieldsInPage on it. A second table there once gave an
// href-less <a> no role. An AngularJS record-type anchor, which routes by ng-click and was recorded
// as a link, was refused for it, and the namesake menu tab was clicked instead. This pins the
// function and the selector toExtractedField builds from it, so a "fix" that re-adds a default
// somewhere else shows up as a failure here. The real-DOM half (an href-less <a> read by the
// extractor) is case M2 of recordedIdentityNamesake.dom.smoke.ts.
//
//   npm run portal:test:unit -- --only recordedRole
import assert from "node:assert/strict";
import { recordedRoleOf, toExtractedField, type RawField } from "./autoLearnAdapter";

let failures = 0;
const t = (name: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${e instanceof Error ? e.message : String(e)}`); }
};

t("a clickable control's explicit role is its recorded role", () => {
  assert.equal(recordedRoleOf({ fieldType: "button", role: "menuitem" }), "menuitem");
});
t("an <a> read by the extractor (role \"link\", href or not) records as a link", () => {
  assert.equal(recordedRoleOf({ fieldType: "button", role: "link" }), "link");
});
t("a clickable control with no role read records as a button", () => {
  assert.equal(recordedRoleOf({ fieldType: "button" }), "button");
  assert.equal(recordedRoleOf({ fieldType: "button", role: "" }), "button");
});
t("any other field is named only by its explicit role", () => {
  assert.equal(recordedRoleOf({ fieldType: "text" }), "");
  assert.equal(recordedRoleOf({ fieldType: "select", role: "combobox" }), "combobox");
});
t("toExtractedField writes exactly recordedRoleOf into a click step's role+name selector", () => {
  for (const role of ["link", "button", "menuitem", undefined]) {
    const raw: RawField = { label: "Apply", fieldType: "button", role, text: "Apply", id: "apply-btn-x" };
    const sel = toExtractedField(raw).selector;
    assert.equal(sel.role, recordedRoleOf(raw), `role ${String(role)}`);
    assert.equal(sel.name, "Apply");
    assert.deepEqual(sel.fallbacks, [{ css: "#apply-btn-x" }]);
  }
});
// #229 decides this shape: a clickable control known only by its name ATTRIBUTE records that
// attribute as css and no role+name at all (a bare name is never an accessible name), so there is
// no role for recordedRoleOf to write. A control with text or an id keeps the case above.
t("a name-only clickable control (no text, no id) records its name attribute as css, no role", () => {
  const raw: RawField = { label: "", fieldType: "button", name: "go" };
  const sel = toExtractedField(raw).selector;
  assert.equal(sel.role, undefined);
  assert.equal(sel.name, undefined);
  assert.match(String(sel.css ?? ""), /\[name="go"\]/);
});

if (failures) { console.error(`\nrecordedRole.test: ${failures} FAILURE(S)`); process.exit(1); }
console.log("\nrecordedRole.test: all passed");
