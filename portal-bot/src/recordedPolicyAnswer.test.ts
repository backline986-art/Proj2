// A RECORDED "POLICY DEFAULT" EXPORT-CAPACITY STEP ANSWERS FROM THE JOB (issue #355).
//
// answerForRecordedPolicyStep decides what a recorded "policy default: … → No" step commits on THIS
// job. Pinned both ways: an export-limited job files "Yes" (never the recorded standing "No"); a job
// with no evidence, or no exportLimiting at all, keeps the standing answer and says so; every other
// policy question replays exactly as recorded.
//
// Run: npx tsx portal-bot/src/recordedPolicyAnswer.test.ts
import assert from "node:assert/strict";
import { answerForRecordedPolicyStep, parsePolicyDefaultNote } from "./recordedPolicyAnswer";
import { NO_JOB_EVIDENCE_WHY } from "./unrecordedControls";
import { EXPORT_LIMITING_NO_EVIDENCE_KEY } from "../../shared/src/exportLimiting";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const Q = "Do you propose to limit the export capacity of this system?";
const STEP = { note: `policy default: ${Q} → No` };
const LIMITED = { exportLimiting: "Yes", [EXPORT_LIMITING_NO_EVIDENCE_KEY]: "" };

check("the note parses into its question and its recorded answer", () => {
  assert.deepEqual(parsePolicyDefaultNote(STEP.note), { question: Q, answer: "No" });
  assert.equal(parsePolicyDefaultNote("battery declaration: Energy Storage → Yes"), null);
  assert.equal(parsePolicyDefaultNote(Q), null);
});

check("an export-limited job files Yes, never the recorded standing No", () => {
  assert.deepEqual(answerForRecordedPolicyStep(STEP, LIMITED), { kind: "job", key: "exportLimiting", value: "Yes", recorded: "No" });
});

check("the job's own explicit No (evidence) is the job's answer", () => {
  assert.deepEqual(answerForRecordedPolicyStep(STEP, { exportLimiting: "No", [EXPORT_LIMITING_NO_EVIDENCE_KEY]: "" }),
    { kind: "job", key: "exportLimiting", value: "No", recorded: "No" });
});

check("no evidence on the job (#356): the recorded standing No, said to be the standing answer", () => {
  const a = answerForRecordedPolicyStep(STEP, { exportLimiting: "No", [EXPORT_LIMITING_NO_EVIDENCE_KEY]: "1" });
  assert.equal(a?.kind, "standing");
  assert.equal(a && "value" in a ? a.value : "", "No");
  assert.equal(a?.kind === "standing" ? a.why : "", NO_JOB_EVIDENCE_WHY);
});

check("no exportLimiting on the job at all: the recorded standing answer", () => {
  const a = answerForRecordedPolicyStep(STEP, {});
  assert.equal(a?.kind, "standing");
  assert.equal(a && "value" in a ? a.value : "", "No");
});

check("the select note (\"…limit the export capacity…\") and a question carried only on the selector label", () => {
  assert.equal(answerForRecordedPolicyStep({ note: `policy default: Generation: ${Q} → No` }, LIMITED)?.kind, "job");
  assert.equal(answerForRecordedPolicyStep({ note: "policy default: Yes → No", selector: { label: Q } }, LIMITED)?.kind, "job");
});

check("a note naming only an option reads the live group's question", () => {
  const optionOnly = { note: "policy default: Yes → No" };
  assert.equal(answerForRecordedPolicyStep(optionOnly, LIMITED), null, "no question, no live group → as recorded");
  assert.deepEqual(answerForRecordedPolicyStep(optionOnly, LIMITED, `${Q} Yes No`),
    { kind: "job", key: "exportLimiting", value: "Yes", recorded: "No" });
});

check("a live container holding TWO policy questions decides nothing", () => {
  const wide = `${Q} Yes No Are all inverters lab certified? Yes No`;
  assert.equal(answerForRecordedPolicyStep({ note: "policy default: Yes → No" }, LIMITED, wide), null);
});

check("the live group never overrides a note that names ANOTHER policy question", () => {
  const knife = { note: "policy default: Are all inverters lab-certified? → Yes" };
  assert.equal(answerForRecordedPolicyStep(knife, LIMITED, `${Q} Yes No`), null);
});

check("every other policy question replays as recorded (no job key)", () => {
  for (const note of [
    "policy default: Are all inverters lab-certified? → Yes",
    "policy default: Is the disconnect within 10 feet of the meter? → Yes",
    "policy default: Is this a public school project? → No",
    "policy default: meter collar adapter → No",
  ]) assert.equal(answerForRecordedPolicyStep({ note }, LIMITED), null, note);
});

check("not a policy-default step → null (a planner-recorded step is the binder's)", () => {
  assert.equal(answerForRecordedPolicyStep({ note: Q }, LIMITED), null);
  assert.equal(answerForRecordedPolicyStep({}, LIMITED), null);
});

check("a negated wording gets neither answer: left for a person", () => {
  const a = answerForRecordedPolicyStep({ note: "policy default: Do you propose to limit the export capacity of this system, or not? → No" }, LIMITED);
  assert.equal(a?.kind, "unanswerable");
});

check("a live group's option words (\"Yes No\") are not read as a negation", () => {
  assert.equal(answerForRecordedPolicyStep({ note: "policy default: Yes → No" }, LIMITED, `${Q} Yes No`)?.kind, "job");
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nrecordedPolicyAnswer: all checks passed");
