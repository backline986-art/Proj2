// REVIEW-AUDIT DRAFTS 03 + 04 — THE UTILITY SIDE OF THE GATE COMES FROM EACH UTILITY'S RECORDED
// REQUIREMENTS, AND FOUR SMALL REVIEWER FIXES.
//
// 03: the reviewer checked the utility side only for two utilities, by name (Portland General,
// PacifiCorp); Idaho Power and city-owned utilities got silence. Now one rule reads a cited list per
// utility (backend/data/reference-utility-application-requirements.json + the utility's filing row),
// and the two utilities' findings are its first seeded rows — pinned here unchanged (ids, severities,
// titles, wording) except where draft 04 changes the wording on purpose.
// 04: (1) "Rocky MOUNTain Power" mapped the settings finding to the racking topic; (2) the settings
// message contradicted itself; (3) no AC-size cross-check in the gate; (4) the account evidence line
// was masked twice ("account number ****ured: ******7890").
//
// Synthetic data only; scratch DB; no network.
//   npx tsx backend/test/utilityRequirementsGate.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "util-req-"));
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
const { buildReviewerReport, topicForFinding } = await import("../src/reviewerEngine");
const UR = await import("../src/utilityRequirements");
const ufl = await import("../src/utilityFilingLookup");
const { MEASURED_FINDING_IDS } = await import("../src/reviewerVision");
const { findingHoldScope } = await import("../src/gateScope");
const { evidenceForTopic, evidenceLines } = await import("../src/projectEvidence");
import type { ProjectRecord, ReviewerFinding, UtilityApplicationRequirement } from "../../shared/src/types";

const db = await openDatabase();

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

let n = 0;
function job(over: Partial<ProjectRecord> = {}, snap: Record<string, unknown> = {}): ProjectRecord {
  n++;
  return {
    id: `util-req-${n}`, clientId: "client-x", homeownerName: "Synthetic Owner", projectAddress: `${100 + n} Synthetic Way`,
    city: "Testville", state: "OR", zip: "97000", ahj: "City of Testville", utility: "PGE",
    accountNumber: "1234567890", meterNumber: "987654", systemSizeDcKw: 8, systemSizeAcKw: 7.6,
    interconnectionMethod: "Load-side breaker", status: "pending",
    parserSnapshot: { moduleQty: "20", moduleWattage: "400", ...snap },
    ...over,
  } as unknown as ProjectRecord;
}
const ids = (p: ProjectRecord, opts = {}) => buildReviewerReport(p, opts).findings.map((f) => f.id);
const find = (p: ProjectRecord, id: string, opts = {}): ReviewerFinding | undefined => buildReviewerReport(p, opts).findings.find((f) => f.id === id);

console.log("\nthe two first seeded utilities: today's findings, from data");
await check("PINNED: a Utah Rocky Mountain Power job missing its meter photo blocks on reviewer.utility.pacpower-meter-photo, cited to RMP's own page", () => {
  for (const utility of ["Rocky Mountain Power", "PacifiCorp", "RMP", "Pacific Power", "Rocky Mtn. Power"]) {
    const f = find(job({ state: "UT", utility, meterNumber: "" }), "reviewer.utility.pacpower-meter-photo");
    assert.ok(f, utility);
    assert.equal(f!.severity, "blocker", utility);
    assert.equal(f!.title, "Rocky Mountain Power meter photo missing", utility);
    assert.equal(f!.message, "Rocky Mountain Power customer generation packages should not be staged without meter photo/evidence.");
    assert.equal(f!.category, "utility_nem");
    assert.match(f!.codeReferences[0]?.note ?? "", /including a picture of the meter/);
    assert.match(f!.codeReferences[0]?.sourceUrl ?? "", /^https:\/\/www\.rockymountainpower\.net\//);
  }
});
await check("PINNED: Oregon Pacific Power names Pacific Power; a meter number alone is a warning; inverter settings are a warning", () => {
  const p = job({ state: "OR", utility: "Pacific Power" });
  const meter = find(p, "reviewer.utility.pacpower-meter-photo");
  assert.equal(meter?.severity, "warning");
  assert.equal(meter?.title, "Verify Pacific Power meter photo");
  const settings = find(p, "reviewer.utility.pacpower-settings");
  assert.equal(settings?.severity, "warning");
  assert.equal(settings?.title, "Pacific Power inverter settings evidence missing");
  assert.equal(settings?.message, "Confirm UL 1741 SB / smart inverter settings evidence is included before NEM submission.");
});
await check("PINNED: Oregon PGE with an unverified account warns on reviewer.utility.pge-account with today's wording (the Oregon golden pins the rest)", () => {
  const f = find(job(), "reviewer.utility.pge-account");
  assert.equal(f?.severity, "warning");
  assert.equal(f?.title, "Verify PGE account evidence");
  assert.match(f!.message, /^PGE\/NEM submission has an account value, but parsed utility bill\/account match evidence is not strong enough\./);
});
await check("PGE's row is UNCITED (its page refused an automated read): a missing account warns and says why, and the core field blocker still holds the job", () => {
  const r = buildReviewerReport(job({ accountNumber: "" }));
  const account = r.findings.filter((f) => ["reviewer.utility.pge-account", "reviewer.core.account"].includes(f.id));
  assert.equal(account.length, 1, "one finding per topic");
  assert.equal(account[0].id, "reviewer.core.account");
  assert.equal(account[0].severity, "blocker");
  const seed = UR.shippedRecordFor("OR", "PGE")!.requirements.find((x) => x.key === "account_verification")!;
  assert.equal(UR.requirementMayBlock(seed), false);
});
await check("MUST-EXCLUDE: PG&E (California, or spelled with '&' anywhere) and a Washington 'Pacific County PUD' get no PGE / PacifiCorp finding", () => {
  for (const p of [job({ state: "CA", utility: "PGE" }), job({ state: "CA", utility: "Pacific Gas and Electric" }), job({ state: "OR", utility: "P.G.&E." }), job({ state: "OR", utility: "PG&E" }), job({ state: "WA", utility: "Pacific County PUD" })]) {
    const got = ids(p);
    assert.ok(!got.some((id) => /pge-account|pacpower/.test(id)), `${p.state} ${p.utility}: ${got.join(",")}`);
  }
});

console.log("\nevery other utility: data, or a callout that says nothing was checked");
await check("NO LIST ON FILE: Idaho Power gets one callout that its requirements are not on file (never silence)", () => {
  const f = find(job({ state: "ID", utility: "Idaho Power" }), "reviewer.utility.requirements-not-on-file");
  assert.equal(f?.severity, "callout");
  assert.equal(f?.message, "Idaho Power's application requirements are not on file; the utility side was not reviewed.");
  assert.ok(!find(job({ state: "ID", utility: "" }), "reviewer.utility.requirements-not-on-file"), "no utility named: the core field finding covers it");
});
await check("DATA ONLY: a person records Idaho Power's items on its filing row; the gate checks them (storage only on a battery job), cited", () => {
  ufl.saveUtilityFilingLookup(db, {
    state: "ID", utility: "Idaho Power", lookedUpAt: new Date().toISOString(),
    filing: { value: { name: "Customer Generation Application", url: null }, sourceUrl: "https://www.utility-example.com/apply", quote: "Apply online", origin: "lookup" },
    program: { value: "net_metering", sourceUrl: "https://www.utility-example.com/apply", quote: "net metering", origin: "lookup" },
  } as never);
  const r = UR.recordUtilityApplicationRequirements(db, { state: "ID", utility: "Idaho Power" }, {
    verifiedBy: "A. Person",
    requirements: [
      { key: "meter_photo", whenMissing: "blocker", sourceUrl: "https://www.utility-example.com/apply", quote: "Attach a photo of the meter with the application." },
      { key: "storage_mode_declaration", whenMissing: "blocker", sourceUrl: "https://www.utility-example.com/apply", quote: "Every battery system must declare its operating mode." },
      { key: "one_line", whenMissing: "warning", sourceUrl: "https://www.utility-example.com/apply", quote: "Include a one-line diagram." },
    ],
  });
  assert.equal(r.saved, true, r.reason);
  const list = UR.resolveUtilityRequirements(db, "ID", "Idaho Power");
  const pv = job({ state: "ID", utility: "Idaho Power", meterNumber: "" });
  const meter = find(pv, "reviewer.utility.meter-photo", { utilityRequirements: list });
  assert.equal(meter?.severity, "blocker");
  assert.equal(meter?.title, "Idaho Power meter photo missing");
  assert.match(meter!.codeReferences[0].adoptionScope, /Recorded by A\. Person/);
  assert.ok(!ids(pv, { utilityRequirements: list }).includes("reviewer.utility.storage-mode-declaration"), "no battery: no storage item");
  assert.ok(!ids(pv, { utilityRequirements: list }).includes("reviewer.utility.requirements-not-on-file"));
  const battery = job({ state: "ID", utility: "Idaho Power" }, { hasBattery: "yes", batteryQty: "1", batteryModel: "Synthetic Battery 10" });
  const storage = find(battery, "reviewer.utility.storage-mode-declaration", { utilityRequirements: list });
  assert.ok(storage, ids(battery, { utilityRequirements: list }).join(","));
});
await check("MUST-EXCLUDE: a person's item without the page's words, or with words that do not name it, is refused; no filing row = refused", () => {
  const bad = UR.recordUtilityApplicationRequirements(db, { state: "ID", utility: "Idaho Power" }, {
    verifiedBy: "A. Person", requirements: [{ key: "one_line", whenMissing: "blocker", sourceUrl: "https://www.utility-example.com/apply", quote: "Attach a photo of the meter." }],
  });
  assert.equal(bad.saved, false);
  const noRow = UR.recordUtilityApplicationRequirements(db, { state: "NV", utility: "Synthetic Light & Power" }, {
    verifiedBy: "A. Person", requirements: [{ key: "meter_photo", whenMissing: "blocker", sourceUrl: "https://www.utility-example.com/apply", quote: "Attach a photo of the meter." }],
  });
  assert.equal(noRow.saved, false);
  assert.match(noRow.reason, /No filing record/);
});
await check("#637 BAR: a seeded item blocks only with a named source, its URL and a quote naming the item; an 'official' claim off a government host reads as seeded", () => {
  const base: UtilityApplicationRequirement = { key: "meter_photo", whenMissing: "blocker", tier: "seeded", sourceName: "Utility page", sourceUrl: "https://www.utility-example.com/x", quote: "Include a picture of the meter." };
  assert.equal(UR.requirementMayBlock(base), true);
  assert.equal(UR.requirementMayBlock({ ...base, quote: "" }), false, "uncited");
  assert.equal(UR.requirementMayBlock({ ...base, quote: "Include a one-line diagram." }), false, "quote about something else");
  assert.equal(UR.requirementMayBlock({ ...base, sourceName: "" }), false, "unnamed source");
  assert.equal(UR.requirementMayBlock({ ...base, whenMissing: "warning" }), false, "a warning item never blocks");
  db.run("UPDATE utility_filing_lookups SET application_requirements_json = ? WHERE profile_key = ?", [
    JSON.stringify({ requirements: [{ ...base, key: "site_plan", quote: "", tier: "official", fetchedAt: "2026-11-10T00:00:00Z" }] }), ufl.utilityFilingKey("ID", "Idaho Power"),
  ]);
  const item = UR.filingRowRequirements(db, "ID", "Idaho Power").requirements.find((r) => r.key === "site_plan");
  assert.equal(item?.tier, "seeded", "a .com host is not an official source by itself");
});
await check("RULE 3: a person's item is never replaced by a seeded or official one for the same key", () => {
  const person: UtilityApplicationRequirement = { key: "one_line", whenMissing: "warning", tier: "verified", sourceName: "x", sourceUrl: "https://a.example/x", quote: "one-line diagram", verifiedBy: "A", verifiedAt: "2026-11-10" };
  const merged = UR.mergeRequirements([person], [{ ...person, tier: "seeded", whenMissing: "blocker" }], [{ ...person, tier: "official" }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].tier, "verified");
});
await check("#673 ADDITIVE: recording requirements never touches the storage-mode record on the same filing row", () => {
  const key = ufl.utilityFilingKey("ID", "Idaho Power");
  db.run("UPDATE utility_filing_lookups SET storage_modes_json = ? WHERE profile_key = ?", ['{"sentinel":true}', key]);
  UR.recordUtilityApplicationRequirements(db, { state: "ID", utility: "Idaho Power" }, {
    verifiedBy: "A. Person", requirements: [{ key: "meter_photo", whenMissing: "blocker", sourceUrl: "https://www.utility-example.com/apply", quote: "Attach a photo of the meter." }],
  });
  UR.clearUtilityApplicationRequirements(db, { state: "ID", utility: "Idaho Power" });
  assert.equal(db.get<{ s: string }>("SELECT storage_modes_json AS s FROM utility_filing_lookups WHERE profile_key = ?", [key])?.s, '{"sentinel":true}');
});
await check("UNIVERSAL: reviewerEngine names no utility in code any more (identity helpers gone; names live in data)", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "reviewerEngine.ts"), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  for (const re of [/knownPowerClerkUtility/, /pacifiCorpBrand/, /PacifiCorp|Pacific Power|Rocky Mountain|Portland General|\bPGE\b|Idaho Power/]) {
    assert.ok(!re.test(src), `reviewerEngine.ts matches ${re}`);
  }
});

console.log("\ndraft 04: the small reviewer fixes");
await check("04.1 a Rocky Mountain Power settings finding reads inverter-settings evidence, never racking ('Mountain' is not 'mount')", () => {
  const p = job({ state: "UT", utility: "Rocky Mountain Power" }, { invModel: "SYN-7600", splitPagesText: "Racking attachment detail: flashed standoffs lagged to rafters, page 4" });
  const f = find(p, "reviewer.utility.pacpower-settings")!;
  assert.equal(f.title, "Verify Rocky Mountain Power inverter settings");
  assert.equal(topicForFinding(f), "inverterSettings");
  assert.ok(!(f.evidenceFound ?? []).some((e) => /Racking/i.test(e.label)), (f.evidenceFound ?? []).map((e) => e.label).join(" | "));
  assert.equal(topicForFinding({ id: "x.custom", title: "Mounting detail missing" } as ReviewerFinding), "rackingAttachment");
  assert.equal(topicForFinding({ id: "reviewer.utility.site-plan", title: "Mount Example Utility site plan missing" } as ReviewerFinding), "siteRoofPlan");
});
await check("04.2 the settings message says what was read: a model on file, no settings text — no contradiction", () => {
  const f = find(job({ state: "UT", utility: "Rocky Mountain Power" }, { invModel: "SYN-7600" }), "reviewer.utility.pacpower-settings")!;
  assert.equal(f.message, "An inverter model or spec sheet is on file; no UL 1741 SB / settings text was found.");
});
await check("04.3 city.elec.ac-size-mismatch: one 32 A inverter (≈7.68 kW at 240 V) against AC 6.5 kW warns; 7.6 kW agrees; battery / existing system / 3-phase skip", () => {
  const ac = (over: Partial<ProjectRecord>, snap: Record<string, unknown>) => find(job({ state: "ID", utility: "Idaho Power", ...over }, snap), "city.elec.ac-size-mismatch");
  const f = ac({ systemSizeAcKw: 6.5 }, { invQty: "1", invOutputW: "32" });
  assert.equal(f?.severity, "warning");
  assert.match(f!.message, /7\.68 kW AC \(1 x 32 A x 240 V \(assumed\)\) but the project AC size is 6\.50 kW/);
  assert.ok(!ac({ systemSizeAcKw: 7.6 }, { invQty: "1", invOutputW: "32" }), "within 3%");
  assert.ok(ac({ systemSizeAcKw: 6.5 }, { pvMicroQty: "20", pvMicroOutputW: "1.6" }), "micros: 20 x 1.6 A x 240 V = 7.68 kW");
  assert.ok(ac({ systemSizeAcKw: 3 }, { invQty: "1", invOutputW: "7600" }), "a watt rating (> 100) is read as watts");
  assert.ok(!ac({ systemSizeAcKw: 6.5 }, { invQty: "1", invOutputW: "32", hasBattery: "yes", batteryQty: "1", batteryModel: "Synthetic Battery 10" }), "battery job skipped");
  assert.ok(!ac({ systemSizeAcKw: 6.5, existingSystem: { hasExistingSystem: true } as never }, { invQty: "1", invOutputW: "32" }), "existing system skipped");
  assert.ok(!ac({ systemSizeAcKw: 6.5 }, { invQty: "1", invOutputW: "32", serviceVoltage: "277/480V 3-phase" }), "three-phase skipped");
  assert.ok(MEASURED_FINDING_IDS.has("city.elec.ac-size-mismatch"), "vision never relaxes arithmetic");
  assert.equal(findingHoldScope({ id: "city.elec.ac-size-mismatch", category: "electrical" }), "all");
});
await check("04.4 the account evidence line masks the number only ('captured' stays a word)", () => {
  const lines = evidenceLines(evidenceForTopic(job(), "accountVerification")).join(" ");
  assert.match(lines, /account number captured: \*{6}7890/);
  assert.ok(!/\*{4}ured/.test(lines), lines);
  const meter = evidenceLines(evidenceForTopic(job(), "meterPhoto")).join(" ");
  assert.match(meter, /meter number captured: \*{2}7654/);
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
