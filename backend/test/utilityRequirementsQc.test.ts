// THE QC BASELINE'S UTILITY RULES ARE PER-UTILITY DATA (follow-on to review-audit draft 03).
//
// baselineRules.ts had three QC rules keyed to named utilities (PacifiCorp's UL 1741 SB settings and
// meter evidence, PGE's interconnection package). They are now items on each utility's cited requirement
// list (backend/data/reference-utility-application-requirements.json), read by one generic rule. This
// pins:
//   - TODAY'S OUTPUT, BYTE FOR BYTE: every result evaluateBaselineRules returned BEFORE the move (captured
//     on staging a6947704 into fixtures/utilityRequirementsQcPinned.json), over a matrix of 14 utility
//     spellings x 7 states x 4 packages — PacifiCorp's brands, PGE, PG&E, a Washington PUD, Idaho Power;
//   - the rule catalogue (the `rules` table) keeps the three entries with the same words;
//   - a utility with NO list gets the strict default as a WARNING that says it is not researched;
//   - only a verbatim-cited item may block (Helm's #637 bar);
//   - no utility is named in baselineRules.ts code any more.
// Synthetic data only; no DB, no network.
//   npx tsx backend/test/utilityRequirementsQc.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UtilityApplicationRequirement, UtilityRequirementList } from "../../shared/src/types";

const { evaluateBaselineRules, baselineRuleDefinitions } = await import("../src/baselineRules");

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
let passed = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.log(`  FAIL - ${label}\n         ${(e as Error).message.slice(0, 1500)}`); }
};

// The matrix the fixture was captured over (same order).
const UTILITIES = ["Rocky Mountain Power", "RMP", "PacifiCorp", "Pacific Power", "Rocky Mtn. Power", "Pac Power", "PGE", "Portland General Electric", "P.G.E.", "PG&E", "Pacific Gas and Electric", "Pacific County PUD", "Idaho Power", ""];
const STATES = ["OR", "UT", "ID", "WA", "CA", "WY", ""];
const VARIANTS: Array<Record<string, string>> = [
  {},
  { splitPagesText: "E-1 SLD; PV-1 site plan; module spec; inverter spec", utilityUploadNotesText: "UL 1741 SB listed", meter: "123456", account: "1234567890" },
  { splitPagesText: "single line diagram, plot plan", utilityDownloadChecklistText: "microinverter cut sheet", projectDescriptionText: "smart inverter settings", ubAccountNumber: "1234567890" },
  { splitPagesText: "3-line diagram", ubMeterNumber: "654321", hasBattery: "yes", batteryQty: "1" },
];
const payloads: Array<Record<string, string>> = [];
for (const utility of UTILITIES) for (const state of STATES) for (const v of VARIANTS) payloads.push({ state, utility, ahj: "City of Testville", dcKw: "8", ...v });

const pinned = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "utilityRequirementsQcPinned.json"), "utf8")) as { results: unknown[][]; defs: Array<Record<string, string>> };
const ids = (rs: Array<{ ruleId: string }>) => rs.map((r) => r.ruleId);

console.log("\ntoday's outputs, from data");
check(`PINNED: every result for ${payloads.length} payloads is byte-identical to before the move`, () => {
  assert.equal(pinned.results.length, payloads.length);
  const drift: string[] = [];
  payloads.forEach((p, i) => {
    const now = JSON.stringify(evaluateBaselineRules(p as never));
    if (now !== JSON.stringify(pinned.results[i])) drift.push(`${p.state || "-"} ${p.utility || "-"} v${i % VARIANTS.length}: ${now}`);
  });
  assert.equal(drift.length, 0, drift.slice(0, 3).join("\n"));
  const withUtilityRules = pinned.results.filter((rs) => (rs as Array<{ ruleId: string }>).some((r) => /^(pacpower-|pge-)/.test(r.ruleId))).length;
  assert.ok(withUtilityRules > 50, `the matrix exercises the utility rules (${withUtilityRules} payloads)`);
});
check("PINNED: the rule catalogue keeps pacpower-ul1741sb, pacpower-meter-photo and pge-powerclerk-docs with the same words", () => {
  for (const before of pinned.defs) {
    const now = baselineRuleDefinitions.find((d) => d.id === before.id);
    assert.ok(now, before.id);
    for (const [k, v] of Object.entries(before)) assert.equal((now as unknown as Record<string, string>)[k], v, `${before.id}.${k}`);
  }
});
check("the Utah brand and the PGE package read from data (spot check)", () => {
  const ut = evaluateBaselineRules({ state: "UT", utility: "PacifiCorp" } as never).filter((r) => r.ruleId.startsWith("pacpower-"));
  assert.deepEqual(ut.map((r) => r.ruleName), ["Rocky Mountain Power UL 1741 SB inverter settings", "Rocky Mountain Power meter photo requirement"]);
  const pge = evaluateBaselineRules({ state: "OR", utility: "PGE", ahj: "City of Testville" } as never).find((r) => r.ruleId === "pge-powerclerk-docs");
  assert.equal(pge?.message, "PGE package may be missing: SLD/3-line, site/plot plan, module spec, inverter spec, utility account.");
});

console.log("\na utility with no list: the strict default, as a warning that says so");
check("NOT RESEARCHED: Idaho Power with an empty package warns once, naming what the strictest common set lacks", () => {
  const rs = evaluateBaselineRules({ state: "ID", utility: "Idaho Power" } as never, undefined, undefined, { reportUnresearched: true });
  const f = rs.filter((r) => r.ruleId === "utility-requirements-not-researched");
  assert.equal(f.length, 1, ids(rs).join(","));
  assert.equal(f[0].severity, "warning");
  assert.equal(f[0].qcStatus, "warning");
  assert.equal(f[0].ruleName, "Idaho Power application requirements not researched");
  assert.equal(f[0].message, "Idaho Power's application requirements are not researched, so the strictest common set was checked; the package may be missing: SLD/3-line, site/plot plan, module spec, inverter spec, utility account, meter evidence, UL 1741 SB / inverter settings evidence, AC disconnect. Confirm against the utility's own application.");
});
check("NOT RESEARCHED: a battery job also owes its operating mode; a complete package says nothing; off for bare callers and with no state", () => {
  const full = { splitPagesText: "SLD, site plan, module spec, inverter spec, AC disconnect", utilityUploadNotesText: "UL 1741 SB", meter: "123456", account: "1234567890" };
  const battery = evaluateBaselineRules({ state: "ID", utility: "Idaho Power", ...full, hasBattery: "yes", batteryQty: "1" } as never, undefined, undefined, { reportUnresearched: true });
  assert.match(battery.find((r) => r.ruleId === "utility-requirements-not-researched")?.message ?? "", /missing: battery operating mode\./);
  assert.ok(!ids(evaluateBaselineRules({ state: "ID", utility: "Idaho Power", ...full } as never, undefined, undefined, { reportUnresearched: true })).includes("utility-requirements-not-researched"));
  assert.ok(!ids(evaluateBaselineRules({ state: "ID", utility: "Idaho Power" } as never)).includes("utility-requirements-not-researched"), "bare caller");
  assert.ok(!ids(evaluateBaselineRules({ state: "", utility: "Idaho Power" } as never, undefined, undefined, { reportUnresearched: true })).includes("utility-requirements-not-researched"), "no state");
  assert.ok(!ids(evaluateBaselineRules({ state: "UT", utility: "Rocky Mountain Power" } as never, undefined, undefined, { reportUnresearched: true })).includes("utility-requirements-not-researched"), "a researched utility gets its own list");
});

console.log("\none generic rule over any utility's data");
const item = (over: Partial<UtilityApplicationRequirement>): UtilityApplicationRequirement => ({
  key: "meter_photo", whenMissing: "blocker", tier: "seeded", sourceName: "Example Utility page", sourceUrl: "https://www.utility-example.com/apply",
  quote: "Attach a picture of the meter.", ...over,
});
const list = (items: UtilityApplicationRequirement[]): UtilityRequirementList => ({ displayName: "Example Light & Power", requirements: items });
check("DATA ONLY: a new utility's items report under the generic rule, grouped, with its own name", () => {
  const rs = evaluateBaselineRules({ state: "NV", utility: "Example Light & Power" } as never, undefined, undefined, {
    requirements: list([item({}), item({ key: "one_line", quote: "" })]),
  });
  const f = rs.find((r) => r.ruleId === "utility-application-package");
  assert.equal(f?.message, "Example Light & Power's application may be missing: meter evidence, SLD/3-line.");
  assert.equal(f?.severity, "warning", "no item asks QC for a blocker");
});
check("#637 BAR: an item whose QC wording asks for a blocker blocks only when it quotes its named source in words naming it", () => {
  const qc = { ruleId: "example-meter", ruleName: "{utility} meter", message: "{utility} wants {missing}.", fieldName: "meter", severity: "blocker" as const };
  const cited = evaluateBaselineRules({ state: "NV", utility: "x" } as never, undefined, undefined, { requirements: list([item({ qc })]) }).find((r) => r.ruleId === "example-meter");
  assert.equal(cited?.severity, "blocker");
  assert.equal(cited?.qcStatus, "fail");
  for (const weak of [item({ qc, quote: "" }), item({ qc, quote: "Include a one-line diagram." }), item({ qc, sourceName: "" })]) {
    const r = evaluateBaselineRules({ state: "NV", utility: "x" } as never, undefined, undefined, { requirements: list([weak]) }).find((x) => x.ruleId === "example-meter");
    assert.equal(r?.severity, "warning", JSON.stringify(weak));
  }
});
check("GATES: a reviewer-only item is not a QC item", () => {
  const rs = evaluateBaselineRules({ state: "NV", utility: "x" } as never, undefined, undefined, { requirements: list([item({ gates: ["reviewer"] })]) });
  assert.ok(!ids(rs).includes("utility-application-package"), ids(rs).join(","));
});
check("UNIVERSAL: baselineRules.ts names no utility in code (the #679-owned or-nem-residential-25kw catalogue entry aside)", () => {
  const raw = fs.readFileSync(path.join(here, "..", "src", "baselineRules.ts"), "utf8");
  const start = raw.indexOf('id: "or-nem-residential-25kw"');
  const end = raw.indexOf("},", start);
  assert.ok(start > 0 && end > start, "the #679 entry is where it was");
  const code = (raw.slice(0, start) + raw.slice(end)).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  for (const re of [/knownPowerClerkUtility|pacifiCorpBrand|utilityIdentity/, /PacifiCorp|Pacific Power|Rocky Mountain|Portland General|\bPGE\b|Idaho Power|pacBrand|isPacific|isPge/, /"pacpower-|"pge-/]) {
    assert.ok(!re.test(code), `baselineRules.ts matches ${re}`);
  }
});

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
