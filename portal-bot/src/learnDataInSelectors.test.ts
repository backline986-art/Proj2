// A RECORDED SELECTOR NEVER CARRIES THE LEARN JOB'S DATA OR A DATE AS IDENTITY (#235).
//
// Pins learnDataInSelectors.ts, the one answer the learner and the replay share:
//   resultRowRoleOf      — a results-row pick, by role: the shapes the 2026-11-14 audit found
//                          (an address row labelled with the learn property's address, a parcel
//                          row with its parcel number, an owner row with its owner, a licence row
//                          with the company's licence number, a contact row keyed by the learn
//                          company's name in a css) — and NOT a record type, a policy answer, a
//                          yes/no radio, a contact TYPE word, or a work-location address version.
//   isVolatileLabel      — a date with its caption, a long number, the learn job's own values are
//                          not identity; a voltage "120/240", a record type, a bare "Date:" are.
//   withoutLearnDataInSelectors — the learner's last pass: no learn value or date survives in any
//                          selector level, a row pick becomes a ROW ROLE, a dated label the id.
// All values are synthetic: invented streets, parcels, licences, owners and companies.
// Run: tsx portal-bot/src/learnDataInSelectors.test.ts
import assert from "node:assert/strict";
import type { RecipeStep } from "../../shared/src/types";
import {
  carriesDate, DATE_LITERAL, identityWordsOf, isVolatileLabel, readsAsStreetAddress, resultRowRoleOf,
  RESULT_ROW_MARKER_CSS, withoutLearnDataInSelectors, type LearnIdentity,
} from "./learnDataInSelectors";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The learn job (synthetic). Another job's values never appear below except where a test says so.
const LEARN: LearnIdentity = {
  siteStreet: "4417 W Quillmere Blvd",
  ownerNames: ["Orrin Tavelwick"],
  parcels: ["R7730012645"],
  companyNames: ["Brightfold Energy LLC"],
  companyStreet: "929 Harrowgate Rd",
  companyContacts: ["555-201-7788", "office@brightfold.example"],
};
const POPUP = "ACADialogFrame";
const listStep = (list: string, row: number, label: string, section: string): RecipeStep => ({
  action: "check", phase: "fill",
  selector: { label, frame: POPUP, fallbacks: [{ css: `#ctl00_phPopup_ucSearchResult_uc${list}List_gv_CB_${row}`, frame: POPUP }] },
  note: label,
  fingerprint: { id: `ctl00_phPopup_ucSearchResult_uc${list}List_gv_CB_${row}`, name: `ctl00_phPopup_ucSearchResult_uc${list}List_gv_RadioButtonFieldGroupName`, section },
});
// The audit's shapes, re-made with invented values.
const ADDRESS_ROW = listStep("Address", 1, "4417 W QUILLMERE BLVD, Fernhollow ID 83999", "Address City State Zip");
const PARCEL_ROW = listStep("Parcel", 0, "R7730012645", "Parcel Number Lot Block Subdivision");
const OWNER_ROW = listStep("Owner", 0, "TAVELWICK ORRIN", "Name Address");
const LICENCE_ROW: RecipeStep = {
  action: "check", phase: "fill",
  selector: { label: "085531", frame: POPUP, fallbacks: [{ css: "#ctl00_phPopup_refLicenseList_gdvLicenseList_ctl02_CB_0", frame: POPUP }] },
  note: "085531",
  fingerprint: { id: "ctl00_phPopup_refLicenseList_gdvLicenseList_ctl02_CB_0", name: "ctl00$phPopup$refLicenseList$gdvLicenseList$ctl02$CB_0", section: "Showing 1-2 of 2" },
};
const CONTACT_ROW_CSS = 'tr:has-text("BRIGHTFOLD ENERGY LLC"):has-text("929")';
const CONTACT_ROW: RecipeStep = {
  action: "click", phase: "fill",
  selector: { css: `${CONTACT_ROW_CSS} a:has-text("Select"), ${CONTACT_ROW_CSS} button:has-text("Add"), ${CONTACT_ROW_CSS} input[type='radio']` },
  note: "lookup(Add Contact As : Contractor): select this client's record (the row at 929 Harrowgate)",
};
const CERT_TICK: RecipeStep = {
  action: "check", phase: "fill",
  selector: { label: "Date: 10/02/2026", fallbacks: [{ css: "#ctl00_PlaceHolderMain_capReviewCertification1_termReviewAccept" }] },
  note: "Date: 10/02/2026",
  fingerprint: { id: "ctl00_PlaceHolderMain_capReviewCertification1_termReviewAccept", name: "ctl00$PlaceHolderMain$capReviewCertification1$termReviewAccept", section: "Requirements" },
};

// ---- isVolatileLabel ------------------------------------------------------------------------
check("a date with its caption is volatile, in either date form, and the stand-in is too", () => {
  assert.equal(isVolatileLabel("Date: 10/02/2026"), true);
  assert.equal(isVolatileLabel("Today's date 2026-10-02"), true);
  assert.equal(isVolatileLabel("Date: [date]"), true);
  assert.equal(carriesDate("Signed on 1/5/2027"), true);
});
check("a long number is volatile once its digit groups are closed up (parcel, licence, phone)", () => {
  assert.equal(isVolatileLabel("R7730012645"), true);
  assert.equal(isVolatileLabel("085531"), true);
  assert.equal(isVolatileLabel("773-001-2645"), true);
});
check("...but the portal's own vocabulary stays identity: a voltage, a record type, a bare Date:", () => {
  assert.equal(isVolatileLabel("120/240"), false, "a slash is never closed up — 120/240 is a voltage");
  assert.equal(isVolatileLabel("501-622-Electrical"), false);
  assert.equal(isVolatileLabel("Date:"), false, "a bare caption names a question");
  assert.equal(isVolatileLabel("Start Date: 10/02/2026"), false, "'start' still names the question");
  assert.equal(isVolatileLabel("No"), false);
  assert.equal(isVolatileLabel(""), false, "an absent label is not a volatile one");
});
check("the learn job's own values are volatile only with its identity (the learner's reading)", () => {
  assert.equal(isVolatileLabel("TAVELWICK ORRIN"), false);
  assert.equal(isVolatileLabel("TAVELWICK ORRIN", LEARN), true);
  assert.deepEqual(identityWordsOf("Owner: Orrin Tavelwick", LEARN), ["owner"]);
});
check("DATE_LITERAL is the backend's anchored date grammar, unchanged", () => {
  assert.equal(DATE_LITERAL.source, String.raw`^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})$`);
  assert.equal(DATE_LITERAL.test("10/02/2026"), true);
  assert.equal(DATE_LITERAL.test("10/02/26"), false);
});
check("readsAsStreetAddress: a house number, a street word and a suffix or ZIP — never a record type or a question", () => {
  assert.equal(readsAsStreetAddress("4417 W QUILLMERE BLVD, Fernhollow ID 83999"), true);
  assert.equal(readsAsStreetAddress("88 Larkspur Lane"), true);
  assert.equal(readsAsStreetAddress("501-622-Electrical"), false);
  assert.equal(readsAsStreetAddress("Building - Residential (1 & 2 Family)"), false);
  assert.equal(readsAsStreetAddress("Is the system 2 stories or more?"), false);
  assert.equal(readsAsStreetAddress("Date: 10/02/2026"), false);
});

// ---- resultRowRoleOf: the replay's reading (no identity) ------------------------------------
check("the audit's row shapes read as their roles with no identity at all (recipes recorded before)", () => {
  assert.equal(resultRowRoleOf(ADDRESS_ROW), "address");
  assert.equal(resultRowRoleOf(PARCEL_ROW), "parcel");
  assert.equal(resultRowRoleOf(OWNER_ROW), "owner");
  assert.equal(resultRowRoleOf(LICENCE_ROW), "licence");
  assert.equal(resultRowRoleOf(CONTACT_ROW), "contact");
});
check("an explicit rowRole is the answer", () => {
  assert.equal(resultRowRoleOf({ action: "check", selector: { css: RESULT_ROW_MARKER_CSS }, rowRole: "parcel" }), "parcel");
});
check("a certification tick, a yes/no radio, a record type and a policy answer are never rows", () => {
  assert.equal(resultRowRoleOf(CERT_TICK), null);
  assert.equal(resultRowRoleOf({ action: "check", selector: { label: "No", fallbacks: [{ css: "#ctl00_PlaceHolderMain_AppSpecEdit_TOWN_rdo_0_3_1" }] }, note: "No" }), null);
  assert.equal(resultRowRoleOf({ action: "check", selector: { label: "501-622-Electrical", fallbacks: [{ css: "#ctl00_PlaceHolderMain_capTypeListControl_rptPermitTypeGroup_ctl02_rptPermitTypeCont_ctl02_permitType" }] }, note: "record type (verified): 501-622-Electrical" }), null);
  assert.equal(resultRowRoleOf({ action: "check", selector: { label: "4417 W QUILLMERE BLVD" }, note: "policy default: 4417 W QUILLMERE BLVD -> Yes" }), null);
  assert.equal(resultRowRoleOf({ ...ADDRESS_ROW, isFinalSubmit: true }), null);
});
check("a contact TYPE in a contact list is the portal's word, not a row's data", () => {
  const typeWord: RecipeStep = {
    action: "check", selector: { label: "Associated Contact", frame: POPUP, fallbacks: [{ css: "#ctl00_phPopup_contactSearchList_gdvSearchContactList_CB_0", frame: POPUP }] },
    note: "Associated Contact", fingerprint: { id: "ctl00_phPopup_contactSearchList_gdvSearchContactList_CB_0", section: "Category Type Name" },
  };
  assert.equal(resultRowRoleOf(typeWord), null);
});
check("a work-location address VERSION keeps its own matcher (its css names the version, not the job)", () => {
  assert.equal(resultRowRoleOf({ action: "click", selector: { css: 'tr:has-text("CITY APPLICATIONS") a:has-text("Select")' }, note: "work location: select city/structural address row" }), null);
});
check("a long number outside any list is not routed by shape (it has no row to be)", () => {
  assert.equal(resultRowRoleOf({ action: "check", selector: { label: "085531", fallbacks: [{ css: "#chkAgree085531" }] }, note: "085531" }), null);
});

// ---- resultRowRoleOf: the learner's reading (with identity) ---------------------------------
check("with the learn identity, a row carrying the learn company's name or street is its contact record", () => {
  assert.equal(resultRowRoleOf({ action: "click", selector: { role: "link", name: "Brightfold Energy LLC" }, note: "pick" }, LEARN), "contact");
  assert.equal(resultRowRoleOf({ action: "check", selector: { label: "929 HARROWGATE RD" } }, LEARN), "contact");
});
check("...and an attestation that only mentions the owner is not a row", () => {
  assert.equal(resultRowRoleOf({ action: "check", selector: { label: "Is Orrin Tavelwick the owner of record?" } }, LEARN), null);
});

// ---- withoutLearnDataInSelectors: the learner's last pass -----------------------------------
const learnedValues = ["4417", "QUILLMERE", "R7730012645", "TAVELWICK", "BRIGHTFOLD", "929", "Harrowgate", "10/02/2026", "085531"];
const leaks = (steps: RecipeStep[]): string[] => {
  const out: string[] = [];
  for (const st of steps) {
    const sel = JSON.stringify([st.selector, st.note]).toUpperCase();
    for (const v of learnedValues) if (sel.includes(v.toUpperCase())) out.push(`${st.note}: ${v}`);
  }
  return out;
};
check("no learn value or date survives in a selector or a note; row picks become ROW ROLES", () => {
  const { steps, changed } = withoutLearnDataInSelectors([ADDRESS_ROW, PARCEL_ROW, OWNER_ROW, LICENCE_ROW, CONTACT_ROW, CERT_TICK], LEARN);
  assert.deepEqual(leaks(steps), []);
  assert.deepEqual(steps.slice(0, 5).map((s) => s.rowRole), ["address", "parcel", "owner", "licence", "contact"]);
  assert.equal(changed.length, 6);
  for (const s of steps.slice(0, 5)) {
    assert.equal(s.selector?.css, RESULT_ROW_MARKER_CSS, "a marker that never resolves on replay");
    assert.equal(s.selector?.fallbacks, undefined, "no recorded row position survives as a fallback");
  }
  assert.equal(steps[0].selector?.frame, POPUP, "the frame is kept: the picker reads the dialog's grid");
  assert.match(String(steps[0].note), /^address row:/, "the wording replay routes to its address matcher");
  assert.equal(steps[1].fingerprint?.id, PARCEL_ROW.fingerprint?.id, "the id is kept to find the GRID, never the row");
});
check("a dated label becomes the control's own id; the note keeps its caption with the date stood in", () => {
  const { steps } = withoutLearnDataInSelectors([CERT_TICK], LEARN);
  assert.equal(steps[0].selector?.label, undefined);
  assert.equal(steps[0].selector?.css, '[id="ctl00_PlaceHolderMain_capReviewCertification1_termReviewAccept"]');
  assert.equal(steps[0].note, "Date: [date]");
  assert.equal(isVolatileLabel(String(steps[0].note)), true, "replay reads the stood-in note as volatile");
  assert.equal(steps[0].rowRole, undefined);
});
check("a step carrying nothing of the learn job passes through untouched (same object)", () => {
  const plain: RecipeStep = { action: "fill", selector: { label: "Number of Units:", fallbacks: [{ css: "#txtUnits" }] }, note: "Number of Units:", field: "dwellingUnits" };
  const { steps, changed } = withoutLearnDataInSelectors([plain, { action: "goto", value: "https://portal.example/apply" }], LEARN);
  assert.equal(steps[0], plain);
  assert.equal(changed.length, 0);
});
check("a level naming the learn company is dropped when another level remains", () => {
  const st: RecipeStep = { action: "click", selector: { role: "button", name: "Brightfold Energy LLC", fallbacks: [{ css: "#acctMenu" }] }, note: "advance: account" };
  const { steps } = withoutLearnDataInSelectors([st], LEARN);
  assert.equal(steps[0].selector?.name, undefined);
  assert.equal(steps[0].selector?.css, "#acctMenu");
});

if (failures) { console.error(`\n${failures} learnDataInSelectors check(s) failed`); process.exit(1); }
console.log("\nlearnDataInSelectors: all checks passed");
