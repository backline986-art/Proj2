// A 705.10 POWER-SOURCE DIRECTORY ON THE LABEL SHEET IS NOT MISSING (issue #335).
//
// A live label sheet (E 1.3 WARNING LABELS) carried the directory placard in the wording installers
// and label vendors use — "POWER TO THIS BUILDING IS ALSO SUPPLIED FROM THE FOLLOWING SOURCES WITH
// DISCONNECT(S) LOCATED AS SHOWN" — and the text gate read "Power-source directory (705.10)" as
// missing, a BLOCKER, until the vision pass looked. The directory is credited by what it says (power
// from other sources AND where the disconnects are, as a pair); a label schedule with no directory
// anywhere is still flagged; the other labels that say "source" or "disconnect" are not a
// directory; and with a label sheet present, a label the text did not find is a warning the vision
// pass still looks at, never a blocker before it has.
//
// Every fixture is SYNTHETIC. No database, no LLM, no network.
//
// Run: npx tsx backend/test/powerSourceDirectory.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import type { CodeEdition, JurisdictionCodeProfile, ProjectRecord, ReviewerFinding } from "../../shared/src/types";
import { buildCodeContext } from "../src/codeProfiles";
import { evaluateDesignCodeFindings, POWER_SOURCE_DIRECTORY_PATTERNS } from "../src/codeReviewRules";
import { topicForFinding } from "../src/reviewerEngine";
import { visionMayRelax } from "../src/reviewerVision";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const STATE = "ZZ";
const AHJ = "City of Testville";
const plan = (): ProjectRecord => ({
  id: "directory-plan", state: STATE, ahj: AHJ, utility: "Test Power", homeownerName: "Test Owner", projectAddress: "1 Test St",
  interconnectionMethod: "Supply-side tap",
  parserSnapshot: { mounting: "Roof mount", invModel: "Test 7600 string inverter" },
} as unknown as ProjectRecord);
const profile = (adoptedCodes: CodeEdition[]): JurisdictionCodeProfile => ({
  key: `${STATE.toLowerCase()}|${AHJ.toLowerCase()}|unknown`, state: STATE, ahj: AHJ, confidence: "verified",
  adoptedCodes, amendments: [], designCriteria: {}, prescriptive: {}, fireSetbacks: [], citations: [], updatedAt: "",
  researchedAt: "2026-09-01T00:00:00.000Z",
});
const NEC_2020: CodeEdition[] = [
  { code: "NEC", edition: "2020", title: "National Electrical Code" },
  { code: "IRC", edition: "2021", title: "International Residential Code" },
];

/** A verified 2020 edition and the documents read: the rule-3 blocker shape. */
const run = (text: string, docLabel = "Plan set"): ReviewerFinding[] => {
  const project = { ...plan(), parserSnapshot: { ...(plan().parserSnapshot || {}), planSetExtractedText: text } } as ProjectRecord;
  return evaluateDesignCodeFindings(project, null, buildCodeContext(STATE, AHJ, profile(NEC_2020)), [], [{ label: docLabel, text }]);
};
const LABELS_EDITION = "city.elec.labels-edition-missing";
const get = (fs: ReviewerFinding[], id: string): ReviewerFinding | undefined => fs.find((f) => f.id === id);
const owesDirectory = (f: ReviewerFinding | undefined): boolean => (f?.codeReferences ?? []).some((r) => r.section === "705.10");

// Everything else the 2020 edition asks of a string-inverter design, so only the directory is in question.
const RSD = "RAPID SHUTDOWN PER NEC 690.12. PV HAZARD CONTROL SYSTEM LISTED TO UL 3741. RAPID SHUTDOWN SWITCH AT EXTERIOR OF DWELLING NEXT TO METER.";
const OTHER_LABELS = `LABEL: "SOLAR PV SYSTEM IS EQUIPPED WITH RAPID SHUTDOWN". LABEL: "PV SYSTEM DISCONNECT". LABEL: MAXIMUM DC VOLTAGE 480 V. `
  + "LABEL: RATED AC OUTPUT CURRENT 32 A, NOMINAL AC VOLTAGE 240 V.";
// The live E 1.3 placard's wording, beside a site-map legend of the sources (synthetic sheet).
const E13_DIRECTORY = "CAUTION: POWER TO THIS BUILDING IS ALSO SUPPLIED FROM THE FOLLOWING SOURCES WITH DISCONNECT(S) LOCATED AS SHOWN. "
  + "DANGEROUS VOLTAGE MAY BE PRESENT AT ALL TIMES. PV ARRAY. AC COMBINER. AC DISCONNECT. UTILITY METER. MAIN SERVICE PANEL.";
const labelSheet = (body: string): string => `E-1 ONE-LINE DIAGRAM. ${RSD} E 1.3 WARNING LABELS. ${OTHER_LABELS} ${body}`;
// A label schedule on the one-line, not a dedicated label sheet.
const scheduleOnE1 = (body: string): string => `E-1 ONE-LINE DIAGRAM. ${RSD} LABEL SCHEDULE: ${OTHER_LABELS} ${body}`;

console.log("A. the directory is credited by what it says");

check("the E 1.3 placard wording on a label sheet → no 705.10 finding (no labels-edition finding at all)", () => {
  const f = get(run(labelSheet(E13_DIRECTORY)), LABELS_EDITION);
  assert.equal(f, undefined, f?.message);
});
check("the same wording in a label schedule on the one-line → no 705.10 finding", () => {
  assert.equal(owesDirectory(get(run(scheduleOnE1(E13_DIRECTORY)), LABELS_EDITION)), false);
});
for (const wording of [
  "CAUTION: MULTIPLE SOURCES OF POWER - PV AND UTILITY DISCONNECTS LOCATED AS SHOWN ON THE SITE MAP.",
  "WARNING: THIS BUILDING HAS MULTIPLE SOURCES OF POWER, WITH DISCONNECTING MEANS LOCATED AS SHOWN.",
  "POWER SOURCES AND THEIR DISCONNECT(S) LOCATED AS SHOWN: UTILITY METER, PV AC DISCONNECT.",
  "PV SYSTEM DISCONNECTS ARE LOCATED AS SHOWN FOR THE FOLLOWING POWER SOURCES: UTILITY, PV ARRAY.",
  "POWER TO THIS BUILDING IS ALSO SERVED BY A PV SYSTEM, DISCONNECT LOCATED ON EAST WALL.",
]) {
  check(`credited: "${wording.slice(0, 60)}…"`, () => {
    assert.equal(owesDirectory(get(run(scheduleOnE1(wording)), LABELS_EDITION)), false);
  });
}
check("the word and the section still count as before", () => {
  assert.equal(owesDirectory(get(run(scheduleOnE1("SERVICE EQUIPMENT DIRECTORY.")), LABELS_EDITION)), false);
  assert.equal(owesDirectory(get(run(scheduleOnE1("PLAQUE PER NEC 705.10.")), LABELS_EDITION)), false);
});

console.log("\nB. MUST-EXCLUDE: no directory anywhere is still flagged");

check("a label schedule with only the 690.56(C) placard and no directory → 705.10 still owed, blocker (verified edition, documents read)", () => {
  const f = get(run(scheduleOnE1("")), LABELS_EDITION);
  assert.ok(f, "labels-edition-missing expected");
  assert.ok(owesDirectory(f), f.message);
  assert.match(f.message, /Power-source directory \(705\.10\)/);
  assert.equal(f.severity, "blocker");
});
for (const decoy of [
  // 705.12 backfed-breaker warning: one source named, no disconnect location.
  "WARNING: DUAL POWER SOURCE. SECOND SOURCE IS PHOTOVOLTAIC SYSTEM.",
  // 705.12(B)(3)(3) busbar-sum label: "multiple sources" is not "multiple sources of power".
  "WARNING: THIS EQUIPMENT FED BY MULTIPLE SOURCES. TOTAL RATING OF ALL OVERCURRENT DEVICES SHALL NOT EXCEED AMPACITY OF BUSBAR.",
  // A disconnect marking alone.
  "AC DISCONNECT LOCATED NEXT TO UTILITY METER.",
  // A de-energize instruction, not a directory.
  "WARNING: TURN OFF ALL POWER SOURCES, AC DISCONNECT LOCATED AT METER.",
  // The two halves in different sentences are two labels.
  "PHOTOVOLTAIC SYSTEM ALSO SUPPLIED FROM UTILITY. AC DISCONNECT LOCATED AT METER.",
]) {
  check(`not a directory: "${decoy.slice(0, 60)}…"`, () => {
    assert.ok(owesDirectory(get(run(scheduleOnE1(decoy)), LABELS_EDITION)), "705.10 should still be owed");
  });
}
check("the shared predicate itself: placard wording yes, a decoy no", () => {
  const credited = (t: string) => POWER_SOURCE_DIRECTORY_PATTERNS.some((p) => p.test(t));
  assert.equal(credited(E13_DIRECTORY), true);
  assert.equal(credited("WARNING: DUAL POWER SOURCE. SECOND SOURCE IS PHOTOVOLTAIC SYSTEM."), false);
});

console.log("\nC. with a label sheet present, a text-only miss is not a blocker before vision looks");

check("label sheet (WARNING LABELS), no directory → still flagged, warning not blocker; vision may still look and relax it", () => {
  const f = get(run(labelSheet("")), LABELS_EDITION);
  assert.ok(f, "labels-edition-missing expected");
  assert.ok(owesDirectory(f), f.message);
  assert.equal(f.severity, "warning");
  assert.equal(topicForFinding(f), "labels");
  assert.equal(visionMayRelax(f), true);
});
check("an uploaded labels document (source 'Labels sheet') → warning", () => {
  const f = get(run(`${RSD} ${OTHER_LABELS}`, "Labels sheet"), LABELS_EDITION);
  assert.ok(f, "labels-edition-missing expected");
  assert.equal(f.severity, "warning");
});
check("a 'LABEL SCHEDULE' note on the one-line is not a label sheet → rule-3 blocker stands", () => {
  assert.equal(get(run(scheduleOnE1("")), LABELS_EDITION)?.severity, "blocker");
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall power-source directory checks passed");
