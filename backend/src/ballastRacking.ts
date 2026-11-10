// BALLASTED / NON-PENETRATING RACKING — the one predicate (#689 3d). A leaf (types only), so both the
// state prescriptive rules (stateRules.ts) and the reviewer's attachment rule (codeReviewRules.ts, which
// stateRules imports) read the same answer without an import cycle. Moved here unchanged from stateRules.
import type { ProjectRecord } from "../../shared/src/types";

// ---------------------------------------------------------------------------------------------
// BALLASTED / NON-PENETRATING RACKING. Read from the racking and attachment fields, and from the plan
// text's own clauses. A clause that denies it ("NON-BALLASTED", "NO BALLAST") does not count.
// IronRidge BX is the manufacturer's ballasted flat-roof system, named because plan sets often call
// it by product ("IRONRIDGE BX CHASSIS / BLOCKS") without the word "ballast".
// ---------------------------------------------------------------------------------------------
const BALLAST = /\bballast(?:ed|ing)?\b|\bnon[-\s]?penetrat(?:ing|ive)\b|\bIRONRIDGE\s+BX\b/i;
const BALLAST_DENIED = /\bnon[-\s]?ballast|\b(?:no|not|without|never)\s+(?:\w+\s+){0,2}?ballast|\bballast(?:ed)?\s*(?::|=)?\s*(?:no|none|n\/a)\b/i;

/** Where the package says the racking is ballasted or non-penetrating, quoted; "" when it does not. */
export function ballastedRackingEvidence(project: ProjectRecord): string {
  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  for (const key of ["attachmentHardware", "rackingSystem", "mounting", "tileAttachmentMethod"]) {
    const v = String(snap[key] ?? "").trim();
    if (v && BALLAST.test(v) && !BALLAST_DENIED.test(v)) return `${key}: ${v.slice(0, 80)}`;
  }
  for (const raw of String(snap.planSetExtractedText ?? "").split(/[\n;]|\.(?=\s|$)/)) {
    const clause = raw.replace(/\s+/g, " ").trim();
    if (clause && BALLAST.test(clause) && !BALLAST_DENIED.test(clause)) return `Plan set: "${clause.slice(0, 120)}"`;
  }
  return "";
}

