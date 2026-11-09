// AN OFFICIAL SOURCE IS USED AT ONCE, NEVER CALLED PERSON-VERIFIED (#683).
//
// Owner decision 2026-11-09: a fact the bot read on the authority's own official page is used right
// away, labelled with its source. Rule 3 stays as written: such a fact is "official", never "verified
// by" anyone; it never overwrites a human-verified row; and it never decides where a filing goes.
// This pins, with invented jurisdictions and hosts only:
//   1. the one landing function: a .gov page + a verbatim quote in the retrieved bytes -> official;
//      the quote not in the bytes, no bytes at all (a model's answer), a third-party host, a quote
//      without the value, a city .org that no person verified -> seeded; the same .org once a PERSON
//      verified the city's permit-process lookup that cites it -> official;
//   2. the design-criteria lookup lands per field: official from the city's own .gov page; seeded
//      from a model's answer; official replaces seeded; official refreshes official only from the
//      same host; a seeded read and a later research save never replace an official value;
//   3. it is USED: a plan below the city's official ground snow load is a BLOCKER, worded "from
//      <host>", never "human-verified"; the same value from a seeded read stays a warning;
//   4. rule 3: a human-verified row is never written; a differing official read becomes a conflict a
//      person sees (listCodeProfiles), and it leaves the list once the row says the same;
//   5. exclusions: an official read never makes a portal "verified" for the rule 5 carve-out, never
//      sets verified_at on the knowledge base, and never makes a filing-email record usable.
// NO LIVE NETWORK: every page comes from a fake transport (_isolate refuses any other fetch).
//
//   npx tsx backend/test/officialSourceTier.test.ts
import "./_isolate"; // FIRST: temp cwd, off the network
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DesignCriteriaResearchResult, JurisdictionCodeProfile, LLMProvider, PermitProcessLookup, ProjectRecord, ReviewerFinding } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "official-source-tier-"));
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
const OS = await import("../../shared/src/officialSource");
const { createPageReader } = await import("../src/agencyPageReader");
const { savePermitProcessLookup } = await import("../src/permitProcess");
const { personVerifiedAuthorityHosts } = await import("../src/officialAuthorityHosts");
const { isGovernmentDomain, filingEmailRecordProblems } = await import("../src/filingEmail");
const { isVerifiedKnowledge } = await import("../src/knowledgeBase");
const { lookupPortalEntity } = await import("../src/permitProcessLookup");
const { evaluateDesignCodeFindings } = await import("../src/codeReviewRules");
const db = await openDatabase();

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};

// ── 1. The landing function ────────────────────────────────────────────────────────────
console.log("1. landingTierFor: official only from an official host, with the quote in the bytes read");
const PAGE = "https://www.pinecrestut.gov/220/Design-Criteria";
const BYTES = "Design Criteria\nGround Snow Load | 42 pounds\nFrost Line Depth | 30 inches\nSeismic Design Category | D1";
const AT = "2026-11-09T12:00:00.000Z";
const land = (over: Partial<Parameters<typeof OS.landingTierFor>[0]>) =>
  OS.landingTierFor({ sourceUrl: PAGE, quote: "Ground Snow Load 42 pounds", value: 42, fetchedAt: AT, retrievedText: BYTES, ...over });

await check("a .gov page, the quote names the value and is in the bytes read -> official", () => {
  const r = land({});
  assert.equal(r.tier, "official", r.reasons.join("; "));
  assert.equal(r.host, "www.pinecrestut.gov");
});
await check("the quote is not in the retrieved page -> seeded", () => {
  assert.equal(land({ quote: "Ground Snow Load 42 psf per City Code" }).tier, "seeded");
});
await check("nothing was retrieved (a model's answer quoting the page) -> seeded", () => {
  const r = land({ retrievedText: undefined });
  assert.equal(r.tier, "seeded");
  assert.match(r.reasons.join(" "), /not retrieved/);
});
await check("the quote does not contain the value -> seeded", () => {
  assert.equal(land({ value: 40 }).tier, "seeded");
});
await check("no fetched-at -> seeded", () => {
  assert.equal(land({ fetchedAt: "" }).tier, "seeded");
});
await check("a third-party host (a vendor's CDN, an aggregator) -> seeded, whatever the quote", () => {
  assert.equal(land({ sourceUrl: "https://cdn.examplecms.com/pinecrest/design-criteria.pdf" }).tier, "seeded");
  assert.equal(land({ sourceUrl: "https://solar-permit-guides.example.com/ut/pinecrest" }).tier, "seeded");
});
await check("a city .org no person verified -> seeded; the same .org verified as the city's own -> official", () => {
  const org = "https://www.pinecrestcity.org/design-criteria";
  assert.equal(land({ sourceUrl: org }).tier, "seeded");
  assert.equal(land({ sourceUrl: org, verifiedAuthorityHosts: ["pinecrestcity.org"] }).tier, "official");
  assert.equal(land({ sourceUrl: "https://www.otherpinecrest.org/x", verifiedAuthorityHosts: ["pinecrestcity.org"] }).tier, "seeded", "another domain is not the authority's");
});
await check("ONE government predicate: the filing-email check reads the shared one", () => {
  for (const d of ["pinecrestut.gov", "ci.pinecrest.ut.us", "state.ut.us", "army.mil", "council.gov.uk", "pinecrest.org", "pinecrest.com", "gov.example.com"]) {
    assert.equal(isGovernmentDomain(d), OS.isGovernmentHost(d), d);
  }
  assert.equal(OS.isGovernmentHost("gov.example.com"), false);
});

// ── 2. The design-criteria lookup lands per field ──────────────────────────────────────
console.log("2. the design-criteria lookup lands official values from the city's own page, per field");
type Served = { contentType: string; text: string };
const site = new Map<string, Served>();
const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const fakeFetch = async (url: string) => {
  const s = site.get(url);
  if (!s) return { ok: false, status: 404, contentType: "text/html", text: "Not found", finalUrl: url, reason: "HTTP 404" };
  return { ok: true, status: 200, contentType: s.contentType, text: s.text, finalUrl: url, reason: "HTTP 200" };
};
const reader = () => createPageReader({ fetch: fakeFetch, minGapMs: 0, maxReads: 8 });
const table = (rows: Array<[string, string]>) => `<table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("")}</table>`;
const citySite = (origin: string, rows: Array<[string, string]>) => {
  site.set(`${origin}/`, { contentType: "text/html", text: html("City Home", `<a href="${origin}/220/Design-Criteria">Design Criteria</a>`) });
  site.set(`${origin}/220/Design-Criteria`, { contentType: "text/html", text: html("Design Criteria", table(rows)) });
};
const fakeLlm = (result: DesignCriteriaResearchResult = { provider: "claude", webGrounded: true, values: [], notes: "" }): LLMProvider =>
  ({ researchDesignCriteria: async () => result } as unknown as LLMProvider);
const seedProcess = (who: { state: string; ahj: string }, agencyUrl: string, verifiedBy?: string) => {
  const r = savePermitProcessLookup(db, {
    state: who.state, ahj: who.ahj, lookedUpAt: new Date().toISOString(), permits: [],
    issuingAgency: { value: who.ahj, sourceUrl: agencyUrl, quote: "Building permits are issued by the City", origin: "lookup" },
    permitStructure: { value: "combo", sourceUrl: agencyUrl, quote: "one combination permit", origin: "lookup" },
    ...(verifiedBy ? { confidence: "verified" as const } : {}),
  } as unknown as Omit<PermitProcessLookup, "profileKey" | "confidence">, verifiedBy ? { verifiedBy } : {});
  assert.equal(r.saved, true, r.reason);
};
const own = (who: { state: string; ahj: string }) => CP.ownCodeProfileRow(db, who.state, who.ahj)?.profile ?? null;
const cite = (who: { state: string; ahj: string }, field: string) => own(who)?.citations.filter((c) => c.field === `designCriteria.${field}`).pop();

const GOV = { state: "UT", ahj: "City of Pinecrest" };
const GOV_HOST = "https://www.pinecrestut.gov";
citySite(GOV_HOST, [["Ground Snow Load", "42 pounds"], ["Wind Speed", "105 mph"], ["Frost Line Depth", "30 inches"], ["Seismic Design Category", "D1"]]);
seedProcess(GOV, `${GOV_HOST}/150/Building`);

await check("MUST-PASS: the city's own .gov table lands official, each field cited with its fetched-at", async () => {
  const r = await CP.runDesignCriteriaResearch(db, GOV, fakeLlm(), reader());
  assert.deepEqual([...(r.official as string[])].sort(), ["frostDepthIn", "groundSnowLoadPsf", "seismicDesignCategory", "windSpeedMph"], JSON.stringify(r));
  const row = own(GOV)!;
  assert.equal(row.confidence, "seeded", "the ROW is never stamped verified");
  assert.equal(row.verifiedAt, undefined);
  for (const f of ["groundSnowLoadPsf", "frostDepthIn", "seismicDesignCategory", "windSpeedMph"]) {
    const c = cite(GOV, f);
    assert.equal(c?.tier, "official", `${f}: ${JSON.stringify(c)}`);
    assert.match(String(c?.fetchedAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(c?.sourceUrl, `${GOV_HOST}/220/Design-Criteria`);
  }
});

await check("a layered read reports the field as official (with where it came from), not verified", () => {
  // A state row makes the read layered (fieldSources).
  CP.saveResearchedCodeProfile(db, { key: "", state: "UT", ahj: "", confidence: "seeded", adoptedCodes: [], amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "" });
  const p = CP.getCodeProfile(db, GOV)!;
  const src = p.fieldSources?.["designCriteria.groundSnowLoadPsf"];
  assert.equal(src?.confidence, "official");
  assert.equal(src?.officialSource?.host, "www.pinecrestut.gov");
  assert.equal(src?.verifiedBy, undefined);
});

const ORG = { state: "UT", ahj: "City of Larkfield" };
const ORG_HOST = "https://www.cityoflarkfield.org";
citySite(ORG_HOST, [["Ground Snow Load", "38 pounds"], ["Wind Speed", "110 mph"]]);
await check("a city .org page whose domain no person verified lands SEEDED", async () => {
  seedProcess(ORG, `${ORG_HOST}/building`);
  assert.deepEqual(personVerifiedAuthorityHosts(db, ORG.state, ORG.ahj), [], "a seeded lookup never vouches for a domain");
  const r = await CP.runDesignCriteriaResearch(db, ORG, fakeLlm(), reader());
  assert.equal(own(ORG)?.designCriteria.groundSnowLoadPsf, 38, JSON.stringify(r));
  assert.equal(cite(ORG, "groundSnowLoadPsf")?.tier, undefined);
});
await check("once a PERSON verified the city's lookup citing that .org, a read from it lands official (and replaces the seeded value)", async () => {
  seedProcess(ORG, `${ORG_HOST}/building`, "Pat Operator");
  assert.deepEqual(personVerifiedAuthorityHosts(db, ORG.state, ORG.ahj), ["www.cityoflarkfield.org"]);
  const res: DesignCriteriaResearchResult = {
    provider: "issuer_page", webGrounded: true, notes: "",
    values: [{ criterion: "groundSnowLoadPsf", value: 40, qualifier: "pg", sourceUrl: `${ORG_HOST}/220/Design-Criteria`, quote: "Ground Snow Load 40 pounds" }],
    retrieved: [{ url: `${ORG_HOST}/220/Design-Criteria`, text: "Ground Snow Load | 40 pounds", fetchedAt: AT }],
  };
  const r = CP.mergeResearchedDesignCriteria(db, ORG, res);
  assert.deepEqual(r.official, ["groundSnowLoadPsf"], JSON.stringify(r));
  assert.equal(own(ORG)?.designCriteria.groundSnowLoadPsf, 40, "official replaces seeded");
  assert.equal(cite(ORG, "groundSnowLoadPsf")?.tier, "official");
});

const page = (host: string, n: number, quote = `Ground Snow Load ${n} pounds`): DesignCriteriaResearchResult => ({
  provider: "issuer_page", webGrounded: true, notes: "",
  values: [{ criterion: "groundSnowLoadPsf", value: n, qualifier: "pg", sourceUrl: `${host}/220/Design-Criteria`, quote }],
  retrieved: [{ url: `${host}/220/Design-Criteria`, text: quote, fetchedAt: AT }],
});
await check("a seeded read (a model's answer) never replaces an official value", () => {
  const r = CP.mergeResearchedDesignCriteria(db, GOV, { provider: "claude", webGrounded: true, notes: "", values: [{ criterion: "groundSnowLoadPsf", value: 25, qualifier: "pg", sourceUrl: "https://www.utah.gov/snow", quote: "ground snow load 25 psf" }] });
  assert.equal(r.saved, false);
  assert.equal(own(GOV)?.designCriteria.groundSnowLoadPsf, 42);
});
await check("an official read from ANOTHER official host does not replace it; one from the same host refreshes it", () => {
  const other = CP.mergeResearchedDesignCriteria(db, GOV, page("https://www.utahcounty.gov", 30));
  assert.equal(other.saved, false, JSON.stringify(other));
  assert.match(other.skipped.join(" "), /official value on file from www\.pinecrestut\.gov/);
  assert.equal(own(GOV)?.designCriteria.groundSnowLoadPsf, 42);
  const same = CP.mergeResearchedDesignCriteria(db, GOV, page(GOV_HOST, 45));
  assert.equal(same.saved, true, JSON.stringify(same));
  assert.equal(own(GOV)?.designCriteria.groundSnowLoadPsf, 45);
  assert.equal(own(GOV)?.citations.filter((c) => c.field === "designCriteria.groundSnowLoadPsf").length, 1, "one citation per value");
});
await check("an official read never replaces a value a person applied from an AHJ correction", () => {
  const row = own(ORG)!;
  db.run("UPDATE jurisdiction_code_profiles SET payload_json = ? WHERE profile_key = ?", [JSON.stringify({ ...row, designCriteria: { ...row.designCriteria, windSpeedMph: 120 },
    citations: [...row.citations, { label: "AHJ plan-review correction: windSpeedMph = 120", sourceUrl: "", kind: "ahj_correction", field: "designCriteria.windSpeedMph", at: AT }] }), row.key]);
  const res: DesignCriteriaResearchResult = { provider: "issuer_page", webGrounded: true, notes: "",
    values: [{ criterion: "windSpeedMph", value: 110, sourceUrl: `${ORG_HOST}/220/Design-Criteria`, quote: "Wind Speed 110 mph" }],
    retrieved: [{ url: `${ORG_HOST}/220/Design-Criteria`, text: "Wind Speed | 110 mph", fetchedAt: AT }] };
  const r = CP.mergeResearchedDesignCriteria(db, ORG, res);
  assert.equal(r.saved, false, JSON.stringify(r));
  assert.equal(own(ORG)?.designCriteria.windSpeedMph, 120);
});
await check("a later import re-save of the row keeps the official value and its citation", () => {
  const row = own(GOV)!;
  CP.saveResearchedCodeProfile(db, { ...row, key: "", confidence: "seeded", designCriteria: { ...row.designCriteria, groundSnowLoadPsf: 20 }, citations: [] });
  assert.equal(own(GOV)?.designCriteria.groundSnowLoadPsf, 45);
  assert.equal(cite(GOV, "groundSnowLoadPsf")?.tier, "official");
});

// ── 3. It is used ──────────────────────────────────────────────────────────────────────
console.log("3. an official value is used: a plan below it is a blocker worded 'from <host>'");
const project = { id: "official-tier-test", state: "UT", ahj: "City of Pinecrest", utility: "Test Power", homeownerName: "Test Owner", projectAddress: "1 Test St", interconnectionMethod: "Load-side breaker",
  parserSnapshot: { mounting: "Roof mount", snow: "16", windSpeed: "120", planSetExtractedText: "STRUCTURAL NOTES: GROUND SNOW LOAD = 16 PSF. WIND SPEED = 120 MPH. EXPOSURE CATEGORY = C." } } as unknown as ProjectRecord;
const profileWith = (citation: JurisdictionCodeProfile["citations"][number] | null): JurisdictionCodeProfile => ({
  key: "ut|city of pinecrest|unknown", state: "UT", ahj: "City of Pinecrest", confidence: "seeded",
  adoptedCodes: [{ code: "IRC", edition: "2021" }, { code: "NEC", edition: "2023" }], amendments: [], designCriteria: { groundSnowLoadPsf: 42 },
  prescriptive: {}, fireSetbacks: [], citations: citation ? [citation] : [], updatedAt: "", researchedAt: "2026-11-01T00:00:00.000Z",
});
const BELOW = "city.struct.design-criteria-below-ahj";
const below = (p: JurisdictionCodeProfile): ReviewerFinding | undefined =>
  evaluateDesignCodeFindings(project, null, CP.buildCodeContext("UT", "City of Pinecrest", p), [], []).find((f) => f.id === BELOW);
const officialCite = { label: "Design criteria lookup: groundSnowLoadPsf = 42", sourceUrl: `${GOV_HOST}/220/Design-Criteria`, kind: "design_criteria_research" as const, field: "designCriteria.groundSnowLoadPsf", quote: "Ground Snow Load 42 pounds", at: AT, tier: "official" as const, fetchedAt: AT };

await check("MUST-PASS: an OFFICIAL ground snow load is a blocker, worded 'from <host>', never 'human-verified'", () => {
  const f = below(profileWith(officialCite));
  assert.equal(f?.severity, "blocker", JSON.stringify(f));
  assert.match(f!.message, /from www\.pinecrestut\.gov/);
  assert.doesNotMatch(f!.message, /human-verified|verified by/i);
});
await check("the same value from a SEEDED read stays a warning", () => {
  const { tier: _t, fetchedAt: _f, ...seeded } = officialCite;
  assert.equal(below(profileWith(seeded))?.severity, "warning");
  assert.equal(below(profileWith(null))?.severity, "warning");
});

// ── 4. Rule 3 ──────────────────────────────────────────────────────────────────────────
console.log("4. a human-verified row is never written; a differing official read is a conflict for a person");
const VER = { state: "UT", ahj: "City of Hollowmere" };
const VER_HOST = "https://www.hollowmereut.gov";
await check("MUST-PASS: the verified row is unchanged and the official read is listed as a conflict", () => {
  CP.saveVerifiedCodeProfile(db, { key: "", state: VER.state, ahj: VER.ahj, confidence: "verified", adoptedCodes: [], amendments: [], designCriteria: { groundSnowLoadPsf: 35 }, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "" }, "Pat Operator");
  const r = CP.mergeResearchedDesignCriteria(db, VER, page(VER_HOST, 50));
  assert.equal(r.saved, false);
  assert.equal(r.conflicts?.length, 1, JSON.stringify(r));
  const row = own(VER)!;
  assert.equal(row.confidence, "verified");
  assert.equal(row.verifiedBy, "Pat Operator");
  assert.equal(row.designCriteria.groundSnowLoadPsf, 35, "rule 3: the person's value stands");
  const listed = CP.listCodeProfiles(db).find((p) => p.ahj === VER.ahj)?.officialConflicts ?? [];
  assert.deepEqual(listed.map((c) => [c.field, c.current, c.found, c.sourceUrl]), [["designCriteria.groundSnowLoadPsf", 35, 50, `${VER_HOST}/220/Design-Criteria`]]);
  CP.mergeResearchedDesignCriteria(db, VER, page(VER_HOST, 50));
  assert.equal(CP.listOfficialConflicts(db).filter((c) => c.profileKey === row.key).length, 1, "recorded once per finding");
});
await check("a seeded read (no bytes retrieved) against a verified row records no conflict", () => {
  const seeded = CP.mergeResearchedDesignCriteria(db, VER, { ...page(VER_HOST, 61), retrieved: [] });
  assert.equal(seeded.conflicts, undefined);
});
await check("the conflict leaves the list once a person re-verifies the row with the official value", () => {
  const row = own(VER)!;
  CP.saveVerifiedCodeProfile(db, { ...row, designCriteria: { groundSnowLoadPsf: 50 } }, "Pat Operator");
  assert.deepEqual(CP.listOfficialConflicts(db, row.key), []);
});

// ── 5. Exclusions ──────────────────────────────────────────────────────────────────────
console.log("5. an official read never opens a filing door");
await check("MUST-EXCLUDE: an official value sets no verified_at and makes no portal 'verified' (rule 5 carve-out)", async () => {
  const now = new Date().toISOString();
  db.run("INSERT INTO permit_utility_knowledge (profile_key, state, ahj, utility, portal_url, confidence, sources_json, first_seen_at, last_learned_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["ut|city of pinecrest|", "UT", "City of Pinecrest", "", "https://aca-prod.accela.com/PINECREST/Default.aspx", "seeded", "[]", now, now, now]);
  const kb = db.get<{ verified_at: string | null }>("SELECT verified_at FROM permit_utility_knowledge WHERE profile_key = ?", ["ut|city of pinecrest|"]);
  assert.equal(isVerifiedKnowledge(kb), false, "the KB row is not verified by an official design-criteria read");
  const entity = await lookupPortalEntity(db, "UT", "City of Pinecrest");
  assert.deepEqual(entity?.verifiedPortals, [], "the rule 5 carve-out list stays person-verified only");
});
await check("MUST-EXCLUDE: an official page never makes a filing-email record usable without a named person", () => {
  const problems = filingEmailRecordProblems({ address: "permits@pinecrestut.gov", sourceUrl: `${GOV_HOST}/150/Building`, quote: "Email applications to permits@pinecrestut.gov", verifiedBy: "", verifiedAt: "" });
  assert.ok(problems.some((p) => /named person/.test(p)), problems.join("; "));
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall official-source tier checks passed");
process.exit(0);
