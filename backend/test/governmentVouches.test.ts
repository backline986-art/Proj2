// A GOVERNMENT PAGE VOUCHES FOR AN AUTHORITY'S OWN SITE (owner, 2026-11-13, decision card "Decide how a
// city or utility site that is not .gov gets trusted": "A government page vouches").
//
// What these checks pin:
//   A. The five conditions on one page Keelix read (governmentVouches.vouchesOnPage): a government page,
//      read by Keelix, linking a site in the authority's own name, on a domain that carries that name and
//      is not hosting / a platform / government, and only one such site per page.
//   B. A stored vouch is re-checked when read; a re-run keeps an earlier vouch unless it re-read the page.
//   C. The host lists: the vouched host is official for grading a FACT (officialAuthorityHosts,
//      utilityOfficialHosts) and never for a FILING DOOR (person-verified lists, filingDestinationProposals).
//   D. A lookup run records the vouch and the fee it read on the vouched site grades official; with no
//      vouching link the same fee stays seeded; a recorded vouch is not read again.
//
// Names, hosts and pages are invented; every read is a fake transport; no model key.
//
// Kill tests (each mutation → the checks that fail), run by hand on this branch:
//   K1  vouchesOnPage: drop the government-host check on the vouching page        → A2.
//   K2  vouchesOnPage: drop linkNamesAuthority                                      → A3, D2, D5.
//   K3  hostCouldBeAuthorityOwn: drop the hosting / permit-platform refusal        → none: today the
//       name-in-domain test already refuses every such host (a vendor's domain never carries a
//       city's name); kept as a second wall should that test ever widen.
//   K4  hostCouldBeAuthorityOwn (ahj): any host                                     → A4, B1.
//   K5  vouchesOnPage: drop the two-sites rule                                      → A5.
//   K6  vouchHolds: trust a stored vouch without re-checking                        → B1.
//   K7  mergeVouches: keep a prior vouch whose page was re-read                     → B2.
//   K8  officialAuthorityHosts: person-verified only (no vouches)                   → D1, D3, C1.
//   K9  utilityOfficialHosts: person-verified only (no vouches)                     → D4, C2.
//   K10 filingDestinationProposals reads the official union                         → C3.
//   K11 findSiteVouches: read even when the site is already recorded                → D3.
//   K12 hostCouldBeAuthorityOwn (utility): refuse the rule 5 utility list again     → A7.
//   K13 hostCouldBeAuthorityOwn (ahj): drop the utility-list refusal                → A7.

import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectRecord, WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gov-vouches-"));
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
delete process.env.NEM_FEE_ESTIMATE_USD;
delete process.env.FEE_MATCH_BADGE;

const db = await (await import("../src/db")).openDatabase();
const reader = await import("../src/agencyPageReader");
const gv = await import("../src/governmentVouches");
const hostsMod = await import("../src/officialAuthorityHosts");
const ureq = await import("../src/utilityRequirements");
const ppl = await import("../src/permitProcessLookup");
const pp = await import("../src/permitProcess");
const ufl = await import("../src/utilityFilingLookup");
const subFees = await import("../src/submissionFees");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const project = (over: Partial<ProjectRecord>): ProjectRecord => ({
  id: `job-${Math.random().toString(36).slice(2, 8)}`, clientId: "", orgId: "", state: "ZZ", ahj: "", utility: "",
  systemSizeDcKw: 8, systemSizeAcKw: 7.6, homeownerName: "Sample Job", status: "qc_passed",
  parserSnapshot: { systemSizeDcKw: "8", systemSizeAcKw: "7.6", mountType: "Roof", hasBattery: "No" }, ...over,
} as unknown as ProjectRecord);

const AT = "2026-11-13T06:00:00.000Z";
const COUNTY = "https://www.hollowcountyzz.gov/residents/cities-and-towns";
const CITY_SITE = "www.cityofelmcrestzz.org";
const ELMCREST = { kind: "ahj" as const, state: "ZZ", names: ["Elmcrest"] };
const LARCH = { kind: "utility" as const, state: "ZZ", names: ["Larchmont Power"] };
type Link = { href: string; text: string };
const page = (url: string, links: Link[], over: Record<string, unknown> = {}) => ({
  url, finalUrl: url, ok: true, status: 200, kind: "html", reason: "HTTP 200", title: "", text: "", links, ...over,
}) as never;
const cityLink: Link = { href: `https://${CITY_SITE}/`, text: "City of Elmcrest" };

console.log("government page vouches");

// ── A. The five conditions on one page ──────────────────────────────────────────────────────────
await check("(A1) a government page Keelix read, linking the city's .org site in the city's own name, vouches for it with its evidence", () => {
  const v = gv.vouchesOnPage(page(COUNTY, [cityLink, { href: "https://www.hollowcountyzz.gov/parks", text: "Parks" }]), ELMCREST, AT);
  assert.deepEqual(v, [{ host: CITY_SITE, vouchedByUrl: COUNTY, linkText: "City of Elmcrest", fetchedAt: AT }]);
  assert.equal(gv.vouchesOnPage(page(COUNTY, [{ href: `https://${CITY_SITE}/`, text: "City of Elmcrest official website (opens in new window)" }]), ELMCREST, AT).length, 1, "a few words around the name are allowed");
});
await check("(A2) only a page Keelix READ on a GOVERNMENT host vouches: a .org page, a failed read, a PDF, a bad read time give nothing", () => {
  assert.deepEqual(gv.vouchesOnPage(page("https://www.hollowcountyzz.org/cities", [cityLink]), ELMCREST, AT), [], "a non-government page");
  assert.deepEqual(gv.vouchesOnPage(page(COUNTY, [cityLink], { finalUrl: "https://www.hollowcountyzz-mirror.com/cities" }), ELMCREST, AT), [], "a government address that landed on another host");
  assert.deepEqual(gv.vouchesOnPage(page(COUNTY, [cityLink], { ok: false }), ELMCREST, AT), []);
  assert.deepEqual(gv.vouchesOnPage(page(COUNTY, [cityLink], { kind: "pdf" }), ELMCREST, AT), []);
  assert.deepEqual(gv.vouchesOnPage(page(COUNTY, [cityLink]), ELMCREST, "yesterday"), []);
  assert.deepEqual(gv.vouchesOnPage(null, ELMCREST, AT), []);
});
await check("(A3) the link's own words must name THIS authority", () => {
  for (const text of ["Click here", "Elmcrest Chamber of Commerce", "City of Fernvale", "Visit our partners", ""]) {
    assert.deepEqual(gv.vouchesOnPage(page(COUNTY, [{ href: `https://${CITY_SITE}/`, text }]), ELMCREST, AT), [], JSON.stringify(text));
  }
  assert.equal(gv.linkNamesAuthority("Larchmont", LARCH), false, "half a utility's name");
  assert.equal(gv.linkNamesAuthority("Larchmont Power Company", LARCH), true);
});
await check("(A4) the linked site must carry the authority's name and be nobody else's: hosting, maps, permit or interconnection platforms, government, unrelated", () => {
  const refused = [
    "https://elmcrest.wixsite.com/city", "https://elmcrest-zz.maps.arcgis.com/home", "https://aca-prod.accela.com/ELMCREST/",
    "https://elmcrest.powerclerk.com/", "https://www.elmcrestzz.gov/", "https://www.elmcrestrealtyzz.com/", "https://www.facebook.com/cityofelmcrest",
    "https://www.fernvalezz.org/",
  ];
  for (const href of refused) assert.deepEqual(gv.vouchesOnPage(page(COUNTY, [{ href, text: "City of Elmcrest" }]), ELMCREST, AT), [], href);
  assert.equal(gv.hostCouldBeAuthorityOwn("www.larchmontpowerzz.com", LARCH), true);
  assert.equal(gv.hostCouldBeAuthorityOwn("www.larchmontzz.com", LARCH), false, "a domain with half the name");
  assert.equal(gv.hostCouldBeAuthorityOwn("larchmontpower.example.com", LARCH), false, "the name under someone else's domain");
});
await check("(A5) one page naming two different sites as the same authority vouches for neither", () => {
  const two = page(COUNTY, [cityLink, { href: "https://www.elmcrestcityzz.com/", text: "City of Elmcrest" }]);
  assert.deepEqual(gv.vouchesOnPage(two, ELMCREST, AT), []);
  const sameSite = page(COUNTY, [cityLink, { href: `https://${CITY_SITE}/departments`, text: "Elmcrest" }]);
  assert.equal(gv.vouchesOnPage(sameSite, ELMCREST, AT).length, 1, "two links to the same site are one site");
});
await check("(A6) a utility: a state commission page linking the utility in its own name vouches for its .com site", () => {
  const PUC = "https://puc.zz.gov/utilities/electric";
  const v = gv.vouchesOnPage(page(PUC, [{ href: "https://www.larchmontpowerzz.com/", text: "Larchmont Power" }, { href: "https://www.otherutilityzz.com/", text: "Other Utility" }]), LARCH, AT);
  assert.deepEqual(v.map((x) => x.host), ["www.larchmontpowerzz.com"]);
});

await check("(A7) a utility's own domain that the rule 5 utility list holds is still its own; a vendor's domain or a city's vouch onto it is not", async () => {
  const pc = await import("../src/portalChannel");
  const OWN = "www.xcelenergy.com"; // a utility's own domain on portalChannel's utility list (for rule 5)
  assert.equal(pc.isUtilityPlatformUrl(`https://${OWN}/`), true, "fixture: the host is on the utility list");
  const UTIL = { kind: "utility" as const, state: "ZZ", names: ["Xcel Energy"] };
  const PUC = "https://puc.zz.gov/utilities/electric";
  assert.deepEqual(gv.vouchesOnPage(page(PUC, [{ href: `https://${OWN}/`, text: "Xcel Energy" }]), UTIL, AT).map((v) => v.host), [OWN]);
  assert.deepEqual(gv.vouchesOnPage(page(PUC, [{ href: "https://xcelenergy.powerclerk.com/", text: "Xcel Energy" }]), UTIL, AT), [], "an interconnection vendor's tenant");
  assert.equal(gv.hostCouldBeAuthorityOwn(OWN, { kind: "ahj", state: "ZZ", names: ["Xcel Energy"] }), false, "a jurisdiction is never vouched onto a utility's domain");
});

// ── B. A stored vouch is re-checked ─────────────────────────────────────────────────────────────
const good = { host: CITY_SITE, vouchedByUrl: COUNTY, linkText: "City of Elmcrest", fetchedAt: AT };
await check("(B1) a stored vouch counts only while it still passes conditions 2 to 4: an edited row gives nothing", () => {
  assert.deepEqual(gv.vouchedHosts([good], ELMCREST), [CITY_SITE]);
  const tampered = [
    { ...good, vouchedByUrl: "https://www.hollowcountyzz.org/cities" },
    { ...good, linkText: "Click here" },
    { ...good, host: "elmcrest.wixsite.com" },
    { ...good, host: "www.fernvalezz.org" },
    { ...good, fetchedAt: "" },
    "www.cityofelmcrestzz.org", null,
  ];
  for (const t of tampered) assert.deepEqual(gv.vouchedHosts([t], ELMCREST), [], JSON.stringify(t));
  assert.deepEqual(gv.vouchedHosts([good], { ...ELMCREST, names: ["Fernvale"] }), [], "a vouch for another authority");
  assert.deepEqual(gv.vouchedHosts("not a list", ELMCREST), []);
});
await check("(B2) a re-run keeps an earlier vouch unless it read that government page again and the link is gone", () => {
  assert.deepEqual(gv.mergeVouches([good], [], []), [good], "page not read again: kept");
  assert.deepEqual(gv.mergeVouches([good], [], [`${COUNTY}/`]), [], "page read again, no link: dropped");
  const fresh = { ...good, fetchedAt: "2026-11-14T06:00:00.000Z" };
  assert.deepEqual(gv.mergeVouches([good], [fresh], [COUNTY]), [fresh], "read again and still linked: the new read");
  assert.equal(gv.mergeVouches(Array.from({ length: 9 }, (_v, i) => ({ ...good, host: `h${i}.example.org`, vouchedByUrl: `${COUNTY}/${i}` })), [], []).length, 6, "capped");
});

// ── C/D. Lookup runs and the host lists ─────────────────────────────────────────────────────────
const g = (answer: unknown, urls: string[]): WebLookupResult => ({ text: JSON.stringify(answer), groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0 });
type Raw = import("../src/agencyPageReader").RawFetch;
const transport = (pages: Record<string, string>): Raw => async (url) => {
  const body = pages[url] ?? pages[url.replace(/\/$/, "")];
  if (body == null) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
  return { ok: true, status: 200, contentType: "text/html; charset=utf-8", text: body, finalUrl: url, reason: "HTTP 200" };
};
const readerOver = (pages: Record<string, string>) => { reader._resetPoliteness(); return reader.createPageReader({ fetch: transport(pages), minGapMs: 0, maxReads: 12 }); };
const html = (body: string) => `<html><head><title>t</title></head><body><main>${body}</main></body></html>`;
const cite = (value: unknown, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, notFound: "" });
const NONE = { value: null, sourceUrl: "", quote: "", notFound: "no page states it" };
const LABEL = "Residential solar photovoltaic electrical permit";

/** A permit lookup for `ahj` whose own pages sit on `site` (a .org), with a county page among the results. */
async function runPermit(ahj: string, site: string, countyLinks: Link[]) {
  const BUILD = `https://${site}/building/permits`;
  const FEES = `https://${site}/building/fee-table`;
  const AGENCY = `The ${ahj} Building Division issues electrical permits for work inside the city.`;
  const QUOTE = `${LABEL} $94.00`;
  const fee = cite({ amountUsd: 94, basis: "flat residential solar electrical permit", lines: [{ label: LABEL, amountUsd: 94 }] }, FEES, QUOTE);
  const permit = { discipline: "electrical", label: "Electrical permit", issuingAgency: cite(`${ahj} Building Division`, BUILD, AGENCY), portalUrl: NONE, recordType: NONE };
  const a = {
    process: { issuingAgency: cite(`${ahj} Building Division`, BUILD, AGENCY), permitStructure: NONE, prerequisites: [], groundMountZoning: NONE, permits: [permit] },
    portal: { permits: [{ discipline: "electrical", portalUrl: NONE, recordType: NONE }], prerequisites: [] },
    docsFees: { permits: [{ discipline: "electrical", documents: NONE, fee }] },
  };
  const links = countyLinks.map((l) => `<li><a href="${l.href}">${l.text}</a></li>`).join("");
  const r = readerOver({
    [BUILD]: html(`<p>${AGENCY}</p>`),
    [FEES]: html(`<table><tr><td>${LABEL}</td><td>$94.00</td></tr></table>`),
    [COUNTY]: html(`<h1>Cities and towns</h1><ul>${links}</ul>`),
  });
  const run = await ppl.runPermitProcessLookup(db, {
    webLookup: async (q: { label: string }) => g(/\.process$/.test(q.label) ? a.process : /\.portal$/.test(q.label) ? a.portal : /documentsFees$/.test(q.label) ? a.docsFees : {}, [BUILD, FEES, COUNTY]),
  } as never, { state: "ZZ", ahj, force: true, reader: r });
  return { run, reads: r.log.map((l) => l.url) };
}

await check("(D1) a permit lookup records the county page's vouch, and the fee it read on the city's .org site is official on the quote", async () => {
  const { run, reads } = await runPermit("Elmcrest", CITY_SITE, [cityLink]);
  assert.equal(run.lookup?.permits[0].fee.value?.amountUsd, 94, JSON.stringify(run.lookup?.permits[0].fee));
  assert.ok(reads.includes(COUNTY), `the county page was read: ${JSON.stringify(reads)}`);
  const stored = pp.getPermitProcessLookup(db, "ZZ", "Elmcrest");
  assert.deepEqual(stored?.siteVouches?.map((v) => [v.host, v.vouchedByUrl, v.linkText]), [[CITY_SITE, COUNTY, "City of Elmcrest"]]);
  assert.equal(stored?.confidence, "seeded", "the lookup row itself is still nobody's verified row");
  const q = subFees.readPaymentQuote(db, project({ ahj: "Elmcrest" }), "permit");
  assert.equal(q.permitFeeUsd, 94);
  assert.equal(q.permitFeeConfidence, "official", q.permitFeeBasis);
  assert.equal(q.permitFeeOfficialSource?.host, CITY_SITE);
});
await check("(D2) with no vouching link (another city's link, or a link that names nobody) the same fee on the .org site stays seeded", async () => {
  const site = "www.cityoffernvalezz.org";
  await runPermit("Fernvale", site, [{ href: `https://${site}/`, text: "Click here" }, cityLink]);
  assert.equal(pp.getPermitProcessLookup(db, "ZZ", "Fernvale")?.siteVouches, undefined);
  const q = subFees.readPaymentQuote(db, project({ ahj: "Fernvale" }), "permit");
  assert.equal(q.permitFeeUsd, 94);
  assert.equal(q.permitFeeConfidence, "seeded", q.permitFeeBasis);
  assert.equal(q.permitFeeOfficialSource, undefined);
});
await check("(D3) a site already recorded as the city's own is not vouched for again: no extra read, the earlier vouch is kept", async () => {
  const { reads } = await runPermit("Elmcrest", CITY_SITE, [cityLink]);
  assert.equal(reads.includes(COUNTY), false, JSON.stringify(reads));
  assert.deepEqual(pp.getPermitProcessLookup(db, "ZZ", "Elmcrest")?.siteVouches?.map((v) => v.host), [CITY_SITE]);
});
await check("(C1) the vouched host is official for grading a fact, never a person-verified host", () => {
  assert.deepEqual(hostsMod.officialAuthorityHosts(db, "ZZ", "Elmcrest"), [CITY_SITE]);
  assert.deepEqual(hostsMod.personVerifiedAuthorityHosts(db, "ZZ", "Elmcrest"), [], "a vouch is not a person");
  assert.deepEqual(hostsMod.officialAuthorityHosts(db, "ZZ", "Fernvale"), []);
});

// The utility side.
const UP = "https://www.larchmontpowerzz.com";
const APPLY = `${UP}/customer-generation/apply/`;
const PUC = "https://puc.zz.gov/utilities/electric";
const APP_QUOTE = "Net metering interconnection application fee: $100.";
const utilityAnswer = {
  filing: { value: { name: "Customer portal", url: null }, sourceUrl: APPLY, quote: "Apply online in the customer portal." },
  program: { value: "net_billing", programName: "Customer Generation", sourceUrl: APPLY, quote: "Exports are credited at the export credit rate." },
  limits: {}, fees: [{ value: { label: "Net metering interconnection application fee", amountUsd: 100 }, sourceUrl: APPLY, quote: APP_QUOTE }],
};
await check("(D4) a utility lookup records a state commission page's vouch for the utility's .com site, and its fee there is official", async () => {
  const r = readerOver({
    [APPLY]: html(`<p>Apply online in the customer portal.</p><p>${APP_QUOTE}</p>`),
    [PUC]: html(`<h1>Electric utilities</h1><ul><li><a href="${UP}/">Larchmont Power</a></li></ul>`),
  });
  const run = await ufl.runUtilityFilingLookup(db, { webLookup: async () => g(utilityAnswer, [APPLY, PUC]) } as never, { state: "ZZ", utility: "Larchmont Power", force: true, reader: r });
  assert.ok(r.log.some((l) => l.url === PUC), JSON.stringify(r.log.map((l) => l.url)));
  assert.deepEqual(run.lookup?.siteVouches?.map((v) => [v.host, v.vouchedByUrl]), [["www.larchmontpowerzz.com", PUC]]);
  assert.equal(run.feeLanding?.landed?.amountUsd, 100, JSON.stringify(run.feeLanding));
  const q = subFees.readPaymentQuote(db, project({ utility: "Larchmont Power" }), "nem");
  assert.equal(q.permitFeeUsd, 100);
  assert.equal(q.permitFeeConfidence, "official", q.permitFeeBasis);
  assert.equal(q.permitFeeOfficialSource?.host, "www.larchmontpowerzz.com");
});
await check("(D5) the same utility fee with no commission page linking the site stays seeded", async () => {
  const MP = "https://www.mapletonpowerzz.com";
  const MAPPLY = `${MP}/customer-generation/apply/`;
  const answer = JSON.parse(JSON.stringify(utilityAnswer).split(APPLY).join(MAPPLY));
  const r = readerOver({
    [MAPPLY]: html(`<p>Apply online in the customer portal.</p><p>${APP_QUOTE}</p>`),
    [PUC]: html(`<h1>Electric utilities</h1><ul><li><a href="${MP}/">Click here</a></li></ul>`),
  });
  const run = await ufl.runUtilityFilingLookup(db, { webLookup: async () => g(answer, [MAPPLY, PUC]) } as never, { state: "ZZ", utility: "Mapleton Power", force: true, reader: r });
  assert.equal(run.lookup?.siteVouches, undefined);
  assert.equal(run.feeLanding?.landed?.amountUsd, 100, JSON.stringify(run.feeLanding));
  const q = subFees.readPaymentQuote(db, project({ utility: "Mapleton Power" }), "nem");
  assert.equal(q.permitFeeConfidence, "seeded", q.permitFeeBasis);
});
await check("(C2) the utility's vouched host is official for facts, never person-verified", () => {
  assert.deepEqual(ureq.utilityOfficialHosts(db, "ZZ", "Larchmont Power"), ["www.larchmontpowerzz.com"]);
  assert.deepEqual(ureq.utilityPersonVerifiedHosts(db, "ZZ", "Larchmont Power"), []);
});
await check("(C3) a filing door never reads a vouch: filingDestinationProposals takes person-verified hosts only", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/filingDestinationProposals.ts"), "utf8")
    .split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join("\n"); // code, not comments
  assert.doesNotMatch(src, /\b(?:officialAuthorityHosts|utilityOfficialHosts|governmentVouchedAuthorityHosts|vouchedHosts)\s*\(|siteVouches|governmentVouches"/);
  assert.match(src, /personVerifiedAuthorityHosts\(db, authority\.state, authority\.name\)/);
  assert.match(src, /utilityPersonVerifiedHosts\(db, authority\.state, authority\.name\)/);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\ngovernmentVouches: all checks passed");
