// #280 — A RECIPE'S LEADING SIGN-IN SEQUENCE.
//
// Every hand recording starts with the person signing in, so the recipe's first steps ARE the
// sign-in: a click that opens it, the user-name fill, the SENSITIVE credential fill the recorder
// writes without a value, and the click (or key press) that sends it. On replay the engine signs
// in by itself before the first recorded step (the login phase), so those steps name controls a
// signed-in page no longer has. The replay skips them as a unit when — and only when — its own
// login phase reported the session signed in (recipeAdapter: signedInAtRecipeStart).
//
// THE MARKER IS THE RECORDER'S SENSITIVE CREDENTIAL FILL, NEVER WORDING. Nothing here reads a
// label, a note, an id or a URL: only each step's action and its sensitive / field / value shape.
//
// THE DEFINITION (tight on purpose; anything else is "no leading sign-in sequence" and the recipe
// replays exactly as before):
//   1. Leading `goto` steps are NOT part of it (they still run). The sequence starts at the first
//      step that is not a goto.
//   2. Before the marker, only these may appear: click / press / goto / waitFor steps, and AT MOST
//      ONE fill that is not sensitive and is bound to no project field (the user name, stored as a
//      literal or without a value).
//   3. The marker: a `fill` with `sensitive` set and NO `field`. A sensitive fill bound to a
//      project field (an account or meter number) is application data, not a credential.
//   4. After the marker, only more credential fills of the same shape may appear before the end.
//   5. The end: the first click or press after the marker — the step that sends the sign-in.
//   6. Any other step before the end — a select, a check, an upload, a fill bound to a project
//      field, a second plain fill, the review stop, a click flagged as the final submit — means
//      form data is written (or the run's boundary is reached) before the credential: no sequence.
import type { RecipeStep } from "../../../shared/src/types";

export interface LeadingSignInSequence {
  /** Index of the sequence's first step (after any leading goto). */
  start: number;
  /** Index of its last step: the click/press that sends the sign-in. Inclusive. */
  end: number;
}

/** The recorder's sensitive credential fill: sensitive, a fill, bound to no project field. */
function isCredentialFill(step: RecipeStep): boolean {
  return step.action === "fill" && step.sensitive === true && !String(step.field ?? "").trim();
}

/** The recipe's leading sign-in sequence, or null when it has none (see THE DEFINITION above). */
export function leadingSignInSequence(steps: readonly RecipeStep[] | null | undefined): LeadingSignInSequence | null {
  if (!Array.isArray(steps)) return null;
  let start = 0;
  while (start < steps.length && steps[start]?.action === "goto") start++;
  let plainFills = 0;
  let marker = -1;
  for (let i = start; i < steps.length; i++) {
    const step = steps[i];
    if (!step || step.isFinalSubmit) return null;
    const action = step.action;
    if (isCredentialFill(step)) {
      if (marker < 0) marker = i;
      continue;
    }
    if (action === "click" || action === "press") {
      if (marker >= 0) return { start, end: i };
      continue;
    }
    // Past the marker, only the sending click/press (above) or another credential fill may come.
    if (marker >= 0) return null;
    if (action === "goto" || action === "waitFor") continue;
    if (action === "fill" && !step.sensitive && !String(step.field ?? "").trim()) {
      if (++plainFills > 1) return null;
      continue;
    }
    return null;
  }
  return null;
}

/** One line naming the sequence for the run's notes: step numbers, each step's action and label.
 *  NEVER a value (the user-name literal lives in `value`) and never a sensitive step's label. */
export function describeLeadingSignIn(steps: readonly RecipeStep[], seq: LeadingSignInSequence): string {
  const parts: string[] = [];
  for (let i = seq.start; i <= seq.end; i++) {
    const step = steps[i];
    if (isCredentialFill(step)) { parts.push("fill (credential — no value stored)"); continue; }
    const label = String(step.selector?.name || step.selector?.label || step.selector?.text || step.note || "").replace(/\s+/g, " ").trim().slice(0, 40);
    parts.push(label ? `${step.action} "${label}"` : String(step.action));
  }
  const range = seq.start === seq.end ? `step ${seq.start + 1}` : `steps ${seq.start + 1}-${seq.end + 1}`;
  return `${range}: ${parts.join(", ")}`;
}
