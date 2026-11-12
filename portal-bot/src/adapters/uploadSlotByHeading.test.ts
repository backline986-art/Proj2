// A SLOT NAMED BY ITS HEADING TAKES ITS OWN DOCUMENT OR NOTHING (#140).
//
// City of Star's iWorQ form (watched learn 2026-11-11) heads its two required slots "Bid" and
// "Plans". Once tagUploadControls reads the heading (reviewPageUpload.dom.smoke [C]/[D]), the label
// alone must decide the document:
//
// MUST-PASS    "Plans" is the plan set — on the review page too, where only an exact match attaches
//              (exactOnly); a job that holds its bid gets the bid into "Bid".
// MUST-EXCLUDE "Bid" never receives a stand-in, in any mode: not the review page's exact pass, not
//              split mode's required fallback tiers, not combined mode's plan-set-everywhere; and the
//              replay sweep skips it (uploadForbidsSubstitute) unless the job holds a bid.
//              "Stamped plans" / "Landscape plans" are not the bare word and keep their old reading.
//
// Run: npx tsx portal-bot/src/adapters/uploadSlotByHeading.test.ts
// Constructing the learner starts a debug bundle (LearnRunDebug.start) — keep it out of data/learn-runs.
import "../smokeArtifactDirs";
import assert from "node:assert/strict";
import { AutoLearnAdapter, catchAllUploadSlot, exactUploadDocType, formsSlotDocTypes, uploadForbidsSubstitute, uploadSlotTakesPlans, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${e instanceof Error ? e.message : String(e)}`); }
};
const planner: LearnPlanner = async () => ({ fills: [], atReview: false });
const PLAN = { plan_set: "C:/nope/ZZTEST-plan-set.pdf" };
const WITH_BID = { ...PLAN, bid: "C:/nope/ZZTEST-bid.pdf" };
const pick = (docs: Record<string, string>, label: string, opts: { mode?: "combined" | "split"; required?: boolean; review?: boolean; plansOffered?: boolean } = {}): string | null => {
  const a = new AutoLearnAdapter("Heading Slots", planner, { uploadMode: opts.mode ?? "split", docsByType: docs }) as unknown as {
    resolveUploadByLabel(l: string, r?: boolean, acc?: string, exactOnly?: boolean, pageOffersPlans?: boolean): { docType: string } | null;
  };
  return a.resolveUploadByLabel(label, opts.required ?? true, " .pdf ", opts.review ?? false, opts.plansOffered ?? false)?.docType ?? null;
};

check("MUST-PASS a slot headed \"Plans\" takes the plan set on the review page (exact match only)", () => {
  assert.equal(pick(PLAN, "Plans", { review: true }), "plan_set");
  assert.equal(pick(PLAN, "Plans *", { review: true }), "plan_set");
  assert.equal(pick(PLAN, "Plan Set", { review: true }), "plan_set");
  assert.equal(pick(PLAN, "Construction documents", { review: true }), "plan_set");
  assert.equal(pick(PLAN, "Drawings", { review: true }), "plan_set");
});
check("MUST-PASS …and off the review page, split and combined", () => {
  assert.equal(pick(PLAN, "Plans"), "plan_set");
  assert.equal(pick(PLAN, "Plans", { mode: "combined" }), "plan_set");
});
check("MUST-EXCLUDE a slot headed \"Bid\" gets nothing when the job holds no bid — every mode", () => {
  assert.equal(pick(PLAN, "Bid", { review: true }), null, "review page");
  assert.equal(pick(PLAN, "Bid"), null, "split, required: no fallback tier may fill it");
  assert.equal(pick(PLAN, "Bid", { mode: "combined" }), null, "combined: not the plan set");
  assert.equal(pick(PLAN, "A copy of the bid"), null);
});
check("MUST-EXCLUDE replay: the sweep skips a \"Bid\" slot (a named document, never a substitute)", () => {
  assert.equal(uploadForbidsSubstitute("Bid"), true);
  assert.equal(exactUploadDocType("Bid"), "bid");
});
check("MUST-PASS a job that holds its bid gets it into \"Bid\" (review page and split)", () => {
  assert.equal(pick(WITH_BID, "Bid", { review: true }), "bid");
  assert.equal(pick(WITH_BID, "Bid"), "bid");
  assert.equal(pick(WITH_BID, "Bid", { mode: "combined" }), "bid");
});
check("MUST-EXCLUDE only the BARE word is the plan set on the review page", () => {
  assert.equal(pick(PLAN, "Stamped plans", { review: true }), null);
  assert.equal(pick(PLAN, "Landscape plans", { review: true }), null);
  assert.equal(pick(PLAN, "Other Files", { review: true, required: false }), null);
});
// ---- CityView's three headed requirement rows (City of Bend, watched learn 2026-11-12) ----
// "Agreements, Form, Documents & Checklists" | "Electrical Plans" | "Other/Miscellaneous". An AHJ
// learn runs in combined mode, where every slot used to take the plan set.
const FORMS = "Agreements, Form, Documents & Checklists";
check("MUST-PASS \"Electrical Plans\" is the plan set — on the review page (exact only), split and combined", () => {
  assert.equal(pick(PLAN, "Electrical Plans", { review: true }), "plan_set");
  assert.equal(pick(PLAN, "Electrical Plans"), "plan_set");
  assert.equal(pick(PLAN, "Electrical Plans", { mode: "combined" }), "plan_set");
  assert.equal(pick(PLAN, "Solar PV Plans", { review: true }), "plan_set");
  assert.equal(pick(PLAN, "Plans - Construction", { review: true }), "plan_set");
  assert.equal(uploadSlotTakesPlans("Electrical Plans"), true);
  assert.equal(uploadSlotTakesPlans(FORMS), false);
  assert.equal(uploadSlotTakesPlans("Other/Miscellaneous"), false);
});
check("MUST-EXCLUDE the forms slot never takes the plan set when a plans slot is offered — any mode", () => {
  assert.equal(pick(PLAN, FORMS, { mode: "combined", plansOffered: true }), null, "combined (the AHJ learn's mode)");
  assert.equal(pick(PLAN, FORMS, { plansOffered: true }), null, "split, required");
  assert.equal(pick(PLAN, FORMS, { review: true }), null, "review page");
  assert.equal(pick(PLAN, "Agreements & Forms", { mode: "combined", plansOffered: true }), null, "no checklist word: still a forms slot");
  assert.equal(pick(PLAN, "Agreements & Forms", { plansOffered: true }), null);
});
check("MUST-PASS the forms slot takes the job's own forms, whichever it holds", () => {
  const withForms = { ...PLAN, building_application: "C:/nope/ZZTEST-building-application.pdf", solar_checklist: "C:/nope/ZZTEST-checklist.pdf" };
  assert.equal(pick(withForms, FORMS, { mode: "combined", plansOffered: true }), "building_application");
  assert.equal(pick({ ...PLAN, solar_checklist: "C:/nope/ZZTEST-checklist.pdf" }, FORMS, { review: true }), "solar_checklist");
  assert.equal(pick({ ...PLAN, permit_application: "C:/nope/ZZTEST-application.pdf" }, "Agreements & Forms", { plansOffered: true }), "permit_application");
  assert.deepEqual(formsSlotDocTypes("Plans & forms"), null, "a heading that also names plans is not a forms slot");
  assert.deepEqual(formsSlotDocTypes("Bid"), null);
});
check("MUST-PASS alone on a page (no plans slot offered), a forms-and-documents slot keeps its old fallback", () => {
  assert.equal(pick(PLAN, "Agreements & Forms"), "plan_set", "split, required, nothing else offered");
  assert.equal(pick(PLAN, "Agreements & Forms", { mode: "combined" }), "plan_set");
});
check("MUST-PASS a catch-all heading is known as one; a plans or forms heading is not", () => {
  assert.equal(catchAllUploadSlot("Other/Miscellaneous"), true);
  assert.equal(catchAllUploadSlot("Other Files"), true);
  assert.equal(catchAllUploadSlot("Additional Documents"), true);
  assert.equal(catchAllUploadSlot("Electrical Plans"), false);
  assert.equal(catchAllUploadSlot(FORMS), false);
  assert.equal(catchAllUploadSlot(undefined), false);
});

check("MUST-PASS a description box gets the document's KIND, never a file name", () => {
  assert.equal(AutoLearnAdapter.uploadDescriptionFor("plan_set"), "Plan set");
  assert.equal(AutoLearnAdapter.uploadDescriptionFor("sld"), "Single-line diagram");
  assert.equal(AutoLearnAdapter.uploadDescriptionFor("site_photo"), "Site photo");
});

if (failures) { console.error(`\n${failures} heading-slot check(s) FAILED.`); process.exit(1); }
console.log("\nAll heading-slot upload checks passed.");
process.exit(0);
