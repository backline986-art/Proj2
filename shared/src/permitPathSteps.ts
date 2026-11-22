// A RECORDED CHOICE THAT NAMES A PERMIT PATH (owner 2026-11-21: "how do we differentiate if its a
// prescriptive non prescriptive ... with the manual recordings?").
//
// Keelix decides prescriptive vs engineered per JOB (backend permitPath.resolvePermitPath; a person's
// choice on Manual entry wins). A recipe is per portal and permit type, not per path, so a person
// recording on a prescriptive job saves "Prescriptive" as a fixed answer and every later job replayed
// it. A choice step (select, check, click) whose own words name a path is stamped with the path of the
// job it was recorded or fixed on (whenPermitPath), and the replay binding leaves it out on a job of
// the other path (recipeReplayBinding). A person shows the other path's choice once (a hand fix on the
// next such job), and from then on each path replays its own answer.
//
// Pure: no DB, no page. Typing (fill) and uploads are never stamped: a typed value binds to the job's
// data, and which document goes in a slot is the document gate's call.
import type { RecipeStep } from "./types";

export type DefinitePermitPath = "prescriptive" | "engineered";

const PATH_WORDS = /\b(non[-\s]?prescriptive|prescriptive|engineered|engineering\s+(letter|calc\w*|review)|structural\s+(review|calc\w*|engineer\w*|plan\s+review)|plan\s+review\s+required)\b/i;

/** The words a step shows: its label, accessible name, text, note and (for a select) the option. */
function stepWords(step: RecipeStep): string {
  const sel = step.selector ?? {};
  return [sel.label, sel.name, sel.text, step.note, step.action === "select" ? step.value : ""].map((v) => String(v ?? "")).join(" ");
}

/** True for a choice step (select / check / uncheck / an ordinary click) whose own words name a permit path. */
export function namesPermitPath(step: RecipeStep): boolean {
  if (!step || step.isFinalSubmit) return false;
  if (!["select", "check", "uncheck", "click"].includes(step.action)) return false;
  return PATH_WORDS.test(stepWords(step));
}

/** Stamp every path-naming choice that carries no stamp yet with the job's path. A job whose path is
 *  not settled stamps nothing (the step then replays on every job, as before). */
export function stampPermitPathSteps(steps: RecipeStep[], path: string | null | undefined): RecipeStep[] {
  if (path !== "prescriptive" && path !== "engineered") return steps;
  return steps.map((s) => (s.whenPermitPath || !namesPermitPath(s) ? s : { ...s, whenPermitPath: path }));
}
