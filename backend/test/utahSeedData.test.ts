// UTAH SEED DATA (issue #109): the shipped Utah AHJ process rows in
// backend/data/reference-ahj-processes.json (Salt Lake City, Provo, Lehi, Spanish Fork; City of
// Saratoga Springs from issue #228; the northern Utah prospect cities from worker-refdata-ut,
// 2026-11-10: Murray City, South Jordan, West Jordan, Ogden, Syracuse, Clearfield, Bountiful,
// Kaysville, each with per-fact `citations`).
// Utah is the next test jurisdiction and had ZERO process rows, so findAhjProcessProfile
// answered null for every Utah project. Pins:
//   - each row resolves for its own city (and only its own: Salt Lake COUNTY is not the city);
//   - each row is web-researched, cites official .gov sources, and says it is seeded, not
//     verified (hard rule 3) — the KB row the boot seed writes from it is "seeded";
//   - no row names a bare information page as its submission method (hard rule 5);
//   - the rows pass the reference importer's own validation (importAhjProcessSheet, dry run).
// CITED CHECKLISTS (issue #123): each row's `documents` lands at boot in permit_process_lookups as
// one 'seeded' permit, so lookupRequiredList returns the page's items with its http sourceUrl; a
// person's verified row is never touched (rule 3); a runtime lookup saved on or after the page was
// read is never overwritten; an older one keeps its own permits; a reboot rewrites nothing.
// Run: tsx backend/test/utahSeedData.test.ts
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AhjProcessProfile, ProjectRecord } from "../../shared/src/types";
import type { SheetData } from "../src/xlsxRead";

const { openDatabase } = await import("../src/db");
const { findAhjProcessProfile, ahjProcessKnowledgeStatus } = await import("../src/processProfiles");
const { importAhjProcessSheet } = await import("../src/referenceImport");
const { findKnowledgeForLearn, seedInitialKnowledgeBase, REFERENCE_CHECKLIST_LABEL } = await import("../src/knowledgeBase");
const { lookupRequiredList } = await import("../src/requiredDocuments");
const { getPermitProcessLookup, savePermitProcessLookup } = await import("../src/permitProcess");
const { lookupHasUnaskedPart } = await import("../src/permitProcessLookup");
const { essPermitStep } = await import("../src/essRequirements");

const db = await openDatabase();

let failures = 0;
const run = async (label: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`  ok   - ${label}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`);
  }
};

const file = JSON.parse(fs.readFileSync(path.join(REPO, "backend", "data", "reference-ahj-processes.json"), "utf8")) as { count: number; profiles: AhjProcessProfile[] };
const UT_CITIES = ["Salt Lake City", "Provo", "Lehi", "Spanish Fork", "City of Saratoga Springs",
  "Murray City", "South Jordan", "West Jordan", "Ogden", "Syracuse", "Clearfield", "Bountiful", "Kaysville"];
// Rows read 2026-11-10 (worker-refdata-ut): every fact carries its page, words and fetch time.
const CITED_2026_11_10 = ["Murray City", "South Jordan", "West Jordan", "Ogden", "Syracuse", "Clearfield", "Bountiful", "Kaysville"];
// Cities whose pages publish no solar checklist ship NO documents block: an empty cited list would
// replace a runtime lookup's documents list (seedReferenceDocumentChecklist, #560) with nothing.
const NO_PUBLISHED_CHECKLIST = ["West Jordan", "Ogden", "Syracuse", "Clearfield"];
// The cities' own hosts (Clearfield's is clearfield.city, its own domain; the rest are .gov).
const CITY_HOSTS = /(^|\.)(slc|provo|lehi-ut|spanishfork|saratogasprings-ut|murray\.utah|sjc\.utah|westjordan\.utah|ogdencity|syracuseut|bountiful|kaysville)\.gov$|^clearfield\.city$/;
const utRows = file.profiles.filter((p) => p.state === "UT");
const project = (ahj: string) => ({ state: "UT", ahj, city: ahj }) as unknown as ProjectRecord;

await run("the reference ships exactly the researched Utah process rows; count stays true", () => {
  assert.deepEqual(utRows.map((r) => r.ahj).sort(), [...UT_CITIES].sort());
  assert.equal(file.count, file.profiles.length, "header count matches the rows");
  assert.equal(ahjProcessKnowledgeStatus().status, "resolved");
});

await run("each Utah city resolves to its own row; Salt Lake County does not read the city's", () => {
  for (const city of UT_CITIES) {
    const p = findAhjProcessProfile(project(city));
    assert.ok(p, `${city}: a process row`);
    assert.equal(p!.state, "UT");
    assert.equal(p!.ahj, city);
  }
  const county = findAhjProcessProfile({ state: "UT", ahj: "Salt Lake County" } as unknown as ProjectRecord);
  assert.notEqual(county?.ahj, "Salt Lake City", "a county project is not handed the city's process");
});

await run("every Utah row is seeded, cites official city sources, and names a portal (never an info page)", () => {
  for (const r of utRows) {
    assert.match(r.sourceSheet, /seeded/i, `${r.ahj}: sourceSheet says seeded`);
    assert.match(r.reviewerNotes, /NOT verified/, `${r.ahj}: notes say not verified`);
    const urls = r.reviewerNotes.match(/https:\/\/[^\s;]+/g) ?? [];
    assert.ok(urls.length > 0, `${r.ahj}: at least one source URL`);
    for (const u of urls) assert.match(new URL(u).hostname, CITY_HOSTS, `${r.ahj}: the city's own source ${u}`);
    // Hard rule 5: the submission method names the permit platform, not a city information page.
    assert.match(r.submissionMethod, /\b(accela|cityview|iworq|citizenserve|cityworks|eprocess360|energov|civicreview|cityinspect)\b/i, `${r.ahj}: platform named`);
    assert.doesNotMatch(r.submissionMethod, /https?:\/\//i, `${r.ahj}: no bare URL as the method`);
    for (const u of urls) {
      const page = new URL(u);
      assert.ok(!r.submissionMethod.toLowerCase().includes(`${page.hostname}${page.pathname}`.toLowerCase()), `${r.ahj}: the cited information page ${u} is not the portal`);
    }
  }
});

await run("boot seed writes each Utah row into the KB as SEEDED, never verified", () => {
  for (const city of UT_CITIES) {
    const kb = findKnowledgeForLearn(db, { state: "UT", ahj: city }).ahj;
    assert.ok(kb, `${city}: KB row`);
    assert.equal(kb!.confidence, "seeded", `${city}: seeded`);
    assert.ok(!kb!.verifiedAt, `${city}: never verified by the seed`);
  }
});

await run("reference-import dry run: the Utah rows pass the importer's validation and write nothing", () => {
  const sheet: SheetData = {
    name: "UT PROCESS",
    headers: ["Municipality", "Permit Search Website", "Special Notes"],
    rows: utRows.map((r) => ({ Municipality: r.ahj, "Permit Search Website": r.submissionMethod, "Special Notes": r.otherRequirements })),
  };
  const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_utility_knowledge")!.n;
  const summary = importAhjProcessSheet(db, sheet, { dryRun: true });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.imported, utRows.length, `every row accepted (${JSON.stringify(summary)})`);
  assert.equal(summary.skippedEmpty, 0);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM permit_utility_knowledge")!.n, before, "dry run wrote nothing");
});

// ── Cited checklists (issue #123) ───────────────────────────────────────────────────────────
const docsOf = (city: string) => utRows.find((r) => r.ahj === city)!.documents!;
const rowOf = (city: string) =>
  db.get<{ payload_json: string; updated_at: string; verified_at: string | null }>(
    "SELECT payload_json, updated_at, verified_at FROM permit_process_lookups WHERE profile_key = ?", [`ut|${city.toLowerCase()}`])!;
const cited = (permitDocs: string[] | null, sourceUrl: string) => ({
  discipline: "structural" as const, label: "Residential Structural",
  issuingAgency: { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "none" },
  portalUrl: { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "none" },
  recordType: { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "none" },
  documents: { value: permitDocs, sourceUrl, quote: "the page's words", origin: "lookup" as const },
  fee: { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "none" },
});
const runtime = (city: string, permitDocs: string[], model = "test-model") => ({
  state: "UT", ahj: city,
  issuingAgency: { value: `City of ${city}`, sourceUrl: "https://example.gov/a", quote: "issued by the city", origin: "lookup" as const },
  permitStructure: { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "none" },
  permits: [cited(permitDocs, "https://example.gov/runtime-list")],
  lookedUpAt: new Date().toISOString(), model,
});

await run("every Utah row with a published checklist carries a cited documents block: items, the city's own page, its words", () => {
  for (const r of utRows) {
    if (NO_PUBLISHED_CHECKLIST.includes(r.ahj)) {
      assert.equal(r.documents, undefined, `${r.ahj}: no published checklist, so no documents block`);
      continue;
    }
    const d = r.documents;
    assert.ok(d, `${r.ahj}: documents`);
    assert.ok(d!.items.length > 0 || d!.notFound, `${r.ahj}: items or notFound`);
    assert.match(new URL(d!.sourceUrl).hostname, CITY_HOSTS, `${r.ahj}: the city's own page`);
    assert.ok(d!.quote.trim().length >= 20, `${r.ahj}: a quote`);
    assert.match(d!.observedAt, /^\d{4}-\d{2}-\d{2}$/, `${r.ahj}: observedAt`);
  }
});

await run("after boot lookupRequiredList returns each row's cited items with its http sourceUrl, seeded", () => {
  for (const city of UT_CITIES.filter((c) => !NO_PUBLISHED_CHECKLIST.includes(c))) {
    const want = docsOf(city);
    const got = lookupRequiredList({ state: "UT", ahj: city });
    assert.deepEqual(got.items, want.items, `${city}: items`);
    assert.equal(got.sourceUrl, want.sourceUrl, `${city}: sourceUrl`);
    assert.match(got.sourceUrl, /^https?:\/\//);
    const lk = getPermitProcessLookup(db, "UT", city)!;
    assert.equal(lk.confidence, "seeded", `${city}: seeded, never verified`);
    assert.ok(!rowOf(city).verified_at);
    // The seed answers only the documents: the per-job lookup still asks the portal and fee.
    assert.ok(lookupHasUnaskedPart(lk), `${city}: portal/fee left for the lookup`);
    assert.deepEqual(lk.permits.map((p) => p.discipline), ["other"], `${city}: one trackless permit`);
  }
});

await run("a reboot rewrites nothing (our own unchanged row keeps its updated_at)", () => {
  const before = rowOf("Spanish Fork");
  seedInitialKnowledgeBase(db);
  const after = rowOf("Spanish Fork");
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(after.payload_json, before.payload_json);
});

await run("a person-verified row is never touched by the seed (hard rule 3)", () => {
  const saved = savePermitProcessLookup(db, { ...runtime("Salt Lake City", ["Verified line A"]), confidence: "verified" }, { verifiedBy: "test-person" });
  assert.equal(saved.lookup?.confidence, "verified");
  const before = rowOf("Salt Lake City");
  seedInitialKnowledgeBase(db);
  const after = rowOf("Salt Lake City");
  assert.equal(after.payload_json, before.payload_json, "payload untouched");
  assert.equal(after.verified_at, before.verified_at);
  assert.deepEqual(lookupRequiredList({ state: "UT", ahj: "Salt Lake City" }).items, ["Verified line A"]);
});

await run("a newer runtime lookup is never overwritten by the reference (the reference loses)", () => {
  savePermitProcessLookup(db, runtime("Provo", ["Runtime line P"]));
  const before = rowOf("Provo");
  assert.ok(before.updated_at >= docsOf("Provo").observedAt, "the runtime row is newer than the page read");
  seedInitialKnowledgeBase(db);
  const after = rowOf("Provo");
  assert.equal(after.payload_json, before.payload_json);
  assert.deepEqual(lookupRequiredList({ state: "UT", ahj: "Provo" }).items, ["Runtime line P"]);
});

await run("an OLDER runtime lookup keeps its own answers; the cited checklist REPLACES its documents list (#560: no stale list beside it)", () => {
  savePermitProcessLookup(db, runtime("Lehi", ["Runtime line L"]));
  db.run("UPDATE permit_process_lookups SET updated_at = ? WHERE profile_key = ?", ["2026-01-01T00:00:00.000Z", "ut|lehi"]);
  seedInitialKnowledgeBase(db);
  const lk = getPermitProcessLookup(db, "UT", "Lehi")!;
  assert.equal(lk.confidence, "seeded");
  assert.equal(lk.model, "test-model", "the runtime row is kept, not replaced");
  assert.equal(lk.issuingAgency.value, "City of Lehi");
  assert.deepEqual(lk.permits.map((p) => p.label), ["Residential Structural", REFERENCE_CHECKLIST_LABEL]);
  const got = lookupRequiredList({ state: "UT", ahj: "Lehi" });
  assert.deepEqual(got.items, docsOf("Lehi").items, "the runtime list is superseded, not kept beside the checklist");
  assert.match(String(lk.permits[0].documents.notFound), /superseded by .*published checklist/);
  // and a second boot leaves it alone (it is now newer than the page read)
  const before = rowOf("Lehi");
  seedInitialKnowledgeBase(db);
  assert.equal(rowOf("Lehi").payload_json, before.payload_json);
});

// ── Per-fact citations and the door rule (worker-refdata-ut, 2026-11-10) ─────────────────────
await run("every 2026-11-10 row cites each fact: the city's own page, its words, when it was read", () => {
  for (const city of CITED_2026_11_10) {
    const r = utRows.find((x) => x.ahj === city)!;
    assert.ok(r, `${city}: row`);
    const cites = r.citations ?? [];
    assert.ok(cites.length > 0, `${city}: citations`);
    for (const c of cites) {
      assert.ok(c.field === "ess" || c.field in r, `${city}: citation field ${c.field} is a profile field or "ess"`);
      assert.match(new URL(c.sourceUrl).protocol, /^https:$/, `${city}: https page`);
      assert.match(new URL(c.sourceUrl).hostname, CITY_HOSTS, `${city}: the city's own page ${c.sourceUrl}`);
      assert.ok(c.quote.trim().length >= 8, `${city}: the page's words`);
      assert.match(c.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `${city}: fetchedAt`);
    }
    // The door: one citation backs the submission method, and the host it read is the one the row names.
    const door = cites.filter((c) => c.field === "submissionMethod" && c.value);
    assert.equal(door.length, 1, `${city}: one cited door`);
    assert.ok(r.submissionMethod.includes(door[0].value!), `${city}: the method names the cited host ${door[0].value}`);
    // Nothing in a seeded row claims a person's or an official mark.
    assert.doesNotMatch(JSON.stringify(r), /"verified(?:By|At)?"\s*:|"official"|"tier"\s*:/, `${city}: no verified / official stamp`);
  }
});

await run("a seeded door is never launchable: the KB row holds the method as text, never a portal URL (rule 3, rule 5)", () => {
  for (const city of CITED_2026_11_10) {
    const kb = findKnowledgeForLearn(db, { state: "UT", ahj: city }).ahj!;
    assert.equal(kb.confidence, "seeded", `${city}: seeded`);
    assert.equal(kb.portalUrl ?? "", "", `${city}: no portal URL on the KB row (the stage launches only a whole URL)`);
    assert.doesNotMatch(kb.portalName ?? "", /^https?:\/\//i, `${city}: portal name is the method's words`);
  }
});

const batteryJob = (ahj: string) => ({ state: "UT", ahj, city: ahj, parserSnapshot: { hasBattery: "Yes", batteryMake: "Examplecell", batteryModel: "EX-13", batteryQty: "1" } }) as unknown as ProjectRecord;
await run("a battery job reads the city's ESS words where its page has them, and 'not on file' where it does not", () => {
  // The rows cite their pages for storage (citations[field=ess]): read as CITED, the page's own words,
  // not as the operator's seeded note (worker-trackissuer; the brief's item 2).
  const bountiful = essPermitStep(batteryJob("Bountiful"))!;
  assert.equal(bountiful.status, "cited", "Bountiful: its page names its battery permit packet");
  assert.ok(bountiful.entries.every((e) => e.basis === "reference_cited" && /^https:\/\//.test(e.sourceUrl)), "Bountiful: every entry is its page, quoted");
  assert.ok(bountiful.entries.some((e) => /fire agency/i.test(e.step) && /approval letter/i.test(e.step)), "Bountiful: the fire agency letter is named");
  for (const city of ["South Jordan", "Salt Lake City"]) {
    const step = essPermitStep(batteryJob(city))!;
    assert.equal(step.status, "cited", `${city}: its page's battery words, cited`);
    assert.ok(step.entries.length && step.entries.every((e) => e.basis === "reference_cited"), `${city}: no seeded-note entries beside the cited ones`);
  }
  for (const city of ["Murray City", "West Jordan", "Ogden", "Syracuse", "Clearfield", "Kaysville"]) {
    assert.equal(essPermitStep(batteryJob(city))!.status, "not_on_file", `${city}: nothing read, so not on file (never assumed)`);
  }
});

db.close();
if (failures > 0) {
  console.error(`\n${failures} Utah seed-data test(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll Utah seed-data tests passed.`);
process.exit(0);
