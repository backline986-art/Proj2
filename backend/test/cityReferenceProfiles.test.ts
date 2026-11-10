// A CITY'S REFERENCE CODE PROFILE REACHES A PERSON, WITH ITS EFFECTIVE DATES (#561).
//
// A city's shipped reference profile (its adopted editions, its own amendments, its design-criteria
// page) never reached a person: the seeder skipped it whenever ANY row existed for the city, and
// raised no proposal (the state layers did). Effective dates could neither be entered (the verify
// route stripped them) nor proposed (the compare ignored them), so an edition phase-in never applied.
// And the design-criteria reads took the number of a value without its unit. This pins, with
// invented jurisdictions only:
//   1. a dated city reference lands on the SEEDED row already there (editions, blank criteria),
//      not over a grounded research newer than it, and is idempotent;
//   2. on a HUMAN-VERIFIED row it never writes (rule 3): differing editions become a proposal; an
//      edition the row states NEWER than the reference is not proposed backwards;
//   3. effective / mandatory dates and the replaced edition are compared: the same edition with a
//      date the row lacks is a dates-only proposal, and approving it puts the dates on the person's
//      own entry (siblings kept), so the phase-in applies;
//   4. the verify route accepts the dates and refuses a non-date or a mandatory date before the
//      effective one;
//   5. a design-criteria page stating snow, roof snow, frost and seismic category in other units is
//      read with its units (kPa -> psf, feet -> inches, lb/sq ft), lands official from the city's
//      own .gov page, and a value printed in a unit its field cannot hold is dropped.
//
//   npx tsx backend/test/cityReferenceProfiles.test.ts
import "./_isolate"; // FIRST: temp cwd, off the network
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodeEdition, DesignCriteriaResearchResult, JurisdictionCodeProfile, LLMProvider, PermitProcessLookup } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "city-reference-profiles-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.AUTO_STAGE_STEPS = "0";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "AHJ_FORM_DOWNLOADS", "FEE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CODE_RESEARCH;
delete process.env.SKIP_CODE_RESEARCH;

const { openDatabase } = await import("../src/db");
const CP = await import("../src/codeProfiles");
const { editionsInEffect } = await import("../src/codeFamilies");
const { codeProfileVerifySchema } = await import("../src/validation");
const { createPageReader } = await import("../src/agencyPageReader");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const { parseDesignCriteriaLookup } = await import("../src/llm");
const { extractCriteriaTable } = await import("../src/issuerDesignCriteria");
const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

const refPath = path.join(tmp, "reference.json");
const seedWith = (profiles: unknown[]) => {
  fs.writeFileSync(refPath, JSON.stringify({ profiles, stateAdoptions: [] }));
  process.env.CODE_PROFILE_REFERENCE_PATH = refPath;
  CP.resetReferenceCacheForTests();
  CP.seedReferenceCodeProfiles(db);
};
const blank = (over: Partial<JurisdictionCodeProfile>): JurisdictionCodeProfile => ({
  key: "", state: "UT", ahj: "", confidence: "seeded", adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "", ...over,
});
/** A seeded row as research left it (written directly: an AHJ research save is scoped to the
 *  families the state leaves local, and Utah's are uniform). */
const putSeeded = (p: JurisdictionCodeProfile) => {
  const key = CP.codeProfileKey(p);
  const { key: _k, confidence: _c, ...payload } = p;
  db.run("INSERT INTO jurisdiction_code_profiles (profile_key, state, ahj, confidence, payload_json, researched_at, verified_at, verified_by, updated_at) VALUES (?, ?, ?, 'seeded', ?, ?, NULL, NULL, ?)",
    [key, p.state, p.ahj, JSON.stringify(payload), "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"]);
};
const own = (state: string, ahj: string) => CP.ownCodeProfileRow(db, state, ahj)?.profile ?? null;
const SRC = "https://www.brookhollowut.gov/DocumentCenter/View/1/Title-18";
const refCity = (ahj: string, over: Record<string, unknown> = {}) => ({
  key: "", state: "UT", ahj, confidence: "seeded", asOf: "2026-10-06",
  adoptedCodes: [
    { code: "IRC", edition: "2021", family: "residential", sourceUrl: SRC, quote: "The 2021 edition of the International Residential Code" },
    { code: "IBC", edition: "2024", family: "building", sourceUrl: SRC, quote: "The 2024 edition of the International Building Code" },
    { code: "NEC", edition: "2023", family: "electrical", sourceUrl: SRC, quote: "The 2023 edition of the National Electrical Code", effectiveDate: "2025-07-01" },
  ],
  amendments: [{ code: "City Code 19.05.12", section: "Solar Panels", summary: "Ground-mounted arrays only in the rear yard.", sourceUrl: SRC }],
  designCriteria: { groundSnowLoadPsf: 43, roofSnowLoadPsf: 30, frostDepthIn: 30, seismicDesignCategory: "D1", sourceUrl: "https://www.brookhollowut.gov/213/Design-Criteria" },
  prescriptive: {}, fireSetbacks: [],
  citations: [{ label: "Brookhollow City Code Title 18", sourceUrl: SRC }],
  updatedAt: "",
  ...over,
});
const codes = (p: JurisdictionCodeProfile | null) => (p?.adoptedCodes ?? []).map((c) => `${c.code} ${c.edition}`).sort();

// ── 1. A seeded row already there ─────────────────────────────────────────────────────
console.log("1. a dated city reference lands on the seeded row already there");
await check("MUST-PASS: the reference's editions replace a research row's, and its blank criteria are filled", () => {
  putSeeded(blank({ ahj: "City of Brookhollow", adoptedCodes: [{ code: "IRC", edition: "2018", family: "residential", sourceUrl: "https://www.brookhollowut.gov/old" }], designCriteria: { windSpeedMph: 105 },
    researchProvenance: { webGrounded: true, method: "web_search", at: "2026-09-01T00:00:00.000Z" } }));
  assert.deepEqual(codes(own("UT", "City of Brookhollow")), ["IRC 2018"]);
  seedWith([refCity("City of Brookhollow")]);
  const row = own("UT", "City of Brookhollow")!;
  assert.deepEqual(codes(row), ["IBC 2024", "IRC 2021", "NEC 2023"]);
  assert.equal(row.confidence, "seeded", "the row still waits on a person's Review / verify");
  assert.equal(row.designCriteria.windSpeedMph, 105, "the research's own value is kept");
  assert.equal(row.designCriteria.groundSnowLoadPsf, 43, "a blank is filled from the reference");
  assert.equal(row.amendments.length, 1);
  assert.equal(row.researchProvenance?.method, "reference_truth");
  assert.equal(row.adoptedCodes.find((c) => c.code === "NEC")?.effectiveDate, "2025-07-01");
});
await check("idempotent: a second boot changes nothing", () => {
  const before = JSON.stringify(own("UT", "City of Brookhollow"));
  seedWith([refCity("City of Brookhollow")]);
  const after = own("UT", "City of Brookhollow")!;
  assert.equal(JSON.stringify({ ...after, updatedAt: "" }), JSON.stringify({ ...JSON.parse(before), updatedAt: "" }));
});
await check("a grounded research NEWER than the reference is not merged over", () => {
  putSeeded(blank({ ahj: "City of Fernvale", adoptedCodes: [{ code: "IRC", edition: "2024", family: "residential", sourceUrl: "https://www.fernvaleut.gov/codes" }],
    researchProvenance: { webGrounded: true, method: "web_search", at: "2026-11-01T00:00:00.000Z" } }));
  seedWith([refCity("City of Fernvale")]);
  assert.deepEqual(codes(own("UT", "City of Fernvale")), ["IRC 2024"]);
});
await check("a reference profile with no asOf never touches an existing row (as before)", () => {
  putSeeded(blank({ ahj: "City of Ashgrove", adoptedCodes: [{ code: "IRC", edition: "2018", family: "residential" }], researchProvenance: { webGrounded: true, method: "web_search", at: "2026-01-01T00:00:00.000Z" } }));
  seedWith([refCity("City of Ashgrove", { asOf: undefined })]);
  assert.deepEqual(codes(own("UT", "City of Ashgrove")), ["IRC 2018"]);
});

// ── 2. A human-verified row ────────────────────────────────────────────────────────────
console.log("2. a human-verified row is never written; differing editions become a proposal");
await check("MUST-PASS: the verified row is unchanged and a reference proposal awaits a person", () => {
  CP.saveVerifiedCodeProfile(db, blank({ ahj: "City of Millbrook", adoptedCodes: [{ code: "IRC", edition: "2018", family: "residential" }, { code: "NEC", edition: "2023", family: "electrical", effectiveDate: "2025-07-01" }, { code: "IBC", edition: "2024", family: "building" }] }), "Pat Operator");
  seedWith([refCity("City of Millbrook")]);
  const row = own("UT", "City of Millbrook")!;
  assert.equal(row.confidence, "verified");
  assert.deepEqual(codes(row), ["IBC 2024", "IRC 2018", "NEC 2023"], "rule 3");
  const proposals = CP.listEditionProposals(db, row.key);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].source, "reference");
  assert.deepEqual(proposals[0].changes.map((c) => [c.family, c.current, c.proposed]), [["residential", "IRC 2018", "IRC 2021"]]);
});
await check("an edition the verified row states NEWER than the reference is not proposed backwards", () => {
  CP.saveVerifiedCodeProfile(db, blank({ ahj: "City of Oakmere", adoptedCodes: [{ code: "IRC", edition: "2024", family: "residential" }, { code: "IBC", edition: "2024", family: "building" }, { code: "NEC", edition: "2023", family: "electrical", effectiveDate: "2025-07-01" }] }), "Pat Operator");
  seedWith([refCity("City of Oakmere")]);
  assert.deepEqual(CP.listEditionProposals(db, own("UT", "City of Oakmere")!.key), []);
});

// ── 3. Effective dates ─────────────────────────────────────────────────────────────────
console.log("3. effective dates are compared, proposed and applied");
await check("MUST-PASS: the same edition without the reference's effective date is a dates-only proposal", () => {
  CP.saveVerifiedCodeProfile(db, blank({ ahj: "City of Willowby", adoptedCodes: [
    { code: "IRC", edition: "2021", family: "residential" }, { code: "IBC", edition: "2024", family: "building" },
    { code: "NEC", edition: "2023", family: "electrical", notes: "the person's own note" }, { code: "OESC", edition: "2023", family: "electrical", notes: "a sibling entry" },
  ] }), "Pat Operator");
  seedWith([refCity("City of Willowby", { adoptedCodes: [...(refCity("x").adoptedCodes as CodeEdition[]).filter((c) => c.code !== "NEC"),
    { code: "NEC", edition: "2023", family: "electrical", sourceUrl: SRC, effectiveDate: "2025-07-01", mandatoryDate: "2026-01-01", previousEdition: "2020" }] })]);
  const key = own("UT", "City of Willowby")!.key;
  const [p] = CP.listEditionProposals(db, key);
  assert.ok(p, "no proposal");
  assert.deepEqual(p.changes.map((c) => [c.family, c.datesOnly, c.proposed]), [["electrical", true, "NEC 2023, effective 2025-07-01, mandatory 2026-01-01, replaces 2020"]]);
  const r = CP.applyEditionProposal(db, p.fingerprint, "Pat Operator");
  assert.equal(r.status, "applied", r.note);
  const row = own("UT", "City of Willowby")!;
  const nec = row.adoptedCodes.find((c) => c.code === "NEC")!;
  assert.equal(nec.effectiveDate, "2025-07-01");
  assert.equal(nec.mandatoryDate, "2026-01-01");
  assert.equal(nec.previousEdition, "2020");
  assert.equal(nec.notes, "the person's own note", "the dates land on the person's entry");
  assert.ok(row.adoptedCodes.some((c) => c.code === "OESC"), "a sibling entry of the family is kept");
  assert.equal(row.verifiedBy, "Pat Operator");
  assert.deepEqual(CP.listEditionProposals(db, key), [], "resolved");
  // The phase-in now applies: before the mandatory date both editions are allowed.
  const before = editionsInEffect(row.adoptedCodes.filter((c) => c.code === "NEC"), "electrical", "2025-09-01");
  assert.equal(before.status, "phase_in", JSON.stringify(before));
  assert.equal(editionsInEffect(row.adoptedCodes.filter((c) => c.code === "NEC"), "electrical", "2026-02-01").status, "in_effect");
});
await check("a date only the ROW states is not a change", () => {
  const have: CodeEdition = { code: "NEC", edition: "2023", effectiveDate: "2025-07-01" };
  assert.equal(CP.editionChanges([have], [{ code: "NEC", edition: "2023" }]).length, 0);
  assert.equal(CP.editionChanges([have], [{ code: "NEC", edition: "2023", effectiveDate: "2025-07-01T00:00:00Z" }]).length, 0, "compared as days");
  assert.equal(CP.editionChanges([have], [{ code: "NEC", edition: "2023", effectiveDate: "2025-08-01" }]).length, 1);
});

// ── 4. The verify route accepts the dates ──────────────────────────────────────────────
console.log("4. a person can enter effective dates");
await check("MUST-PASS: effectiveDate / mandatoryDate / previousEdition survive validation", () => {
  const b = codeProfileVerifySchema.parse({ state: "UT", ahj: "City of Brookhollow", adoptedCodes: [{ code: "NEC", edition: "2023", effectiveDate: "2025-07-01", mandatoryDate: "2026-01-01", previousEdition: "2020" }] });
  assert.deepEqual(b.adoptedCodes[0], { code: "NEC", edition: "2023", effectiveDate: "2025-07-01", mandatoryDate: "2026-01-01", previousEdition: "2020" });
});
await check("a non-date, an impossible date, or a mandatory date before the effective one is refused", () => {
  for (const bad of [{ effectiveDate: "July 2025" }, { effectiveDate: "2025-02-30" }, { effectiveDate: "2026-01-01", mandatoryDate: "2025-07-01" }]) {
    assert.equal(codeProfileVerifySchema.safeParse({ state: "UT", adoptedCodes: [{ code: "NEC", edition: "2023", ...bad }] }).success, false, JSON.stringify(bad));
  }
});

// ── 5. Design-criteria reads with their units ──────────────────────────────────────────
console.log("5. a design-criteria page is read with its units");
const HOST = "https://www.larchmontut.gov";
const PAGE = `${HOST}/213/Design-Criteria`;
const PAGE_TEXT = "Ground Snow Load | 1.44 kPa\nRoof Snow Load | 25 lb/sq ft\nFrost Line Depth | 2.5 feet\nSeismic Design Category | D1\nWind Speed | 105 mph";
const parse = (text: string) => parseDesignCriteriaLookup(extractCriteriaTable(text, PAGE), true, false, { ahj: "City of Larchmont", state: "UT" });
const read = (text: string) => Object.fromEntries(parse(text).values.map((v) => [v.qualifier === "pg_asd" ? "groundSnowLoadAsdPsf" : v.criterion, v.value]));

await check("MUST-PASS: snow, roof snow, frost and SDC are all read, each converted to its field's unit", () => {
  assert.deepEqual(read(PAGE_TEXT), { groundSnowLoadPsf: 30, roofSnowLoadPsf: 25, frostDepthIn: 30, seismicDesignCategory: "D1", windSpeedMph: 105 });
});
await check("the units a design-criteria table prints: pounds, inches, feet-and-inches, mm, km/h", () => {
  assert.deepEqual(read("Ground Snow Load | 31 pounds\nRoof Snow Load | 30 pounds\nFrost Line Depth | 30 inches"), { groundSnowLoadPsf: 31, roofSnowLoadPsf: 30, frostDepthIn: 30 });
  assert.deepEqual(read("Frost Line Depth | 2 ft 6 in"), { frostDepthIn: 30 });
  assert.deepEqual(read("Frost depth: 2'-6\""), { frostDepthIn: 30 });
  assert.deepEqual(read("Frost depth: 762 mm"), { frostDepthIn: 30 });
  assert.deepEqual(read("Ultimate design wind speed: 160 km/h"), { windSpeedMph: 99 });
});
await check("MUST-EXCLUDE: a value printed in a unit its field cannot hold is dropped, never stored as the number", () => {
  const r = parse("Ground Snow Load | 30 inches\nFrost Line Depth | 30 psf");
  assert.deepEqual(r.values, []);
  assert.match(r.notes, /groundSnowLoadPsf 30 \(the value is published in in/);
  assert.match(r.notes, /frostDepthIn 30 \(the value is published in psf/);
});
await check("MUST-PASS: the city's own .gov page lands every converted value OFFICIAL (the quote holds the printed number)", async () => {
  const site = new Map<string, string>([
    [`${HOST}/`, "<!doctype html><html><head><title>Larchmont</title></head><body><a href=\"/213/Design-Criteria\">Design Criteria</a></body></html>"],
    [PAGE, `<!doctype html><html><head><title>Design Criteria</title></head><body><h1>Design Criteria</h1><table>${PAGE_TEXT.split("\n").map((l) => { const [a, b] = l.split(" | "); return `<tr><td>${a}</td><td>${b}</td></tr>`; }).join("")}</table></body></html>`],
  ]);
  const reader = createPageReader({ fetch: async (url: string) => site.has(url)
    ? { ok: true, status: 200, contentType: "text/html", text: site.get(url), finalUrl: url, reason: "HTTP 200" }
    : { ok: false, status: 404, contentType: "text/html", text: "", finalUrl: url, reason: "HTTP 404" }, minGapMs: 0, maxReads: 8 });
  const who = { state: "UT", ahj: "City of Larchmont" };
  // The issuer host on file: the city's own (seeded) permit-process lookup cites its site.
  savePermitProcessLookup(db, { state: who.state, ahj: who.ahj, lookedUpAt: new Date().toISOString(), permits: [],
    issuingAgency: { value: who.ahj, sourceUrl: `${HOST}/150/Building`, quote: "Building permits are issued by the City", origin: "lookup" },
    permitStructure: { value: "combo", sourceUrl: `${HOST}/150/Building`, quote: "one combination permit", origin: "lookup" },
  } as unknown as Omit<PermitProcessLookup, "profileKey" | "confidence">);
  const llm = { researchDesignCriteria: async () => ({ provider: "claude", webGrounded: true, values: [], notes: "" }) as DesignCriteriaResearchResult } as unknown as LLMProvider;
  const r = await CP.runDesignCriteriaResearch(db, who, llm, reader);
  const row = own(who.state, who.ahj)!;
  assert.deepEqual({ ...row.designCriteria, sourceUrl: undefined }, { groundSnowLoadPsf: 30, roofSnowLoadPsf: 25, frostDepthIn: 30, seismicDesignCategory: "D1", windSpeedMph: 105, sourceUrl: undefined }, JSON.stringify(r));
  for (const f of ["groundSnowLoadPsf", "roofSnowLoadPsf", "frostDepthIn", "seismicDesignCategory"]) {
    const c = row.citations.filter((x) => x.field === `designCriteria.${f}`).pop();
    assert.equal(c?.tier, "official", `${f}: ${JSON.stringify(c)}`);
  }
  assert.match(String(row.citations.find((x) => x.field === "designCriteria.frostDepthIn")?.quote), /2\.5 feet/, "the quote keeps the page's own words");
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall city reference profile checks passed");
process.exit(0);
