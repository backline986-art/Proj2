// HOW A PERMIT IS FILED: EMAIL, IN PERSON, BY MAIL, WITH ANOTHER PERMIT (lookup-permit-filing-channel,
// bot-vs-research comparison 2026-11-10). The permit lookup had one slot for where a permit is filed
// (a portal URL). A city that takes permits by email or at the counter had nowhere to land, and the
// vendor-link resolver filled the hole with whatever vendor link its page carried: a "Schedule an
// Inspection" link into the city's permit vendor, and the city portal for an electrical permit the
// same page says is bought at City Hall.
//
// The model is stubbed; the pages are invented and served by a fake transport. Every name is invented.
//
// KILL TESTS (each verified red by hand with the change removed):
//   K1 quoteStatesChannel always true                          → (a), (b) fail.
//   K2 candidatesOn without linkWordsAreNotApplying            → (d2) fails (inspection link is the portal).
//   K3 baseCandidates without the non-portal channel guard     → (e) fails (resolver portal kept).
//   K4 permitCandidates without the channel's email            → (f) fails.
//   K5 the stage's launch source without citedNonPortalChannelFor → (g) fails.
//
// Run: npx tsx backend/test/permitFilingChannel.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "permit-channel-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const reader = await import("../src/agencyPageReader");
const cat = await import("../src/permitPlatformCatalog");
const ppl = await import("../src/permitProcessLookup");
const pp = await import("../src/permitProcess");
const fdp = await import("../src/filingDestinationProposals");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
function site(pages: Record<string, string>) {
  const fetch: import("../src/agencyPageReader").RawFetch = async (url) => {
    const text = pages[url] ?? pages[url.replace(/#.*$/, "")];
    if (text == null) return { ok: false, status: 404, contentType: "text/html", finalUrl: url, reason: "HTTP 404" };
    return { ok: true, status: 200, contentType: "text/html", text, bytes: new TextEncoder().encode(text), finalUrl: url, reason: "HTTP 200" };
  };
  return fetch;
}
const newReader = (pages: Record<string, string>) => { reader._resetPoliteness(); return reader.createPageReader({ fetch: site(pages), minGapMs: 0, maxReads: 12 }); };
const g = (text: string, urls: string[]): WebLookupResult => ({ text, groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0 });
const SEEN = ["https://www.maplecrest.example.gov/building"];
const fact = (value: unknown, quote: string, sourceUrl = SEEN[0]) => ({ value, sourceUrl, quote });

console.log("permit filing channel");

await check("(a) the quote must STATE the channel: an email address in it, a hand-over verb + where, mail words without the e-mail words", () => {
  const t = ppl.quoteStatesChannel;
  assert.equal(t({ kind: "email", value: "permits@maplecrest.example.gov" }, "Please email individual PDFs of the following to permits@maplecrest.example.gov : Application"), true);
  assert.equal(t({ kind: "email", value: "other@maplecrest.example.gov" }, "Please email individual PDFs to permits@maplecrest.example.gov"), false);
  assert.equal(t({ kind: "in_person", value: "City Hall" }, "Electrical permits are in addition to the building permit and are purchased separately at City Hall."), true);
  assert.equal(t({ kind: "in_person", value: "Building Department" }, "Electrical permits are available at the Maplecrest Building Department."), false, "'available at' is not filing in person");
  assert.equal(t({ kind: "in_person", value: "Town Hall" }, "Permits are purchased separately at City Hall."), false, "the office must be the one named");
  assert.equal(t({ kind: "mail", value: "" }, "Applications may be emailed to the department."), false, "'emailed' is not 'mailed'");
  assert.equal(t({ kind: "portal", value: "" }, "Apply online through the Contractor Portal."), true);
  assert.equal(t({ kind: "with_other_permit", value: "Building" }, "The electrical work is included with the Building permit."), true);
  const both = "You have the option of faxing, emailing, mailing or bringing the application into the Building Department.";
  assert.equal(t({ kind: "mail", value: "" }, both), true);
  assert.equal(t({ kind: "email", value: "" }, both), true);
  assert.equal(t({ kind: "in_person", value: "Building Department" }, both), true);
});

await check("(b) acceptChannel: a cited, supported channel is kept; an unseen source, an unknown kind or an address not in the words is not", () => {
  const ok = ppl.acceptChannel(fact({ kind: "email", value: "permits@maplecrest.example.gov" }, "Please email the application to permits@maplecrest.example.gov."), SEEN);
  assert.deepEqual(ok.value, { kind: "email", value: "permits@maplecrest.example.gov" });
  assert.equal(ppl.acceptChannel(fact({ kind: "email", value: "permits@maplecrest.example.gov" }, "Please email the application to permits@maplecrest.example.gov.", "https://elsewhere.example.com/x"), SEEN).value, null);
  assert.equal(ppl.acceptChannel(fact({ kind: "fax", value: "555" }, "Fax the application to 555-0100."), SEEN).value, null);
  assert.equal(ppl.acceptChannel(fact({ kind: "email", value: "not an address" }, "Email it to us."), SEEN).value, null);
  assert.equal(ppl.acceptChannel(fact({ kind: "in_person", value: "City Hall" }, "Contact City Hall with questions."), SEEN).value, null);
});

await check("(c) alternates: one per kind, never the primary's kind, each cited", () => {
  const q = "You have the option of faxing, emailing, mailing or bringing the application into the Building Department.";
  const primary = ppl.acceptChannel(fact({ kind: "portal", value: "" }, "Please use the Contractor Portal for Electrical Permits."), SEEN);
  const alts = ppl.acceptAlternateChannels([
    fact({ kind: "email", value: "" }, q), fact({ kind: "mail", value: "" }, q), fact({ kind: "in_person", value: "Building Department" }, q),
    fact({ kind: "mail", value: "" }, q), fact({ kind: "portal", value: "" }, "Apply online."),
  ], SEEN, primary);
  assert.deepEqual(alts.map((a) => a.value?.kind), ["email", "mail", "in_person"]);
});

await check("(d1) link words: inspection / scheduling / payment / status / registration are never an application link; 'Permits & Inspections' and 'Apply & Pay Online' still are", () => {
  const no = ["Schedule an Inspection", "Inspections", "Pay permit fees", "Check permit status", "Application status", "Track my permit", "Contractor Registration"];
  const yes = ["Permits & Inspections", "Apply & Pay Online", "Apply for a permit online", "Online permit portal"];
  for (const w of no) assert.equal(cat.linkWordsAreNotApplying(w), true, w);
  for (const w of yes) assert.equal(cat.linkWordsAreNotApplying(w), false, w);
});

const CITY = "https://www.maplecrest.example.gov";
const BUILDING = `${CITY}/building`;
const VENDOR = "https://portal.iworq.net/MAPLECREST/permits/600";
const page = (linkWords: string, extra = "") => `<html><head><title>Building Department</title></head><body><main><h1>Building Department</h1><p>The City of Maplecrest Building Department issues residential building and electrical permits.</p>${extra}<p><a href="${VENDOR}">${linkWords}</a></p></main></body></html>`;
const vendorPage = `<html><head><title>Maplecrest - Permits</title></head><body><h1>City of Maplecrest Permits</h1><p>iWorQ Systems</p></body></html>`;
const processAnswer = (permit: Record<string, unknown>) => JSON.stringify({
  issuingAgency: { value: "City of Maplecrest Building Department", sourceUrl: BUILDING, quote: "The City of Maplecrest Building Department issues residential building and electrical permits." },
  permitStructure: { value: "combo", sourceUrl: BUILDING, quote: "One permit covers the structural and electrical work (a combined permit)." },
  permits: [{ discipline: "combo", label: "Residential solar", portalUrl: { value: null, notFound: "x" }, recordType: { value: null }, ...permit }],
});
const llmFor = (process1: string) => ({ webLookup: async (i: { label: string }) => {
  if (i.label.endsWith(".process")) return g(process1, [BUILDING]);
  return g(JSON.stringify({ permits: [] }), [BUILDING]);
} });
const run = (ahj: string, pages: Record<string, string>, process1: string) =>
  ppl.runPermitProcessLookup(db, llmFor(process1) as never, { state: "ZZ", ahj, force: true, reader: newReader(pages) });

await check("(d2) end to end: the page's only vendor link is 'Schedule an Inspection' → no portal from the resolver", async () => {
  const r = await run("Maplecrest", { [BUILDING]: page("Schedule an Inspection"), [VENDOR]: vendorPage }, processAnswer({}));
  assert.equal(r.lookup?.permits[0].portalUrl.value ?? null, null, JSON.stringify(r.lookup?.permits[0].portalUrl));
});

await check("(d3) control: the same page linking it as 'Apply for a permit online' → the resolver's portal is kept", async () => {
  const r = await run("Maplecrest", { [BUILDING]: page("Apply for a permit online"), [VENDOR]: vendorPage }, processAnswer({}));
  assert.equal(r.lookup?.permits[0].portalUrl.value, VENDOR, (r.lookup?.notes ?? []).join(" | "));
});

const EMAIL_Q = "Residential submittals: please email individual PDFs of the following to permits@maplecrest.example.gov";
await check("(e) a permit whose cited channel is email takes NO portal from the resolver (even an apply link); the channel is kept and the note says why", async () => {
  const r = await run("Maplecrest", { [BUILDING]: page("Apply for a permit online", `<p>${EMAIL_Q}</p>`), [VENDOR]: vendorPage },
    processAnswer({ channel: fact({ kind: "email", value: "permits@maplecrest.example.gov" }, EMAIL_Q, BUILDING) }));
  const p = r.lookup!.permits[0];
  assert.equal(p.portalUrl.value ?? null, null, JSON.stringify(p.portalUrl));
  assert.deepEqual(p.channel?.value, { kind: "email", value: "permits@maplecrest.example.gov" });
  assert.ok((r.lookup?.notes ?? []).some((n) => /vendor link was not taken.*by email to permits@/.test(n)), (r.lookup?.notes ?? []).join(" | "));
  assert.equal(r.lookup?.confidence, "seeded");
});

await check("(e2) an in-person permit: no resolver portal, and an earlier row's portal is not carried back onto it", async () => {
  const q = "Electrical permits are in addition to the building permit and are purchased separately at City Hall.";
  const r = await run("Larchmont", { [BUILDING]: page("Apply for a permit online", `<p>${q}</p>`), [VENDOR]: vendorPage },
    processAnswer({ channel: fact({ kind: "in_person", value: "City Hall" }, q, BUILDING) }));
  assert.equal(r.lookup!.permits[0].portalUrl.value ?? null, null);
  assert.equal(r.lookup!.permits[0].channel?.value?.kind, "in_person");
  // mergeWithEarlier: an earlier row's portal is not carried back onto a permit read as in person.
  const earlier = { ...r.lookup!, permits: [{ ...r.lookup!.permits[0], portalUrl: { value: VENDOR, sourceUrl: BUILDING, quote: "Apply for a permit online", origin: "lookup" as const } }] };
  const merged = ppl.mergeWithEarlier(earlier, { issuingAgency: r.lookup!.issuingAgency, permitStructure: r.lookup!.permitStructure, permits: r.lookup!.permits },
    () => ({ fact: earlier.permits[0].portalUrl, source: "process part", attestedBy: null, code: "none" }) as never, () => true);
  assert.equal(merged.permits[0].portalUrl.value ?? null, null);
  assert.equal(merged.permits[0].channel?.value?.kind, "in_person");
});

await check("(f) the cited email becomes a PROPOSAL (kind email, the page and its words) — never a door by itself", () => {
  const lookup = pp.getPermitProcessLookup(db, "ZZ", "Maplecrest");
  const c = fdp.permitCandidates({ profile: null, lookup, tracks: ["building"] });
  const email = c.find((x) => x.kind === "email");
  assert.ok(email, JSON.stringify(c));
  assert.equal(email!.address, "permits@maplecrest.example.gov");
  assert.equal(email!.sourceUrl, BUILDING);
  assert.equal(email!.from, "permit_lookup");
  // Nothing was written as a filing email: the record stays a person's.
  const row = db.get<{ j: string | null }>("SELECT filing_email_json AS j FROM permit_process_lookups WHERE state = 'ZZ' AND ahj LIKE 'Maplecrest%'", []);
  assert.ok(!row?.j || row.j === "null" || row.j === "", `filing_email_json = ${row?.j}`);
});

await check("(g) the track: a non-portal channel launches nothing from the lookup and the stop says where to file", () => {
  const project = { state: "ZZ", ahj: "Larchmont" } as never;
  assert.equal(pp.citedNonPortalChannelFor(project, "permit")?.value?.kind, "in_person");
  const s = pp.filingChannelStopSentence(project, "permit");
  assert.match(s, /File it in person at City Hall/);
  assert.match(s, /Nothing was opened/);
  assert.equal(pp.filingChannelStopSentence({ state: "ZZ", ahj: "Nowhere" } as never, "building"), "");
  // The stage's launch source reads the same predicate (source pin: the one place the lookup's portal
  // becomes the AHJ's launch URL).
  const repo = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "repository.ts"), "utf8");
  assert.match(repo, /if \(track !== "nem" && !ahjPortalUrl && !citedNonPortalChannelFor\(project, track\)\) \{\s*const looked = permitAnswerForTrack\(project, track\)\?\.portalUrl\.value/);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\npermitFilingChannel: all checks passed");
