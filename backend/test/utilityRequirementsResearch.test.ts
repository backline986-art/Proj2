// A UTILITY'S APPLICATION REQUIREMENTS: THE FILING LOOKUP PROPOSES THEM, A PERSON RECORDS THEM
// (review-audit draft 03's last bullet and its PR's panel follow-up).
//
//   - the lookup's applicationRequirements proposals are shape-checked (a known kind, a page the search
//     returned, words naming the item; model memory proposes nothing);
//   - they land OFFICIAL only through #683's landingTierFor on bytes this process read (a government host
//     or a domain a person verified as the utility's own, the quote in the page, a fetched-at time), and
//     an official item blocks only when its own words make it mandatory; everything else lands SEEDED and
//     warns;
//   - never over a person's item (a different reading is one conflict for a person), never an official
//     item from another host, never a seeded proposal over the shipped seed (pins unchanged);
//   - a lookup answer with no requirement member changes nothing on the row;
//   - the person's PUT takes every kind and a "merge" mode; the panel's read lists every item.
// Fake fetch, fake model answers and invented utilities only: no network.
//   npx tsx backend/test/utilityRequirementsResearch.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "util-req-research-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "UTILITY_FILING_LOOKUP"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const UFL = await import("../src/utilityFilingLookup");
const UR = await import("../src/utilityRequirements");
const RES = await import("../src/utilityRequirementsResearch");
const { createPageReader, _resetPoliteness } = await import("../src/agencyPageReader");
import type { LLMProvider, WebLookupResult } from "../../shared/src/types";

const db = await openDatabase();
let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message.slice(0, 1500)}`); }
};

// ── Invented utilities and pages ────────────────────────────────────────────────────────────────
const GOV = "https://www.exampleton-nv.gov/utilities/solar-interconnection";
const GOV_TEXT = "Solar interconnection. Every application must include a photo of the meter showing the meter number. Include a one-line diagram of the system. Applications are reviewed in ten business days.";
const COM = "https://www.example-light-power.com/solar/apply";
const COM_TEXT = "Apply for solar. Your application must include a picture of the meter and a site plan showing the array.";
const PLATFORM = "https://exampleton.powerclerk.com/MvcAccount/Login";
const pages = new Map<string, string>([[GOV, GOV_TEXT], [COM, COM_TEXT]]);
let reads: string[] = [];
const newReader = () => {
  _resetPoliteness();
  return createPageReader({
    fetch: async (url: string) => {
      reads.push(url);
      return pages.has(url)
        ? { ok: true, status: 200, contentType: "text/html", text: `<!doctype html><html><head><title>Solar</title></head><body><p>${pages.get(url)}</p></body></html>`, finalUrl: url, reason: "HTTP 200" }
        : { ok: false, status: 404, contentType: "text/html", text: "", finalUrl: url, reason: "HTTP 404" };
    },
    minGapMs: 0, maxReads: 8,
  });
};

/** A fake lookup answer: the filing location and program (so the row saves), plus the proposals. */
function answer(seen: string[], requirements?: unknown, grounded = 1): Pick<LLMProvider, "webLookup"> {
  const body: Record<string, unknown> = {
    filing: { value: { name: "PowerClerk", url: PLATFORM }, sourceUrl: seen[0], quote: "Submit your interconnection application through PowerClerk." },
    program: { value: "net_metering", programName: "Net Metering", sourceUrl: seen[0], quote: "Customers are credited under our net metering program." },
    limits: {},
  };
  if (requirements !== undefined) body.applicationRequirements = requirements;
  return {
    webLookup: async () => ({ text: JSON.stringify(body), groundedSearches: grounded, stopReason: null, resultUrls: [...seen, PLATFORM], pagesRead: 1, fetchedUrls: [] }) as WebLookupResult,
  };
}
const GOV_UTILITY = { state: "NV", utility: "Exampleton Municipal Light" };
const run = (who: { state: string; utility: string }, llm: Pick<LLMProvider, "webLookup">, reader: ReturnType<typeof newReader> | null = newReader()) =>
  UFL.runUtilityFilingLookup(db, llm, { ...who, force: true, reader });
const item = (who: { state: string; utility: string }, key: string) => UR.filingRowRequirements(db, who.state, who.utility).requirements.find((r) => r.key === key);
const rowJson = (who: { state: string; utility: string }) => db.get<{ application_requirements_json: string }>("SELECT application_requirements_json FROM utility_filing_lookups WHERE profile_key = ?", [UFL.utilityFilingKey(who.state, who.utility)])?.application_requirements_json ?? null;

console.log("\nproposals, shape-checked");
await check("READS: a known kind, on a page the search returned, in words that name it; model memory proposes nothing", () => {
  const raw = [
    { key: "meter_photo", sourceUrl: GOV, quote: "Every application must include a photo of the meter showing the meter number." },
    { key: "meter_photo", sourceUrl: GOV, quote: "A second meter photo entry is ignored." },
    { key: "roof_photo", sourceUrl: GOV, quote: "A roof photo is required." },
    { key: "one_line", sourceUrl: "https://elsewhere.example.org/page", quote: "Include a one-line diagram." },
    { key: "site_plan", sourceUrl: GOV, quote: "Applications are reviewed in ten business days." },
    { key: "ac_disconnect", sourceUrl: GOV, quote: "short" },
  ];
  const r = RES.utilityRequirementReadsOf(raw, [GOV], true);
  assert.deepEqual(r.reads.map((x) => x.key), ["meter_photo"]);
  assert.equal(r.dropped.length, 4, r.dropped.join(" | "));
  assert.deepEqual(RES.utilityRequirementReadsOf(raw, [GOV], false).reads, [], "not web-grounded: nothing");
});

console.log("\nlanding through #683's one landing function");
await check("OFFICIAL: a .gov page read here lands official; mandatory words may block, plain words warn; a quote not in the bytes lands seeded", async () => {
  reads = [];
  const r = await run(GOV_UTILITY, answer([GOV], [
    { key: "meter_photo", sourceName: "Exampleton solar interconnection", sourceUrl: GOV, quote: "Every application must include a photo of the meter showing the meter number." },
    { key: "one_line", sourceUrl: GOV, quote: "Include a one-line diagram of the system." },
    { key: "site_plan", sourceUrl: GOV, quote: "A site plan must be attached to every application." },
  ]));
  assert.ok(r.saved, r.reason);
  assert.deepEqual(reads, [GOV], "the official page is read once, by the run");
  assert.deepEqual(r.requirements?.landed, ["meter_photo (official)", "one_line (official)", "site_plan (seeded)"]);
  const meter = item(GOV_UTILITY, "meter_photo")!;
  assert.deepEqual([meter.tier, meter.whenMissing, meter.sourceName], ["official", "blocker", "Exampleton solar interconnection"]);
  assert.match(String(meter.fetchedAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(UR.requirementMayBlock(meter), true);
  assert.deepEqual([item(GOV_UTILITY, "one_line")!.tier, item(GOV_UTILITY, "one_line")!.whenMissing], ["official", "warning"]);
  const site = item(GOV_UTILITY, "site_plan")!;
  assert.deepEqual([site.tier, site.whenMissing], ["seeded", "warning"], "the quote is not on the page read");
  assert.equal(UR.requirementMayBlock(site), false);
  const list = UR.resolveUtilityRequirements(db, GOV_UTILITY.state, GOV_UTILITY.utility);
  assert.deepEqual(list?.requirements.map((x) => x.key).sort(), ["meter_photo", "one_line", "site_plan"], "the gates read them");
});
await check("SEEDED: a utility's own .com page lands seeded and warns, even with mandatory words; no reader = seeded", async () => {
  const who = { state: "NV", utility: "Example Light & Power" };
  reads = [];
  const r = await run(who, answer([COM], [{ key: "meter_photo", sourceUrl: COM, quote: "Your application must include a picture of the meter and a site plan showing the array." }]));
  assert.deepEqual(reads, [], "a non-official host's page is not read (nothing there could land official)");
  assert.deepEqual([item(who, "meter_photo")!.tier, item(who, "meter_photo")!.whenMissing], ["seeded", "warning"], JSON.stringify(r.requirements));
  const who2 = { state: "NV", utility: "Exampleton Water and Light" };
  await run(who2, answer([GOV], [{ key: "meter_photo", sourceUrl: GOV, quote: "Every application must include a photo of the meter showing the meter number." }]), null);
  assert.equal(item(who2, "meter_photo")!.tier, "seeded", "no page read here: a model's quote is not a read");
});
await check("PERSON-VERIFIED HOST: once a person records an item cited to the utility's own .com page, that host reads official", async () => {
  const who = { state: "NV", utility: "Example Light & Power" };
  const saved = UR.recordUtilityApplicationRequirements(db, who, { requirements: [{ key: "account_verification", whenMissing: "warning", sourceUrl: COM, quote: "Bring your account number from a recent bill." }], verifiedBy: "Pat Synthetic", mode: "merge" });
  assert.ok(saved.saved, saved.reason);
  assert.deepEqual(RES.utilityPersonVerifiedHosts(db, who.state, who.utility), ["www.example-light-power.com"]);
  reads = [];
  await run(who, answer([COM], [{ key: "site_plan", sourceUrl: COM, quote: "Your application must include a picture of the meter and a site plan showing the array." }]));
  assert.deepEqual(reads, [COM]);
  assert.deepEqual([item(who, "site_plan")!.tier, item(who, "site_plan")!.whenMissing], ["official", "blocker"]);
  assert.equal(item(who, "account_verification")!.tier, "verified", "the person's item stands");
});

console.log("\nrule 3, the seed and the pins");
await check("RULE 3: an official read never replaces a person's item; a different reading is ONE conflict for a person", async () => {
  const saved = UR.recordUtilityApplicationRequirements(db, GOV_UTILITY, { requirements: [{ key: "meter_photo", whenMissing: "warning", sourceUrl: GOV, quote: "Every application must include a photo of the meter showing the meter number." }], verifiedBy: "Pat Synthetic", mode: "merge" });
  assert.ok(saved.saved, saved.reason);
  const proposal = [{ key: "meter_photo", sourceUrl: GOV, quote: "Every application must include a photo of the meter showing the meter number." }];
  const r1 = await run(GOV_UTILITY, answer([GOV], proposal));
  const r2 = await run(GOV_UTILITY, answer([GOV], proposal));
  const m = item(GOV_UTILITY, "meter_photo")!;
  assert.deepEqual([m.tier, m.whenMissing, m.verifiedBy], ["verified", "warning", "Pat Synthetic"]);
  assert.equal(r1.requirements?.conflicts.length, 1);
  assert.equal(r2.requirements?.conflicts.length, 1);
  const audits = db.query<{ id: string }>("SELECT id FROM audit_logs WHERE action = 'utility_filing.application_requirement_official_conflict'");
  assert.equal(audits.length, 1, "recorded once, not once per run");
});
await check("NEVER WEAKER: a seeded proposal never replaces an official item; an official item from another host is never replaced", async () => {
  const before = item(GOV_UTILITY, "one_line")!;
  await run(GOV_UTILITY, answer([GOV, COM], [{ key: "one_line", sourceUrl: COM, quote: "Your application must include a one-line diagram." }]));
  assert.deepEqual(item(GOV_UTILITY, "one_line"), before);
});
await check("SHIPPED SEED: a seeded proposal for a kind the shipped reference already cites is skipped, so today's findings do not move", async () => {
  const who = { state: "UT", utility: "Rocky Mountain Power" };
  const before = JSON.stringify(UR.resolveUtilityRequirements(db, who.state, who.utility));
  const r = await run(who, answer([COM], [{ key: "meter_photo", sourceUrl: COM, quote: "Your application must include a picture of the meter and a site plan showing the array." }]));
  assert.match(r.requirements?.skipped.join("; ") ?? "", /meter_photo \(the shipped reference covers it\)/);
  assert.equal(JSON.stringify(UR.resolveUtilityRequirements(db, who.state, who.utility)), before);
});
await check("PINS: a lookup answer with no requirement member, or an ungrounded one, leaves the row's items untouched", async () => {
  const who = { state: "NV", utility: "Exampleton Pinned Power" };
  const r = await run(who, answer([GOV]));
  assert.ok(r.saved && r.requirements === undefined);
  assert.equal(rowJson(who), "", "no requirement member: the column is never written");
  const before = rowJson(GOV_UTILITY);
  await run(GOV_UTILITY, answer([GOV], [{ key: "owner_signature", sourceUrl: GOV, quote: "The customer must sign the application." }], 0));
  assert.equal(rowJson(GOV_UTILITY), before, "ungrounded: nothing");
});

console.log("\nthe person's record and the panel's read");
await check("MERGE: the panel's mode keeps other people's items; replace (the default) is the person's whole list, as before", () => {
  const who = { state: "NV", utility: "Example Light & Power" };
  const r = UR.recordUtilityApplicationRequirements(db, who, { requirements: [{ key: "module_spec", whenMissing: "warning", sourceUrl: COM, quote: "Attach the module spec sheet for each panel model." }], verifiedBy: "Lee Synthetic", mode: "merge" });
  assert.ok(r.saved, r.reason);
  assert.deepEqual([item(who, "account_verification")!.verifiedBy, item(who, "module_spec")!.verifiedBy], ["Pat Synthetic", "Lee Synthetic"]);
  UR.recordUtilityApplicationRequirements(db, who, { requirements: [{ key: "module_spec", whenMissing: "warning", sourceUrl: COM, quote: "Attach the module spec sheet for each panel model." }], verifiedBy: "Lee Synthetic" });
  assert.equal(item(who, "account_verification"), undefined, "replace: the person's list is exactly what was stated");
  assert.equal(item(who, "site_plan")!.tier, "official", "official items for other kinds stay");
});
await check("VIEW: every item from the seed and the row, marked by origin and by which one the gates read", () => {
  const v = UR.utilityRequirementsView(db, "UT", "Rocky Mountain Power");
  assert.equal(v.displayName, "Rocky Mountain Power");
  assert.ok(v.rowExists);
  assert.ok(v.items.length >= 2 && v.items.every((x) => x.origin === "shipped" && x.inEffect));
  const g = UR.utilityRequirementsView(db, GOV_UTILITY.state, GOV_UTILITY.utility);
  assert.deepEqual(g.items.map((x) => `${x.key}:${x.tier}:${x.origin}:${x.inEffect}`).sort(), ["meter_photo:verified:row:true", "one_line:official:row:true", "site_plan:seeded:row:true"]);
  assert.deepEqual(UR.utilityRequirementsView(db, "NV", "Nowhere Electric"), { displayName: "Nowhere Electric", rowExists: false, items: [] });
});
await check("THE PUT'S SCHEMA takes every kind the data knows, and the merge mode", async () => {
  const { utilityApplicationRequirementsSchema } = await import("../src/validation");
  const { UTILITY_REQUIREMENT_KEYS } = await import("../../shared/src/types");
  for (const key of UTILITY_REQUIREMENT_KEYS) {
    assert.ok(utilityApplicationRequirementsSchema.safeParse({ requirements: [{ key, whenMissing: "warning", sourceUrl: COM, quote: "Words long enough." }], mode: "merge" }).success, key);
  }
  assert.ok(!utilityApplicationRequirementsSchema.safeParse({ requirements: [{ key: "roof_photo", whenMissing: "warning", sourceUrl: COM, quote: "Words long enough." }] }).success);
});
await check("UNIVERSAL: the research module names no utility, state or portal in code", () => {
  const code = fs.readFileSync(new URL("../src/utilityRequirementsResearch.ts", import.meta.url), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/PacifiCorp|Pacific Power|Rocky Mountain|Portland General|\bPGE\b|Idaho Power|powerclerk|Oregon|Utah|Idaho|"OR"|"UT"/i.test(code));
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
