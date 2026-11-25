// KEELIX FINDS FEES ITSELF (fee round on saved pages, 2026-11-11; Proj2 #150 folded in).
//
// A fee that will be charged to a client up front must be accurate, carry its tier, its source
// quote and the date it was read, and never read as person-verified while it is seeded. Each check
// below is a miss the fee round measured on saved pages, or a rule the new landing must keep:
//
//   1. The page reader dropped every text line over 600 characters, so a fee printed inside one long
//      paragraph was "not on the page" as Keelix read it.
//   2. A fee schedule linked as "CLICK HERE" / "PDF" was never read: only the link's words named it.
//   3. A utility's cited application fee sat on the utility card and never reached the fee schedule
//      (the fee quote read "unknown"). It now lands through saveFeeSchedule: seeded, the page re-read,
//      one application fee only, never over a person's row, never from a third party's page.
//   4. A fee stated as a formula on the job's cost ("$60 plus 2% of total wiring cost") was kept and
//      landed as a flat $60 (#150). It is not a number any more: a person prices it.
//   5. A refused, dated or unreadable fee page was silent on the fee quote. The quote now names the
//      page a person reads; it never guesses.
//   6. A stored fee carries the date its source was read; the quote and the invoice's pass-through
//      line show it, and say "seeded" until a person confirms.
//
// Names, hosts and pages are invented; every read is a fake transport; no model key.
//
// KILL TESTS (each run with the change removed and seen red, 2026-11-11):
//   K1  parseHtml back to dropping every line over 600 characters            → (1) fails.
//   K2  a fee schedule named by its link's words only                        → (2a), (2b) fail.
//   K3  runUtilityFilingLookup without the fee landing                       → (3b) to (3g) fail.
//   K4  utilityFeeKind answering "application" for every fee                 → (3a), (3b), (3d), (3e), (3g) fail.
//   K5  the landing without the quote-on-page check                          → (3c) fails.
//   K6  the landing without "a person's row at the same amount writes nothing" → (3d) fails.
//   K7  formulaFeeNotANumber returning its input, the formula check off in applyLookupFees → (4) fails.
//   K8  feeReadsSentence returning ""                                        → (3c), (4), (5a) fail.
//   K9  saveFeeSchedule not stamping the read date                           → (3b), (6a) fail.
//   K10 fee research without the utility-lookup skip                         → (3g) fails.
//
// Run: npx tsx backend/test/keelixFindsFees.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord, WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keelix-finds-fees-"));
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

const db = await (await import("../src/db")).openDatabase();
const reader = await import("../src/agencyPageReader");
const cat = await import("../src/permitPlatformCatalog");
const ppl = await import("../src/permitProcessLookup");
const ufl = await import("../src/utilityFilingLookup");
const landing = await import("../src/utilityFeeLanding");
const fees = await import("../src/feeSchedules");
const subFees = await import("../src/submissionFees");
const needs = await import("../src/feeNeedsPerson");
const invoices = await import("../src/invoices");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const g = (answer: unknown, urls: string[]): WebLookupResult => ({ text: JSON.stringify(answer), groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0 });
type Raw = import("../src/agencyPageReader").RawFetch;
/** A fake transport over a map of pages; anything else is a 404; `refuse` hosts answer 403. */
const transport = (pages: Record<string, string>, refuse: string[] = []): Raw => async (url) => {
  if (refuse.some((h) => url.includes(h))) return { ok: false, status: 403, contentType: "text/html", finalUrl: url, reason: "HTTP 403 — refused" };
  const body = pages[url] ?? pages[url.replace(/\/$/, "")];
  if (body == null) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
  return { ok: true, status: 200, contentType: "text/html; charset=utf-8", text: body, finalUrl: url, reason: "HTTP 200" };
};
const readerOver = (pages: Record<string, string>, refuse: string[] = []) => { reader._resetPoliteness(); return reader.createPageReader({ fetch: transport(pages, refuse), minGapMs: 0, maxReads: 12 }); };
const html = (body: string) => `<html><head><title>t</title></head><body><main>${body}</main></body></html>`;
const project = (over: Partial<ProjectRecord>): ProjectRecord => ({
  id: `job-${Math.random().toString(36).slice(2, 8)}`, clientId: "", orgId: "", state: "ZZ", ahj: "", utility: "",
  systemSizeDcKw: 8, systemSizeAcKw: 7.6, homeownerName: "Sample Job", status: "qc_passed",
  parserSnapshot: { systemSizeDcKw: "8", systemSizeAcKw: "7.6", mountType: "Roof", hasBattery: "No" }, ...over,
} as unknown as ProjectRecord);
const nemRow = (state: string, utility: string) => fees.getFeeSchedule(db, fees.feeScheduleProfileKey({ state, utility }, "nem"), "nem", "");

console.log("keelix finds fees");

// ── 1. The page reader keeps a long paragraph ───────────────────────────────────────────────────
await check("(1) a fee printed inside one long paragraph is still on the page; a long line with no sentence is still dropped", () => {
  const filler = "Customers who generate their own power stay connected to the grid and are billed under the schedule that applies to their service. ".repeat(4);
  const para = `${filler}Submit a customer generation application with the non-refundable $100 application fee. ${filler}`;
  assert.ok(para.length > 900, "the paragraph is well over the old 600-character limit");
  const menu = Array.from({ length: 140 }, (_v, i) => `Menu${i}`).join(" ");
  const page = reader.parseHtml(html(`<p>${para}</p><div>${menu}</div><p>Short line.</p>`), "https://www.larchmontpower.example.com/apply");
  assert.equal(reader.quoteOnPage("Submit a customer generation application with the non-refundable $100 application fee.", page.text), true, "the fee sentence is read");
  assert.equal(page.text.includes("Menu77"), false, "a long run of words with no sentence is furniture, dropped as before");
  assert.ok(page.text.split("\n").every((l) => l.length <= 600), "every kept line is within the limit");
  assert.ok(page.text.includes("Short line."));
});

// ── 2. A fee schedule named by its own file name ────────────────────────────────────────────────
await check("(2a) a fee schedule linked as CLICK HERE is named by the document's own file name", () => {
  assert.equal(cat.classifyDocument("CLICK HERE", "https://www.maplecrest.gov/DocumentCenter/View/412/Building-Permit-Fee-Schedule"), "fees");
  assert.equal(cat.classifyDocument("PDF", "https://www.maplecrest.gov/files/master-fee-schedule.pdf"), "fees");
  assert.equal(cat.classifyDocument("Read more", "https://www.maplecrest.gov/departments/permit-fees"), null, "a page path is navigation, not a document's name");
  assert.equal(cat.classifyDocument("CLICK HERE", "https://www.maplecrest.gov/DocumentCenter/View/9/Sign-Permit-Fee-Schedule"), null, "another permit kind's schedule");
});
await check("(2b) a dated schedule is still not read as the job's, and is listed for a person; another office's is not", () => {
  const dated = "https://www.maplecrest.gov/DocumentCenter/View/618/23-01-Fee-Schedule-Update-Approved-1-24-2023-Building";
  assert.equal(cat.classifyDocument("CLICK HERE", dated, ), null, "a prior-year schedule is never the job's fee source");
  const page = { ok: true, kind: "html", url: "https://www.maplecrest.gov/building", finalUrl: "https://www.maplecrest.gov/building", status: 200, reason: "HTTP 200", title: "", text: "",
    links: [{ href: dated, text: "CLICK HERE" }, { href: "https://www.maplecrest.gov/DocumentCenter/View/70/Clerks-Fee-Schedule-2023", text: "Clerk fees" },
      { href: "https://www.maplecrest.gov/DocumentCenter/View/71/Building-Permit-Fee-Schedule", text: "Fee schedule" }] };
  const leads = cat.datedFeeScheduleLinks([page as never], ["Maplecrest"], "ZZ", 2026);
  assert.deepEqual(leads.map((l) => l.url), [dated], JSON.stringify(leads));
  assert.match(leads[0].reason, /prior-year schedule \(2023\).*does not rely on it/);
});

// ── 3. The utility's application fee lands in the fee schedule ──────────────────────────────────
const UP = "https://www.larchmontpower.example.com";
const APPLY = `${UP}/customer-generation/apply/`;
const FAQ = `${UP}/customer-generation/faq/`;
const APP_QUOTE = "Submit a customer generation application with the non-refundable $100 application fee.";
const TRIP_QUOTE = "A return trip charge of $52 may be billed each time our personnel are dispatched to the site but are unable to conduct the inspection.";
const MOD_QUOTE = "Customers planning modifications must complete a new application, $100 fee and system verification form.";
const XFER_QUOTE = "The transfer fee is $10 per transfer and will be applied to your service agreement.";
const utilityPages = { [APPLY]: html(`<p>Apply online in the customer portal.</p><p>${APP_QUOTE}</p>`), [FAQ]: html(`<p>${TRIP_QUOTE}</p><p>${MOD_QUOTE}</p><p>${XFER_QUOTE}</p>`) };
const utilityAnswer = (feeList: unknown[], extra: Record<string, unknown> = {}) => ({
  filing: { value: { name: "Customer portal", url: null }, sourceUrl: APPLY, quote: "Apply online in the customer portal." },
  program: { value: "net_billing", programName: "Customer Generation", sourceUrl: APPLY, quote: "Exports are credited at the export credit rate." },
  limits: {}, fees: feeList, ...extra,
});
const FEE_APP = { value: { label: "Non-refundable application fee", amountUsd: 100 }, sourceUrl: APPLY, quote: APP_QUOTE };
const FEE_TRIP = { value: { label: "Return trip charge", amountUsd: 52 }, sourceUrl: FAQ, quote: TRIP_QUOTE };
const FEE_MOD = { value: { label: "System modification application fee", amountUsd: 100 }, sourceUrl: FAQ, quote: MOD_QUOTE };
const FEE_XFER = { value: { label: "Transfer fee", amountUsd: 10 }, sourceUrl: FAQ, quote: XFER_QUOTE };
const runUtility = (utility: string, feeList: unknown[], pages: Record<string, string> = utilityPages, refuse: string[] = []) =>
  ufl.runUtilityFilingLookup(db, { webLookup: async () => g(utilityAnswer(feeList), [APPLY, FAQ]) } as never, { state: "ZZ", utility, force: true, reader: readerOver(pages, refuse) });

await check("(3a) which fee every application owes: a trip, a modification, a transfer are charges for some cases; a size band is a person's read", () => {
  assert.equal(landing.utilityFeeKind(FEE_APP.value, APP_QUOTE), "application");
  assert.equal(landing.utilityFeeKind(FEE_TRIP.value, TRIP_QUOTE), "conditional");
  assert.equal(landing.utilityFeeKind(FEE_MOD.value, MOD_QUOTE), "conditional", "a modification's application fee is not the application fee");
  assert.equal(landing.utilityFeeKind(FEE_XFER.value, XFER_QUOTE), "conditional");
  assert.equal(landing.utilityFeeKind({ label: "Application fee", amountUsd: 500 }, "Systems over 25 kW: $500 application fee."), "banded");
  assert.equal(landing.utilityFeeKind({ label: "Level 2 application fee", amountUsd: 250 }, "Level 2 application fee: $250"), "banded");
  assert.equal(landing.utilityFeeKind({ label: "Engineering charge", amountUsd: 75 }, "Engineering charge: $75"), "unclear");
  assert.equal(landing.utilityFeeKind({ label: "Net metering application fee", amountUsd: 50 }, "Net metering application fee: $50. A reinspection costs $40."), "application", "another sentence's condition is not this fee's");
});

await check("(3b) one store: the cited application fee lands seeded with its quote, source and read date, and the quote shows them", async () => {
  const before = Date.now();
  const run = await runUtility("Larchmont Power", [FEE_APP, FEE_TRIP, FEE_MOD, FEE_XFER]);
  assert.equal(run.feeLanding?.landed?.amountUsd, 100, JSON.stringify(run.feeLanding));
  assert.deepEqual(run.feeLanding?.held, [], "charges owed in some cases only are not held and never landed");
  const row = nemRow("ZZ", "Larchmont Power")!;
  assert.equal(row.confidence, "seeded", "a lookup's fee is seeded (rule 3)");
  assert.deepEqual(row.brackets.map((b) => [b.feeUsd, b.label]), [[100, "Non-refundable application fee"]]);
  assert.equal(row.sourceUrl, APPLY);
  assert.equal(row.sourceQuote, APP_QUOTE);
  assert.ok(Date.parse(row.sources[0].fetchedAt ?? "") >= before - 1000, `the source carries the read date: ${JSON.stringify(row.sources)}`);
  const q = subFees.readPaymentQuote(db, project({ utility: "Larchmont Power" }), "nem");
  assert.equal(q.permitFeeUsd, 100);
  assert.equal(q.permitFeeSource, "published_schedule");
  assert.equal(q.permitFeeConfidence, "seeded");
  assert.equal(q.permitFeeSourceReadAt, row.sources[0].fetchedAt);
  assert.match(q.permitFeeBasis, /not yet human-verified/);
  assert.match(q.permitFeeBasis, /Published as: "Submit a customer generation application with the non-refundable \$100 application fee\."/);
  assert.match(q.permitFeeBasis, new RegExp(`${APPLY.replace(/[/.]/g, "\\$&")} Source read ${new Date().toISOString().slice(0, 4)}-\\d\\d-\\d\\d\\.`));
  assert.doesNotMatch(q.permitFeeBasis.replace(/not yet human-verified/g, ""), /verified/i, "a seeded fee is never worded as verified");
  // The card still shows every printed fee, as before.
  assert.match(ufl.utilityFeesAndReviewSentence(db, { state: "ZZ", utility: "Larchmont Power" }), /Return trip charge \$52/);
});

await check("(3c) a fee whose page Keelix cannot re-read, or whose quote is not on it, lands nothing and is held for a person", async () => {
  const refused = await runUtility("Ridgeway Energy", [FEE_APP], utilityPages, ["larchmontpower.example.com"]);
  assert.equal(refused.feeLanding?.landed, null);
  assert.equal(nemRow("ZZ", "Ridgeway Energy"), null, "nothing lands off a page that was not read");
  assert.match(refused.lookup?.feesHeld?.[0]?.reason ?? "", /could not read the page/);
  assert.ok(refused.lookup?.needsPersonRead?.some((r) => r.url === APPLY), "the refusal is listed for a person");
  const q = subFees.readPaymentQuote(db, project({ utility: "Ridgeway Energy" }), "nem");
  assert.equal(q.permitFeeUsd, null, "unknown, never a guess");
  assert.match(q.permitFeeBasis, /Needs a person to read before this fee is relied on: https:\/\/www\.larchmontpower\.example\.com\/customer-generation\/apply\//);
  assert.ok(q.feeNeedsPersonRead?.length);
  // The page reads, but does not print the quoted words.
  const off = await runUtility("Alderbrook Electric", [FEE_APP], { ...utilityPages, [APPLY]: html("<p>Apply online in the customer portal.</p><p>There is an application fee.</p>") });
  assert.equal(off.feeLanding?.landed, null);
  assert.equal(nemRow("ZZ", "Alderbrook Electric"), null);
  assert.match(off.lookup?.feesHeld?.[0]?.reason ?? "", /not on the page as Keelix read it/);
});

await check("(3d) rule 3: a person-verified fee is never changed; the same amount writes nothing, a different one is held and noted", async () => {
  const key = fees.feeScheduleProfileKey({ state: "ZZ", utility: "Larchmont Power" }, "nem");
  fees.markFeeScheduleVerified(db, key, "nem", "Pat Example");
  const verified = nemRow("ZZ", "Larchmont Power")!;
  assert.equal(verified.confidence, "verified");
  const same = await runUtility("Larchmont Power", [FEE_APP]);
  assert.equal(same.feeLanding?.landed, null);
  assert.deepEqual(same.feeLanding?.held, []);
  assert.equal(nemRow("ZZ", "Larchmont Power")!.updatedAt, verified.updatedAt, "the same amount writes nothing at all");
  const NEW_QUOTE = "Submit a customer generation application with the non-refundable $125 application fee.";
  const diff = await ufl.runUtilityFilingLookup(db, { webLookup: async () => g(utilityAnswer([{ value: { label: "Non-refundable application fee", amountUsd: 125 }, sourceUrl: APPLY, quote: NEW_QUOTE }]), [APPLY, FAQ]) } as never,
    { state: "ZZ", utility: "Larchmont Power", force: true, reader: readerOver({ ...utilityPages, [APPLY]: html(`<p>Apply online in the customer portal.</p><p>${NEW_QUOTE}</p>`) }) });
  // A person verified the fee row, not the lookup row, so the lookup re-runs; the fee row stands.
  const after = nemRow("ZZ", "Larchmont Power")!;
  assert.equal(after.confidence, "verified");
  assert.deepEqual(after.brackets.map((b) => b.feeUsd), [100], "the person's amount stands");
  assert.match(after.notes, /NOT applied — row is human-verified/, "the differing read is recorded for the person");
  assert.match(diff.lookup?.feesHeld?.[0]?.reason ?? "", /differs from the fee a person verified \(\$100\)/, JSON.stringify(diff.feeLanding));
});

await check("(3e) two application fees, a fee by size, or a fee Keelix cannot classify: none lands, a person reads", async () => {
  const L1 = { value: { label: "Level 1 application fee", amountUsd: 50 }, sourceUrl: APPLY, quote: "Level 1 application fee: $50" };
  const L2 = { value: { label: "Level 2 application fee", amountUsd: 250 }, sourceUrl: APPLY, quote: "Level 2 application fee: $250" };
  const pages = { ...utilityPages, [APPLY]: html("<p>Apply online in the customer portal.</p><p>Level 1 application fee: $50</p><p>Level 2 application fee: $250</p>") };
  const run = await runUtility("Briarwood Light", [L1, L2], pages);
  assert.equal(run.feeLanding?.landed, null);
  assert.equal(nemRow("ZZ", "Briarwood Light"), null);
  assert.equal(run.lookup?.feesHeld?.length, 2);
  assert.match(run.lookup?.feesHeld?.[0]?.reason ?? "", /size or application level/);
  const unclear = await runUtility("Cedarfield Power", [FEE_APP, { value: { label: "Engineering charge", amountUsd: 75 }, sourceUrl: APPLY, quote: "Engineering charge: $75" }],
    { ...utilityPages, [APPLY]: html(`<p>Apply online in the customer portal.</p><p>${APP_QUOTE}</p><p>Engineering charge: $75</p>`) });
  assert.equal(unclear.feeLanding?.landed, null, "an application fee beside a charge of unknown kind may be an under-count");
  assert.equal(nemRow("ZZ", "Cedarfield Power"), null);
});

await check("(3f) a third party's page about the utility's fee never lands; a researched row from another document is not replaced", async () => {
  const BLOG = "https://www.solarguides.example.org/larchmont-fees";
  const answer = utilityAnswer([{ ...FEE_APP, sourceUrl: BLOG }]);
  const run = await ufl.runUtilityFilingLookup(db, { webLookup: async () => g(answer, [APPLY, BLOG]) } as never,
    { state: "ZZ", utility: "Dunmore Electric", force: true, reader: readerOver({ ...utilityPages, [BLOG]: html(`<p>${APP_QUOTE}</p>`) }) });
  assert.equal(run.feeLanding?.landed, null);
  assert.equal(nemRow("ZZ", "Dunmore Electric"), null);
  assert.match(run.lookup?.feesHeld?.[0]?.reason ?? "", /not the utility's own site/);
  // Fee research saved a tariff with a different amount first: the lookup's single line does not replace it.
  const TARIFF = `${UP}/tariffs/schedule-84.pdf`;
  fees.saveFeeSchedule(db, { state: "ZZ", utility: "Elmhurst Power", track: "nem" }, { found: true, reason: "", basis: "flat", brackets: [{ feeUsd: 150, label: "Interconnection application fee" }],
    notes: "", sourceUrl: TARIFF, sourceQuote: "Interconnection application fee $150", sourceKind: "official" } as never);
  const kept = await runUtility("Elmhurst Power", [FEE_APP]);
  assert.equal(kept.feeLanding?.landed, null);
  assert.deepEqual(nemRow("ZZ", "Elmhurst Power")!.brackets.map((b) => b.feeUsd), [150]);
  assert.match(kept.lookup?.feesHeld?.[0]?.reason ?? "", /differs from the researched fee on file \(\$150/);
});

await check("(3g) fee research does not pay to find a fee the utility lookup already landed", async () => {
  await runUtility("Foxglove Electric", [FEE_APP, FEE_TRIP]);
  assert.equal(nemRow("ZZ", "Foxglove Electric")?.sourceKind, landing.UTILITY_LOOKUP_FEE_KIND);
  let called = 0;
  const outcome = await fees.researchFeeSchedule(db, { state: "ZZ", utility: "Foxglove Electric", track: "nem" }, { researcher: async () => { called++; throw new Error("research must not run"); } });
  assert.equal(called, 0);
  assert.equal(outcome.skipped, "lookup_fee_landed");
  assert.match(outcome.reason ?? "", /utility lookup already landed a cited application fee/);
  // A utility with no landed fee is researched as before.
  await fees.researchFeeSchedule(db, { state: "ZZ", utility: "Gorsewood Power", track: "nem" }, { researcher: async () => { called++; return { found: false, reason: "nothing", basis: "other", brackets: [], notes: "", sourceUrl: "", sourceQuote: "", sourceKind: "" }; } });
  assert.equal(called, 1);
});

// ── 4. A formula is not an amount (#150) ────────────────────────────────────────────────────────
const SITE = "https://www.hollowayzz.gov";
const BUILD = `${SITE}/building/permits`;
const RULE = `${SITE}/rules/electrical-fees`;
const cite = (value: unknown, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, notFound: "" });
const NONE = { value: null, sourceUrl: "", quote: "", notFound: "no page states it" };
const AGENCY_QUOTE = "The Holloway Building Division issues electrical permits for work inside the city.";
const permitAnswers = (fee: unknown, feeUrls: string[] = [], build = BUILD) => {
  const permit = { discipline: "electrical", label: "Electrical permit", issuingAgency: cite("Holloway Building Division", build, AGENCY_QUOTE), portalUrl: NONE, recordType: NONE };
  return {
    process: { issuingAgency: cite("Holloway Building Division", build, AGENCY_QUOTE), permitStructure: NONE, prerequisites: [], groundMountZoning: NONE, permits: [permit] },
    portal: { permits: [{ discipline: "electrical", portalUrl: NONE, recordType: NONE }], prerequisites: [] },
    docsFees: { permits: [{ discipline: "electrical", documents: NONE, fee }] },
    urls: [build, ...feeUrls],
  };
};
/** Every stored permit fee row cited to this source, whichever authority's key it sits under. */
const rowsCitedTo = (sourceUrl: string) => db.query<{ id: string }>("SELECT id FROM fee_schedules WHERE track = 'permit' AND source_url = ?", [sourceUrl]).map((r) => fees.getFeeScheduleById(db, r.id)!);
const anyPermitBrackets = () => db.query<{ brackets_json: string; source_url: string }>("SELECT brackets_json, source_url FROM fee_schedules WHERE track = 'permit' AND state = 'ZZ'").filter((r) => JSON.parse(r.brackets_json || "[]").length > 0);
const runPermit = (ahj: string, a: ReturnType<typeof permitAnswers>, pages: Record<string, string>, refuse: string[] = []) =>
  ppl.runPermitProcessLookup(db, { webLookup: async (q: { label: string }) => g(/\.process$/.test(q.label) ? a.process : /\.portal$/.test(q.label) ? a.portal : /documentsFees$/.test(q.label) ? a.docsFees : {}, a.urls) } as never,
    { state: "ZZ", ahj, force: true, reader: readerOver(pages, refuse) });
const permitRows = (ahj: string) => fees.getFeeSchedulesForKey(db, fees.feeScheduleProfileKey({ state: "ZZ", ahj }, "permit"), "permit");

await check("(4) a fee that is a base plus a share of job cost is never kept or landed as its base; a person prices it", async () => {
  const FORMULA = "Wiring cost not exceeding ten thousand dollars ($10,000): sixty dollars ($60) plus two percent (2%) of total wiring cost.";
  assert.equal(fees.bracketDescribesPercentOfCost(FORMULA), true);
  assert.equal(fees.bracketDescribesPercentOfCost("two hundred sixty dollars ($260) plus one percent (1%) of wiring cost in excess of ten thousand dollars ($10,000)"), true);
  assert.equal(fees.bracketDescribesPercentOfCost("Permit fee is 1.5% of the contract price, minimum $200"), true);
  assert.equal(fees.bracketDescribesPercentOfCost("Solar permit $150 plus a 12% state surcharge of the permit fee"), false, "a surcharge on the permit fee is a share of a known amount");
  assert.equal(fees.bracketDescribesPercentOfCost("Residential solar permit: $165 flat"), false);
  const fee = cite({ amountUsd: 60, basis: "wiring cost not exceeding $10,000: $60 plus 2% of total wiring cost", lines: [{ label: "Wiring cost not exceeding ten thousand dollars ($10,000)", amountUsd: 60 }] }, RULE, FORMULA);
  const pages = { [BUILD]: html(`<p>${AGENCY_QUOTE}</p>`), [RULE]: html(`<p>${FORMULA}</p>`) };
  const run = await runPermit("Holloway", permitAnswers(fee, [RULE]), pages);
  const kept = run.lookup?.permits.find((p) => p.discipline === "electrical")?.fee;
  assert.equal(kept?.value, null, `the formula's base is not kept as the fee: ${JSON.stringify(kept)}`);
  assert.match(kept?.notFound ?? "", /^the cited fee is a formula/);
  assert.deepEqual(anyPermitBrackets(), [], "no flat schedule lands, under the city's key or its issuing agency's");
  assert.ok(run.lookup?.feeReadsForPerson?.some((r) => r.url === RULE && /formula on the job's cost/.test(r.reason)), JSON.stringify(run.lookup?.feeReadsForPerson));
  const q = subFees.readPaymentQuote(db, project({ ahj: "Holloway" }), "permit");
  assert.notEqual(q.permitFeeUsd, 60);
  assert.match(q.permitFeeBasis, /Needs a person to read before this fee is relied on: https:\/\/www\.hollowayzz\.gov\/rules\/electrical-fees \(the electrical fee is a formula/);
});

// ── 5. A blocked, dated or unreadable fee page is a person's read on the fee quote ───────────────
await check("(5a) a site that refuses every read: the fee quote names the page for a person", async () => {
  const run = await runPermit("Holloway Heights", permitAnswers(NONE, [], "https://www.hollowayheightszz.gov/building/permits"), {}, ["hollowayheightszz.gov"]);
  assert.ok(run.lookup?.needsPersonRead?.length, JSON.stringify(run.reason));
  const q = subFees.readPaymentQuote(db, project({ ahj: "Holloway Heights" }), "permit");
  assert.match(q.permitFeeBasis, /Needs a person to read before this fee is relied on: https:\/\/www\.hollowayheightszz\.gov\/building\/permits \(the site refused Keelix's read/);
  assert.equal(q.permitFeeConfidence === "verified", false);
});
await check("(5b) a fee cited to a prior-year schedule is not kept, and the dated schedule is listed for a person", async () => {
  const GUIDE = `${SITE}/media/solar-fee-guide_dec-2019_final.pdf`;
  const fee = cite({ amountUsd: 165, basis: "flat residential solar permit fee", lines: [{ label: "Residential solar permit fee", amountUsd: 165 }] }, GUIDE, "Residential solar permit fee: $165");
  const run = await runPermit("Holloway", permitAnswers(fee, [GUIDE]), { [BUILD]: html(`<p>${AGENCY_QUOTE}</p>`), [GUIDE]: html("<p>Residential solar permit fee: $165</p>") });
  assert.equal(run.lookup?.permits[0].fee.value, null, "the dated-schedule rule is unchanged");
  assert.deepEqual(rowsCitedTo(GUIDE), [], "nothing lands off a dated schedule");
  assert.ok(run.lookup?.feeReadsForPerson?.some((r) => r.url === GUIDE && /prior-year schedule \(2019\)/.test(r.reason)), JSON.stringify(run.lookup?.feeReadsForPerson));
  assert.deepEqual(ppl.feeReadsForAPerson([{ discipline: "electrical", fee: { value: { amountUsd: 1, basis: "", lines: [] }, sourceUrl: GUIDE, quote: "", origin: "lookup" } as never }], [{ url: GUIDE, reason: "dated" }]), [],
    "a document whose fee was kept is never listed");
});
await check("(5c) fee research that saved nothing names the documents it could not get, for this project only", async () => {
  const DOC = `${SITE}/DocumentCenter/View/88/Building-Fee-Schedule`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("refused", { status: 403, headers: { "content-type": "text/html" } })) as typeof fetch;
  let outcome: Awaited<ReturnType<typeof fees.researchFeeSchedule>>;
  try {
    outcome = await fees.researchFeeSchedule(db, { state: "ZZ", ahj: "Ironbridge", track: "permit", discipline: "electrical" }, { researcher: async (_i, o) => {
      await fees.openFeeDocument({ url: DOC }, o!.ledger!, { timeoutMs: 5000, allowBrowser: false });
      return { found: false, reason: "the schedule could not be opened", basis: "other", brackets: [], notes: "", sourceUrl: "", sourceQuote: "", sourceKind: "" };
    } });
  } finally { globalThis.fetch = realFetch; }
  assert.equal(outcome.saved, false);
  assert.deepEqual(outcome.unread?.map((u) => u.url), [DOC], JSON.stringify(outcome));
  const p = project({ ahj: "Ironbridge" });
  const now = new Date().toISOString();
  db.run("INSERT INTO job_queue (id, job_type, payload, status, project_id, created_at, finished_at, result) VALUES (?, 'fee_research', '{}', 'done', ?, ?, ?, ?)",
    [`job-${p.id}`, p.id, now, now, JSON.stringify({ saved: false, found: false, track: "permit", unread: outcome.unread })]);
  assert.deepEqual(needs.feeReadsNeedingAPerson(db, p, "permit").map((r) => r.url), [DOC]);
  assert.deepEqual(needs.feeReadsNeedingAPerson(db, project({ ahj: "Ironbridge" }), "permit"), [], "another project's job rows are never read");
  assert.deepEqual(needs.feeReadsNeedingAPerson(db, p, "nem"), [], "the other track's research says nothing here");
});

// ── 6. Tier, source quote and read date, to the quote and the invoice ───────────────────────────
await check("(6a) the read date is stated only where it is known: a lookup's fee carries it, a hand-applied finding does not", async () => {
  const FEES = `${SITE}/building/fee-table`;
  const ROW = "Residential solar electrical permit $94.00";
  const fee = cite({ amountUsd: 94, basis: "flat residential solar electrical permit", lines: [{ label: "Residential solar electrical permit", amountUsd: 94 }] }, FEES, ROW);
  const run = await runPermit("Juniper Falls", { ...permitAnswers(fee, [FEES]) }, { [BUILD]: html(`<p>${AGENCY_QUOTE}</p>`), [FEES]: html(`<table><tr><td>Residential solar electrical permit</td><td>$94.00</td></tr></table>`) });
  const row = rowsCitedTo(FEES).find((r) => r.brackets.length)!;
  assert.ok(row, `the flat fee landed: ${JSON.stringify(run.lookup?.permits[0].fee)}`);
  assert.equal(row.confidence, "seeded");
  assert.equal(row.sources[0].fetchedAt, run.lookup?.lookedUpAt, "the lookup's own run time is the read date");
  assert.equal(fees.feeSourceReadAt(row), run.lookup?.lookedUpAt);
  const q = subFees.readPaymentQuote(db, project({ ahj: "Juniper Falls" }), "permit");
  assert.match(q.permitFeeBasis, /Source read \d{4}-\d\d-\d\d\./);
  // A finding applied by hand, with no ledger and no stated read time, carries no read date.
  fees.saveFeeSchedule(db, { state: "ZZ", ahj: "Kestrel Point", track: "permit", discipline: "electrical" }, { found: true, reason: "", basis: "flat", brackets: [{ feeUsd: 80, label: "Electrical permit" }],
    notes: "", sourceUrl: `${SITE}/kestrel-fees`, sourceQuote: "Electrical permit $80", sourceKind: "official" } as never);
  const hand = permitRows("Kestrel Point")[0];
  assert.equal(hand.sources[0].fetchedAt, undefined, "the save time is never dressed up as a read");
  assert.equal(fees.feeSourceReadAt(hand), "");
  assert.doesNotMatch(subFees.readPaymentQuote(db, project({ ahj: "Kestrel Point" }), "permit").permitFeeBasis, /Source read/);
});

await check("(6b) the invoice's pass-through line names a seeded schedule as seeded with its read date; only a person's confirm reads verified", () => {
  const comp = (tier: "seeded" | "verified", sourceReadAt: string) => ({ authority: "Larchmont Power", discipline: "", amountUsd: 100, sourceUrl: APPLY, collectedVia: "", tier, sourceQuote: APP_QUOTE, sourceReadAt });
  assert.equal(invoices.publishedFeeProvenance([comp("seeded", "2026-11-11T20:00:00.000Z")]), "seeded schedule, not person-verified; source read 2026-11-11");
  assert.equal(invoices.publishedFeeProvenance([comp("seeded", "")]), "seeded schedule, not person-verified");
  assert.equal(invoices.publishedFeeProvenance([comp("seeded", "2026-11-11T20:00:00.000Z"), comp("verified", "")]), "seeded schedule, not person-verified", "one seeded or undated share decides");
  assert.equal(invoices.publishedFeeProvenance([comp("verified", "")]), "person-verified schedule");
  assert.equal(invoices.publishedFeeProvenance([]), "");
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nkeelixFindsFees: all checks passed");
