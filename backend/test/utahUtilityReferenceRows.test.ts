// NORTHERN UTAH UTILITY ROWS AS SEEDED, CITED DATA (worker-refdata-ut, 2026-11-10).
//
// The staging soft run found the prospects' filings blocked on DATA: the three city-owned utilities
// (Murray City Power, Bountiful City Light & Power, Kaysville City Power) had no program limits and
// no application requirements, and Rocky Mountain Power's program limit lived only in a KB note.
// This pins the rows added to the two shipped files that already hold those facts:
//   - backend/data/reference-eligibility-limits.json (#679 shape): program caps, production meter,
//     installer certification — each with the page, its words and fetchedAt;
//   - backend/data/reference-utility-application-requirements.json (draft 03 shape): what each
//     utility's own application asks for.
// Pins: every row loads SEEDED (never verified, never official — rule 3); each matches the names a
// job carries; a blocker only where the row's own words name the item or carry the limit (Helm's
// #637 bar); Rocky Mountain Power keeps its ONE existing requirement record (its PowerClerk door is
// the existing KB seed, not duplicated); and no row here names a filing door, so a city utility's
// interconnection track stays "not yet identified" until a person verifies where it files.
// Remove the rows and every check below fails.
// Synthetic jobs only; scratch DB; no network.
//   npx tsx backend/test/utahUtilityReferenceRows.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ut-util-rows-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
for (const k of ["BACKGROUND_WORKERS", "UTILITY_FILING_LOOKUP", "PERMIT_PROCESS_LOOKUP"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const UR = await import("../src/utilityRequirements");
const EL = await import("../src/eligibilityLimits");
const { utilityTrackPresentation } = await import("../src/utilityFilingLookup");
const { channelKindOf } = await import("../src/submittalTracks");

const db = await openDatabase();
let failures = 0;
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`  ok   - ${label}`); } catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// The utility's own host for each display name (all are the cities' own .gov sites; the RMP tariff is RMP's).
const OWN_HOST: Record<string, RegExp> = {
  "Murray City Power": /(^|\.)murray\.utah\.gov$/,
  "Bountiful City Light & Power": /(^|\.)bountiful\.gov$/,
  "Kaysville City Power": /(^|\.)kaysville\.gov$/,
};
// The names a job's utility field carries (the soft run's spellings first).
const SPELLINGS: Array<[string, string]> = [
  ["Murray City Power", "Murray City Power"], ["Murray Power", "Murray City Power"],
  ["Bountiful City Light & Power", "Bountiful City Light & Power"], ["BCLP", "Bountiful City Light & Power"],
  ["Kaysville City", "Kaysville City Power"], ["Kaysville City Power", "Kaysville City Power"],
];

check("each city utility's requirement list resolves for the names a job carries, every item seeded and cited", () => {
  for (const [spelling, display] of SPELLINGS) {
    const list = UR.resolveUtilityRequirements(null, "UT", spelling);
    assert.ok(list, `${spelling}: a list`);
    assert.equal(list!.displayName, display, `${spelling}: ${display}`);
    for (const item of list!.requirements) {
      assert.equal(item.tier, "seeded", `${spelling}/${item.key}: seeded`);
      assert.ok(!item.verifiedBy && !item.verifiedAt, `${spelling}/${item.key}: no person's mark`);
      assert.match(new URL(item.sourceUrl).hostname, OWN_HOST[display], `${spelling}/${item.key}: the utility's own page`);
      assert.ok(item.quote.length >= 8, `${spelling}/${item.key}: the page's words`);
      assert.match(String(item.fetchedAt), /^2026-11-10T/, `${spelling}/${item.key}: fetchedAt`);
    }
  }
  // Not another state's job, and not a different utility that shares a word.
  assert.equal(UR.resolveUtilityRequirements(null, "ID", "Murray City Power"), null, "state gates the match");
});

check("a blocker only where the row's own words name the item (Helm's #637 bar); every other item warns", () => {
  const blocks = (utility: string) => UR.resolveUtilityRequirements(null, "UT", utility)!.requirements.filter((r) => UR.requirementMayBlock(r)).map((r) => r.key).sort();
  assert.deepEqual(blocks("Murray City Power"), ["ac_disconnect"]);
  assert.deepEqual(blocks("Bountiful City Light & Power"), ["ac_disconnect"]);
  // Kaysville's disconnect applies only to 11-15 kW facilities, so it warns.
  assert.deepEqual(blocks("Kaysville City Power"), []);
});

check("Rocky Mountain Power keeps its one existing record (confirmed, not duplicated)", () => {
  const records = UR.shippedUtilityRequirementRecords().filter((r) => r.states.includes("UT") && UR.shippedRecordFor("UT", "Rocky Mountain Power", [r]));
  assert.equal(records.length, 1, "one record answers to Rocky Mountain Power in Utah");
  assert.deepEqual(records[0].requirements.map((r) => r.key).sort(), ["inverter_settings", "meter_photo"]);
});

// ── Program limits (#679) ────────────────────────────────────────────────────────────────────
const job = (utility: string, dcKw: number, extra: Partial<Parameters<typeof EL.evaluateEligibility>[1]> = {}) => ({
  state: "UT", utility, ahj: "", programDcKw: dcKw, programAcKw: null, combinedNote: "", dcKw, acKw: null,
  stringsPerInverter: null, micro: true, productionMeterShown: true, clientCertifications: ["NABCEP Installation Certification"], today: "2026-11-10", ...extra,
});
const records = EL.eligibilityRecordsForState(null, "UT");
const ids = (findings: Array<{ ruleId: string; severity: string }>) => findings.map((f) => `${f.ruleId}:${f.severity}`).sort();

check("the shipped program rows seed SEEDED (never verified or official) and a reboot writes nothing new", () => {
  EL.seedEligibilityRecords(db);
  const rows = db.query<{ authority: string; confidence: string; verified_at: string; verified_by: string }>(
    "SELECT authority, confidence, verified_at, verified_by FROM authority_eligibility_limits WHERE state = 'UT' ORDER BY authority");
  assert.deepEqual(rows.map((r) => r.authority), ["Bountiful City Light & Power", "Kaysville City", "Kaysville City Power", "Murray City Power", "Rocky Mountain Power"]);
  for (const r of rows) {
    assert.equal(r.confidence, "seeded", `${r.authority}: seeded`);
    assert.equal(r.verified_at, "", `${r.authority}: no verified_at`);
    assert.equal(r.verified_by, "", `${r.authority}: no verified_by`);
  }
  assert.equal(EL.seedEligibilityRecords(db), 0, "unchanged rows are not rewritten");
});

check("every limit is cited: a named source, the utility's page, words that carry the value, fetchedAt", () => {
  for (const rec of records) {
    for (const [key, limit] of Object.entries(rec.limits)) {
      const c = (limit as { citation: { sourceName: string; sourceUrl: string; quote: string; fetchedAt?: string } }).citation;
      assert.ok(c.sourceName, `${rec.authority}/${key}: source name`);
      assert.match(c.sourceUrl, /^https:\/\//, `${rec.authority}/${key}: page`);
      assert.match(String(c.fetchedAt), /^2026-11-10T/, `${rec.authority}/${key}: fetchedAt`);
      assert.ok(c.quote.length >= 8, `${rec.authority}/${key}: words`);
    }
  }
});

check("over a cap: a blocker only where the words carry the limit and it binds every job; else a warning", () => {
  // Murray's pilot agreement is for systems of 10 kW DC or less, and Kaysville's caps at 15 kW DC: binding, cited.
  assert.deepEqual(ids(EL.evaluateEligibility(records, job("Murray City Power", 12))), ["eligibility.utility-program.maxDcKw:blocker"]);
  assert.deepEqual(ids(EL.evaluateEligibility(records, job("Kaysville City", 16))), ["eligibility.utility-program.maxDcKw:blocker"]);
  // Bountiful's 10 kW is for residential single-phase customers; RMP's 25 kW is for residential facilities.
  assert.deepEqual(ids(EL.evaluateEligibility(records, job("Bountiful City Light & Power", 12))), ["eligibility.utility-program.maxDcKw:warning"]);
  assert.deepEqual(ids(EL.evaluateEligibility(records, job("Rocky Mountain Power", 30))), ["eligibility.utility-program.maxDcKw:warning"]);
  // Under every cap, meter shown, certified: nothing, and no "not on file" any more.
  for (const u of ["Murray City Power", "Kaysville City", "Bountiful City Light & Power", "Rocky Mountain Power"]) {
    assert.deepEqual(EL.evaluateEligibility(records, job(u, 8), { reportUnknownProgram: true }), [], `${u}: clean`);
  }
});

check("a production meter the plans do not show, and Murray's installer certification, are said (warnings)", () => {
  assert.deepEqual(ids(EL.evaluateEligibility(records, job("Murray City Power", 8, { productionMeterShown: false, clientCertifications: [] }))),
    ["eligibility.utility-program.installerCertification.unconfirmed:warning", "eligibility.utility-program.productionMeterRequired.unconfirmed:warning"]);
  assert.deepEqual(ids(EL.evaluateEligibility(records, job("Bountiful City Light & Power", 8, { productionMeterShown: false }))),
    ["eligibility.utility-program.productionMeterRequired.unconfirmed:warning"]);
});

check("no row here names a filing door: a city utility's interconnection track stays not yet identified", () => {
  for (const utility of ["Murray City Power", "Bountiful City Light & Power", "Kaysville City"]) {
    const t = utilityTrackPresentation(db, { state: "UT", utility } as never);
    assert.equal(t.portalUrl, "", `${utility}: no portal`);
    assert.ok(!t.filedWithPermit, `${utility}: not filed-with-permit (that needs a person's verified record, #664)`);
    assert.equal(channelKindOf(t), "unknown", `${utility}: unknown until a person verifies it`);
  }
});

db.close();
if (failures) { console.error(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log("\nAll northern Utah utility row checks passed.");
process.exit(0);
