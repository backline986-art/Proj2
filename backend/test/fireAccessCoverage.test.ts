// FIRE ACCESS READ THE WAY THE AHJ READS IT (review-audit draft 08; fireAccess.ts, designCriteria.ts).
//
//   COVERAGE   — array over 33% of the plan-view roof → 36 in from the ridge (66% on a dwelling stated
//                to be sprinklered); under → today's 18 in (pinned); not stated → the stricter 36 in,
//                said ("roof coverage not stated").
//   SPRINKLERS — only a statement of fact about the dwelling; a copied code note never relaxes.
//   EERO       — modules below an emergency escape and rescue opening with no 36 in path → warning;
//                silence → one callout; "none" / "no modules below" / a dimensioned path → nothing.
//   POLICY     — the AHJ's alternative pathway policy as typed data: applied when person-verified with
//                its page, or official (#683); seeded → model code + a callout. Area ceiling honoured.
//   STORAGE    — the policy round-trips through the code profile (verified saves exactly what was sent).
// Kill tests: requiredRoofPlanDimensions ignoring facts → the coverage and policy checks fail.
// Every name is invented. Run: npx tsx backend/test/fireAccessCoverage.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JurisdictionCodeProfile, JurisdictionFirePathwayPolicy, ProjectRecord, ReviewerFinding } from "../../shared/src/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fire-access-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";

const { openDatabase } = await import("../src/db");
const { buildCodeContext, getCodeProfile, saveVerifiedCodeProfile, saveResearchedCodeProfile } = await import("../src/codeProfiles");
const { evaluateDesignCodeFindings } = await import("../src/codeReviewRules");
const { readRoofCoverage, readSprinklered, readArrayAreaSqFt } = await import("../src/fireAccess");
const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const BELOW = "city.fire.pathway-below-required";
const UNMEASURED = "city.fire.pathway-unmeasured";
const EERO_BAD = "city.fire.eero-obstructed";
const EERO_ASK = "city.fire.eero-unconfirmed";
const POLICY_ASK = "city.fire.alt-pathway-policy-unverified";

const project = (snapshot: Record<string, unknown> = {}): ProjectRecord => ({
  id: "fire-access-test", state: "ZQ", ahj: "Town of Larchmere", utility: "Larchmere Light",
  homeownerName: "Test Owner", projectAddress: "1 Test Way", interconnectionMethod: "Load-side breaker",
  parserSnapshot: { mounting: "Roof mount", ...snapshot },
} as unknown as ProjectRecord);
const profile = (over: Partial<JurisdictionCodeProfile> = {}): JurisdictionCodeProfile => ({
  key: "zq|town of larchmere|unknown", state: "ZQ", ahj: "Town of Larchmere", confidence: "seeded",
  adoptedCodes: [{ code: "IRC", edition: "2021" }, { code: "NEC", edition: "2023" }],
  amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  ...over,
});
const POLICY: JurisdictionFirePathwayPolicy = {
  name: "Rooftop solar access alternative", arrayAreaMaxSqFt: 1000, ridgeSetbackIn: 12, pathwayWidthIn: 30,
  pathwaysExemptMaxCoveragePct: 33, sourceUrl: "https://larchmere.invalid/fire/solar-access",
  quote: "Arrays under 1,000 square feet may use a 12-inch ridge setback and one 30-inch pathway.",
};
const ctxOf = (over: Partial<JurisdictionCodeProfile> = {}) => buildCodeContext("ZQ", "Town of Larchmere", profile(over));
const plan = (text: string) => [{ label: "Plan set", text }];
const run = (text: string, over: Partial<JurisdictionCodeProfile> = {}, snapshot: Record<string, unknown> = {}): ReviewerFinding[] =>
  evaluateDesignCodeFindings(project(snapshot), null, ctxOf(over), [], plan(text));
const get = (fs: ReviewerFinding[], id: string) => fs.find((f) => f.id === id);
const src = (text: string) => [{ label: "Plan set", text }];

console.log("\n1. COVERAGE, read from the plan");
await check("the plan's own percentage, label first or value first", () => {
  assert.equal(readRoofCoverage(project(), src("ROOF COVERAGE: 40%"))?.pct, 40);
  assert.equal(readRoofCoverage(project(), src("ARRAY COVERAGE = 27.5%"))?.pct, 27.5);
  assert.equal(readRoofCoverage(project(), src("PV ARRAY = 31% OF ROOF AREA"))?.pct, 31);
});
await check("array area / roof area where both are stated (thousands separators read)", () => {
  const c = readRoofCoverage(project(), src("TOTAL ARRAY AREA: 400 SQ FT. TOTAL ROOF AREA: 2,000 SQ FT."));
  assert.equal(c?.pct, 20);
  assert.equal(c?.basis, "areas");
});
await check("both ways: the larger coverage (the stricter setback) wins", () => {
  assert.equal(readRoofCoverage(project(), src("ROOF COVERAGE: 25%. ARRAY AREA: 600 SF. ROOF AREA: 2000 SF."))?.pct, 30);
});
await check("nothing stated, or an array area with no roof area → coverage unknown", () => {
  assert.equal(readRoofCoverage(project(), src('36" FIRE ACCESS PATHWAY')), null);
  assert.equal(readRoofCoverage(project(), src("ARRAY AREA: 400 SQ FT")), null);
});
await check("modules x the module's stated size gives the array area", () => {
  const a = readArrayAreaSqFt(project({ moduleQty: "20" }), src('MODULE DIMENSIONS: 67.8" x 44.6"'));
  assert.ok(a && Math.abs(a.value - 420) < 2, String(a?.value));
  assert.equal(readArrayAreaSqFt(project({}), src('MODULE DIMENSIONS: 67.8" x 44.6"')), null, "no module count");
});

console.log("\n2. SPRINKLERS, only as a fact about the dwelling");
await check("a statement of fact counts", () => {
  assert.ok(readSprinklered(src("DWELLING IS EQUIPPED WITH AN NFPA 13D SPRINKLER SYSTEM.")));
  assert.ok(readSprinklered(src("FIRE SPRINKLERS: YES")));
});
await check("a code note, a denial or a bare citation never counts", () => {
  assert.equal(readSprinklered(src("ARRAY MAY COVER 66% OF THE ROOF WHERE THE DWELLING IS SPRINKLERED PER R324.6.2.")), null);
  assert.equal(readSprinklered(src("FIRE SPRINKLERS: NONE")), null);
  assert.equal(readSprinklered(src("DWELLING IS NOT SPRINKLERED")), null);
  assert.equal(readSprinklered(src("IRC R313 AUTOMATIC FIRE SPRINKLER SYSTEMS")), null);
});

console.log("\n3. THE RIDGE SETBACK, by coverage (model code)");
await check("40% coverage at 18 in → a finding (36 in required), a warning on the model code", () => {
  const f = get(run('36" FIRE ACCESS PATHWAY. 18" SETBACK FROM RIDGE. ROOF COVERAGE: 40%.'), BELOW);
  assert.ok(f, "no finding at 40% coverage");
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /requires at least 36 in/);
  assert.match(f!.message, /covers 40% of the roof/);
});
await check("PIN: under 33% coverage, today's 18 in — no finding at 18 in, a finding at 12 in", () => {
  assert.equal(get(run('36" FIRE ACCESS PATHWAY. 18" SETBACK FROM RIDGE. ROOF COVERAGE: 25%.'), BELOW), undefined);
  const f = get(run('36" FIRE ACCESS PATHWAY. 12" SETBACK FROM RIDGE. ROOF COVERAGE: 25%.'), BELOW);
  assert.equal(f?.severity, "warning");
  assert.match(f!.message, /requires at least 18 in/);
});
await check("coverage not stated → the stricter 36 in, and the finding says why", () => {
  const f = get(run('36" FIRE ACCESS PATHWAY. 18" SETBACK FROM RIDGE.'), BELOW);
  assert.ok(f);
  assert.equal(f!.severity, "warning", "a model-code default never blocks");
  assert.match(f!.message, /roof coverage not stated on the plan, so the stricter 36 in applies/);
  const u = get(run("FIRE ACCESS PER CODE."), UNMEASURED);
  assert.deepEqual(u?.roofPlanRequired?.map((r) => `${r.kind}=${r.inches}`), ["pathwayWidth=36", "ridgeSetback=36"]);
});
await check("a sprinklered dwelling: 18 in up to 66%, 36 in above", () => {
  const SPR = "DWELLING IS EQUIPPED WITH AN NFPA 13D SPRINKLER SYSTEM.";
  assert.equal(get(run(`36" FIRE ACCESS PATHWAY. 18" SETBACK FROM RIDGE. ROOF COVERAGE: 50%. ${SPR}`), BELOW), undefined);
  assert.ok(get(run(`36" FIRE ACCESS PATHWAY. 18" SETBACK FROM RIDGE. ROOF COVERAGE: 70%. ${SPR}`), BELOW));
});
await check("a jurisdiction's own fireSetbacks rule still decides over the coverage default", () => {
  const f = get(run('36" FIRE ACCESS PATHWAY. 24" SETBACK FROM RIDGE. ROOF COVERAGE: 20%.', { fireSetbacks: [{ id: "f1", description: "Arrays shall be set back three (3) feet from the ridge." }] }), BELOW);
  assert.match(f?.message ?? "", /requires at least 36 in/);
});

console.log("\n4. THE AHJ'S ALTERNATIVE POLICY");
const POLICY_PLAN = '30" FIRE ACCESS PATHWAY. 12" SETBACK FROM RIDGE. TOTAL ARRAY AREA: 400 SQ FT.';
await check("a person-verified policy with its page: the design built to it passes", () => {
  const fs = run(POLICY_PLAN, { confidence: "verified", verifiedBy: "Dana Plans", firePathwayPolicy: POLICY });
  assert.equal(get(fs, BELOW), undefined, get(fs, BELOW)?.message);
  assert.equal(get(fs, POLICY_ASK), undefined);
});
await check("a design short of the applied policy is measured against it, with the policy's own tier and page", () => {
  const f = get(run('30" FIRE ACCESS PATHWAY. 6" SETBACK FROM RIDGE. TOTAL ARRAY AREA: 400 SQ FT.', { confidence: "verified", verifiedBy: "Dana Plans", firePathwayPolicy: POLICY }), BELOW);
  assert.match(f?.message ?? "", /requires at least 12 in/);
  assert.equal(f?.ruleBasis?.tier, "verified");
  assert.equal(f?.ruleBasis?.sourceUrl, POLICY.sourceUrl);
});
await check("an OFFICIAL read of the policy (#683) is applied too", () => {
  const fs = run(POLICY_PLAN, {
    firePathwayPolicy: POLICY,
    citations: [{ label: "Town fire marshal page", sourceUrl: POLICY.sourceUrl!, field: "firePathwayPolicy", tier: "official", fetchedAt: "2026-11-09T00:00:00Z" } as never],
  });
  assert.equal(get(fs, BELOW), undefined, get(fs, BELOW)?.message);
});
await check("a SEEDED policy: the model code still applies, and the policy is shown as a callout", () => {
  const fs = run(POLICY_PLAN, { firePathwayPolicy: POLICY });
  const f = get(fs, BELOW);
  assert.ok(f, "a seeded policy relaxed the model code");
  assert.equal(f!.severity, "warning");
  assert.match(f!.message, /pathway width: stated 30 in .* requires at least 36 in/);
  const c = get(fs, POLICY_ASK);
  assert.equal(c?.severity, "callout");
  assert.match(c!.message, /seeded, not yet human-verified/);
  assert.match(c!.message, /12 in from the ridge/);
});
await check("a verified policy WITHOUT its page is not applied", () => {
  const { sourceUrl: _drop, ...noPage } = POLICY;
  const fs = run(POLICY_PLAN, { confidence: "verified", verifiedBy: "Dana Plans", firePathwayPolicy: noPage });
  assert.ok(get(fs, BELOW));
  assert.match(get(fs, POLICY_ASK)?.message ?? "", /verified without the page/);
});
await check("an array over the policy's area ceiling (or with no stated area) gets the model code, said", () => {
  const big = run('30" FIRE ACCESS PATHWAY. 12" SETBACK FROM RIDGE. TOTAL ARRAY AREA: 1,200 SQ FT.', { confidence: "verified", verifiedBy: "Dana Plans", firePathwayPolicy: POLICY });
  assert.match(get(big, BELOW)?.message ?? "", /covers arrays up to 1000 sq ft, and this array is 1200 sq ft/);
  const unknown = run('30" FIRE ACCESS PATHWAY. 12" SETBACK FROM RIDGE.', { confidence: "verified", verifiedBy: "Dana Plans", firePathwayPolicy: POLICY });
  assert.match(get(unknown, BELOW)?.message ?? "", /the array's area is not stated/);
});
await check("the policy's coverage exemption: no pathway width at or below its coverage", () => {
  const fs = run('6" FIRE ACCESS PATHWAY. 12" SETBACK FROM RIDGE. TOTAL ARRAY AREA: 300 SQ FT. TOTAL ROOF AREA: 1,500 SQ FT.', { confidence: "verified", verifiedBy: "Dana Plans", firePathwayPolicy: POLICY });
  assert.equal(get(fs, BELOW), undefined, get(fs, BELOW)?.message);
});

console.log("\n5. EMERGENCY ESCAPE AND RESCUE OPENINGS (R324.6)");
const OK = '36" FIRE ACCESS PATHWAY. 36" SETBACK FROM RIDGE.';
await check("silence → one callout asking the designer to confirm", () => {
  const c = get(run(OK), EERO_ASK);
  assert.equal(c?.severity, "callout");
  assert.equal(get(run(OK), EERO_BAD), undefined);
});
await check("modules below an EERO with no 36 in path → a warning", () => {
  const f = get(run(`${OK} MODULES BELOW EERO ON ROOF PLANE 2.`), EERO_BAD);
  assert.equal(f?.severity, "warning");
  assert.match(f!.message, /MODULES BELOW EERO ON ROOF PLANE 2/);
});
await check("a dimensioned path, a denial or a code note → nothing", () => {
  for (const t of [
    `${OK} MODULES BELOW EERO ON PLANE 2. 36" PATHWAY TO EERO PROVIDED.`,
    `${OK} NO MODULES BELOW EERO.`,
    `${OK} NO EERO ON ARRAY ROOF PLANES.`,
    `${OK} PANELS SHALL NOT BE PLACED ON THE ROOF BELOW AN EMERGENCY ESCAPE AND RESCUE OPENING.`,
    `${OK} ARRAY LOCATED BELOW RIDGE, EGRESS WINDOW ON NORTH WALL.`,
  ]) {
    const fs = run(t);
    assert.equal(get(fs, EERO_BAD), undefined, t);
    assert.equal(get(fs, EERO_ASK), undefined, t);
  }
});
await check("a ground mount gets none of the roof checks", () => {
  const fs = evaluateDesignCodeFindings(project({ mounting: "Ground mount" }), null, ctxOf({ firePathwayPolicy: POLICY }), [], plan("MODULES BELOW EERO. ROOF COVERAGE: 80%."));
  for (const id of [EERO_BAD, EERO_ASK, POLICY_ASK, BELOW]) assert.equal(get(fs, id), undefined, id);
});

console.log("\n6. THE POLICY ON THE CODE PROFILE");
await check("a person's verify stores the policy; a seeded re-save keeps it; a verify without it drops it", () => {
  const base = profile({ firePathwayPolicy: POLICY });
  saveVerifiedCodeProfile(db, base, "Dana Plans");
  let read = getCodeProfile(db, { state: "ZQ", ahj: "Town of Larchmere" });
  assert.deepEqual(read?.firePathwayPolicy, POLICY);
  // A malformed policy (no rule) is never stored or read.
  saveVerifiedCodeProfile(db, profile({ firePathwayPolicy: { name: "just a name" } as never }), "Dana Plans");
  read = getCodeProfile(db, { state: "ZQ", ahj: "Town of Larchmere" });
  assert.equal(read?.firePathwayPolicy, undefined);
  saveVerifiedCodeProfile(db, base, "Dana Plans");
  saveVerifiedCodeProfile(db, profile({}), "Dana Plans");
  assert.equal(getCodeProfile(db, { state: "ZQ", ahj: "Town of Larchmere" })?.firePathwayPolicy, undefined, "a verify sends exactly what it stores");
});
await check("a seeded save keeps the policy a re-save does not carry; the AHJ's policy reads with its row's tier", () => {
  saveResearchedCodeProfile(db, profile({ key: "zq|village of fenwick|unknown", ahj: "Village of Fenwick", firePathwayPolicy: POLICY }));
  saveResearchedCodeProfile(db, profile({ key: "zq|village of fenwick|unknown", ahj: "Village of Fenwick" }));
  const read = getCodeProfile(db, { state: "ZQ", ahj: "Village of Fenwick" });
  assert.deepEqual(read?.firePathwayPolicy, POLICY);
  assert.equal(read?.confidence, "seeded");
});

if (failures) { console.error(`\n${failures} fire access check(s) FAILED.`); process.exit(1); }
console.log("\nAll fire access checks passed.");
process.exit(0);
