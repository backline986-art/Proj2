// A RECORDED "POLICY DEFAULT" STEP YIELDS TO THE JOB'S OWN ANSWER (issue #355).
//
// The learner's policy pass (autoLearnAdapter applyPolicyDefaults / applyPolicySelect) answers
// "Do you propose to limit the export capacity of this system?" with the standing "No" and records
// the step as a literal: a `check` on the "No" radio, or a `select` of "No", noted
// "policy default: <question> → No". Nothing rebinds that literal — the post-learn binder keeps
// "policy default:" steps as recorded on purpose (portalRecipes convertLiteralsToBoundFields), and so
// does the replay binder (recipeReplayBinding R10) — so a replay of that recipe on an EXPORT-LIMITED
// job (a PCS, an export limit, non-export, NGOM: shared exportLimitingFor) filed "No" on the
// interconnection application. Only a step the PLANNER recorded, bound to exportLimiting, answered
// from the job.
//
// So the replay asks THIS of a recorded policy-default step before it acts:
//   - the step's question is a learner rule that carries a job key (POLICY_RADIO_DEFAULTS `jobKey`,
//     read through POLICY_QUESTION_JOB_KEYS — today only the export-capacity question ↔
//     exportLimiting) → the JOB'S answer when the job carries one with evidence ("job");
//   - the key is absent or empty, or the replay map flags it as no evidence on the job (#356:
//     exportLimiting's "No" is then the default, not the job's answer) → the recorded standing
//     answer, said to be the standing answer ("standing");
//   - the question reads negated where the rule matched ("I do not propose…") → neither answer
//     applies, so the control is left for a person ("unanswerable") — never the recorded literal;
//   - any other policy-default step (lab-certified, knife-blade, distance…) and any other step → null:
//     it replays exactly as recorded.
//
// WHICH QUESTION. The recorded note names it — but the radio pass notes the group's FIRST
// legend/label/strong, which on a <label>-wrapped radio group can be an option ("Yes") rather than
// the question. So when the note and the selector's label match NO policy rule, the caller may pass
// the live group's text (the same container the learner read: closest fieldset / form-group / field
// / row); it is used only when it matches exactly ONE policy rule and that rule carries a job key —
// a container wide enough to hold two policy questions decides nothing.
//
// Pure. The DOM work (finding the "Yes" peer in the recorded radio's group) is the adapter's.
import { POLICY_RADIO_DEFAULTS, type PolicyRadioRule } from "./adapters/autoLearnAdapter";
import { negatedWhereMatched, NO_JOB_EVIDENCE_WHY, noJobEvidence } from "./unrecordedControls";

const POLICY_NOTE = /^\s*policy default\s*:\s*/i;

export type RecordedPolicyAnswer =
  /** The job's own answer: `value` is what the step must commit; `recorded` the literal it carries. */
  | { kind: "job"; key: string; value: string; recorded: string }
  /** The recorded standing answer stands; `why` says so in the run's notes. */
  | { kind: "standing"; key: string; value: string; why: string }
  /** Neither answer applies (a negated wording): nothing is committed; `why` names it for a person. */
  | { kind: "unanswerable"; key: string; why: string };

/** "policy default: <question> → <answer>" → its parts, or null when the note is not a policy default. */
export function parsePolicyDefaultNote(note: string | null | undefined): { question: string; answer: string } | null {
  const text = String(note ?? "");
  if (!POLICY_NOTE.test(text)) return null;
  const body = text.replace(POLICY_NOTE, "");
  const arrow = body.lastIndexOf("→");
  if (arrow < 0) return { question: body.trim(), answer: "" };
  return { question: body.slice(0, arrow).trim(), answer: body.slice(arrow + 1).trim() };
}

const yesNo = (v: string): string => (/^(?:yes|y|true)$/i.test(v) ? "Yes" : /^(?:no|n|false)$/i.test(v) ? "No" : v);
const rulesFor = (text: string): PolicyRadioRule[] => (text.trim() ? POLICY_RADIO_DEFAULTS.filter((r) => r.question.test(text)) : []);

/**
 * What a RECORDED policy-default step commits on THIS job (see the header), or null when the step is
 * not one whose question the job answers. `liveQuestion`: the live group's text around the recorded
 * control, consulted only when the recorded words match no policy rule.
 */
export function answerForRecordedPolicyStep(
  step: { note?: string | null; selector?: { label?: string | null } | null },
  fieldValues: Record<string, string>,
  liveQuestion?: string | null,
): RecordedPolicyAnswer | null {
  const parsed = parsePolicyDefaultNote(step?.note);
  if (!parsed) return null;
  const recordedText = `${parsed.question} ${String(step?.selector?.label ?? "")}`.replace(/\s+/g, " ").trim();
  let text = recordedText;
  let rules = rulesFor(recordedText);
  if (!rules.length && liveQuestion) {
    text = String(liveQuestion).replace(/\s+/g, " ").trim();
    rules = rulesFor(text);
    if (rules.length !== 1) return null;
  }
  const rule = rules[0];
  if (!rule?.jobKey) return null;
  const key = rule.jobKey;
  const recorded = yesNo(parsed.answer || rule.answer);
  if (negatedWhereMatched(text, rule.question)) {
    return { kind: "unanswerable", key, why: `the question reads negated, so neither this job's ${key} nor the standing "${recorded}" answers it` };
  }
  const own = String(fieldValues?.[key] ?? "").trim();
  if (!own) return { kind: "standing", key, value: recorded, why: `the operator's standing answer (this job carries no ${key})` };
  if (noJobEvidence(fieldValues, key)) return { kind: "standing", key, value: recorded, why: NO_JOB_EVIDENCE_WHY };
  return { kind: "job", key, value: yesNo(own), recorded };
}
