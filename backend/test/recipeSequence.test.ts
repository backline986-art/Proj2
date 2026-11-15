// A RECORDED SEQUENCE THAT CANNOT REPLAY AS RECORDED IS NOT 'complete' (#241).
//
// The 2026-11-14 audit of all 22 saved recipes found sequences no replay can reproduce — replay does
// exactly what was recorded and cannot invent a pick the learn never made. Every fixture below is a
// SYNTHETIC copy of a real recipe's SHAPE (ids, step order, notes as the recorder writes them); no
// real name, address, phone or e-mail is used.
//
//   A. recipeSequenceProblems, one shape each:
//      1. City of Bend structural (0f27d93d): a refused "Next Step", then page 1 re-filled, the phone
//         box re-bound to another key, and no review — the looped learn;
//      2. ComEd (1ef9a324): ends on its first page, no advance, no review — truncated;
//      3. City of Boise / Corvallis / Meridian: a chooser opened and nothing picked, a dialog left with
//         a pick or a search as its last step;
//      4. City of Corvallis (4b1fb65f / 333de771): Type and Description written after the
//         attachment row's own Save, then Save again;
//      5. City of Bend electrical (8bbd9a74): one select set to two different answers on one page.
//   B. MUST-KEEP: the live-proven Coos Bay recipes' shape (e965c645 / 15626922: two contact dialogs
//      re-using one css, each committed; upload -> description -> type -> save), Tigard's look-ups
//      (a "Search" followed by a pick; a note whose section says "Add Contact"), a single-page
//      application, an empty literal later set, one id in two committed dialogs — no finding.
//   C. No upload step: a NOTE (never a refusal), and only when the filing owes documents or that is
//      not known.
//   D. The doors, on the real write path: promoteRecordingIfEligible REFUSES and writes why (note,
//      flag, audit); finishPortalRecipe (a person) PROMOTES and is shown the same findings; clean steps
//      clear only this check's own flag, and so does an abandoned re-record restored to its snapshot.
//   E. The learn's trust gate, through the real autoLearnPortal (browser and LLM stubbed): a learn whose
//      saved steps re-fill page 1 after its advance is NOT trusted; a clean one still is; one whose walk
//      reached review but kept no submit step is too (the learner writes no stopForReview).
//   F. The fix round (#241 review) — the shapes the first cut refused although they replay as recorded:
//      the patch-by-demonstration flow (advance, a person's "Previous page", a corrected box, "Next
//      page"), a healed draft-only Part 1 saved by a person, a per-render id re-used for another
//      control, an in-page dialog used twice.
//
// KILL CHECKS (each turns this file red for its own reason):
//   K1 shared/src/recipeSequence.ts: recipeSequenceProblems returns [] -> A1-A5 and C fail, B passes.
//   K2 backend/src/portalRecipes.ts at origin/main -> D fails (the looped recording is promoted).
//   K3 backend/src/autoLearn.ts at origin/main -> E1 fails (the looped learn is trusted).
//   K4 finishPortalRecipe keeps any flag on clean steps -> D4 fails (the stale sequence flag survives).
//   K5 restoreRecipeSnapshotIfAbandoned keeps the sequence flag -> D5 fails.
//   K6 the walk ignores mayReplaceForm -> F1 and F2 fail (the person's patch is refused and flagged).
//   K7 the learn passes no reachedReview -> E3 fails; finishPortalRecipe passes none -> F3 fails.
//   K8 namesDisagree always false -> F4 fails; the conflict baseline ignores formBreak -> F5 fails.
//
// Run: npx tsx backend/test/recipeSequence.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import { setupStageFixture, check, finish } from "./_stageFixture";
import { recipeSequenceProblems, type RecipeSequenceProblem } from "../../shared/src/recipeSequence";

const fx = await setupStageFixture("recipe-sequence");
const { db, repo, recipes } = fx;
const autoLearn = await import("../src/autoLearn");
const llmMod = await import("../src/llm");
const draftMod = await import("../src/portalDraft");

// ── step builders (the recorder's own shapes) ──────────────────────────────────────────────────
const S = (s: Record<string, unknown>): RecipeStep => s as unknown as RecipeStep;
const GOTO = S({ action: "goto", phase: "open", value: "https://permits.example.test/Portal/", note: "entry url" });
const ENTRY = S({ action: "click", phase: "open", selector: { text: "Apply" }, note: "application entry: Apply" });
const fillId = (id: string, field: string, label: string, frame?: string) =>
  S({ action: "fill", phase: "fill", selector: { label, ...(frame ? { frame } : {}) }, field, note: label, fingerprint: { id } });
const selectId = (id: string, value: string, label: string) =>
  S({ action: "select", phase: "fill", selector: { label }, value, note: label, fingerprint: { id } });
const checkId = (id: string, label: string, frame?: string) =>
  S({ action: "check", phase: "fill", selector: { label, ...(frame ? { frame } : {}) }, note: label, fingerprint: { id } });
const advance = (name: string, role = "button") => S({ action: "click", phase: "fill", selector: { role, name }, note: `advance: ${name}` });
const FINAL = S({ action: "click", phase: "review", selector: { role: "button", name: "Submit Application" }, isFinalSubmit: true, note: "final submit: Submit Application (recorded, NOT clicked)" });
const DLG = "ACADialogFrame";

const kinds = (p: RecipeSequenceProblem[]) => p.map((x) => x.kind);
const refusing = (p: RecipeSequenceProblem[]) => p.filter((x) => x.refusesPromotion);
const KNOWN_DOCS = { owedDocuments: [] as string[] }; // section A/B: the upload note is section C's

// ── A1. the looped learn (Bend structural shape) ───────────────────────────────────────────────
const PAGE1 = [
  selectId("applicationType", "Renovation/Alteration", "Choose the application type:*"),
  selectId("workclass", "Alteration", "Please categorize the nature of the work being done:*"),
  fillId("description", "workDescription", "Please describe the work being done:*"),
  selectId("PRPermit1_BuildingUse", "Single Family Dwelling", "Building Use:*"),
  fillId("PRPermit21_attUtilityCustomerPhone", "ubAccountHolderPhone", "Phone Number:*"),
  fillId("PRPermit21_attUtilityCustomerAddress", "projectAddress", "Complete Mailing Address (street, city, zip):*"),
];
const LOOPED = [
  GOTO, ENTRY, ...PAGE1,
  advance("Next Step"), // index 8 — refused: what follows re-fills page 1
  fillId("PRPermit21_attUtilityCustomerAddress", "projectAddress", "Complete Mailing Address (street, city, zip):*"),
  selectId("applicationType", "Renovation/Alteration", "Choose the application type:*"),
  selectId("workclass", "Alteration", "Please categorize the nature of the work being done:*"),
  fillId("PRPermit21_attUtilityCustomerEmail", "homeownerEmail", "Email Address:*"),
  fillId("PRPermit21_attUtilityCustomerPhone", "homeownerPhone", "Phone Number:*"), // index 13 — re-bound
];

await check("A1 the looped learn: a refused advance, a re-bound control, no review — each named", () => {
  const p = recipeSequenceProblems(LOOPED, KNOWN_DOCS);
  const adv = p.find((x) => x.kind === "refused_advance");
  assert.ok(adv, `no refused advance found: ${JSON.stringify(kinds(p))}`);
  assert.equal(adv!.steps[0], 8, "the finding must point at the advance itself");
  assert.match(adv!.detail, /advance at step 9 \("Next Step"\) did not leave its page: step\(s\) 10, 11, 12, 14 write again/);
  const bound = p.find((x) => x.kind === "conflicting_write");
  assert.ok(bound, "the phone box bound to the account holder, then to the homeowner, is not named");
  assert.deepEqual(bound!.steps, [13, 6]);
  assert.match(bound!.detail, /step 14 writes bound to homeownerPhone .*"Phone Number:\*".* step 7 wrote bound to ubAccountHolderPhone/);
  assert.ok(kinds(p).includes("never_reached_review"), "the looped learn never reached review");
  assert.ok(p.every((x) => x.kind !== "dialog_not_committed" && x.kind !== "chooser_nothing_picked"), `false dialog findings: ${JSON.stringify(kinds(p))}`);
  // The refused advance alone refuses, even when the recipe goes on to a review it reached somehow.
  const withEnd = recipeSequenceProblems([...LOOPED, FINAL], KNOWN_DOCS);
  assert.deepEqual(kinds(refusing(withEnd)).sort(), ["conflicting_write", "refused_advance"]);
  // A control written twice after the advance is one re-fill, named once (Bend's second pass).
  const twice = recipeSequenceProblems([...LOOPED, selectId("applicationType", "Renovation/Alteration", "Choose the application type:*"), FINAL], KNOWN_DOCS);
  assert.deepEqual(twice.find((x) => x.kind === "refused_advance")?.steps, [8, 9, 10, 11, 13], "a control's second write after the advance was listed as another re-fill");
});

// ── A2. truncated (ComEd shape) ────────────────────────────────────────────────────────────────
await check("A2 a recipe that ends on its first page: never reached review, never advanced — and nothing else", () => {
  const steps = [
    GOTO,
    S({ action: "click", phase: "open", selector: { text: "New Application Button. This will open a popup drawer" }, note: "application entry: New Application Button" }),
    S({ action: "click", phase: "open", selector: { role: "radio", name: "Distributed Generation" }, note: "application program: Distributed Generation" }),
    fillId("formly_6_itc-input_project_name_0", "projectName", "Project Name *"),
    checkId("formly_6_radio_existing_ia_1_1-input", "No"),
    fillId("formly_6_itc-input_street_address_3", "street", "Street Address *"),
    fillId("formly_9_itc-input_city_0", "city", "City *"),
    checkId("mat-radio-2-input", "Level 1  Maximum system size is 25 kW."),
  ];
  const p = refusing(recipeSequenceProblems(steps, KNOWN_DOCS));
  assert.deepEqual(kinds(p), ["never_reached_review"]);
  assert.match(p[0].detail, /ends at step 8 with no review stop and no recorded final submit, and nothing shows the recording reached review; it never advances past its first page/);
  // The door's own evidence that review was reached silences it — and nothing else changes.
  assert.deepEqual(kinds(refusing(recipeSequenceProblems(steps, { ...KNOWN_DOCS, reachedReview: true }))), []);
});

// ── A3. choosers and dialogs (Boise / Corvallis / Meridian shapes) ─────────────────────────────
await check("A3a a chooser opened and nothing picked: Boise's \"Select a Contact\", Corvallis's address Search", () => {
  const boise = [GOTO, ENTRY, fillId("ctl00_PlaceHolderMain_DetailInfoEdit_txtApplicationName", "projectName", "Project Name:"),
    advance("Select a Contact", "link"), advance("Continue »", "link"), FINAL];
  const pb = refusing(recipeSequenceProblems(boise, KNOWN_DOCS));
  assert.deepEqual(kinds(pb), ["chooser_nothing_picked"]);
  assert.deepEqual(pb[0].steps, [3, 4]);
  assert.match(pb[0].detail, /step 4 \("Select a Contact"\) opens a chooser and nothing is picked: step 5 moves on/);
  const corvallis = [GOTO, ENTRY, fillId("ctl00_PlaceHolderMain_WorkLocationEdit_txtStreetNo", "streetNumber", "Street No.:"),
    advance("Search", "link"), advance("Continue Application »", "link"), FINAL];
  assert.deepEqual(kinds(refusing(recipeSequenceProblems(corvallis, KNOWN_DOCS))), ["chooser_nothing_picked"]);
});

await check("A3b a dialog left with a pick as its last step (Boise: picks, no Select) — a committed one beside it is not flagged", () => {
  const steps = [
    GOTO, ENTRY,
    fillId("ctl00_PlaceHolderMain_WorkLocationEdit_txtStreetNo", "streetNumber", "Street No.:"),
    S({ action: "click", phase: "fill", selector: { role: "link", name: "Search" }, note: "lookup: Search [Search by Address]", fingerprint: { id: "ctl00_PlaceHolderMain_WorkLocationEdit_btnSearch" } }),
    S({ action: "click", phase: "fill", selector: { css: '[data-al-row="af1"]', frame: DLG }, note: "address version: this property" }),
    S({ action: "click", phase: "fill", selector: { css: '[id="ctl00_phPopup_btnSelect"]', frame: DLG }, note: "lookup: Select [address list]" }),
    advance("Search", "link"), // index 6 — opens the dialog again
    checkId("AddressSearchResult_ucAddressList_gv_CB_1", "100 EXAMPLE ST, Example City", DLG),
    // Boise's real run typed into the page BEHIND the dialog between two of its picks (its Phone box):
    // a main-page write does not end the dialog. (A different id here, so no other finding rides along.)
    fillId("ctl00_PlaceHolderMain_OwnerEdit_txtFax", "homeownerPhone", "Fax:"),
    checkId("AddressSearchResult_ucParcelList_gv_CB_0", "R0000000001", DLG),
    advance("Continue »", "link"), // index 10 — the page moves on with the dialog never committed
    FINAL,
  ];
  const p = refusing(recipeSequenceProblems(steps, KNOWN_DOCS));
  assert.deepEqual(kinds(p), ["dialog_not_committed"], `expected only the uncommitted dialog: ${JSON.stringify(p.map((x) => x.detail))}`);
  assert.deepEqual(p[0].steps, [7, 9, 10], "the dialog is one run across the main-page write behind it");
  assert.match(p[0].detail, /dialog at step\(s\) 8-10 is never committed: its last step is a pick, then step 11 moves on/);
});

await check("A3c a dialog whose last step is its own search (Corvallis licence Look Up) — never committed", () => {
  const steps = [
    GOTO, ENTRY, advance("Look Up", "link"),
    S({ action: "select", phase: "fill", selector: { label: "License Type:", frame: DLG }, value: "Contractor", note: "License Type:", fingerprint: { id: "ctl00_phPopup_licenseInput_ddlLicenseType" } }),
    fillId("ctl00_phPopup_licenseInput_txtLicenseNum", "ccbLicenseNumber", "CCB Number:", DLG),
    S({ action: "click", phase: "fill", selector: { role: "link", name: "Look Up", frame: DLG }, note: "advance: Look Up" }),
    advance("Continue Application »", "link"),
    FINAL,
  ];
  const p = refusing(recipeSequenceProblems(steps, KNOWN_DOCS));
  assert.deepEqual(kinds(p), ["dialog_not_committed"]);
  assert.match(p[0].detail, /dialog at step\(s\) 4-6 is never committed: its last step is a search, then step 7 moves on/);
});

await check("A3d Meridian: two Autofill look-ups at the end, no advance — each named, and the truncation", () => {
  const autofill = (section: string) => S({ action: "click", phase: "fill", selector: { role: "link", name: "Autofill" }, note: `lookup: Autofill [${section}]`, fingerprint: { id: `ctl00_PlaceHolderMain_${section}Edit_btnAddFromSaved`, section } });
  const steps = [GOTO, ENTRY, fillId("ctl00_PlaceHolderMain_WorkLocationEdit_txtStreetNo", "streetNumber", "Street No.:"), autofill("Applicant"), autofill("Contact")];
  assert.deepEqual(kinds(refusing(recipeSequenceProblems(steps, KNOWN_DOCS))), ["chooser_nothing_picked", "chooser_nothing_picked", "never_reached_review"]);
});

// ── A4. attachment-row steps after the row's own commit (Corvallis shape) ──────────────────────
const SAVE_COMMIT = S({ action: "click", phase: "upload", selector: { role: "link", name: "Save", exact: true }, note: "attachment: save (commits the upload)" });
await check("A4 Type and Description written after the row's Save, then Save again — the row's own steps after its commit", () => {
  const steps = [
    GOTO, ENTRY, advance("Continue Application »", "link"),
    S({ action: "upload", phase: "fill", selector: { css: '[data-al-upl="f0"]' }, docType: "plan_set", note: "upload plan_set: Select Files to Upload" }),
    SAVE_COMMIT, // index 4
    selectId("ctl00_documentEdit_ddlDocType", "01 Electrical Plans", "Type:"),
    S({ action: "fill", phase: "fill", selector: { label: "Description:" }, value: "Electrical plan set", note: "Description:", fingerprint: { id: "ctl00_documentEdit_txtAFileDescription" } }),
    S({ action: "click", phase: "fill", selector: { role: "link", name: "Save" }, note: "advance: Save" }), // index 7
    advance("Continue Application »", "link"),
    FINAL,
  ];
  const p = refusing(recipeSequenceProblems(steps, KNOWN_DOCS));
  assert.deepEqual(kinds(p), ["after_row_commit"]);
  assert.deepEqual(p[0].steps, [5, 6, 4]);
  assert.match(p[0].detail, /step\(s\) 6, 7 write the attachment row step 5 already committed, and step 8 commits it again/);
  // The recorder's own words name a row field after the commit even when nothing commits it again.
  const stamped = [
    GOTO, ENTRY, advance("Continue Application »", "link"),
    S({ action: "upload", phase: "fill", selector: { css: '[data-al-upl="f0"]' }, docType: "plan_set", note: "upload plan_set: Select Files to Upload" }),
    SAVE_COMMIT, // index 4
    S({ action: "fill", phase: "upload", selector: { css: "textarea" }, value: "Electrical plan set", note: "attachment: description" }),
    advance("Continue Application »", "link"),
    FINAL,
  ];
  const ps = refusing(recipeSequenceProblems(stamped, KNOWN_DOCS));
  assert.deepEqual(kinds(ps), ["after_row_commit"], "a stamped row field after the row's commit, with no re-commit, is not named");
  assert.deepEqual(ps[0].steps, [5, 4]);
  assert.match(ps[0].detail, /step\(s\) 6 write the attachment row step 5 already committed — the row is saved/);
});

// ── A5. two writes that disagree on one control (Bend electrical shape) ────────────────────────
await check("A5 one select set to two different answers on one page is named; an identical re-write is not", () => {
  const steps = [
    GOTO, ENTRY,
    selectId("applicationType", "Electrical", "Choose the application type:*"),
    selectId("workclass", "Alteration", "Please categorize the nature of the work being done:*"),
    fillId("description", "workDescription", "Please describe the work being done:*"),
    selectId("PRPermit1_BuildingUse", "Single Family Dwelling", "Building Use:*"),
    selectId("workclass", "New", "Please categorize the nature of the work being done:*"), // index 6
    selectId("PRPermit1_BuildingUse", "Single Family Dwelling", "Building Use:*"), // same answer again: harmless
    advance("Next Step"),
    FINAL,
  ];
  const p = refusing(recipeSequenceProblems(steps, KNOWN_DOCS));
  assert.deepEqual(kinds(p), ["conflicting_write"]);
  assert.deepEqual(p[0].steps, [6, 3]);
  assert.match(p[0].detail, /step 7 writes "New" .* step 4 wrote "Alteration", on the same page/);
});

// ── B. MUST-KEEP — the shapes that replay as recorded ──────────────────────────────────────────
const contactDialog = (role: string, keys: [string, string][]) => [
  S({ action: "click", phase: "fill", selector: { role: "button", name: "Add New" }, note: `contact(${role}): add new` }),
  // Oregon ePermitting's dialog carries NO ids: every contact re-uses the same css.
  ...keys.map(([css, field]) => S({ action: "fill", phase: "fill", selector: { css, frame: DLG }, field, value: "Example", note: `contact: ${field} [${role}]` })),
  S({ action: "click", phase: "fill", selector: { role: "button", name: "Continue", frame: DLG }, note: `contact(${role}): save new contact` }),
];
const COOS_BAY_SHAPE = [
  GOTO,
  ENTRY,
  S({ action: "check", phase: "fill", selector: { css: "input[id$='termAccept'], input[name$='termAccept']" }, note: "accela: accept entry terms" }),
  S({ action: "click", phase: "fill", selector: { css: 'a:has-text("Continue Application")' }, note: "accela: continue past entry disclaimer" }),
  S({ action: "fill", phase: "fill", selector: { css: "input[id*='StreetNo4Search']" }, field: "streetNumber", value: "100", note: "work location: street number" }),
  S({ action: "fill", phase: "fill", selector: { css: "input[id*='txtStreetName']" }, field: "streetNameSearchPortion", value: "Exa", note: "work location: street name (portion)" }),
  S({ action: "click", phase: "fill", selector: { css: "a[id$='WorkLocationEdit_btnSearch']" }, note: "work location: search" }),
  S({ action: "click", phase: "fill", selector: { css: '[data-al-row="ar1"]' }, note: "address version: CITY APPLICATIONS" }),
  S({ action: "click", phase: "fill", selector: { css: 'a:has-text("Continue Application")' }, note: "work location: continue" }),
  S({ action: "check", phase: "fill", selector: { label: "Residential - Structural" }, note: "record type: Residential - Structural" }),
  S({ action: "click", phase: "fill", selector: { css: 'a:has-text("Continue Application")' }, note: "record type: continue" }),
  advance("Continue Application »", "link"),
  advance("Continue Application »", "link"),
  fillId("ctl00_PlaceHolderMain_DescriptionEdit_txtJobValue", "declaredValuation", "Job Value($):"),
  selectId("ctl00_PlaceHolderMain_DescriptionEdit_ddlConstrucType", "1-1 or 2 Family Dwelling", "Category of Construction"),
  fillId("ctl00_PlaceHolderMain_DetailInfoEdit_txtApplicationName", "projectName", "Project Name"),
  advance("Continue Application »", "link"),
  ...contactDialog("applicant", [["input[id*='FirstName' i]", "installerFirstName"], ["input[id*='LastName' i]", "installerLastName"], ["input[id*='Email' i]", "installerEmail"]]),
  ...contactDialog("site contact", [["input[id*='FirstName' i]", "homeownerFirstName"], ["input[id*='LastName' i]", "homeownerLastName"], ["input[id*='Email' i]", "homeownerEmail"]]),
  S({ action: "click", phase: "fill", selector: { css: 'a:has-text("Continue Application")' }, note: "contacts: continue" }),
  checkId("ctl00_PlaceHolderMain_AppSpecEdit_EXAMPLE_rdo_0_0_1", "No"),
  selectId("ctl00_PlaceHolderMain_AppSpecEdit_EXAMPLE_ddl_1_0", "Other", "Category of Construction:"),
  fillId("ctl00_PlaceHolderMain_AppSpecEdit_EXAMPLE_txt_4_2", "workDescription", "Additional Comments:"),
  advance("Continue Application »", "link"),
  S({ action: "upload", phase: "fill", selector: { css: '[data-al-upl="f0"]' }, docType: "plan_set", note: "upload plan_set: Add" }),
  S({ action: "fill", phase: "upload", selector: { css: "textarea" }, value: "Solar PV plan set", note: "attachment: description" }),
  S({ action: "select", phase: "upload", selector: { css: "select" }, value: "Plans - Structural", note: "attachment: document type" }),
  SAVE_COMMIT,
  advance("Continue Application »", "link"),
  S({ action: "click", selector: { role: "link", name: "000-26-000000-STR" }, note: "human-patch: 000-26-000000-STR" }),
  S({ action: "click", phase: "review", selector: { role: "link", name: "Continue Application »" }, isFinalSubmit: true, note: "final submit: Continue Application » (recorded, NOT clicked)" }),
];

await check("B1 MUST-KEEP: the live-proven Coos Bay shape carries no finding at all", () => {
  assert.deepEqual(recipeSequenceProblems(COOS_BAY_SHAPE).map((x) => x.detail), []);
});

await check("B2 MUST-KEEP: Tigard's look-ups — a Search followed by a pick, a section that says \"Add Contact\" — carry no finding", () => {
  const steps = [
    GOTO,
    S({ action: "click", phase: "open", selector: { role: "link", name: "Apply" }, note: "navigate to application: Apply" }),
    advance("Search"),
    S({ action: "click", phase: "fill", selector: { role: "link", name: "Apply" }, note: "record type (verified): Apply Residential Renewable Energy - Prescriptive" }),
    S({ action: "select", phase: "fill", selector: { label: "Address Type" }, value: "Location", note: "Address Type", fingerprint: { id: "addressTypeSelect" } }),
    advance("Next"),
    advance("Contractor"),
    S({ action: "fill", phase: "fill", selector: { label: "Search" }, field: "installerCompanyName", note: "Search", fingerprint: { id: "input-ContactSearchBar", section: "Add Contact As : Contractor" } }),
    S({ action: "click", phase: "fill", selector: { role: "button", name: "Search" }, note: "lookup: Search [Add Contact As : Contractor]", fingerprint: { id: "button-Search", section: "Add Contact As : Contractor" } }),
    S({ action: "fill", phase: "fill", selector: { label: "Business Name" }, field: "installerCompanyName", note: "lookup(Add Contact As : Contractor): business name" }),
    S({ action: "click", phase: "fill", selector: { role: "button", name: "Search" }, note: "lookup(Add Contact As : Contractor): Search" }),
    S({ action: "click", phase: "fill", selector: { css: 'tr:has-text("EXAMPLE SOLAR LLC") a:has-text("Select")' }, note: "lookup(Add Contact As : Contractor): select this client's record" }),
    advance("Next"),
    fillId("ProjectName", "projectName", "*Project Name"),
    advance("Next"),
    S({ action: "upload", phase: "fill", selector: { css: '[data-al-upl="f0"]' }, docType: "plan_set", note: "upload plan_set: Plan Set Add Attachment" }),
    advance("Next"),
    S({ action: "fill", phase: "fill", selector: { css: "#signatureConsentNameId" }, field: "authorizedSignerName", note: "e-signature: signer name (consent)" }),
    S({ action: "fill", phase: "fill", selector: { css: "#signatureTypedNameId" }, field: "authorizedSignerName", note: "e-signature: typed signature" }),
    advance("Next"),
    S({ action: "click", phase: "review", selector: { role: "button", name: "Submit" }, isFinalSubmit: true, note: "final submit: Submit (recorded, NOT clicked)" }),
  ];
  assert.deepEqual(recipeSequenceProblems(steps).map((x) => x.detail), []);
});

await check("B3 MUST-KEEP: a single-page application, an empty literal later set, one id in two committed dialogs — no finding", () => {
  const single = [GOTO, fillId("name", "homeownerName", "Name"), fillId("addr", "street", "Street"),
    S({ action: "upload", phase: "fill", selector: { css: '[data-al-upl="f0"]' }, docType: "plan_set", note: "upload plan_set: Attach" }),
    S({ action: "click", phase: "review", selector: { role: "button", name: "Submit" }, isFinalSubmit: true, note: "final submit: Submit (recorded, NOT clicked — single-page application)" })];
  assert.deepEqual(recipeSequenceProblems(single).map((x) => x.detail), [], "a single-page application never advances and is fine");
  // PacifiCorp: the planner left a select "" (replay skips an empty literal) and a policy default set it.
  const policy = [GOTO, ENTRY,
    S({ action: "select", phase: "fill", selector: { label: "Are the AC disconnect(s) within reach?" }, value: "", note: "Are the AC disconnect(s) within reach?", fingerprint: { id: "E44U32NXYNWGInput" } }),
    S({ action: "select", phase: "fill", selector: { css: "#E44U32NXYNWGInput" }, value: "Yes", note: "policy default: Are the AC disconnect(s) within reach?" }),
    advance("Next"), FINAL];
  assert.deepEqual(kinds(refusing(recipeSequenceProblems(policy, KNOWN_DOCS))), [], "an empty literal writes nothing, so the later value is not a disagreement");
  // Corvallis: the contact dialog's Full Name box takes the owner in one dialog, the company in the next.
  const dialogs = [GOTO, ENTRY,
    S({ action: "click", phase: "fill", selector: { role: "link", name: "Select from Account" }, note: "advance: Select from Account" }),
    checkId("ContactSearchList_gdvSearchContactList_CB_0", "Associated Contact", DLG),
    S({ action: "click", phase: "fill", selector: { role: "link", name: "Continue", frame: DLG }, note: "advance: Continue" }),
    fillId("ctl00_phPopup_ucContactInfo_txtAppFullName", "homeownerName", "Full Name:", DLG),
    S({ action: "click", phase: "fill", selector: { role: "link", name: "Continue", frame: DLG }, note: "advance: Continue" }),
    S({ action: "click", phase: "fill", selector: { role: "link", name: "Add New" }, note: "advance: Add New" }),
    fillId("ctl00_phPopup_ucContactInfo_txtAppFullName", "installerContactName", "Full Name:", DLG),
    S({ action: "click", phase: "fill", selector: { role: "link", name: "Continue", frame: DLG }, note: "advance: Continue" }),
    advance("Continue Application »", "link"), FINAL];
  assert.deepEqual(kinds(refusing(recipeSequenceProblems(dialogs, KNOWN_DOCS))), [], "a re-opened dialog is a fresh form");
});

await check("B4 MUST-KEEP: controls with NO id are never one control by their words — two \"I agree\" boxes and two textareas on two pages", () => {
  const steps = [GOTO, ENTRY,
    S({ action: "check", phase: "fill", selector: { label: "I agree to the terms", css: "input[type=checkbox]" }, note: "I agree to the terms" }),
    S({ action: "fill", phase: "fill", selector: { label: "Description", css: "textarea" }, value: "Roof-mounted PV", note: "Description" }),
    advance("Next"),
    S({ action: "check", phase: "fill", selector: { label: "I agree to the terms", css: "input[type=checkbox]" }, note: "I agree to the terms" }),
    S({ action: "fill", phase: "fill", selector: { label: "Description", css: "textarea" }, value: "Battery storage", note: "Description" }),
    advance("Next"), FINAL];
  assert.deepEqual(recipeSequenceProblems(steps, KNOWN_DOCS).map((x) => x.detail), [], "same words, same css, no id: two controls");
});

await check("B5 MUST-KEEP: a dialog whose button lives OUTSIDE its frame is committed by that main-page click", () => {
  const steps = [GOTO, ENTRY,
    advance("Look Up", "link"), // opens the dialog
    checkId("ctl00_phPopup_resultList_CB_0", "EXAMPLE SOLAR LLC", DLG),
    S({ action: "click", phase: "fill", selector: { role: "button", name: "OK" }, note: "OK" }), // the dialog's own OK, on the page behind
    advance("Continue Application »", "link"), FINAL];
  assert.deepEqual(kinds(refusing(recipeSequenceProblems(steps, KNOWN_DOCS))), [], "a dialog closed by its own outside button was flagged as uncommitted");
});

// ── C. no upload step: a note, never a refusal ─────────────────────────────────────────────────
await check("C no upload step is a NOTE when the filing owes documents or that is unknown, and nothing when it owes none", () => {
  const noUploads = COOS_BAY_SHAPE.filter((s) => s.action !== "upload" && !/^attachment:/.test(String(s.note ?? "")));
  const owed = recipeSequenceProblems(noUploads, { owedDocuments: ["plan_set", "sld"] });
  assert.deepEqual(owed.map((x) => [x.kind, x.refusesPromotion]), [["no_uploads", false]]);
  assert.match(owed[0].detail, /no step uploads a document, though this filing carries 2 \(plan_set, sld\)/);
  const unknown = recipeSequenceProblems(noUploads);
  assert.deepEqual(unknown.map((x) => [x.kind, x.refusesPromotion]), [["no_uploads", false]]);
  assert.match(unknown[0].detail, /whether this filing owes documents was not known/);
  assert.deepEqual(recipeSequenceProblems(noUploads, { owedDocuments: [] }), [], "a filing known to owe nothing is not noted");
});

// ── D. the doors ───────────────────────────────────────────────────────────────────────────────
let scopeSeq = 0;
const freshRecording = (steps: RecipeStep[]) => {
  const row = recipes.startPortalRecording(db, { scopeType: "ahj", state: "OR", ahj: `City of Sequence ${++scopeSeq}`, portalUrl: "https://permits.example.test/Portal/" });
  recipes.savePortalRecipeSteps(db, row.id, steps); // a save is not a verdict: status stays 'recording'
  return row.id;
};
const sequenceSegments = (notes: string) => notes.split(" | ").filter((seg) => seg.toLowerCase().startsWith("[sequence check"));

await check("D1 the automatic door REFUSES a looped learn that reached review, and writes why: note, flag, audit — once", () => {
  const id = freshRecording([...LOOPED, FINAL]);
  const out = recipes.promoteRecordingIfEligible(db, id, { finishedBy: "operator (submitted in review browser)", via: "human_submit_observed" });
  assert.equal(out, null, "the looped recording was promoted");
  const r = recipes.getPortalRecipe(db, id);
  assert.equal(r.status, "recording");
  assert.ok(r.flagReason.startsWith(recipes.RECIPE_SEQUENCE_FLAG_PREFIX), `no sequence flag: "${r.flagReason}"`);
  assert.match(r.flagReason, /not promoted to complete.*advance at step 9 \("Next Step"\) did not leave its page/);
  assert.equal(sequenceSegments(r.notes).length, 1);
  assert.match(sequenceSegments(r.notes)[0], /not promoted \(human_submit_observed\)/);
  assert.ok(fx.audits("portal_recipe.promotion_refused").some((a) => a.details.includes(id)), "no audit row for the refusal");
  recipes.promoteRecordingIfEligible(db, id, { finishedBy: "operator", via: "mark_submitted" });
  assert.equal(sequenceSegments(recipes.getPortalRecipe(db, id).notes).length, 1, "a second refusal grew the notes");
});

await check("D2 the automatic door still promotes the Coos Bay shape, with no flag", () => {
  const id = freshRecording(COOS_BAY_SHAPE);
  const out = recipes.promoteRecordingIfEligible(db, id, { finishedBy: "operator", via: "mark_submitted" });
  assert.equal(out?.status, "complete", "a replayable sequence must still promote");
  assert.equal(recipes.getPortalRecipe(db, id).flagReason, "");
});

await check("D2b the automatic door is NOT refused by the zero-upload note: it promotes, unflagged, and notes it once", () => {
  // PSE / Ameren / PacifiCorp: complete recipes with no upload step. The note is shown, never a refusal.
  const noUploads = COOS_BAY_SHAPE.filter((s) => s.action !== "upload" && !/^attachment:/.test(String(s.note ?? "")));
  const id = freshRecording(noUploads);
  const out = recipes.promoteRecordingIfEligible(db, id, { finishedBy: "operator", via: "mark_submitted" });
  assert.equal(out?.status, "complete", "the zero-upload note refused an automatic promotion");
  const r = recipes.getPortalRecipe(db, id);
  assert.equal(r.flagReason, "", "the zero-upload note raised the dashboard flag");
  assert.equal(sequenceSegments(r.notes).length, 1);
  assert.match(sequenceSegments(r.notes)[0], /no step uploads a document/);
});

await check("D3 a PERSON's save promotes the looped learn anyway — and is shown the same findings (response, note, flag)", () => {
  const id = freshRecording([...LOOPED, FINAL]);
  const done = recipes.finishPortalRecipe(db, id, "Pat Reviewer");
  assert.equal(done.status, "complete", "a person must never be blocked");
  assert.ok(Array.isArray(done.sequenceProblems), "the person's save does not return what the sequence check found");
  assert.deepEqual(done.sequenceProblems.filter((p) => p.refusesPromotion).map((p) => p.kind).sort(), ["conflicting_write", "refused_advance"]);
  assert.ok(done.flagReason.startsWith(recipes.RECIPE_SEQUENCE_FLAG_PREFIX), `the dashboard flag was not raised: "${done.flagReason}"`);
  assert.match(done.flagReason, /promoted by Pat Reviewer although the recorded sequence cannot replay as recorded/);
  assert.match(sequenceSegments(done.notes)[0] ?? "", /promoted by Pat Reviewer although/);
  assert.match(done.notes, /\[verified by Pat Reviewer — promoted from recording\]/);
  assert.ok(fx.audits("portal_recipe.promoted_over_sequence_findings").some((a) => a.details.includes(id)), "no audit row for the person's promotion over the findings");
});

await check("D4 clean steps clear this check's own flag and note on a person's save — never another flag", () => {
  const id = freshRecording([...LOOPED, FINAL]);
  recipes.promoteRecordingIfEligible(db, id, { finishedBy: "operator", via: "mark_submitted" }); // refused: flag + note
  const refused = recipes.getPortalRecipe(db, id);
  assert.ok(refused.status === "recording" && refused.flagReason.startsWith(recipes.RECIPE_SEQUENCE_FLAG_PREFIX ?? "Sequence check:"),
    `setup: the automatic door must refuse and flag the looped recording (status ${refused.status}, flag "${refused.flagReason}")`);
  recipes.savePortalRecipeSteps(db, id, COOS_BAY_SHAPE); // the person fixed the steps
  const fixed = recipes.finishPortalRecipe(db, id, "Pat Reviewer");
  assert.equal(fixed.flagReason, "", "the stale sequence flag survived clean steps");
  assert.deepEqual(sequenceSegments(fixed.notes), [], "the stale sequence note survived clean steps");
  // Another writer's flag (an unattributed replay failure) is not this check's to clear. Set directly:
  // its own writer (demoteOnReplayFailure) acts only on a complete recipe, and this one is a recording.
  const other = freshRecording(COOS_BAY_SHAPE);
  db.run("UPDATE portal_recipes SET flag_reason = ?, flagged_at = ? WHERE id = ?", ["A replay failed and the failure could not be attributed (x)", "2026-11-14T00:00:00Z", other]);
  assert.match(recipes.finishPortalRecipe(db, other, "Pat Reviewer").flagReason, /^A replay failed/, "a foreign flag was cleared");
});

await check("D4b a re-record whose notes began with the snapshot marker: the person's save REPLACES the refusal's note, never keeps both", () => {
  const scope = { scopeType: "ahj" as const, state: "OR", ahj: `City of Sequence ${++scopeSeq}`, portalUrl: "https://permits.example.test/Portal/" };
  const first = recipes.startPortalRecording(db, scope);
  recipes.savePortalRecipeSteps(db, first.id, [GOTO, fillId("w_a", "homeownerName", "Name")]); // notes stay empty
  const again = recipes.startPortalRecording(db, scope); // notes are now just the snapshot marker
  recipes.savePortalRecipeSteps(db, again.id, [...LOOPED, FINAL]);
  recipes.promoteRecordingIfEligible(db, again.id, { finishedBy: "operator", via: "mark_submitted" });
  assert.match(recipes.getPortalRecipe(db, again.id).notes, /not promoted \(mark_submitted\)/, "setup: the automatic door must refuse and note it");
  const done = recipes.finishPortalRecipe(db, again.id, "Pat Reviewer");
  assert.doesNotMatch(done.notes, /not promoted \(mark_submitted\)/, `the refusal's stale note survived beside the person's: ${done.notes.slice(0, 300)}`);
  assert.equal(sequenceSegments(done.notes).length, 1);
  assert.match(sequenceSegments(done.notes)[0], /promoted by Pat Reviewer although/);
});

await check("D5 an abandoned re-record restored to its proven snapshot drops the sequence flag written about the abandoned steps", () => {
  // A small working recipe, made complete by a person (the real path)...
  const scope = { scopeType: "ahj" as const, state: "OR", ahj: `City of Sequence ${++scopeSeq}`, portalUrl: "https://permits.example.test/Portal/" };
  const first = recipes.startPortalRecording(db, scope);
  recipes.savePortalRecipeSteps(db, first.id, [GOTO, fillId("w_a", "homeownerName", "Name"), fillId("w_b", "street", "Street"),
    S({ action: "upload", phase: "fill", selector: { css: '[data-al-upl="f0"]' }, docType: "plan_set", note: "upload plan_set: Attach" }), advance("Next"), FINAL]);
  recipes.finishPortalRecipe(db, first.id, "Pat Reviewer");
  // ...re-recorded (its steps parked as a PROVEN snapshot), the re-record loops and is refused...
  const again = recipes.startPortalRecording(db, scope);
  assert.equal(again.id, first.id, "setup: the re-record resets the same row");
  recipes.savePortalRecipeSteps(db, again.id, [...LOOPED, FINAL]);
  recipes.promoteRecordingIfEligible(db, again.id, { finishedBy: "operator", via: "mark_submitted" });
  assert.ok(recipes.getPortalRecipe(db, again.id).flagReason.startsWith(recipes.RECIPE_SEQUENCE_FLAG_PREFIX ?? "Sequence check:"), "setup: the looped re-record must be refused and flagged");
  // ...and abandoned: the sweep hands back the working recipe, without a flag about steps it no longer has.
  assert.equal(recipes.restoreRecipeSnapshotIfAbandoned(db, again.id), "complete");
  const back = recipes.getPortalRecipe(db, again.id);
  assert.equal(back.flagReason, "", `the restored working recipe still carries the abandoned steps' flag: "${back.flagReason}"`);
  assert.deepEqual(sequenceSegments(back.notes), [], "the restored working recipe still carries the abandoned steps' note");
});

await check("D5b the restore keeps the sequence flag when the abandoned steps are the ones kept, and never clears another writer's flag", () => {
  // (i) An UNPROVEN, shallower snapshot gives way to the abandoned attempt's own deeper steps: the flag
  //     describes the steps still there, so it stays.
  const scope = { scopeType: "ahj" as const, state: "OR", ahj: `City of Sequence ${++scopeSeq}`, portalUrl: "https://permits.example.test/Portal/" };
  const shallow = recipes.startPortalRecording(db, scope);
  recipes.savePortalRecipeSteps(db, shallow.id, [GOTO, fillId("w_a", "homeownerName", "Name")]); // never promoted
  const deeper = recipes.startPortalRecording(db, scope);
  assert.equal(deeper.id, shallow.id, "setup: the re-record resets the same row");
  recipes.savePortalRecipeSteps(db, deeper.id, [...LOOPED, FINAL]);
  recipes.promoteRecordingIfEligible(db, deeper.id, { finishedBy: "operator", via: "mark_submitted" });
  assert.ok(recipes.getPortalRecipe(db, deeper.id).flagReason.startsWith(recipes.RECIPE_SEQUENCE_FLAG_PREFIX), "setup: the looped re-record must be refused and flagged");
  assert.equal(recipes.restoreRecipeSnapshotIfAbandoned(db, deeper.id), "needs_rerecord");
  const kept = recipes.getPortalRecipe(db, deeper.id);
  assert.equal(kept.steps.length, LOOPED.length + 1, "setup: the deeper abandoned steps should be the ones kept");
  assert.ok(kept.flagReason.startsWith(recipes.RECIPE_SEQUENCE_FLAG_PREFIX), `the flag about the steps still there was cleared: "${kept.flagReason}"`);
  assert.equal(sequenceSegments(kept.notes).length, 1, "the note about the steps still there was cleared");
  // (ii) A proven snapshot restored over a re-record that carries ANOTHER writer's flag: not this check's to clear.
  const scope2 = { ...scope, ahj: `City of Sequence ${++scopeSeq}` };
  const first = recipes.startPortalRecording(db, scope2);
  recipes.savePortalRecipeSteps(db, first.id, [GOTO, fillId("w_a", "homeownerName", "Name"), fillId("w_b", "street", "Street"),
    S({ action: "upload", phase: "fill", selector: { css: '[data-al-upl="f0"]' }, docType: "plan_set", note: "upload plan_set: Attach" }), advance("Next"), FINAL]);
  recipes.finishPortalRecipe(db, first.id, "Pat Reviewer");
  const again = recipes.startPortalRecording(db, scope2);
  recipes.savePortalRecipeSteps(db, again.id, [...LOOPED, FINAL]);
  db.run("UPDATE portal_recipes SET flag_reason = ?, flagged_at = ? WHERE id = ?", ["A replay failed and the failure could not be attributed (x)", "2026-11-14T00:00:00Z", again.id]);
  assert.equal(recipes.restoreRecipeSnapshotIfAbandoned(db, again.id), "complete");
  assert.match(recipes.getPortalRecipe(db, again.id).flagReason, /^A replay failed/, "the restore cleared another writer's flag");
});

// ── E. the learn's trust gate, end to end ──────────────────────────────────────────────────────
let nextLearn: Record<string, unknown> = {};
const failedLearn = { ok: false, portalName: "stub", steps: [], reviewScreen: { fields: [], bodyTextSnippet: "" }, finalSubmitRecorded: false, pageCount: 0, pauseReason: null, message: "stub learn: nothing walked" };
autoLearn.setAutoLearnSeamsForTests({ learnPortal: (async () => ({ ...failedLearn, ...nextLearn })) as never });
const verified = {
  accurate: true, overallConfidence: "high" as const, issues: [], notes: "",
  matches: [
    { label: "Owner", expected: "x", found: "x", ok: true },
    { label: "Address", expected: "x", found: "x", ok: true },
    { label: "Valuation", expected: "x", found: "x", ok: true },
  ],
};
const base = llmMod.createLLMProvider(); // no API key -> the stub provider
autoLearn.setAutoLearnSeamsForTests({
  llm: () => Object.assign(Object.create(base), {
    verifyPortalFill: async () => verified,
    verifyPortalFillVision: async () => verified,
    planPortalFields: async () => ({ fills: [], advanceIndex: null, navigateIndex: null, finalSubmitIndex: null, atReview: false, notes: "" }),
  }),
});
/** A four-page walk that reached review with six bound fills (every form page read) — enough to
 *  clear every other bar. `loop`: the advance after page 1 is followed by page 1's own ids again.
 *  The steps are the learner's real output shape: it writes NO stopForReview (none of the 22 saved
 *  recipes carries one); its review is the walk's reachedReview, and its terminal step the recorded
 *  submit — which `noSubmit` leaves out, as a pay- or signature-worded submit is (isOffLimitsButton). */
async function learnWith(portalUrl: string, loop: boolean, opts: { noSubmit?: boolean; requiredFieldMisses?: string[] } = {}) {
  const projectId = fx.newProject();
  const project = repo.getProjectDetail(db, projectId).project;
  const replay = recipes.resolveRecipeFieldValues(db, project, "AHJ", "building");
  const keys = Object.keys(replay).filter((k) => String(replay[k] ?? "").trim() && !/acc(oun)?t|meter|ssn|passw/i.test(k)).slice(0, 6);
  assert.ok(keys.length >= 6, `fixture: need 6 bindable fields, got ${keys.join(",")}`);
  const fillAt = (k: string, idKey: string) => S({ action: "fill", phase: "fill", selector: { label: k }, field: k, note: k, fingerprint: { id: idKey } });
  nextLearn = {
    ok: true, portalName: "Example Permits", pageCount: 4, pauseReason: null, finalSubmitRecorded: !opts.noSubmit,
    reachedReview: true, filledSomething: true, message: "reached review",
    steps: [
      S({ action: "goto", value: portalUrl, note: "entry url" }),
      fillAt(keys[0], "p1_a"), fillAt(keys[1], "p1_b"), fillAt(keys[2], "p1_c"),
      advance("Next Step"),
      ...(loop ? [fillAt(keys[0], "p1_a"), fillAt(keys[1], "p1_b")] : []),
      fillAt(keys[3], "p2_a"), fillAt(keys[4], "p2_b"), fillAt(keys[5], "p2_c"),
      advance("Next Step"),
      ...(opts.noSubmit ? [] : [FINAL]),
    ],
    reviewScreen: { fields: [{ label: "Owner", value: "x" }], bodyTextSnippet: "Review your application before submitting." },
    reviewScreenshotBase64: "iVBORw0KGgo=",
    requiredFieldMisses: opts.requiredFieldMisses ?? [], missingRequiredDocs: [], validationBlocks: [], equipmentNotHeld: [],
    pageExitReads: { read: [2, 3, 4], unread: [] },
  };
  const result = await autoLearn.autoLearnPortal(db, projectId, { scope: "ahj", portalUrl, createdBy: "operator" });
  const recipe = result.recipe ? recipes.getPortalRecipe(db, result.recipe.id) : null;
  return { result, recipe, issues: (result.verification?.issues ?? []).join(" | ") };
}

// The problem case first, on its own portal: a trusted recipe would turn a later run into the
// protect-complete path, which proves nothing about the gate.
await check("E1 a learn whose saved steps re-fill page 1 after its advance is NOT trusted, and the issue says why", async () => {
  const r = await learnWith("https://permits.loop.example.test/apply", true);
  assert.notEqual(r.result.status, "trusted", `the looped learn was TRUSTED (${String(r.result.message).slice(0, 200)})`);
  assert.notEqual(r.recipe?.status, "complete", "the shared recipe was promoted to complete");
  assert.match(r.issues, /recorded sequence cannot replay as recorded — the advance at step 5 \("Next Step"\) did not leave its page/, r.issues.slice(0, 400));
});

await check("E2 the same walk without the loop IS trusted (the over-correction guard)", async () => {
  const r = await learnWith("https://permits.clean.example.test/apply", false);
  assert.equal(r.result.status, "trusted", `the clean learn was not trusted: ${String(r.result.message).slice(0, 300)} | ${r.issues.slice(0, 300)}`);
  assert.equal(r.recipe?.status, "complete");
  assert.match(String(r.recipe?.notes ?? ""), /^Auto-learned and verified \(high confidence\) on 4 page\(s\)\./, "the matching-key lead sentence moved");
  // The zero-upload note rides on the trusted recipe as its own segment AFTER the lead sentence.
  assert.match(String(r.recipe?.notes ?? ""), /^Auto-learned and verified[^|]*\| \[sequence check: no step uploads a document/, "the zero-upload note is not on the trusted recipe's notes");
});

await check("E3 a learn whose walk REACHED REVIEW but kept no submit step is still trusted — not \"never reached review\"", async () => {
  const r = await learnWith("https://permits.offlimits.example.test/apply", false, { noSubmit: true });
  assert.equal(r.result.status, "trusted", `a learn that reached review with no recordable submit was refused: ${String(r.result.message).slice(0, 300)} | ${r.issues.slice(0, 300)}`);
  assert.equal(r.recipe?.status, "complete");
  assert.doesNotMatch(r.issues, /no recorded final submit|reaching the review screen/);
});

await check("E4 the zero-upload note never takes a slot ahead of a hard blocker in the learn's issues", async () => {
  const r = await learnWith("https://permits.blank.example.test/apply", false, { requiredFieldMisses: ["Applicant Email"] });
  assert.notEqual(r.result.status, "trusted", "setup: a required blank must block");
  const issues = r.result.verification?.issues ?? [];
  const blank = issues.findIndex((x) => /Required field\(s\) left blank/.test(x));
  const note = issues.findIndex((x) => /^Sequence note:/.test(x));
  assert.ok(blank >= 0 && note >= 0, `setup: both issues expected: ${JSON.stringify(issues).slice(0, 300)}`);
  assert.ok(blank < note, `the zero-upload note came before the required-blank blocker: ${JSON.stringify(issues).slice(0, 300)}`);
});

// ── F. the fix round (#241 review): shapes that replay as recorded ──────────────────────────────
/** A PowerClerk-shaped recording (per-page id tokens) that reached review: page 1, page 2, review. */
const pcFill = (id: string, field: string, label: string) => S({ action: "fill", phase: "fill", selector: { role: "textbox", name: label }, field, note: label, fingerprint: { id } });
const pcSelect = (id: string, value: string, label: string, note = label) => S({ action: "select", phase: "fill", selector: { role: "combobox", name: label }, value, note, fingerprint: { id } });
const PC_WALK = [
  S({ action: "goto", value: "https://example-nem.powerclerk.test/", note: "entry url" }),
  S({ action: "click", phase: "open", selector: { role: "link", name: "New Interconnection Application" }, note: "navigate to application: New Interconnection Application" }),
  pcFill("pcInputBase1", "homeownerName", "Customer Name"), pcFill("pcInputBase2", "street", "Service Address"),
  advance("Next page"), // index 4
  pcSelect("pcInputBase11", "Solar", "Generator Type"), pcFill("pcInputBase12", "moduleQty", "Module Quantity"),
  advance("Next page"), // index 7 — the review page
  S({ action: "upload", phase: "fill", selector: { css: '[data-al-upl="f0"]' }, docType: "plan_set", note: "upload plan_set: One-line diagram" }),
];
const PC_FINAL = S({ action: "click", phase: "review", selector: { role: "button", name: "Submit" }, isFinalSubmit: true, note: "final submit: Submit (recorded, NOT clicked)" });
const humanPatch = (s: Record<string, unknown>) => S({ ...s, note: `human-patch: ${String(s.label)}`, label: undefined });
const PATCH = [
  humanPatch({ action: "click", selector: { role: "button", name: "Previous page" }, label: "Previous page" }),
  humanPatch({ action: "select", selector: { role: "combobox", name: "Generator Type" }, value: "Solar + Storage", fingerprint: { id: "pcInputBase11" }, label: "Generator Type" }),
  humanPatch({ action: "click", selector: { role: "button", name: "Next page" }, label: "Next page" }),
];

await check("F1 the patch-by-demonstration flow — advance, a person's \"Previous page\", a corrected box, \"Next page\" — carries no finding", () => {
  assert.deepEqual(recipeSequenceProblems([...PC_WALK, ...PATCH, PC_FINAL]).map((x) => x.detail), [], "a person's correction on the page before review was read as a refused advance");
  // The same box re-typed with the same answer, too.
  const retyped = [PATCH[0], humanPatch({ action: "select", selector: { role: "combobox", name: "Generator Type" }, value: "Solar", fingerprint: { id: "pcInputBase11" }, label: "Generator Type" }), PATCH[2]];
  assert.deepEqual(recipeSequenceProblems([...PC_WALK, ...retyped, PC_FINAL]).map((x) => x.detail), []);
  // Without the person's navigation the same write IS the looped shape (the narrowing is the click, nothing else).
  assert.deepEqual(kinds(refusing(recipeSequenceProblems([...PC_WALK, PATCH[1], PC_FINAL]))).sort(), ["conflicting_write", "refused_advance"]);
});

await check("F2 the same patch on the real write path: appended at review, the submit seen — the automatic door promotes it, unflagged", () => {
  const id = freshRecording([...PC_WALK, PC_FINAL]);
  recipes.appendHumanPatchSteps(db, id, PATCH.map((s) => ({ ...s })), {});
  const merged = recipes.getPortalRecipe(db, id).steps;
  assert.deepEqual(merged.map((s) => String(s.note ?? "").slice(0, 24)).slice(-4), ["human-patch: Previous pa", "human-patch: Generator T", "human-patch: Next page", "final submit: Submit (re"], "setup: the patch must merge before the recorded submit");
  const out = recipes.promoteRecordingIfEligible(db, id, { finishedBy: "operator (submitted in review browser)", via: "human_submit_observed" });
  const r = recipes.getPortalRecipe(db, id);
  assert.equal(out?.status, "complete", `the person's patched recording was refused: "${r.flagReason.slice(0, 260)}"`);
  assert.equal(r.flagReason, "");
  assert.deepEqual(sequenceSegments(r.notes), []);
});

await check("F3 a healed draft-only Part 1 a PERSON saves is not told it never reached review; with no heal record it still is", () => {
  // PSE's Part 1 shape: one page, the Submit only creates a draft. The heal takes isFinalSubmit off it.
  const PART1 = [
    S({ action: "goto", value: "https://example-nem.powerclerk.test/", note: "entry url" }),
    S({ action: "click", phase: "open", selector: { role: "link", name: "New Interconnection Application Part 1" }, note: "navigate to application: New Interconnection Application Part 1" }),
    S({ action: "click", phase: "open", selector: { role: "link", name: "Net Metering" }, note: "permit type: Net Metering" }),
    pcFill("Q1EXAMPLEDATEInput", "todayDateUs", "Application Date"),
    pcSelect("Q2EXAMPLETYPEInput", "Net Metering", "Application Type:"),
    S({ action: "click", phase: "review", selector: { role: "button", name: "Submit" }, isFinalSubmit: true, note: "final submit: Submit (recorded, NOT clicked — single-page application)" }),
  ];
  const healedId = freshRecording(PART1);
  const heal = draftMod.healDraftCreatingFinalSubmit(db, healedId, {
    applicationNumber: "NEM-00001", nextForm: "Interconnection Application - Part 2", evidence: "Your draft application NEM-00001 has been created.",
    strength: "created", clickedLabel: "Submit", tenantKey: "example-nem.powerclerk.test",
  });
  assert.equal(heal.healed, true, `setup: the heal must take the final flag off the Submit (${heal.why})`);
  const done = recipes.finishPortalRecipe(db, healedId, "Pat Reviewer");
  assert.equal(done.status, "complete");
  assert.deepEqual(done.sequenceProblems.filter((p) => p.refusesPromotion).map((p) => p.kind), [], "the healed draft-only Part 1 was told it never reached review");
  assert.equal(done.flagReason, "", `the healed Part 1 was flagged: "${done.flagReason.slice(0, 200)}"`);
  // The same steps with the final flag gone but NO heal on record: nothing shows the recording reached its end.
  const bareId = freshRecording([...PART1.slice(0, -1), S({ ...PART1[PART1.length - 1], isFinalSubmit: undefined })]);
  const bare = recipes.finishPortalRecipe(db, bareId, "Pat Reviewer");
  assert.deepEqual(bare.sequenceProblems.filter((p) => p.refusesPromotion).map((p) => p.kind), ["never_reached_review"], "with no heal record the check must still speak");
  assert.ok(bare.flagReason.startsWith(recipes.RECIPE_SEQUENCE_FLAG_PREFIX));
});

await check("F4 one id, two recorded names: a per-render id re-used for another control is not one control", () => {
  const steps = [GOTO, ENTRY,
    S({ action: "select", phase: "fill", selector: { role: "combobox", name: "Battery Model" }, field: "batteryModel", note: "Battery Model", fingerprint: { id: "pcInputBase34" } }),
    checkId("pcInputBase35", "Battery included"),
    // a re-render renumbered the page: the same token now names the export box
    S({ action: "fill", phase: "fill", selector: { role: "textbox", name: "Total System Export (kW)" }, field: "exportKw", note: "Total System Export (kW)", fingerprint: { id: "pcInputBase34" } }),
    advance("Next page"),
    S({ action: "fill", phase: "fill", selector: { role: "textbox", name: "Inverter Manufacturer" }, field: "inverterManufacturer", note: "Inverter Manufacturer", fingerprint: { id: "pcInputBase34" } }),
    advance("Next page"), FINAL];
  assert.deepEqual(kinds(refusing(recipeSequenceProblems(steps, KNOWN_DOCS))), [], "two controls sharing a per-render id were read as one");
  // One id with the SAME name both times stays one control (A1 / A5 carry the real shapes).
});

await check("F5 an in-page dialog (no frame) used for two contacts — its Save between them — is two forms, not one control set twice", () => {
  const steps = [GOTO, ENTRY, advance("Next"),
    S({ action: "click", phase: "fill", selector: { role: "button", name: "Add Contact" }, note: "contact(applicant): add contact" }),
    fillId("contactModal_Name", "installerCompanyName", "Name"),
    S({ action: "click", phase: "fill", selector: { role: "button", name: "Save Contact" }, note: "contact(applicant): save" }),
    S({ action: "click", phase: "fill", selector: { role: "button", name: "Add Contact" }, note: "contact(owner): add contact" }),
    fillId("contactModal_Name", "homeownerName", "Name"),
    S({ action: "click", phase: "fill", selector: { role: "button", name: "Save Contact" }, note: "contact(owner): save" }),
    advance("Next"), FINAL];
  assert.deepEqual(kinds(refusing(recipeSequenceProblems(steps, KNOWN_DOCS))), [], "an in-page dialog re-opened for a second contact was read as one control set twice");
});

finish("recipe-sequence");
