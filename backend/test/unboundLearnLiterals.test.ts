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
const { ADDRESS_COMPONENT_FIELD_KEYS, ADDRESS_COMPONENTS_UNREAD_KEY, addressComponentFields, addressComponentKeyFor, parseStreetName } = await import("../../portal-bot/src/addressParse");
const { recipeStageGaps } = await import("../src/recipeStageGaps");
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
  // A directional written AFTER the street: the leading Direction is not claimed empty (a single
  // "Direction" control may want that NW) — it is named unread.
  assert.deepEqual(addressComponentFields("77 Main St NW Apt 4, Town, OR"), {
    streetPostDirection: "NW", streetPostDirectionWord: "Northwest",
    streetSuffix: "ST", streetSuffixWord: "Street", unitType: "APT", unitTypeWord: "Apartment",
    [ADDRESS_COMPONENTS_UNREAD_KEY]: "streetDirection,streetDirectionWord",
  });
});

// ── (1b) THE STREET LINE IS READ ONCE, AND AN UNKNOWN IS NEVER "NONE" (#236 review) ──────────────
// The first reader stopped at any token spelling a state code ("ne" = Nebraska, "ct" = Connecticut,
// "la", "de"): an NE-quadrant or Court address read as having no direction / no type, and R13 then
// stripped those controls saying so. And the name box was cut by a second grammar, so one search's
// boxes disagreed ("1234 North Ave" searched name "Ave").
const at = (a: string) => resolveRecipeFieldValues(db, projectAt(a), "accela");
check("RESOLVER: state-code street words read as street words — NE … Ct, La Paloma, De Anza", () => {
  const ne = at("1234 NE Example Ct, Testville, OR 97000");
  assert.equal(ne.streetDirection, "NE");
  assert.equal(ne.streetSuffix, "CT");
  assert.equal(ne.streetNameCore, "Example");
  const ct = at("2468 Example Ct, Testville, OR 97000");
  assert.equal(ct.streetSuffix, "CT", "a Court is a street type, not Connecticut");
  assert.equal(ct.streetDirection, "");
  for (const [a, name, sfx] of [["1234 La Paloma Dr, Testville, CA 90000", "La Paloma", "DR"], ["1234 De Anza Blvd, Testville, CA 90000", "De Anza", "BLVD"]]) {
    const v = at(a);
    assert.equal(v.streetNameCore, name, a);
    assert.equal(v.streetSuffix, sfx, a);
  }
});
check("RESOLVER: the number, direction, name and type boxes of one search agree (one reading)", () => {
  for (const [a, dir, name, sfx] of [
    ["1234 North Ave, Testville, OR 97000", "", "North", "AVE"],
    ["500 Northeast Larkspur Way, Testville, OR 97000", "NE", "Larkspur", "WAY"],
    ["45 Example Point Rd, Testville, OR 97000", "", "Example Point", "RD"],
    ["1234 Example Cove, Testville, OR 97000", "", "Example", "CV"],
    ["925 N Grant St, Lafayette, OR, 97127", "N", "Grant", "ST"],
  ] as const) {
    const v = at(a);
    assert.deepEqual([v.streetDirection, v.streetNameCore, v.streetSuffix], [dir, name, sfx], a);
    assert.equal(parseStreetName(a), name, `${a}: the name parser is the same reading`);
  }
});
check("RESOLVER: what the reader could not read is NAMED unread, never emitted as \"\"", () => {
  const plz = at("1234 Example Plz, Testville, OR 97000"); // a suffix outside the shared list
  assert.equal("streetSuffix" in plz, false, "no street type is claimed for a Plz");
  assert.equal(plz[ADDRESS_COMPONENTS_UNREAD_KEY], "streetSuffix,streetSuffixWord");
  assert.equal(plz.streetDirection, "", "the direction is still certain: none");
  const runOn = at("925 N Grant St Lafayette OR 97127"); // no comma: its city, state and ZIP are in the line
  assert.equal("streetDirection" in runOn || "streetSuffix" in runOn, false);
  assert.match(String(runOn[ADDRESS_COMPONENTS_UNREAD_KEY]), /streetDirection,.*streetSuffix/);
});

check("MUST-PASS (replay, R13): an NE … Ct project searches NE … CT — never stripped as \"no direction\"", () => {
  const ne = at("1234 NE Example Ct, Testville, OR 97000");
  const b = bind(SEARCH, ne);
  assert.equal(b.steps.find((s) => s.selector?.label === "Direction:")?.field, "streetDirection");
  assert.equal(b.steps.find((s) => s.selector?.label === "Street Type:")?.field, "streetSuffix");
  assert.equal(b.changes.some((c) => c.kind === "stripped"), false, JSON.stringify(b.changes));
  const learned = bind(convertLiteralsToBoundFields(SEARCH, SE_AVE).steps, ne);
  assert.equal(learned.steps.find((s) => s.selector?.label === "Street Type:")?.field, "streetSuffix", "a step bound at learn too");
});
check("MUST-PASS (replay, R13): an UNREAD component is left blank for a person, named — not stripped, not the learn job's", () => {
  const plz = at("1234 Example Plz, Testville, OR 97000");
  for (const steps of [SEARCH, convertLiteralsToBoundFields(SEARCH, SE_AVE).steps]) {
    const b = bind(steps, plz);
    const type = b.steps.find((s) => s.selector?.label === "Street Type:");
    assert.ok(type, "the Street Type step is kept — never stripped as \"the address has no street type\"");
    assert.equal(type!.field, REPLAY_BLANK_FIELD);
    assert.equal(type!.value, "");
    assert.match(String(type!.operatorItem), /street type could not be read from its address, so it is left blank for a person/);
    assert.equal(b.changes.some((c) => /has no street type/.test(c.reason)), false, JSON.stringify(b.changes));
    assert.equal(b.steps.some((s) => s.selector?.label === "Direction:"), false, "its direction IS certain (none): stripped");
  }
  const runOn = bind(SEARCH, at("925 N Grant St Lafayette OR 97127"));
  assert.equal(runOn.steps.find((s) => s.selector?.label === "Direction:")?.field, REPLAY_BLANK_FIELD, "an unreadable line: blank for a person");
  assert.ok(runOn.changes.some((c) => c.kind === "blanked" && /never the recorded "NW"/.test(c.reason)), JSON.stringify(runOn.changes));
});
check("MUST-EXCLUDE (replay, R13): a value dictionary with no component reading leaves the step as before", () => {
  const b = bind(SEARCH, { streetNumber: "1234", streetNameCore: "Example" });
  assert.equal(b.steps.find((s) => s.selector?.label === "Street Type:")?.value, "ST");
  assert.equal(b.steps.find((s) => s.selector?.label === "Street Type:")?.field, undefined);
});
check("MUST-EXCLUDE (learn): an address component is never bound by VALUE (\"Roof Facing\" = \"Southwest\" at an SW address)", () => {
  const sw = at("123 SW Example St, Testville, OR 97000");
  assert.equal(sw.streetDirectionWord, "Southwest");
  const { steps } = convertLiteralsToBoundFields([
    ADVANCE,
    st("select", "Roof Facing", { value: "Southwest" }),
    st("select", "Array Azimuth Direction", { value: "SW" }),
    ADVANCE,
  ], sw);
  assert.equal(steps[1].field, undefined, "the roof's facing is not the street's direction");
  assert.equal(steps[1].value, "Southwest");
  assert.equal(steps[2].field, undefined);
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

check("MUST-PASS (replay, R13): a step BOUND at learn is stripped on a directionless job — never a blank the stage gate holds for", () => {
  const learned = convertLiteralsToBoundFields(SEARCH, SE_AVE).steps;
  const b = bind(learned, WAY);
  assert.equal(b.steps.some((s) => s.field === "streetDirection"), false);
  assert.ok(b.changes.some((c) => c.kind === "stripped" && /no street direction/.test(c.reason)));
  const again = bind(learned, SE_AVE);
  assert.equal(again.steps.find((s) => s.selector?.label === "Direction:")?.field, "streetDirection");
  assert.equal(again.changes.some((c) => /street direction/.test(c.reason)), false, "an already-bound step is not re-announced every replay");
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
