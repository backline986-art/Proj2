// OFFICIAL FACTS ON A PERMIT-PROCESS LOOKUP (owner, 2026-11-11; lookupFactTiers.ts, plan slice 3).
//
// What these checks pin:
//   A. A lookup run stamps a non-door fact official (tier + fetchedAt) only when its quote, naming its
//      value, is in the bytes Keelix read on a government page (or a domain a person recorded); the
//      same answer on an unrecorded .org, or off a page Keelix could not read, lands seeded.
//   B. Never stamped: a portal, a record type, a fee, a category (yes/no, combo/separate), whatever the
//      answer carried; a tier the input already carried is stripped.
//   C. A re-run keeps a stamp on a fact carried over unchanged; a changed fact earns its own.
//   D. At read, each stamp is re-checked against today's hosts; a person-verified row is untouched; the
//      project route serves the honoured row.
//
// Names, hosts and pages are invented; every read is a fake transport; no model key.
//
// Kill tests (mutation → checks that fail), run by hand:
//   K1 stampFact: skip the retrieved-bytes check (retrievedText = quote)      → A2, C1.
//   K2 stampFact: skip the host check (hosts = every host)                     → A3.
//   K3 stripNeverStamped: keep the portal's tier                                → B1.
//   K4 stampFact: a list needs only one item named                              → B2.
//   K5 earlier stamps ignored                                                   → C1.
//   K6 withHonouredFactTiers: return the row as stored                          → D1.

import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "official-lookup-facts-"));
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

const db = await (await import("../src/db")).openDatabase();
const reader = await import("../src/agencyPageReader");
const ppl = await import("../src/permitProcessLookup");
const pp = await import("../src/permitProcess");
const tiers = await import("../src/lookupFactTiers");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};

const g = (answer: unknown, urls: string[]): WebLookupResult => ({ text: JSON.stringify(answer), groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0 });
type Raw = import("../src/agencyPageReader").RawFetch;
const transport = (pages: Record<string, string>, refuse: string[] = []): Raw => async (url) => {
  if (refuse.some((h) => url.includes(h))) return { ok: false, status: 403, contentType: "text/html", finalUrl: url, reason: "HTTP 403 — refused" };
  const body = pages[url] ?? pages[url.replace(/\/$/, "")];
  if (body == null) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
  return { ok: true, status: 200, contentType: "text/html; charset=utf-8", text: body, finalUrl: url, reason: "HTTP 200" };
};
const html = (body: string) => `<html><head><title>t</title></head><body><main>${body}</main></body></html>`;
const cite = (value: unknown, sourceUrl: string, quote: string) => ({ value, sourceUrl, quote, notFound: "" });
const NONE = { value: null, sourceUrl: "", quote: "", notFound: "no page states it" };

/** A permit lookup for `ahj` whose agency page is `site`'s /building/permits. */
async function run(ahj: string, site: string, opts: { refuse?: string[]; pageWords?: string } = {}) {
  const BUILD = `https://${site}/building/permits`;
  const AGENCY = `Electrical permits are issued by the ${ahj} Building Division for work inside the city.`;
  const permit = { discipline: "electrical", label: "Electrical permit", issuingAgency: cite(`${ahj} Building Division`, BUILD, AGENCY), portalUrl: NONE, recordType: NONE };
  const a = {
    process: { issuingAgency: cite(`${ahj} Building Division`, BUILD, AGENCY), permitStructure: cite("separate", BUILD, "Separate building and electrical permits are required."), prerequisites: [], groundMountZoning: NONE, permits: [permit] },
    portal: { permits: [{ discipline: "electrical", portalUrl: NONE, recordType: NONE }], prerequisites: [] },
    docsFees: { permits: [{ discipline: "electrical", documents: NONE, fee: NONE }] },
  };
  reader._resetPoliteness();
  const r = reader.createPageReader({ fetch: transport({ [BUILD]: html(`<p>${opts.pageWords ?? AGENCY}</p><p>Separate building and electrical permits are required.</p>`) }, opts.refuse ?? []), minGapMs: 0, maxReads: 12 });
  const out = await ppl.runPermitProcessLookup(db, {
    webLookup: async (q: { label: string }) => g(/\.process$/.test(q.label) ? a.process : /\.portal$/.test(q.label) ? a.portal : /documentsFees$/.test(q.label) ? a.docsFees : {}, [BUILD]),
  } as never, { state: "ZZ", ahj, force: true, reader: r });
  return { out, row: pp.getPermitProcessLookup(db, "ZZ", ahj) };
}

console.log("official lookup facts");

// ── A. What earns the stamp ─────────────────────────────────────────────────────────────────────
await check("(A1) the issuing agency, quoted from a government page Keelix read, lands official with its read time; the row stays seeded", async () => {
  const before = Date.now();
  const { row } = await run("Alderbrook", "www.alderbrookzz.gov");
  const f = row?.issuingAgency as { tier?: string; fetchedAt?: string; value: unknown } | undefined;
  assert.equal(f?.value, "Alderbrook", JSON.stringify(row?.issuingAgency));
  assert.equal(f?.tier, "official", JSON.stringify(f));
  assert.ok(Date.parse(f?.fetchedAt ?? "") >= before - 1000, String(f?.fetchedAt));
  assert.equal((row?.permits[0].issuingAgency as { tier?: string }).tier, "official", "the permit's own issuing agency too");
  assert.equal(row?.confidence, "seeded", "the row itself is nobody's verified row");
});
await check("(A2) the same answer off a page Keelix could not read lands seeded", async () => {
  const { row } = await run("Birchmere", "www.birchmerezz.gov", { refuse: ["birchmerezz.gov"] });
  assert.ok(row, "the row is saved");
  assert.equal((row!.issuingAgency as { tier?: string }).tier, undefined, JSON.stringify(row!.issuingAgency));
  assert.ok(row!.permits.every((p) => (p.issuingAgency as { tier?: string }).tier === undefined));
});
await check("(A3) the same answer on a .org nobody recorded as the city's own lands seeded", async () => {
  const { row } = await run("Cobbleford", "www.cobblefordcityzz.org");
  assert.equal(row?.issuingAgency?.value, "Cobbleford", JSON.stringify(row?.issuingAgency));
  assert.equal((row?.issuingAgency as { tier?: string }).tier, undefined);
});

// ── B. Never stamped ────────────────────────────────────────────────────────────────────────────
const GOV = "https://www.dunmorezz.gov/building";
const PAGE = "Permits are issued by the Dunmore Building Division. Apply online at https://dunmore.permitszz.example/apply. Separate permits are required.";
const ctx = { pageText: (u: string) => (u === GOV ? PAGE : undefined), hosts: [], now: "2026-11-13T07:00:00.000Z" };
const fact = (value: unknown, quote: string, extra: Record<string, unknown> = {}) => ({ value, sourceUrl: GOV, quote, origin: "lookup", ...extra }) as never;
await check("(B1) a portal, record type, fee and category are never stamped, and a tier they carried is stripped", () => {
  const injected = { tier: "official", fetchedAt: "2026-11-01T00:00:00.000Z" };
  const out = tiers.stampOfficialLookupFacts({
    permitStructure: fact("separate", "Separate permits are required.", injected),
    permits: [{ discipline: "electrical", label: "Electrical permit",
      issuingAgency: fact("Dunmore Building Division", "Permits are issued by the Dunmore Building Division."),
      portalUrl: fact("https://dunmore.permitszz.example/apply", "Apply online at https://dunmore.permitszz.example/apply.", injected),
      recordType: fact("Residential Electrical", "Residential Electrical", injected),
      documents: fact(null, "", injected),
      fee: fact({ amountUsd: 94, basis: "flat" }, "Solar permit $94", injected) }],
  } as never, ctx) as never as { permitStructure: { tier?: string }; permits: Array<Record<string, { tier?: string }>> };
  assert.equal(out.permitStructure.tier, undefined, "a category");
  for (const k of ["portalUrl", "recordType", "fee", "documents"]) assert.equal(out.permits[0][k].tier, undefined, k);
  assert.equal(out.permits[0].issuingAgency.tier, "official", "the agency beside them is");
});
await check("(B2) a quote that does not name the value, or a value that is not words, is not stamped", () => {
  const out = tiers.stampOfficialLookupFacts({
    issuingAgency: fact("Dunmore Public Works", "Permits are issued by the Dunmore Building Division."),
    reviewTime: fact(14, "Permits are issued by the Dunmore Building Division."),
    codes: fact(["Dunmore Building Division", "2023 NEC"], "Permits are issued by the Dunmore Building Division."),
  } as never, ctx) as never as Record<string, { tier?: string }>;
  assert.equal(out.issuingAgency.tier, undefined);
  assert.equal(out.reviewTime.tier, undefined);
  assert.equal(out.codes.tier, undefined, "every item of a list must be named");
});

// ── C. A re-run ─────────────────────────────────────────────────────────────────────────────────
await check("(C1) a fact carried over unchanged keeps its earlier stamp; a changed one earns its own or none", () => {
  const earlier = { issuingAgency: fact("Dunmore Building Division", "Permits are issued by the Dunmore Building Division.", { tier: "official", fetchedAt: "2026-11-01T00:00:00.000Z" }) };
  const noRead = { ...ctx, pageText: () => undefined, earlier: earlier as never };
  const kept = tiers.stampOfficialLookupFacts({ issuingAgency: fact("Dunmore Building Division", "Permits are issued by the Dunmore Building Division.") } as never, noRead) as never as Record<string, { tier?: string; fetchedAt?: string }>;
  assert.deepEqual([kept.issuingAgency.tier, kept.issuingAgency.fetchedAt], ["official", "2026-11-01T00:00:00.000Z"]);
  const changed = tiers.stampOfficialLookupFacts({ issuingAgency: fact("Dunmore Planning Division", "The Dunmore Planning Division issues permits.") } as never, noRead) as never as Record<string, { tier?: string }>;
  assert.equal(changed.issuingAgency.tier, undefined);
});

// ── D. At read ──────────────────────────────────────────────────────────────────────────────────
await check("(D1) a stamp is re-checked against today's hosts: a domain no longer recorded loses it; a broken stamp is dropped", () => {
  const ORG = "https://www.dunmorecityzz.org/building";
  const stamped = (sourceUrl: string, fetchedAt = "2026-11-01T00:00:00.000Z") => ({ confidence: "seeded", issuingAgency: { value: "Dunmore Building Division", sourceUrl, quote: "Permits are issued by the Dunmore Building Division.", origin: "lookup", tier: "official", fetchedAt }, permits: [] });
  const tierOf = (r: unknown) => (r as { issuingAgency: { tier?: string } }).issuingAgency.tier;
  assert.equal(tierOf(tiers.withHonouredFactTiers(stamped(ORG) as never, ["www.dunmorecityzz.org"])), "official", "a person still records the domain");
  assert.equal(tierOf(tiers.withHonouredFactTiers(stamped(ORG) as never, [])), undefined, "nobody records it any more");
  assert.equal(tierOf(tiers.withHonouredFactTiers(stamped(GOV, "") as never, [])), undefined, "no read time");
  assert.equal(tierOf(tiers.withHonouredFactTiers(stamped(GOV) as never, [])), "official");
  const verified = { ...stamped(ORG), confidence: "verified" };
  assert.equal(tiers.withHonouredFactTiers(verified as never, []), verified as never, "a person's row is served as it stands");
});
await check("(D2) the project route serves the honoured row", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/server.ts"), "utf8");
  const route = /app\.get\("\/api\/projects\/:id\/permit-process", [\s\S]*?\n\}\);/.exec(src)?.[0] ?? "";
  assert.match(route, /withHonouredFactTiers\(lookup, hosts\)/);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nofficialLookupFacts: all checks passed");
