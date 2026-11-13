// REVIEW-AUDIT DRAFT 16 B — A COUNTY PARCEL MAP ON A HOSTED MAP PLATFORM (ArcGIS Online), PERSON-VERIFIED.
//
// Many counties publish their parcel map on ArcGIS Online (Esri), never a government host, so draft 09
// refused them. The owner agreed (2026-11-10, "Yes that is okay") that a job's address may go to such a
// service, but only when a person first confirmed that the county's own website links that exact
// service. Helm's conditions, each pinned here:
//   (1) the shared #683 predicate (isOfficialSourceHost / isGovernmentHost) never learns arcgis.com;
//   (2) an ArcGIS-hosted record is used only at tier verified: a named person, the county's own
//       GOVERNMENT page URL and a verbatim quote naming the exact host — or (owner 2026-11-12, automated)
//       at tier official, once KEELIX's own read of that government page confirms the link
//       (parcelServiceLink.test.ts pins that path); never on a record's word alone;
//   (3) the query goes to that exact host (and service root) only; a redirect is not followed;
//   (4) the address only (street, city / ZIP), never a name, account or anything else;
//   (5) a record that neither path can vouch for is dropped at load; one waiting for Keelix's read is
//       refused at the door with no fetch; any other third-party host stays refused.
//
// Synthetic data only (every county, city, street, organisation id and page is invented); scratch DB;
// NO NETWORK: the "platform" is a fake answering through the fetch seam, and the test fails if any other
// host or service root is asked.
//   npx tsx backend/test/parcelMapPlatform.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parcel-map-platform-"));
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
const { isGovernmentHost, isOfficialSourceHost } = await import("../../shared/src/officialSource");
import type { ProjectRecord, ReviewerFinding } from "../../shared/src/types";

const db = await openDatabase();

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

// ── The fake platform service ─────────────────────────────────────────────────────────────────
const PLATFORM_HOST = "services9.arcgis.com";
const ORG = "SyntheticOrg0001"; // invented organisation id
const SERVICE_ROOT = `https://${PLATFORM_HOST}/${ORG}/arcgis/rest/services/Example_Parcels/FeatureServer`;
const PORTAL_HOST = "examplecounty.maps.arcgis.com"; // the host the county's page links (invented)
const asked: string[] = [];
let answerStatus = 200;
const PARCELS: Record<string, string> = { "1200 N EXAMPLE ST": "SAMPLETON", "77 FARMSTEAD RD": "UNINCORPORATED" };
PJ.setParcelFetchForTests(async (url) => {
  asked.push(url);
  // Anything but the verified service root on the fake platform host is a test failure.
  if (!url.startsWith(`${SERVICE_ROOT}/`)) throw new Error(`the test reached something other than the verified service: ${url}`);
  if (answerStatus !== 200) return { status: answerStatus, text: "" };
  const where = new URL(url).searchParams.get("where") ?? "";
  const street = (/^SITE_ADDR='(.*)'$/.exec(where)?.[1] ?? "").replace(/''/g, "'");
  const city = PARCELS[street];
  return { status: 200, text: JSON.stringify({ features: city === undefined ? [] : [{ attributes: { JURIS: city } }] }) };
});

const TEMPLATE = `${SERVICE_ROOT}/0/query?where=SITE_ADDR%3D%27{street}%27&outFields=JURIS&returnGeometry=false&f=json`;
/** A person-verified record on the platform, as the local worker would write it. */
const GOOD = {
  state: "ID",
  county: "Example County",
  covers: { cities: ["Sampleton"], zips: ["83999"] },
  queryUrl: TEMPLATE,
  recordsPath: "features",
  jurisdictionField: "attributes.JURIS",
  unincorporatedValues: ["UNINCORPORATED"],
  sourceName: "Example County Assessor — GIS maps",
  sourceUrl: "https://www.examplecounty.gov/assessor/gis",
  pageLinksHost: PORTAL_HOST,
  quote: `Parcel maps are available at ${PORTAL_HOST}`,
  fetchedAt: "2026-11-10T12:00:00Z",
  tier: "verified",
  verifiedBy: "Synthetic Reviewer",
  verifiedService: SERVICE_ROOT,
};
const load = (over: Record<string, unknown>) => PJ.sanitizeLookupSource({ ...GOOD, ...over });
const ADDRESS = { projectAddress: "1200 North Example Street", city: "Sampleton", state: "ID", zip: "83999" };

// ── (1) The shared predicate never learns the platform ────────────────────────────────────────
console.log("\n(1) the official-source predicate never learns the platform");
await check("isGovernmentHost / isOfficialSourceHost say no to platform hosts, whatever records load", () => {
  PJ.setJurisdictionLookupSourcesForTests([GOOD]);
  assert.equal(PJ.jurisdictionLookupSources().sources.length, 1, "the verified record loads");
  for (const h of [PLATFORM_HOST, PORTAL_HOST, "arcgis.com", "www.arcgis.com"]) {
    assert.equal(isGovernmentHost(h), false, h);
    assert.equal(isOfficialSourceHost(`https://${h}/x`), false, h);
  }
  assert.equal(PJ.isPersonVerifiedMapPlatformHost(PLATFORM_HOST), true);
  assert.equal(PJ.isPersonVerifiedMapPlatformHost("arcgis.com.example-vendor.com"), false, "a look-alike is not the platform");
  assert.equal(PJ.isPersonVerifiedMapPlatformHost("notarcgis.com"), false);
});

// ── (2) Verified tier only, on the county's own government page ───────────────────────────────
console.log("\n(2) a platform record is used only person-verified, quoted from the county's own government page");
await check("MUST-PASS: the person-verified record loads at tier verified, as a platform record bound to its service root", () => {
  const { source, problem } = load({});
  assert.equal(problem, "");
  assert.equal(source?.tier, "verified");
  assert.equal(source?.hostedOn, "map_platform");
  assert.equal(source?.verifiedService, SERVICE_ROOT);
  assert.equal(source?.mayBlock, true);
});
await check("a quote naming the service host itself (no pageLinksHost) also loads", () => {
  assert.equal(load({ pageLinksHost: "", quote: `Parcel data: ${PLATFORM_HOST}/${ORG}` }).problem, "");
});
await check("each missing condition drops the record at load, with the reason", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ verifiedService: "" }, /no verifiedService/],
    [{ verifiedService: `https://services8.arcgis.com/${ORG}/arcgis/rest/services/Example_Parcels/FeatureServer` }, /verifiedService is not on services9\.arcgis\.com/],
    [{ verifiedService: `https://${PLATFORM_HOST}` }, /no service path/],
    [{ verifiedService: `https://${PLATFORM_HOST}/AnotherOrg0002/arcgis/rest/services/Example_Parcels/FeatureServer` }, /queryUrl is not under verifiedService/],
    [{ verifiedService: `${SERVICE_ROOT.slice(0, -2)}` }, /queryUrl is not under verifiedService/], // a prefix that ends mid-segment
    [{ sourceUrl: "https://www.examplecounty.org/assessor/gis" }, /not the county's own government page/],
    [{ sourceUrl: `https://${PORTAL_HOST}/home` }, /not the county's own government page/],
    [{ sourceUrl: "" }, /not the county's own government page/],
    [{ sourceUrl: "http://www.examplecounty.gov/assessor/gis", verifiedBy: "" }, /not an https page on the county's own government host/],
  ];
  for (const [over, why] of cases) {
    const { source, problem } = load(over);
    assert.equal(source, null, JSON.stringify(over));
    assert.match(problem, /services9\.arcgis\.com is not a government host/, problem);
    assert.match(problem, why, problem);
    assert.match(problem, /nor can Keelix confirm the county links it/, problem);
  }
});
await check("a record short of a person's verification falls back to KEELIX's check: official, no person, not asked until confirmed", () => {
  const cases: Array<Record<string, unknown>> = [
    { verifiedBy: "" },
    { quote: "Parcel maps are available online" },
    { pageLinksHost: "maps.example-vendor.com", quote: "maps.example-vendor.com" },
    { fetchedAt: "" },
  ];
  for (const over of cases) {
    const { source, problem } = load(over);
    assert.equal(problem, "", JSON.stringify(over));
    assert.equal(source?.linkCheck, "keelix", JSON.stringify(over));
    assert.equal(source?.tier, "official");
    assert.equal(source?.verifiedBy, "", "never shown as a person's check");
    assert.equal(source?.verifiedService, SERVICE_ROOT);
    assert.equal(PJ.mayAskServiceUrl(source!, PJ.buildQueryUrl(source!, ADDRESS)), false, "not asked with no confirmation");
  }
});

// ── (5) Seeded / official dropped; any other third party refused ──────────────────────────────
console.log("\n(5) seeded or official platform records wait for Keelix's read; every other third-party host is refused");
await check("a seeded or official platform record loads only as waiting for Keelix's read of the county page", () => {
  for (const tier of ["seeded", "official", ""]) {
    const { source, problem } = load({ tier });
    assert.equal(problem, "", tier);
    assert.equal(source?.linkCheck, "keelix", tier);
    assert.equal(source?.tier, "official", tier);
    assert.equal(source?.linkConfirmation, undefined, "no confirmation comes from the data");
  }
});
await check("any other third-party host stays refused, even fully person-verified", () => {
  const { source, problem } = load({
    queryUrl: "https://maps.example-vendor.com/Org/rest/services/Parcels/0/query?where={street}",
    verifiedService: "https://maps.example-vendor.com/Org/rest/services/Parcels",
  });
  assert.equal(source, null);
  assert.match(problem, /maps\.example-vendor\.com is not a government host$/);
});
await check("the door refuses a seeded or official platform record handed in directly, with no fetch", async () => {
  const good = load({}).source!;
  const before = asked.length;
  for (const tier of ["seeded", "official"] as const) {
    const a = await PJ.askParcelService({ ...good, tier }, ADDRESS);
    assert.equal(a.status, "unavailable", tier);
    assert.match((a as { detail: string }).detail, /not a government host or the person-verified service/);
  }
  const unbound = await PJ.askParcelService({ ...good, hostedOn: "government", verifiedService: "" }, ADDRESS);
  assert.equal(unbound.status, "unavailable", "a platform URL on a record not loaded as a platform record");
  const waiting = load({ tier: "seeded" }).source!;
  assert.equal((await PJ.askParcelService(waiting, ADDRESS)).status, "unavailable", "a record waiting for Keelix's read");
  const verifiedButKeelix = await PJ.askParcelService({ ...good, linkCheck: "keelix", tier: "official", linkConfirmation: null }, ADDRESS);
  assert.equal(verifiedButKeelix.status, "unavailable", "a keelix record with no confirmation, however the rest reads");
  assert.equal(asked.length, before, "nothing was fetched");
});
await check("(3) the door refuses another organisation on the same platform host, or another host, with no fetch", async () => {
  const good = load({}).source!;
  const before = asked.length;
  const otherOrg = await PJ.askParcelService({ ...good, queryUrl: TEMPLATE.replace(ORG, "AnotherOrg0002") }, ADDRESS);
  assert.equal(otherOrg.status, "unavailable");
  const otherHost = await PJ.askParcelService({ ...good, queryUrl: TEMPLATE.replace(PLATFORM_HOST, "services8.arcgis.com") }, ADDRESS);
  assert.equal(otherHost.status, "unavailable");
  const vendor = await PJ.askParcelService({ ...good, queryUrl: "https://maps.example-vendor.com/q?w={street}" }, ADDRESS);
  assert.equal(vendor.status, "unavailable");
  assert.equal(asked.length, before, "nothing was fetched");
});

// ── (3) + (4) The exact service, the address only ─────────────────────────────────────────────
console.log("\n(3)+(4) the verified record is asked: its exact service, the address only");
PJ.setJurisdictionLookupSourcesForTests([GOOD]);
const client = createClient(db, { companyName: "Synthetic Solar Co" });
let seq = 0;
function makeProject(street: string, over: Record<string, unknown> = {}): ProjectRecord {
  seq++;
  const id = repo.createProject(db, {
    clientId: client.id, owner: `Homeowner Zebulon ${seq}`, street, city: "Sampleton", state: "ID", zip: "83999",
    ahj: "City of Sampleton", utility: "Example Power", dcKw: "8", acKw: "7.6", ...over,
  } as never).project.id;
  return repo.getProjectDetail(db, id).project;
}
const gate = (p: ProjectRecord) => repo.buildReviewerReportFor(db, repo.getProjectDetail(db, p.id).project).findings;
const byId = (fs: ReviewerFinding[], id: string) => fs.find((f) => f.id === id);
const runJob = async (p: ProjectRecord) => PJ.runParcelJurisdictionCheck(db, { projectId: p.id, addressKey: PJ.parcelAddressKey(p) });

await check("MUST-PASS: the verified record is asked once, at its exact service root, with nothing but the address", async () => {
  const p = makeProject("1200 North Example Street");
  const before = asked.length;
  const res = await runJob(p);
  assert.equal(res.status, "found");
  assert.equal(asked.length, before + 1, "one GET");
  const url = asked[asked.length - 1];
  // (4) The URL is the record's template with the street filled in, and nothing else of the job.
  assert.equal(url, TEMPLATE.replace("{street}", encodeURIComponent("1200 N EXAMPLE ST")));
  assert.doesNotMatch(url, /zebulon|synthetic solar|example power|homeowner/i, "no name, client or utility");
  assert.equal(new URL(url).hostname, PLATFORM_HOST);
});
await check("(4) a template asking for city and ZIP sends those, and still nothing else", async () => {
  const withCity = { ...GOOD, queryUrl: `${SERVICE_ROOT}/0/query?where=SITE_ADDR%3D%27{street}%27%20AND%20CITY%3D%27{city}%27%20AND%20ZIP%3D%27{zip}%27&f=json` };
  const src = PJ.sanitizeLookupSource(withCity).source!;
  const url = PJ.buildQueryUrl(src, ADDRESS);
  assert.equal(new URL(url).searchParams.get("where"), "SITE_ADDR='1200 N EXAMPLE ST' AND CITY='SAMPLETON' AND ZIP='83999'");
});
await check("MUST-PASS: the gate blocks a county parcel from the platform, naming the host and who verified the county links it", async () => {
  const p = makeProject("77 Farmstead Road");
  assert.equal((await runJob(p)).parcelAgency, "Example County");
  const f = byId(gate(p), "reviewer.jurisdiction.parcel");
  assert.equal(f?.severity, "blocker");
  assert.equal(f?.title, "Parcel is in Example County, not City of Sampleton");
  assert.match(f?.message ?? "", /Example County's parcel service \(services9\.arcgis\.com, a hosted map Synthetic Reviewer verified the county links, checked \d{4}-\d{2}-\d{2}\)/);
});
await check("(3) a redirect is not followed: a 3xx answer is 'not checked', and nothing more is asked", async () => {
  const p = makeProject("1200 North Example Street", { zip: "83998", city: "Sampleton" });
  answerStatus = 302;
  const before = asked.length;
  try {
    const res = await runJob(p);
    assert.equal(res.status, "unavailable");
  } finally { answerStatus = 200; }
  assert.equal(asked.length, before + 1, "one request, no follow-up");
  const f = byId(gate(p), "reviewer.profile.jurisdiction");
  assert.match(f?.message ?? "", /not checked \(the county's parcel service did not answer: .*HTTP 302\)/);
});
await check("every request in this file went to the verified service root on the platform host", () => {
  assert.ok(asked.length >= 3);
  for (const u of asked) assert.ok(u.startsWith(`${SERVICE_ROOT}/`), u);
});

PJ.setParcelFetchForTests(null);
PJ.setJurisdictionLookupSourcesForTests(null);
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
