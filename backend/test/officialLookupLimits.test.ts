// PROGRAM LIMITS A UTILITY LOOKUP READS ON AN OFFICIAL PAGE LAND OFFICIAL (official-source slice 4a;
// CLAUDE.md rule 3; owner 2026-11-13: one rule across everything Keelix looks up, "Verified from <host>,
// <date>", a government page vouches for a utility's own .com site).
//
// What these checks pin:
//   A. A lookup's limits land official only when EVERY limit's quote is in the bytes Keelix read from an
//      official host (a .gov utility, or a .com a state commission page vouched for); an unvouched .com,
//      a quote missing from the page, or one limit short of that leaves the whole record seeded.
//   B. The write rules: a person's record is never written (a differing official read is logged once as a
//      conflict for a person); an official record is refreshed only from its own hosts; a seeded read never
//      replaces an official one.
//   C. Read time: the screen's read (eligibilityRecordsOnFile) re-checks an official record against the
//      utility's hosts as they stand, so a vouch that is gone demotes it; the finding says "Verified from
//      <host>, <date>", never "Verified by".
//   D. Doors untouched: the filing row stays seeded; these modules read no person-only door list.
//
// Utilities, hosts and pages are invented; every read is a fake transport; no model key.
//
// Kill tests (each mutation → the checks that fail), run by hand on this branch:
//   K1  lookupRecordTier: drop the landing test (host + in-bytes)          → A3, A4, A5.
//   K2  lookupRecordTier: one official limit is enough (some, not every)   → A5.
//   K3  landLookupEligibilityRecord: write over a person's record          → B1.
//   K4  landLookupEligibilityRecord: no same-host refresh rule             → B2.
//   K5  honourOfficialRecord: trust the stored tier                         → C1.
//   K6  runUtilityFilingLookup: grade with no hosts (no vouch)              → A2, C1.
//   K7  citeText: the old "official source, not verified by a person" words → C2.

import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "official-limits-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.FEE_RESEARCH = "off";
process.env.DOCUMENT_FETCH_BROWSER = "0";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
const emptyRef = (name: string, body: unknown) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(body)); return p; };
process.env.ELIGIBILITY_LIMITS_REFERENCE_PATH = emptyRef("elig.json", { records: [] });
process.env.UTILITY_REQUIREMENTS_REFERENCE_PATH = emptyRef("ureq.json", { records: [], strictDefault: {}, qcRuleDefinitions: [] });
process.env.AHJ_PROCESS_REFERENCE_PATH = emptyRef("ahj.json", { count: 0, profiles: [] });
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const reader = await import("../src/agencyPageReader");
const EL = await import("../src/eligibilityLimits");
const EO = await import("../src/eligibilityOfficial");
const ufl = await import("../src/utilityFilingLookup");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const ST = "UT";
type Raw = import("../src/agencyPageReader").RawFetch;
const transport = (pages: Record<string, string>): Raw => async (url) => {
  const body = pages[url] ?? pages[url.replace(/\/$/, "")];
  if (body == null) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
  return { ok: true, status: 200, contentType: "text/html; charset=utf-8", text: body, finalUrl: url, reason: "HTTP 200" };
};
const readerOver = (pages: Record<string, string>) => { reader._resetPoliteness(); return reader.createPageReader({ fetch: transport(pages), minGapMs: 0, maxReads: 12 }); };
const html = (body: string) => `<html><head><title>t</title></head><body><main>${body}</main></body></html>`;
const g = (answer: unknown, urls: string[]): WebLookupResult => ({ text: JSON.stringify(answer), groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0 });

const CAP_QUOTE = "Residential systems may not exceed 25 kW DC.";
const METER_QUOTE = "A separate production meter is required for every system.";
const answerFor = (site: string, limits: Record<string, unknown>) => {
  const apply = `${site}/customer-generation/apply/`;
  return {
    filing: { value: { name: "Customer portal", url: null }, sourceUrl: apply, quote: "Apply online in the customer portal." },
    program: { value: "net_billing", programName: "Customer Generation", sourceUrl: apply, quote: "Exports are credited at the export credit rate." },
    limits, fees: [],
  };
};
const cap = (url: string, quote = CAP_QUOTE) => ({ value: 25, citation: { sourceName: "Customer generation program", sourceUrl: url, quote } });
const meter = (url: string) => ({ value: true, citation: { sourceName: "Customer generation program", sourceUrl: url, quote: METER_QUOTE } });
const programPage = (extra = "") => html(`<p>Apply online in the customer portal.</p><p>Exports are credited at the export credit rate.</p><p>${CAP_QUOTE}</p>${extra}`);

async function runFor(utility: string, site: string, limits: Record<string, unknown>, pages: Record<string, string>, extraUrls: string[] = []) {
  const r = readerOver(pages);
  const apply = `${site}/customer-generation/apply/`;
  const run = await ufl.runUtilityFilingLookup(db, { webLookup: async () => g(answerFor(site, limits), [apply, `${site}/program`, ...extraUrls]) } as never, { state: ST, utility, force: true, reader: r });
  return { run, reads: r.log.map((l) => l.url) };
}
const stored = (utility: string) => EL.eligibilityRecordsForState(db, ST).find((x) => x.authority === utility);
const onFile = (utility: string) => EO.eligibilityRecordsOnFile(db, ST).find((x) => x.authority === utility);
const tierRow = (utility: string) => db.get<{ confidence: string; verified_at: string; limits_json: string }>(
  "SELECT confidence, verified_at, limits_json FROM authority_eligibility_limits WHERE record_key = ?", [EL.eligibilityKey("utility_program", ST, utility)]);

console.log("official lookup limits");

// ── A. landing ────────────────────────────────────────────────────────────────────────────────
const GOV = "https://www.quarrytownut.gov";
await check("(A1) a .gov utility's program page carrying the quote: the record lands official, its citation dated by Keelix's read", async () => {
  const { run, reads } = await runFor("Quarrytown Light", GOV, { maxDcKw: cap(`${GOV}/program`) }, { [`${GOV}/customer-generation/apply/`]: programPage(), [`${GOV}/program`]: programPage() });
  assert.ok(reads.includes(`${GOV}/program`), JSON.stringify(reads));
  const row = tierRow("Quarrytown Light");
  assert.equal(row?.confidence, "official", JSON.stringify(run.dropped));
  const rec = onFile("Quarrytown Light");
  assert.equal(rec?.confidence, "official");
  assert.match(String(rec?.limits.maxDcKw?.citation.fetchedAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(run.lookup?.confidence, "seeded", "the filing row is nobody's verified row");
});
const COM = "https://www.larchwoodpowerut.com";
const PUC = "https://psc.ut.gov/utilities/electric";
await check("(A2) a .com utility site a state commission page vouches for in the utility's name: official", async () => {
  const { run } = await runFor("Larchwood Power", COM, { maxDcKw: cap(`${COM}/program`) }, {
    [`${COM}/customer-generation/apply/`]: programPage(), [`${COM}/program`]: programPage(),
    [PUC]: html(`<h1>Electric utilities</h1><ul><li><a href="${COM}/">Larchwood Power</a></li></ul>`),
  }, [PUC]);
  assert.deepEqual(run.lookup?.siteVouches?.map((v) => v.host), ["www.larchwoodpowerut.com"]);
  assert.equal(tierRow("Larchwood Power")?.confidence, "official", JSON.stringify(run.dropped));
});
const UNV = "https://www.fenwickenergyut.com";
await check("(A3) the same page on a .com nobody vouched for: seeded", async () => {
  const { run } = await runFor("Fenwick Energy", UNV, { maxDcKw: cap(`${UNV}/program`) }, { [`${UNV}/customer-generation/apply/`]: programPage(), [`${UNV}/program`]: programPage() });
  assert.equal(tierRow("Fenwick Energy")?.confidence, "seeded", JSON.stringify(run.dropped));
  assert.equal(onFile("Fenwick Energy")?.confidence, "seeded");
});
const GOV2 = "https://www.marlowut.gov";
await check("(A4) a .gov page that does not carry the quote: seeded", async () => {
  await runFor("Marlow Utilities", GOV2, { maxDcKw: cap(`${GOV2}/program`) }, { [`${GOV2}/customer-generation/apply/`]: programPage(), [`${GOV2}/program`]: html("<p>Program details are being updated.</p>") });
  assert.equal(tierRow("Marlow Utilities")?.confidence, "seeded");
});
const GOV3 = "https://www.ashbyut.gov";
await check("(A5) every limit or none: one limit read in the bytes and one not leaves the whole record seeded", async () => {
  await runFor("Ashby Light", GOV3, { maxDcKw: cap(`${GOV3}/program`), productionMeterRequired: meter(`${GOV3}/program`) }, {
    [`${GOV3}/customer-generation/apply/`]: programPage(), [`${GOV3}/program`]: programPage(),
  });
  assert.equal(tierRow("Ashby Light")?.confidence, "seeded");
  await runFor("Ashby Light", GOV3, { maxDcKw: cap(`${GOV3}/program`), productionMeterRequired: meter(`${GOV3}/program`) }, {
    [`${GOV3}/customer-generation/apply/`]: programPage(), [`${GOV3}/program`]: programPage(`<p>${METER_QUOTE}</p>`),
  });
  assert.equal(tierRow("Ashby Light")?.confidence, "official", "both limits in the bytes");
});

// ── B. write rules ────────────────────────────────────────────────────────────────────────────
const pagesOf = (url: string, text: string) => new Map([[url, { text, fetchedAt: "2026-11-13T20:00:00.000Z" }]]);
const input = (utility: string, url: string, value = 25, quote = CAP_QUOTE) => ({
  authorityKind: "utility_program" as const, state: ST, authority: utility, programName: "Customer Generation",
  limits: { maxDcKw: { value, citation: { sourceName: "Program", sourceUrl: url, quote } } },
});
await check("(B1) a person's record is never written; a differing official read is logged once as a conflict for a person", () => {
  const U = "Pellston Electric", url = "https://www.pellstonut.gov/program";
  assert.equal(EL.saveEligibilityRecord(db, input(U, url, 20, "Systems may not exceed 20 kW DC."), { verifiedBy: "A Person" }).saved, true);
  const before = tierRow(U);
  const r = EL.landLookupEligibilityRecord(db, input(U, url), { pages: pagesOf(url, CAP_QUOTE), authorityHosts: [] });
  assert.equal(r.saved, false);
  assert.equal(r.conflict, true);
  assert.deepEqual(tierRow(U), before, "the person's record is unchanged");
  EL.landLookupEligibilityRecord(db, input(U, url), { pages: pagesOf(url, CAP_QUOTE), authorityHosts: [] });
  const logs = db.query<{ details: string }>("SELECT details FROM audit_logs WHERE action = 'eligibility_limits.official_conflict'");
  assert.equal(logs.filter((l) => l.details.includes(U)).length, 1, "logged once");
  // The same values from an official page: no conflict.
  const same = EL.landLookupEligibilityRecord(db, input(U, url, 20, "Systems may not exceed 20 kW DC."), { pages: pagesOf(url, "Systems may not exceed 20 kW DC."), authorityHosts: [] });
  assert.equal(same.conflict, false);
});
await check("(B2) an official record is refreshed only from its own hosts; a seeded read never replaces it", () => {
  const U = "Quenby Power", A = "https://www.quenbyut.gov/program", B = "https://energy.ut.gov/quenby";
  assert.equal(EL.landLookupEligibilityRecord(db, input(U, A), { pages: pagesOf(A, CAP_QUOTE), authorityHosts: [] }).tier, "official");
  const other = EL.landLookupEligibilityRecord(db, input(U, B, 30, "Systems may not exceed 30 kW DC."), { pages: pagesOf(B, "Systems may not exceed 30 kW DC."), authorityHosts: [] });
  assert.equal(other.saved, false, other.reason);
  assert.equal(JSON.parse(tierRow(U)!.limits_json).maxDcKw.value, 25);
  const seeded = EL.landLookupEligibilityRecord(db, input(U, "https://www.quenbyfanut.com/x", 40, "Systems may not exceed 40 kW DC."), { pages: new Map(), authorityHosts: [] });
  assert.equal(seeded.saved, false);
  assert.equal(tierRow(U)?.confidence, "official");
  const refresh = EL.landLookupEligibilityRecord(db, input(U, A, 30, "Systems may not exceed 30 kW DC."), { pages: pagesOf(A, "Systems may not exceed 30 kW DC."), authorityHosts: [] });
  assert.equal(refresh.saved, true, "the same host refreshes it");
  assert.equal(JSON.parse(tierRow(U)!.limits_json).maxDcKw.value, 30);
});

// ── C. read time and the words ────────────────────────────────────────────────────────────────
await check("(C1) a vouch that is gone demotes the record at read time; the stored tier is left as it was", () => {
  assert.equal(onFile("Larchwood Power")?.confidence, "official");
  db.run("UPDATE utility_filing_lookups SET payload_json = json_remove(payload_json, '$.siteVouches') WHERE profile_key = ?", [ufl.utilityFilingKey(ST, "Larchwood Power")]);
  assert.equal(onFile("Larchwood Power")?.confidence, "seeded");
  assert.equal(stored("Larchwood Power")?.confidence, "official", "a read writes nothing");
  assert.equal(onFile("Quarrytown Light")?.confidence, "official", "a .gov host needs no vouch");
});
await check("(C2) the finding names the source as 'Verified from <host>, <date>', never a person", () => {
  const records = EO.eligibilityRecordsOnFile(db, ST).filter((r) => r.authority === "Quarrytown Light");
  const job = { state: ST, utility: "Quarrytown Light", ahj: "", programDcKw: 30, programAcKw: null, combinedNote: "", dcKw: 30, acKw: null,
    stringsPerInverter: null, micro: true, productionMeterShown: true, clientCertifications: [], today: "2026-11-13" };
  const [f] = EL.evaluateEligibility(records, job as never);
  assert.ok(f, "over the cap: a finding");
  assert.match(f.message, / — Verified from www\.quarrytownut\.gov, \d{4}-\d{2}-\d{2}\./);
  assert.doesNotMatch(f.message, /seeded, verify|Verified by|not verified by a person/);
});

// ── D. doors ──────────────────────────────────────────────────────────────────────────────────
await check("(D1) doors untouched: the limit modules read no person-only door list and set no filing door", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ["eligibilityLimits.ts", "eligibilityOfficial.ts"]) {
    const src = fs.readFileSync(path.join(here, "..", "src", f), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(src, /utilityPersonVerifiedHosts|personVerifiedAuthorityHosts|filingDestination|portal_url|submission_method/, f);
  }
  for (const u of ["Quarrytown Light", "Larchwood Power"]) assert.equal(ufl.getUtilityFilingLookup(db, ST, u)?.confidence, "seeded", u);
});

if (failures) { console.error(`\nofficialLookupLimits: ${failures} FAILED`); process.exit(1); }
console.log("\nofficialLookupLimits: all passed");
process.exit(0);
