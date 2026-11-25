// THE NEWEST FEE SCHEDULE AN AGENCY STILL LINKS IS ITS CURRENT ONE, WHEN IT IS ON THE OFFICIAL SITE
// (owner, 2026-11-11, asked whether a schedule dated last year or older counts while it is still
// the newest the agency links: "this can be done the same way as the auto verification thing. If
// its from an offical source we can use it").
//
// The prior-year rule (permitPlatformCatalog.staleOrOtherFeeSource, close F4) stands. This is the
// one way past it, and each condition is pinned:
//   1. The agency's own page, read in this run, links the schedule (a URL an answer merely cites
//      never counts: keelixFindsFees (5b) pins that and is unchanged).
//   2. It is a document dated to a prior year and nothing else: archived / superseded / draft never.
//   3. No current fee schedule document is linked beside it, and nothing current priced the fee
//      (a current fee page that prices it wins: (2e)).
//   4. It is the newest dated one linked.
//   5. Its host passes the one shared official-source predicate.
//   6. The row and the fee quote say the year in words.
//
// Names, hosts and pages are invented; every read is a fake transport; no model key.
//
// KILL TESTS (each run with the one guard removed and seen red, 2026-11-11; failures as measured):
//   K1  newestLinkedFeeSchedules not stopping at a current schedule document      → (1b), (2c).
//   K2  newestLinkedFeeSchedules returning every dated one, not the newest        → (1c).
//   K3  newestLinkedFeeSchedules without the official-host predicate              → (1e), (2d).
//   K4  newestLinkedFeeSchedules counting an archived / draft schedule            → (1d).
//   K5  newestLinkedFeeSchedules counting a dated page that is not a document     → (1f).
//   K6  the lookup never asking (no fallback read)                                → (2a), (2b).
//   K7  the lookup asking even when something current priced the fee              → (2e).
//   K8  currentFeeSource without the waiver                                       → (2a), (2b), (3a).
//   K9  currentFeeSource waiving every stale reason for a listed URL              → (3a).
//   K10 the quote not naming the schedule's year                                  → (2b).
//   K11 the stored row not naming the schedule's year                             → (2a).
//
// Run: npx tsx backend/test/datedOfficialFeeSchedule.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord, WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dated-official-fee-"));
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
const fees = await import("../src/feeSchedules");
const subFees = await import("../src/submissionFees");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const NOW = new Date().getFullYear();
const LAST = NOW - 1;
const OLDER = NOW - 3;
const yes = () => true;
const page = (url: string, links: Array<{ href: string; text: string }>) => ({ ok: true, kind: "html", url, finalUrl: url, status: 200, reason: "HTTP 200", title: "", text: "", links }) as never;

console.log("dated official fee schedule");

// ── 1. The rule itself ──────────────────────────────────────────────────────────────────────────
const GOV = "https://www.quillhavenzz.gov";
const DATED = `${GOV}/DocumentCenter/View/618/${LAST}-Building-Permit-Fee-Schedule.pdf`;
await check("(1a) the only fee schedule the agency's page links is last year's, on an official host: it counts", () => {
  const got = cat.newestLinkedFeeSchedules([page(`${GOV}/building`, [{ href: DATED, text: "Fee schedule" }])], ["Quillhaven"], "ZZ", yes, NOW);
  assert.deepEqual(got, [{ url: DATED, year: LAST, linkedFrom: `${GOV}/building` }]);
});
await check("(1b) MUST-EXCLUDE: a current fee schedule document linked beside it is the agency's schedule; the dated one never counts", () => {
  const links = [{ href: DATED, text: "Fee schedule" }, { href: `${GOV}/DocumentCenter/View/71/Building-Permit-Fee-Schedule.pdf`, text: "Current fee schedule" }];
  assert.deepEqual(cat.newestLinkedFeeSchedules([page(`${GOV}/building`, links)], ["Quillhaven"], "ZZ", yes, NOW), []);
  const thisYear = [{ href: DATED, text: "Fee schedule" }, { href: `${GOV}/DocumentCenter/View/72/${NOW}-Building-Permit-Fee-Schedule.pdf`, text: "Fee schedule" }];
  assert.deepEqual(cat.newestLinkedFeeSchedules([page(`${GOV}/building`, thisYear)], ["Quillhaven"], "ZZ", yes, NOW), [], "this year's is current");
});
await check("(1c) of several dated schedules only the newest counts", () => {
  const older = `${GOV}/DocumentCenter/View/402/${OLDER}-Building-Permit-Fee-Schedule.pdf`;
  const got = cat.newestLinkedFeeSchedules([page(`${GOV}/building`, [{ href: older, text: "Fee schedule" }, { href: DATED, text: "Fee schedule" }])], ["Quillhaven"], "ZZ", yes, NOW);
  assert.deepEqual(got.map((x) => x.url), [DATED]);
});
await check("(1d) MUST-EXCLUDE: an archived, superseded or draft schedule never counts; another permit kind's or another office's neither counts nor stands in the way", () => {
  for (const href of [`${GOV}/archive/${LAST}-Building-Permit-Fee-Schedule.pdf`, `${GOV}/files/${LAST}-building-permit-fee-schedule-superseded.pdf`, `${GOV}/files/draft-${LAST}-building-permit-fee-schedule.pdf`]) {
    assert.deepEqual(cat.newestLinkedFeeSchedules([page(`${GOV}/building`, [{ href, text: "Fee schedule" }])], ["Quillhaven"], "ZZ", yes, NOW), [], href);
  }
  const others = [{ href: `${GOV}/DocumentCenter/View/9/Sign-Permit-Fee-Schedule.pdf`, text: "Sign permit fee schedule" }, { href: `${GOV}/DocumentCenter/View/70/Clerks-Fee-Schedule.pdf`, text: "Clerk fees" }, { href: DATED, text: "Fee schedule" }];
  assert.deepEqual(cat.newestLinkedFeeSchedules([page(`${GOV}/building`, others)], ["Quillhaven"], "ZZ", yes, NOW).map((x) => x.url), [DATED]);
});
await check("(1e) MUST-EXCLUDE: a host that does not pass the official-source predicate never counts", () => {
  assert.deepEqual(cat.newestLinkedFeeSchedules([page(`${GOV}/building`, [{ href: DATED, text: "Fee schedule" }])], ["Quillhaven"], "ZZ", () => false, NOW), []);
});
await check("(1f) MUST-EXCLUDE: a dated schedule on someone else's site, or one that is a page and not a document, never counts; a current fee PAGE link does not stand in the way", () => {
  const elsewhere = `https://www.feefinderzz.com/quillhaven/${LAST}-Building-Permit-Fee-Schedule.pdf`;
  assert.deepEqual(cat.newestLinkedFeeSchedules([page(`${GOV}/building`, [{ href: elsewhere, text: "Fee schedule" }])], ["Quillhaven"], "ZZ", yes, NOW), []);
  assert.deepEqual(cat.newestLinkedFeeSchedules([page(`${GOV}/building`, [{ href: `${GOV}/building/${LAST}-permit-fee-schedule`, text: "Fee schedule" }])], ["Quillhaven"], "ZZ", yes, NOW), []);
  const nav = [{ href: `${GOV}/building/permit-fees`, text: "Permit fees" }, { href: DATED, text: "Fee schedule" }];
  assert.deepEqual(cat.newestLinkedFeeSchedules([page(`${GOV}/building`, nav)], ["Quillhaven"], "ZZ", yes, NOW).map((x) => x.url), [DATED]);
});
await check("(1g) the year a fee source is dated to, only when that is a prior year", () => {
  assert.equal(cat.priorYearOfFeeSource(DATED, NOW), LAST);
  assert.equal(cat.priorYearOfFeeSource(`${GOV}/DocumentCenter/View/71/Building-Permit-Fee-Schedule.pdf`, NOW), null);
  assert.equal(cat.priorYearOfFeeSource(`${GOV}/archive/${LAST}-Building-Permit-Fee-Schedule.pdf`, NOW), null, "archived is not 'dated'");
});

// ── 2. Through the lookup ───────────────────────────────────────────────────────────────────────
const g = (answer: unknown, urls: string[]): WebLookupResult => ({ text: JSON.stringify(answer), groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0 });
type Raw = import("../src/agencyPageReader").RawFetch;
const transport = (pages: Record<string, string>): Raw => async (url) => {
  const body = pages[url] ?? pages[url.replace(/\/$/, "")];
  if (body == null) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
  return { ok: true, status: 200, contentType: "text/html; charset=utf-8", text: body, finalUrl: url, reason: "HTTP 200" };
};
const readerOver = (pages: Record<string, string>) => { reader._resetPoliteness(); return reader.createPageReader({ fetch: transport(pages), minGapMs: 0, maxReads: 12 }); };
const html = (body: string) => `<html><head><title>t</title></head><body><main>${body}</main></body></html>`;
const project = (over: Partial<ProjectRecord>): ProjectRecord => ({
  id: `job-${Math.random().toString(36).slice(2, 8)}`, clientId: "", orgId: "", state: "ZZ", ahj: "", utility: "",
  systemSizeDcKw: 8, systemSizeAcKw: 7.6, homeownerName: "Sample Job", status: "qc_passed",
  parserSnapshot: { systemSizeDcKw: "8", systemSizeAcKw: "7.6", mountType: "Roof", hasBattery: "No" }, ...over,
} as unknown as ProjectRecord);
const cite = (value: unknown, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, notFound: "" });
const NONE = { value: null, sourceUrl: "", quote: "", notFound: "no page states it" };
const FEE_ROW = "Residential solar photovoltaic permit fee: $165";
const feeAt = (url: string) => cite({ amountUsd: 165, basis: "flat residential solar permit fee", lines: [{ label: "Residential solar photovoltaic permit fee", amountUsd: 165 }] }, url, FEE_ROW);
/** One lookup for an invented town: its building page (with the given links) and the pages served. */
const run = (town: string, site: string, links: string, fee: unknown, served: Record<string, string>) => {
  const build = `${site}/building/permits`;
  const agencyQuote = `The ${town} Building Division issues electrical permits for work inside the city.`;
  const permit = { discipline: "electrical", label: "Electrical permit", issuingAgency: cite(`${town} Building Division`, build, agencyQuote), portalUrl: NONE, recordType: NONE };
  const a = {
    process: { issuingAgency: cite(`${town} Building Division`, build, agencyQuote), permitStructure: NONE, prerequisites: [], groundMountZoning: NONE, permits: [permit] },
    portal: { permits: [{ discipline: "electrical", portalUrl: NONE, recordType: NONE }], prerequisites: [] },
    docsFees: { permits: [{ discipline: "electrical", documents: NONE, fee }] },
  };
  return ppl.runPermitProcessLookup(db, { webLookup: async (q: { label: string }) => g(/\.process$/.test(q.label) ? a.process : /\.portal$/.test(q.label) ? a.portal : /documentsFees$/.test(q.label) ? a.docsFees : {}, [build]) } as never,
    { state: "ZZ", ahj: town, force: true, reader: readerOver({ [build]: html(`<p>${agencyQuote}</p>${links}`), ...served }) });
};
const rowsCitedTo = (sourceUrl: string) => db.query<{ id: string }>("SELECT id FROM fee_schedules WHERE track = 'permit' AND source_url = ?", [sourceUrl]).map((r) => fees.getFeeScheduleById(db, r.id)!);
const link = (href: string, text: string) => `<p><a href="${href}">${text}</a></p>`;
const schedule = (site: string, year: number) => `${site}/DocumentCenter/View/55/${year}-Solar-Permit-Fee-Schedule.pdf`;

await check("(2a) a fee read on last year's schedule, the only one the agency's own government page links, is kept and lands", async () => {
  const SITE = "https://www.rookfieldzz.gov";
  const DOC = schedule(SITE, LAST);
  const r = await run("Rookfield", SITE, link(DOC, "Solar permit fee schedule"), feeAt(DOC), { [DOC]: html(`<p>${FEE_ROW}</p>`) });
  assert.equal(r.lookup?.permits[0].fee.value?.amountUsd, 165, JSON.stringify(r.lookup?.permits[0].fee));
  const rows = rowsCitedTo(DOC);
  assert.equal(rows.length, 1, "the fee lands in the fee schedule");
  assert.equal(rows[0].confidence, "seeded", "a lookup's fee is never a person's");
  assert.match(rows[0].notes, new RegExp(`Schedule dated ${LAST}: the newest the agency's own page links, used as current`));
  assert.ok(!(r.lookup?.feeReadsForPerson ?? []).some((x) => x.url === DOC), "a schedule Keelix relies on is not listed as one it does not rely on");
});
await check("(2b) the fee quote names the schedule's year beside the amount", async () => {
  const q = subFees.readPaymentQuote(db, project({ ahj: "Rookfield" }), "permit");
  assert.equal(q.permitFeeUsd, 165);
  assert.match(q.permitFeeBasis, new RegExp(`The schedule is dated ${LAST}\\.`));
  assert.equal(q.permitFeeConfidence === "verified", false);
});
await check("(2c) MUST-EXCLUDE: with a current fee schedule document linked beside it, a fee cited to the dated one is not kept, and the dated one is listed for a person", async () => {
  const SITE = "https://www.sedgemoorzz.gov";
  const DOC = schedule(SITE, LAST);
  const CURRENT = `${SITE}/DocumentCenter/View/56/Building-Permit-Fee-Schedule.pdf`;
  const r = await run("Sedgemoor", SITE, link(DOC, "Solar permit fee schedule") + link(CURRENT, "Building permit fee schedule"), feeAt(DOC),
    { [DOC]: html(`<p>${FEE_ROW}</p>`), [CURRENT]: html("<p>Building permit fees are set by resolution of the council.</p>") });
  assert.equal(r.lookup?.permits[0].fee.value, null, JSON.stringify(r.lookup?.permits[0].fee));
  assert.deepEqual(rowsCitedTo(DOC), []);
  assert.ok(r.lookup?.feeReadsForPerson?.some((x) => x.url === DOC && /prior-year schedule/.test(x.reason)), JSON.stringify(r.lookup?.feeReadsForPerson));
});
await check("(2d) MUST-EXCLUDE: the same dated schedule on a non-government site nobody verified is not kept", async () => {
  const SITE = "https://www.tarnbrookcityzz.org";
  const DOC = schedule(SITE, LAST);
  const r = await run("Tarnbrook", SITE, link(DOC, "Solar permit fee schedule"), feeAt(DOC), { [DOC]: html(`<p>${FEE_ROW}</p>`) });
  assert.equal(r.lookup?.permits[0].fee.value, null, JSON.stringify(r.lookup?.permits[0].fee));
  assert.deepEqual(rowsCitedTo(DOC), []);
  assert.ok(r.lookup?.feeReadsForPerson?.some((x) => x.url === DOC), JSON.stringify(r.lookup?.feeReadsForPerson));
});

await check("(2e) MUST-EXCLUDE: where a current fee PAGE the agency links prices the fee, the dated schedule is never read as current", async () => {
  const SITE = "https://www.umberleighzz.gov";
  const DOC = schedule(SITE, LAST);
  const FEES_PAGE = `${SITE}/building/permit-fees`;
  const r = await run("Umberleigh", SITE, link(DOC, "Solar permit fee schedule") + link(FEES_PAGE, "Permit fees"), feeAt(DOC),
    { [DOC]: html(`<p>${FEE_ROW}</p>`), [FEES_PAGE]: html("<h1>Permit fees</h1><table><tr><td>Residential solar photovoltaic permit fee</td><td>$180.00</td></tr></table>") });
  assert.equal(r.lookup?.permits[0].fee.value, null, JSON.stringify(r.lookup?.permits[0].fee));
  assert.deepEqual(rowsCitedTo(DOC), []);
});

// ── 3. Only the prior-year reason is waived ─────────────────────────────────────────────────────
await check("(3a) MUST-EXCLUDE: the waiver is for a prior-year date only: an archived schedule stays refused even if it were listed", () => {
  const ARCHIVED = `${GOV}/archive/${LAST}-Solar-Permit-Fee-Schedule.pdf`;
  const answer = JSON.stringify({ permits: [{ discipline: "electrical", documents: NONE, fee: feeAt(ARCHIVED) }] });
  const texts = new Map([[ppl.pageKey(ARCHIVED), FEE_ROW], [ppl.pageKey(DATED), FEE_ROW]]);
  const refused = ppl.parseDocsFeesPart(answer, [ARCHIVED], "end_turn", texts, [], [ppl.pageKey(ARCHIVED)]).byDiscipline.get("electrical")?.fee;
  assert.equal(refused?.value, null, JSON.stringify(refused));
  assert.match(String(refused?.notFound), /archived/);
  const dated = JSON.stringify({ permits: [{ discipline: "electrical", documents: NONE, fee: feeAt(DATED) }] });
  assert.equal(ppl.parseDocsFeesPart(dated, [DATED], "end_turn", texts, [], []).byDiscipline.get("electrical")?.fee.value, null, "not listed: the prior-year rule stands");
  assert.equal(ppl.parseDocsFeesPart(dated, [DATED], "end_turn", texts, [], [ppl.pageKey(DATED)]).byDiscipline.get("electrical")?.fee.value?.amountUsd, 165, "listed: kept");
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\ndatedOfficialFeeSchedule: all checks passed");
