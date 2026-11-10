// THE BATTERY (ESS) REVIEW, THE WAY THE AHJ DOES IT (review-audit draft 05, essReview.ts).
//
// The storage review used to be one keyword check: any of "706 / R328 / clearance …" anywhere cleared
// it, and nothing compared the battery facts with a rule. These checks pin the new review: the facts
// read from the sheets, the model-code baseline everywhere (warning), a jurisdiction's own cited rule
// applied where a person verified it or it came from the official page, and a blocker only on that
// rule's verbatim citation AND a value stated on the package's own sheets (Helm's #637 bar).
//
// Every job, address, product and jurisdiction here is invented. Run: npx tsx backend/test/essReview.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ess-review-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";

const { openDatabase } = await import("../src/db");
const { buildCodeContext, getCodeProfile, resolveEffectiveCodeContext, saveResearchedCodeProfile, saveVerifiedCodeProfile } = await import("../src/codeProfiles");
const { buildReviewerReport } = await import("../src/reviewerEngine");
const { evaluateDesignCodeFindings } = await import("../src/codeReviewRules");
const { readEssFacts, resolveEssRules, ESS_MEASURED_FINDING_IDS } = await import("../src/essReview");
const { MEASURED_FINDING_IDS } = await import("../src/reviewerVision");
const { codeProfileVerifySchema } = await import("../src/validation");
type Profile = import("../../shared/src/types").JurisdictionCodeProfile;
type Project = import("../../shared/src/types").ProjectRecord;
type Finding = import("../../shared/src/types").ReviewerFinding;

const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const STATE = "ZQ";
const AHJ = "Town of Lantern Ridge";
// The rest of a realistic sheet, so only the ESS facts move.
const SHEET_BASE = '36" FIRE ACCESS PATHWAY PER IFC 1205.2. RAPID SHUTDOWN PER NEC 690.12. 705.12 BUSBAR CALC. SITE PLAN AND ROOF PLAN. SINGLE LINE DIAGRAM. LABEL SCHEDULE.';
// Everything an AHJ asks except what a case changes (invented product).
const DISCONNECT_OK = "ESS DISCONNECT ON EXTERIOR WALL BESIDE THE METER. LABEL: ENERGY STORAGE SYSTEM DISCONNECT, 240 V.";
const GARAGE_OK = "BOLLARDS IN FRONT OF THE BATTERIES. SMOKE ALARM IN GARAGE INTERCONNECTED. 5/8 TYPE X GYPSUM ON GARAGE WALLS.";

function job(sheet: string, snap: Record<string, string> = {}, opts: { documents?: boolean } = {}): Project {
  return {
    id: "ess-job", clientId: "client-ess", homeownerName: "Storage Probe", projectAddress: "7 Example Row",
    city: "Lantern Ridge", state: STATE, zip: "00002", ahj: AHJ, utility: "Example Basin Electric",
    systemSizeDcKw: 8.6, systemSizeAcKw: 7.6, interconnectionMethod: "Load-side breaker", status: "pending",
    parserSnapshot: {
      state: STATE, ahj: AHJ, utility: "Example Basin Electric",
      mounting: "Roof mount", busRating: "225A", mainBreaker: "175A", pvBreaker: "40",
      moduleMake: "Examplesolar", moduleModel: "EX-430", moduleWattage: "430", moduleQty: "20", dcKw: "8.6",
      batteryMake: "Examplecell", batteryModel: "EXC-13", hasBattery: "Yes",
      ...(opts.documents === false ? {} : { planSetExtractedText: `${SHEET_BASE} ${sheet}` }),
      ...snap,
    },
  } as unknown as Project;
}

function profile(over: Partial<Profile> & { essRules?: Profile["essRules"] } = {}): Profile {
  return {
    key: `${STATE.toLowerCase()}|${AHJ.toLowerCase()}|`, state: STATE, ahj: AHJ, confidence: "seeded",
    adoptedCodes: [{ code: "NEC", edition: "2023" }, { code: "IRC", edition: "2021" }, { code: "IFC", edition: "2021" }],
    amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
    ...over,
  } as Profile;
}
const CITED_GARAGE_40 = { label: "Lantern Ridge ESS handout (invented)", sourceUrl: "https://lanternridge.example.gov/ess.pdf", field: "essRules.maxAggregateKwhGarage", quote: "The aggregate rating of ESS in a garage shall not exceed 40 kWh." };

const findings = (p: Project, prof: Profile | null = null): Finding[] =>
  evaluateDesignCodeFindings(p, null, prof ? buildCodeContext(STATE, AHJ, prof) : undefined);
const find = (fs_: Finding[], id: string) => fs_.find((f) => f.id === id);

console.log("\n1. THE GAP: a citation word no longer clears a storage review");
await check("REGRESSION: 3 x 13.5 kWh in a utility closet with an 'NEC 706 / IRC R328' note is over 40 kWh (the keyword check passed it silently)", () => {
  const p = job("ESS NOTES PER NEC 706 AND IRC R328. (3) EXAMPLECELL BATTERY 13.5 KWH. BATTERY LOCATION: UTILITY CLOSET.");
  const f = findings(p);
  const over = find(f, "city.ess.aggregate-rating-over");
  assert.ok(over, `no aggregate finding: ${f.filter((x) => x.id.startsWith("city.ess")).map((x) => x.id).join(", ") || "(no ESS findings at all)"}`);
  assert.equal(over!.severity, "warning", "a model-code baseline only warns");
  assert.match(over!.message, /40\.5 kWh/);
  assert.match(over!.message, /40 kWh/);
});
await check("2 x 13.5 kWh = 27 kWh in a utility closet is within the 40 kWh limit", () => {
  const f = findings(job("(2) EXAMPLECELL BATTERY 13.5 KWH. BATTERY LOCATION: UTILITY CLOSET."));
  assert.ok(!find(f, "city.ess.aggregate-rating-over"));
  assert.ok(!find(f, "city.ess.unit-rating-over"));
});

console.log("\n2. LOCATION LIMITS");
await check("garage: 80 kWh is the limit, 80.4 kWh is over and 80 kWh is not", () => {
  const over = findings(job(`6 x 13.4 KWH BATTERIES. BATTERY LOCATION: GARAGE. ${GARAGE_OK} ${DISCONNECT_OK}`));
  assert.ok(find(over, "city.ess.aggregate-rating-over"), "80.4 kWh in a garage");
  const at = findings(job(`4 x 20 KWH BATTERIES. BATTERY LOCATION: GARAGE. ${GARAGE_OK} ${DISCONNECT_OK}`));
  assert.ok(!find(at, "city.ess.aggregate-rating-over"), "exactly 80 kWh is within the limit");
});
await check("a unit over 20 kWh is over the per-unit limit", () => {
  const f = findings(job(`(1) EXAMPLECELL BATTERY 24 KWH. BATTERY LOCATION: GARAGE. ${GARAGE_OK} ${DISCONNECT_OK}`));
  assert.equal(find(f, "city.ess.unit-rating-over")?.severity, "warning");
});
await check("a battery in a bedroom is a location the code does not permit", () => {
  const f = findings(job(`(1) EXAMPLECELL BATTERY 13.5 KWH. BATTERY LOCATION: MASTER BEDROOM CLOSET. ${DISCONNECT_OK}`));
  const loc = find(f, "city.ess.location-not-permitted");
  assert.ok(loc, "habitable location not flagged");
  assert.equal(loc!.severity, "warning");
});
await check("a copied code note ('SHALL NOT BE INSTALLED IN SLEEPING ROOMS') is not the job's location", () => {
  const f = findings(job(`ESS SHALL NOT BE INSTALLED IN SLEEPING ROOMS OR HABITABLE SPACES. (1) EXAMPLECELL BATTERY 13.5 KWH. BATTERY LOCATION: GARAGE. ${GARAGE_OK} ${DISCONNECT_OK}`));
  assert.ok(!find(f, "city.ess.location-not-permitted"));
  assert.deepEqual([...new Set(readEssFacts(job(`ESS SHALL NOT BE INSTALLED IN SLEEPING ROOMS. (1) EXAMPLECELL BATTERY 13.5 KWH MOUNTED IN THE GARAGE.`)).locations.map((l) => l.value))], ["garage"]);
});
await check("an exterior-wall battery 24 in from a window is too close; 48 in is not", () => {
  const near = findings(job(`(1) EXAMPLECELL BATTERY 13.5 KWH, UL 9540. BATTERY LOCATION: EXTERIOR WALL. BATTERY 24 IN FROM NEAREST WINDOW. ${DISCONNECT_OK}`));
  assert.equal(find(near, "city.ess.opening-clearance-under")?.severity, "warning");
  const far = findings(job(`(1) EXAMPLECELL BATTERY 13.5 KWH, UL 9540. BATTERY LOCATION: EXTERIOR WALL. BATTERY 4 FT FROM NEAREST WINDOW. ${DISCONNECT_OK}`));
  assert.ok(!find(far, "city.ess.opening-clearance-under"));
  assert.ok(!find(far, "city.ess.details-missing"), `a full exterior-wall detail still warned: ${find(far, "city.ess.details-missing")?.message}`);
});

console.log("\n3. SPACING (UL 9540A is a per-AHJ allowance)");
await check("two units 6 in apart with no test basis are under the 3 ft spacing", () => {
  const f = findings(job(`(2) EXAMPLECELL BATTERY 13.5 KWH, UL 9540. BATTERIES 6 IN APART. BATTERY LOCATION: GARAGE. ${GARAGE_OK} ${DISCONNECT_OK}`));
  assert.equal(find(f, "city.ess.unit-spacing-under")?.severity, "warning");
});
await check("UL 9540A named but no rule on file accepting it: still warns, naming the jurisdiction", () => {
  const f = findings(job(`(2) EXAMPLECELL BATTERY 13.5 KWH, UL 9540, UL 9540A TESTED. BATTERIES 6 IN APART. BATTERY LOCATION: GARAGE. ${GARAGE_OK} ${DISCONNECT_OK}`), profile());
  const s = find(f, "city.ess.unit-spacing-under");
  assert.ok(s && s.message.includes(AHJ), s?.message);
});
await check("UL 9540A named and a verified AHJ rule accepting it: no spacing finding", () => {
  const f = findings(job(`(2) EXAMPLECELL BATTERY 13.5 KWH, UL 9540, UL 9540A TESTED. BATTERIES 6 IN APART. BATTERY LOCATION: GARAGE. ${GARAGE_OK} ${DISCONNECT_OK}`),
    profile({ confidence: "verified", essRules: { spacingReductionBy9540A: true } }));
  assert.ok(!find(f, "city.ess.unit-spacing-under"));
});
await check("a SEEDED rule accepting UL 9540A is not applied (it would relax the baseline)", () => {
  const f = findings(job(`(2) EXAMPLECELL BATTERY 13.5 KWH, UL 9540, UL 9540A TESTED. BATTERIES 6 IN APART. BATTERY LOCATION: GARAGE. ${GARAGE_OK} ${DISCONNECT_OK}`),
    profile({ essRules: { spacingReductionBy9540A: true } }));
  assert.ok(find(f, "city.ess.unit-spacing-under"));
});

console.log("\n4. WHAT THE PLAN DOES NOT SHOW: one warning that lists it");
await check("a battery with no disconnect, listing or location: one 'ESS detail not shown' warning naming each", () => {
  const f = findings(job("(1) EXAMPLECELL BATTERY 13.5 KWH."));
  const d = find(f, "city.ess.details-missing");
  assert.ok(d);
  assert.equal(d!.severity, "warning");
  assert.match(d!.message, /^ESS detail not shown: /);
  for (const item of [/UL 9540 listing/, /ESS location/, /disconnecting means \(NEC 706\.15\)/]) assert.match(d!.message, item);
  assert.equal(f.filter((x) => x.id === "city.ess.details-missing").length, 1);
});
await check("a garage battery owes impact protection, an alarm and the dwelling separation", () => {
  const d = find(findings(job(`(1) EXAMPLECELL BATTERY 13.5 KWH, UL 9540. BATTERY LOCATION: GARAGE. ${DISCONNECT_OK}`)), "city.ess.details-missing");
  assert.ok(d);
  for (const item of [/Vehicle-impact protection/, /Smoke alarm/, /Garage-to-dwelling separation/]) assert.match(d!.message, item);
});
await check("NEC edition decides the disconnect location: 2023 asks for outside, 2017 does not", () => {
  const sheet = "(1) EXAMPLECELL BATTERY 13.5 KWH, UL 9540. BATTERY LOCATION: UTILITY ROOM. SMOKE ALARM IN UTILITY ROOM. FINISHED WALLS. ESS DISCONNECT IN UTILITY ROOM, LABEL: ENERGY STORAGE SYSTEM DISCONNECT.";
  const nec23 = find(findings(job(sheet), profile()), "city.ess.details-missing");
  assert.ok(nec23 && /outside the dwelling/.test(nec23.message), nec23?.message);
  const nec17 = find(findings(job(sheet), profile({ adoptedCodes: [{ code: "NEC", edition: "2017" }, { code: "IRC", edition: "2018" }] } as Partial<Profile>)), "city.ess.details-missing");
  assert.ok(!nec17, nec17?.message);
});
await check("the adopted IRC edition picks the section: 2018 cites R327, 2021 R328", () => {
  const sheet = "(3) EXAMPLECELL BATTERY 13.5 KWH. BATTERY LOCATION: UTILITY CLOSET.";
  const s21 = find(findings(job(sheet), profile()), "city.ess.aggregate-rating-over")!;
  assert.ok(s21.codeReferences.some((r) => /R328\.5/.test(r.section)), JSON.stringify(s21.codeReferences.map((r) => r.section)));
  const s18 = find(findings(job(sheet), profile({ adoptedCodes: [{ code: "NEC", edition: "2020" }, { code: "IRC", edition: "2018" }] } as Partial<Profile>)), "city.ess.aggregate-rating-over")!;
  assert.ok(s18.codeReferences.some((r) => r.section === "R327"), JSON.stringify(s18.codeReferences.map((r) => r.section)));
});

console.log("\n5. WHOSE RULE, AND WHEN IT BLOCKS (Helm's #637 bar)");
const GARAGE_54 = `(4) EXAMPLECELL BATTERY 13.5 KWH, UL 9540. BATTERY LOCATION: GARAGE. ${GARAGE_OK} ${DISCONNECT_OK}`;
await check("model-code only: 54 kWh in a garage is within 80, no finding", () => {
  assert.ok(!find(findings(job(GARAGE_54)), "city.ess.aggregate-rating-over"));
});
await check("a VERIFIED AHJ rule (40 kWh in garages) quoted verbatim with its source BLOCKS a sheet-stated 54 kWh", () => {
  const f = find(findings(job(GARAGE_54), profile({ confidence: "verified", verifiedBy: "Pat Example", essRules: { maxAggregateKwhGarage: 40 }, citations: [CITED_GARAGE_40] })), "city.ess.aggregate-rating-over");
  assert.equal(f?.severity, "blocker", f?.message);
  assert.ok(f!.codeReferences.some((r) => r.code === "Jurisdiction ESS rule" && /human-verified by Pat Example/.test(r.adoptionScope)));
});
await check("the same rule SEEDED is applied (stricter) but only warns", () => {
  const f = find(findings(job(GARAGE_54), profile({ essRules: { maxAggregateKwhGarage: 40 }, citations: [CITED_GARAGE_40] })), "city.ess.aggregate-rating-over");
  assert.equal(f?.severity, "warning");
  assert.match(f!.message, /seeded/);
});
await check("VERIFIED but no verbatim quote of the value: warns", () => {
  const f = find(findings(job(GARAGE_54), profile({ confidence: "verified", essRules: { maxAggregateKwhGarage: 40 }, citations: [{ ...CITED_GARAGE_40, quote: "Garage limits apply." }] })), "city.ess.aggregate-rating-over");
  assert.equal(f?.severity, "warning");
});
await check("OFFICIAL tier (#683) on a seeded row blocks under the same bar", () => {
  const official = { ...CITED_GARAGE_40, tier: "official" as const, fetchedAt: "2026-11-09T12:00:00Z" };
  const f = find(findings(job(GARAGE_54), profile({ essRules: { maxAggregateKwhGarage: 40 }, citations: [official] })), "city.ess.aggregate-rating-over");
  assert.equal(f?.severity, "blocker", f?.message);
  assert.ok(f!.codeReferences.some((r) => /from lanternridge\.example\.gov/.test(r.adoptionScope)));
});
await check("a value only the parser read (no sheet text) never blocks, even on a verified cited rule", () => {
  const p = job("", { batteryQty: "4", essKwh: "54", essLocation: "Garage" }, { documents: false });
  const f = find(findings(p, profile({ confidence: "verified", essRules: { maxAggregateKwhGarage: 40 }, citations: [CITED_GARAGE_40] })), "city.ess.aggregate-rating-over");
  assert.equal(f?.severity, "warning", f?.message);
});
await check("a SEEDED relaxation (60 kWh in utility spaces) is not applied; a VERIFIED one is", () => {
  const sheet = "(3) EXAMPLECELL BATTERY 13.5 KWH. BATTERY LOCATION: UTILITY CLOSET.";
  assert.ok(find(findings(job(sheet), profile({ essRules: { maxAggregateKwhUtilitySpace: 60 } })), "city.ess.aggregate-rating-over"), "seeded relaxation applied");
  assert.ok(!find(findings(job(sheet), profile({ confidence: "verified", essRules: { maxAggregateKwhUtilitySpace: 60 } })), "city.ess.aggregate-rating-over"), "verified relaxation ignored");
  const r = resolveEssRules(buildCodeContext(STATE, AHJ, profile({ essRules: { maxAggregateKwhUtilitySpace: 60 } })));
  assert.equal(r.maxAggregateKwhUtilitySpace.value, 40);
  assert.equal(r.maxAggregateKwhUtilitySpace.unappliedSeeded, 60);
});
await check("a verified residential-listing exemption lifts the kWh limits for a marked UL 9540 unit, never the bedroom rule", () => {
  const prof = profile({ confidence: "verified", essRules: { listedResidentialExemption: true } });
  const marked = "(3) EXAMPLECELL BATTERY 13.5 KWH, UL 9540 LISTED, MARKED FOR USE IN RESIDENTIAL DWELLING UNITS.";
  assert.ok(!find(findings(job(`${marked} BATTERY LOCATION: UTILITY CLOSET.`), prof), "city.ess.aggregate-rating-over"));
  assert.ok(find(findings(job(`${marked} BATTERY LOCATION: UTILITY CLOSET.`), profile()), "city.ess.aggregate-rating-over"), "the baseline grants no exemption");
  assert.ok(find(findings(job(`${marked} BATTERY LOCATION: BEDROOM.`), prof), "city.ess.location-not-permitted"));
});

console.log("\n6. SCOPE");
await check("a storage-only job (no new modules) gets the ESS review", () => {
  const p = job(`(1) EXAMPLECELL BATTERY 24 KWH. BATTERY LOCATION: GARAGE.`, { moduleMake: "", moduleModel: "", moduleWattage: "", moduleQty: "", dcKw: "", newModulesOnSchedule: "No", newModulesOnSld: "No" });
  assert.ok(find(findings(p), "city.ess.unit-rating-over"));
});
await check("a job with hasBattery 'Yes' but no storage words on the sheets still gets the review (the one battery predicate)", () => {
  const p = job("", { batteryModel: "", batteryMake: "", hasBattery: "Yes" });
  assert.ok(find(findings(p), "city.ess.details-missing"));
});
await check("every measured ESS finding is out of vision's reach; the 'not shown' warning is not", () => {
  for (const id of ESS_MEASURED_FINDING_IDS) assert.ok(MEASURED_FINDING_IDS.has(id), id);
  assert.ok(!MEASURED_FINDING_IDS.has("city.ess.details-missing"));
});
await check("the full reviewer report carries the measured finding (end to end)", () => {
  const r = buildReviewerReport(job("(3) EXAMPLECELL BATTERY 13.5 KWH. BATTERY LOCATION: UTILITY CLOSET."), { codeContext: buildCodeContext(STATE, AHJ, profile()) });
  assert.ok(r.findings.some((f) => f.id === "city.ess.aggregate-rating-over"));
});

console.log("\n7. THE RULES AS STORED DATA (layered read, rule 3)");
await check("state row seeded + AHJ row verified: the AHJ's ESS value answers as verified, field by field", () => {
  saveResearchedCodeProfile(db, profile({ ahj: "", key: "", essRules: { maxUnitKwh: 18, minUnitSpacingIn: 48 } }));
  saveVerifiedCodeProfile(db, profile({ essRules: { maxAggregateKwhGarage: 40 }, citations: [CITED_GARAGE_40] }), "Pat Example");
  const merged = getCodeProfile(db, { state: STATE, ahj: AHJ })!;
  assert.deepEqual(merged.essRules, { maxUnitKwh: 18, minUnitSpacingIn: 48, maxAggregateKwhGarage: 40 });
  assert.equal(merged.fieldSources?.["essRules.maxAggregateKwhGarage"]?.confidence, "verified");
  assert.equal(merged.fieldSources?.["essRules.maxUnitKwh"]?.confidence, "seeded");
  const rules = resolveEssRules(resolveEffectiveCodeContext(db, STATE, AHJ));
  assert.equal(rules.maxAggregateKwhGarage.tier, "verified");
  assert.equal(rules.maxAggregateKwhGarage.blocks, true);
  assert.equal(rules.maxUnitKwh.value, 18, "a seeded STRICTER state value applies");
  assert.equal(rules.maxUnitKwh.blocks, false);
});
await check("a seeded re-save without ESS rules keeps the row's; a verified save stores only what the person sent", () => {
  const stateKey = { state: STATE, ahj: "" };
  const before = getCodeProfile(db, stateKey)!;
  saveResearchedCodeProfile(db, { ...before, essRules: undefined });
  assert.deepEqual(getCodeProfile(db, stateKey)!.essRules, { maxUnitKwh: 18, minUnitSpacingIn: 48 });
  saveVerifiedCodeProfile(db, { ...getCodeProfile(db, stateKey)!, essRules: undefined }, "Pat Example");
  assert.equal(getCodeProfile(db, stateKey)!.essRules, undefined, "rules the person was not shown were locked as verified");
});
await check("stored rules are shape-checked: unknown keys, strings and negatives are dropped", () => {
  saveResearchedCodeProfile(db, profile({ ahj: "Village of Spare Key", key: "", essRules: { maxUnitKwh: -5, minUnitSpacingIn: "36" as unknown as number, bogus: 1, alarmRequired: true } as never }));
  assert.deepEqual(getCodeProfile(db, { state: STATE, ahj: "Village of Spare Key" })!.essRules, { alarmRequired: true });
});
await check("the verify route's schema keeps ESS rules and each citation's field and quote", () => {
  const b = codeProfileVerifySchema.parse({ state: STATE, ahj: AHJ, essRules: { maxAggregateKwhGarage: 40, spacingReductionBy9540A: true }, citations: [CITED_GARAGE_40] });
  assert.deepEqual(b.essRules, { maxAggregateKwhGarage: 40, spacingReductionBy9540A: true });
  assert.equal(b.citations[0].quote, CITED_GARAGE_40.quote);
  assert.equal(b.citations[0].field, "essRules.maxAggregateKwhGarage");
});

fs.rmSync(tmpDir, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} ESS review check(s) FAILED.`); process.exit(1); }
console.log("\nAll ESS review checks passed.");
