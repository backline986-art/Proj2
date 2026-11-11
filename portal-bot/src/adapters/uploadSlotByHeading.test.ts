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
import { AutoLearnAdapter, exactUploadDocType, uploadForbidsSubstitute, type LearnPlanner } from "./autoLearnAdapter";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${e instanceof Error ? e.message : String(e)}`); }
};
const planner: LearnPlanner = async () => ({ fills: [], atReview: false });
const PLAN = { plan_set: "C:/nope/ZZTEST-plan-set.pdf" };
const WITH_BID = { ...PLAN, bid: "C:/nope/ZZTEST-bid.pdf" };
const pick = (docs: Record<string, string>, label: string, opts: { mode?: "combined" | "split"; required?: boolean; review?: boolean } = {}): string | null => {
  const a = new AutoLearnAdapter("Heading Slots", planner, { uploadMode: opts.mode ?? "split", docsByType: docs }) as unknown as {
    resolveUploadByLabel(l: string, r?: boolean, acc?: string, exactOnly?: boolean): { docType: string } | null;
  };
  return a.resolveUploadByLabel(label, opts.required ?? true, " .pdf ", opts.review ?? false)?.docType ?? null;
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
check("MUST-PASS a description box gets the document's KIND, never a file name", () => {
  assert.equal(AutoLearnAdapter.uploadDescriptionFor("plan_set"), "Plan set");
  assert.equal(AutoLearnAdapter.uploadDescriptionFor("sld"), "Single-line diagram");
  assert.equal(AutoLearnAdapter.uploadDescriptionFor("site_photo"), "Site photo");
});

if (failures) { console.error(`\n${failures} heading-slot check(s) FAILED.`); process.exit(1); }
console.log("\nAll heading-slot upload checks passed.");
process.exit(0);
