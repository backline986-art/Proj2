// THE PRESCRIPTIVE-VS-ENGINEERED SPLIT IS DATA (review-audit draft 14 item 2).
//
// permitPath.ts decided the structural split by `usStateCode(state) === "OR"`, with Oregon's limits,
// its roofing row and the ORSC / BCD 440-5952 wording in code; reviewerEngine.ts recognised the
// statewide ePermitting profile by its id and printed its OAR wording. Both now come from
// per-jurisdiction data: backend/data/reference-jurisdiction-permit-paths.json (a record per state or
// AHJ that publishes a prescriptive rooftop-PV path), and a `statewide` block on the application
// profile. This pins:
//   - TODAY'S OUTPUT, BYTE FOR BYTE: resolvePermitPath, prescriptiveSplitApplies, permitPathCallout,
//     resolveStampRequirement, evaluatePrescriptiveCriteria (with and without jurisdictionOnly) and the
//     roofing-row helpers over a multi-state matrix with messy state spellings, hashed, captured
//     BEFORE the move (fixtures/jurisdictionPermitPathsPinned.json), plus the reviewer's statewide
//     process finding;
//   - a new state or AHJ with a prescriptive path is a record, never code (Nevada / Reno test records);
//   - an unrecognised state still asks (fail-closed), whatever the records say;
//   - a person-verified code profile's limits overlay the record (rule 3), a seeded one never does;
//   - permitPath.ts and reviewerEngine.ts name no state in code.
// Synthetic data only; no network.
//   npx tsx backend/test/jurisdictionPermitPaths.test.ts    (UPDATE_PIN=1 rewrites the pin: intended changes only)
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "juris-path-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "UTILITY_FILING_LOOKUP", "CODE_PROFILE_RESEARCH"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const P = await import("../src/permitPath");
const R = await import("../src/roofCovering");
const { buildReviewerReport } = await import("../src/reviewerEngine");
import type { PrescriptiveLimits, ProjectRecord } from "../../shared/src/types";

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
let passed = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message.slice(0, 1500)}`); }
};
const hashOf = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

// ── The matrix the pin was captured over (same order) ───────────────────────────────────────────────
// Messy spellings on purpose: the normaliser maps the first group to OR, refuses the second ("" → asks).
const STATES = ["OR", "Oregon", "ore.", " or ", "OREG", "Oreg.", "OR 97201", "Portland, OR", "O.R.", "WA", "CA", "FL", "UT", "Utah", "ID", "nevada", "NV", "MA", "XX", ""];
const AHJS = ["City of Portland", "Salem", "South Portland", "Reno", ""];
const SNAPS: Array<Record<string, string>> = [
  {},
  { snow: "25", deadLoad: "3", roofRafterSpacing: "24", wind: "Exposure C", roofMaterial: "Composition shingle" },
  { snow: "80", deadLoad: "3", roofRafterSpacing: "24", wind: "C" },
  { snow: "25", deadLoad: "5", roofRafterSpacing: "32", wind: "D", windSpeed: "140" },
  { snow: "25", deadLoad: "3", roofRafterSpacing: "24", wind: "B", windSpeed: "130" },
  { snow: "25", deadLoad: "3", roofRafterSpacing: "24", wind: "C", windSpeed: "125" },
  { snow: "25", deadLoad: "3", roofRafterSpacing: "16", wind: "C", roofMaterial: "Concrete tile", roofMaterialSubtype: "S-tile" },
  { snow: "25", deadLoad: "3", roofRafterSpacing: "16", wind: "C", roofMaterial: "TPO membrane" },
  { snow: "25", deadLoad: "3", roofRafterSpacing: "16", wind: "C", roofMaterial: "Slate" },
  { snow: "25", deadLoad: "3", roofRafterSpacing: "16", wind: "C", roofMaterial: "Composition shingle", roofLayers: "3" },
  { snow: "25", deadLoad: "3", roofRafterSpacing: "16", wind: "C", roofMaterial: "Cedar shake", roofLayers: "2" },
  { snow: "25", deadLoad: "3", roofRafterSpacing: "16", wind: "C", roofMaterial: "Cedar shake" },
  { snow: "25", deadLoad: "3", roofRafterSpacing: "16", wind: "C", roofMaterial: "Standing seam metal" },
  { permitPathOverride: "prescriptive", snow: "25" },
  { permitPathOverride: "engineered" },
  { permitPath: "engineered" },
  { stampRecommendation: "Requires PE stamp for the structural sheets" },
  { stampRecommendation: "AHJ may require stamped structural documentation", snow: "25", wind: "C" },
  { mounting: "Ground mount", snow: "25", wind: "C" },
  { pvMicroModel: "IQ8M" },
  { snow: "25", deadLoad: "3", roofRafterSpacing: "24", wind: "C", moduleHeightAboveRoof: "20", riskCategory: "II", lightFrame: "yes", mounting: "roof" },
];
const LIMITS: Array<PrescriptiveLimits | undefined> = [
  undefined,
  { hasPrescriptivePath: true, maxGroundSnowPsf: 50, maxPvDeadLoadPsf: 4, maxRafterSpacingIn: 16, allowedWindExposures: ["B"], maxWindSpeedMphExpC: 110, maxWindSpeedMphExpB: 115 },
  { hasPrescriptivePath: false, sourceUrl: "https://example.gov/no-path" },
  { allowedWindExposures: ["B", "C", "D"] },
  { hasPrescriptivePath: true },
];
type Case = { state: string; ahj: string; snap: Record<string, string>; limits: PrescriptiveLimits | undefined };
const cases: Case[] = [];
for (const state of STATES) for (const ahj of AHJS) for (const snap of SNAPS) for (const limits of LIMITS) cases.push({ state, ahj, snap, limits });

const projectOf = (c: Case) => ({ state: c.state, ahj: c.ahj, systemSizeDcKw: 12, parserSnapshot: { ...c.snap } }) as unknown as ProjectRecord;
function outputOf(c: Case): unknown {
  const project = projectOf(c);
  const res = P.resolvePermitPath(project, { limits: c.limits });
  return {
    res,
    split: P.prescriptiveSplitApplies(project, c.limits),
    callout: P.permitPathCallout(res),
    stamp: P.resolveStampRequirement(project, { stampThresholdKwDc: 10, jurisdictionLabel: c.ahj }),
    criteria: P.evaluatePrescriptiveCriteria(project, (c.limits ?? {}) as never),
    criteriaOnly: P.evaluatePrescriptiveCriteria(project, (c.limits ?? {}) as never, { jurisdictionOnly: true }),
  };
}
// The roofing-row helpers, over every covering and layer count (state-free).
const ROOFS: Array<[string, string, string]> = [];
for (const m of ["", "Composition shingle", "Asphalt", "Cedar shake", "Wood shingles", "Standing seam metal", "TPO", "Concrete", "Clay tile", "Slate", "Mystery"]) {
  for (const l of ["", "1", "2", "3", "2 layers"]) ROOFS.push([m, "", l]);
}
const roofOutputs = () => ROOFS.map(([m, s, l]) => [R.oregonRoofingRow(m, s, l), R.assumedRoofLayersNote(m, s, l)]);

// The reviewer's statewide process finding (reviewer.profile.missing) for jobs whose AHJ has no profile.
const REVIEWER_JOBS = [
  { state: "OR", ahj: "City of Testville" },
  { state: "Oregon", ahj: "City of Testville" },
  { state: "WA", ahj: "City of Testville" },
  { state: "UT", ahj: "" },
];
function reviewerProcessFinding(j: { state: string; ahj: string }): unknown {
  const project = {
    id: `rv-${j.state}-${j.ahj}`, clientId: "client-pin", homeownerName: "Pin Test", projectAddress: "1 Test St", city: "Testville",
    state: j.state, zip: "00000", ahj: j.ahj, utility: "Example Electric", systemSizeDcKw: 8, systemSizeAcKw: 7, status: "pending",
    parserSnapshot: { state: j.state, ahj: j.ahj, dcKw: "8", snow: "25", wind: "C" },
  } as unknown as ProjectRecord;
  const f = buildReviewerReport(project).findings.find((x) => x.id === "reviewer.profile.missing");
  return f ? { severity: f.severity, title: f.title, message: f.message } : null;
}

const pinPath = path.join(here, "fixtures", "jurisdictionPermitPathsPinned.json");
if (process.env.UPDATE_PIN === "1") {
  fs.writeFileSync(pinPath, `${JSON.stringify({
    _comment: "Hashes of permitPath outputs over the jurisdictionPermitPaths.test.ts matrix, captured BEFORE the split moved to data (draft 14). UPDATE_PIN=1 rewrites: intended changes only.",
    hashes: cases.map((c) => hashOf(outputOf(c))),
    roofing: hashOf(roofOutputs()),
    reviewer: REVIEWER_JOBS.map(reviewerProcessFinding),
  }, null, 1)}\n`);
  console.log(`pin rewritten: ${cases.length} cases`);
}
const pinned = JSON.parse(fs.readFileSync(pinPath, "utf8")) as { hashes: string[]; roofing: string; reviewer: unknown[] };

console.log("permit path split as data (draft 14)");

check(`byte-identical permit-path outputs over ${cases.length} payloads (${STATES.length} state spellings × ${AHJS.length} AHJs × ${SNAPS.length} plan sets × ${LIMITS.length} limit sets)`, () => {
  assert.equal(pinned.hashes.length, cases.length, "matrix size changed: re-capture on the old code");
  const drift: string[] = [];
  cases.forEach((c, i) => {
    const h = hashOf(outputOf(c));
    if (h !== pinned.hashes[i]) drift.push(`#${i} ${JSON.stringify({ state: c.state, ahj: c.ahj, snap: c.snap, limits: c.limits })}`);
  });
  assert.deepEqual(drift.slice(0, 5), [], `${drift.length} payload(s) drifted`);
});

check("byte-identical roofing-row answers and assumed-layer notes", () => {
  assert.equal(hashOf(roofOutputs()), pinned.roofing);
});

check("byte-identical reviewer statewide-process finding", () => {
  assert.deepEqual(REVIEWER_JOBS.map(reviewerProcessFinding), pinned.reviewer);
});

if (process.env.PIN_ONLY !== "1") {
  const JP = await import("../src/jurisdictionPermitPaths");
  const { findApplicationProfile } = await import("../src/applicationDocs");
  const job = (state: string, ahj: string, snap: Record<string, string>) => ({ state, ahj, systemSizeDcKw: 8, parserSnapshot: { ...snap } }) as unknown as ProjectRecord;
  const clean = { snow: "25", deadLoad: "3", roofRafterSpacing: "16", wind: "C", roofMaterial: "Composition shingle" };

  // A second state and a city as DATA: a temp reference file with the shipped record plus two test ones.
  const shipped = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "reference-jurisdiction-permit-paths.json"), "utf8")) as { records: unknown[] };
  const testFile = path.join(tmpDir, "paths.json");
  fs.writeFileSync(testFile, JSON.stringify({ records: [
    ...shipped.records,
    { state: "NV", ahj: "", displayName: "Testada", ahjNames: [], split: true, code: "TEST-CODE 1", source: "Synthetic test code",
      limits: { maxGroundSnowPsf: 40, maxPvDeadLoadPsf: 4, maxRafterSpacingIn: 24, allowedWindExposures: ["B", "C"], maxWindSpeedMphExpC: 110, maxWindSpeedMphExpB: 120 },
      roofingRow: { name: "the TEST-CODE roofing row", allows: { metal: true, compositionLayers: 1 }, admits: "only metal or one layer of composition", eligible: "metal or one-layer composition", layersLimit: "one layer of composition" } },
    { state: "UT", ahj: "City of Testville", displayName: "Testville", ahjNames: ["testville"], split: true, code: "Testville PV Guide", source: "Synthetic city guide",
      limits: { maxGroundSnowPsf: 30 } },
    { state: "UT", ahj: "", displayName: "No code", ahjNames: [], split: true },
  ] }));
  process.env.JURISDICTION_PERMIT_PATHS_REFERENCE_PATH = testFile;

  check("a new state's prescriptive path is a record: its limits screen, its words, its split", () => {
    const over = P.resolvePermitPath(job("NV", "Reno", { ...clean, snow: "50" }));
    assert.equal(over.path, "engineered");
    assert.match(over.basis.join(" "), /ground snow load 50 psf > 40 psf prescriptive limit/);
    assert.equal(over.standardReview, false, "a published split is never the no-choice standard review");
    assert.equal(P.resolvePermitPath(job("NV", "Reno", clean)).path, "prescriptive");
    assert.equal(P.prescriptiveSplitApplies(job("Nevada", "Reno", {}), undefined), true);
    const wind = P.resolvePermitPath(job("NV", "Reno", { ...clean, windSpeed: "115" }));
    assert.match(wind.basis.join(" "), /ultimate design wind speed 115 mph > 110 mph prescriptive cap/);
  });
  check("its roofing row is its own: allowance and words come from the record", () => {
    const twoLayers = P.resolvePermitPath(job("NV", "Reno", { ...clean, roofLayers: "2" }));
    assert.equal(twoLayers.path, "engineered");
    assert.match(twoLayers.basis.join(" "), /the TEST-CODE roofing row admits one layer of composition/);
    const tile = P.resolvePermitPath(job("NV", "Reno", { ...clean, roofMaterial: "Concrete tile" }));
    assert.match(tile.basis.join(" "), /\(the TEST-CODE roofing row admits only metal or one layer of composition\), so tile-roof PV is non-prescriptive in Testada/);
    const wood = P.resolvePermitPath(job("NV", "Reno", { ...clean, roofMaterial: "Cedar shake" }));
    assert.equal(wood.path, "engineered", "a covering the row does not list (wood here) answers No");
    assert.equal(R.roofingRowAgainst({ metal: true, compositionLayers: 1 }, "Cedar shake", "", "").qualifies, false);
    assert.equal(P.resolvePermitPath(job("NV", "Reno", clean)).basis.some((b) => /assumed a single layer of composition/.test(b)), true);
  });
  check("an AHJ record applies inside its state only, and wins there", () => {
    assert.equal(P.prescriptiveSplitApplies(job("UT", "City of Testville", {}), undefined), true);
    const t = P.resolvePermitPath(job("UT", "City of Testville", { ...clean, snow: "35" }));
    assert.match(t.basis.join(" "), /ground snow load 35 psf > 30 psf prescriptive limit/);
    const other = P.resolvePermitPath(job("UT", "Salt Lake City", clean));
    assert.equal(other.standardReview, true, "another Utah AHJ has no published path: the standard review");
    assert.equal(P.prescriptiveSplitApplies(job("ID", "Testville", {}), undefined), false, "never across a state line");
  });
  check("a record missing its code is no record (never a half-read screen)", () => {
    assert.equal(JP.shippedPermitPathRecords().filter((r) => r.state === "UT" && !r.ahj).length, 0);
  });
  check("the no-path wording names every published split from the data", () => {
    const fl = P.resolvePermitPath(job("FL", "Cape Test", clean));
    assert.match(fl.basis[0], /the screen encoded here is Oregon's ORSC \/ BCD 440-5952 or Testada's TEST-CODE 1, which does not apply in FL/);
  });
  check("fail-closed: an unrecognised spelling still asks, whatever the records hold", () => {
    for (const s of ["NV 89501", "Reno, NV", "N.V.", "Nevada State"]) {
      const r = P.resolvePermitPath(job(s, "Reno", clean));
      assert.equal(r.path, "unknown", s);
      assert.match(r.basis.join(" "), /not a recognised US state spelling/);
    }
  });
  check("a person-verified code profile's limits overlay the record; a seeded or untiered one never does", () => {
    const j = job("NV", "Reno", { ...clean, snow: "35" });
    const own: PrescriptiveLimits = { maxGroundSnowPsf: 30, hasPrescriptivePath: true };
    assert.equal(P.resolvePermitPath(j, { limits: own, limitsTier: "verified" }).path, "engineered");
    assert.match(P.resolvePermitPath(j, { limits: own, limitsTier: "verified" }).basis.join(" "), /35 psf > 30 psf/);
    assert.equal(P.resolvePermitPath(j, { limits: own, limitsTier: "seeded" }).path, "prescriptive");
    assert.equal(P.resolvePermitPath(j, { limits: own }).path, "prescriptive");
  });
  check("no data file: no published path anywhere, so no state is screened on borrowed numbers", () => {
    process.env.JURISDICTION_PERMIT_PATHS_REFERENCE_PATH = path.join(tmpDir, "missing.json");
    const r = P.resolvePermitPath(job("OR", "Salem", clean));
    assert.equal(r.standardReview, true);
    assert.deepEqual(JP.criteriaDefaultLimits(), {});
    assert.equal(P.evaluatePrescriptiveCriteria(job("OR", "Salem", clean), {}).find((x) => x.key === "snowLoad")?.answer, "[verify]");
  });
  delete process.env.JURISDICTION_PERMIT_PATHS_REFERENCE_PATH;

  check("the statewide application profile is recognised by its flag, for the state it names", () => {
    const or = findApplicationProfile(job("Oregon", "City of Testville", {}));
    assert.equal(or.statewide?.state, "OR");
    assert.equal(findApplicationProfile(job("WA", "City of Testville", {})).statewide, undefined);
    assert.equal(findApplicationProfile(job("", "City of Testville", {})).statewide, undefined);
  });
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
