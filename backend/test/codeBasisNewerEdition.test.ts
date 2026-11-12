// A PLAN ON A NEWER EDITION THAN THE PROFILE WARNS; AN OLDER ONE STILL BLOCKS (#597).
//
// Owner, 2026-11-07 (#596's Washington County job, "this really a blocker?" -> "Yes"): a plan citing
// the 2026 OESC was blocked because our verified Oregon profile still said 2023. The plan was right;
// the profile was lagging an adoption. The two directions are not equally risky:
//   · plan OLDER than adopted -> likely designed to a superseded code: still a BLOCKER (a recorded
//     phase-in, #216, still softens it);
//   · plan NEWER than the profile -> almost always the profile lagging: a WARNING that asks a person
//     to check the profile. It never writes the profile (hard rule 3).
// Editions compare as years; one that is not a plain year keeps the old answer (block on verified),
// never fails open.
//
// Fixtures are SYNTHETIC governing-codes strings; no names, addresses or permit numbers.
//
// Run: npx tsx backend/test/codeBasisNewerEdition.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { CodeEdition, JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCriteriaFindings } from "../src/designCriteria";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const BASIS = "city.code.basis-mismatch";
const AS_OF = "2026-11-09";
const AHJ = "Testington County";

const plan = (codes: string): ProjectRecord => ({
  id: "newer-edition-test", state: "OR", ahj: AHJ, utility: "Test Power", homeownerName: "Test Owner",
  projectAddress: "1 Test St", interconnectionMethod: "Load-side breaker",
  parserSnapshot: { mounting: "Roof mount", planSetExtractedText: `GOVERNING CODES: ${codes}. SYSTEM SIZE: 8 kW DC` },
} as unknown as ProjectRecord);

// The install's verified Oregon row before #596's proposal is approved: OESC and NEC 2023 as separate
// entries, ORSC 2023 on the 2021 IRC, OSSC 2025.
const STALE_OR: CodeEdition[] = [
  { code: "OESC", edition: "2023", title: "Oregon Electrical Specialty Code (based on the 2023 NEC)" },
  { code: "NEC", edition: "2023", title: "National Electrical Code as adopted via the 2023 OESC" },
  { code: "ORSC", edition: "2023", title: "Oregon Residential Specialty Code (2023 edition, based on the 2021 IRC)" },
  { code: "OSSC", edition: "2025", basedOn: "2024 IBC" },
];
const profile = (adoptedCodes: CodeEdition[], confidence: "verified" | "seeded" = "verified"): JurisdictionCodeProfile => ({
  key: "or|testington county|unknown", state: "OR", ahj: AHJ, confidence, ...(confidence === "verified" ? { verifiedBy: "operator" } : {}),
  adoptedCodes, amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  researchedAt: "2026-09-01T00:00:00.000Z",
});
const basis = (codes: string, adopted: CodeEdition[] = STALE_OR, confidence: "verified" | "seeded" = "verified"): ReviewerFinding | undefined =>
  evaluateDesignCriteriaFindings(plan(codes), buildCodeContext("OR", AHJ, profile(adopted, confidence)), { roofMounted: true, asOf: AS_OF })
    .find((f) => f.id === BASIS);

check("AC1+7 MUST-PASS (the Washington County case): '2023 ORSC, 2025 OSSC, 2026 OESC' against a verified OESC 2023 -> a WARNING that asks to check the profile, not a blocker", () => {
  const f = basis("2023 ORSC, 2025 OSSC, 2026 OESC");
  assert.ok(f, "the plan still gets an answer");
  assert.equal(f!.severity, "warning", f!.message);
  assert.match(f!.message, /OESC 2026/);
  assert.match(f!.message, /OESC 2023/, "names the compared profile row");
  assert.match(f!.message, /newer than the profile/i);
  assert.match(f!.message, /check (the )?profile/i);
  assert.match(f!.message, /Profile: /, "the provenance of the compared row is still named");
  assert.equal(f!.installerCallout, false, "the plan is not asked to change");
  assert.doesNotMatch(f!.cityFeedback, /Update the plan's governing-codes block/, f!.cityFeedback);
});

check("AC1 MUST-PASS: a newer edition is a warning whatever the upcoming window says (none recorded here)", () => {
  assert.equal(basis("2026 OESC", [{ code: "OESC", edition: "2023" }])?.severity, "warning");
});

check("AC2 MUST-EXCLUDE: an OLDER edition outside any phase-in still BLOCKS (profile OESC 2026, plan 2023 OESC)", () => {
  const f = basis("2023 OESC", [{ code: "OESC", edition: "2026", basedOn: "2026 NEC" }]);
  assert.equal(f?.severity, "blocker", f?.message);
  assert.doesNotMatch(f!.message, /newer than the profile/i);
  assert.equal(f!.installerCallout, true);
});

check("AC3 MUST-EXCLUDE: a previous edition inside a recorded phase-in is still the #216 callout", () => {
  const f = basis("2023 ORSC", [{ family: "residential", code: "ORSC", edition: "2026", previousEdition: "2023", effectiveDate: "2026-10-01", mandatoryDate: "2027-04-01" }]);
  assert.equal(f?.severity, "callout", f?.message);
  assert.match(f!.message, /2027-04-01/);
});

check("AC3 MUST-EXCLUDE: a SEEDED profile is unchanged — a warning, without the verified-profile note", () => {
  const f = basis("2026 OESC", [{ code: "OESC", edition: "2023" }], "seeded");
  assert.equal(f?.severity, "warning");
  assert.doesNotMatch(f!.message, /newer than the profile/i);
});

check("AC4 MUST-PASS: a newer BASE model code warns ('2023 OESC (NEC 2026)' against NEC 2023)", () => {
  const f = basis("2023 OESC (NEC 2026)");
  assert.equal(f?.severity, "warning", f?.message);
  assert.match(f!.message, /NEC 2026/);
  assert.match(f!.message, /newer than the profile/i);
});

check("AC4 MUST-EXCLUDE: an older BASE model code still blocks ('2023 OESC (NEC 2020)' against NEC 2023)", () => {
  const f = basis("2023 OESC (NEC 2020)");
  assert.equal(f?.severity, "blocker", f?.message);
});

check("AC5 MUST-PASS: a mixed package blocks on the OLDER line only; the newer line is marked as not what blocks", () => {
  const f = basis("2021 ORSC, 2026 OESC");
  assert.equal(f?.severity, "blocker", f?.message);
  const lines = f!.message.split("; ");
  const orsc = lines.find((l) => /ORSC 2021/.test(l));
  const oesc = lines.find((l) => /OESC 2026/.test(l));
  assert.ok(orsc && oesc, f!.message);
  assert.doesNotMatch(orsc!, /newer than the profile/i, "the older line is the blocker");
  assert.match(oesc!, /newer than the profile/i, "the newer line is listed as a warning-only line");
});

check("AC6 MUST-EXCLUDE: a profile edition that is not a plain year never makes a line 'newer' (fails closed: blocker)", () => {
  for (const edition of ["current", "8th Edition", "2023a", ""]) {
    const f = basis("2026 OESC", [{ code: "OESC", edition }]);
    if (!f) continue; // an empty edition may not compare at all; what matters is that nothing softened
    assert.equal(f.severity, "blocker", `profile edition ${JSON.stringify(edition)}: ${f.message}`);
  }
});

check("AC6 MUST-EXCLUDE: newer than ONE profile row of the code but not all of them is not 'newer'", () => {
  // Two rows of one code (a state row and a city's own), 2023 and 2029: a plan on 2026 is older than one of them.
  const f = basis("2026 OESC", [{ code: "OESC", edition: "2023" }, { code: "OESC", edition: "2029" }]);
  assert.equal(f?.severity, "blocker", f?.message);
});

if (failures) { console.error(`\n${failures} newer-edition check(s) FAILED.`); process.exit(1); }
console.log("\nAll newer-edition checks passed.");
