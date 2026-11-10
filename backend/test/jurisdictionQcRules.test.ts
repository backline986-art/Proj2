// EACH JURISDICTION'S QC BASELINE SCREENS ARE DATA (review-audit draft 12).
//
// baselineRules.ts named Oregon and Portland in code: an AHJ-name fallback for a job with no state, the
// legacy prescriptive limits and rule ids, the Tier 1 export wording, a manual-disconnect screen and
// Portland's submittal list. They are now records in backend/data/reference-jurisdiction-qc-rules.json
// (overlaid by state_permit_rules rows of family "qc"), read by one generic rule per kind. This pins:
//   - TODAY'S OUTPUT, BYTE FOR BYTE: every result over 2,304 payloads (8 states incl. a spelled-out one
//     and none, 9 AHJ names incl. "South Portland", 4 packages, 8 code contexts), hashed, captured before
//     the move (fixtures/jurisdictionQcPinned.json), and the whole rule catalogue in order;
//   - a new state or city is a record, never code; the AHJ fallback never crosses a named state;
//   - the #637 bar: only a person's screen or a verbatim-cited one may block;
//   - the state_permit_rules overlay (rule 3: a lower tier never replaces a person's screen);
//   - baselineRules.ts names no state, city or state rule id in code (#679's or-nem-residential-25kw
//     catalogue entry aside).
// Synthetic data only; no network.
//   npx tsx backend/test/jurisdictionQcRules.test.ts       (UPDATE_PIN=1 rewrites the pin: intended changes only)
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "juris-qc-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
for (const k of ["CLIENT_NOTIFICATIONS", "BACKGROUND_WORKERS", "DOCUMENT_FETCH", "AHJ_FORM_DOWNLOADS", "AHJ_FORM_RESEARCH", "FEE_RESEARCH", "PORTAL_URL_RESEARCH", "RUN_TRIAGE", "UTILITY_FILING_LOOKUP"]) process.env[k] = "off";
delete process.env.ANTHROPIC_API_KEY;

const { openDatabase } = await import("../src/db");
const { evaluateBaselineRules, baselineRuleDefinitions } = await import("../src/baselineRules");
const J = await import("../src/jurisdictionQcRules");
import type { JurisdictionQcRecord, JurisdictionQcScreen } from "../src/jurisdictionQcRules";
import type { StatePermitRule } from "../../shared/src/types";

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
let passed = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message.slice(0, 1500)}`); }
};
const ids = (rs: Array<{ ruleId: string }>) => rs.map((r) => r.ruleId);

// ── The matrix the pin was captured over (same order) ───────────────────────────────────────────────
const STATES = ["OR", "WA", "CA", "ME", "FL", "UT", "OREGON", ""];
const AHJS = ["City of Portland", "Hillsboro", "Oregon City", "Salem", "Washington County", "Clackamas County", "City of Testville", "South Portland", ""];
const VARIANTS: Array<Record<string, string>> = [
  { dcKw: "8" },
  { dcKw: "60", exportKw: "30", snow: "90", deadLoad: "5", roofRafterSpacing: "32", wind: "D", acDiscReq: "", splitPagesText: "cover sheet", utility: "Example Electric" },
  { dcKw: "8", exportKw: "5", snow: "25", deadLoad: "3", roofRafterSpacing: "24", wind: "Exposure C", acDiscReq: "lockable disconnect shown", splitPagesText: "site plan, fire pathways, roof framing plan, cross section, racking attachment detail", utility: "Example Electric" },
  { dcKw: "40", combinedDcKw: "55", existingDcKw: "15", wind: "B", acDiscReq: "no", splitPagesText: "plot plan; mounting detail", sitePlanNotesText: "access path 36 in" },
];
type Ctx = { state: string; ahj: string; prescriptive: Record<string, unknown> } | undefined;
const CTXS: Array<(state: string, ahj: string) => Ctx> = [
  () => undefined,
  (_s, a) => ({ state: "OR", ahj: a, prescriptive: { maxGroundSnowPsf: 70, maxPvDeadLoadPsf: 4.5, maxRafterSpacingIn: 24, allowedWindExposures: ["B", "C"], maxExportKwWithoutStudy: 25, hasPrescriptivePath: true } }),
  (s, a) => ({ state: s, ahj: a, prescriptive: {} }),
  (s, a) => ({ state: s, ahj: a, prescriptive: { allowedWindExposures: ["B", "C", "D"] } }),
  (s, a) => ({ state: s, ahj: a, prescriptive: { maxGroundSnowPsf: 50, maxExportKwWithoutStudy: 20 } }),
  (s, a) => ({ state: s, ahj: a, prescriptive: { hasPrescriptivePath: false, maxGroundSnowPsf: 50, maxExportKwWithoutStudy: 20 } }),
  () => ({ state: "", ahj: "", prescriptive: { minGroundSnowCitation: "R301" } }),
  (s, a) => ({ state: s, ahj: a, prescriptive: { hasPrescriptivePath: true, allowedWindExposures: ["B"], maxPvDeadLoadPsf: 4, maxRafterSpacingIn: 16 } }),
];
const cases: Array<{ payload: Record<string, string>; ctx: Ctx }> = [];
for (const state of STATES) for (const ahj of AHJS) for (const v of VARIANTS) for (const c of CTXS) cases.push({ payload: { state, ahj, ...v }, ctx: c(state, ahj) });
const hashOf = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

const pinPath = path.join(here, "fixtures", "jurisdictionQcPinned.json");
const pinned = JSON.parse(fs.readFileSync(pinPath, "utf8")) as { _comment: string; hashes: string[]; catalogue: unknown[] };
if (process.env.UPDATE_PIN === "1") {
  pinned.hashes = cases.map((c) => hashOf(evaluateBaselineRules(c.payload as never, c.ctx as never)));
  pinned.catalogue = baselineRuleDefinitions;
  fs.writeFileSync(pinPath, JSON.stringify(pinned));
  console.log(`pin rewritten: ${pinPath}`);
}

console.log("\ntoday's outputs, from data");
check(`PINNED: every result for ${cases.length} payloads (states x AHJs x packages x code contexts) is byte-identical to before the move`, () => {
  assert.equal(pinned.hashes.length, cases.length);
  const drift: string[] = [];
  cases.forEach((c, i) => {
    const now = evaluateBaselineRules(c.payload as never, c.ctx as never);
    if (hashOf(now) !== pinned.hashes[i]) drift.push(`${JSON.stringify(c.payload)} ctx=${JSON.stringify(c.ctx)}: ${JSON.stringify(now)}`);
  });
  assert.equal(drift.length, 0, `${drift.length} drifted, e.g.\n${drift.slice(0, 2).join("\n")}`);
});
check("PINNED: the rule catalogue (the `rules` table) is the same entries, words and order", () => {
  assert.equal(JSON.stringify(baselineRuleDefinitions), JSON.stringify(pinned.catalogue));
});
check("the shipped records carry the moved screens (spot check)", () => {
  const or = evaluateBaselineRules({ state: "OR", ahj: "City of Portland", dcKw: "60", exportKw: "30", splitPagesText: "cover" } as never);
  for (const id of ["or-nem-tier1-export-25kw", "or-nem-manual-disconnect", "or-prescriptive-snow-70", "or-fire-pathways", "portland-submittal-docs"]) assert.ok(ids(or).includes(id), id);
  assert.equal(or.find((r) => r.ruleId === "portland-submittal-docs")?.message, "Portland package may be missing: site/plot plan, fire access path, roof framing/roof plan, roof cross-section, racking attachment.");
  const me = evaluateBaselineRules({ state: "ME", ahj: "South Portland", dcKw: "60", exportKw: "30" } as never);
  assert.ok(!ids(me).some((id) => /^(or-|portland-)/.test(id)), `a named other state never falls under the AHJ fallback: ${ids(me)}`);
});

console.log("\none generic rule over any jurisdiction's data");
const nv: JurisdictionQcRecord[] = [
  {
    state: "NV", ahj: "", displayName: "Nevada", ahjNames: ["nevada", "reno"],
    prescriptive: { publishesPath: true, defaults: { maxGroundSnowPsf: 40, maxExportKwWithoutStudy: 15 }, ruleIds: { snow: "nv-snow-40" }, exportScreen: { ruleName: "Nevada export screen", message: "Over the {limit} kW screen: {dcKw} kW DC / {exportKw} kW export." } },
    screens: [{ kind: "manual_disconnect", ruleId: "nv-disconnect", ruleName: "Nevada disconnect", message: "Show the disconnect.", fieldName: "acDiscReq", tier: "seeded" }],
  },
  {
    state: "NV", ahj: "Reno", displayName: "Reno", ahjNames: ["reno"],
    screens: [{ kind: "submittal_documents", ruleId: "reno-docs", ruleName: "Reno documents", message: "Reno wants: {missing}.", fieldName: "splitPagesText", tier: "seeded", items: [{ key: "roof_cross_section", label: "a roof section" }, { key: "site_plan", label: "a site plan" }] }],
  },
];
check("DATA ONLY: a new state and city are records — their screens, ids and words, with no code", () => {
  const rs = evaluateBaselineRules({ state: "NV", ahj: "City of Reno", dcKw: "40", exportKw: "20", splitPagesText: "site plan" } as never, undefined, undefined, {}, { records: nv });
  assert.deepEqual(ids(rs).filter((id) => /^(nv-|reno-|jurisdiction-|nv$)/.test(id)), ["nv-export-study-screen", "nv-disconnect", "nv-snow-40", "reno-docs"]);
  assert.equal(rs.find((r) => r.ruleId === "nv-export-study-screen")?.message, "Over the 15 kW screen: 40 kW DC / 20 kW export.");
  assert.equal(rs.find((r) => r.ruleId === "reno-docs")?.message, "Reno wants: a roof section.");
  assert.equal(rs.find((r) => r.ruleId === "nv-snow-40")?.ruleName, "Nevada prescriptive snow limit");
  const noState = evaluateBaselineRules({ state: "", ahj: "Reno", dcKw: "8" } as never, undefined, undefined, {}, { records: nv });
  assert.ok(ids(noState).includes("nv-disconnect"), "a job with no state falls under the record its AHJ names");
  const other = evaluateBaselineRules({ state: "CA", ahj: "Reno Street", dcKw: "8" } as never, undefined, undefined, {}, { records: nv });
  assert.ok(!ids(other).some((id) => /^(nv-|reno-)/.test(id)), "never across a named state");
});
const blockerScreen = (over: Partial<JurisdictionQcScreen>): JurisdictionQcRecord[] => [{
  state: "NV", ahj: "", displayName: "Nevada", ahjNames: [],
  screens: [{ kind: "manual_disconnect", ruleId: "nv-disconnect", ruleName: "Nevada disconnect", message: "Show the disconnect.", fieldName: "acDiscReq", severity: "blocker", source: "NAC 704.0001", sourceUrl: "https://www.example.gov/nac", quote: "A lockable disconnect shall be shown.", tier: "seeded", ...over }],
}];
check("#637 BAR: a screen asking for a blocker blocks only when a person recorded it or it quotes its named source", () => {
  const sev = (records: JurisdictionQcRecord[]) => evaluateBaselineRules({ state: "NV", dcKw: "8" } as never, undefined, undefined, {}, { records }).find((r) => r.ruleId === "nv-disconnect");
  assert.deepEqual([sev(blockerScreen({}))?.qcStatus, sev(blockerScreen({}))?.severity], ["fail", "blocker"]);
  for (const weak of [{ quote: undefined }, { source: undefined }, { sourceUrl: undefined }]) assert.equal(sev(blockerScreen(weak))?.severity, "warning", JSON.stringify(weak));
  assert.equal(sev(blockerScreen({ quote: undefined, source: undefined, sourceUrl: undefined, tier: "verified" }))?.severity, "blocker", "a person's screen");
  assert.equal(sev(blockerScreen({ source: undefined, tier: "official" }))?.severity, "blocker", "an official read with its quote and URL");
  assert.equal(sev(blockerScreen({ severity: undefined }))?.severity, "warning", "no ask, no blocker");
  const shipped = J.shippedJurisdictionQcRecords().flatMap((r) => r.screens);
  assert.ok(shipped.length >= 2 && shipped.every((s) => !J.jurisdictionScreenMayBlock(s) || s.severity !== "blocker"), "no shipped screen blocks");
});

console.log("\nthe state_permit_rules overlay");
const row = (over: Partial<StatePermitRule>): StatePermitRule => ({ state: "OR", family: "qc", key: "or-nem-manual-disconnect", value: {}, citation: "", sourceUrl: "", confidence: "seeded", ...over });
check("OVERLAY: a person's row rewords a shipped screen; a lower tier never replaces a person's; a new ruleId adds a city screen", () => {
  const shipped = J.shippedJurisdictionQcRecords();
  const person = J.overlayJurisdictionRows(shipped, [row({ confidence: "verified", value: { message: "Show the lockable disconnect on the one-line." } })]);
  const msg = (records: JurisdictionQcRecord[]) => evaluateBaselineRules({ state: "OR", dcKw: "8" } as never, undefined, undefined, {}, { records }).find((r) => r.ruleId === "or-nem-manual-disconnect")?.message;
  assert.equal(msg(person), "Show the lockable disconnect on the one-line.");
  assert.equal(msg(J.overlayJurisdictionRows(person, [row({ confidence: "seeded", value: { message: "older words" } })])), "Show the lockable disconnect on the one-line.", "rule 3");
  assert.equal(msg(shipped), "AC/manual disconnect requirement was not clearly identified. Confirm lockable load-break disconnect or documented utility exception.", "the shipped seed is not mutated");
  const city = J.overlayJurisdictionRows(shipped, [row({ key: "salem-docs", value: { kind: "submittal_documents", ruleName: "Salem documents", message: "Salem wants: {missing}.", fieldName: "splitPagesText", ahjNames: ["salem"], ahj: "Salem", items: [{ key: "roof_framing", label: "framing" }] } })]);
  const rs = evaluateBaselineRules({ state: "OR", ahj: "City of Salem", dcKw: "8", splitPagesText: "site" } as never, undefined, undefined, {}, { records: city });
  assert.equal(rs.find((r) => r.ruleId === "salem-docs")?.message, "Salem wants: framing.");
});
const db = await openDatabase();
check("OVERLAY FROM THE DB: QC's resolve reads the state's family \"qc\" rows (a person's row = verified_at set)", () => {
  db.run(`INSERT INTO state_permit_rules (state, family, rule_key, value_json, citation, source_url, confidence, verified_at, verified_by, updated_at)
          VALUES ('OR', 'qc', 'or-nem-manual-disconnect', ?, 'A disconnect switch shall be lockable.', 'https://www.example.gov/oar', 'seeded', '2026-11-10', 'A. Person', '2026-11-10')`,
  [JSON.stringify({ severity: "blocker" })]);
  for (const [state, ahj] of [["OR", "City of Testville"], ["", "Hillsboro"]]) {
    const records = J.resolveJurisdictionQcRecords(db, state, ahj);
    const r = evaluateBaselineRules({ state, ahj, dcKw: "8" } as never, undefined, undefined, {}, { records }).find((x) => x.ruleId === "or-nem-manual-disconnect");
    assert.deepEqual([r?.severity, r?.message], ["blocker", "AC/manual disconnect requirement was not clearly identified. Confirm lockable load-break disconnect or documented utility exception."], `${state || "-"} ${ahj}`);
  }
  assert.equal(J.resolveJurisdictionQcRecords(db, "WA", "Vancouver"), J.shippedJurisdictionQcRecords(), "another state reads nothing of Oregon's rows");
});

console.log("\nuniversal");
check("UNIVERSAL: baselineRules.ts names no state, city or state-prefixed rule id in code (#679's or-nem-residential-25kw entry aside)", () => {
  const raw = fs.readFileSync(path.join(here, "..", "src", "baselineRules.ts"), "utf8");
  const start = raw.indexOf("  {\n    id: \"or-nem-residential-25kw\"");
  const end = raw.indexOf("  },\n", start);
  assert.ok(start > 0 && end > start, "the #679 entry is where it was");
  const code = (raw.slice(0, start) + raw.slice(end + 5)).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/ .*$/, "")).join("\n");
  const STATE_NAMES = ["Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"];
  const CODES = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
  const hits: string[] = [];
  for (const n of STATE_NAMES) if (new RegExp(`\\b${n}\\b`, "i").test(code)) hits.push(n);
  for (const c of CODES) if (new RegExp(`["'\`]${c}["'\`]`).test(code)) hits.push(`"${c}"`);
  for (const re of [/portland|hillsboro|beaverton|gresham|clackamas|salem/i, /["'`](or|wa|ca)-[a-z]/, /\bOAR\b|\bBCD\b|isOregon|isPortland/]) if (re.test(code)) hits.push(String(re));
  assert.deepEqual(hits, []);
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
