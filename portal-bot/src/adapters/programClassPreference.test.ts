// A RESIDENTIAL LEARN MUST NOT LAND ON THE COMMERCIAL PROGRAM BECAUSE IT WAS LISTED FIRST (#693).
//
// chooseProgram walked PROGRAM_PREFER tier by tier and took the FIRST eligible option that
// matched, in DOM order. A utility listing "Commercial Net Metering Application" above
// "Residential Net Metering Application" gave a home's learn the commercial program, and the
// recipe recorded that label for every replay on the tenant.
//
// Pinned here, with invented program names only:
//   - commercial above residential -> residential chosen (and the reverse for a commercial job);
//   - a single fitting option, and a portal whose first program already fits -> same pick as before;
//   - two options the labels do not settle -> undefined (the supervising person picks);
//   - a program naming only the other class is never taken;
//   - printed kW thresholds read against the job's size;
//   - PROGRAM_EXCLUDE behaviour unchanged.
// Browser-free:  npx tsx portal-bot/src/adapters/programClassPreference.test.ts
import assert from "node:assert/strict";
import {
  PROGRAM_EXCLUDE,
  chooseProgram,
  explainProgramChoice,
  explainRecordTypeChoice,
  jobClassOf,
  namesJobClassAndDiscipline,
  programClassFit,
  readSizeBound,
  type ProgramGroup,
} from "./applicationProgram";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const group = (labels: string[], area = 1000): ProgramGroup[] => [{
  area,
  options: labels.map((label, i) => ({ key: `k${i}`, label, radio: true })),
}];

check("THE REGRESSION: commercial listed above residential -> the residential program", () => {
  const g = group(["Commercial Net Metering Application", "Residential Net Metering Application"]);
  assert.equal(chooseProgram(g)?.label, "Residential Net Metering Application");
});

check("...and 'Large Generator Interconnection' above 'Net Metering' -> Net Metering", () => {
  const g = group(["Large Generator Interconnection", "Net Metering"]);
  assert.equal(chooseProgram(g)?.label, "Net Metering");
});

check("...and 'Small Commercial' is commercial, not 'small'", () => {
  const g = group(["Small Commercial Interconnection", "Home Solar Interconnection"]);
  assert.equal(chooseProgram(g)?.label, "Home Solar Interconnection");
});

check("a job HELD as commercial gets the commercial program, whichever is first", () => {
  const g = group(["Residential Net Metering Application", "Commercial Net Metering Application"]);
  assert.equal(chooseProgram(g, "", { jobClass: "commercial" })?.label, "Commercial Net Metering Application");
});

check("a portal whose FIRST program already fits is left alone (same pick as before #693)", () => {
  const g = group(["Residential Net Metering Application", "Commercial Net Metering Application"]);
  assert.equal(chooseProgram(g)?.label, "Residential Net Metering Application");
});

check("a single fitting option is unchanged (pinned)", () => {
  assert.equal(chooseProgram(group(["Distributed Generation", "Distributed Generation Rebates"]))?.label, "Distributed Generation");
  assert.equal(chooseProgram(group(["Interconnection Application", "Contact Us"]))?.label, "Interconnection Application");
});

check("STRICT DEFAULT: two class-ambiguous options -> undefined, never DOM order", () => {
  const g = group(["Net Metering Application", "Interconnection Application"]);
  assert.equal(chooseProgram(g), undefined);
  const why = explainProgramChoice(g);
  assert.equal(why.reason, "ambiguous");
  assert.deepEqual(why.candidates, ["Net Metering Application", "Interconnection Application"]);
});

check("...two that BOTH name this job's class are still ambiguous", () => {
  const g = group(["Residential Net Metering", "Residential Interconnection Upgrade"]);
  assert.equal(chooseProgram(g), undefined);
});

check("a program naming only the other class is never taken, even alone", () => {
  const g = group(["Commercial Interconnection", "Interconnection Rebates"]);
  assert.equal(chooseProgram(g), undefined);
  assert.equal(explainProgramChoice(g).reason, "other_class");
});

check("...but a looser tier that IS ours still wins over a stricter tier that is not", () => {
  const g = group(["Commercial Interconnection", "Residential Solar PV"]);
  assert.equal(chooseProgram(g)?.label, "Residential Solar PV");
});

check("a label naming both classes fits either job", () => {
  const g = group(["Commercial Net Metering", "Residential and Small Commercial Net Metering"]);
  assert.equal(chooseProgram(g)?.label, "Residential and Small Commercial Net Metering");
  assert.equal(programClassFit("Residential and Small Commercial Net Metering", { jobClass: "commercial" }), "fits");
});

check("printed kW thresholds read against the job's size", () => {
  const g = group(["Net Metering over 25 kW", "Net Metering up to 25 kW"]);
  assert.equal(chooseProgram(g, "", { sizeKw: 8.4 })?.label, "Net Metering up to 25 kW");
  assert.equal(chooseProgram(g, "", { sizeKw: 40 })?.label, "Net Metering over 25 kW");
  // Size unknown: a floor reads as the large class, a ceiling as the small one.
  assert.equal(chooseProgram(g)?.label, "Net Metering up to 25 kW");
  // A residential label whose ceiling the job exceeds is not this job's program.
  assert.equal(programClassFit("Residential Net Metering (up to 10 kW)", { sizeKw: 12 }), "contradicts");
  // Inside the bound but naming only the other class: still not a home's program.
  assert.equal(programClassFit("Small Commercial up to 25 kW", { sizeKw: 8 }), "contradicts");
});

check("readSizeBound reads the shapes portals print, and not energy (kWh)", () => {
  assert.deepEqual(readSizeBound("Level 1 (≤ 25 kW)"), { max: 25, maxExclusive: false });
  assert.deepEqual(readSizeBound("Systems under 10 kWac"), { max: 10, maxExclusive: true });
  assert.deepEqual(readSizeBound("Greater than 1 MW"), { min: 1000, minExclusive: true });
  assert.deepEqual(readSizeBound("25 kW or less"), { max: 25 });
  assert.deepEqual(readSizeBound("25 kW and above"), { min: 25 });
  assert.deepEqual(readSizeBound("25-2,000 kW"), { min: 25, max: 2000 });
  assert.deepEqual(readSizeBound("10 kW to 1 MW"), { min: 10, max: 1000 });
  assert.equal(readSizeBound("Net Metering 500 kWh credit"), undefined);
  assert.equal(readSizeBound("Net Metering Application"), undefined);
});

check("PROGRAM_EXCLUDE behaviour unchanged: a residential REBATE is still never chosen", () => {
  assert.equal(PROGRAM_EXCLUDE.test("Residential Solar Rebate"), true);
  const g = group(["Residential Solar Rebate", "Commercial Net Metering", "Net Metering"]);
  assert.equal(chooseProgram(g)?.label, "Net Metering");
});

check("the permit track reads class too ('Commercial Building Permit' listed first)", () => {
  const g = group(["Commercial Building Permit", "Residential Building Permit"]);
  assert.equal(chooseProgram(g, "structural")?.label, "Residential Building Permit");
});

check("tightest group still decides first; an ambiguous tight group is not rescued by a looser one", () => {
  const groups: ProgramGroup[] = [
    { area: 50000, options: [{ key: "a", label: "Interconnection", radio: false }, { key: "b", label: "Help", radio: false }] },
    { area: 1000, options: [{ key: "c", label: "Net Metering", radio: true }, { key: "d", label: "Interconnection Application", radio: true }] },
  ];
  assert.equal(chooseProgram(groups), undefined);
});

check("jobClassOf: residential unless the project is held as commercial", () => {
  assert.equal(jobClassOf({}), "residential");
  assert.equal(jobClassOf(null), "residential");
  assert.equal(jobClassOf({ projectClass: "residential" }), "residential");
  assert.equal(jobClassOf({ projectClass: "Commercial" }), "commercial");
  assert.equal(jobClassOf({ projectClass: "probably commercial" }), "residential");
});

// ---------------------------------------------------------------------------
// THE SAME RULE FOR A RECORD-TYPE LIST (#176). Accela tenants list Commercial groups first; the
// record-type pass took the first solar label in DOM order — "Commercial Electrical Solar Array"
// — for a residential job (owner-watched City of Meridian run). explainRecordTypeChoice is the
// pass's tier walk through programClassFit; namesJobClassAndDiscipline is the expansion pass's
// "which group to open" reading. Invented labels; the tiers are the pass's own.
// ---------------------------------------------------------------------------
const TIERS = [/solar|photovoltaic|\bpv\b/i, /residential\s*[-–—]?\s*electrical/i];
const ELECTRICAL = /\belectrical\b/i;

check("THE REGRESSION (#176): the other class's solar type listed first -> this class's solar type", () => {
  const labels = ["Commercial Addition", "Commercial Electrical Solar Array", "Residential Electrical Floor Heat", "Residential Electrical Solar Array"];
  const c = explainRecordTypeChoice(labels, TIERS, {}, ELECTRICAL);
  assert.equal(c.reason, "matched");
  assert.equal(labels[c.index!], "Residential Electrical Solar Array");
});

check("...and the reverse for a commercial job", () => {
  const labels = ["Residential Electrical Solar Array", "Commercial Electrical Solar Array"];
  const c = explainRecordTypeChoice(labels, TIERS, { jobClass: "commercial" }, ELECTRICAL);
  assert.equal(labels[c.index!], "Commercial Electrical Solar Array");
});

check("only the other class's type offered -> other_class, names it, picks nothing (never DOM order)", () => {
  const c = explainRecordTypeChoice(["Commercial Electrical Solar Array", "Residential Building Deck"], TIERS, {}, ELECTRICAL);
  assert.equal(c.reason, "other_class");
  assert.equal(c.index, undefined);
  assert.deepEqual(c.candidates, ["Commercial Electrical Solar Array"]);
});

check("a tier whose matches are all the other class is passed over; the next tier may still hold ours", () => {
  const labels = ["Commercial Solar Array", "Residential - Electrical"];
  const c = explainRecordTypeChoice(labels, TIERS, {}, ELECTRICAL);
  assert.equal(labels[c.index!], "Residential - Electrical");
});

check("two of our class at the deciding tier: the discipline's words settle it", () => {
  const labels = ["Residential Building Solar Array", "Residential Electrical Solar Array"];
  const c = explainRecordTypeChoice(labels, TIERS, {}, ELECTRICAL);
  assert.equal(labels[c.index!], "Residential Electrical Solar Array");
  const s = explainRecordTypeChoice(labels, TIERS, {}, /\bstructural\b|\bbuilding\b/i);
  assert.equal(labels[s.index!], "Residential Building Solar Array");
});

check("two the labels do not settle -> ambiguous, both named, nothing picked", () => {
  const c = explainRecordTypeChoice(["Residential Electrical Solar Array", "Residential Electrical PV System"], TIERS, {}, ELECTRICAL);
  assert.equal(c.reason, "ambiguous");
  assert.equal(c.index, undefined);
  assert.deepEqual(c.candidates, ["Residential Electrical Solar Array", "Residential Electrical PV System"]);
});

check("a single neutral match is taken as before (a label saying nothing about class is not refused)", () => {
  const labels = ["Electrical Permit", "Solar Photovoltaic System"];
  const c = explainRecordTypeChoice(labels, TIERS, {}, ELECTRICAL);
  assert.equal(labels[c.index!], "Solar Photovoltaic System");
  assert.equal(c.reason, "matched");
});

check("nothing matches any tier -> unmatched (the caller's old bail path)", () => {
  assert.equal(explainRecordTypeChoice(["Fence", "Demolition"], TIERS, {}, ELECTRICAL).reason, "unmatched");
});

check("namesJobClassAndDiscipline: the group to open is this class AND discipline, derived from the job", () => {
  assert.equal(namesJobClassAndDiscipline("Residential Electrical", {}, ELECTRICAL), true);
  assert.equal(namesJobClassAndDiscipline("Residential", {}, ELECTRICAL), false);
  assert.equal(namesJobClassAndDiscipline("Residential Building", {}, ELECTRICAL), false);
  assert.equal(namesJobClassAndDiscipline("Commercial Electrical", {}, ELECTRICAL), false);
  assert.equal(namesJobClassAndDiscipline("Commercial Electrical", { jobClass: "commercial" }, ELECTRICAL), true);
  assert.equal(namesJobClassAndDiscipline("Residential Electrical", {}, undefined), false);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nprogram class preference: all checks passed");
