// BATTERY (ESS) PERMITTING, UTILITY FEES AND REVIEW TIME, AS THE PAGES STATE THEM
// (lookup-battery-and-fees, bot-vs-research comparison 2026-11-10). Four of nine cities published how
// a battery job is permitted (a separate storage packet, a fire approval letter, a fire department
// battery permit, or "batteries in the same PV review"), two municipal utilities print their net-meter
// fee, and several pages state a review time; none of it had a question. Each is now a cited answer:
// display and warnings only, a battery answer only on a storage job.
//
// The model is stubbed; every name is invented.
//
// KILL TESTS (each verified red by hand with the change removed):
//   K1 quoteStatesBatteryPermitting without the storage-word test     → (a) fails.
//   K1b the storage-page test without the path-only rule               → (a) fails.
//   K2 quoteStatesReviewTime without the span match                    → (c) fails.
//   K3 essPermitStep without the lookup's battery answers              → (d) fails.
//   K4 quoteStatesFee without the printed-amount test                  → (e) fails.
//   K5 the track channel without utilityFeesAndReviewSentence          → (f) fails.
//   K6 the save without the earlier row's battery answers              → (h) fails.
//
// Run: npx tsx backend/test/batteryFeesReviewTime.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectRecord, WebLookupResult } from "../../shared/src/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "battery-fees-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmp, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
delete process.env.ANTHROPIC_API_KEY;

const db = await (await import("../src/db")).openDatabase();
const ppl = await import("../src/permitProcessLookup");
const ufl = await import("../src/utilityFilingLookup");
const rt = await import("../src/citedReviewTime");
const ess = await import("../src/essRequirements");
const docs = await import("../src/applicationDocs");

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${name}`); } catch (e) { failures++; console.error(`  FAIL - ${name}\n         ${(e as Error).message}`); }
};
const PAGE = "https://www.maplecrest.example.gov/building/solar";
const SEEN = [PAGE];
const fact = (value: unknown, quote: string, sourceUrl = PAGE) => ({ value, sourceUrl, quote });

console.log("battery permitting, utility fees, review time");

await check("(a) a battery answer must name the storage AND state its kind; a named agency must be in the words", () => {
  const t = ppl.quoteStatesBatteryPermitting;
  assert.equal(t({ kind: "separatePermit" }, "Battery storage systems require a separate Storage Battery System permit packet."), true);
  assert.equal(t({ kind: "sameReview" }, "Batteries are reviewed together with the PV plan review."), true);
  assert.equal(t({ kind: "fireReview", agency: "Maplecrest Fire District" }, "Battery systems require a permit from the Maplecrest Fire District."), true);
  assert.equal(t({ kind: "fireApprovalLetter" }, "Include the fire approval letter for any battery system."), true);
  assert.equal(t({ kind: "separatePermit" }, "A separate permit is required for all detached structures."), false, "no storage word");
  assert.equal(t({ kind: "fireReview", agency: "Larchmont Fire" }, "Battery systems require a permit from the Maplecrest Fire District."), false, "another agency");
  assert.equal(t({ kind: "sameReview" }, "Battery systems require a separate permit."), false, "the words state another kind");
  // A line printed in a battery packet need not repeat the word: the page's own address is about storage.
  const letter = "MAPLECREST FIRE DISTRICT: Approval Letter (see attachment)";
  assert.equal(t({ kind: "fireApprovalLetter" }, letter), false, "no storage word, no storage page");
  assert.equal(t({ kind: "fireApprovalLetter" }, letter, "https://www.maplecrest.example.gov/docs/View/9/Solar-Packet-Battery-System-PDF"), true);
  assert.equal(t({ kind: "fireApprovalLetter" }, letter, "https://battery.example.gov/docs/solar-packet"), false, "the host alone is not the page's subject");
});

await check("(b) the process part keeps cited battery answers (one per kind) and a cited review time", () => {
  const text = JSON.stringify({
    issuingAgency: { value: null }, permitStructure: { value: null }, permits: [],
    batteryPermitting: [
      fact({ kind: "separatePermit", documents: ["Storage Battery System packet"] }, "Battery storage systems require a separate Storage Battery System permit packet."),
      fact({ kind: "separatePermit" }, "Battery storage systems require a separate permit."),
      fact({ kind: "fireApprovalLetter" }, "Battery jobs must include the fire district's approval letter."),
      fact({ kind: "sameReview" }, "Solar permits are reviewed within 10 days.", "https://elsewhere.example.com/x"),
    ],
    reviewTime: fact("Allow 10 business days for review", "Please allow 10 business days for review of your application."),
  });
  const part = ppl.parseProcessPart(text, SEEN, "end_turn");
  assert.deepEqual(part.batteryPermitting?.map((b) => b.value?.kind), ["separatePermit", "fireApprovalLetter"]);
  assert.equal(part.reviewTime?.value, "Allow 10 business days for review");
});

await check("(c) review time: the value's span is the quote's, about review — never an expiry", () => {
  assert.equal(rt.quoteStatesReviewTime("10 business days", "Initial review takes up to 10 business days."), true);
  assert.equal(rt.quoteStatesReviewTime("1-3 days", "Allow 1-3 days to process applications."), true);
  assert.equal(rt.quoteStatesReviewTime("11 business days", "Initial review takes up to 10 business days."), false);
  assert.equal(rt.quoteStatesReviewTime("180 days", "The permit is void if work is not commenced within 180 days."), false);
  assert.equal(rt.quoteStatesReviewTime("10 days", "Call us with questions."), false);
});

const batteryJob = (ahj: string, battery: boolean) => ({
  id: "p1", state: "ZZ", ahj, utility: "Maplecrest Light",
  parserSnapshot: battery ? { hasBattery: "Yes", batteryModel: "Test Battery 10" } : { hasBattery: "No" },
} as unknown as ProjectRecord);
const g = (text: string, urls: string[]): WebLookupResult => ({ text, groundedSearches: 3, searches: 3, stopReason: "end_turn", resultUrls: urls, pagesRead: 0 });
const processWith = (extra: Record<string, unknown>) => JSON.stringify({
  issuingAgency: { value: "City of Maplecrest", sourceUrl: PAGE, quote: "The City of Maplecrest issues building permits." },
  permitStructure: { value: "combo", sourceUrl: PAGE, quote: "One permit covers the structural and electrical work (a combined permit)." },
  permits: [{ discipline: "combo", label: "Solar", portalUrl: { value: null }, recordType: { value: null } }], ...extra,
});
const runWith = (ahj: string, extra: Record<string, unknown>) => ppl.runPermitProcessLookup(db, { webLookup: async (i: { label: string }) => (i.label.endsWith(".process") ? g(processWith(extra), [PAGE]) : g(JSON.stringify({ permits: [] }), [PAGE])) } as never,
  { state: "ZZ", ahj, force: true, reader: null });

await check("(d) a STORAGE job's card says how this AHJ permits a battery, cited; a PV-only job hears nothing", async () => {
  await runWith("Maplecrest", {
    batteryPermitting: [fact({ kind: "fireApprovalLetter", agency: "Maplecrest Fire District" }, "Battery jobs must include the Maplecrest Fire District approval letter.")],
    reviewTime: fact("10 business days", "Allow 10 business days for review."),
  });
  const step = ess.essPermitStep(batteryJob("Maplecrest", true))!;
  assert.equal(step.status, "cited");
  assert.ok(step.entries.some((e) => e.basis === "lookup_battery" && /fire approval letter.*Maplecrest Fire District/i.test(e.step)), JSON.stringify(step.entries));
  assert.match(step.summary, /own page says how a battery is permitted/);
  assert.equal(ess.essPermitStep(batteryJob("Maplecrest", false)), null);
});

await check("(g) the permit-structure line shows the cited review time", () => {
  const a = docs.permitStructureAnswer(batteryJob("Maplecrest", false));
  assert.match(docs.permitStructureSentence(a), /Review time \(the AHJ's page\): 10 business days — https:\/\/www\.maplecrest\.example\.gov/);
});

await check("(h) a re-run that finds no battery answer or review time keeps the earlier cited ones", async () => {
  const r = await runWith("Maplecrest", {});
  assert.equal(r.lookup?.batteryPermitting?.[0]?.value?.kind, "fireApprovalLetter");
  assert.equal(r.lookup?.reviewTime?.value, "10 business days");
});

const UPAGE = "https://www.maplecrestlight.example.gov/net-metering";
await check("(e) utility fees: kept only when the quote PRINTS the amount beside the label's words; review time the same way", () => {
  const text = JSON.stringify({
    filing: { value: null, notFound: "x" }, program: { value: null }, limits: {},
    fees: [
      fact({ label: "Residential net meter fee", amountUsd: 250 }, "Residential Net Meter Fee: $250.00", UPAGE),
      fact({ label: "NET Metering", amountUsd: 578 }, "NET Metering $578.00", UPAGE),
      fact({ label: "Meter fee", amountUsd: 300 }, "A meter fee applies.", UPAGE),
      fact({ label: "Application fee", amountUsd: 50 }, "Application fee $50", "https://elsewhere.example.com/x"),
    ],
    reviewTime: fact("up to 10 business days", "Applications are reviewed in up to 10 business days.", UPAGE),
  });
  const parsed = ufl.parseUtilityFilingAnswer(text, [UPAGE]);
  assert.deepEqual(parsed.fees?.map((f) => f.value?.amountUsd), [250, 578]);
  assert.equal(parsed.reviewTime?.value, "up to 10 business days");
  assert.equal(rt.quoteStatesFee({ label: "NET Metering", amountUsd: 578 }, "NET Metering $5,780.00"), false);
  assert.deepEqual(rt.dollarAmounts("TOTAL $1,033.00 and $3.50"), [1033, 3.5]);
});

await check("(f) the NEM track card carries the utility's fees and review time, from its page", async () => {
  const text = JSON.stringify({
    filing: { value: null, notFound: "x" }, program: { value: "net_metering", programName: "Net Metering", sourceUrl: UPAGE, quote: "Net metering credits exported energy." }, limits: {},
    fees: [fact({ label: "Residential net meter fee", amountUsd: 250 }, "Residential Net Meter Fee: $250.00", UPAGE)],
    reviewTime: fact("up to 10 business days", "Applications are reviewed in up to 10 business days.", UPAGE),
  });
  await ufl.runUtilityFilingLookup(db, { webLookup: async () => g(text, [UPAGE]) } as never, { state: "ZZ", utility: "Maplecrest Light", force: true, reader: null });
  const s = ufl.utilityFeesAndReviewSentence(db, { state: "ZZ", utility: "Maplecrest Light" });
  assert.match(s, /Utility fees \(from its page\): Residential net meter fee \$250 — https:\/\/www\.maplecrestlight/);
  assert.match(s, /Utility review time \(from its page\): up to 10 business days/);
  assert.equal(ufl.utilityFeesAndReviewSentence(db, { state: "ZZ", utility: "Nowhere Power" }), "");
  // Source pin: the NEM track card's channel line carries the sentence.
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "submittalTracks.ts"), "utf8");
  assert.match(src, /channel: `\$\{u\.channel\}\$\{utilityFeesAndReviewSentence\(db, project\)\}`/);
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nbatteryFeesReviewTime: all checks passed");
