// #280 — the definition of a recipe's leading sign-in sequence (leadingSignIn.ts), pinned.
// MUST-PASS shapes a hand recording produces; MUST-EXCLUDE everything that writes form data (or
// reaches the run's boundary) before the recorder's sensitive credential fill.
//
// Run: npx tsx portal-bot/src/adapters/leadingSignIn.test.ts
import type { RecipeStep } from "../../../shared/src/types";
import { describeLeadingSignIn, leadingSignInSequence } from "./leadingSignIn";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};
const s = (step: Partial<RecipeStep>): RecipeStep => step as RecipeStep;
const click = (name: string): RecipeStep => s({ action: "click", selector: { role: "button", name }, note: name });
const goto = s({ action: "goto", value: "http://portal.localhost/", note: "entry url" });
const user = s({ action: "fill", selector: { role: "textbox", name: "Login name" }, value: "recorded-literal", note: "Login name" });
const secret = s({ action: "fill", selector: { role: "textbox", name: "Secret" }, sensitive: true, optional: true, note: "SENSITIVE — bind to credential/redacted field (no value stored). Secret" });
const boundSecret = s({ action: "fill", selector: { label: "Account" }, field: "accountNumber", sensitive: true, optional: true, note: 'SENSITIVE — bound to project field "accountNumber" (no value stored). Account' });
const boundFill = s({ action: "fill", selector: { label: "Project title" }, field: "projectName", note: "Project title" });
const stop = s({ action: "stopForReview" });
const show = (steps: RecipeStep[]): string => JSON.stringify(leadingSignInSequence(steps));
const is = (steps: RecipeStep[], start: number, end: number): boolean => {
  const q = leadingSignInSequence(steps);
  return !!q && q.start === start && q.end === end;
};

// MUST-PASS
{
  const incident = [click("Open the sign-in"), user, secret, click("Send"), click("Start"), boundFill, stop];
  check("MUST-PASS: click, user-name fill, credential fill, click -> steps 1-4", is(incident, 0, 3), show(incident));
  const withGoto = [goto, goto, ...incident];
  check("MUST-PASS: leading gotos are not part of the sequence (they still run)", is(withGoto, 2, 5), show(withGoto));
  const formFirst = [user, secret, s({ action: "press", value: "Enter", note: "Enter" }), click("Start"), boundFill, stop];
  check("MUST-PASS: the recipe opens on the sign-in form and a key press sends it", is(formFirst, 0, 2), show(formFirst));
  const twoPage = [click("Open the sign-in"), user, click("Continue"), secret, click("Send"), click("Start")];
  check("MUST-PASS: an identifier-first sign-in (a click between user name and credential)", is(twoPage, 0, 4), show(twoPage));
  const noUser = [click("Open the sign-in"), secret, click("Send"), click("Start")];
  check("MUST-PASS: a remembered user name (no user-name fill)", is(noUser, 0, 2), show(noUser));
  const valueless = [click("Open the sign-in"), s({ ...user, value: undefined }), secret, click("Send")];
  check("MUST-PASS: a user-name fill stored without a value", is(valueless, 0, 3), show(valueless));
  const line = describeLeadingSignIn(incident, { start: 0, end: 3 });
  check("the description names the step numbers and labels", /^steps 1-4: click "Open the sign-in", fill "Login name", fill \(credential/.test(line) && /click "Send"$/.test(line), line);
  check("the description never carries a recorded value or a sensitive step's label", !line.includes("recorded-literal") && !/Secret/.test(line), line);
}

// MUST-EXCLUDE
{
  const none = (label: string, steps: RecipeStep[]): void => check(`MUST-EXCLUDE: ${label}`, leadingSignInSequence(steps) === null, show(steps));
  none("no sensitive fill at all", [click("Start"), boundFill, click("Continue"), stop]);
  none("the first sensitive fill comes after an application fill", [click("Start"), boundFill, secret, click("Continue"), stop]);
  none("two plain fills before the sensitive fill", [click("Start"), user, s({ ...user, note: "Street" }), secret, click("Continue")]);
  none("the first sensitive fill is bound to a project field", [click("Start"), boundSecret, click("Continue"), stop]);
  none("a project-bound sensitive fill before the credential fill", [click("Start"), boundSecret, secret, click("Continue")]);
  none("a select before the sensitive fill", [click("Start"), s({ action: "select", selector: { label: "Type" }, value: "Roof", note: "Type" }), secret, click("Continue")]);
  none("a tick before the sensitive fill", [s({ action: "check", selector: { label: "I agree" }, note: "I agree" }), secret, click("Continue")]);
  none("an upload before the sensitive fill", [s({ action: "upload", selector: { css: "#f" }, docType: "site_plan" }), secret, click("Continue")]);
  none("a sensitive SELECT is not the credential fill", [click("Start"), s({ ...secret, action: "select" }), click("Continue")]);
  none("the review stop comes before the sensitive fill", [click("Start"), stop, secret, click("File")]);
  none("a final-submit click inside the candidate", [s({ ...click("File"), isFinalSubmit: true }), secret, click("Continue")]);
  none("the click that would end it is the final submit", [click("Open"), secret, s({ ...click("File"), isFinalSubmit: true })]);
  none("a form fill between the credential and the sending click", [click("Open"), secret, boundFill, click("Send")]);
  none("a plain fill between the credential and the sending click", [click("Open"), secret, user, click("Send")]);
  none("a credential fill nothing sends", [click("Open"), user, secret]);
  none("no steps", []);
  check("MUST-EXCLUDE: a missing step list", leadingSignInSequence(undefined) === null && leadingSignInSequence(null) === null);
}

if (failures) { console.error(`\n${failures} leading-sign-in check(s) FAILED.`); process.exit(1); }
console.log("\nAll leading-sign-in checks passed.");
