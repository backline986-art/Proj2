// A READ-ONLY PAGE INSIDE THE WIZARD IS NOT THE REVIEW PAGE (#271, offline bench 2026-11-23).
//
// Accela's advance on every step is "Continue Application »", which is submit-worded. A page with
// nothing to fill AFTER a form page (a "Licensed Professional" step that only shows the account's
// licence) read as the review page: the learn stopped there with 4 of 19 fields, and that page's
// Continue was recorded as the FINAL SUBMIT (rule 1: the wrong click carried isFinalSubmit).
// Engine invariants, each asserted here:
//
//   R1 MUST-PASS   accela/extra_readonly_page: the learn walks THROUGH the read-only page (its
//                  click recorded as an advance, not a final submit), fills every field the base
//                  learn fills, and reaches the real review page.
//   R2 MUST-PASS   accela/base: the real review page (CapConfirm, "Step 4: Review") still reads as
//                  review and its "Continue Application" is still the recorded final submit.
//   R4 MUST-PASS   with a planner that never says review, the learner's own reading of CapConfirm
//                  still stops there and flags its "Continue Application" as the final submit.
//   R3 MUST-EXCLUDE a planner that says atReview on the read-only page and names its Continue as
//                  the final submit: the run may stop there for a person, but no step carries
//                  isFinalSubmit (the page does not name itself the review step).
//   Every case: no filing POST reached the replica.
//
// KILL TESTS (each must turn this file red):
//   K1 autoLearnAdapter isReviewPage: drop `&& !readOnlyMidWizard`              → R1 fails.
//   K2 autoLearnAdapter: delete the c2o block (planner final submit on a continue-only page) → R3 fails.
//   K3 autoLearnAdapter promotable: `(!continueOnly(f.label) || false)`          → R4 fails.
//   (The other half of "after a form page", form data already recorded, is pinned by the offline
//   bench's accela/extra_readonly_page learn: 4 of 19 fields without it, 19 of 19 with it.)
//
// Synthetic replica and projects only (no real portal, no customer data).
// Run: npx tsx portal-bot/src/replica/learnReadOnlyMidWizard.dom.smoke.ts
import "../smokeArtifactDirs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { learnPortal } from "../index";
import { buildWizard, scoredControls, type Wizard } from "./fixtures/wizards";
import { PROJECT_A } from "./fixtures/syntheticProjects";
import { startSyntheticReplica } from "./syntheticServer";
import { standInPlanner } from "./standInPlanner";
import type { LearnPlanRequest, LearnPlanResponse } from "../adapters/autoLearnAdapter";
import type { ProjectRecord, RecipeStep } from "../../../shared/src/types";

delete process.env.PORTAL_ALLOW_FINAL_SUBMIT;
process.env.ANTHROPIC_API_KEY = "";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const P = PROJECT_A;
const ONLY = process.env.SMOKE_ONLY || "";
const CRED = { username: P.portalUsername, password: P.portalPassword };
const fields: Record<string, string> = {
  homeownerFirstName: P.ownerFirst, homeownerLastName: P.ownerLast, homeownerName: `${P.ownerFirst} ${P.ownerLast}`,
  homeownerEmail: P.ownerEmail, homeownerPhone: P.ownerPhone, street: P.street, city: P.city, state: P.state, zip: P.zip, county: P.county,
  installerFirstName: P.installer.contactFirst, installerLastName: P.installer.contactLast, installerCompanyName: P.installer.company,
  installerEmail: P.installer.email, installerPhone: P.installer.phone, installerContactName: `${P.installer.contactFirst} ${P.installer.contactLast}`,
  workDescription: `Roof-mounted residential solar PV system, ${P.dcKw} kW DC / ${P.acKw} kW AC`, systemSizeDcKw: P.dcKw, numberOfStories: P.stories,
  moduleQty: P.moduleQty, moduleQuantity: P.moduleQty, inverterQty: P.inverterQty, moduleMake: P.moduleMake, moduleModel: P.moduleModel, inverterMake: P.inverterMake, inverterModel: P.inverterModel,
};
// Synthetic placeholder PDFs (the bench's own shape): the upload step needs a plan set.
const DOC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "readonly-mid-wizard-"));
const pdf = (name: string): string => {
  const f = path.join(DOC_DIR, name);
  fs.writeFileSync(f, "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  return f;
};
const docsByType = { plan_set: pdf("A-plan-set.pdf"), sld: pdf("A-one-line.pdf"), site_plan: pdf("A-site-plan.pdf") };
const project = {
  id: "smoke-readonly", ahj: P.ahj, utility: P.utility, state: P.state, city: P.city, zip: P.zip, address: `${P.street}, ${P.city}, ${P.state} ${P.zip}`, projectAddress: `${P.street}, ${P.city}, ${P.state} ${P.zip}`,
  homeownerName: `${P.ownerFirst} ${P.ownerLast}`,
} as unknown as ProjectRecord;

/** A planner that, on the read-only "Licensed Professional" page, claims review and names its
 *  "Continue Application" as the final submit — what a wrong model answer would look like. */
const claimsReviewOnReadOnly = (inner: (r: LearnPlanRequest) => Promise<LearnPlanResponse>) => async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
  if (/licensed professional/i.test(`${req.pageTitle} ${req.bodyText}`) && !req.fields.some((f) => f.fieldType !== "button")) {
    const i = req.fields.findIndex((f) => f.fieldType === "button" && /continue\s+application/i.test(String(f.label ?? "")));
    if (i >= 0) return { fills: [], atReview: true, finalSubmitSelectorIndex: i, notes: "smoke: a wrong review claim" };
  }
  return inner(req);
};

/** A planner that never says review: on the review page it answers its submit as a plain advance,
 *  so only the learner's own structural reading can stop there and flag the final submit. */
const neverClaimsReview = (inner: (r: LearnPlanRequest) => Promise<LearnPlanResponse>) => async (req: LearnPlanRequest): Promise<LearnPlanResponse> => {
  const plan = await inner(req);
  if (!plan.atReview) return plan;
  return { fills: plan.fills, atReview: false, advanceSelectorIndex: plan.finalSubmitSelectorIndex, notes: "smoke: no review claim" };
};

interface Case { name: string; wizard: Wizard; planner?: "claimsReview" | "neverReview" }
async function run(c: Case) {
  if (ONLY && !c.name.includes(ONLY)) return null;
  const replica = await startSyntheticReplica({ wizard: c.wizard, credential: CRED });
  const inner = standInPlanner(fields, { utility: false });
  const t0 = Date.now();
  try {
    const r = await learnPortal({
      portalName: `smoke ${c.name}`,
      portalUrl: replica.entryUrl,
      project,
      planner: c.planner === "claimsReview" ? claimsReviewOnReadOnly(inner) : c.planner === "neverReview" ? neverClaimsReview(inner) : inner,
      credential: CRED,
      headless: true,
      budgetMs: 240_000,
      docsByType,
      uploadMode: "combined",
      policyProfile: "none",
      contactIdentity: { firstName: fields.installerFirstName, lastName: fields.installerLastName, email: fields.installerEmail, phone: fields.installerPhone, street: P.installer.street, city: P.installer.city, state: P.installer.state, zip: P.installer.zip },
      siteContactIdentity: { firstName: fields.homeownerFirstName, lastName: fields.homeownerLastName, email: fields.homeownerEmail, phone: fields.homeownerPhone, street: P.street, city: P.city, state: P.state, zip: P.zip },
      siteIdentity: { city: P.city, zip: P.zip, homeownerName: fields.homeownerName, isElectrical: true },
      hasBattery: false,
    });
    const secs = (Date.now() - t0) / 1000;
    const steps: RecipeStep[] = r.steps ?? [];
    const finals = steps.filter((s) => s.isFinalSubmit === true);
    const lastFill = steps.map((s) => s.action).lastIndexOf("fill");
    const firstFinal = steps.findIndex((s) => s.isFinalSubmit === true);
    const scored = scoredControls(c.wizard).map((ctl) => ctl.key);
    const filled = scored.filter((n) => String(replica.state.values[n] ?? "").trim()).length;
    console.log(`   [${c.name}] ${secs.toFixed(1)}s ok=${r.ok} review=${!!r.reachedReview} fields=${filled}/${scored.length} finals=${finals.map((s) => s.note).join(" | ") || "-"}\n      msg: ${String(r.message).slice(0, 300)}\n      trace: ${(r.pageTrace ?? []).slice(-5).join(" || ").slice(0, 700)}`);
    return { r, steps, finals, lastFill, firstFinal, filled, scored: scored.length, walked: replica.state.reviewReached, submits: replica.state.submitPosts.length };
  } finally {
    await replica.close();
  }
}

// R2 MUST-PASS — the real review page is still review, and its Continue is still the final submit.
{
  const x = await run({ name: "r2-base", wizard: buildWizard("accela", "base") });
  if (x) {
    check("R2 MUST-PASS accela/base reaches CapConfirm and records its \"Continue Application\" as the one final submit",
      x.r.reachedReview === true && x.filled === x.scored && x.finals.length === 1 && /continue application/i.test(String(x.finals[0]?.note ?? "")),
      `review=${x.r.reachedReview} fields=${x.filled}/${x.scored} finals=${x.finals.map((s) => s.note).join(" | ")}`);
    check("R2 no filing POST", x.submits === 0, `submits=${x.submits}`);
  }
}
// R1 MUST-PASS — the bench cell that failed.
{
  const x = await run({ name: "r1-extra-readonly", wizard: buildWizard("accela", "extra_readonly_page") });
  if (x) {
    check("R1 MUST-PASS the learn walks through the read-only mid-wizard page and fills every scored field",
      x.filled === x.scored && x.walked, `fields=${x.filled}/${x.scored} walkedToReview=${x.walked}`);
    check("R1 the read-only page's Continue is recorded as an advance, and the only final submit comes after the last fill",
      x.finals.length === 1 && x.firstFinal > x.lastFill
        && x.steps.some((s, i) => i < x.lastFill && s.action === "click" && /continue application/i.test(String(s.note ?? "")) && s.isFinalSubmit !== true),
      `finals=${x.finals.length} firstFinal=${x.firstFinal} lastFill=${x.lastFill}`);
    check("R1 no filing POST", x.submits === 0, `submits=${x.submits}`);
  }
}
// R3 MUST-EXCLUDE — a planner's wrong review claim on the read-only page records no final submit.
{
  const x = await run({ name: "r3-planner-claims-review", wizard: buildWizard("accela", "extra_readonly_page"), planner: "claimsReview" });
  if (x) {
    check("R3 MUST-EXCLUDE a planner atReview on the read-only page names its Continue as final submit: no step carries isFinalSubmit",
      x.finals.length === 0, `finals=${x.finals.map((s) => s.note).join(" | ")}`);
    check("R3 no filing POST", x.submits === 0, `submits=${x.submits}`);
  }
}

// R4 MUST-PASS — the learner's OWN review reading (no planner claim) still flags CapConfirm's
// "Continue Application" as the final submit: the page names itself review (URL and heading).
{
  const x = await run({ name: "r4-structural-review", wizard: buildWizard("accela", "base"), planner: "neverReview" });
  if (x) {
    check("R4 MUST-PASS with no planner review claim, CapConfirm is still read as review and its Continue is the one final submit",
      x.finals.length === 1 && /continue application/i.test(String(x.finals[0]?.note ?? "")) && x.filled === x.scored,
      `finals=${x.finals.map((s) => s.note).join(" | ")} fields=${x.filled}/${x.scored}`);
    check("R4 no filing POST", x.submits === 0, `submits=${x.submits}`);
  }
}

fs.rmSync(DOC_DIR, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} read-only mid-wizard learn smoke test(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll read-only mid-wizard learn smoke tests passed.");
process.exit(0);
