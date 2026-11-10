// PV-ONLY JOBS ARE UNTOUCHED BY THE ESS REVIEW (review-audit draft 05).
//
// The battery review reads storage facts and per-jurisdiction ESS rules. A job with NO storage must
// get exactly the reviewer report it got before that work — finding for finding, word for word —
// including under a jurisdiction whose profile carries ESS rules (cited, verified). The golden was
// captured from the engine WITHOUT the ESS review: first on Helm staging ae6eaca3, then recaptured on
// staging 7d706055 (draft 04's AC-size check and draft 06 changed PV reports there, not this work).
//
// Every job, address and jurisdiction here is invented.
//
// Regenerate ONLY when a PV-side behaviour change is intended:
//   UPDATE_GOLDEN=1 npx tsx backend/test/essReviewPvOnlyGolden.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JurisdictionCodeProfile, ProjectRecord } from "../../shared/src/types";
import { buildReviewerReport } from "../src/reviewerEngine";
import { buildCodeContext } from "../src/codeProfiles";

const base = {
  clientId: "client-ess-golden",
  homeownerName: "Pin Test",
  projectAddress: "1 Example Loop",
  city: "Sample Falls",
  state: "ZZ",
  zip: "00001",
  ahj: "City of Sample Falls",
  utility: "Example Valley Power",
  systemSizeDcKw: 8.6,
  systemSizeAcKw: 7.6,
  interconnectionMethod: "Load-side breaker",
  status: "pending",
};
const pvSnap = {
  state: "ZZ", ahj: "City of Sample Falls", utility: "Example Valley Power",
  dcKw: "8.6", acKw: "7.6", busRating: "200", mainBreaker: "200", pvBreaker: "40",
  moduleMake: "Examplesolar", moduleModel: "EX-430", moduleWattage: "430", moduleQty: "20",
  inverterModel: "EXI-7600", permitPath: "Engineered",
  splitPagesText: "one-line diagram rapid shutdown site plan roof plan",
  projectDescriptionText: "Roof-mounted PV, load side interconnection.",
};

const fixtures: Array<{ name: string; project: ProjectRecord }> = [
  { name: "pv-only plain", project: { ...base, id: "ess-pin-1", parserSnapshot: { ...pvSnap } } as unknown as ProjectRecord },
  {
    name: "pv-only with full sheet text",
    project: {
      ...base, id: "ess-pin-2",
      parserSnapshot: {
        ...pvSnap,
        planSetExtractedText: "SHEET PV-1 SITE PLAN. FIRE ACCESS PATHWAY 36 IN. SHEET PV-3 ELECTRICAL. AC DISCONNECT ON EXTERIOR WALL IN GARAGE SIDE YARD. UL 1741 SA INVERTER. UL 2703 RACKING. SMOKE ALARM NOTE. 3 FT FROM WINDOWS.",
        labelsText: "PHOTOVOLTAIC SYSTEM AC DISCONNECT. RAPID SHUTDOWN SWITCH FOR SOLAR PV SYSTEM.",
      },
    } as unknown as ProjectRecord,
  },
  {
    name: "pv-only with a denied storage line",
    project: { ...base, id: "ess-pin-3", parserSnapshot: { ...pvSnap, hasBattery: "No", batteryModel: "N/A", planSetExtractedText: "BATTERY / ESS: NONE. EQUIPMENT SCHEDULE: (20) PV MODULES, (1) INVERTER." } } as unknown as ProjectRecord,
  },
];

// A jurisdiction whose profile carries ESS rules, cited and verified: none of them may touch a PV job.
const essProfile = {
  key: "zz|city of sample falls|", state: "ZZ", ahj: "City of Sample Falls", confidence: "verified",
  adoptedCodes: [{ code: "NEC", edition: "2023" }, { code: "IRC", edition: "2021" }, { code: "IFC", edition: "2021" }],
  amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], updatedAt: "",
  essRules: { maxUnitKwh: 15, maxAggregateKwhGarage: 40, minUnitSpacingIn: 48, impactProtectionInGarage: true },
  citations: [
    { label: "Invented city ESS handout", sourceUrl: "https://example.invalid/ess", field: "essRules.maxUnitKwh", quote: "Individual units shall not exceed 15 kWh." },
  ],
} as unknown as JurisdictionCodeProfile;

function normalized(): unknown {
  const out: Record<string, unknown> = {};
  for (const f of fixtures) {
    out[`${f.name} / no context`] = { ...buildReviewerReport(f.project), generatedAt: "<normalized>" };
    const ctx = buildCodeContext("ZZ", "City of Sample Falls", essProfile);
    out[`${f.name} / ESS rules on file`] = { ...buildReviewerReport(f.project, { codeContext: ctx }), generatedAt: "<normalized>" };
  }
  return JSON.parse(JSON.stringify(out));
}

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const goldenPath = path.join(fixturesDir, "essReviewPvOnlyGolden.json");

if (process.env.UPDATE_GOLDEN === "1") {
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(goldenPath, JSON.stringify(normalized(), null, 2));
  console.log(`golden written: ${goldenPath}`);
  process.exit(0);
}

let failures = 0;
try {
  const actual = normalized() as Record<string, { findings: Array<{ id: string }> }>;
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(goldenPath, "utf8")));
  const n = Object.values(actual).reduce((sum, r) => sum + r.findings.length, 0);
  console.log(`  ok   - PV-only reviewer reports are byte-identical to the pre-ESS-review engine (${Object.keys(actual).length} reports, ${n} findings)`);
  assert.ok(Object.values(actual).every((r) => !r.findings.some((f) => /^city\.ess\./.test(f.id))), "no ESS finding on a PV-only job");
  console.log("  ok   - no PV-only job carries an ESS finding");
} catch (err) {
  failures++;
  console.error("  FAIL - PV-only reviewer report drifted. If the change is INTENDED, regenerate with UPDATE_GOLDEN=1.");
  console.error(err instanceof Error ? err.message.slice(0, 4000) : String(err));
}
if (failures) process.exit(1);
