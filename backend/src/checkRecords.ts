// WHAT THE GATE CHECKED, NOT ONLY WHAT IT FOUND (review-audit draft 07).
//
// A measured rule (electrical sizing, the wire table, design criteria, pathway widths, anchor
// spacing, the DC and AC sizes) reported only a violation, so "the 120 % screen ran and passed" and
// "the screen was skipped: no bus rating" read the same on the gate — nothing. An AHJ plan reviewer
// marks every line of a checklist. Each such rule now also leaves a CHECK RECORD:
//   - passed:      severity "pass", id "<rule>.pass", the arithmetic that passed in the message;
//   - not checked: severity "callout", id "<rule>.not-checked", "Not checked: <input> not on the plans."
// Check records are DISPLAY ONLY. They never block, never relax a finding, never go into the
// correction notice (it lists corrections), never need an acknowledgement on the approval sheet and
// are never sent to vision (needsVision reads warnings and blockers only). Their ids are the rule's
// id plus a suffix, so a test or a reader looking for the violation by its id never finds a record.
// A leaf: types only.

import type { CodeReference, ReviewerFinding, ReviewerRuleBasis } from "../../shared/src/types";

export const PASS_SUFFIX = ".pass";
export const NOT_CHECKED_SUFFIX = ".not-checked";

/** A check record (passed or not checked), never a correction. */
export const isCheckRecord = (f: Pick<ReviewerFinding, "checkOutcome">): boolean =>
  f.checkOutcome === "passed" || f.checkOutcome === "not_checked";

/** The rule a check record reports on ("city.elec.sizing-busbar-120"), or the finding's own id. */
export function checkRuleId(f: Pick<ReviewerFinding, "id" | "checkOutcome">): string {
  if (f.checkOutcome === "passed" && f.id.endsWith(PASS_SUFFIX)) return f.id.slice(0, -PASS_SUFFIX.length);
  if (f.checkOutcome === "not_checked" && f.id.endsWith(NOT_CHECKED_SUFFIX)) return f.id.slice(0, -NOT_CHECKED_SUFFIX.length);
  return f.id;
}

interface CheckInput {
  /** The rule's own finding id (the violation's id). */
  ruleId: string;
  category: ReviewerFinding["category"];
  /** What was checked, in a few words: "Busbar 120 percent screen (705.12(B)(3)(2))". */
  title: string;
  codeReferences?: CodeReference[];
  ruleBasis?: ReviewerRuleBasis | null;
}

/** The rule ran and passed: `arithmetic` is the calculation as a person would check it. */
export function passRecord(input: CheckInput & { arithmetic: string }): ReviewerFinding {
  return {
    id: `${input.ruleId}${PASS_SUFFIX}`,
    severity: "pass",
    category: input.category,
    title: input.title,
    message: input.arithmetic,
    cityFeedback: "",
    designTeamAction: "",
    evidenceNeeded: [],
    codeReferences: input.codeReferences ?? [],
    installerCallout: false,
    checkOutcome: "passed",
    ...(input.ruleBasis ? { ruleBasis: input.ruleBasis } : {}),
  };
}

/** The rule could not run: `inputs` are what is missing, in words ("the busbar rating"). */
export function notCheckedRecord(input: CheckInput & { inputs: string[] }): ReviewerFinding {
  const inputs = [...new Set(input.inputs.map((s) => s.trim()).filter(Boolean))];
  const what = inputs.length ? inputs.join("; ") : "an input";
  return {
    id: `${input.ruleId}${NOT_CHECKED_SUFFIX}`,
    severity: "callout",
    category: input.category,
    title: input.title,
    message: `Not checked: ${what} ${inputs.length > 1 ? "are" : "is"} not on the plans.`,
    cityFeedback: "",
    designTeamAction: `State ${what} on the plan set so this check can run.`,
    evidenceNeeded: inputs,
    codeReferences: input.codeReferences ?? [],
    installerCallout: false,
    checkOutcome: "not_checked",
    ...(input.ruleBasis ? { ruleBasis: input.ruleBasis } : {}),
  };
}
