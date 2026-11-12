// THE PLAN SET AGAINST ITSELF (#338).
//
// A line-side-tap set (live job, 2026-10-14) contradicted itself across sheets and the gate stayed
// generic: POI interior on one sheet and exterior on the next; load-side (705.12) boilerplate and the
// "DO NOT RELOCATE THIS OVERCURRENT DEVICE" label on a supply-side tap; "SHUTDOWN – NO" beside an RSD
// note and placard; labels citing NEC 2020 on a 2023-NEC job; the supply-side disconnect never called
// suitable for use as service equipment. The consistency pass names both places in one callout each.
//
// The fixture is SYNTHETIC — the shape of that set, none of its words beyond the code phrases. No
// database, no LLM, no network.
//
// Run: npx tsx backend/test/planConsistency.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { CodeEdition, JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings } from "../src/codeReviewRules";
import { planSheets } from "../src/planAttachmentRead";
import { readNecEditionCitations, readOtherMethodItems, readRapidShutdownStatements, readServiceLocationConflicts } from "../src/planConsistency";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const STATE = "ZZ";
const AHJ = "City of Testville";
// Every page carries a title block with an owner and an address, the way real sheets do: no excerpt
// may carry them into the report.
const TITLE = "OWNER: PAT EXAMPLE, 12 SAMPLE WAY";
const page = (id: string, body: string): string => `${TITLE} SHEET: ${id} ${body}`;

const CONTRADICTORY = [
  page("PV 0.0", "COVER SHEET. APPLICABLE CODES: 2021 IRC, 2023 NEC. ROOF MOUNTED PV SYSTEM"),
  page("PV 1.0", "SITE PLAN. (E) EXISTING INTERIOR MAIN SERVICE PANEL & POINT OF INTERCONNECTION. 36 IN FIRE ACCESS PATHWAY"),
  page("PV 1.1", "ROOF PLAN. EXISTING EXTERIOR MAIN SERVICE DISCONNECT & POINT OF INTERCONNECTION. ATTIC RUN NOTES: CONDUIT IN ATTIC, SHUTDOWN – NO"),
  page("E 1.1", "ONE-LINE DIAGRAM. LINE SIDE TAP PER NEC 705.11. 60A FUSED AC DISCONNECT. RAPID SHUTDOWN PER 690.12. ATTIC RUN: SHUTDOWN – NO"),
  page("E 1.2", "INTERCONNECTION NOTES. BUS RATING X 120% RULE: 200A X 1.2 = 240A"),
  page("E 1.3", "LABELS. LABEL 1: POWER SOURCE OUTPUT CONNECTION. DO NOT RELOCATE THIS OVERCURRENT DEVICE. NEC: 2020 705.12(B)(3)(2). LABEL 2: PV SOLAR BREAKER. NEC: 2020. LABEL 3: SOLAR PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN. NEC: 2020 690.56(C)"),
].join("\n");

// The same set, made consistent.
const CONSISTENT = [
  page("PV 0.0", "COVER SHEET. APPLICABLE CODES: 2021 IRC, 2023 NEC. ROOF MOUNTED PV SYSTEM"),
  page("PV 1.0", "SITE PLAN. EXISTING EXTERIOR MAIN SERVICE DISCONNECT & POINT OF INTERCONNECTION. RAPID SHUTDOWN SWITCH AT EXTERIOR NEXT TO METER"),
  page("PV 1.1", "ROOF PLAN. EXISTING EXTERIOR MAIN SERVICE DISCONNECT & POINT OF INTERCONNECTION. 120% RULE NOT APPLICABLE (SUPPLY SIDE CONNECTION)"),
  page("E 1.1", "ONE-LINE DIAGRAM. LINE SIDE TAP PER NEC 705.11. 60A FUSED AC DISCONNECT, SUITABLE FOR USE AS SERVICE EQUIPMENT. RAPID SHUTDOWN PER 690.12. INVERTER COMPLIANT WITH NEC 2017 690.12"),
  page("E 1.3", "LABELS. LABEL 1: SOLAR PV SYSTEM EQUIPPED WITH RAPID SHUTDOWN. NEC: 2023 690.56(C)"),
].join("\n");

const project = (text: string, interco = "Line side tap", mounting = "Roof mount"): ProjectRecord => ({
  id: "plan-consistency", state: STATE, ahj: AHJ, utility: "Test Power", homeownerName: "Pat Example", projectAddress: "12 Sample Way",
  interconnectionMethod: interco,
  parserSnapshot: { mounting, interco, invModel: "Test 7600 string inverter", planSetExtractedText: text },
} as unknown as ProjectRecord);
const profile = (edition: string): JurisdictionCodeProfile => ({
  key: `${STATE.toLowerCase()}|${AHJ.toLowerCase()}|unknown`, state: STATE, ahj: AHJ, confidence: "verified",
  adoptedCodes: [{ code: "NEC", edition, title: "National Electrical Code" }, { code: "IRC", edition: "2021", title: "International Residential Code" }] as CodeEdition[],
  amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "", researchedAt: "2026-09-01T00:00:00.000Z",
});
const run = (text: string, opts: { interco?: string; edition?: string; mounting?: string } = {}): ReviewerFinding[] => {
  const ctx = opts.edition ? buildCodeContext(STATE, AHJ, profile(opts.edition)) : undefined;
  return evaluateDesignCodeFindings(project(text, opts.interco, opts.mounting), null, ctx, [], []);
};
const get = (fs: ReviewerFinding[], id: string): ReviewerFinding | undefined => fs.find((f) => f.id === id);

const BOILERPLATE = "city.elec.interconnection-boilerplate-mismatch";
const LOCATION = "city.elec.service-location-conflict";
const EDITION = "city.elec.nec-edition-cited-outdated";
const RSD = "city.elec.rapid-shutdown-contradiction";
const SERVICE_RATED = "city.elec.supply-side-disconnect-service-rating";
const ALL = [BOILERPLATE, LOCATION, EDITION, RSD, SERVICE_RATED];

const bad = run(CONTRADICTORY, { edition: "2023" });

console.log("A. the contradictory set: one callout per contradiction, each naming its sheets");

check("load-side boilerplate on a line-side tap: the 120 % rule (E 1.2), the 705.12(B) cite and the output-connection label (E 1.3)", () => {
  const f = get(bad, BOILERPLATE);
  assert.ok(f, "no boilerplate callout");
  assert.equal(f.severity, "callout");
  assert.match(f.message, /120 % busbar rule \(E 1\.2/);
  assert.match(f.message, /705\.12 load-side citation \(E 1\.3: "705\.12\(B\)\(3\)\(2\)"\)/);
  assert.match(f.message, /DO NOT RELOCATE THIS OVERCURRENT DEVICE/);
  // A bare PV breaker label is not load-side evidence (an AC combiner on a supply-side job has breakers).
  assert.doesNotMatch(f.message, /SOLAR BREAKER/);
});
check("POI interior on PV 1.0 and exterior on PV 1.1: one callout naming both sheets", () => {
  const f = get(bad, LOCATION);
  assert.ok(f, "no location callout");
  assert.equal(f.severity, "callout");
  assert.match(f.message, /point of interconnection is INTERIOR on PV 1\.0 .* EXTERIOR on PV 1\.1/);
  // An interior panel and an exterior disconnect are two facts, not a contradiction of their own.
  assert.doesNotMatch(f.title, /main service panel|main service disconnect/);
});
check("NEC 2020 on the labels against the adopted NEC 2023: ONE callout (not one per label) with the count", () => {
  const fs = bad.filter((f) => f.id === EDITION);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].severity, "callout");
  assert.match(fs[0].message, /NEC 2020 on E 1\.3 \(3 citations/);
  assert.match(fs[0].title, /adopted NEC 2023/);
});
check("SHUTDOWN – NO (PV 1.1, E 1.1) against the RSD note and placard", () => {
  const f = get(bad, RSD);
  assert.ok(f, "no RSD callout");
  assert.equal(f.severity, "callout");
  assert.match(f.message, /claimed on E 1\.1, E 1\.3/);
  assert.match(f.message, /denied on PV 1\.1, E 1\.1/);
  // The adopted edition is in the table, so 690.12(C) is the edition-evidence rule's question.
  assert.doesNotMatch(f.message, /initiation device/);
});
check("a fused line-side disconnect never called suitable for use as service equipment (230.82(6))", () => {
  const f = get(bad, SERVICE_RATED);
  assert.ok(f, "no service-rating callout");
  assert.equal(f.severity, "callout");
  assert.match(f.message, /FUSED AC DISCONNECT/);
  assert.ok(f.codeReferences.some((r) => r.section === "230.82(6)"), JSON.stringify(f.codeReferences.map((r) => r.section)));
});
check("every new finding carries its sheets as evidence, and no excerpt carries the title block", () => {
  for (const id of ALL) {
    const f = get(bad, id)!;
    assert.ok(f.evidenceFound?.length, `${id}: no evidence`);
    assert.ok(f.evidenceFound.every((e) => /^(?:PV|E) \d\.\d$/.test(e.source)), `${id}: ${f.evidenceFound.map((e) => e.source)}`);
    const all = JSON.stringify(f);
    assert.doesNotMatch(all, /PAT EXAMPLE|SAMPLE WAY/i, `${id} leaked the title block`);
  }
});
check("none of them is a blocker or a warning", () => {
  for (const f of bad.filter((x) => ALL.includes(x.id))) assert.equal(f.severity, "callout", f.id);
});

console.log("\nB. the same set made consistent raises none of them");
const good = run(CONSISTENT, { edition: "2023" });
for (const id of ALL) {
  check(`consistent set: no ${id}`, () => assert.equal(get(good, id), undefined, get(good, id)?.message));
}

console.log("\nC. edges: what was not read yields nothing");
check("edition unknown: the set against itself (2023 on the cover, 2020 on the labels)", () => {
  const f = get(run(CONTRADICTORY), EDITION);
  assert.ok(f);
  assert.match(f.title, /more than one NEC edition/);
  assert.match(f.message, /NEC 2020 on E 1\.3/);
  assert.match(f.message, /NEC 2023 on PV 0\.0/);
});
check("edition unknown and only one edition cited: no edition callout", () => {
  assert.equal(get(run(CONSISTENT), EDITION), undefined);
});
check("edition unknown: RSD claimed with no initiation device is named (strictest default, 690.12(C))", () => {
  const text = CONSISTENT.replace("RAPID SHUTDOWN SWITCH AT EXTERIOR NEXT TO METER", "");
  const f = get(run(text), RSD);
  assert.ok(f);
  assert.match(f.message, /no sheet names the initiation device/);
  assert.ok(f.codeReferences.some((r) => r.section === "690.12(C)"));
  // Known edition: the edition-evidence rule asks it; this pass does not ask twice.
  assert.equal(get(run(text, { edition: "2023" }), RSD), undefined);
});
check("method unclassified: no boilerplate or service-rating callout (the gate's own classifier decides)", () => {
  const fs = run(CONTRADICTORY, { interco: "Net Metering", edition: "2023" });
  assert.equal(get(fs, BOILERPLATE), undefined);
  assert.equal(get(fs, SERVICE_RATED), undefined);
});
check("load-side job: line-side tap notes are the other method's; a conditional general note is not", () => {
  const text = [
    page("E 1.1", "ONE-LINE DIAGRAM. 40A BACKFED PV BREAKER AT OPPOSITE END OF BUSBAR. LINE SIDE TAP AT METER"),
    page("E 1.4", "GENERAL NOTES. WHERE A SUPPLY SIDE CONNECTION IS USED, PROVIDE A SERVICE RATED DISCONNECT"),
  ].join("\n");
  const f = get(run(text, { interco: "Load side breaker", edition: "2023" }), BOILERPLATE);
  assert.ok(f);
  assert.match(f.title, /Supply-side notes on a load-side connection/);
  assert.match(f.message, /line-\/supply-side tap \(E 1\.1/);
  assert.doesNotMatch(f.message, /E 1\.4/);
});
check("ground mount: rapid shutdown is not read", () => {
  assert.equal(get(run(CONTRADICTORY, { mounting: "Ground mount", edition: "2023" }), RSD), undefined);
});
check("no sheet text: nothing", () => {
  const fs = run("", { edition: "2023" });
  for (const id of ALL) assert.equal(get(fs, id), undefined, id);
});

console.log("\nD. the readers");
const sheets = planSheets({ parserSnapshot: { planSetExtractedText: CONTRADICTORY } } as unknown as ProjectRecord);
check("readOtherMethodItems: a negated 120 % note is not boilerplate", () => {
  const s = planSheets({ parserSnapshot: { planSetExtractedText: page("E 1.2", "NOTE: 120% BUSBAR RULE NOT APPLICABLE, SUPPLY SIDE TAP") } } as unknown as ProjectRecord);
  assert.deepEqual(readOtherMethodItems(s, "supply"), []);
});
check("readServiceLocationConflicts: 'MSP (EXTERIOR)' against 'INTERIOR MAIN SERVICE PANEL'", () => {
  const s = planSheets({ parserSnapshot: { planSetExtractedText: [page("PV 1.0", "MSP (EXTERIOR)"), page("E 1.1", "INTERIOR MAIN SERVICE PANEL")].join("\n") } } as unknown as ProjectRecord);
  const c = readServiceLocationConflicts(s);
  assert.equal(c.length, 1);
  assert.equal(c[0].fact, "main service panel");
});
check("readNecEditionCitations: datasheet lists and equipment compliance claims are not the design basis", () => {
  const s = planSheets({ parserSnapshot: { planSetExtractedText: page("E 2.0", "COMPLIES WITH NEC 2014, 2017 AND 2020. INVERTER CONFORMS TO NEC 2017 690.12. DESIGNED PER 2023 NATIONAL ELECTRICAL CODE") } } as unknown as ProjectRecord);
  assert.deepEqual(readNecEditionCitations(s).map((c) => c.edition), [2023]);
});
check("readRapidShutdownStatements: 'NO.' as a number sign is not a denial", () => {
  const s = planSheets({ parserSnapshot: { planSetExtractedText: page("E 1.1", "RAPID SHUTDOWN SWITCH. SHUTDOWN - NO. 2 BOX") } } as unknown as ProjectRecord);
  assert.deepEqual(readRapidShutdownStatements(s, []).denied, []);
  assert.equal(readRapidShutdownStatements(sheets, []).denied.length, 2);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall plan-consistency checks passed");
