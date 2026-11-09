// UTILITY PROGRAM LIMITS AND SIMPLIFIED-PERMIT ELIGIBILITY ARE CITED PER-AUTHORITY DATA (#679).
//
// The one program limit the code knew was a single state's 25 kW net-metering cap, coded under a state
// test. These checks pin, on synthetic jobs with invented names only:
//   - that cap now comes from the shipped reference row, and today's output is unchanged (same rule id,
//     name, wording, severity, and the AHJ-name fallback for a payload with no state);
//   - the screen code names no state: the rule id appears in baselineRules.ts only in its rule catalog;
//   - an over-cap job is a WARNING on a seeded row with no verbatim quote, a BLOCKER on a row that names,
//     links and quotes its source with the value, and a warning again when the limit has a condition
//     the job data cannot confirm;
//   - strings per inverter over a simplified permit path's limit → that path is not offered;
//   - an installer certification the client record lacks, a required production meter the plans do
//     not show, and a utility with no program record on file are warnings that say so, never a pass;
//   - research keeps only limits cited to a page the search returned, in words that carry the value;
//   - migration v66 + boot seed; a verified (or official) row is never overwritten (rule 3).
// Run: tsx backend/test/eligibilityLimits.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthorityEligibilityRecord } from "../../shared/src/types";

const { openDatabase } = await import("../src/db");
const { evaluateBaselineRules } = await import("../src/baselineRules");
const {
  acceptProposedLimits, eligibilityRecordsForState, evaluateEligibility, permitPathOffers, saveEligibilityRecord,
  seedEligibilityRecords, stringsPerInverterOf,
} = await import("../src/eligibilityLimits");
const { parseUtilityFilingAnswer } = await import("../src/utilityFilingLookup");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const here = path.dirname(fileURLToPath(import.meta.url));

// ── The shipped row reproduces today's screen exactly ─────────────────────────────────────────
check("the 25 kW program screen: same id, name, wording and warning as before (state, combined size, AHJ-name fallback)", () => {
  const golden = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "baselineOregonGolden.json"), "utf8")) as Array<Record<string, unknown>>;
  const want = golden.find((r) => r.ruleId === "or-nem-residential-25kw");
  assert.ok(want, "golden carries the screen");
  const got = evaluateBaselineRules({ state: "OR", utility: "PGE", dcKw: 60 }).find((r) => r.ruleId === "or-nem-residential-25kw");
  assert.deepEqual(got, want);
  const combined = evaluateBaselineRules({ state: "OR", utility: "PGE", dcKw: 6, combinedDcKw: 26 }).find((r) => r.ruleId === "or-nem-residential-25kw");
  assert.equal(combined?.message, "DC size is 26 kW (combined new + existing system size). Confirm this is not a residential OAR 860-039 net metering project capped at 25 kW.");
  assert.ok(evaluateBaselineRules({ ahj: "Hillsboro", dcKw: 30 }).some((r) => r.ruleId === "or-nem-residential-25kw"), "no-state AHJ fallback still screens");
  assert.ok(!evaluateBaselineRules({ state: "OR", utility: "PGE", dcKw: 25 }).some((r) => r.ruleId === "or-nem-residential-25kw"), "at the cap is not over it");
  assert.ok(!evaluateBaselineRules({ state: "ME", ahj: "Portland", utility: "Example Power", dcKw: 60 }).some((r) => r.ruleId === "or-nem-residential-25kw"));
});

check("no state is named in the screen code: the rule id lives in the reference data, not in evaluateBaselineRules", () => {
  const src = fs.readFileSync(path.join(here, "..", "src", "baselineRules.ts"), "utf8");
  const body = src.slice(src.indexOf("export function evaluateBaselineRules")).replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!body.includes("or-nem-residential-25kw"), "the screen's id is not coded in the evaluator");
  assert.ok(!/860-039/.test(body), "the citation is not coded in the evaluator");
  const elig = fs.readFileSync(path.join(here, "..", "src", "eligibilityLimits.ts"), "utf8");
  assert.ok(!/\b(?:oregon|utah|idaho|nevada|arizona|pacificorp|portland general)\b/i.test(elig.replace(/^\s*\/\/.*$/gm, "")), "eligibilityLimits code names no state or utility");
});

// ── Severity by citation ──────────────────────────────────────────────────────────────────────
const job = (over: Partial<Parameters<typeof evaluateEligibility>[1]> = {}): Parameters<typeof evaluateEligibility>[1] => ({
  state: "ZZ" as string, utility: "Lakeview Municipal Light", ahj: "Town of Lakeview",
  programDcKw: 12, programAcKw: 10, combinedNote: "", dcKw: 12, acKw: 10,
  stringsPerInverter: { value: 2, estimated: false }, micro: false, productionMeterShown: true,
  clientCertifications: [], today: "2026-11-09", ...over,
});
// "ZZ" is not a state: records use a real code with invented authorities.
const J = (over: Partial<Parameters<typeof evaluateEligibility>[1]> = {}) => job({ state: "WY", ...over });
const program = (cite: { quote?: string; sourceUrl?: string; appliesOnlyTo?: string }, extra: Partial<AuthorityEligibilityRecord["limits"]> = {}): AuthorityEligibilityRecord => ({
  authorityKind: "utility_program", state: "WY", authority: "Lakeview Municipal Light", programName: "Lakeview Solar Pilot", confidence: "seeded",
  limits: {
    maxDcKw: { value: 10, ...(cite.appliesOnlyTo ? { appliesOnlyTo: cite.appliesOnlyTo } : {}), citation: { sourceName: "Lakeview Solar Pilot rules", sourceUrl: cite.sourceUrl ?? "https://lakeview.example.gov/solar-pilot", quote: cite.quote ?? "" } },
    ...extra,
  },
});

check("over a seeded cap with no verbatim quote → warning", () => {
  const f = evaluateEligibility([program({})], J());
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, "eligibility.utility-program.maxDcKw");
  assert.equal(f[0].severity, "warning");
  assert.equal(f[0].qcStatus, "warning");
  assert.match(f[0].message, /12 kW is over the Lakeview Solar Pilot limit of 10 kW/);
  assert.match(f[0].message, /seeded, verify/);
});

check("over a cap whose source is named, linked and quoted with the value → blocker", () => {
  const f = evaluateEligibility([program({ quote: "Systems enrolled in the pilot may not exceed 10 kW DC." })], J());
  assert.equal(f[0].severity, "blocker");
  assert.equal(f[0].qcStatus, "fail");
  // A quote that does not carry the value, or no URL, is not the bar.
  assert.equal(evaluateEligibility([program({ quote: "Systems may not exceed the pilot cap." })], J())[0].severity, "warning");
  assert.equal(evaluateEligibility([program({ quote: "Systems may not exceed 10 kW DC.", sourceUrl: "" })], J())[0].severity, "warning");
  // A condition the job data cannot confirm keeps it a warning that asks.
  const cond = evaluateEligibility([program({ quote: "Residential systems may not exceed 10 kW DC.", appliesOnlyTo: "residential customers" })], J());
  assert.equal(cond[0].severity, "warning");
  assert.match(cond[0].message, /for residential customers — confirm whether it applies/);
});

check("a record for another utility, or another state, does not screen this job", () => {
  assert.equal(evaluateEligibility([program({})], J({ utility: "Riverside Electric Coop" })).length, 0);
  assert.equal(evaluateEligibility([program({})], J({ state: "MT" })).length, 0);
});

check("no utility-program record on file → a warning that says so (QC), nothing for the pure legacy call", () => {
  const f = evaluateEligibility([], J(), { reportUnknownProgram: true });
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, "eligibility.utility-program.not-on-file");
  assert.match(f[0].message, /No program limits are on file for Lakeview Municipal Light \(WY\)/);
  assert.equal(evaluateEligibility([program({})], J(), { reportUnknownProgram: true }).filter((x) => x.ruleId.endsWith("not-on-file")).length, 0);
  assert.equal(evaluateEligibility([], J()).length, 0);
});

// ── Permit path offers ────────────────────────────────────────────────────────────────────────
const path2: AuthorityEligibilityRecord = {
  authorityKind: "permit_path", state: "WY", authority: "Lakeview", programName: "Lakeview simplified solar permit", confidence: "seeded",
  limits: {
    maxDcKw: { value: 15, citation: { sourceName: "Lakeview solar packet", sourceUrl: "https://lakeview.example.gov/packet.pdf", quote: "" } },
    maxStringsPerInverter: { value: 2, citation: { sourceName: "Lakeview solar packet", sourceUrl: "https://lakeview.example.gov/packet.pdf", quote: "No more than 2 strings per inverter." } },
  },
};

check("strings per inverter over the path limit → that permit path is not offered (blocker on its verbatim row)", () => {
  const over = J({ stringsPerInverter: { value: 3, estimated: false } });
  const offers = permitPathOffers([path2], over);
  assert.equal(offers.length, 1, "'Town of Lakeview' matches the AHJ record 'Lakeview'");
  assert.equal(offers[0].offered, false);
  assert.match(offers[0].reasons[0], /not offered for this job: 3 strings per inverter is over its 2/);
  const f = evaluateEligibility([path2], over);
  assert.equal(f.find((x) => x.ruleId === "eligibility.permit-path.maxStringsPerInverter")?.severity, "blocker");
  assert.equal(permitPathOffers([path2], J()).at(0)?.offered, true, "2 strings is within the limit");
  assert.equal(permitPathOffers([path2], J({ dcKw: 16 })).at(0)?.offered, false, "over the path's kW ceiling");
});

check("a string count the plans do not state is a warning, never a pass; microinverters have no strings", () => {
  const unread = evaluateEligibility([path2], J({ stringsPerInverter: null }));
  assert.ok(unread.some((x) => x.ruleId === "eligibility.permit-path.maxStringsPerInverter.unconfirmed" && x.severity === "warning"));
  const estimate = stringsPerInverterOf((k) => ({ moduleQty: 20, modulesPerString: 10, invQty: 1 } as Record<string, number>)[k] ?? null);
  assert.deepEqual(estimate, { value: 2, estimated: true });
  const est = evaluateEligibility([path2], J({ stringsPerInverter: estimate }));
  assert.ok(est.some((x) => /module count gives at least 2/.test(x.message)), "an estimate at the limit is unconfirmed");
  assert.equal(evaluateEligibility([path2], J({ stringsPerInverter: null, micro: true })).length, 0);
});

// ── Production meter and installer certification ─────────────────────────────────────────────
const meterCert = program({}, {
  productionMeterRequired: { value: true, citation: { sourceName: "Lakeview interconnection handbook", sourceUrl: "https://lakeview.example.gov/handbook", quote: "A production meter is required." } },
  installerCertification: { value: { name: "Lakeview Solar Installer Card", effectiveFrom: "2026-01-01" }, citation: { sourceName: "Lakeview interconnection handbook", sourceUrl: "https://lakeview.example.gov/handbook", quote: "From January 1, 2026 the installer must hold a Lakeview Solar Installer Card." } },
});

check("installer without the certification → warning; with it → nothing; before its date → nothing", () => {
  const small = J({ programDcKw: 8, dcKw: 8 });
  const missing = evaluateEligibility([meterCert], small);
  assert.ok(missing.some((x) => x.ruleId === "eligibility.utility-program.installerCertification.unconfirmed" && x.severity === "warning" && /client record does not list it/.test(x.message)));
  assert.ok(!evaluateEligibility([meterCert], { ...small, clientCertifications: ["NABCEP PV Associate", "Lakeview solar installer card #123"] }).some((x) => x.ruleId.includes("installerCertification")));
  assert.ok(!evaluateEligibility([meterCert], { ...small, today: "2025-12-31" }).some((x) => x.ruleId.includes("installerCertification")));
  assert.ok(evaluateEligibility([meterCert], { ...small, clientCertifications: null }).some((x) => /no client record/.test(x.message)));
});

check("a required production meter the plans do not show → warning", () => {
  const small = J({ programDcKw: 8, dcKw: 8, clientCertifications: ["Lakeview Solar Installer Card"] });
  assert.equal(evaluateEligibility([meterCert], small).length, 0);
  const f = evaluateEligibility([meterCert], { ...small, productionMeterShown: false });
  assert.equal(f.length, 1);
  assert.equal(f[0].ruleId, "eligibility.utility-program.productionMeterRequired.unconfirmed");
  // Through the baseline: the plan text decides.
  const ctx = { records: [meterCert], clientCertifications: ["Lakeview Solar Installer Card"], today: "2026-11-09" };
  const base = { state: "WY", utility: "Lakeview Municipal Light", dcKw: 8 };
  assert.ok(evaluateBaselineRules({ ...base, projectDescriptionText: "Install 8 kW PV system." }, undefined, ctx).some((r) => r.ruleId.includes("productionMeter")));
  assert.ok(!evaluateBaselineRules({ ...base, projectDescriptionText: "New PV production meter adjacent to the utility meter." }, undefined, ctx).some((r) => r.ruleId.includes("productionMeter")));
  assert.ok(evaluateBaselineRules({ ...base, projectDescriptionText: "No production meter required." }, undefined, ctx).some((r) => r.ruleId.includes("productionMeter")));
});

// ── Research ──────────────────────────────────────────────────────────────────────────────────
check("research keeps a limit only from a page the search returned, in words that carry the value", () => {
  const seen = ["https://lakeview.example.gov/solar-pilot"];
  const r = acceptProposedLimits({
    maxDcKw: { value: 10, citation: { sourceName: "Pilot page", sourceUrl: "https://lakeview.example.gov/solar-pilot", quote: "Pilot systems are capped at 10 kW." } },
    maxAcKw: { value: 8, citation: { sourceName: "Pilot page", sourceUrl: "https://lakeview.example.gov/solar-pilot", quote: "Pilot systems are capped." } },
    productionMeterRequired: { value: true, citation: { sourceName: "Blog", sourceUrl: "https://someblog.example.com/post", quote: "A production meter is required." } },
  }, seen, "2026-11-09T00:00:00.000Z");
  assert.deepEqual(Object.keys(r.limits), ["maxDcKw"]);
  assert.equal(r.limits.maxDcKw?.citation.fetchedAt, "2026-11-09T00:00:00.000Z");
  assert.equal(r.dropped.length, 2);
  const parsed = parseUtilityFilingAnswer(JSON.stringify({
    filing: { value: null, notFound: "x" }, program: { value: null, notFound: "x" },
    limits: { maxDcKw: { value: 10, citation: { sourceName: "Pilot page", sourceUrl: "https://lakeview.example.gov/solar-pilot", quote: "capped at 10 kW" } } },
  }), seen);
  assert.equal(parsed.limits.maxDcKw?.value, 10);
});

// ── Store: migration v66, seed, rule 3 ───────────────────────────────────────────────────────
const db = await openDatabase();

check("migration v66 + boot seed: the shipped row is on file, seeded, cited with URL, quote and fetchedAt", () => {
  const rows = eligibilityRecordsForState(db, "OR");
  const row = rows.find((r) => r.authorityKind === "utility_program" && r.authority === "");
  assert.ok(row);
  assert.equal(row!.confidence, "seeded");
  const c = row!.limits.maxDcKw!.citation;
  assert.ok(c.sourceName && /^https:\/\//.test(c.sourceUrl) && c.quote.includes("25") && c.fetchedAt);
  const stored = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM authority_eligibility_limits WHERE state = 'OR'");
  assert.ok((stored?.n ?? 0) >= 1);
});

check("a verified row is never overwritten by a seed or a lookup; an official row is not replaced by a seed (rule 3)", () => {
  const rec = { authorityKind: "utility_program" as const, state: "WY", authority: "Lakeview Municipal Light", programName: "Lakeview Solar Pilot", limits: program({}).limits };
  assert.equal(saveEligibilityRecord(db, rec).saved, true);
  assert.equal(saveEligibilityRecord(db, rec, { verifiedBy: "Ops Reviewer" }).saved, true);
  const changed = { ...rec, limits: { maxDcKw: { ...rec.limits.maxDcKw!, value: 99 } } };
  const refused = saveEligibilityRecord(db, changed);
  assert.equal(refused.saved, false);
  const after = eligibilityRecordsForState(db, "WY").find((r) => r.authority === "Lakeview Municipal Light");
  assert.equal(after?.limits.maxDcKw?.value, 10);
  assert.equal(after?.confidence, "verified");
  db.run("UPDATE authority_eligibility_limits SET confidence = 'official', verified_at = '', verified_by = '' WHERE authority = 'Lakeview Municipal Light'");
  assert.equal(saveEligibilityRecord(db, changed).saved, false);
  assert.equal(eligibilityRecordsForState(db, "WY").find((r) => r.authority === "Lakeview Municipal Light")?.confidence, "official");
  // The boot seed is idempotent and never touches a verified shipped row.
  db.run("UPDATE authority_eligibility_limits SET verified_at = '2026-11-09', verified_by = 'Ops Reviewer', program_name = 'edited by a person' WHERE state = 'OR' AND authority = ''");
  assert.equal(seedEligibilityRecords(db), 0);
  assert.equal(eligibilityRecordsForState(db, "OR").find((r) => r.authority === "")?.programName, "edited by a person");
});

if (failures) {
  console.error(`\n${failures} eligibility check(s) failed`);
  process.exit(1);
}
console.log("\neligibilityLimits: all checks passed");
