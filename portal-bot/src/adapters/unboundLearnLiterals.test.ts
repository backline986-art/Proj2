// A RECORDED VALUE WITH NO BINDING REPLAYS ON EVERY JOB (#236) — THE REPLAY ADAPTER'S HALF.
//
// The auditors' p3 predicates (looksLikeProjectData on the recorded label/value pairs), the
// literals.audit battery case (a storage question that lives only in the step's section) and the
// hand-off listing, on the real RecipeAdapter. Synthetic values in the evidence's shapes.
//
//   npx tsx portal-bot/src/adapters/unboundLearnLiterals.test.ts
import assert from "node:assert/strict";
import type { RecipeStep } from "../../../shared/src/types";
import { RecipeAdapter, looksLikeProjectData } from "./recipeAdapter";
import { batteryControlKind, batteryQuestionTextOfStep } from "../../../shared/src/batteryControls";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}`); }
};

// ── (3) THE p3 PREDICATES ───────────────────────────────────────────────────────────────────────
check("p3 MUST-PASS: the learn job's data is refused whatever the label (value shape, battery spec)", () => {
  for (const [l, v] of [
    ["*Describe Location of Solar Array", "Roof-mounted PV array on existing single-family dwelling, south-facing (135° azimuth, 18° tilt)"],
    ["Other parties to have access to the project (Name,Email,Phone)", "ZZ Test Person, zz.person@example.test, (503) 555-0100"],
    ["Battery Round-trip Efficiency (%)", "91"],
    ["Description", "6.2 kW roof mounted"],
    ["Notes", "Panel is on the east wall. Meter is on the south side."],
    ["Site", "1234 SE Example Ave"],
  ]) assert.equal(looksLikeProjectData(l, v), true, `${l} = ${v} would replay the learn job's answer`);
});
check("p3 MUST-EXCLUDE: the portal's own words still replay (and a bare count is the binder's R14)", () => {
  for (const [l, v] of [
    ["Job Category", "STAND-ALONE"], ["Permit Name", "Solar PV System Installation"], ["Energy Source", "Solar"],
    ["Type of Work", "Alteration"], ["Description:", "Electrical plan set"], ["Battery Type", "Lithium-ion"],
    ["*Without Service or Feeder", "1"], ["Location of placement:", "Roof"],
  ]) assert.equal(looksLikeProjectData(l, v), false, `${l} = ${v} would be blanked`);
});

// ── (2) THE STORAGE QUESTION THAT LIVES ONLY IN THE SECTION ────────────────────────────────────
type Replay = {
  skipForNoBattery(s: RecipeStep): boolean; isBatteryDeclaration(s: RecipeStep): boolean;
  batteryRadioConflict(s: RecipeStep): string | null; noteReplayedLearnAnswer(s: RecipeStep): void;
  reviewHandoffNotes: string[]; agingNotes: string[];
};
const replayWith = (hasBattery: string): Replay => {
  const a = Object.create(RecipeAdapter.prototype) as Record<string, unknown>;
  a.fieldValues = { hasBattery };
  a.recipe = { steps: [] };
  a.agingNotes = [];
  a.reviewHandoffNotes = [];
  a.learnAnswersListed = [];
  return a as unknown as Replay;
};
const radio = (label: string, section: string): RecipeStep =>
  ({ action: "check", phase: "fill", note: label, selector: { label }, fingerprint: { section } } as RecipeStep);
// The Ameren shape: the recorded radio is labelled "No", the question is the step's section.
const ESS_NO = radio("No", "Do you seek to install an Energy Storage System (ESS), or batteries as part of t");
const ESS_YES = radio("Yes", "Do you seek to install an Energy Storage System (ESS), or batteries as part of t");
const PRE_APP_NO = radio("No", "Have you submitted a Pre-Application for this project site? If so, please provid");

check("literals.audit: a radio labelled \"No\" is asked its SECTION's storage question", () => {
  assert.equal(replayWith("No").isBatteryDeclaration(ESS_NO), true);
  assert.equal(replayWith("No").isBatteryDeclaration(PRE_APP_NO), false, "MUST-EXCLUDE: a question about something else");
});
check("no battery: the recorded No is TICKED (not skipped as a declaring checkbox) and agrees", () => {
  assert.equal(replayWith("No").skipForNoBattery(ESS_NO), false, "skipping leaves a required radio blank");
  assert.equal(replayWith("No").batteryRadioConflict(ESS_NO), null);
});
check("battery: the learn job's No is LEFT for a person, named; a recorded Yes is ticked", () => {
  assert.match(String(replayWith("Yes").batteryRadioConflict(ESS_NO)), /^left "Do you seek to install an Energy Storage System.* for a person — the recorded answer "No" was the learn job's, and this project has a battery$/);
  assert.equal(replayWith("Yes").batteryRadioConflict(ESS_YES), null);
  assert.match(String(replayWith("No").batteryRadioConflict(ESS_YES)), /has no battery$/, "the mirror: a battery learn's Yes on a no-battery job");
});
check("unknown battery: the recorded answer replays (and the hand-off lists it)", () => {
  assert.equal(replayWith("").batteryRadioConflict(ESS_NO), null);
  assert.equal(replayWith("").skipForNoBattery(ESS_NO), false);
});
check("MUST-EXCLUDE: the Ivy declaring checkbox is unchanged — unchecked on a no-battery job", () => {
  const box = { action: "check", phase: "fill", note: "This system includes battery storage", selector: { label: "This system includes battery storage" } } as RecipeStep;
  assert.equal(replayWith("No").skipForNoBattery(box), true);
  assert.equal(replayWith("No").batteryRadioConflict(box), null);
});
check("MUST-EXCLUDE: a non-answer label is never read with its section (an inverter is not a battery spec)", () => {
  const inv = { action: "select", phase: "fill", note: "Manufacturer", selector: { label: "Manufacturer" }, fingerprint: { section: "Inverter and Battery Information" } } as RecipeStep;
  assert.equal(batteryControlKind(batteryQuestionTextOfStep(inv), { control: "select" }), null);
  assert.equal(replayWith("No").skipForNoBattery(inv), false);
});

// ── (5) THE HAND-OFF LISTING ────────────────────────────────────────────────────────────────────
check("the hand-off names an unbound select and a radio answer replayed as recorded", () => {
  const r = replayWith("");
  r.noteReplayedLearnAnswer({ action: "select", phase: "fill", note: "Application Type", selector: { label: "Application Type" }, value: "Change to an existing system" } as RecipeStep);
  r.noteReplayedLearnAnswer(radio("Load Side", "Is this proposed generation to be connected on the line or load side of the main"));
  r.noteReplayedLearnAnswer(ESS_NO);
  assert.deepEqual(r.reviewHandoffNotes, [
    "replayed the learn's answer: \"Application Type\" = \"Change to an existing system\"; "
    + "\"Is this proposed generation to be connected on the line or l\" = \"Load Side\"; "
    + "\"Do you seek to install an Energy Storage System (ESS), or ba\" = \"No\""
    + " — bound to nothing, so each of these 3 is the recorded job's answer; confirm each is this job's.",
  ]);
  assert.deepEqual(r.agingNotes, [], "not a re-record signal: the benchmark and the KPI read agingNotes as \"took another route\"");
});
check("ONE hand-off line, rewritten in place — never six notes crowding out a held payment", () => {
  const r = replayWith("");
  r.reviewHandoffNotes.push("an earlier hand-off note");
  r.noteReplayedLearnAnswer({ action: "select", phase: "fill", note: "Building Use", selector: { label: "Building Use" }, value: "Single Family Dwelling" } as RecipeStep);
  assert.match(r.reviewHandoffNotes[1], /^replayed the learn's answer: "Building Use" = "Single Family Dwelling" — bound to nothing, so it is the recorded job's answer; confirm it is this job's\.$/);
  r.reviewHandoffNotes = ["a note that leads", ...r.reviewHandoffNotes]; // a later reassignment (the payment note leads)
  for (let i = 1; i <= 12; i++) r.noteReplayedLearnAnswer({ action: "select", phase: "fill", note: `Question ${i}`, selector: { label: `Question ${i}` }, value: `Answer ${i}` } as RecipeStep);
  r.noteReplayedLearnAnswer({ action: "select", phase: "fill", note: "Question 1", selector: { label: "Question 1" }, value: "Answer 1" } as RecipeStep);
  assert.equal(r.reviewHandoffNotes.length, 3);
  assert.equal(r.reviewHandoffNotes[0], "a note that leads");
  assert.match(r.reviewHandoffNotes[2], /^replayed the learn's answer: "Building Use" = "Single Family Dwelling"; "Question 1" = "Answer 1";.*"Question 9" = "Answer 9" \(\+3 more\) — bound to nothing, so each of these 13 is/);
});
check("MUST-EXCLUDE: answers taken from THIS job, and checks that answer no question, are not listed", () => {
  const r = replayWith("No");
  r.noteReplayedLearnAnswer({ action: "select", phase: "fill", note: "State", selector: { label: "State" }, field: "state" } as RecipeStep);
  r.noteReplayedLearnAnswer({ action: "select", phase: "fill", note: "policy default: Are the AC disconnects visible? -> Yes", selector: { label: "AC disconnect" }, value: "Yes" } as RecipeStep);
  r.noteReplayedLearnAnswer({ action: "check", phase: "fill", note: "record type (verified): Residential Solar", selector: { label: "Residential Solar" } } as RecipeStep);
  r.noteReplayedLearnAnswer({ action: "check", phase: "fill", note: "I have read and accept the above terms:", selector: { label: "I have read and accept the above terms:" } } as RecipeStep);
  r.noteReplayedLearnAnswer(ESS_NO); // answered from hasBattery No — this job's answer
  assert.deepEqual(r.reviewHandoffNotes, []);
});

if (failures) { console.error(`\n${failures} unbound-learn-literal check(s) FAILED.`); process.exit(1); }
console.log("\nunbound learn literals (replay): every check passed.");
