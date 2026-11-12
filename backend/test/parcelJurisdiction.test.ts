// REVIEW-AUDIT DRAFT 09 — CONFIRM THE JOB'S JURISDICTION FROM THE PARCEL, NOT THE MAILING CITY.
//
// A mailing city is a postal name: an address that says one city can sit on a parcel in the
// unincorporated county around it, and a permit filed with the city for a county parcel is refused.
// The gate used to say only "Jurisdiction/address verification recommended" where a seeded process
// profile asked for it. Now: per-county parcel-service DATA, read by a JOB against government hosts only,
// cached by address hash, and the gate reads the cache:
//   city address inside limits -> pass; same mailing city, county parcel -> blocker on permit tracks
//   (warning from an uncited seeded record); service down -> the callout, worded "not checked".
//
// Synthetic data only (every county, city, street and host is invented); scratch DB; NO NETWORK: the
// parcel service is a fake answering through the fetch seam, and the test fails if anything else is asked.
//   npx tsx backend/test/parcelJurisdiction.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parcel-jur-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
process.env.SKIP_CODE_RESEARCH = "1";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "UTILITY_FILING_LOOKUP"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const PJ = await import("../src/parcelJurisdiction");
const repo = await import("../src/repository");
const { createClient } = await import("../src/clients");
const { enqueueJob } = await import("../src/jobQueue");
const { buildReviewerReport } = await import("../src/reviewerEngine");
const { findingHoldScope, scopeHoldsTrack } = await import("../src/gateScope");
const { savePermitProcessLookup } = await import("../src/permitProcess");
import type { ProjectRecord, ReviewerFinding } from "../../shared/src/types";

const db = await openDatabase();

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

// ── The fake parcel service ──────────────────────────────────────────────────────────────────
const GOV_HOST = "gis.examplecounty.gov";
const asked: string[] = [];
let serviceDown = false;
/** Street -> the CITY field the fake county service returns ("" features = no parcel). */
const PARCELS: Record<string, string> = {
  "1200 N EXAMPLE ST": "SAMPLETON",
  "77 FARMSTEAD RD": "UNINCORPORATED",
  "5 O'NEIL WAY": "SAMPLETON",
};
PJ.setParcelFetchForTests(async (url) => {
  asked.push(url);
  const u = new URL(url);
  // Anything but the fake government host is a test failure: no real service is ever reached.
  if (u.hostname !== GOV_HOST) throw new Error(`the test reached a non-fake host: ${u.hostname}`);
  if (serviceDown) return { status: 503, text: "Service Unavailable" };
  const where = u.searchParams.get("where") ?? "";
  const m = /^SITE_ADDR='(.*)'$/.exec(where);
  const street = (m?.[1] ?? "").replace(/''/g, "'");
  const city = PARCELS[street];
  return { status: 200, text: JSON.stringify({ features: city === undefined ? [] : [{ attributes: { CITY: city } }] }) };
});

const RECORD = {
  state: "ID",
  county: "Example County",
  covers: { cities: ["Sampleton"], zips: ["83999"] },
  queryUrl: `https://${GOV_HOST}/arcgis/rest/services/Parcels/MapServer/0/query?where=SITE_ADDR%3D%27{street}%27&outFields=CITY&returnGeometry=false&f=json`,
  recordsPath: "features",
  jurisdictionField: "attributes.CITY",
  unincorporatedValues: ["UNINCORPORATED"],
  sourceName: "Example County GIS — parcel services",
  sourceUrl: "https://www.examplecounty.gov/gis/services",
  quote: `Parcel data is published at ${GOV_HOST}/arcgis/rest/services/Parcels`,
  fetchedAt: "2026-11-09T12:00:00Z",
  tier: "verified",
  verifiedBy: "Synthetic Reviewer",
};

// ── Data: per-county records, government hosts only ──────────────────────────────────────────
console.log("\nthe per-county records are data, and only a government host is ever asked");
await check("a record whose service is on a government host loads; one on any other host is dropped with the reason", () => {
  PJ.setJurisdictionLookupSourcesForTests([
    RECORD,
    { ...RECORD, county: "Vendor County", queryUrl: "https://maps.example-vendor.com/query?where={street}" },
    { ...RECORD, county: "Plain County", queryUrl: `http://${GOV_HOST}/query?where={street}` },
  ]);
  const { sources, problems } = PJ.jurisdictionLookupSources();
  assert.deepEqual(sources.map((s) => s.county), ["Example County"]);
  assert.ok(problems.some((p) => /Vendor County: maps\.example-vendor\.com is not a government host/.test(p)), problems.join(" | "));
  assert.ok(problems.some((p) => /Plain County: queryUrl is not https/.test(p)), problems.join(" | "));
});
await check("the tier is honoured only on its conditions: verified needs a named person, official a government page quoting the service's host", () => {
  const tierOf = (over: Record<string, unknown>) => PJ.sanitizeLookupSource({ ...RECORD, ...over }).source!;
  assert.equal(tierOf({}).tier, "verified");
  assert.equal(tierOf({ verifiedBy: "" }).tier, "seeded");
  assert.equal(tierOf({ tier: "official" }).tier, "official");
  assert.equal(tierOf({ tier: "official", sourceUrl: "https://blog.example.com/gis" }).tier, "seeded");
  assert.equal(tierOf({ tier: "official", quote: "Parcel data is published online" }).tier, "seeded");
  assert.equal(tierOf({ tier: "official", fetchedAt: "" }).tier, "seeded");
  // Helm's #637 bar: a seeded record blocks only when it names and quotes its source about THIS service.
  assert.equal(tierOf({ tier: "seeded" }).mayBlock, true);
  assert.equal(tierOf({ tier: "seeded", quote: "" }).mayBlock, false);
  assert.equal(tierOf({ tier: "seeded", sourceName: "" }).mayBlock, false);
});
await check("the address is sent as the county's site address: street line, unit dropped, USPS abbreviations, quotes escaped", () => {
  assert.equal(PJ.normalizeStreet("1200 North Example Street, Sampleton, ID 83999"), "1200 N EXAMPLE ST");
  assert.equal(PJ.normalizeStreet("1200 N. Example St. Apt 4"), "1200 N EXAMPLE ST");
  assert.equal(PJ.normalizeStreet("1200 North Example Street", "full"), "1200 NORTH EXAMPLE STREET");
  assert.equal(PJ.normalizeStreet("PO Box 12"), "", "no house number = nothing to look up");
  const src = PJ.sanitizeLookupSource(RECORD).source!;
  const url = PJ.buildQueryUrl(src, { projectAddress: "5 O'Neil Way", city: "Sampleton", state: "ID", zip: "83999" });
  assert.equal(new URL(url).searchParams.get("where"), "SITE_ADDR='5 O''NEIL WAY'");
});
await check("the service's answer: a city value is that city; an unincorporated value is the county; none, two, or an error is no answer", () => {
  const src = PJ.sanitizeLookupSource(RECORD).source!;
  const ans = (o: unknown) => PJ.parseParcelAnswer(JSON.stringify(o), src);
  assert.deepEqual(ans({ features: [{ attributes: { CITY: "SAMPLETON" } }] }), { status: "found", raw: "SAMPLETON", agency: "City of Sampleton", incorporated: true });
  assert.deepEqual(ans({ features: [{ attributes: { CITY: "unincorporated" } }] }), { status: "found", raw: "unincorporated", agency: "Example County", incorporated: false });
  assert.equal(ans({ features: [] }).status, "no_match");
  const two = ans({ features: [{ attributes: { CITY: "SAMPLETON" } }, { attributes: { CITY: "UNINCORPORATED" } }] });
  assert.equal(two.status, "no_match");
  assert.match((two as { detail: string }).detail, /more than one jurisdiction/);
  assert.equal(ans({ error: { code: 400 } }).status, "unavailable");
  assert.equal(PJ.parseParcelAnswer("<html>", src).status, "unavailable");
  const mapped = PJ.sanitizeLookupSource({ ...RECORD, cityNames: { SMP: "Sampleton" } }).source!;
  assert.equal((PJ.parseParcelAnswer(JSON.stringify({ features: [{ attributes: { CITY: "SMP" } }] }), mapped) as { agency: string }).agency, "City of Sampleton");
});
await check("the door refuses a non-government URL even if one were handed in (no fetch is made)", async () => {
  const before = asked.length;
  const src = { ...PJ.sanitizeLookupSource(RECORD).source!, queryUrl: "https://maps.example-vendor.com/q?w={street}" };
  const a = await PJ.askParcelService(src, { projectAddress: "1200 N Example St", city: "Sampleton", state: "ID", zip: "83999" });
  assert.equal(a.status, "unavailable");
  assert.equal(asked.length, before, "nothing was fetched");
});
await check("agency names: the same agency by name, never a city for its county; a state agency is not compared", () => {
  assert.equal(PJ.agenciesAgree(null, "ID", "Sampleton Building Division", "City of Sampleton"), true);
  assert.equal(PJ.agenciesAgree(null, "ID", "City of Sampleton", "Example County"), false);
  assert.equal(PJ.agenciesAgree(null, "ID", "Example County Development Services", "Example County"), true);
  assert.equal(PJ.isStateLevelAgency("Idaho Division of Building Safety", "ID"), true);
  assert.equal(PJ.isStateLevelAgency("City of Sampleton", "ID"), false);
});

// ── End to end on a scratch DB: QC queues, the job reads, the gate reads the cache ──────────────
console.log("\nthe job, the cache and the gate");
PJ.setJurisdictionLookupSourcesForTests([RECORD]);
const client = createClient(db, { companyName: "Synthetic Solar Co" });
let seq = 0;
function makeProject(street: string, over: Record<string, unknown> = {}): ProjectRecord {
  seq++;
  const id = repo.createProject(db, {
    clientId: client.id, owner: `Parcel Owner ${seq}`, street, city: "Sampleton", state: "ID", zip: "83999",
    ahj: "City of Sampleton", utility: "Example Power", dcKw: "8", acKw: "7.6", ...over,
  } as never).project.id;
  return repo.getProjectDetail(db, id).project;
}
const gate = (p: ProjectRecord) => repo.buildReviewerReportFor(db, repo.getProjectDetail(db, p.id).project).findings;
const byId = (fs: ReviewerFinding[], id: string) => fs.find((f) => f.id === id);
const count = (sql: string) => Number(db.get<{ n: number }>(sql)?.n ?? 0);
const runJob = async (p: ProjectRecord) => PJ.runParcelJurisdictionCheck(db, { projectId: p.id, addressKey: PJ.parcelAddressKey(p) });

const inCity = makeProject("1200 North Example Street");
const inCounty = makeProject("77 Farmstead Road");
const downProject = makeProject("9 Quiet Lane");

await check("READS WRITE NOTHING: the gate on a covered, un-looked-up job queues nothing, caches nothing, asks nothing — and says not checked", () => {
  const jobs = count("SELECT COUNT(*) AS n FROM job_queue");
  const rows = count("SELECT COUNT(*) AS n FROM parcel_jurisdiction_checks");
  const before = asked.length;
  const f = byId(gate(inCity), "reviewer.profile.jurisdiction");
  assert.equal(count("SELECT COUNT(*) AS n FROM job_queue"), jobs);
  assert.equal(count("SELECT COUNT(*) AS n FROM parcel_jurisdiction_checks"), rows);
  assert.equal(asked.length, before);
  assert.equal(f?.severity, "callout");
  assert.equal(f?.title, "Jurisdiction/address not checked against the parcel");
  assert.match(f?.message ?? "", /not checked \(the parcel has not been looked up yet\)/);
});
await check("QC's trigger does nothing in a process with no job worker (tests, smoke, scripts never start network reads)", async () => {
  assert.equal(await PJ.ensureParcelJurisdictionChecked(db, inCity.id), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM job_queue WHERE job_type = 'parcel_jurisdiction_check'`), 0);
});
await check("the queue decision: one job per project, its payload naming the project and the address HASH only", () => {
  assert.equal(PJ.queueParcelCheck(db, inCity.id, enqueueJob as never), 1);
  assert.equal(PJ.queueParcelCheck(db, inCity.id, enqueueJob as never), 0, "deduped while pending");
  const row = db.get<{ payload: string }>("SELECT payload FROM job_queue WHERE job_type = 'parcel_jurisdiction_check' AND project_id = ?", [inCity.id]);
  assert.ok(row);
  assert.doesNotMatch(row!.payload, /example|1200/i, "no address in the payload");
  assert.match(byId(gate(inCity), "reviewer.profile.jurisdiction")?.message ?? "", /the parcel lookup is queued/);
  db.run("DELETE FROM job_queue WHERE job_type = 'parcel_jurisdiction_check'");
});
await check("MUST-PASS: a city address inside its limits -> the gate passes it as confirmed from the parcel, no callout", async () => {
  const res = await runJob(inCity);
  assert.equal(res.status, "found");
  assert.equal(res.parcelAgency, "City of Sampleton");
  assert.doesNotMatch(JSON.stringify(res), /example st|1200/i, "the job's result names no address");
  const fs1 = gate(inCity);
  const f = byId(fs1, "reviewer.jurisdiction.parcel");
  assert.equal(f?.severity, "pass");
  assert.equal(f?.title, "Jurisdiction confirmed from the parcel: City of Sampleton");
  assert.match(f?.message ?? "", /Example County's parcel service \(gis\.examplecounty\.gov, checked \d{4}-\d{2}-\d{2}\)/);
  assert.equal(byId(fs1, "reviewer.profile.jurisdiction"), undefined);
  assert.equal(PJ.queueParcelCheck(db, inCity.id, enqueueJob as never), 0, "a fresh answer is not asked again");
});
await check("MUST-PASS: same mailing city, county parcel -> a BLOCKER that holds the permit tracks and not the utility filing", async () => {
  assert.equal((await runJob(inCounty)).parcelAgency, "Example County");
  const f = byId(gate(inCounty), "reviewer.jurisdiction.parcel");
  assert.equal(f?.severity, "blocker");
  assert.equal(f?.title, "Parcel is in Example County, not City of Sampleton");
  assert.match(f?.message ?? "", /permit filed with the wrong agency is refused/);
  const scope = findingHoldScope(f!);
  assert.equal(scope, "permit");
  for (const t of ["building", "electrical", "combo", "permit"] as const) assert.equal(scopeHoldsTrack(scope, t), true, t);
  assert.equal(scopeHoldsTrack(scope, "nem"), false);
});
await check("the same disagreement from an uncited seeded record is a WARNING, not a blocker (Helm's #637 bar)", () => {
  // Same service, same answer (the fingerprint covers what decides the answer, not the tier): seeded warns.
  PJ.setJurisdictionLookupSourcesForTests([{ ...RECORD, tier: "seeded", verifiedBy: "", sourceName: "" }]);
  try {
    const f = byId(gate(inCounty), "reviewer.jurisdiction.parcel");
    assert.equal(f?.severity, "warning");
    assert.match(f?.message ?? "", /seeded and uncited, so this is a warning/);
  } finally { PJ.setJurisdictionLookupSourcesForTests([RECORD]); }
});
await check("a changed service record makes a cached answer stale: not checked until it is asked again", () => {
  PJ.setJurisdictionLookupSourcesForTests([{ ...RECORD, jurisdictionField: "attributes.JURIS" }]);
  try {
    assert.equal(byId(gate(inCounty), "reviewer.jurisdiction.parcel"), undefined);
    assert.match(byId(gate(inCounty), "reviewer.profile.jurisdiction")?.message ?? "", /has not been looked up yet/);
  } finally { PJ.setJurisdictionLookupSourcesForTests([RECORD]); }
});
await check("a county that issues for the city (the cited permit-process lookup) agrees: no blocker", async () => {
  const delegated = makeProject("1200 North Example Street", { owner: "Delegation Owner", ahj: "Example County" });
  savePermitProcessLookup(db, {
    state: "ID", ahj: "City of Sampleton",
    issuingAgency: { value: "Example County Building Department", sourceUrl: "https://www.examplecounty.gov/building", quote: "Example County issues building permits for the City of Sampleton", origin: "lookup" },
    permitStructure: { value: null, sourceUrl: "", quote: "", origin: "lookup" },
    permits: [], lookedUpAt: "2026-11-09T12:00:00Z",
  } as never);
  const f = byId(gate(delegated), "reviewer.jurisdiction.parcel");
  assert.equal(f?.severity, "pass", "the cached answer for the same address is reused; the county issues for the city");
});
await check("MUST-PASS: the service is down -> the callout, worded not checked, with the reason; asked again later", async () => {
  serviceDown = true;
  try {
    const res = await runJob(downProject);
    assert.equal(res.status, "unavailable");
  } finally { serviceDown = false; }
  const fs2 = gate(downProject);
  assert.equal(byId(fs2, "reviewer.jurisdiction.parcel"), undefined);
  const f = byId(fs2, "reviewer.profile.jurisdiction");
  assert.equal(f?.severity, "callout");
  assert.match(f?.message ?? "", /not checked \(the county's parcel service did not answer: Example County: the service answered HTTP 503\)/);
  // Re-asked after the retry window, not before.
  assert.equal(PJ.queueParcelCheck(db, downProject.id, enqueueJob as never), 0);
  db.run("UPDATE parcel_jurisdiction_checks SET checked_at = ? WHERE status = 'unavailable'", [new Date(Date.now() - 7 * 3600_000).toISOString()]);
  assert.equal(PJ.queueParcelCheck(db, downProject.id, enqueueJob as never), 1);
  db.run("DELETE FROM job_queue WHERE job_type = 'parcel_jurisdiction_check'");
});
await check("an address no record covers keeps today's behaviour: no finding unless the process profile asks, then not checked", () => {
  const p = { ...inCity, city: "Elsewhere", zip: "83000" } as ProjectRecord;
  const r = PJ.readParcelJurisdiction(db, p);
  assert.equal(r.status, "not_checked");
  assert.equal(r.covered, false);
  const none = buildReviewerReport(p, { parcelJurisdiction: r }).findings;
  assert.equal(byId(none, "reviewer.profile.jurisdiction"), undefined);
  assert.equal(byId(none, "reviewer.jurisdiction.parcel"), undefined);
});
await check("the cache holds no address: only a hash, the agency and the service host", () => {
  const rows = db.query<Record<string, unknown>>("SELECT * FROM parcel_jurisdiction_checks");
  assert.ok(rows.length >= 3);
  for (const r of rows) {
    assert.match(String(r.address_key), /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(r), /example st|farmstead|quiet ln|1200|\b77\b/i);
  }
  for (const u of asked) assert.equal(new URL(u).hostname, GOV_HOST);
});

PJ.setParcelFetchForTests(null);
PJ.setJurisdictionLookupSourcesForTests(null);
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
