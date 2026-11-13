// KEELIX CONFIRMS A COUNTY'S OWN PAGE LINKS ITS HOSTED PARCEL MAP, THEN USES IT (draft 16 B, automated;
// owner 2026-11-12, "would like it to be automated if we could. arcgis maps are pretty useful").
//
// Under the one official-source rule (#683): a county parcel map on ArcGIS Online (Esri) is asked with
// a job's street address only after KEELIX ITSELF read the county's own GOVERNMENT page and found the
// link in the bytes it retrieved, recording the page, the link, the page's own words around it and
// when. Pinned here:
//   (A) the platform never becomes a government host (isGovernmentHost / isOfficialSourceHost);
//   (B) what counts as the county linking the service (linkMatchFor / pageLinks): the service itself,
//       the same organisation on the same shared host, or the organisation's own site whose public
//       self-description names the same organisation id; never a script, a comment, a style block,
//       another organisation, another host, plain http, or a look-alike host;
//   (C) the reads Keelix makes to confirm carry nothing of any job and go only to the county's https
//       government page (same-host redirects) and an organisation site's portals/self;
//   (D) the service is asked only while the confirmation holds (confirmed, < 30 days, for this record's
//       page and service root) — a forged, stale or refused confirmation is refused at the door with no
//       fetch, and a page that stops linking the map stops the asking and the answer;
//   (E) the gate names the county page and read date, official, never as a person's check.
//
// Synthetic, saved pages only (backend/test/fixtures/parcel-link-pages; every county, host and
// organisation id invented); scratch DB; NO NETWORK: both fetch seams are fakes, and the test fails if
// anything else is asked.
//   npx tsx backend/test/parcelServiceLink.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parcel-service-link-"));
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
const SL = await import("../src/parcelServiceLink");
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

// ── Saved pages and the fakes ─────────────────────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const pageFile = (name: string) => fs.readFileSync(path.join(here, "fixtures", "parcel-link-pages", name), "utf8");
const PLATFORM_HOST = "services9.arcgis.com";
const ORG = "SyntheticOrg0001";
const SERVICE_ROOT = `https://${PLATFORM_HOST}/${ORG}/arcgis/rest/services/Example_Parcels/FeatureServer`;
const COUNTY_PAGE = "https://www.examplecounty.gov/assessor/gis";
const ORG_SITE = "examplecounty.maps.arcgis.com";
const TEMPLATE = `${SERVICE_ROOT}/0/query?where=SITE_ADDR%3D%27{street}%27&outFields=JURIS&returnGeometry=false&f=json`;

/** What the county's page currently serves, and what the organisation site says its id is. */
let servedPage = "links-service.html";
let pageStatus = 200;
let pageRedirect = "";
let orgSiteId = ORG;
const linkReads: string[] = [];
SL.setLinkCheckFetchForTests(async (url) => {
  linkReads.push(url);
  if (url === `https://${ORG_SITE}/sharing/rest/portals/self?f=json`) return { status: 200, text: JSON.stringify({ id: orgSiteId, urlKey: "examplecounty", name: "Example County GIS" }) };
  if (url.startsWith("https://www.examplecounty.gov/")) {
    if (pageRedirect && url === COUNTY_PAGE) return { status: 301, text: "", location: pageRedirect };
    if (pageStatus !== 200) return { status: pageStatus, text: "" };
    return { status: 200, text: pageFile(servedPage) };
  }
  throw new Error(`the link check reached something it must not: ${url}`);
});
const asked: string[] = [];
const PARCELS: Record<string, string> = { "1200 N EXAMPLE ST": "SAMPLETON", "77 FARMSTEAD RD": "UNINCORPORATED" };
PJ.setParcelFetchForTests(async (url) => {
  asked.push(url);
  if (!url.startsWith(`${SERVICE_ROOT}/`)) throw new Error(`the test reached something other than the service: ${url}`);
  const where = new URL(url).searchParams.get("where") ?? "";
  const street = (/^SITE_ADDR='(.*)'$/.exec(where)?.[1] ?? "").replace(/''/g, "'");
  const city = PARCELS[street];
  return { status: 200, text: JSON.stringify({ features: city === undefined ? [] : [{ attributes: { JURIS: city } }] }) };
});

/** A record as a researcher (or Keelix's own lookup) lists it: no person, no quote of its own. */
const RECORD = {
  state: "ID",
  county: "Example County",
  covers: { cities: ["Sampleton"], zips: ["83999"] },
  queryUrl: TEMPLATE,
  recordsPath: "features",
  jurisdictionField: "attributes.JURIS",
  unincorporatedValues: ["UNINCORPORATED"],
  sourceName: "Example County Assessor — GIS data",
  sourceUrl: COUNTY_PAGE,
  serviceRoot: SERVICE_ROOT,
  tier: "seeded",
};
const ADDRESS = { projectAddress: "1200 North Example Street", city: "Sampleton", state: "ID", zip: "83999" };
const loaded = () => PJ.sanitizeLookupSource(RECORD).source!;
const clearChecks = () => db.run("DELETE FROM parcel_service_link_checks");
const reset = () => { servedPage = "links-service.html"; pageStatus = 200; pageRedirect = ""; orgSiteId = ORG; clearChecks(); };

// ── (A) ───────────────────────────────────────────────────────────────────────────────────────
console.log("\n(A) the platform never becomes a government host");
await check("isGovernmentHost / isOfficialSourceHost say no to every platform host", () => {
  for (const h of [PLATFORM_HOST, ORG_SITE, "arcgis.com", "www.arcgis.com", "utility.arcgis.com"]) {
    assert.equal(isGovernmentHost(h), false, h);
    assert.equal(isOfficialSourceHost(`https://${h}/x`), false, h);
  }
});
await check("the record loads waiting for Keelix (official, no person), and is not asked yet", () => {
  const s = loaded();
  assert.equal(s.hostedOn, "map_platform");
  assert.equal(s.linkCheck, "keelix");
  assert.equal(s.tier, "official");
  assert.equal(s.verifiedBy, "");
  assert.equal(s.verifiedService, SERVICE_ROOT);
  assert.equal(PJ.mayAskServiceUrl(s, PJ.buildQueryUrl(s, ADDRESS)), false);
});
await check("a record whose source page is not an https government page is dropped at load", () => {
  for (const sourceUrl of ["https://www.examplecounty.org/gis", `https://${ORG_SITE}/home`, "http://www.examplecounty.gov/gis", ""]) {
    const { source, problem } = PJ.sanitizeLookupSource({ ...RECORD, sourceUrl });
    assert.equal(source, null, sourceUrl);
    assert.match(problem, /nor can Keelix confirm the county links it: sourceUrl.*not an https page on the county's own government host/, problem);
  }
});
await check("a record whose query leaves its service root, or names no root, is dropped at load", () => {
  for (const [over, why] of [
    [{ serviceRoot: "" }, /no serviceRoot/],
    [{ serviceRoot: `https://${PLATFORM_HOST}` }, /no service path/],
    [{ serviceRoot: `https://${PLATFORM_HOST}/AnotherOrg0002/arcgis/rest/services/Example_Parcels/FeatureServer` }, /queryUrl is not under serviceRoot/],
    [{ serviceRoot: SERVICE_ROOT.replace(PLATFORM_HOST, "services8.arcgis.com") }, /serviceRoot is not on services9\.arcgis\.com/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    const { source, problem } = PJ.sanitizeLookupSource({ ...RECORD, ...over });
    assert.equal(source, null, JSON.stringify(over));
    assert.match(problem, why, problem);
  }
});

// ── (B) ───────────────────────────────────────────────────────────────────────────────────────
console.log("\n(B) what counts as the county linking the service");
await check("linkMatchFor: the service, a layer or query under it, the same organisation; nothing else", () => {
  assert.equal(SL.linkMatchFor(SERVICE_ROOT, SERVICE_ROOT), "service");
  assert.equal(SL.linkMatchFor(`${SERVICE_ROOT}/`, SERVICE_ROOT), "service");
  assert.equal(SL.linkMatchFor(`${SERVICE_ROOT}/0`, SERVICE_ROOT), "service");
  assert.equal(SL.linkMatchFor(`${SERVICE_ROOT}?f=pjson`, SERVICE_ROOT), "service");
  assert.equal(SL.linkMatchFor(`https://SERVICES9.arcgis.com/${ORG}/arcgis/rest/services/Example_Parcels/FeatureServer`, SERVICE_ROOT), "service", "host case does not matter");
  assert.equal(SL.linkMatchFor(`https://${PLATFORM_HOST}/${ORG}/arcgis/rest/services`, SERVICE_ROOT), "organisation");
  assert.equal(SL.linkMatchFor(`https://${PLATFORM_HOST}/${ORG}/arcgis/rest/services/City_Limits/FeatureServer`, SERVICE_ROOT), "organisation");
  assert.equal(SL.linkMatchFor(`${SERVICE_ROOT}2`, SERVICE_ROOT), "organisation", "a name that merely starts the same is not the service (same organisation only)");
  assert.equal(SL.linkMatchFor(`https://utility.arcgis.com/usrsvcs/servers/abc/rest/services/X/MapServer`, "https://utility.arcgis.com/usrsvcs/servers/def/rest/services/X/MapServer"), "", "no organisation on a host without one");
  for (const no of [
    `https://${PLATFORM_HOST}/AnotherOrg0002/arcgis/rest/services/Example_Parcels/FeatureServer`,
    `https://services8.arcgis.com/${ORG}/arcgis/rest/services/Example_Parcels/FeatureServer`,
    SERVICE_ROOT.replace("https://", "http://"),
    `https://${PLATFORM_HOST}.example-vendor.com/${ORG}/arcgis/rest/services/Example_Parcels/FeatureServer`,
    `https://${PLATFORM_HOST}/arcgis/rest/services`,
    `https://${ORG_SITE}/apps/webappviewer/index.html`,
  ]) assert.equal(SL.linkMatchFor(no, SERVICE_ROOT), "", no);
});
await check("pageLinks reads <a>, <iframe> and bare URLs as the page wrote them, entities decoded, quote verbatim", () => {
  const html = pageFile("links-org-site.html");
  const links = SL.pageLinks(html, COUNTY_PAGE);
  const viewer = links.find((l) => l.url.includes("webappviewer"));
  assert.ok(viewer, "the <a> link");
  assert.equal(viewer!.url, "https://examplecounty.maps.arcgis.com/apps/webappviewer/index.html?id=0123456789abcdef0123456789abcdef&extent=1");
  assert.ok(html.includes(viewer!.quote), "the quote is the page's own bytes");
  assert.match(viewer!.quote, /Parcel Viewer<\/a>$/);
  assert.ok(links.some((l) => l.url.includes("/apps/instant/")), "the embedded map");
  const text = SL.pageLinks(`<p>Service: ${SERVICE_ROOT}.</p>`, COUNTY_PAGE);
  assert.deepEqual(text.map((l) => l.url), [SERVICE_ROOT]);
  assert.ok(`<p>Service: ${SERVICE_ROOT}.</p>`.includes(text[0].quote));
});
await check("a link only in a script, a style block or a comment is not the county's word", () => {
  assert.equal(SL.findServiceLink(pageFile("link-only-in-script.html"), COUNTY_PAGE, SERVICE_ROOT), null);
});

// ── (C) + confirmation ────────────────────────────────────────────────────────────────────────
console.log("\n(C) Keelix reads the county's page, and only that, to confirm");
await check("MUST-PASS: a page linking the service confirms it, with the link, the page's own words, its hash and the read time", async () => {
  reset();
  linkReads.length = 0;
  const c = await SL.confirmParcelServiceLink(db, loaded());
  assert.equal(c.status, "confirmed", c.detail);
  assert.equal(c.kind, "service");
  assert.equal(c.linkUrl, SERVICE_ROOT);
  assert.ok(pageFile("links-service.html").includes(c.quote), "the quote is in the retrieved bytes");
  assert.match(c.quote, /Tax Parcels \(REST\)/);
  assert.match(c.pageSha256, /^[0-9a-f]{64}$/);
  assert.match(c.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(linkReads, [COUNTY_PAGE], "one read: the county's own page");
  const stored = SL.readServiceLinkCheck(db, loaded().key, COUNTY_PAGE, SERVICE_ROOT);
  assert.equal(stored?.status, "confirmed");
  assert.equal(SL.confirmationHolds(stored, loaded()), true);
});
await check("MUST-PASS: a page linking only the county's own map site confirms it when that site names the service's organisation", async () => {
  reset();
  servedPage = "links-org-site.html";
  linkReads.length = 0;
  const c = await SL.confirmParcelServiceLink(db, loaded());
  assert.equal(c.status, "confirmed", c.detail);
  assert.equal(c.kind, "organisation_site");
  assert.equal(c.organisationId, ORG);
  assert.equal(c.organisationSource, `https://${ORG_SITE}/sharing/rest/portals/self?f=json`);
  assert.deepEqual(linkReads, [COUNTY_PAGE, `https://${ORG_SITE}/sharing/rest/portals/self?f=json`]);
});
await check("refused: the map site belongs to another organisation; another organisation's service; no link; a link hidden in script", async () => {
  for (const [page, siteId, why] of [
    ["links-org-site.html", "AnotherOrg0002", /none is the service's organisation/],
    ["links-other-org.html", ORG, /does not link services9\.arcgis\.com \(organisation SyntheticOrg0001\)/],
    ["no-link.html", ORG, /does not link/],
    ["link-only-in-script.html", ORG, /does not link/],
  ] as Array<[string, string, RegExp]>) {
    reset();
    servedPage = page;
    orgSiteId = siteId;
    const c = await SL.confirmParcelServiceLink(db, loaded());
    assert.equal(c.status, "refused", page);
    assert.match(c.detail, why, `${page}: ${c.detail}`);
    assert.equal(SL.confirmationHolds(SL.readServiceLinkCheck(db, loaded().key, COUNTY_PAGE, SERVICE_ROOT), loaded()), false);
  }
});
await check("a same-host redirect is followed; a redirect off the county's host, or an error, is refused", async () => {
  reset();
  pageRedirect = "/assessor/gis/";
  assert.equal((await SL.confirmParcelServiceLink(db, loaded())).status, "confirmed");
  reset();
  pageRedirect = `https://${ORG_SITE}/home`;
  linkReads.length = 0;
  const off = await SL.confirmParcelServiceLink(db, loaded());
  assert.equal(off.status, "refused");
  assert.match(off.detail, /redirects off www\.examplecounty\.gov/);
  assert.deepEqual(linkReads, [COUNTY_PAGE], "the off-host redirect is never followed");
  reset();
  pageStatus = 404;
  assert.match((await SL.confirmParcelServiceLink(db, loaded())).detail, /HTTP 404/);
});
await check("the door for these reads: an https government page, or exactly an organisation site's portals/self", () => {
  assert.equal(SL.mayFetchForLinkCheck(COUNTY_PAGE, "page"), true);
  assert.equal(SL.mayFetchForLinkCheck(`https://${ORG_SITE}/sharing/rest/portals/self?f=json`, "organisation_site"), true);
  for (const [u, stage] of [
    ["http://www.examplecounty.gov/gis", "page"],
    ["https://www.examplecounty.org/gis", "page"],
    [SERVICE_ROOT, "page"],
    [`${SERVICE_ROOT}/0/query?where=1%3D1&f=json`, "organisation_site"],
    [`https://${ORG_SITE}/sharing/rest/portals/self?f=json&q=x`, "organisation_site"],
    [`https://${ORG_SITE}/sharing/rest/content/items/x?f=json`, "organisation_site"],
    ["https://user:pw@www.examplecounty.gov/gis", "page"],
  ] as Array<[string, "page" | "organisation_site"]>) assert.equal(SL.mayFetchForLinkCheck(u, stage), false, u);
});

// ── (D) + (E): the job ────────────────────────────────────────────────────────────────────────
console.log("\n(D)+(E) the job: confirm first, then ask; the gate names the county page");
PJ.setJurisdictionLookupSourcesForTests([RECORD]);
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
const ADDRESS_WORDS = /1200|example st|farmstead|zebulon|synthetic solar|example power|homeowner|sampleton|83999/i;

await check("MUST-PASS: the job reads the county's page first (nothing of the job in it), then asks the service with the address only", async () => {
  reset();
  linkReads.length = 0;
  asked.length = 0;
  const p = makeProject("1200 North Example Street");
  const res = await runJob(p);
  assert.equal(res.status, "found", JSON.stringify(res));
  assert.deepEqual(linkReads, [COUNTY_PAGE]);
  for (const u of linkReads) assert.doesNotMatch(u, ADDRESS_WORDS, "the confirming read carries nothing of the job");
  assert.equal(asked.length, 1);
  assert.equal(asked[0], TEMPLATE.replace("{street}", encodeURIComponent("1200 N EXAMPLE ST")));
});
await check("a fresh confirmation is reused: the next job does not read the page again", async () => {
  linkReads.length = 0;
  const p = makeProject("1200 North Example Street", { zip: "83998" });
  await runJob(p);
  assert.deepEqual(linkReads, []);
});
await check("MUST-PASS: the gate blocks on the answer (official), naming the county page and read date, never a person", async () => {
  const p = makeProject("77 Farmstead Road");
  assert.equal((await runJob(p)).parcelAgency, "Example County");
  const reading = PJ.readParcelJurisdiction(db, p);
  assert.equal(reading.tier, "official");
  assert.equal(reading.mayBlock, true);
  assert.equal(reading.serviceVerifiedBy, undefined);
  assert.equal(reading.serviceConfirmedFrom?.pageHost, "www.examplecounty.gov");
  const f = byId(gate(p), "reviewer.jurisdiction.parcel");
  assert.equal(f?.severity, "blocker");
  assert.match(f?.message ?? "", /services9\.arcgis\.com, a hosted map the county's own page links, from www\.examplecounty\.gov, read \d{4}-\d{2}-\d{2}; not checked by a person/);
  assert.doesNotMatch(f?.message ?? "", /verified/i);
});
await check("MUST-PASS: a page that does not link the map: the service is never asked, the job is 'not checked' with the reason", async () => {
  reset();
  servedPage = "no-link.html";
  asked.length = 0;
  const p = makeProject("1200 North Example Street", { zip: "83997" });
  const res = await runJob(p);
  assert.equal(res.status, "unavailable");
  assert.match(String(res.detail), /does not confirm its hosted parcel map \(the page does not link/);
  assert.equal(asked.length, 0, "no address went anywhere");
  const f = byId(gate(p), "reviewer.profile.jurisdiction");
  assert.match(f?.message ?? "", /not checked/);
});
await check("a refused read is not repeated within a day", async () => {
  linkReads.length = 0;
  await runJob(makeProject("1200 North Example Street", { zip: "83996" }));
  assert.deepEqual(linkReads, []);
});
await check("MUST-PASS: once the county page stops linking the map, an earlier answer stops standing", async () => {
  reset();
  const p = makeProject("77 Farmstead Road", { zip: "83995" });
  assert.equal((await runJob(p)).status, "found");
  assert.equal(PJ.readParcelJurisdiction(db, p).status, "disagrees");
  servedPage = "no-link.html";
  await new Promise((r) => setTimeout(r, 5));
  await SL.confirmParcelServiceLink(db, loaded());
  const reading = PJ.readParcelJurisdiction(db, p);
  assert.equal(reading.status, "not_checked");
  assert.match(reading.reason, /no longer confirms its hosted parcel map/);
  assert.notEqual(byId(gate(p), "reviewer.jurisdiction.parcel")?.severity, "blocker");
});
await check("MUST-PASS: the door refuses a stale, forged or mismatched confirmation, with no fetch", async () => {
  reset();
  const s = loaded();
  const good = await SL.confirmParcelServiceLink(db, s);
  assert.equal(good.status, "confirmed");
  const withConf = (c: unknown) => ({ ...s, linkConfirmation: c as never });
  const url = PJ.buildQueryUrl(s, ADDRESS);
  assert.equal(PJ.mayAskServiceUrl(withConf(good), url), true, "the real confirmation holds");
  const day = 24 * 3600_000;
  for (const [label, c] of [
    ["31 days old", { ...good, checkedAt: new Date(Date.now() - 31 * day).toISOString() }],
    ["refused", { ...good, status: "refused" }],
    ["another service root", { ...good, serviceRoot: `${SERVICE_ROOT}2` }],
    ["another source page", { ...good, sourceUrl: "https://www.othercounty.gov/gis" }],
    ["read off a government host", { ...good, pageUrl: `https://${ORG_SITE}/home` }],
    ["read on another government host", { ...good, pageUrl: "https://www.othercounty.gov/gis" }],
    ["a link to another organisation", { ...good, linkUrl: `https://${PLATFORM_HOST}/AnotherOrg0002/arcgis/rest/services/X/FeatureServer` }],
    ["an organisation site naming another id", { ...good, kind: "organisation_site", linkUrl: `https://${ORG_SITE}/home`, organisationId: "AnotherOrg0002" }],
    ["no quote", { ...good, quote: "" }],
    ["none", null],
  ] as Array<[string, unknown]>) {
    assert.equal(PJ.mayAskServiceUrl(withConf(c), url), false, label);
  }
  // A person-verified record's confirmation path is not a door into another host or organisation.
  assert.equal(PJ.mayAskServiceUrl(withConf(good), url.replace(ORG, "AnotherOrg0002")), false);
  const before = asked.length;
  const a = await PJ.askParcelService(withConf({ ...good, checkedAt: new Date(Date.now() - 31 * day).toISOString() }), ADDRESS);
  assert.equal(a.status, "unavailable");
  assert.equal(asked.length, before, "nothing was fetched");
});
await check("a stale confirmation makes the next job read the county's page again before asking", async () => {
  reset();
  await SL.confirmParcelServiceLink(db, loaded());
  db.run("UPDATE parcel_service_link_checks SET checked_at = ?", [new Date(Date.now() - 31 * 24 * 3600_000).toISOString()]);
  linkReads.length = 0;
  asked.length = 0;
  const res = await runJob(makeProject("1200 North Example Street", { zip: "83994" }));
  assert.equal(res.status, "found");
  assert.deepEqual(linkReads, [COUNTY_PAGE]);
  assert.equal(asked.length, 1);
});
await check("every request in this file went to the county's page, the organisation site's self-description, or the service", () => {
  for (const u of asked) assert.ok(u.startsWith(`${SERVICE_ROOT}/`), u);
});

SL.setLinkCheckFetchForTests(null);
PJ.setParcelFetchForTests(null);
PJ.setJurisdictionLookupSourcesForTests(null);
console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
