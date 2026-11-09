// THE "APPLICATION ALREADY IN PROGRESS" NOTICE AND THE START-NEW CONTROL, PURE (#351).
//
// readExistingApplicationNotice names a page that shows somebody's draft (the learner then stops or
// starts its own application); isStartNewApplicationControl is the one control it may take there.
// Synthetic wording only.
//
//   npx tsx portal-bot/src/existingApplicationNotice.test.ts
import { isStartNewApplicationControl, readExistingApplicationNotice } from "./existingApplicationNotice";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`ok   - ${label}`);
  else { failures++; console.error(`FAIL - ${label}${detail ? `\n       ${detail}` : ""}`); }
};

const NAMES: Array<[string, RegExp]> = [
  ["Permitting Information You have an application in progress. Draft 2026-0141, 77 Other Ave. Continue", /in progress\. Draft 2026-0141, 77 Other Ave\./],
  ["Saved applications: Draft 2026-0141, 77 Other Ave.", /Saved applications/],
  ["You have 2 applications not yet submitted.", /not yet submitted/],
  ["There is one request that is still in progress for this account.", /in progress/],
  ["Continue your saved application or start a new one.", /saved application/],
  ["Resume an existing draft below.", /existing draft/],
  ["Your unfinished applications are listed below.", /unfinished applications/],
  ["Draft #A-77123 was last edited on 10/02.", /Draft #A-77123/],
  ["You have an in-progress application.", /in-progress application/],
];
for (const [text, want] of NAMES) {
  const got = readExistingApplicationNotice(text);
  check(`names the notice: "${text.slice(0, 60)}"`, !!got && want.test(got), `got ${JSON.stringify(got)}`);
}

const NOT: string[] = [
  "Please enter the site address. Save as draft at any time.",
  "NEM-90017\tApplication Draft\tJordan Testcase\t1234 N Example St",
  "This is a permit request only. A Permit Tech will review your submission. Click Continue.",
  "Staff will review your application within 5 business days. Click Next to send it to the city.",
  "If you are modifying an existing application, file it as a modification on the original record.",
  "Work in progress: the new portal launches in spring.",
  "Drafting standards: plans must be drawn to scale (1/4 in = 1 ft).",
  "Your draft application NEM-90017 has been created.",
  "",
];
for (const text of NOT) {
  const got = readExistingApplicationNotice(text);
  check(`no notice: "${text.slice(0, 60)}"`, got === null, `got ${JSON.stringify(got)}`);
}
// The created-draft page of a two-part portal is the RUN's own draft and is read elsewhere
// (draftCreated.ts); this predicate is only asked before anything was entered.

// A page's innerText: menu and heading lines first, then the notice — the line is the notice alone.
{
  const page = "Placeholder Solar Co\nDevelopment Hub Fixture\nOnline License & Permit Services\nDevHub Home\nMy Profile\nPermitting Information\nYou have an application in progress.\nDraft 2026-0141, 77 Other Ave.\nContinue";
  const got = readExistingApplicationNotice(page);
  check("reads the notice out of a page's lines, without its menus", got === "You have an application in progress. Draft 2026-0141, 77 Other Ave.", `got ${JSON.stringify(got)}`);
}
check("caps the line at 160 characters", (readExistingApplicationNotice(`You have an application in progress ${"x".repeat(300)}.`) ?? "").length <= 160);

const START = ["Start a New Application", "New Application", "Create New", "Begin Another Application", "Start new request", "+ New Permit"];
const NOT_START = ["Continue", "Resume Application", "Open Draft", "Edit", "View", "Start Over", "Start Again", "Next", "Begin", "Apply For A Permit",
  "Continue New Application", "Discard and start new", "Copy to new application", "Renew"];
for (const l of START) check(`start-new control: "${l}"`, isStartNewApplicationControl(l));
for (const l of NOT_START) check(`not a start-new control: "${l}"`, !isStartNewApplicationControl(l));

if (failures) { console.error(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log("\nAll existingApplicationNotice checks passed.");
