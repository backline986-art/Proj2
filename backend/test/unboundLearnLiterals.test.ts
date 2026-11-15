// A RECORDED VALUE WITH NO BINDING REPLAYS ON EVERY JOB (#236) — THE BACKEND HALF.
//
// The 2026-11-14 audit of all 22 saved recipes found the learn job's answers frozen as literals and
// replayed for every later project. Synthetic shapes copied from that evidence (never its values):
//   Corvallis   Direction "NW" and Street Type "ST" beside a bound street number and name — an
//               SE … Ave project's address search asked NW … ST.
//   Tigard      "Without Service or Feeder" = 1 and "With Service or Feeder" = 0 on a page whose two
//               sibling boxes ARE fee-bound; "Describe Location of Solar Array" carrying the learn
//               roof's "180° azimuth, 22° tilt".
// Each rule is pinned both ways: MUST-PASS (the learn job's answer is replaced or withheld) and
// MUST-EXCLUDE (a portal constant, an array's direction, the contractor's own address, a count on a
// page with no fee lines are left exactly as recorded).
//
//   npx tsx backend/test/unboundLearnLiterals.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecipeStep } from "../../shared/src/types";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "unbound-literals-"));
process.env.AUTOPILOT_DB_PATH = path.join(scratch, "test.sqlite");

const { openDatabase } = await import("../src/db");
const { resolveRecipeFieldValues, convertLiteralsToBoundFields } = await import("../src/portalRecipes");
const { bindRecipeForReplay, REPLAY_BLANK_FIELD } = await import("../src/recipeReplayBinding");
const { plannerFieldView } = await import("../src/autoLearn");
const { ADDRESS_COMPONENT_FIELD_KEYS, addressComponentFields, addressComponentKeyFor } = await import("../../portal-bot/src/addressParse");
const { jobValueShape } = await import("../../portal-bot/src/jobValueShape");
const { SERVICE_FEEDER_200A_FIELD } = await import("../../shared/src/serviceLineLabels");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const db = await openDatabase();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const projectAt = (projectAddress: string): any => ({
  id: "p-unbound", clientId: null, homeownerName: "ZZ Test Owner", projectAddress,
  city: "Testville", state: "OR", zip: "97000", ahj: "City of Testville", utility: "Test Power", parserSnapshot: {},
});
const SE_AVE = resolveRecipeFieldValues(db, projectAt("1234 SE Example Ave, Testville, OR 97000"), "accela");
const WAY = resolveRecipeFieldValues(db, projectAt("500 Larkspur Way, Testville, OR 97000"), "accela");

const st = (action: RecipeStep["action"], label: string, extra: Partial<RecipeStep> = {}): RecipeStep =>
  ({ action, phase: "fill", note: label, selector: { label }, ...extra } as RecipeStep);
const ADVANCE = st("click", "advance: Continue Application", { selector: { role: "button", name: "Continue Application" } } as Partial<RecipeStep>);
// The Corvallis shape: the search's number and name bound, its direction and type frozen.
const SEARCH: RecipeStep[] = [
  ADVANCE,
  st("fill", "Street No.:", { field: "streetNumber" }),
  st("select", "Direction:", { value: "NW" }),
  st("fill", "Street Name:", { field: "streetNameCore" }),
  st("select", "Street Type:", { value: "ST" }),
  st("select", "Type of Use:", { value: "Single-Family" }),
  ADVANCE,
];
const bind = (steps: RecipeStep[], fieldValues: Record<string, string>) => bindRecipeForReplay({
  steps, project: { state: "OR", ahj: "City of Testville", city: "Testville", parserSnapshot: {} }, fieldValues, track: "permit", borrowed: null, agency: null,
});

// ── (1) ADDRESS COMPONENTS ──────────────────────────────────────────────────────────────────────
check("RESOLVER (the real write path): this project's address components, both vocabularies", () => {
  assert.equal(SE_AVE.streetDirection, "SE");
  assert.equal(SE_AVE.streetDirectionWord, "Southeast");
  assert.equal(SE_AVE.streetSuffix, "AVE");
  assert.equal(SE_AVE.streetSuffixWord, "Avenue");
  assert.equal(WAY.streetDirection, "", "a directionless address has no direction — and that is an answer");
  assert.equal(WAY.streetSuffix, "WAY");
  assert.deepEqual(addressComponentFields("77 Main St NW Apt 4, Town, OR"), {
    streetDirection: "", streetDirectionWord: "", streetPostDirection: "NW", streetPostDirectionWord: "Northwest",
    streetSuffix: "ST", streetSuffixWord: "Street", unitType: "APT", unitTypeWord: "Apartment",
  });
});

check("PLANNER: the components are the binder's to place — the model's field view leaves them out", () => {
  // The components are put in explicitly, so this fails on the planner's filter alone.
  const view = plannerFieldView({ ...SE_AVE, ...addressComponentFields("1234 SE Example Ave, Testville, OR 97000") });
  for (const k of ADDRESS_COMPONENT_FIELD_KEYS) assert.equal(k in view, false, `${k} reached the planner`);
  assert.equal(view.streetNumber, "1234", "the street line's own keys are untouched");
});

check("MUST-PASS (learn): Direction / Street Type literals bind to the component keys, the literal dropped", () => {
  const { steps, bound } = convertLiteralsToBoundFields(SEARCH, SE_AVE);
  assert.equal(steps[2].field, "streetDirection");
  assert.equal(steps[2].value, undefined, "the learn job's NW is not kept");
  assert.equal(steps[4].field, "streetSuffix");
  assert.equal(steps[4].value, undefined);
  assert.ok(bound.some((b) => b.field === "streetDirection") && bound.some((b) => b.field === "streetSuffix"));
  assert.equal(steps[5].value, "Single-Family", "MUST-EXCLUDE: a portal constant beside them stays");
});

check("MUST-EXCLUDE (learn): an array's Direction, a bare Direction on another page, the contractor's own address", () => {
  const steps: RecipeStep[] = [
    ADVANCE,
    st("select", "Direction:", { value: "S" }), // no address search on this page: an array's facing
    st("select", "Array Direction", { value: "S" }),
    ADVANCE,
    st("fill", "Street No.:", { field: "streetNumber" }),
    st("select", "Street Type:", { value: "ST", selector: { label: "Street Type:", frame: "iframe#contact" } } as Partial<RecipeStep>),
    st("select", "Street Type:", { value: "ST", note: "Street Type: [contractor]" }),
    st("select", "Street Type:", { value: "Private Road" }), // not a street-type word
  ];
  const out = convertLiteralsToBoundFields(steps, SE_AVE).steps;
  assert.equal(out[1].value, "S", "a bare Direction with no address search beside it");
  assert.equal(out[2].value, "S", "an array's direction");
  assert.equal(out[5].value, "ST", "a framed contact dialog's address");
  assert.equal(out[6].value, "ST", "the filing company's own block");
  assert.equal(out[7].value, "Private Road");
  assert.equal(addressComponentKeyFor("Name Suffix", "Jr", { addressSearchOnPage: true }), null, "a person's name suffix is not a street's");
});

check("MUST-PASS (replay, R13): an existing recipe's NW / ST bind to THIS project's SE / AVE, named", () => {
  const b = bind(SEARCH, SE_AVE);
  const dir = b.steps.find((s) => s.selector?.label === "Direction:")!;
  const type = b.steps.find((s) => s.selector?.label === "Street Type:")!;
  assert.equal(dir.field, "streetDirection");
  assert.equal(dir.value, undefined);
  assert.equal(type.field, "streetSuffix");
  assert.ok(b.changes.some((c) => c.kind === "rebound" && /street direction "SE", not the recorded "NW"/.test(c.reason)), JSON.stringify(b.changes));
});

check("MUST-PASS (replay, R13): a directionless address strips the Direction step, named — never the learn job's NW", () => {
  const b = bind(SEARCH, WAY);
  assert.equal(b.steps.some((s) => s.selector?.label === "Direction:"), false);
  assert.ok(b.changes.some((c) => c.kind === "stripped" && /no street direction/.test(c.reason)));
  assert.equal(b.steps.find((s) => s.selector?.label === "Street Type:")?.field, "streetSuffix");
});

check("MUST-PASS (replay, R13): a recorded WORD binds to the word form (\"Street\" -> streetSuffixWord)", () => {
  const words = SEARCH.map((s) => (s.selector?.label === "Street Type:" ? { ...s, value: "Street" } : s.selector?.label === "Direction:" ? { ...s, value: "Northwest" } : s));
  const b = bind(words, SE_AVE);
  assert.equal(b.steps.find((s) => s.selector?.label === "Street Type:")?.field, "streetSuffixWord");
  assert.equal(b.steps.find((s) => s.selector?.label === "Direction:")?.field, "streetDirectionWord");
});

// ── (4) FEE-LINE SIBLINGS ───────────────────────────────────────────────────────────────────────
// The Tigard shape: two services boxes fee-bound, two more boxes on the same page frozen.
const FEE_PAGE: RecipeStep[] = [
  ADVANCE,
  st("fill", "*Exact kVA", { field: "systemSizeAcKw" }),
  st("fill", "*Under 200 Amps", { field: "feeLineQuantity:servicesFeeders200A" }),
  st("fill", "*201- 400 Amps", { field: "feeLineQuantity:servicesFeeders201to400A" }),
  st("fill", "*Without Service or Feeder", { value: "1" }),
  st("fill", "*With Service or Feeder", { value: "0" }),
  st("fill", "Services or feeders: 200 amps or less (qty)", { value: "1" }),
  ADVANCE,
  st("fill", "New/Added Building:", { value: "0" }), // a count on a page with no fee line
  ADVANCE,
];
const FEE_VALUES = { ...SE_AVE, [SERVICE_FEEDER_200A_FIELD]: "0" };

check("MUST-PASS (R14): an unbound count beside fee-bound siblings is never the learn job's count", () => {
  const b = bind(FEE_PAGE, FEE_VALUES);
  const without = b.steps.find((s) => s.selector?.label === "*Without Service or Feeder")!;
  const withS = b.steps.find((s) => s.selector?.label === "*With Service or Feeder")!;
  assert.equal(without.field, REPLAY_BLANK_FIELD, "the learn job's 1");
  assert.equal(without.value, "");
  assert.equal(withS.field, REPLAY_BLANK_FIELD, "the learn job's 0");
  assert.match(String(without.operatorItem), /left blank for a person/);
  const services = b.steps.find((s) => /^Services or feeders/.test(String(s.selector?.label)))!;
  assert.equal(services.field, SERVICE_FEEDER_200A_FIELD, "a services/feeders label binds to its key");
  assert.equal(services.value, undefined);
});

check("MUST-EXCLUDE (R14): a count on a page with no fee line, and the fee-bound siblings themselves, are untouched", () => {
  const b = bind(FEE_PAGE, FEE_VALUES);
  const added = b.steps.find((s) => s.selector?.label === "New/Added Building:")!;
  assert.equal(added.value, "0");
  assert.equal(added.field, undefined);
  assert.equal(b.steps.find((s) => s.selector?.label === "*Under 200 Amps")?.field, "feeLineQuantity:servicesFeeders200A");
});

// ── (3) THE VALUE'S SHAPE ───────────────────────────────────────────────────────────────────────
check("MUST-PASS (R2): free text carrying the learn roof's orientation is blanked, named", () => {
  const b = bind([
    ADVANCE,
    st("fill", "*Describe Location of Solar Array", { value: "Roof-mounted PV array on existing single-family dwelling, south-facing (135° azimuth, 18° tilt)" }),
    st("fill", "Description:", { value: "Electrical plan set" }),
    ADVANCE,
  ], SE_AVE);
  const loc = b.steps.find((s) => /Describe Location/.test(String(s.selector?.label)))!;
  assert.equal(loc.field, REPLAY_BLANK_FIELD);
  assert.ok(b.changes.some((c) => c.kind === "blanked" && /\(orientation\)/.test(c.reason)));
  assert.equal(b.steps.find((s) => s.selector?.label === "Description:")?.value, "Electrical plan set", "MUST-EXCLUDE: a portal's phrase");
});

check("jobValueShape: each job-data shape, and the portal's own words that must stay", () => {
  for (const [v, want] of [
    ["south-facing (180° azimuth, 22° tilt)", "orientation"],
    ["tilt 20 deg", "orientation"],
    ["8.36 kW DC / 7.68 kW AC", "electrical units"],
    ["440W", "electrical units"],
    ["200 A main panel", "electrical units"],
    ["13.5 kWh", "electrical units"],
    ["(19) Test Module 400", "module count"],
    ["1234 SE Example Ave", "street address"],
    ["Roof mounted system on the main house. Conduit runs along the north side.", "prose"],
  ] as const) assert.equal(jobValueShape(v), want, v);
  for (const v of ["STAND-ALONE", "Solar PV System Installation", "Residential", "Single-Family", "Electrical plan set",
    "Unit 1 A", "Level 2", "Lot 3 W", "Corner of N. Main and St. Louis Rd. by the gate", "Roof", "Contractor", "01 Electrical Plans", "1", "0", "89"]) {
    assert.equal(jobValueShape(v), null, `"${v}" read as job data`);
  }
});

try { (db as unknown as { close?: () => void }).close?.(); } catch { /* scratch */ }
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* Windows may hold the file a moment */ }
if (failures) { console.error(`\n${failures} unbound-learn-literal check(s) FAILED.`); process.exit(1); }
console.log("\nunbound learn literals (backend): every check passed.");
