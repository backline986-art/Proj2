// A PERCENT-OF-COST FEE BRACKET IS A FORMULA, AND A PRINTED STATE SURCHARGE IS READ AT ITS OWN RATE.
//
//   #692  "$180.00 base fee + .5% (of portion over $10,000.00)" was priced at its flat $180 base. A
//         percentage of a cost now computes from the cost its label names (job valuation, total cost
//         of the system) or REFUSES when the job does not carry that cost — never the base.
//   #674  a printed state surcharge is held at the percentage it prints when that percentage is one
//         the state's cited fee record allows — no 12% literal; a rate the record does not allow is
//         not held.
//
// Every AHJ, state record and document here is invented.
//
//   npx tsx backend/test/percentFeeBrackets.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "percent-fee-brackets-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.FEE_RESEARCH = "off";
process.env.CODE_RESEARCH = "off";
process.env.PERMIT_PROCESS_LOOKUP = "off";
delete process.env.PERMIT_VALUATION_CONTRACT_FACTOR;
delete process.env.PERMIT_VALUATION_PER_WATT;

const { openDatabase } = await import("../src/db");
const FS = await import("../src/feeSchedules");
const { stateSurchargeRuleFor } = await import("../src/stateFeeRules");
type ProjectRecord = import("../../shared/src/types").ProjectRecord;
type FeeScheduleFinding = import("../src/feeSchedules").FeeScheduleFinding;
type FeeBracket = import("../src/feeSchedules").FeeBracket;

const db = await openDatabase();
let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const finding = (over: Partial<FeeScheduleFinding>): FeeScheduleFinding => ({
  found: true, reason: "", basis: "flat", brackets: [], notes: "", sourceUrl: "", sourceQuote: "", sourceKind: "official", ...over,
});
const project = (over: Partial<ProjectRecord>): ProjectRecord => ({
  id: "percent-fee-test", state: "WY", ahj: "Town of Quillford", utility: "", systemSizeAcKw: null, systemSizeDcKw: null,
  parserSnapshot: {}, clientId: "", status: "qc_passed", ...over,
} as unknown as ProjectRecord);

const save = (ahj: string, f: Partial<FeeScheduleFinding>, state = "WY"): void => {
  const out = FS.saveFeeSchedule(db, { state, ahj, track: "permit" }, finding({
    sourceUrl: `https://www.${ahj.toLowerCase().replace(/[^a-z]/g, "")}.example.gov/fees`, sourceQuote: String(f.brackets?.[0]?.label ?? ""), ...f,
  }));
  assert.equal(out.saved, true, out.reason);
};
const line = (p: ProjectRecord) => {
  const res = FS.feeForProject(db, p, "permit");
  assert.ok(res && res.lines?.length, "no schedule line");
  return res.lines![0];
};

const VALUE_PORTION = "$180.00 base fee + .5% (of portion over $10,000.00)";
const WIRING_WORDS = "sixty dollars ($60) plus two percent (2%) of total wiring cost";
const COST_MIN_MAX = "Residential Solar Panels 1.5% of cost, min $200, max $1,000";
const WIRING_EXCESS = "$260 plus 1% of wiring cost in excess of $10,000";

// ── #692: the reader ──────────────────────────────────────────────────────────────────
check("R1 every percent-of-cost label is a formula (the flat base is never the answer)", () => {
  for (const label of [VALUE_PORTION, WIRING_WORDS, COST_MIN_MAX, WIRING_EXCESS, "Up to $10,000: (total cost of system x 0.025) + 60"]) {
    assert.equal(FS.bracketDescribesFormula(label), true, label);
  }
});

check("R2 each label parses: base, percent (digits and words), threshold, min/max and the cost it is taken on", () => {
  const v = FS.parsePercentOfCostFormula({ feeUsd: 180, minValuationUsd: 10000.01, label: VALUE_PORTION });
  assert.deepEqual(v && { ...v, quote: "" }, { baseUsd: 180, percent: 0.5, aboveUsd: 10000, minUsd: null, maxUsd: null, basis: "valuation", quote: "" });
  const w = FS.parsePercentOfCostFormula({ feeUsd: 60, label: WIRING_WORDS });
  assert.deepEqual(w && { ...w, quote: "" }, { baseUsd: 60, percent: 2, aboveUsd: 0, minUsd: null, maxUsd: null, basis: "wiring_cost", quote: "" });
  const c = FS.parsePercentOfCostFormula({ feeUsd: 200, label: COST_MIN_MAX });
  assert.deepEqual(c && { ...c, quote: "" }, { baseUsd: 0, percent: 1.5, aboveUsd: 0, minUsd: 200, maxUsd: 1000, basis: "total_cost", quote: "" });
  const x = FS.parsePercentOfCostFormula({ feeUsd: 260, label: WIRING_EXCESS });
  assert.deepEqual(x && { ...x, quote: "" }, { baseUsd: 260, percent: 1, aboveUsd: 10000, minUsd: null, maxUsd: null, basis: "wiring_cost", quote: "" });
  const half = FS.parsePercentOfCostFormula({ feeUsd: 1160, label: "$1,160 plus one-half of one percent (.5%) of the portion of wiring costs over $100,000" });
  assert.equal(half?.percent, 0.5, "words and digits agree");
  assert.equal(half?.aboveUsd, 100000);
});

check("R3 arithmetic: base + percent of the portion over the threshold, clamped to min/max", () => {
  const v = FS.parsePercentOfCostFormula({ feeUsd: 180, minValuationUsd: 10000.01, label: VALUE_PORTION })!;
  assert.equal(FS.evaluatePercentOfCostFormula(v, 30000), 280);
  assert.equal(FS.evaluatePercentOfCostFormula(v, 9000), 180, "below the threshold the base stands");
  assert.equal(FS.evaluatePercentOfCostFormula(v, null), null, "no cost, no number");
  const c = FS.parsePercentOfCostFormula({ feeUsd: 200, label: COST_MIN_MAX })!;
  assert.equal(FS.evaluatePercentOfCostFormula(c, 5000), 200, "the minimum");
  assert.equal(FS.evaluatePercentOfCostFormula(c, 30000), 450);
  assert.equal(FS.evaluatePercentOfCostFormula(c, 100000), 1000, "the maximum");
});

check("R4 MUST-REFUSE: anything the reader cannot place is not parsed (so the bracket refuses)", () => {
  const no = (b: FeeBracket, why: string) => assert.equal(FS.parsePercentOfCostFormula(b), null, why);
  no({ feeUsd: 180, label: VALUE_PORTION }, "an unnamed portion on a bracket not bounded by valuation");
  no({ feeUsd: 175, minValuationUsd: 10000.01, label: VALUE_PORTION }, "printed base is not the stored fee");
  no({ feeUsd: 60, label: "sixty dollars plus two percent of total wiring cost" }, "a base in words only");
  no({ feeUsd: 1160, label: "$1,160 plus .5% of the portion of wiring costs exceeding one hundred thousand dollars" }, "a threshold in words only");
  no({ feeUsd: 120, label: "Permit fee 2% of project valuation" }, "a stored number no part of the label explains");
  no({ feeUsd: 500, label: "$500 or 2% of valuation, whichever is greater" }, "whichever is greater");
  no({ feeUsd: 50, label: "$50 plus 2% of valuation plus 1% of wiring cost" }, "two percentages");
  no({ feeUsd: 60, label: "sixty dollars ($60) plus three percent (2%) of total wiring cost" }, "words and digits disagree");
  assert.equal(FS.bracketDescribesFormula("State surcharge (12% of permit fee)"), false, "a percentage of a FEE is a charge, not this");
  assert.equal(FS.bracketDescribesFormula("Plan Review Fee — 25% of total electrical permit fee"), false);
  assert.equal(FS.bracketDescribesFormula("Solar permit (includes 12% state surcharge)"), false);
});

// ── #692: the quote ───────────────────────────────────────────────────────────────────
save("Town of Quillford", { basis: "valuation", brackets: [
  { minValuationUsd: 0, maxValuationUsd: 10000, feeUsd: 180, label: "$0 - $10,000 | $180.00" },
  { minValuationUsd: 10000.01, feeUsd: 180, label: VALUE_PORTION },
] });
check("Q1 a valuation-priced bracket computes from the job valuation (contract $50,000 → valuation $20,000 → $230), not the $180 base", () => {
  const l = line(project({ ahj: "Town of Quillford", parserSnapshot: { jobValue: "50000" } as never }));
  assert.equal(l.feeUsd, 230, l.reason);
  assert.match(l.bracketLabel, /computed on the job valuation \$20,000: \$230\.00/);
  assert.equal(l.valuationEstimated, false);
});
check("Q2 MUST-REFUSE: no valuation at all → a question, never $180", () => {
  const l = line(project({ ahj: "Town of Quillford" }));
  assert.equal(l.feeUsd, null);
  assert.match(l.reason, /no valuation/i);
});

save("Pellham Township", { basis: "flat", brackets: [{ feeUsd: 200, label: COST_MIN_MAX }] });
check("Q3 a percent of COST is taken on the contract, not the reduced valuation, with its min and max", () => {
  assert.equal(line(project({ ahj: "Pellham Township", parserSnapshot: { jobValue: "30000" } as never })).feeUsd, 450);
  assert.equal(line(project({ ahj: "Pellham Township", parserSnapshot: { contractAmount: "8000" } as never })).feeUsd, 200);
  assert.equal(line(project({ ahj: "Pellham Township", parserSnapshot: { jobValue: "250000" } as never })).feeUsd, 1000);
});
check("Q4 a per-watt contract ESTIMATE prices it but marks the line estimated (8 kW DC × $3/W = $24,000 → $360)", () => {
  const l = line(project({ ahj: "Pellham Township", systemSizeDcKw: 8 }));
  assert.equal(l.feeUsd, 360, l.reason);
  assert.equal(l.valuationEstimated, true);
});
check("Q5 MUST-REFUSE: no contract and no size → the quote asks for the total cost, never the $200 floor", () => {
  const l = line(project({ ahj: "Pellham Township" }));
  assert.equal(l.feeUsd, null);
  assert.match(l.reason, /NO TOTAL COST OF THE SYSTEM/);
});

save("Corvane City", { basis: "flat", brackets: [{ feeUsd: 260, label: WIRING_EXCESS }] });
check("Q6 MUST-REFUSE: a percent of WIRING cost (not carried on a job) refuses, never the $260 base", () => {
  const l = line(project({ ahj: "Corvane City", parserSnapshot: { jobValue: "40000" } as never, systemSizeDcKw: 8 }));
  assert.equal(l.feeUsd, null);
  assert.match(l.reason, /wiring cost/i);
});

save("Brindle Village", { basis: "flat", brackets: [{ feeUsd: 120, label: "Permit fee 2% of project valuation" }] });
check("Q7 MUST-REFUSE: a percent label the reader cannot price refuses as a formula", () => {
  const l = line(project({ ahj: "Brindle Village", parserSnapshot: { jobValue: "40000" } as never }));
  assert.equal(l.feeUsd, null);
  assert.match(l.reason, /FORMULA/);
});

save("Ashfen City", { basis: "flat", brackets: [{ feeUsd: 150, label: "Solar permit | $150.00" }] });
check("Q8 MUST-PASS: a flat bracket is unchanged", () => {
  const l = line(project({ ahj: "Ashfen City", parserSnapshot: { jobValue: "40000" } as never }));
  assert.equal(l.feeUsd, 150);
  assert.equal(l.bracketLabel, "Solar permit | $150.00");
});

check("Q9 the no-snapshot seam: a valuation percent prices from the valuation it is handed; a cost percent refuses", () => {
  const v = FS.lookupPublishedFee(db, { track: "permit", state: "WY", ahj: "Town of Quillford", utility: "", valuationUsd: 30000 });
  assert.equal(v?.feeUsd, 280, v?.basis);
  const c = FS.lookupPublishedFee(db, { track: "permit", state: "WY", ahj: "Pellham Township", utility: "", valuationUsd: 30000 });
  assert.equal(c?.feeUsd, null, "priced a cost percent on a valuation");
});

// ── #674: the printed state surcharge, at the record's rate ──────────────────────────
db.run(
  `INSERT INTO state_permit_rules (state, family, rule_key, value_json, citation, source_url, confidence, updated_at)
   VALUES ('WY', 'fee', 'surcharge', ?, ?, 'https://legislature.example.gov/stat-9-9-999', 'seeded', ?)`,
  [JSON.stringify({ percent: 3, appliesTo: "permit_fees", section: "Synthetic Stat. 9-9-999(2)" }),
    "Synthetic Stat. 9-9-999(2): \"There is imposed a surcharge of three percent of the total permit fees.\"", new Date().toISOString()],
);
const DOC = "https://www.dunmerewy.example.gov/building/fees.pdf";
const ROW = "Residential solar photovoltaic permit | $100.00";
const doc = (sentence: string) => ({
  evidence: [{ url: DOC, via: "http" as const, status: 200, kind: "pdf" as const, bytes: 100, handed: 2 }],
  corpus: [`TOWN OF DUNMERE — BUILDING FEES\n${ROW}\n${sentence}`],
});
const solarFinding = finding({ basis: "flat", brackets: [{ feeUsd: 100, label: "Residential solar photovoltaic permit" }], sourceUrl: DOC, sourceQuote: ROW });
const sentence = (pct: number) => `Note: A ${pct}% surcharge fee as mandated by the State Department of Fire Prevention is applied to all permit fees.`;

check("S1 a printed 3% against the state's 3% record is held on the bracket at 3%", () => {
  const b = FS.corroborateBrackets(solarFinding, doc(sentence(3)), stateSurchargeRuleFor(db, "WY"))[0];
  assert.equal(b.stateSurcharge?.percent, 3);
  assert.match(String(b.stateSurcharge?.quote), /^3% surcharge fee as mandated by the State/);
});
check("S2 MUST-REFUSE: a printed 15% against Oregon's 12% maximum is not held; nor is any rate in a state with no record", () => {
  assert.equal(FS.corroborateBrackets(solarFinding, doc(sentence(15)), stateSurchargeRuleFor(db, "OR"))[0].stateSurcharge, undefined);
  assert.equal(FS.corroborateBrackets(solarFinding, doc(sentence(5)), stateSurchargeRuleFor(db, "WY"))[0].stateSurcharge, undefined, "5% is not WY's 3%");
  assert.equal(FS.corroborateBrackets(solarFinding, doc(sentence(3)), stateSurchargeRuleFor(db, "MT"))[0].stateSurcharge, undefined, "no MT record");
  assert.equal(FS.corroborateBrackets(solarFinding, doc(sentence(12)), stateSurchargeRuleFor(db, "OR"))[0].stateSurcharge?.percent, 12, "control");
});
check("S3 the held 3% survives the save and the read, and the quote adds it ($100 + 3% = $103)", () => {
  const out = FS.saveFeeSchedule(db, { state: "WY", ahj: "Town of Dunmere", track: "permit" }, solarFinding, { corroborateAgainst: doc(sentence(3)) });
  assert.equal(out.saved, true, out.reason);
  const l = line(project({ ahj: "Town of Dunmere" }));
  assert.equal(l.stateSurchargeUsd, 3);
  assert.equal(l.feeUsd, 103);
});
check("S4 the cited lookup surcharge is attached at the record's rate, and refused where the record does not allow it", () => {
  const cited = (percent: number) => ({ percent, quote: `State surcharge (${percent}% of permit fee)`, sourceUrl: "https://www.harlowwy.example.gov/fees" });
  const flat = finding({ brackets: [{ feeUsd: 80, label: "Solar permit" }], sourceUrl: "https://www.harlowwy.example.gov/fees", sourceQuote: "Solar permit $80.00" });
  assert.equal(FS.saveFeeSchedule(db, { state: "WY", ahj: "Harlow Town", track: "permit" }, flat, { citedStateSurcharge: cited(3) }).saved, true);
  assert.equal(line(project({ ahj: "Harlow Town" })).stateSurchargeUsd, 2.4);
  assert.equal(FS.saveFeeSchedule(db, { state: "MT", ahj: "Harlow Town", track: "permit" }, flat, { citedStateSurcharge: cited(3) }).saved, true);
  assert.equal(line(project({ state: "MT", ahj: "Harlow Town" })).stateSurchargeUsd, undefined, "no MT record, nothing held");
});
check("S5 printedSurchargeFitsStateRule: equal, under a statutory maximum, never over it, never without a rule", () => {
  const or = stateSurchargeRuleFor(db, "OR");
  const wy = stateSurchargeRuleFor(db, "WY");
  assert.equal(FS.printedSurchargeFitsStateRule(12, or), true);
  assert.equal(FS.printedSurchargeFitsStateRule(15, or), false);
  assert.equal(FS.printedSurchargeFitsStateRule(3, wy), true);
  assert.equal(FS.printedSurchargeFitsStateRule(2, wy), false, "WY's 3% is not a maximum");
  assert.equal(FS.printedSurchargeFitsStateRule(3, stateSurchargeRuleFor(db, "MT")), false);
});

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows keeps the sqlite handle */ }
if (failures) {
  console.error(`\npercentFeeBrackets: ${failures} FAILED`);
  process.exit(1);
}
console.log("\npercentFeeBrackets: all checks passed");
