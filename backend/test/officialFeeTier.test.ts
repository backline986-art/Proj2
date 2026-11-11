// FEES READ ON THE AUTHORITY'S OWN OFFICIAL PAGE ARE USED AS PUBLISHED (owner, 2026-11-11: "If its
// from an official source we can use it to come into us as verified already"). SAFETY-CRITICAL: this
// extends hard rule 3's official tier to the fee schedule, and a fee is money a client is charged.
//
// What the rule must keep, each pinned below:
//   A. The grade is earned only by evidence Keelix holds: a printed row it retrieved itself, on a
//      host that passes the ONE shared predicate, stating the amount, naming this permit, with a read
//      time. Anything short of that is seeded, as before.
//   B. It is shown "from <host>, read <date>", never under a person's name and never as "verified".
//   C. A person outranks a page: a person's verified amount is never replaced or re-worded, and a
//      person may still Confirm an official amount.
//   D. An official row is refreshed only by a read of its own official host. A weaker finding is
//      recorded for a person and changes nothing.
//   E. The weakest line decides a total: one seeded line makes the total seeded.
//   F. A lookup's own fee landing earns the grade the same way (the pages it read travel with it).
//   G. What the quote ADDS counts too: a state surcharge from a seeded state rule keeps the amount
//      seeded, however official the printed line is.
//
// Names, hosts and pages are invented; every read is a fake transport; no model key.
//
// KILL TESTS (each run with the one guard removed and seen red, 2026-11-11; failures as measured):
//   K1  officialFeeLineSource ignoring the citation shortfalls (host, quote, read time) → (A2), (A3), (A5), (B3).
//   K2  officialFeeLineSource without "the row names this permit"                       → (A4).
//   K3  officialFeeLineSource without "the row states the amount"                       → (A5).
//   K4  officialFeeLineSource grading a person-verified line                            → (C1).
//   K5  officialFeeResolutionSource skipping a seeded line instead of stopping on it    → (E1).
//   K6  the quote never grading "official" (scheduleFeeAt sets nothing)                 → (B1), (B2), (C1), (D1), (F1), (G1).
//   K7  saveFeeSchedule without the official-row guard                                  → (D1).
//   K8  applyLookupFees without the pages it read                                       → (F1).
//   K9  the official words reading "verified by"                                        → (B1).
//   K10 the state surcharge the quote adds not asked about                              → (G1).
//   K11 a charge outside the lines needing no official quote                            → (E1).
//
// Run: npx tsx backend/test/officialFeeTier.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord, WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "official-fee-tier-"));
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
const ppl = await import("../src/permitProcessLookup");
const fees = await import("../src/feeSchedules");
const official = await import("../src/feeOfficial");
const subFees = await import("../src/submissionFees");
const invoices = await import("../src/invoices");
const R = await import("../src/repository");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const project = (over: Partial<ProjectRecord>): ProjectRecord => ({
  id: `job-${Math.random().toString(36).slice(2, 8)}`, clientId: "", orgId: "", state: "ZZ", ahj: "", utility: "",
  systemSizeDcKw: 8, systemSizeAcKw: 7.6, homeownerName: "Sample Job", status: "qc_passed",
  parserSnapshot: { systemSizeDcKw: "8", systemSizeAcKw: "7.6", mountType: "Roof", hasBattery: "No" }, ...over,
} as unknown as ProjectRecord);

const GOV = "https://www.thistlewoodzz.gov/building/fee-schedule";
const COM = "https://www.thistlewoodcityzz.org/building/fee-schedule";
const ROW = "Residential solar photovoltaic electrical permit | $94.00";
const LABEL = "Residential solar photovoltaic electrical permit";
const READ = "2026-11-11T20:00:00.000Z";
type Line = Parameters<typeof fees.officialFeeLineSource>[0];
const line = (over: Partial<Line> = {}, corr: Record<string, unknown> = {}): Line => ({
  feeUsd: 94, bracketLabel: LABEL, discipline: "electrical", confidence: "seeded",
  corroboration: { corroborated: true, matchedLine: ROW, sourceUrl: GOV, checkedAt: READ, via: "http", ...corr } as never,
  ...over,
});

console.log("official fee tier");

// ── A. What earns the grade ─────────────────────────────────────────────────────────────────────
await check("(A1) a printed row Keelix read on a government host, stating the amount and naming this permit, is official", () => {
  assert.deepEqual(fees.officialFeeLineSource(line(), "permit"), { host: "www.thistlewoodzz.gov", sourceUrl: GOV, fetchedAt: READ });
});
await check("(A2) the same row on a non-government host is seeded", () => {
  assert.equal(fees.officialFeeLineSource(line({}, { sourceUrl: COM }), "permit"), null);
  assert.equal(fees.officialFeeLineSource(line({}, { sourceUrl: "https://cdn.vendorfileszz.net/thistlewood/fees.pdf" }), "permit", ["www.thistlewoodcityzz.org"]), null, "a file on someone else's host never qualifies");
});
await check("(A3) a non-government host is official only where a PERSON verified that domain as the authority's own", () => {
  assert.deepEqual(fees.officialFeeLineSource(line({}, { sourceUrl: COM }), "permit", ["www.thistlewoodcityzz.org"])?.host, "www.thistlewoodcityzz.org");
  assert.equal(fees.officialFeeLineSource(line({}, { sourceUrl: COM }), "permit", ["www.anothertownzz.org"]), null, "another authority's verified domain does not vouch for this one");
});
await check("(A4) a row that names no permit, or another permit, is a machine's guess at which fee this is: seeded", () => {
  assert.equal(fees.officialFeeLineSource(line({ bracketLabel: "5.01 to 15 kva" }, { matchedLine: "5.01 to 15 kva | $94.00" }), "permit"), null, "a bare size row");
  assert.equal(fees.officialFeeLineSource(line({ bracketLabel: "Permit fee" }, { matchedLine: "Plumbing permit fee | $94.00" }), "permit"), null, "another trade's row");
  assert.equal(fees.officialFeeLineSource(line({}, { matchedLine: "Commercial solar photovoltaic electrical permit | $94.00" }), "permit"), null, "another scope's row");
});
await check("(A5) the printed row must itself state this line's amount, and carry a read time; no corroboration is no grade", () => {
  assert.equal(fees.officialFeeLineSource(line({ feeUsd: 120 }), "permit"), null, "the row prints $94, the line says $120");
  assert.deepEqual(fees.officialFeeLineSource(line({ feeUsd: 105.28, baseFeeUsd: 94 }), "permit")?.host, "www.thistlewoodzz.gov", "a held surcharge on top: the printed base is what the row states");
  assert.equal(fees.officialFeeLineSource(line({}, { checkedAt: "" }), "permit"), null);
  assert.equal(fees.officialFeeLineSource(line({}, { corroborated: false }), "permit"), null);
  assert.equal(fees.officialFeeLineSource(line({ corroboration: undefined }), "permit"), null, "a fee nobody re-read is seeded");
});
await check("(A6) an amount computed from a guessed valuation, or reached through an unchecked pointer, is not the printed fee", () => {
  assert.equal(fees.officialFeeLineSource(line({ valuationEstimated: true }), "permit"), null);
  assert.equal(fees.officialFeeLineSource(line({ delegatedFromScheduleId: "ptr-1", hopVouched: false }), "permit"), null);
  assert.ok(fees.officialFeeLineSource(line({ delegatedFromScheduleId: "ptr-1", hopVouched: true }), "permit"), "a hop a person vouched for");
});

// ── B. How it is shown ──────────────────────────────────────────────────────────────────────────
const ledger = (url: string, body: string) => ({ evidence: [{ url, via: "http" as const, status: 200, kind: "html" as const, bytes: body.length, handed: 0 }], corpus: [body] });
const finding = (url: string, feeUsd = 94) => ({ found: true, reason: "", basis: "flat" as const, brackets: [{ feeUsd, label: LABEL }], notes: "", sourceUrl: url, sourceQuote: `${LABEL} $${feeUsd}.00`, sourceKind: "official" });
const save = (ahj: string, url: string, feeUsd = 94, withLedger = true) => fees.saveFeeSchedule(db, { state: "ZZ", ahj, track: "permit", discipline: "electrical" }, finding(url, feeUsd) as never,
  withLedger ? { corroborateAgainst: ledger(url, `Fee schedule\n${LABEL} | $${feeUsd}.00\nPlumbing permit | $60.00`) } : {});
const sheetLine = (p: ProjectRecord) => subFees.buildProjectFeeSheet(db, p).lines.find((l) => l.track === "permit" && !l.role)!;

await check("(B1) the fee quote grades it official and words it 'from <host>, read <date>', never as verified", () => {
  assert.equal(save("Thistlewood", GOV).saved, true);
  const p = project({ ahj: "Thistlewood" });
  const q = subFees.readPaymentQuote(db, p, "permit");
  assert.equal(q.permitFeeUsd, 94);
  assert.equal(q.permitFeeSource, "published_schedule");
  assert.equal(q.permitFeeConfidence, "official");
  assert.equal(q.permitFeeOfficialSource?.host, "www.thistlewoodzz.gov");
  assert.match(q.permitFeeBasis, /\(from www\.thistlewoodzz\.gov, read \d{4}-\d\d-\d\d: the authority's own published schedule, used as published; not checked by a person\)/);
  assert.doesNotMatch(q.permitFeeBasis, /human-verified|verified by|not yet human-verified/i, "official is never worded as a person's check, and no longer as unchecked research");
  assert.equal(q.permitFeeVerifiedBy, "");
  assert.equal(q.permitFeeVerifiedAt, "");
  // The stored row is still seeded: code never writes 'verified' (rule 3), and the grade is derived.
  const row = fees.getFeeSchedule(db, fees.feeScheduleProfileKey({ state: "ZZ", ahj: "Thistlewood" }, "permit"), "permit", "electrical")!;
  assert.equal(row.confidence, "seeded");
  assert.equal(row.verifiedBy, "");
});
await check("(B2) the fee card and the invoice line say the same: official, the host, the date, no person", () => {
  const p = R.createProject(db, { owner: "Sample Owner", state: "ZZ", dcKw: "8.0", acKw: "7.6", street: "1 Test Way", city: "Thistlewood", zip: "00000", ahj: "Thistlewood", utility: "Sample Power" } as never).project;
  const l = sheetLine(p);
  assert.equal(l.confidence, "official");
  assert.equal(l.officialSource?.host, "www.thistlewoodzz.gov");
  assert.equal(l.verifiedBy, "");
  assert.equal(l.confirmable, true, "a person may still put their name to it");
  const comp = (tier: "seeded" | "official" | "verified", host = "") => ({ authority: "Thistlewood", discipline: "electrical", amountUsd: 94, sourceUrl: GOV, collectedVia: "", tier, ...(host ? { officialHost: host } : {}), sourceQuote: ROW, sourceReadAt: READ });
  assert.equal(invoices.publishedFeeProvenance([comp("official", "www.thistlewoodzz.gov")]), "from www.thistlewoodzz.gov, read 2026-11-11; not checked by a person");
  assert.equal(invoices.publishedFeeProvenance([comp("official", "www.thistlewoodzz.gov"), comp("verified")]), "from www.thistlewoodzz.gov, read 2026-11-11; not checked by a person");
  assert.equal(invoices.publishedFeeProvenance([comp("official", "www.thistlewoodzz.gov"), comp("seeded")]), "seeded schedule, not person-verified; source read 2026-11-11", "one seeded share decides");
  assert.doesNotMatch(invoices.publishedFeeProvenance([comp("official", "www.thistlewoodzz.gov")]), /verified by|person-verified schedule/);
  const dash = fs.readFileSync(new URL("../../frontend/dashboard.js", import.meta.url), "utf8");
  const entry = /\n {2}official: \{[\s\S]*?\n {2}\},/.exec(dash)?.[0] ?? "";
  assert.ok(entry, "the dashboard has a fee confidence entry for official");
  assert.doesNotMatch(entry.replace(/\/\/.*$/gm, ""), /label: "[^"]*verified/i, "its badge never says verified");
});
await check("(B3) the same schedule with no retrieved document, or on a host nobody verified, stays seeded and says so", () => {
  save("Umberfield", "https://www.umberfieldzz.gov/fees", 94, false);
  const a = subFees.readPaymentQuote(db, project({ ahj: "Umberfield" }), "permit");
  assert.equal(a.permitFeeConfidence, "seeded");
  assert.match(a.permitFeeBasis, /researched, not yet human-verified/);
  assert.equal(a.permitFeeOfficialSource, undefined);
  save("Vetchley", "https://www.vetchleycityzz.org/fees");
  const b = subFees.readPaymentQuote(db, project({ ahj: "Vetchley" }), "permit");
  assert.equal(b.permitFeeConfidence, "seeded", "a .org nobody recorded as the city's own");
  assert.equal(official.officialSourceOfFeeResolution(db, "ZZ", "permit", fees.feeForProject(db, project({ ahj: "Vetchley" }), "permit")!), null);
});

// ── C. A person outranks a page ─────────────────────────────────────────────────────────────────
await check("(C1) a person's verified amount reads human-verified, not official, and an official read never replaces it", () => {
  save("Woadmere", "https://www.woadmerezz.gov/fees");
  const key = fees.feeScheduleProfileKey({ state: "ZZ", ahj: "Woadmere" }, "permit");
  assert.equal(subFees.readPaymentQuote(db, project({ ahj: "Woadmere" }), "permit").permitFeeConfidence, "official");
  fees.markFeeScheduleVerified(db, key, "permit", "Pat Reviewer", "electrical");
  const q = subFees.readPaymentQuote(db, project({ ahj: "Woadmere" }), "permit");
  assert.equal(q.permitFeeConfidence, "verified");
  assert.match(q.permitFeeBasis, /human-verified/);
  assert.equal(q.permitFeeOfficialSource, undefined);
  // A later official read at another amount is recorded for a person and changes nothing.
  const again = save("Woadmere", "https://www.woadmerezz.gov/fees", 120);
  assert.equal(again.saved, false);
  assert.equal(again.refusedVerified, true);
  const row = fees.getFeeSchedule(db, key, "permit", "electrical")!;
  assert.equal(row.brackets[0].feeUsd, 94);
  assert.equal(row.confidence, "verified");
  assert.match(row.notes, /NOT applied — row is human-verified/);
  assert.equal(fees.officialFeeLineSource(line({ confidence: "verified" }), "permit"), null, "a verified line is never graded official");
});

// ── D. An official row is refreshed only from its own official host ─────────────────────────────
await check("(D1) a finding with no read of that host does not replace an official row; a read of the same host refreshes it", () => {
  const url = "https://www.yarrowbankzz.gov/fees";
  save("Yarrowbank", url);
  const key = fees.feeScheduleProfileKey({ state: "ZZ", ahj: "Yarrowbank" }, "permit");
  // A hand-applied / search-only finding at another amount: no document behind it.
  const weak = save("Yarrowbank", "https://www.fee-aggregator.example.com/yarrowbank", 60, false);
  assert.equal(weak.saved, false);
  assert.equal(weak.refusedOfficial, true);
  assert.match(weak.reason ?? "", /www\.yarrowbankzz\.gov.*schedule unchanged/);
  let row = fees.getFeeSchedule(db, key, "permit", "electrical")!;
  assert.equal(row.brackets[0].feeUsd, 94, "the official amount stands");
  assert.equal(row.sourceUrl, url);
  assert.match(row.notes, /NOT applied — the row's lines were read on www\.yarrowbankzz\.gov/);
  // Another site's document, even one Keelix retrieved: not this row's official host.
  assert.equal(save("Yarrowbank", "https://www.fee-aggregator.example.com/yarrowbank", 60).refusedOfficial, true);
  // The same official host, re-read at a new amount: the row refreshes, and is still official.
  const fresh = save("Yarrowbank", url, 99);
  assert.equal(fresh.saved, true, fresh.reason ?? "");
  row = fees.getFeeSchedule(db, key, "permit", "electrical")!;
  assert.equal(row.brackets[0].feeUsd, 99);
  assert.equal(subFees.readPaymentQuote(db, project({ ahj: "Yarrowbank" }), "permit").permitFeeConfidence, "official");
});
await check("(D2) a seeded row is still replaced by any sourced finding, as before", () => {
  save("Zinniaford", "https://www.zinniafordzz.gov/fees", 94, false);
  const r = save("Zinniaford", "https://www.zinniafordzz.gov/fees-2", 101, false);
  assert.equal(r.saved, true);
  assert.equal(r.refusedOfficial, undefined);
});

// ── E. The weakest line decides a total ─────────────────────────────────────────────────────────
await check("(E1) a total with one official line and one seeded line is seeded; every line official or person-verified is official", () => {
  const mk = (over: Record<string, unknown>) => ({ ...line(), authority: "Thistlewood", charges: [], reason: "", ...over }) as never;
  const res = (lines: unknown[]) => ({ feeUsd: 188, lines, charges: [], valuationEstimated: false }) as never;
  const none = () => [] as string[];
  assert.equal(fees.officialFeeResolutionSource(res([mk({}), mk({ corroboration: undefined })]), "permit", none), null);
  assert.ok(fees.officialFeeResolutionSource(res([mk({}), mk({ confidence: "verified" })]), "permit", none), "a person's line beside an official one");
  assert.equal(fees.officialFeeResolutionSource(res([mk({ confidence: "verified" })]), "permit", none), null, "all person-verified is verified, not official");
  assert.equal(fees.officialFeeResolutionSource({ feeUsd: null, lines: [mk({})], charges: [], valuationEstimated: false } as never, "permit", none), null, "no total, no grade");
  const extra = { label: "Plan review", kind: "plan_review", amountUsd: 30, partOfLineFee: false, conditional: false, reason: "", quote: "", sourceUrl: GOV };
  assert.equal(fees.officialFeeResolutionSource({ feeUsd: 124, lines: [mk({})], charges: [extra], valuationEstimated: false } as never, "permit", none), null, "another charge in the total with no printed row");
  assert.ok(fees.officialFeeResolutionSource({ feeUsd: 124, lines: [mk({})], charges: [{ ...extra, quote: "Plan review | $30.00" }], valuationEstimated: false } as never, "permit", none));
});

// ── F. A lookup's own landing earns it the same way ─────────────────────────────────────────────
const g = (answer: unknown, urls: string[]): WebLookupResult => ({ text: JSON.stringify(answer), groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0 });
type Raw = import("../src/agencyPageReader").RawFetch;
const transport = (pages: Record<string, string>): Raw => async (url) => {
  const body = pages[url] ?? pages[url.replace(/\/$/, "")];
  if (body == null) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
  return { ok: true, status: 200, contentType: "text/html; charset=utf-8", text: body, finalUrl: url, reason: "HTTP 200" };
};
const html = (body: string) => `<html><head><title>t</title></head><body><main>${body}</main></body></html>`;
const cite = (value: unknown, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, notFound: "" });
const NONE = { value: null, sourceUrl: "", quote: "", notFound: "no page states it" };
await check("(F1) a fee the permit lookup lands from a government page it read is official on the quote; the lookup's own row is not a person's", async () => {
  const SITE = "https://www.alderbrookzz.gov";
  const BUILD = `${SITE}/building/permits`;
  const FEES = `${SITE}/building/fee-table`;
  const AGENCY = "The Alderbrook Building Division issues electrical permits for work inside the city.";
  const QUOTE = "Residential solar photovoltaic electrical permit $94.00";
  const fee = cite({ amountUsd: 94, basis: "flat residential solar electrical permit", lines: [{ label: LABEL, amountUsd: 94 }] }, FEES, QUOTE);
  const permit = { discipline: "electrical", label: "Electrical permit", issuingAgency: cite("Alderbrook Building Division", BUILD, AGENCY), portalUrl: NONE, recordType: NONE };
  const a = {
    process: { issuingAgency: cite("Alderbrook Building Division", BUILD, AGENCY), permitStructure: NONE, prerequisites: [], groundMountZoning: NONE, permits: [permit] },
    portal: { permits: [{ discipline: "electrical", portalUrl: NONE, recordType: NONE }], prerequisites: [] },
    docsFees: { permits: [{ discipline: "electrical", documents: NONE, fee }] },
  };
  reader._resetPoliteness();
  const run = await ppl.runPermitProcessLookup(db, { webLookup: async (q: { label: string }) => g(/\.process$/.test(q.label) ? a.process : /\.portal$/.test(q.label) ? a.portal : /documentsFees$/.test(q.label) ? a.docsFees : {}, [BUILD, FEES]) } as never,
    { state: "ZZ", ahj: "Alderbrook", force: true, reader: reader.createPageReader({ fetch: transport({ [BUILD]: html(`<p>${AGENCY}</p>`), [FEES]: html(`<table><tr><td>${LABEL}</td><td>$94.00</td></tr></table>`) }), minGapMs: 0, maxReads: 12 }) });
  assert.equal(run.lookup?.permits[0].fee.value?.amountUsd, 94, JSON.stringify(run.lookup?.permits[0].fee));
  const q = subFees.readPaymentQuote(db, project({ ahj: "Alderbrook" }), "permit");
  assert.equal(q.permitFeeUsd, 94);
  assert.equal(q.permitFeeConfidence, "official", q.permitFeeBasis);
  assert.equal(q.permitFeeOfficialSource?.host, "www.alderbrookzz.gov");
  assert.equal(run.lookup?.confidence, "seeded", "the lookup row itself is nobody's verified row");
});

// ── G. The weakest part decides, including what the quote adds ──────────────────────────────────
await check("(G1) a state surcharge the quote adds from a SEEDED state rule keeps the amount seeded; once that rule is a person's, the amount is official", () => {
  const ST = "OR"; // a state whose shipped surcharge rule is seeded (the quote adds it; the schedule does not print it)
  const rule = db.get<{ confidence: string; verified_at: string | null }>("SELECT confidence, verified_at FROM state_permit_rules WHERE state = ? AND family = 'fee' AND rule_key = 'surcharge'", [ST]);
  assert.ok(rule && rule.confidence === "seeded" && !rule.verified_at, `fixture: the shipped state surcharge rule is seeded (${JSON.stringify(rule)})`);
  const BRAMBLE = "https://www.bramblewickzz.gov/building/fee-schedule";
  assert.equal(fees.saveFeeSchedule(db, { state: ST, ahj: "Bramblewick", track: "permit", discipline: "electrical" }, finding(BRAMBLE) as never,
    { corroborateAgainst: ledger(BRAMBLE, `Fee schedule\n${LABEL} | $94.00`) }).saved, true);
  const p = project({ state: ST, ahj: "Bramblewick" });
  const seeded = subFees.readPaymentQuote(db, p, "permit");
  assert.ok((seeded.permitFeeUsd ?? 0) > 94, `the quote adds the state surcharge (${seeded.permitFeeUsd})`);
  assert.equal(seeded.permitFeeConfidence, "seeded", seeded.permitFeeBasis);
  assert.equal(seeded.permitFeeOfficialSource, undefined);
  assert.doesNotMatch(seeded.permitFeeBasis, /used as published/);
  db.run("UPDATE state_permit_rules SET verified_at = ?, verified_by = 'a person' WHERE state = ? AND family = 'fee' AND rule_key = 'surcharge'", [READ, ST]);
  const stands = subFees.readPaymentQuote(db, p, "permit");
  assert.equal(stands.permitFeeConfidence, "official", stands.permitFeeBasis);
  assert.equal(stands.permitFeeOfficialSource?.host, "www.bramblewickzz.gov");
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nofficialFeeTier: all checks passed");
