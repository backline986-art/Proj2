// A SHIPPED REFERENCE ROW MAY CLAIM "official"; THE LOADER HONOURS IT ONLY THROUGH THE ONE BAR
// (Helm, 2026-11-10, on the owner's official-source rule; rule 3).
//
// The two shipped files that hold facts rather than doors (reference-eligibility-limits.json and
// reference-utility-application-requirements.json) may carry `tier: "official"` on a row (a record, or a
// requirement item). shared/src/officialSource.ts shippedRowTier is the one answer at load: the source
// host passes isOfficialSourceHost, the quote states the value (quoteCarries for a limit,
// QUOTE_NAMES_REQUIREMENT for an item) and fetchedAt is set. A row short of that lands SEEDED and never
// throws. Official is shown "from [source]", never as verified; a seed never overwrites a person's row;
// an official row replaces a seeded one and is refreshed only from the same hosts.
// The AHJ process file carries filing doors (a portal, an email): it never claims a tier.
// Pins: every official-claimed row in the shipped files meets the bar and loads official; every other row
// loads seeded; bad claims in a scratch file land seeded; the seed writes official without touching a
// person's row. Synthetic jobs and scratch files only; no network.
//   npx tsx backend/test/shippedOfficialRows.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipped-official-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
for (const k of ["BACKGROUND_WORKERS", "UTILITY_FILING_LOOKUP", "PERMIT_PROCESS_LOOKUP"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const EL = await import("../src/eligibilityLimits");
const UR = await import("../src/utilityRequirements");
const { shippedRowTier, isOfficialSourceHost } = await import("../../shared/src/officialSource");

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, "..", "data");
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));

const db = await openDatabase();
let failures = 0;
const check = (label: string, fn: () => void) => {
  try { fn(); console.log(`  ok   - ${label}`); } catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const key = (r: { authorityKind: string; state: string; authority: string }) => `${r.authorityKind}|${r.state}|${r.authority}`;

// ── The shipped files as they are ─────────────────────────────────────────────────────────────
const rawEligibility = readJson("reference-eligibility-limits.json").records as Array<Record<string, any>>;
const rawRequirements = readJson("reference-utility-application-requirements.json").records as Array<Record<string, any>>;
const loadedEligibility = new Map(EL.shippedEligibilityRecords().map((r) => [key(r), r]));

check("the shipped files carry official claims (else this suite pins nothing)", () => {
  assert.ok(rawEligibility.some((r) => r.tier === "official"), "an official program record");
  assert.ok(rawRequirements.some((r) => (r.requirements ?? []).some((i: any) => i.tier === "official")), "an official requirement item");
});

check("every official-claimed program record meets the bar on EVERY limit and loads official", () => {
  for (const raw of rawEligibility.filter((r) => r.tier === "official")) {
    const label = `${raw.state} ${raw.authority}`;
    for (const [k, limit] of Object.entries(raw.limits as Record<string, any>)) {
      const c = limit.citation;
      assert.ok(isOfficialSourceHost(c.sourceUrl), `${label}/${k}: ${c.sourceUrl} is an official host`);
      assert.match(String(c.fetchedAt), /^\d{4}-\d{2}-\d{2}T/, `${label}/${k}: fetchedAt`);
      assert.ok(String(c.quote).length >= 8, `${label}/${k}: a verbatim quote`);
      assert.ok(String(c.sourceName), `${label}/${k}: a named source (#637)`);
    }
    const loaded = loadedEligibility.get(`${raw.authorityKind}|${raw.state}|${raw.authority}`);
    assert.ok(loaded, `${label}: loads`);
    assert.equal(loaded!.confidence, "official", `${label}: honoured as official`);
    assert.ok(!loaded!.verifiedBy && !loaded!.verifiedAt, `${label}: never a person's mark`);
  }
});

check("every program record that does not claim official loads seeded", () => {
  for (const raw of rawEligibility.filter((r) => r.tier !== "official")) {
    const loaded = loadedEligibility.get(`${raw.authorityKind}|${raw.state}|${raw.authority}`);
    if (loaded) assert.equal(loaded.confidence, "seeded", `${raw.state} ${raw.authority}: seeded`);
  }
});

check("every official-claimed requirement item meets the bar, names its item and loads official; the rest load seeded", () => {
  const loaded = UR.shippedUtilityRequirementRecords();
  for (const rec of rawRequirements) {
    const match = loaded.find((l) => l.displayName === (rec.displayName || rec.utility) && l.states.join() === (rec.states as string[]).join());
    assert.ok(match, `${rec.displayName}: loads`);
    for (const raw of rec.requirements as Array<Record<string, any>>) {
      const item = match!.requirements.find((i) => i.key === raw.key && i.quote === String(raw.quote).trim());
      assert.ok(item, `${rec.displayName}/${raw.key}: loads`);
      if (raw.tier === "official") {
        assert.ok(isOfficialSourceHost(raw.sourceUrl), `${rec.displayName}/${raw.key}: official host`);
        assert.match(String(raw.fetchedAt), /^\d{4}-\d{2}-\d{2}T/, `${rec.displayName}/${raw.key}: fetchedAt`);
        assert.ok(UR.QUOTE_NAMES_REQUIREMENT[raw.key as keyof typeof UR.QUOTE_NAMES_REQUIREMENT](String(raw.quote)), `${rec.displayName}/${raw.key}: the quote names the item`);
        assert.equal(item!.tier, "official", `${rec.displayName}/${raw.key}: honoured`);
      } else {
        assert.equal(item!.tier, "seeded", `${rec.displayName}/${raw.key}: seeded`);
      }
      assert.ok(!item!.verifiedBy && !item!.verifiedAt, `${rec.displayName}/${raw.key}: never a person's mark`);
    }
  }
});

check("the AHJ process file (it carries filing doors) never claims a tier", () => {
  for (const p of readJson("reference-ahj-processes.json").profiles as Array<Record<string, unknown>>) {
    for (const k of ["tier", "confidence", "verified", "verifiedBy", "verifiedAt"]) assert.ok(!(k in p), `${p.state} ${p.ahj}: no ${k}`);
  }
});

// ── Bad claims in scratch files: seeded, never a throw ────────────────────────────────────────
const cite = (over: Record<string, unknown> = {}) => ({ sourceName: "Example program sheet", sourceUrl: "https://www.example-town.gov/program.pdf", quote: "Systems may not exceed 12 kW DC.", fetchedAt: "2026-11-10T00:00:00Z", ...over });
const rec = (authority: string, citation: Record<string, unknown>, tier: unknown = "official") =>
  ({ authorityKind: "utility_program", state: "UT", authority, programName: `${authority} program`, tier, limits: { maxDcKw: { value: 12, citation } } });
const scratchEligibility = path.join(tmpDir, "eligibility.json");
fs.writeFileSync(scratchEligibility, JSON.stringify({ records: [
  rec("Good Gov Power", cite()),
  rec("Vendor Host Power", cite({ sourceUrl: "https://www.example-power.net/program.pdf" })),
  rec("Wrong Value Power", cite({ quote: "Systems may not exceed 15 kW DC." })),
  rec("Undated Power", cite({ fetchedAt: "" })),
  rec("No Quote Power", cite({ quote: "" })),
  rec("Claims Verified Power", cite(), "verified"),
  { ...rec("Half Good Power", cite()), limits: { maxDcKw: { value: 12, citation: cite() }, productionMeterRequired: { value: true, citation: cite({ quote: "Inspections are scheduled online." }) } } },
] }));

check("a scratch file's claims: official only where every limit passes; the rest seeded; nothing throws", () => {
  const got = Object.fromEntries(EL.shippedEligibilityRecords(scratchEligibility).map((r) => [r.authority, r.confidence]));
  assert.deepEqual(got, {
    "Good Gov Power": "official",
    "Vendor Host Power": "seeded", // a non-government domain no person recorded for the authority
    "Wrong Value Power": "seeded",
    "Undated Power": "seeded",
    "No Quote Power": "seeded",
    "Claims Verified Power": "seeded", // only a person writes verified
    "Half Good Power": "seeded", // one limit short of the bar holds the record seeded
  });
  const broken = path.join(tmpDir, "broken.json");
  fs.writeFileSync(broken, "{ not json");
  assert.deepEqual(EL.shippedEligibilityRecords(broken), [], "a broken file is no rows, not a throw");
});

check("a scratch requirement file: an item is official only with an official host, a quote naming it and fetchedAt", () => {
  const item = (k: string, over: Record<string, unknown> = {}) => ({ key: k, whenMissing: "blocker", tier: "official", sourceName: "Example checklist", sourceUrl: "https://www.example-town.gov/checklist.pdf", quote: "A visible disconnect switch is required.", fetchedAt: "2026-11-10T00:00:00Z", ...over });
  const file = path.join(tmpDir, "requirements.json");
  fs.writeFileSync(file, JSON.stringify({ records: [{ states: ["UT"], utility: "Example Town Power", displayName: "Example Town Power", matchNames: ["example town power"], requirements: [
    item("ac_disconnect"),
    item("one_line"), // the quote is about a disconnect, not a one-line
    item("site_plan", { sourceUrl: "https://www.example-power.net/checklist.pdf", quote: "Site plan required." }),
    item("meter_photo", { quote: "Photo of the meter base.", fetchedAt: "" }),
    item("owner_signature", { quote: "Agreement signed by the owner.", tier: "verified" }),
  ] }] }));
  const [r] = UR.shippedUtilityRequirementRecords(file);
  const tiers = Object.fromEntries(r.requirements.map((i) => [i.key, i.tier]));
  assert.deepEqual(tiers, { ac_disconnect: "official", one_line: "seeded", site_plan: "seeded", meter_photo: "seeded", owner_signature: "seeded" });
  // Seeded under a blocker claim: the #637 bar still decides (no quote naming the item = a warning).
  const byKey = Object.fromEntries(r.requirements.map((i) => [i.key, UR.requirementMayBlock(i)]));
  assert.equal(byKey.ac_disconnect, true, "official + whenMissing blocker blocks");
  assert.equal(byKey.one_line, false, "a quote that does not name the item never blocks");
});

check("the one bar, directly: no claim = seeded; a claim short of the bar = seeded with its reasons", () => {
  const ok = { sourceUrl: "https://www.example-town.gov/a", quote: "not more than 25 kW", fetchedAt: "2026-11-10T00:00:00Z", quoteStatesValue: (q: string) => q.includes("25") };
  assert.equal(shippedRowTier("official", ok).tier, "official");
  assert.equal(shippedRowTier(undefined, ok).tier, "seeded");
  const short = shippedRowTier("official", { ...ok, sourceUrl: "https://www.example-power.net/a" });
  assert.equal(short.tier, "seeded");
  assert.ok(short.reasons.some((r) => /not a government host/.test(r)), short.reasons.join("; "));
});

// ── The store: official lands official, replaces seeded, never a person's row ─────────────────
check("seeding: an official shipped row replaces a seeded one, never a person's row, and a reboot writes nothing", () => {
  const good = EL.shippedEligibilityRecords(scratchEligibility).find((r) => r.authority === "Good Gov Power")!;
  const { confidence: _c, ...asInput } = good;
  // A seeded row already on file (an older seed) is replaced by the official read.
  EL.saveEligibilityRecord(db, asInput);
  assert.equal(EL.seedEligibilityRecords(db, scratchEligibility) > 0, true, "writes");
  const row = () => db.get<{ confidence: string; verified_by: string }>("SELECT confidence, verified_by FROM authority_eligibility_limits WHERE authority = 'Good Gov Power'")!;
  assert.equal(row().confidence, "official");
  assert.equal(row().verified_by, "");
  assert.equal(EL.seedEligibilityRecords(db, scratchEligibility), 0, "unchanged rows are not rewritten");
  // A seeded shipped row never overwrites the official one.
  const vendor = EL.shippedEligibilityRecords(scratchEligibility).find((r) => r.authority === "Vendor Host Power")!;
  const { confidence: _v, ...vendorInput } = vendor;
  assert.equal(EL.saveEligibilityRecord(db, { ...vendorInput, authority: "Good Gov Power" }).saved, false, "a seed never replaces an official row");
  // A person's row is never touched by the seed.
  EL.saveEligibilityRecord(db, asInput, { verifiedBy: "A Person" });
  assert.equal(EL.seedEligibilityRecords(db, scratchEligibility) >= 0, true);
  assert.equal(row().confidence, "verified", "a person's row stays theirs");
});

check("an official limit is shown from its source, never as verified or as 'seeded, verify'", () => {
  const records = EL.shippedEligibilityRecords(scratchEligibility).filter((r) => r.authority === "Good Gov Power");
  const job = { state: "UT", utility: "Good Gov Power", ahj: "", programDcKw: 14, programAcKw: null, combinedNote: "", dcKw: 14, acKw: null,
    stringsPerInverter: null, micro: true, productionMeterShown: true, clientCertifications: [], today: "2026-11-10" };
  const [f] = EL.evaluateEligibility(records, job);
  assert.ok(f, "over the cap: a finding");
  assert.match(f.message, /from www\.example-town\.gov \(official source, not verified by a person\)/);
  assert.doesNotMatch(f.message, /seeded, verify|verified by [A-Z]/);
});

check("per key, a person's item beats an official shipped item; an official item beats a seeded one", () => {
  const base = { whenMissing: "blocker" as const, sourceName: "x", sourceUrl: "https://www.example-town.gov/a", quote: "A disconnect is required." };
  const official = { ...base, key: "ac_disconnect" as const, tier: "official" as const };
  const seeded = { ...base, key: "ac_disconnect" as const, tier: "seeded" as const, quote: "Seeded words about the disconnect." };
  const person = { ...base, key: "ac_disconnect" as const, tier: "verified" as const, verifiedBy: "A Person", verifiedAt: "2026-11-10T00:00:00Z", quote: "A person's words." };
  assert.equal(UR.mergeRequirements([official], [person])[0].tier, "verified");
  assert.equal(UR.mergeRequirements([seeded], [official])[0].tier, "official");
  assert.equal(UR.mergeRequirements([official], [seeded])[0].tier, "official");
});

db.close();
if (failures) { console.error(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log("\nAll shipped official-row checks passed.");
process.exit(0);
