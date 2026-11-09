// ISSUE #562 — A UTAH JOB NAMES ROCKY MOUNTAIN POWER, AND ITS PROFILE CARRIES SCHEDULE 137.
//
// PacifiCorp is one company on one PowerClerk tenant with two brands: Pacific Power (OR/WA/CA) and
// Rocky Mountain Power (UT/ID/WY). A Utah job read "Pacific Power" in its portal name, its
// application document line, its QC rules and its reviewer findings. The brand is now chosen by
// state; the identity, the shared tenant and the rule-5 host checks are unchanged. The Rocky
// Mountain Power utility row is seeded (never verified, rule 3) with Schedule 137's interconnection
// fees, residential cap and disconnect rule, cited to the tariff.
//
// Driven through the real write paths (createProject → learnFromProject, openDatabase → seed) on a
// scratch DB; synthetic data only, no network.
//
//   npx tsx backend/test/rockyMountainPowerBrand.test.ts
import "./_isolate"; // FIRST: runs in a temp cwd so filled/ docs/ never land in the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rmp-brand-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
delete process.env.PORTAL_AUTOMATION;
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "UTILITY_FILING_LOOKUP"]) process.env[k] = "off";
process.env.PORTAL_ALLOW_FINAL_SUBMIT = "false";
delete process.env.SMTP_HOST;
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const R = await import("../src/repository");
const PR = await import("../src/portalRecipes");
const { KNOWN_POWERCLERK_PORTALS, knownPowerClerkPortalFor, knownPowerClerkUtility, pacifiCorpBrand } = await import("../src/utilityIdentity");
const { hostFitsTrackAndEntity } = await import("../src/portalChannel");
const { buildReviewerReport } = await import("../src/reviewerEngine");
const { evaluateBaselineRules } = await import("../src/baselineRules");
const { isVerifiedKnowledge, knowledgeProfileKey, seedInitialKnowledgeBase } = await import("../src/knowledgeBase");

const db = await openDatabase();

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

const TENANT_URL = "https://pacificorpnetmetering.powerclerk.com/MvcAccount/Login";
type KbRow = { profile_key: string; state: string; ahj: string; utility: string; portal_name: string; portal_url: string; portal_platform: string; required_documents_json: string; notes: string; sources_json: string; confidence: string; verified_at: string | null; verified_by: string | null };
const utilRow = (state: string, utility: string): KbRow | undefined =>
  db.get<KbRow>("SELECT * FROM permit_utility_knowledge WHERE lower(state) = lower(?) AND ahj = '' AND lower(utility) = lower(?)", [state, utility]);
const combinedRow = (state: string, utility: string): KbRow | undefined =>
  db.get<KbRow>("SELECT * FROM permit_utility_knowledge WHERE lower(state) = lower(?) AND ahj <> '' AND lower(utility) = lower(?)", [state, utility]);

type P = Record<string, unknown>;
const project = (payload: P) => R.getProjectDetail(db, R.createProject(db, {
  owner: "Pat Example", dcKw: "8", acKw: "7.6", ...payload,
} as never).project.id).project;

console.log("\nthe brand by state; one identity, one tenant");
await check("MUST-PASS: PacifiCorp's brand is Rocky Mountain Power in UT/ID/WY and Pacific Power in OR/WA/CA", () => {
  for (const st of ["UT", "ID", "WY", "Utah"]) assert.equal(pacifiCorpBrand(st), "Rocky Mountain Power", st);
  for (const st of ["OR", "WA", "CA", "Oregon"]) assert.equal(pacifiCorpBrand(st), "Pacific Power", st);
});
await check("MUST-EXCLUDE: the identity is unchanged — every brand spelling in every PacifiCorp state is the one 'pacificorp'", () => {
  for (const [state, utility] of [["UT", "Rocky Mountain Power"], ["UT", "PacifiCorp"], ["UT", "RMP"], ["ID", "Pacific Power"], ["OR", "Pacific Power"], ["OR", "Rocky Mountain Power"]]) {
    assert.equal(knownPowerClerkUtility({ state, utility }), "pacificorp", `${state} ${utility}`);
  }
});
await check("MUST-PASS: the Utah portal is named Rocky Mountain Power's; its tenant (URL, host, owner) is PacifiCorp's one tenant", () => {
  const ut = knownPowerClerkPortalFor("pacificorp", "UT");
  const or = knownPowerClerkPortalFor("pacificorp", "OR");
  assert.equal(ut.portalName, "Rocky Mountain Power Customer Generation Portal");
  assert.equal(or.portalName, "Pacific Power Customer Generation Portal");
  for (const k of ["portalUrl", "host", "owner"] as const) {
    assert.equal(ut[k], KNOWN_POWERCLERK_PORTALS.pacificorp[k], k);
    assert.equal(or[k], KNOWN_POWERCLERK_PORTALS.pacificorp[k], k);
  }
  assert.deepEqual(knownPowerClerkPortalFor("portland_general", "OR"), KNOWN_POWERCLERK_PORTALS.portland_general);
});

console.log("\na Utah job's learned knowledge, QC and reviewer findings name Rocky Mountain Power");
const ut = project({ street: "450 Synthetic Way", city: "Saratoga Springs", state: "UT", zip: "84045", ahj: "City of Saratoga Springs", utility: "Rocky Mountain Power" });
const utTyped = project({ street: "451 Synthetic Way", city: "Lehi", state: "UT", zip: "84043", ahj: "City of Lehi", utility: "PacifiCorp" });
const or = project({ street: "5060 Synthetic Ave", city: "Coos Bay", state: "OR", zip: "97420", ahj: "City of Coos Bay", utility: "Pacific Power" });
await check("MUST-PASS: the learned combined row lists Rocky Mountain Power's application, never Pacific Power's", () => {
  for (const [utility, label] of [["Rocky Mountain Power", "RMP"], ["PacifiCorp", "typed PacifiCorp"]]) {
    const docs = JSON.parse(combinedRow("UT", utility)?.required_documents_json ?? "[]") as string[];
    assert.ok(docs.includes("Rocky Mountain Power customer generation application"), `${label}: ${docs.join(", ")}`);
    assert.ok(!docs.some((d) => /pacific power/i.test(d)), `${label}: ${docs.join(", ")}`);
  }
  void ut; void utTyped;
});
await check("MUST-PASS: the learned Utah utility row names Rocky Mountain Power's portal on PacifiCorp's tenant", () => {
  const row = utilRow("UT", "PacifiCorp");
  assert.equal(row?.portal_name, "Rocky Mountain Power Customer Generation Portal");
  assert.equal(row?.portal_url, TENANT_URL);
});
await check("MUST-EXCLUDE: an Oregon Pacific Power job keeps Pacific Power's wording everywhere", () => {
  const docs = JSON.parse(combinedRow("OR", "Pacific Power")?.required_documents_json ?? "[]") as string[];
  assert.ok(docs.includes("Pacific Power customer generation application"), docs.join(", "));
  assert.equal(utilRow("OR", "Pacific Power")?.portal_url, TENANT_URL);
  const rules = evaluateBaselineRules({ state: "OR", utility: "Pacific Power" } as never);
  assert.equal(rules.find((r) => r.ruleId === "pacpower-meter-photo")?.ruleName, "Pacific Power meter photo requirement");
  assert.equal(rules.find((r) => r.ruleId === "pacpower-ul1741sb")?.ruleName, "Pacific Power UL 1741 SB inverter settings");
  const titles = buildReviewerReport(or).findings.filter((f) => /^reviewer\.utility\.pacpower-/.test(f.id)).map((f) => f.title);
  assert.ok(titles.length > 0 && titles.every((t) => /Pacific Power/.test(t)), titles.join(" / "));
});
await check("MUST-PASS: QC on a Utah PacifiCorp job names Rocky Mountain Power (same rule IDs)", () => {
  for (const utility of ["Rocky Mountain Power", "PacifiCorp"]) {
    const rules = evaluateBaselineRules({ state: "UT", utility } as never).filter((r) => /^pacpower-/.test(r.ruleId));
    assert.deepEqual(rules.map((r) => r.ruleId).sort(), ["pacpower-meter-photo", "pacpower-ul1741sb"], utility);
    for (const r of rules) {
      assert.ok(/Rocky Mountain Power/.test(r.ruleName) && /Rocky Mountain Power/.test(r.message), `${utility}: ${r.ruleName} / ${r.message}`);
      assert.ok(!/Pacific Power/.test(`${r.ruleName} ${r.message}`), `${utility}: ${r.ruleName} / ${r.message}`);
    }
  }
});
await check("MUST-PASS: the reviewer's utility findings on a Utah job name Rocky Mountain Power (same finding IDs)", () => {
  const fs_ = buildReviewerReport(ut).findings.filter((f) => /^reviewer\.utility\.pacpower-/.test(f.id));
  assert.ok(fs_.some((f) => f.id === "reviewer.utility.pacpower-meter-photo"), fs_.map((f) => f.id).join(","));
  for (const f of fs_) {
    const words = JSON.stringify(f);
    assert.ok(/Rocky Mountain Power/.test(f.title), f.title);
    assert.ok(!/Pacific Power/.test(words), words);
  }
});

console.log("\nrule 5 is unchanged: the shared tenant is the NEM portal of both brands, never a permit portal");
await check("MUST-EXCLUDE: the NEM host gate accepts PacifiCorp's tenant for a Utah Rocky Mountain Power job; the permit track refuses it", () => {
  const entity = PR.portalEntityEvidence(db, { scope: "utility", state: "UT", name: "Rocky Mountain Power" });
  assert.equal(hostFitsTrackAndEntity("nem", entity, TENANT_URL, "kb").fits, true);
  const ahjEntity = PR.portalEntityEvidence(db, { scope: "ahj", state: "UT", name: "City of Saratoga Springs" });
  assert.equal(hostFitsTrackAndEntity("permit", ahjEntity, TENANT_URL, "kb").fits, false);
});

console.log("\nthe Rocky Mountain Power profile carries Schedule 137, seeded and cited");
const RMP_KEY = knowledgeProfileKey({ state: "UT", ahj: "", utility: "Rocky Mountain Power" });
await check("MUST-PASS: the seeded UT Rocky Mountain Power row carries Schedule 137's fees, 25 kW DC cap and disconnect rule", () => {
  const row = db.get<KbRow>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [RMP_KEY]);
  assert.ok(row, "no UT Rocky Mountain Power row");
  const notes = row!.notes;
  assert.match(notes, /Schedule 137/);
  assert.match(notes, /Level 1 \$60 per application/);
  assert.match(notes, /Level 2 \$75 per application plus \$1\.50 per kW/);
  assert.match(notes, /Level 3 \$150 per application plus \$3\.00 per kW/);
  assert.match(notes, /not more than 25 kW for a residential facility/);
  assert.match(notes, /nameplate DC/);
  assert.match(notes, /none required for inverter-based systems of 10 kW or less/);
  assert.equal(row!.portal_name, "Rocky Mountain Power Customer Generation Portal");
  assert.equal(row!.portal_url, TENANT_URL);
});
await check("MUST-PASS: the Schedule 137 facts are cited to the tariff, and land SEEDED, never verified (rule 3)", () => {
  const row = db.get<KbRow>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [RMP_KEY])!;
  const sources = JSON.parse(row.sources_json) as Array<{ label: string; url: string; sourceType: string }>;
  const tariff = sources.find((s) => /137_Net_Billing_Service\.pdf$/.test(s.url));
  assert.ok(tariff && tariff.sourceType === "official" && /Schedule 137/.test(tariff.label), JSON.stringify(sources));
  assert.equal(row.verified_at, null);
  assert.equal(isVerifiedKnowledge(row as never), false);
  assert.notEqual(row.confidence, "verified");
});
await check("MUST-EXCLUDE: re-seeding never overwrites a person's verified Rocky Mountain Power row (rule 3)", () => {
  db.run("UPDATE permit_utility_knowledge SET portal_name = ?, verified_at = ?, verified_by = ? WHERE profile_key = ?",
    ["RMP portal as a person typed it", "2026-11-01T00:00:00.000Z", "a person", RMP_KEY]);
  seedInitialKnowledgeBase(db);
  const row = db.get<KbRow>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [RMP_KEY])!;
  assert.equal(row.portal_name, "RMP portal as a person typed it");
  assert.equal(row.verified_by, "a person");
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
