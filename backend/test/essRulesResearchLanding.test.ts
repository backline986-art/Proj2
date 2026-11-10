// BATTERY (ESS) RULES ARRIVE AS DATA (ESS data follow-up to review-audit draft 05).
//
// (1) Code research proposes the jurisdiction's own ESS rules, each with its page and a verbatim quote.
//     Each value lands through #683's ONE landing function: OFFICIAL only when the page is on an
//     official host, the quote contains the value and the quote is in the bytes THIS process read from
//     that page; otherwise SEEDED (and the review only warns on it). A person-verified row is never
//     written: a differing official read becomes a conflict for a person. Write rules per field as the
//     design-criteria lookup's: official replaces seeded, official refreshes only from the same host,
//     seeded never replaces, a person's AHJ-correction value and a state's verified rule are kept.
// (2) A shipped city profile merged onto an existing seeded row carries its ESS rules field by field,
//     never over an official value (nor onto a person-verified row), and fieldSources says whose each
//     value is.
// Invented jurisdictions and hosts only; every page comes from a fake fetch (_isolate refuses the
// network). A research that reads no ESS rule returns exactly the job result it did before.
//
//   npx tsx backend/test/essRulesResearchLanding.test.ts
import "./_isolate"; // FIRST: temp cwd, off the network
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodeEdition, JurisdictionCodeProfile, JurisdictionCodeResearchInput, JurisdictionEssRuleRead, LLMProvider, ProjectRecord } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ess-rules-landing-"));
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
const { essRuleReadsOf } = await import("../../shared/src/essRules");
const { researchedEssRules, ESS_RULES_RESEARCH_SCHEMA, ESS_RULES_RESEARCH_RULE } = await import("../src/essRulesResearch");
const { createPageReader } = await import("../src/agencyPageReader");
const { resolveEssRules, evaluateEssFindings } = await import("../src/essReview");
const db = await openDatabase();
CP.setDesignResearchEnqueuerForTests(() => { /* the design lookup is not under test here */ });

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

// ── Invented places and pages ──────────────────────────────────────────────────────────────────
const ST = "ZQ";
const GOV = "https://www.lanternridgezq.gov/DocumentCenter/View/9/Battery-Storage";
const GOV2 = "https://permits.otherhostzq.gov/ess-handout";
const VENDOR = "https://batteryrules.example.com/lantern-ridge";
const GOV_TEXT = "Residential Energy Storage Systems. Individual ESS units shall not exceed 15 kWh. ESS installed in a garage shall not exceed 40 kWh in aggregate. Units shall be separated by not less than 4 feet.";
type Served = { contentType: string; text: string };
const site = new Map<string, Served>();
const fetched: string[] = [];
const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
site.set(GOV, { contentType: "text/html", text: html("Battery Storage", GOV_TEXT) });
site.set(GOV2, { contentType: "text/html", text: html("ESS Handout", "Individual ESS units shall not exceed 12 kWh.") });
site.set(VENDOR, { contentType: "text/html", text: html("Rules", GOV_TEXT) });
const fakeFetch = async (url: string) => {
  fetched.push(url);
  const s = site.get(url);
  if (!s) return { ok: false, status: 404, contentType: "text/html", text: "Not found", finalUrl: url, reason: "HTTP 404" };
  return { ok: true, status: 200, contentType: s.contentType, text: s.text, finalUrl: url, reason: "HTTP 200" };
};
const reader = () => createPageReader({ fetch: fakeFetch, minGapMs: 0, maxReads: 8 });

const blank = (state: string, ahj: string, over: Partial<JurisdictionCodeProfile> = {}): JurisdictionCodeProfile => ({
  key: "", state, ahj, confidence: "seeded", adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {},
  fireSetbacks: [], citations: [], updatedAt: "", ...over,
});
const CODES: CodeEdition[] = [{ family: "residential", code: "IRC", edition: "2021", sourceUrl: "https://www.lanternridgezq.gov/codes", quote: "The 2021 IRC is adopted." }];
/** A fake code researcher: grounded, returns CODES plus whatever ESS reads it is given. */
const fakeResearcher = (essRules?: JurisdictionEssRuleRead[]): LLMProvider => ({
  async researchJurisdictionCodes(input: JurisdictionCodeResearchInput) {
    return {
      provider: "claude" as const,
      profile: blank(input.state, input.ahj, {
        adoptedCodes: CODES,
        researchProvenance: { webGrounded: true, method: "web_search" as const, searches: 3, groundedSearches: 2, resultUrls: [GOV], at: new Date().toISOString() },
      }),
      ...(essRules ? { essRules } : {}),
      webGrounded: true, needsHumanVerification: true as const, notes: "",
    };
  },
} as unknown as LLMProvider);
const read = (over: Partial<JurisdictionEssRuleRead>): JurisdictionEssRuleRead => ({ key: "maxUnitKwh", value: 15, sourceUrl: GOV, quote: "Individual ESS units shall not exceed 15 kWh.", ...over });
const own = (state: string, ahj: string) => CP.ownCodeProfileRow(db, state, ahj)?.profile ?? null;
const stateRow = (state: string) => db.get<{ payload_json: string }>("SELECT payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [CP.codeProfileKey({ state, ahj: "" })]);
const lastCite = (p: JurisdictionCodeProfile | null, field: string) => (p?.citations ?? []).filter((c) => c.field === field).pop();
const putRow = (p: JurisdictionCodeProfile, confidence: "seeded" | "verified" = "seeded") => {
  const key = CP.codeProfileKey(p);
  const { key: _k, confidence: _c, ...payload } = p;
  db.run("DELETE FROM jurisdiction_code_profiles WHERE profile_key = ?", [key]);
  db.run("INSERT INTO jurisdiction_code_profiles (profile_key, state, ahj, confidence, payload_json, researched_at, verified_at, verified_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [key, p.state, p.ahj, confidence, JSON.stringify(payload), "2026-09-01T00:00:00.000Z", confidence === "verified" ? "2026-09-02T00:00:00.000Z" : null, confidence === "verified" ? "Pat Example" : null, "2026-09-01T00:00:00.000Z"]);
  return key;
};

// ── 1. The read's shape ────────────────────────────────────────────────────────────────────────
console.log("1. a research's ESS reads are shape-checked: a number must be in its own quote");
await check("kept: a known key, a number its quote states, an http page; a yes/no rule with its sentence", () => {
  const r = essRuleReadsOf([
    { key: "maxUnitKwh", value: 15, sourceUrl: GOV, quote: "Individual ESS units shall not exceed 15 kWh." },
    { key: "minUnitSpacingIn", value: 48, publishedValue: 4, sourceUrl: GOV, quote: "Units shall be separated by not less than 4 feet." },
    { key: "alarmRequired", value: true, sourceUrl: GOV, quote: "A heat detector shall be installed in the room." },
  ]);
  assert.deepEqual(r.reads.map((x) => [x.key, x.value, x.publishedValue]), [["maxUnitKwh", 15, undefined], ["minUnitSpacingIn", 48, 4], ["alarmRequired", true, undefined]]);
  assert.deepEqual(r.dropped, []);
});
await check("dropped, each with a reason: a number not in its quote, an unknown key, no page, no quote, a second value, a wrong kind", () => {
  const r = essRuleReadsOf([
    { key: "maxUnitKwh", value: 20, sourceUrl: GOV, quote: "Individual ESS units shall not exceed 15 kWh." },
    { key: "maxBatteryCount", value: 2, sourceUrl: GOV, quote: "2 batteries" },
    { key: "maxAggregateKwhGarage", value: 40, sourceUrl: "", quote: "40 kWh in aggregate" },
    { key: "maxAggregateKwhOutdoor", value: 40, sourceUrl: GOV, quote: "" },
    { key: "minOpeningClearanceIn", value: 36, sourceUrl: GOV, quote: "36 inches from doors" },
    { key: "minOpeningClearanceIn", value: 24, sourceUrl: GOV, quote: "24 inches from doors" },
    { key: "alarmRequired", value: "yes", sourceUrl: GOV, quote: "a heat detector shall be installed" },
  ]);
  assert.deepEqual(r.reads.map((x) => x.key), ["minOpeningClearanceIn"]);
  assert.equal(r.dropped.length, 6, r.dropped.join(" | "));
  assert.match(r.dropped.join(" | "), /maxUnitKwh: the quote does not state 20/);
});
await check("model memory is never a rule: an answer that was not web-grounded yields nothing", () => {
  assert.deepEqual(researchedEssRules([read({})], false).reads, []);
  assert.equal(researchedEssRules([read({})], true).reads.length, 1);
});
await check("the research prompt asks for the jurisdiction's own rules only, cited and quoted, and names every key", () => {
  assert.match(ESS_RULES_RESEARCH_SCHEMA, /"essRules"/);
  assert.match(ESS_RULES_RESEARCH_RULE, /only rules THIS jurisdiction states itself/);
  for (const k of ["maxUnitKwh", "maxAggregateKwhGarage", "minUnitSpacingIn", "spacingReductionBy9540A", "listedResidentialExemption", "disconnectOutside"]) assert.ok(ESS_RULES_RESEARCH_RULE.includes(k), k);
});

// ── 2. Research lands each value through the one landing function ─────────────────────────────
console.log("2. code research lands its ESS reads per field: official only on bytes this process read");
const A1 = "Town of Lantern Ridge";
await check("a .gov page whose bytes carry the quote -> official, cited with field, quote and fetchedAt; used and may block", async () => {
  fetched.length = 0;
  const r = await CP.runCodeResearch(db, { state: ST, ahj: A1 }, fakeResearcher([read({}), read({ key: "maxAggregateKwhGarage", value: 40, quote: "ESS installed in a garage shall not exceed 40 kWh in aggregate." })]), reader());
  assert.equal(r.saved, true);
  const ess = r.essRules as { saved: boolean; filled: string[]; official: string[] };
  assert.deepEqual(ess.filled, ["maxUnitKwh", "maxAggregateKwhGarage"]);
  assert.deepEqual(ess.official, ["maxUnitKwh", "maxAggregateKwhGarage"]);
  assert.deepEqual(fetched, [GOV], "the one official page is read once");
  const row = own(ST, A1)!;
  assert.equal(row.confidence, "seeded");
  assert.deepEqual(row.essRules, { maxUnitKwh: 15, maxAggregateKwhGarage: 40 });
  const c = lastCite(row, "essRules.maxUnitKwh")!;
  assert.equal(c.tier, "official");
  assert.equal(c.kind, "ess_rules_research");
  assert.equal(c.sourceUrl, GOV);
  assert.equal(c.quote, "Individual ESS units shall not exceed 15 kWh.");
  assert.match(String(c.fetchedAt), /^\d{4}-\d{2}-\d{2}T/);
  const rules = resolveEssRules(CP.buildCodeContext(ST, A1, CP.getCodeProfile(db, { state: ST, ahj: A1 })));
  assert.equal(rules.maxUnitKwh.tier, "official");
  assert.equal(rules.maxUnitKwh.value, 15);
  assert.equal(rules.maxUnitKwh.blocks, true, "an official value with its quote meets the #637 bar");
});
await check("the same quote on a vendor's page -> seeded (never read: only official hosts are read), applied only as stricter and only warns", async () => {
  const A2 = "Village of Copper Bend";
  fetched.length = 0;
  const r = await CP.runCodeResearch(db, { state: ST, ahj: A2 }, fakeResearcher([read({ sourceUrl: VENDOR })]), reader());
  const ess = r.essRules as { filled: string[]; official: string[] };
  assert.deepEqual(ess.filled, ["maxUnitKwh"]);
  assert.deepEqual(ess.official, []);
  assert.deepEqual(fetched, [], "a page that could never land official is not read");
  const c = lastCite(own(ST, A2), "essRules.maxUnitKwh")!;
  assert.equal(c.tier, undefined);
  assert.equal(c.quote, "Individual ESS units shall not exceed 15 kWh.");
  assert.ok(c.fetchedAt, "the citation still says when the research read it");
  const rules = resolveEssRules(CP.buildCodeContext(ST, A2, CP.getCodeProfile(db, { state: ST, ahj: A2 })));
  assert.equal(rules.maxUnitKwh.tier, "seeded");
  assert.equal(rules.maxUnitKwh.value, 15, "stricter than the 20 kWh baseline: applied");
  assert.equal(rules.maxUnitKwh.blocks, false, "seeded never blocks");
  const project = { id: "ess-land-1", state: ST, ahj: A2, city: "Copper Bend", parserSnapshot: { hasBattery: "Yes", planSetExtractedText: "ENERGY STORAGE: (1) EXAMPLECELL 18 KWH UNIT, UL 9540 LISTED. LOCATION: GARAGE." } } as unknown as ProjectRecord;
  const f = evaluateEssFindings(project, CP.buildCodeContext(ST, A2, CP.getCodeProfile(db, { state: ST, ahj: A2 })), []).find((x) => x.id === "city.ess.unit-rating-over");
  assert.ok(f, "an 18 kWh unit is over the town's 15 kWh");
  assert.equal(f!.severity, "warning");
});
await check("a .gov page whose bytes do NOT carry the quote -> seeded; no reader at all -> seeded", async () => {
  const A3 = "City of Fernhollow";
  const r = await CP.runCodeResearch(db, { state: ST, ahj: A3 }, fakeResearcher([read({ quote: "ESS units shall not exceed 15 kWh per unit in dwellings." })]), reader());
  assert.deepEqual((r.essRules as { official: string[] }).official, []);
  assert.equal(lastCite(own(ST, A3), "essRules.maxUnitKwh")!.tier, undefined);
  const A4 = "City of Marshgate";
  const r2 = await CP.runCodeResearch(db, { state: ST, ahj: A4 }, fakeResearcher([read({})]), null);
  assert.deepEqual((r2.essRules as { official: string[] }).official, []);
  assert.equal(own(ST, A4)!.essRules?.maxUnitKwh, 15);
});
await check("a yes/no rule lands seeded (no quote contains \"true\"); a seeded relaxation is stored but the review does not apply it", async () => {
  const A5 = "Town of Quarry Flats";
  const r = await CP.runCodeResearch(db, { state: ST, ahj: A5 }, fakeResearcher([
    read({ key: "spacingReductionBy9540A", value: true, quote: "Spacing may be reduced where UL 9540A testing shows no propagation." }),
  ]), reader());
  assert.deepEqual((r.essRules as { filled: string[]; official: string[] }).official, []);
  const rules = resolveEssRules(CP.buildCodeContext(ST, A5, CP.getCodeProfile(db, { state: ST, ahj: A5 })));
  assert.equal(rules.spacingReductionBy9540A.value, false, "the baseline stands: a seeded allowance is not applied");
  assert.equal(rules.spacingReductionBy9540A.unappliedSeeded, true);
});

console.log("3. write rules per field");
await check("a seeded read never replaces a value on file; an official read replaces a seeded one", async () => {
  const A2 = "Village of Copper Bend"; // seeded 15 from the vendor page (above)
  const r = await CP.runCodeResearch(db, { state: ST, ahj: A2 }, fakeResearcher([read({ value: 12, sourceUrl: VENDOR, quote: "units shall not exceed 12 kWh" })]), reader());
  assert.match((r.essRules as { skipped: string[] }).skipped.join(" "), /maxUnitKwh \(already on file\)/);
  assert.equal(own(ST, A2)!.essRules?.maxUnitKwh, 15);
  const r2 = await CP.runCodeResearch(db, { state: ST, ahj: A2 }, fakeResearcher([read({ value: 12, sourceUrl: GOV2, quote: "Individual ESS units shall not exceed 12 kWh." })]), reader());
  assert.deepEqual((r2.essRules as { official: string[] }).official, ["maxUnitKwh"]);
  const row = own(ST, A2)!;
  assert.equal(row.essRules?.maxUnitKwh, 12);
  assert.equal(row.citations.filter((c) => c.field === "essRules.maxUnitKwh").length, 1, "one citation per value: the seeded one went with its value");
});
await check("an official value is refreshed only from the same host; a seeded read never replaces it", async () => {
  const A2 = "Village of Copper Bend"; // official 12 from otherhostzq.gov
  const r = await CP.runCodeResearch(db, { state: ST, ahj: A2 }, fakeResearcher([read({})]), reader()); // official 15 from lanternridgezq.gov
  assert.match((r.essRules as { skipped: string[] }).skipped.join(" "), /official value on file from permits\.otherhostzq\.gov/);
  assert.equal(own(ST, A2)!.essRules?.maxUnitKwh, 12);
  const r2 = await CP.runCodeResearch(db, { state: ST, ahj: A2 }, fakeResearcher([read({ value: 10, sourceUrl: VENDOR, quote: "not exceed 10 kWh" })]), reader());
  assert.equal((r2.essRules as { saved: boolean }).saved, false);
  assert.equal(own(ST, A2)!.essRules?.maxUnitKwh, 12);
});
await check("a value a person applied from an AHJ correction is never replaced, official or not", async () => {
  const A6 = "Town of Ashpoint";
  putRow(blank(ST, A6, { adoptedCodes: CODES, essRules: { maxUnitKwh: 18 }, citations: [{ label: "AHJ plan-review correction: maxUnitKwh = 18", sourceUrl: "", kind: "ahj_correction", field: "essRules.maxUnitKwh" }] }));
  const r = await CP.landResearchedEssRules(db, { state: ST, ahj: A6 }, [read({})], { reader: reader() });
  assert.match(r.skipped.join(" "), /applied by a person from an AHJ correction/);
  assert.equal(own(ST, A6)!.essRules?.maxUnitKwh, 18);
});
await check("an AHJ's read never overrides a rule the state's person-verified row sets", async () => {
  const ST2 = "ZX";
  putRow(blank(ST2, "", { essRules: { maxAggregateKwhGarage: 60 } }), "verified");
  const r = await CP.landResearchedEssRules(db, { state: ST2, ahj: "Town of Lowmeadow" }, [read({ key: "maxAggregateKwhGarage", value: 40, quote: "ESS installed in a garage shall not exceed 40 kWh in aggregate." }), read({})], { reader: reader() });
  assert.deepEqual(r.filled, ["maxUnitKwh"]);
  assert.match(r.skipped.join(" "), /maxAggregateKwhGarage \(the state's verified profile sets it\)/);
});
await check("a state-level research lands on the state's row", async () => {
  const ST3 = "ZY";
  const r = await CP.landResearchedEssRules(db, { state: ST3, ahj: "" }, [read({})], { reader: reader() });
  assert.equal(r.saved, true);
  assert.equal(JSON.parse(stateRow(ST3)!.payload_json).essRules.maxUnitKwh, 15);
});

console.log("4. rule 3: a person-verified row is never written; a differing official read is a conflict for a person");
await check("verified row unchanged; the official read is listed as a conflict, once; it leaves the list once the row agrees", async () => {
  const A7 = "City of Stonewick";
  const key = putRow(blank(ST, A7, { adoptedCodes: CODES, essRules: { maxUnitKwh: 20 } }), "verified");
  const before = db.get<{ payload_json: string; verified_at: string }>("SELECT payload_json, verified_at FROM jurisdiction_code_profiles WHERE profile_key = ?", [key])!;
  const r = await CP.landResearchedEssRules(db, { state: ST, ahj: A7 }, [read({}), read({ key: "alarmRequired", value: false, quote: "No alarm is required." })], { reader: reader() });
  assert.equal(r.saved, false);
  assert.equal(r.conflicts?.length, 1, "only the official (numeric) read is a conflict");
  assert.deepEqual({ field: r.conflicts![0].field, current: r.conflicts![0].current, found: r.conflicts![0].found }, { field: "essRules.maxUnitKwh", current: 20, found: 15 });
  const after = db.get<{ payload_json: string; verified_at: string }>("SELECT payload_json, verified_at FROM jurisdiction_code_profiles WHERE profile_key = ?", [key])!;
  assert.deepEqual(after, before, "the verified row is byte-identical");
  await CP.landResearchedEssRules(db, { state: ST, ahj: A7 }, [read({})], { reader: reader() });
  const listed = CP.listOfficialConflicts(db, key);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].field, "essRules.maxUnitKwh");
  assert.equal(db.query("SELECT id FROM audit_logs WHERE action = 'code_profile.official_conflict' AND details LIKE ?", [`%${key}%`]).length, 1, "recorded once");
  CP.saveVerifiedCodeProfile(db, { ...own(ST, A7)!, essRules: { maxUnitKwh: 15 } }, "Pat Example");
  assert.equal(CP.listOfficialConflicts(db, key).length, 0, "a person re-verified to the official value");
});

console.log("5. a research that reads no ESS rule returns exactly what it did before");
await check("no essRules member in the job result; the row carries no essRules", async () => {
  const A8 = "Town of Pebble Reach";
  const r = await CP.runCodeResearch(db, { state: ST, ahj: A8 }, fakeResearcher(), reader());
  assert.deepEqual(Object.keys(r).sort(), ["adoptedCodes", "confidence", "groundedSearches", "key", "outputTokens", "resultUrls", "saved", "searches", "webGrounded"].sort());
  assert.equal(own(ST, A8)!.essRules, undefined);
});

// ── 6. The shipped reference onto an existing row ─────────────────────────────────────────────
console.log("6. a shipped city profile merged onto an existing seeded row carries its ESS rules field by field");
const refPath = path.join(tmp, "reference.json");
const seedWith = (profiles: unknown[]) => {
  fs.writeFileSync(refPath, JSON.stringify({ profiles, stateAdoptions: [] }));
  process.env.CODE_PROFILE_REFERENCE_PATH = refPath;
  CP.resetReferenceCacheForTests();
  CP.seedReferenceCodeProfiles(db);
};
const REF_URL = "https://www.brambleford-zq.gov/ess";
const A9 = "City of Brambleford";
const refProfile = {
  state: ST, ahj: A9, asOf: "2026-10-01",
  adoptedCodes: [{ family: "residential", code: "IRC", edition: "2021", sourceUrl: REF_URL }],
  essRules: { maxUnitKwh: 14, maxAggregateKwhGarage: 30, minOpeningClearanceIn: 48 },
  citations: [
    { label: "City ESS rules", sourceUrl: REF_URL, field: "essRules.maxUnitKwh", quote: "Units shall not exceed 14 kWh." },
    { label: "City ESS rules", sourceUrl: REF_URL, field: "essRules.maxAggregateKwhGarage", quote: "Garages: 30 kWh in aggregate." },
    { label: "City ESS rules", sourceUrl: REF_URL, field: "essRules.minOpeningClearanceIn", quote: "48 inches from doors and windows." },
  ],
};
await check("a blank is filled and a research-seeded value replaced, each with the reference's citation; an official value is kept", async () => {
  const key = putRow(blank(ST, A9, {
    adoptedCodes: CODES,
    essRules: { maxUnitKwh: 16, maxAggregateKwhGarage: 50 },
    citations: [
      { label: "ESS rule research: maxUnitKwh = 16", sourceUrl: VENDOR, kind: "ess_rules_research", field: "essRules.maxUnitKwh", quote: "16 kWh", at: "2026-09-01T00:00:00.000Z", fetchedAt: "2026-09-01T00:00:00.000Z" },
      { label: "ESS rule research: maxAggregateKwhGarage = 50", sourceUrl: GOV, kind: "ess_rules_research", field: "essRules.maxAggregateKwhGarage", quote: "50 kWh in aggregate", at: "2026-09-01T00:00:00.000Z", fetchedAt: "2026-09-01T00:00:00.000Z", tier: "official" },
    ],
    researchProvenance: { webGrounded: true, method: "web_search", at: "2026-09-01" },
  }));
  seedWith([refProfile]);
  const row = own(ST, A9)!;
  assert.equal(row.confidence, "seeded");
  assert.deepEqual(row.essRules, { maxUnitKwh: 14, maxAggregateKwhGarage: 50, minOpeningClearanceIn: 48 });
  assert.equal(lastCite(row, "essRules.maxUnitKwh")!.kind, "reference");
  assert.equal(lastCite(row, "essRules.maxUnitKwh")!.quote, "Units shall not exceed 14 kWh.");
  assert.equal(row.citations.filter((c) => c.field === "essRules.maxUnitKwh").length, 1, "the research citation went with its value");
  assert.equal(lastCite(row, "essRules.maxAggregateKwhGarage")!.tier, "official", "the official value and its citation are kept");
  assert.equal(row.citations.filter((c) => c.field === "essRules.maxAggregateKwhGarage").length, 1, "the reference's citation for a value it did not set is not appended");
  assert.equal(lastCite(row, "essRules.minOpeningClearanceIn")!.kind, "reference");
  void key;
});
await check("fieldSources says whose each value is: research (official), the reference, a person", async () => {
  putRow(blank(ST, "", { essRules: { alarmRequired: true } }), "verified");
  const p = CP.getCodeProfile(db, { state: ST, ahj: A9 })!;
  assert.equal(p.fieldSources?.["essRules.maxUnitKwh"]?.origin, "reference");
  assert.equal(p.fieldSources?.["essRules.maxUnitKwh"]?.confidence, "seeded");
  assert.equal(p.fieldSources?.["essRules.maxAggregateKwhGarage"]?.origin, "research");
  assert.equal(p.fieldSources?.["essRules.maxAggregateKwhGarage"]?.confidence, "official");
  assert.equal(p.fieldSources?.["essRules.alarmRequired"]?.origin, "person");
  assert.equal(p.fieldSources?.["essRules.alarmRequired"]?.ahj, "", "the state's row");
});
await check("the reference never writes a person-verified row's ESS rules", async () => {
  const A10 = "City of Hollin Cross";
  const key = putRow(blank(ST, A10, { adoptedCodes: CODES, essRules: { maxUnitKwh: 20 } }), "verified");
  const before = db.get<{ payload_json: string }>("SELECT payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [key])!.payload_json;
  seedWith([{ ...refProfile, ahj: A10 }]);
  assert.equal(db.get<{ payload_json: string }>("SELECT payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [key])!.payload_json, before);
});
await check("a new row from the reference marks its ESS citations as the reference's (origin reference)", async () => {
  const A11 = "Town of Wrenfield";
  seedWith([{ ...refProfile, ahj: A11 }]);
  const row = own(ST, A11)!;
  assert.equal(row.essRules?.maxUnitKwh, 14);
  assert.equal(lastCite(row, "essRules.maxUnitKwh")!.kind, "reference");
  assert.equal(CP.essRuleOrigin(row, "essRules.maxUnitKwh"), "reference");
});
await check("a re-run of the same reference changes nothing (idempotent)", async () => {
  const before = db.get<{ payload_json: string }>("SELECT payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [CP.codeProfileKey({ state: ST, ahj: A9 })])!.payload_json;
  seedWith([refProfile]);
  const after = db.get<{ payload_json: string }>("SELECT payload_json FROM jurisdiction_code_profiles WHERE profile_key = ?", [CP.codeProfileKey({ state: ST, ahj: A9 })])!.payload_json;
  assert.deepEqual(JSON.parse(after).essRules, JSON.parse(before).essRules);
  assert.equal(JSON.parse(after).citations.filter((c: { field?: string }) => String(c.field ?? "").startsWith("essRules.")).length, 3);
});
await check("a research merge never appends an ESS citation without its value", () => {
  const merged = CP.mergeResearchIntoRow(blank(ST, "City of Nowhere Glen"), blank(ST, "City of Nowhere Glen", { citations: [{ label: "x", sourceUrl: REF_URL, field: "essRules.maxUnitKwh", quote: "14 kWh" }, { label: "codes", sourceUrl: REF_URL }] }));
  assert.deepEqual(merged.citations.map((c) => c.label), ["codes"]);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall ESS rules landing checks passed");
