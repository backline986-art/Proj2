// A RENDER COUNTER OR ROW ORDINAL IS NOT AN IDENTITY (#234) — the one classifier, pinned.
//
// The 2026-11-14 audit of all 22 saved recipes: PowerClerk's pcInputBaseN, formly_N_, mat-...-N,
// ASP.NET's row ctlNN / gv_CB_N and DOPL's Dc-N are counters, and replay let them move a write into
// the neighbouring box. The ids below are portal DOM field ids taken from that corpus, most of them
// copied as recorded (field tokens and element ids, no customer data), plus a few made-up shapes
// (the React and JSF ids). MUST-VOLATILE: the counters. MUST-STABLE: the identities replay leans on today —
// PowerClerk's interleaved field tokens (radio option ids with a 5-digit key, the contact block's
// <token>First/<token>Address), Accela's ctl00_PlaceHolderMain_* ids and its ASI ids, CityView's
// PRPermitN_att* ids, iWorQ's field<6-digit key>, and plain semantic ids.
//
// Run: npx tsx portal-bot/src/adapters/volatileControlId.test.ts
import assert from "node:assert/strict";
import { isVolatileControlId, volatileControlIdKind } from "../../../shared/src/volatileControlId";

let failures = 0;
const t = (name: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${e instanceof Error ? e.message : String(e)}`); }
};

const MUST_VOLATILE: string[] = [
  // PowerClerk render counter (one control learned as 8 and as 79).
  "pcInputBase8", "pcInputBase79", "pcInputBase11", "#pcInputBase14",
  // Angular formly / Material (ComEd).
  "formly_6_itc-input_project_name_0", "formly_9_itc-input_city_0", "formly_6_radio_existing_ia_1_1-input",
  "mat-input-1", "mat-radio-2-input", "mat-radio-group-1", "mat-mdc-form-field-label-3",
  // ASP.NET row ordinals past the first segment (Accela permit-type rows, attachment rows, grids).
  "ctl00_PlaceHolderMain_capTypeListControl_rptPermitTypeGroup_ctl00_rptPermitTypeCont_ctl02_permitType",
  "ctl00_PlaceHolderMain_Attachment_1234Edit_dlDocumentEdit_ctl00_documentEdit_ddlDocType",
  "ctl00$phPopup$refLicenseList$gdvLicenseList$ctl02$CB_0",
  "ctl00_phPopup_ucAddressSearchResult_ucAddressList_gv_CB_1",
  "ctl00_phPopup_contactSearchList_gdvSearchContactList_CB_0",
  // DOPL.
  "Dc-91",
  // The generic rule: widget words + a short number, React useId, Tyler's group/field ordinals.
  "autocomplete_1", "input-12", "field7", "ember123", ":r1a:", "g_0_f_3", "widget-6-input",
  // React useId in each version's spelling, alone and behind a library prefix.
  ":R6l6:", "radix-:r3:", "«r1a»", "_r_1b_", ":r1a:-form-item",
];
const MUST_STABLE: string[] = [
  // PowerClerk field tokens: letters and digits interleaved, radio option keys of 5-6 digits.
  "QZ7K4MW2PLX9Input_25393", "HKE142YRNPQNInput_200273", "NY2ZFR6CP3D3Input_68", "10V4CD5H7W6VInput",
  "6SBQY3V4BA4EFirst", "R4TN8WE3Z1BBAddress", "MTYQPJJ5PZGEInput",
  "ExternalDataSelectorElement77RVH5AU9HRZ Energy Storage",
  // Accela: the master page's ctl00 is not an ordinal; ASI ids are form config.
  "ctl00_PlaceHolderMain_OwnerEdit_txtEmail", "OwnerEdit_txtEmail", "ctl00$OwnerEdit_txtEmail",
  "ctl00_phPopup_ucContactInfo_txtAppPhone3", "ctl00_PlaceHolderMain_OwnerEdit_ddlAppState_State1",
  "ctl00_PlaceHolderMain_AppSpec1E1D5A1EEdit_SAMPLE_TOWN_txt_0_3", "ctl00_PlaceHolderMain_Applicant_9479Edit_btnAddFromSaved",
  "ctl00_PlaceHolderMain_WorkLocationEdit_txtStreetNo",
  // CityView / iWorQ / Tyler / plain.
  "PRPermit21_attUtilityCustomerEmail", "PRPermit1_BuildingUse", "quantity_ELEC_0_6668_0",
  "field267055", "fee244341", "Amps201400", "AmpsUnder200", "NextButton", "HeaderNextBtn", "txtAppCity", "Phone3",
  // JSF / PrimeFaces colon-separated ids: a segment starting in "r" is not React's useId.
  "form:region:city", "applicationForm:roofType:input", "j_idt12:rate:0",
];

t("MUST-VOLATILE: every counter / ordinal shape reads volatile", () => {
  const missed = MUST_VOLATILE.filter((id) => !isVolatileControlId(id));
  assert.deepEqual(missed, [], `read as identities: ${missed.join(", ")}`);
});
t("MUST-STABLE: every identity shape replay relies on reads stable", () => {
  const wrong = MUST_STABLE.filter((id) => isVolatileControlId(id)).map((id) => `${id} (${volatileControlIdKind(id)})`);
  assert.deepEqual(wrong, [], `read as counters: ${wrong.join(", ")}`);
});
t("nothing recorded is not a counter (an absent id is not evidence either way)", () => {
  for (const v of [undefined, null, "", "   ", "#"]) assert.equal(isVolatileControlId(v), false, JSON.stringify(v));
});
t("the kind names the family, for the run's notes", () => {
  assert.equal(volatileControlIdKind("pcInputBase11"), "PowerClerk render counter");
  assert.equal(volatileControlIdKind("ctl00_x_gdvList_ctl03_chkSelect"), "ASP.NET row ordinal");
  assert.equal(volatileControlIdKind("autocomplete_2"), "render counter or position");
});

if (failures) { console.error(`\n${failures} volatile-id classifier check(s) FAILED.`); process.exit(1); }
console.log("\nAll volatile-id classifier checks passed.");
