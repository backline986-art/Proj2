// THE LOOKUP, ALIGNED WITH WHAT HAND RESEARCH FOUND (bot-vs-research round 2, 2026-11-10). Each
// check is a class of fact the research found and Keelix's own lookup refused or never asked:
//   1. A PDF fee table whose amounts the PDF splits by a glyph gap ("$5 78.00", "TOTAL $1,033 .00").
//   2. A portal link whose words are a call to apply ("Apply for a Permit", "Apply Now", "submit permits").
//   3. A city's site under its state's .gov ("<city>.<state>.gov") is the city's own domain.
//   4. The issuing agency stated by the agency's OWN page without repeating its name.
//   5. "net billing" glued to the word before it by the page's text ("callednet billing").
//   6. A utility page that says some locations are served by ANOTHER utility (a shared service area).
//   7. A utility page the reader was refused is recorded for a person, not silently dropped.
//   8. A net-metering AGREEMENT link is the utility's application link (a co-op's online agreement form).
//   9. A lookup whose answer cites nothing still reads the agency's own result pages, so a site that
//      refuses every read is recorded for a person instead of the lookup silently finding nothing.
//
// Names, hosts and pages are invented; the reads are a fake transport.
//
// KILL TESTS (each verified red by hand with the change removed):
//   K1 joinSplitAmounts returning its input                   → (1) fails.
//   K2 the portal door without APPLY_CALL                     → (2) fails.
//   K3 isAgencyOwnDomain without the state-.gov locality rule  → (3) fails.
//   K4 the agency door back to supportsAgency                 → (4b) fails.
//   K5 "\bnet billing" again                                  → (5) fails.
//   K6 quoteStatesServiceArea always false                    → (6a) fails.
//   K7 the utility lookup without readsNeedingAPerson         → (7) fails.
//   K8 APPLY_LINK_WORDS without the agreement words           → (8) fails.
//   K9 readAgencyEvidence without the nothing-cited fallback  → (9) fails.
//
// Run: npx tsx backend/test/lookupAlignResearch.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lookup-align-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const reader = await import("../src/agencyPageReader");
const cat = await import("../src/permitPlatformCatalog");
const ppl = await import("../src/permitProcessLookup");
const ufl = await import("../src/utilityFilingLookup");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const g = (text: string, urls: string[]): WebLookupResult => ({ text, groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0 });

console.log("lookup aligned with research");

await check("(1) a dollar amount split by a glyph gap inside one PDF cell is one amount; the fee table then ties", () => {
  assert.equal(reader.joinSplitAmounts("**NET Metering  $5 78.00"), "**NET Metering  $578.00");
  assert.equal(reader.joinSplitAmounts("TOTAL  $1,033 .00"), "TOTAL  $1,033.00");
  assert.equal(reader.joinSplitAmounts("$5 per panel, 78.00 kW"), "$5 per panel, 78.00 kW", "words between: not one amount");
  assert.equal(reader.joinSplitAmounts("$5 78"), "$5 78", "no cents: not joined");
  const page = ["*Application Fee  $50.00", "**NET Metering  $5 78.00", "**Building Permit  $300.00", "TOTAL  $1,033 .00"].map(reader.joinSplitAmounts).join("\n");
  const fee2 = { amountUsd: 1033, lines: [{ label: "Application Fee", amountUsd: 50 }, { label: "NET Metering", amountUsd: 578 }, { label: "Building Permit", amountUsd: 300 }, { label: "Plan Check", amountUsd: 105 }] };
  const page2 = page.replace("TOTAL", "**Plan Check  $105.00\nTOTAL");
  assert.equal(ppl.feeTableOnOurPage(fee2 as never, "TOTAL $1,033.00", page2), true);
  const unjoined = ["*Application Fee  $50.00", "**NET Metering  $5 78.00", "**Building Permit  $300.00", "**Plan Check  $105.00", "TOTAL  $1,033 .00"].join("\n");
  assert.equal(ppl.feeTableOnOurPage(fee2 as never, "TOTAL $1,033.00", unjoined), false, "the split page text alone never tied");
});

const CITY = "https://www.maplecrest.example.gov/building";
const PORTAL = "https://maplecrestzz-energovweb.tylerhost.net/apps/SelfService";
await check("(2) a call to apply on the page that links the (attested) portal states the portal; other words do not", () => {
  const take = (quote: string) => ppl.acceptPortal({ value: PORTAL, sourceUrl: CITY, quote } as never, [CITY, PORTAL]).value;
  assert.equal(take("Apply for a Permit"), PORTAL);
  assert.equal(take("Building Permits Apply Now The city regulates construction and provides safeguards."), PORTAL);
  assert.equal(take("Here you will be able to submit permits, request inspections, and monitor your projects."), PORTAL);
  assert.equal(take("Learn about building codes and inspections."), null);
  assert.equal(ppl.acceptPortal({ value: PORTAL, sourceUrl: CITY, quote: "Apply for a Permit" } as never, [CITY]).value, null, "the host must still be attested");
});

await check("(3) a city's site under its state's .gov is the city's own domain — in that state only; a state body's host stays the state's", () => {
  const city = ["City of Maplecrest"];
  assert.equal(cat.isAgencyOwnDomain("maplecrest.oregon.gov", city, "OR"), true);
  assert.equal(cat.isAgencyOwnDomain("permit.maplecrest.oregon.gov", city, "OR"), true);
  assert.equal(cat.isAgencyOwnDomain("maplecrest.oregon.gov", city, "ID"), false, "another state's .gov");
  assert.equal(cat.isAgencyOwnDomain("licensing.oregon.gov", city, "OR"), false);
  assert.equal(cat.isAgencyOwnDomain("oregon.gov", city, "OR"), false, "the state's own host is not the city's");
  assert.equal(cat.isAgencyOwnDomain("oregon.gov", ["State of Oregon"], "OR"), true, "…and still the state's");
});

await check("(4a) the agency's own page states it without repeating the name — only on its own domain, about a permit, naming no one else", () => {
  const t = ppl.agencyStatedOnOwnPage;
  const own = "https://www.cityofmaplecrest.org/media/solar-fee-guide.pdf";
  assert.equal(t("City of Maplecrest", "Note: Trade permits, such as electrical, are obtained separately with a separate fee.", own), true);
  assert.equal(t("City of Maplecrest", "Note: Trade permits, such as electrical, are obtained separately with a separate fee.", "https://www.solarguides.example.com/x"), false, "not its own domain");
  assert.equal(t("City of Maplecrest", "Electrical permits are obtained from the State licensing office.", own), false, "a state body issues it");
  assert.equal(t("City of Maplecrest", "Electrical permits are issued by Larchmont County.", own), false, "another jurisdiction");
  assert.equal(t("City of Maplecrest", "The city regulates construction and provides safeguards.", own), false, "not about a permit");
  assert.equal(t("City of Maplecrest Building Safety Division", "The Building Safety Division utilizes an online permit portal for the submission of permits.", "https://www.cityofmaplecrest.org/building"), true);
  assert.equal(t("City of Maplecrest Fire Marshal", "The Building Safety Division utilizes an online permit portal.", "https://www.cityofmaplecrest.org/building"), false, "a word the host does not carry is missing");
});

await check("(4b) end to end: the part-one door keeps a per-permit agency its own page states", () => {
  const PDF = "https://www.cityofmaplecrest.org/media/solar-fee-guide.pdf";
  const part = ppl.parseProcessPart(JSON.stringify({
    issuingAgency: { value: null }, permitStructure: { value: null },
    permits: [{ discipline: "electrical", label: "Electrical", issuingAgency: { value: "City of Maplecrest", sourceUrl: PDF, quote: "Note: Trade permits, such as electrical, are obtained separately with a separate fee." }, portalUrl: { value: null }, recordType: { value: null } }],
  }), [PDF], "end_turn", [], null, { state: "ZZ", ahj: "Maplecrest" });
  assert.equal(part.permits[0]?.issuingAgency?.value, "City of Maplecrest", JSON.stringify(part.permits[0]?.issuingAgency));
});

const UPAGE = "https://www.maplecrestpower.example.com/solar";
await check("(5) 'net billing' glued to the word before it still states net billing", () => {
  const parsed = ufl.parseUtilityFilingAnswer(JSON.stringify({
    filing: { value: null, notFound: "x" }, limits: {},
    program: { value: "net_billing", programName: "Net Billing", sourceUrl: UPAGE, quote: "Energy use is tracked and billed through a structure callednet billing." },
  }), [UPAGE]);
  assert.equal(parsed.program.value, "net_billing", JSON.stringify(parsed.program));
});

const COOP = "https://www.maplecrestelectric.coop/about/service-area/";
await check("(6a) a shared service area: the words say locations are served by each named utility; the map only when seen", () => {
  const q = "This enables you to see if a location is served by Maplecrest Electric or Larchmont Power, or if it is a location where it may be served by either utility.";
  assert.equal(ufl.quoteStatesServiceArea({ sharedWith: ["Larchmont Power"] }, q), true);
  assert.equal(ufl.quoteStatesServiceArea({ sharedWith: ["Ridgeway Energy"] }, q), false, "another utility");
  assert.equal(ufl.quoteStatesServiceArea({ sharedWith: ["Larchmont Power"] }, "Larchmont Power has a solar program."), false, "not about serving");
  const parse = (mapUrl: string) => ufl.parseUtilityFilingAnswer(JSON.stringify({
    filing: { value: null, notFound: "x" }, program: { value: null }, limits: {},
    serviceArea: { value: { sharedWith: ["Larchmont Power"], mapUrl }, sourceUrl: COOP, quote: q },
  }), [COOP]);
  assert.deepEqual(parse(COOP).serviceArea?.value, { sharedWith: ["Larchmont Power"], mapUrl: COOP });
  assert.deepEqual(parse("https://gis.example.com/map").serviceArea?.value, { sharedWith: ["Larchmont Power"] }, "an unseen map is dropped, the fact kept");
});

await check("(6b+7) end to end: the shared area and a refused page land on the row and on the utility track's line", async () => {
  const q = "This enables you to see if a location is served by Maplecrest Electric or Larchmont Power, or if it is a location where it may be served by either utility.";
  const NM = "https://www.maplecrestelectric.coop/net-metering/";
  const text = JSON.stringify({
    filing: { value: { name: "Small net-metering agreement form", url: "https://forms.maplecrestelectric.coop/agreement" }, sourceUrl: NM, quote: "Small Net-Metering Agreement (for systems of not more than 25 kW)" },
    program: { value: "net_metering", programName: "Net Metering", sourceUrl: NM, quote: "Net metering credits exported energy." }, limits: {},
    serviceArea: { value: { sharedWith: ["Larchmont Power"], mapUrl: COOP }, sourceUrl: COOP, quote: q },
  });
  reader._resetPoliteness();
  const fetch: import("../src/agencyPageReader").RawFetch = async (url) => ({ ok: false, status: 403, contentType: "text/html", finalUrl: url, reason: "HTTP 403 — refused" });
  const run = await ufl.runUtilityFilingLookup(db, { webLookup: async () => g(text, [NM, COOP]) } as never,
    { state: "ZZ", utility: "Maplecrest Electric", force: true, reader: reader.createPageReader({ fetch, minGapMs: 0, maxReads: 4 }) });
  assert.equal(run.lookup?.serviceArea?.value?.sharedWith[0], "Larchmont Power");
  assert.deepEqual(run.lookup?.needsPersonRead?.map((r) => r.url), [NM], JSON.stringify(run.lookup?.needsPersonRead));
  const s = ufl.utilityFeesAndReviewSentence(db, { state: "ZZ", utility: "Maplecrest Electric" });
  assert.match(s, /Check which utility serves the address: Maplecrest Electric's page says some locations are served by Larchmont Power \(https:\/\/www\.maplecrestelectric\.coop\/about\/service-area\/\)/);
  assert.match(s, /Needs a person to read \(the site refused Keelix's read\): https:\/\/www\.maplecrestelectric\.coop\/net-metering\//);
});

await check("(8) a net-metering AGREEMENT link on the utility's page is its application link", () => {
  assert.equal(ufl.isApplyLinkWords("Small Net-Metering Agreement"), true);
  assert.equal(ufl.isApplyLinkWords("Interconnection Agreement"), true);
  assert.equal(ufl.isApplyLinkWords("Net metering FAQ"), false);
  const NM = "https://www.maplecrestelectric.coop/net-metering/";
  const FORM = "https://www.maplecrestelectric.coop/net-metering/small-net-metering-agreement/";
  const got = ufl.filingFromPageLinks(
    { value: { name: "Small Net-Metering Agreement online form", url: FORM }, sourceUrl: NM, quote: "Small Net-Metering Agreement (for systems of not more than 25 kW)" } as never,
    { ok: true, url: NM, finalUrl: NM, links: [{ href: FORM, text: "Small Net-Metering Agreement" }, { href: `${NM}faq/`, text: "Net metering FAQ" }] } as never, [NM]);
  assert.equal(got.fact?.value?.url, FORM, got.why);
});

await check("(9) nothing cited: the search's own results on the agency's named official domain are read, and a refusal is recorded", async () => {
  const CD = "https://www.maplecrestoregon.gov/community-development";
  reader._resetPoliteness();
  const fetch: import("../src/agencyPageReader").RawFetch = async (url) => ({ ok: false, status: 403, contentType: "text/html", finalUrl: url, reason: "HTTP 403 — refused" });
  const empty = JSON.stringify({ issuingAgency: { value: null }, permitStructure: { value: null }, permits: [] });
  const run = await ppl.runPermitProcessLookup(db, { webLookup: async () => g(empty, [CD, "https://www.solarguides.example.com/maplecrest-permits"]) } as never,
    { state: "OR", ahj: "Maplecrest", force: true, reader: reader.createPageReader({ fetch, minGapMs: 0, maxReads: 6 }) });
  assert.deepEqual(run.lookup?.needsPersonRead?.map((r) => r.url), [CD], JSON.stringify({ npr: run.lookup?.needsPersonRead, reason: run.reason }));
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nlookupAlignResearch: all checks passed");
