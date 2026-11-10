// FIVE SMALL DOOR FIXES FOUND BY THE BOT-VS-RESEARCH COMPARISON (lookup-door-fixes, 2026-11-10).
//   1. A named jurisdiction is CAPITALISED: "…Apply Now The city regulates…" is not a place called
//      "Now The City", so a city's own portal is not refused as another jurisdiction's.
//   2. A portal address PRINTED in a page or document we read on the agency's own official domain
//      attests that address (a checklist PDF has no anchors).
//   3. Prerequisites: "must be paid prior to submittal" is a before-filing step; a sentence that only
//      prices something is not; a battery / storage packet's steps are not the PV permit's.
//   4. A printed fee table quoted by its TOTAL row is kept when the page we read prints every line.
//   5. A refused read is not silent: "needs a person to read: <url> (<reason>)" on the row and track.
//
// Pages and names are invented; the page reads are a fake transport.
//
// KILL TESTS (each verified red by hand with the change removed):
//   K1 wordsNameAnotherJurisdiction back to case-insensitive        → (1) fails.
//   K2 readAgencyEvidence without the printed-address scan          → (2b) fails.
//   K3 PREREQ_MARKER without "prior to submittal"                   → (3a) fails.
//   K4 prerequisiteRefusal without the fee-statement refusal        → (3b) fails.
//   K5 pageIsOtherPermitType without the storage-page rule          → (3c) fails.
//   K6 the fee door without feeTableOnOurPage                       → (4a) fails.
//   K7 the lookup without readsNeedingAPerson                       → (5b) fails.
//
// Run: npx tsx backend/test/lookupDoorFixes.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lookup-door-fixes-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const reader = await import("../src/agencyPageReader");
const cat = await import("../src/permitPlatformCatalog");
const ppl = await import("../src/permitProcessLookup");
const pre = await import("../src/permitProcessPrerequisites");
const docs = await import("../src/applicationDocs");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
type Served = { status?: number; contentType?: string; text?: string };
function site(pages: Record<string, Served>) {
  const fetch: import("../src/agencyPageReader").RawFetch = async (url) => {
    const s = pages[url];
    if (!s) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
    const status = s.status ?? 200;
    const ok = status >= 200 && status < 300;
    return { ok, status, contentType: s.contentType ?? "text/html", text: s.text ?? "", bytes: new TextEncoder().encode(s.text ?? ""), finalUrl: url, reason: ok ? `HTTP ${status}` : `HTTP ${status} — refused` };
  };
  return fetch;
}
const newReader = (pages: Record<string, Served>) => { reader._resetPoliteness(); return reader.createPageReader({ fetch: site(pages), minGapMs: 0, maxReads: 12 }); };

const CITY = "https://www.maplecrest.example.gov";
const BUILDING = `${CITY}/building`;
const CHECKLIST = `${CITY}/DocumentCenter/View/12/Solar-Checklist-PDF`;
const PORTAL = "https://maplecrestzz-energovweb.tylerhost.net/apps/SelfService";

console.log("lookup door fixes");

await check("(1) a named jurisdiction is capitalised: 'Apply Now The city regulates' names none; 'City of Larchmont' and 'LARCHMONT COUNTY' still do", () => {
  const own = ["Maplecrest", "City of Maplecrest"];
  assert.equal(cat.wordsNameAnotherJurisdiction("Apply Now The city regulates building and land use", own), false);
  assert.equal(cat.wordsNameAnotherJurisdiction("apply online: the county permit portal", own), false);
  assert.equal(cat.wordsNameAnotherJurisdiction("Submit Plans The city reviews them", own), false);
  assert.equal(cat.wordsNameAnotherJurisdiction("City of Larchmont permits", own), true);
  assert.equal(cat.wordsNameAnotherJurisdiction("city of Larchmont permits", own), true);
  assert.equal(cat.wordsNameAnotherJurisdiction("LARCHMONT COUNTY ONLINE PERMITS", own), true, "an all-caps heading still names one");
  assert.equal(cat.wordsNameAnotherJurisdiction("Larchmont County Online Permits", own), true);
  assert.equal(cat.wordsNameAnotherJurisdiction("Maplecrest County Online Permits", own, ["City of Maplecrest"]), true, "same name, another type");
});

await check("(2a) the door: a printed address on the agency's own page attests the portal; without it the portal is unattested", () => {
  const raw = { value: PORTAL, sourceUrl: CHECKLIST, quote: "Apply online at maplecrestzz-energovweb.tylerhost.net/apps/SelfService" };
  const ctx = { seenUrls: [BUILDING, CHECKLIST], platformPages: [], names: ["Maplecrest"], typeNames: ["Maplecrest"], entity: null };
  assert.equal(ppl.acceptPortalForPermit(raw, "process part", ctx).code, "unattested");
  const dec = ppl.acceptPortalForPermit(raw, "process part", { ...ctx, agencyLinks: [{ page: CHECKLIST, href: "https://maplecrestzz-energovweb.tylerhost.net/apps/SelfService", printed: true }] });
  assert.equal(dec.fact.value, PORTAL, JSON.stringify(dec));
  assert.match(String(dec.attestedBy), /prints it/);
});

await check("(2b) readAgencyEvidence: an address printed in a checklist we read on the agency's domain becomes a printed link; a vanity host or one printed off that domain does not", async () => {
  const rd = newReader({
    [BUILDING]: { text: `<html><head><title>Building</title></head><body><main><h1>Building</h1><p>The City of Maplecrest Building Division issues permits.</p><p><a href="${CHECKLIST}">Solar checklist</a></p></main></body></html>` },
    [CHECKLIST]: { contentType: "text/plain", text: "RESIDENTIAL SOLAR CHECKLIST\nAll permits are applied for online at maplecrestzz-energovweb.tylerhost.net/apps/SelfService\nQuestions: see www.maplecrestpermits.com\nSite plan\nOne-line diagram" },
  });
  const ev = await ppl.readAgencyEvidence(rd, { ahj: "Maplecrest", agencyNames: ["City of Maplecrest"], citedUrls: [BUILDING], agencyCitation: BUILDING, resultUrls: [BUILDING], proposedPortals: [] });
  const printed = ev.agencyLinks.find((l) => l.printed && /tylerhost\.net\/apps\/SelfService/.test(l.href));
  assert.ok(printed, JSON.stringify(ev.agencyLinks));
  assert.equal(printed!.page, CHECKLIST);
  assert.ok(!ev.agencyLinks.some((l) => l.printed && /maplecrestpermits/.test(l.href)), "a vanity host printed in words is read for its redirect, never attested by print");
  const off = await ppl.readAgencyEvidence(newReader({
    [BUILDING]: { text: `<html><body><main><p>The City of Maplecrest Building Division issues permits.</p><p>Our vendor's site is otherbox.example.com/apply</p></main></body></html>` },
  }), { ahj: "Maplecrest", agencyNames: [], citedUrls: ["https://www.vendor-blog.example.com/x"], resultUrls: [], proposedPortals: [] });
  assert.ok(!off.agencyLinks.some((l) => l.printed), "no agency domain was read: nothing printed counts");
});

const SEEN = [CITY + "/solar"];
const prereqOf = (value: string, quote: string, sourceUrl = SEEN[0]) => {
  const text = JSON.stringify({ issuingAgency: { value: null }, permitStructure: { value: null }, permits: [], prerequisites: [{ value, sourceUrl, quote }] });
  return ppl.parseProcessPart(text, SEEN, "end_turn").prerequisites;
};
await check("(3a) 'Must be paid prior to submittal' is a before-filing step (it was dropped)", () => {
  const got = prereqOf("$50 application fee paid to Engineering before submittal", "$50 APPLICATION FEE (Must be paid prior to submittal of Application)");
  assert.equal(got.length, 1);
  assert.equal(pre.prerequisiteRefusal(got[0].value, got[0].sourceUrl, { quote: got[0].quote }), null);
});

await check("(3b) a sentence that only PRICES something is not a step", () => {
  const s = "Any plans submitted for initial review will be subjected to a plan review fee of $100 for the first hour of review.";
  assert.match(String(pre.prerequisiteRefusal(`Approval before the permit: ${s}`, SEEN[0], { kind: "Approval before the permit", quote: s })), /only states a fee/);
  assert.equal(pre.prerequisiteRefusal("Zoning approval is required before applying for the building permit.", SEEN[0]), null, "a real step stays");
});

await check("(3c) a battery / storage packet is another permit's page, even when its path also says solar", () => {
  assert.equal(pre.pageIsOtherPermitType(`${CITY}/DocumentCenter/View/342/Solar-Packet---Battery-System-PDF`), true);
  assert.equal(pre.pageIsOtherPermitType(`${CITY}/residential-energy-storage-systems`), true);
  assert.equal(pre.pageIsOtherPermitType(`${CITY}/DocumentCenter/View/343/Solar-Packet-Net-Meter-PDF`), false);
  assert.equal(pre.pageIsOtherPermitType(`${CITY}/process-improvements`), false, "'process' is not ESS");
  assert.deepEqual(cat.extractPrerequisites({ ok: true, finalUrl: `${CITY}/battery-permits`, text: "Plans approval is required before the permit is issued for any battery system installation here." }), []);
});

const TABLE_PAGE = "SOLAR PERMIT FEES\nApplication Fee $50.00\nNet Metering $578.00\nBuilding Permit for City $300.00\nBuilding Permit for State $3.50\nBuilding Permit for Plan Check $101.50\nTOTAL $1,033.00";
const FEES = `${CITY}/DocumentCenter/View/343/Solar-Packet-PDF`;
const feeAnswer = (lines: Array<[string, number]>, total = 1033) => JSON.stringify({ permits: [{ discipline: "combo", documents: { value: null },
  fee: { value: { amountUsd: total, basis: "solar packet total", lines: lines.map(([label, amountUsd]) => ({ label, amountUsd })) }, sourceUrl: FEES, quote: "TOTAL $1,033.00" } }] });
const LINES: Array<[string, number]> = [["Application Fee", 50], ["Net Metering", 578], ["Building Permit for City", 300], ["Building Permit for State", 3.5], ["Building Permit for Plan Check", 101.5]];
await check("(4a) a fee table quoted by its TOTAL: kept when the page we read prints every line beside its label", () => {
  const pages = new Map([[ppl.pageKey(FEES), TABLE_PAGE]]);
  const fee = ppl.parseDocsFeesPart(feeAnswer(LINES), [FEES], "end_turn", pages).byDiscipline.get("combo")!.fee;
  assert.equal(fee.value?.amountUsd, 1033, JSON.stringify(fee));
});
await check("(4b) …and refused with no page read, or when a line is not on the page, or the total is not theirs", () => {
  assert.equal(ppl.parseDocsFeesPart(feeAnswer(LINES), [FEES], "end_turn", new Map()).byDiscipline.get("combo")!.fee.value, null);
  const pages = new Map([[ppl.pageKey(FEES), TABLE_PAGE]]);
  assert.equal(ppl.parseDocsFeesPart(feeAnswer([...LINES, ["Impact fee", 250]], 1283), [FEES], "end_turn", pages).byDiscipline.get("combo")!.fee.value, null);
  assert.equal(ppl.parseDocsFeesPart(feeAnswer(LINES, 1500), [FEES], "end_turn", pages).byDiscipline.get("combo")!.fee.value, null);
});

await check("(5a) readsNeedingAPerson: refusals, challenges and back-offs — never a 404, a spent budget or a sign-in page", () => {
  const got = ppl.readsNeedingAPerson([
    { url: `${CITY}/a`, ok: false, reason: "HTTP 403 — refused" },
    { url: `${CITY}/b`, ok: false, reason: "a bot challenge page (Cloudflare) — not read" },
    { url: `${CITY}/c`, ok: false, reason: "www.maplecrest.example.gov refused an earlier read (HTTP 403) — backed off, not asked again" },
    { url: `${CITY}/d`, ok: false, reason: "HTTP 404" },
    { url: `${CITY}/e`, ok: false, reason: "the lookup's page-read budget is spent" },
    { url: `${CITY}/f`, ok: false, reason: "a sign-in / registration page — never read" },
    { url: `${CITY}/a`, ok: false, reason: "HTTP 403 — refused" },
    { url: `${CITY}/g`, ok: true, reason: "HTTP 200" },
  ]);
  assert.deepEqual(got.map((g) => g.url.slice(-1)), ["a", "b", "c"]);
});

const g = (text: string, urls: string[]): WebLookupResult => ({ text, groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0 });
await check("(5b) end to end: a refused agency page is on the row, in its notes and on the track's permit-structure line", async () => {
  const process1 = JSON.stringify({
    issuingAgency: { value: "City of Larchmont", sourceUrl: `https://www.larchmont.example.gov/building`, quote: "The City of Larchmont issues building permits." },
    permitStructure: { value: "combo", sourceUrl: `https://www.larchmont.example.gov/building`, quote: "One permit covers the structural and electrical work (a combined permit)." },
    permits: [{ discipline: "combo", label: "Solar", portalUrl: { value: null }, recordType: { value: null } }],
  });
  reader._resetPoliteness();
  const pages = { "https://www.larchmont.example.gov/building": { status: 403 } as Served };
  const run = await ppl.runPermitProcessLookup(db, { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? g(process1, ["https://www.larchmont.example.gov/building"]) : g(JSON.stringify({ permits: [] }), [])) } as never,
    { state: "ZZ", ahj: "Larchmont", force: true, reader: reader.createPageReader({ fetch: site(pages), minGapMs: 0, maxReads: 6 }) });
  assert.deepEqual(run.lookup?.needsPersonRead?.map((r) => r.url), ["https://www.larchmont.example.gov/building"], JSON.stringify(run.lookup?.pagesRead));
  assert.ok(run.lookup?.notes?.some((n) => /^Needs a person to read: https:\/\/www\.larchmont\.example\.gov\/building \(HTTP 403/.test(n)));
  const a = docs.permitStructureAnswer({ state: "ZZ", ahj: "Larchmont" } as never);
  assert.match(docs.permitStructureSentence(a), /Needs a person to read \(the site refused Keelix's read\): https:\/\/www\.larchmont\.example\.gov\/building/);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nlookupDoorFixes: all checks passed");
