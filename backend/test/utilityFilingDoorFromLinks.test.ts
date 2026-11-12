// THE UTILITY FILING DOOR FROM THE UTILITY'S OWN LINKS, AND "FILED WITH THE CITY PERMIT" AS REAL PAGES
// SAY IT (bot-vs-research comparison, 2026-11-10: two utilities lost their door because their page LINKS
// the form under "Submit an online application" and never names its host in words; two municipal
// utilities lost the with-permit method because their pages say "through the <system> portal" and
// "attachment available on-line w/application").
//
// The model is stubbed; the page reads are a fake transport over invented pages. Every name is invented.
//
// KILL TESTS (each verified red by hand with the change removed):
//   K1 runUtilityFilingLookup without the link step              → (a) fails (no URL).
//   K2 filingFromPageLinks without isApplyLinkWords              → (b) fails (inspection link kept).
//   K3 filingFromPageLinks without acceptFilingUrl on the target → (c), (d) fail.
//   K4 quoteStatesFiledWithPermit without the system-name branch → (g) fails.
//   K5 quoteStatesFiledWithPermit without "w/" → "with"           → (h) fails.
//
// Not read: a filing the door KEPT by name with no URL claimed (an email address, a named office) —
// only a refused filing, or one whose claimed URL was dropped, sends Keelix to read the cited page.
//
// Run: npx tsx backend/test/utilityFilingDoorFromLinks.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "utility-filing-links-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.ANTHROPIC_API_KEY = "test-key-not-used";
process.env.PERMIT_PROCESS_LOOKUP = "off";

const { openDatabase } = await import("../src/db");
const db = await openDatabase();
const ufl = await import("../src/utilityFilingLookup");
const reader = await import("../src/agencyPageReader");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const PAGE = "https://www.example-electric.com/solar/customer-generation";
const TENANT = "https://exampleelectric.powerclerk.com/MvcAccount/Login";
const FORM = "https://tools.example-electric.com/forms/GenerationApplication/Submit";
const CITY_PORTAL = "https://aca-prod.accela.com/MAPLECREST/Default.aspx";
const html = (links: Array<[string, string]>) =>
  `<html><head><title>Customer generation</title></head><body><h1>Customer generation</h1>${links.map(([t, h]) => `<p><a href="${h}">${t}</a></p>`).join("")}</body></html>`;
function site(pages: Record<string, string>) {
  const requests: string[] = [];
  const fetch: import("../src/agencyPageReader").RawFetch = async (url) => {
    requests.push(url);
    const text = pages[url];
    if (text == null) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
    return { ok: true, status: 200, contentType: "text/html", text, bytes: new TextEncoder().encode(text), finalUrl: url, reason: "HTTP 200" };
  };
  return { fetch, requests };
}
const newReader = (pages: Record<string, string>) => { reader._resetPoliteness(); const s = site(pages); return { rd: reader.createPageReader({ fetch: s.fetch, minGapMs: 0, maxReads: 6 }), requests: s.requests }; };
const answer = (filing: Record<string, unknown>) => JSON.stringify({
  filing,
  program: { value: "net_billing", programName: "Net Billing", sourceUrl: PAGE, quote: "Exported energy is credited at the export credit rate." },
  limits: {},
});
const llmWith = (text: string, resultUrls = [PAGE]) => ({ webLookup: async () => ({ text, groundedSearches: 3, stopReason: "end_turn", resultUrls, pagesRead: 0 }) }) as never;
const linkFact = (quote: string, url: string | null, name = "online application") => ({ value: { name, url }, sourceUrl: PAGE, quote });
const readPage = async (pages: Record<string, string>) => newReader(pages).rd.read(PAGE);

await check("(a) the page LINKS the form under 'Submit an online application' → the URL is kept, cited by the link, seeded", async () => {
  const { rd } = newReader({ [PAGE]: html([["Submit an online application", TENANT], ["Net billing rates", "https://www.example-electric.com/rates"]]) });
  const run = await ufl.runUtilityFilingLookup(db, llmWith(answer(linkFact("APPLY: Submit an online application with the proposed system.", TENANT))), { state: "ZZ", utility: "Example Electric A", force: true, reader: rd });
  assert.equal(run.lookup?.confidence, "seeded");
  assert.equal(run.lookup?.filing.value?.url, TENANT);
  assert.match(run.lookup?.filing.quote ?? "", /"Submit an online application" -> https:\/\/exampleelectric\.powerclerk\.com/);
  assert.ok(run.dropped.some((d) => /attested by a link/.test(d)), run.dropped.join(" | "));
});

await check("(a2) the answer named no URL, its words did not name the form, and the page has exactly one application link → that link is the door", async () => {
  const { rd } = newReader({ [PAGE]: html([["Application Form – Solar PV, Wind & Other Projects", FORM], ["Frequently asked questions", "https://www.example-electric.com/faq"]]) });
  const run = await ufl.runUtilityFilingLookup(db, llmWith(answer(linkFact("To connect your system, follow the link below.", null, "Generation Application Portal"))), { state: "ZZ", utility: "Example Electric A2", force: true, reader: rd });
  assert.equal(run.lookup?.filing.value?.url, FORM);
});

await check("(b) an inspection / payment / status link is never the filing door", async () => {
  for (const words of ["Schedule an inspection", "Pay your application fee", "Check application status"]) {
    const page = await readPage({ [PAGE]: html([[words, TENANT]]) });
    const got = ufl.filingFromPageLinks(linkFact("see the link", TENANT), page, [PAGE]);
    assert.equal(got.fact, null, `${words}: ${got.why}`);
  }
  assert.equal(ufl.isApplyLinkWords("Submit an online application"), true);
  assert.equal(ufl.isApplyLinkWords("Schedule an Inspection"), false);
  assert.equal(ufl.isApplyLinkWords("Application status"), false);
});

await check("(c) a city PERMIT portal linked from the page never becomes the NEM door (rule 5)", async () => {
  const page = await readPage({ [PAGE]: html([["Apply for a building permit online", CITY_PORTAL]]) });
  const got = ufl.filingFromPageLinks(linkFact("Apply online", CITY_PORTAL), page, [PAGE]);
  assert.equal(got.fact, null);
});

await check("(d) a document (the application as a PDF) is never the door", async () => {
  const pdf = "https://www.example-electric.com/docs/interconnection-application.pdf";
  const page = await readPage({ [PAGE]: html([["Interconnection application", pdf]]) });
  const got = ufl.filingFromPageLinks(linkFact("Interconnection application", pdf), page, [PAGE]);
  assert.equal(got.fact, null);
});

await check("(e) the answer named a URL that NO link on the page points at → not kept", async () => {
  const page = await readPage({ [PAGE]: html([["Submit an online application", FORM]]) });
  const got = ufl.filingFromPageLinks(linkFact("Submit an online application", TENANT), page, [PAGE]);
  assert.equal(got.fact, null);
  assert.match(got.why, /points at/);
});

await check("(e2) two application links and the answer named none → not kept (no guessing)", async () => {
  const page = await readPage({ [PAGE]: html([["Apply online (residential)", FORM], ["Submit an interconnection request", TENANT]]) });
  assert.equal(ufl.filingFromPageLinks(linkFact("Apply online", null), page, [PAGE]).fact, null);
});

await check("(f) a page the search never returned attests nothing; a with-permit method never takes a URL", async () => {
  const page = await readPage({ [PAGE]: html([["Submit an online application", TENANT]]) });
  assert.equal(ufl.filingFromPageLinks(linkFact("Submit an online application", TENANT), page, ["https://elsewhere.example.com/x"]).fact, null);
  const method = { value: { name: "with the permit", url: null, method: "with_ahj_permit" }, sourceUrl: PAGE, quote: "x" };
  assert.equal(ufl.filingFromPageLinks(method, page, [PAGE]).fact, null);
});

await check("(g) 'submitted on-line through the <system> portal' is with-permit only when <system> is the city's own permit system on file", () => {
  const q = "SOLAR PANEL APPLICATION PACKET ** Applications will be submitted on-line through the Permitbox portal **";
  assert.equal(ufl.quoteStatesFiledWithPermit(q), false);
  assert.equal(ufl.quoteStatesFiledWithPermit(q, ["permitbox"]), true);
  assert.equal(ufl.quoteStatesFiledWithPermit(q, ["otherbox"]), false);
  // A page that keeps the two apart is still refused, whatever the names.
  assert.equal(ufl.quoteStatesFiledWithPermit("Apply through the Permitbox portal; the net metering application is separate from the building permit.", ["permitbox"]), false);
});

await check("(h) the utility's agreement 'attachment available on-line w/application' is with-permit; the old shapes are unchanged", () => {
  assert.equal(ufl.quoteStatesFiledWithPermit("Net meter agreement- signed and notarized (attachment available on-line w/application)"), true);
  assert.equal(ufl.quoteStatesFiledWithPermit("Upload the interconnection agreement with your online application."), true);
  assert.equal(ufl.quoteStatesFiledWithPermit("Submit the application with photos."), false); // no utility document
  assert.equal(ufl.quoteStatesFiledWithPermit("Net metering applications are submitted with your building permit application."), true);
  assert.equal(ufl.quoteStatesFiledWithPermit("Apply for interconnection with Example Power and obtain a building permit."), false);
  assert.equal(ufl.quoteStatesFiledWithPermit("The interconnection application is separate from the building permit."), false);
});

await check("(i) permitSystemNamesFor reads the service city's permit portal host label from the shared rows", () => {
  assert.deepEqual(ufl.permitSystemNamesFor(db, "ZZ", "Maplecrest", ["https://zz.permitbox.example.com/register"]).includes("example"), true);
  assert.deepEqual(ufl.permitSystemNamesFor(db, "ZZ", "Maplecrest", ["https://zz.permitbox.com/register"]), ["permitbox"]);
  assert.deepEqual(ufl.permitSystemNamesFor(db, "ZZ", "", ["https://zz.permitbox.com/register"]), []);
});

await check("(j) end to end: a with-permit answer naming the city's own system lands as the method (seeded), with no URL", async () => {
  const pp = await import("../src/permitProcess");
  const portal = { value: "https://zz.permitbox.com/register", sourceUrl: "https://www.maplecrest.example.gov/building", quote: "All permits are completed through Permitbox, our online portal.", origin: "lookup" as const };
  const none = { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "x" };
  pp.savePermitProcessLookup(db, { state: "ZZ", ahj: "Maplecrest", issuingAgency: none, permitStructure: none,
    permits: [{ discipline: "combo", label: "Building", issuingAgency: none, portalUrl: portal, recordType: none, documents: none, fee: none }], lookedUpAt: new Date().toISOString() } as never);
  const filing = { value: { name: "Permitbox solar permit application", url: null, method: "with_ahj_permit", documents: ["Net metered agreement"] }, sourceUrl: PAGE,
    quote: "Applications will be submitted on-line through the Permitbox portal" };
  const run = await ufl.runUtilityFilingLookup(db, llmWith(answer(filing)), { state: "ZZ", utility: "Maplecrest Light", city: "Maplecrest", force: true, reader: null });
  assert.equal(run.lookup?.filing.value?.method, "with_ahj_permit", JSON.stringify(run.lookup?.filing));
  assert.equal(run.lookup?.filing.value?.url, null);
  assert.equal(run.lookup?.confidence, "seeded");
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nutilityFilingDoorFromLinks: all checks passed");
