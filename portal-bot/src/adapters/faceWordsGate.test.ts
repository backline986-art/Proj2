// A PAY OR SUBMIT WORD ON A CONTROL'S FACE IS REFUSED, WHATEVER ITS ARIA-LABEL SAYS (#228).
//
// Since #228 the learner names a role selector by the ACCESSIBLE NAME, not the face text. Live, City
// of Tigard (EnerGov), 2026-11-14: the record-type link read "Apply" with the aria-label "Apply
// Residential Renewable Energy - Prescriptive", and the face-named selector matched only the top
// menu's "Apply" tab. The face words, when they differ, are kept as selector.shownText.
//
// That moves the face OUT of selector.name, and the name was what the replay's click gate tested. For
// <button aria-label="Continue to the next step">Pay Fees</button> the name, the step note (the label)
// and the live click guard (portalSafety.controlLabelInPage, aria-label first) all read "Continue to
// the next step". So RecipeAdapter.executeClick's pay and submit gates must read shownText too, or
// that click goes through. This drives the REAL executeClick, with no page at all: a refusal returns
// false before it touches one, and anything that gets past the gate throws on the missing page or
// clicks the fake control, and both of those count as FAIL here.
//
//   MUST REFUSE  - a pay face and a submit face under a neutral aria-label (and the learner's own
//                  off-limits test on the pay face). Both go red with `gateWords = name`.
//   MUST PASS    - the same step with a neutral face gets past the gate, so the harness itself is
//                  not what refuses.
//
//   npx tsx portal-bot/src/adapters/faceWordsGate.test.ts
import type { PortalRecipe, RecipeSelector, RecipeStep } from "../../../shared/src/types";
import { AutoLearnAdapter, type ExtractedField } from "./autoLearnAdapter";
import { RecipeAdapter } from "./recipeAdapter";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   - ${label}`);
  else { failures++; console.error(`  FAIL - ${label}\n         ${detail}`); }
};

const recipe = { id: "fw228", scopeType: "ahj", steps: [] } as unknown as PortalRecipe;

/** executeClick on one step, page-less. "refused" = returned false and clicked nothing. */
async function clickOutcome(selector: RecipeSelector, note: string): Promise<string> {
  const adapter = new RecipeAdapter(recipe, {}, {}, { autoSubmit: false });
  let clicked = false;
  const scoped = {
    click: async () => { clicked = true; },
    waitFor: async () => undefined,
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
  };
  const step: RecipeStep = { action: "click", phase: "fill", selector, note };
  try {
    const r = await (adapter as unknown as { executeClick: (s: RecipeStep, l: unknown, p: boolean) => Promise<boolean> })
      .executeClick(step, scoped, false);
    if (clicked) return `CLICKED (returned ${r})`;
    return r === false ? "refused" : `returned ${r} without a click`;
  } catch (err) {
    return `went past the gate (${clicked ? "clicked, then " : ""}threw: ${err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80)})`;
  }
}

const NEUTRAL = "Continue to the next step";
const note = `advance: ${NEUTRAL}`; // the learner's note carries the label, which is the aria-label

{
  const got = await clickOutcome({ role: "button", name: NEUTRAL, exact: true, shownText: "Pay Fees", fallbacks: [{ css: "#btn-pay" }] }, note);
  check("a control whose FACE reads \"Pay Fees\" under a neutral aria-label is refused by the replay's pay gate", got === "refused", got);
}
{
  const got = await clickOutcome({ role: "button", name: NEUTRAL, exact: true, shownText: "Submit Application", fallbacks: [{ css: "#btn-go" }] }, note);
  check("a control whose FACE reads \"Submit Application\" under a neutral aria-label is refused by the replay's submit gate", got === "refused", got);
}
{
  const got = await clickOutcome({ role: "button", name: NEUTRAL, exact: true, shownText: "Next", fallbacks: [{ css: "#btn-next" }] }, note);
  check("MUST PASS: the same step with a neutral face gets past the gate (the harness is not what refuses)", got !== "refused", got);
}
{
  // The learner's twin, on the field the scan builds: its click doors ask isOffLimitsButton.
  const field = {
    label: NEUTRAL, fieldType: "button",
    selector: { role: "button", name: NEUTRAL, exact: true, shownText: "Pay Fees", fallbacks: [{ css: "#btn-pay" }] },
  } as unknown as ExtractedField;
  const off = (AutoLearnAdapter.prototype as unknown as { isOffLimitsButton: (f: ExtractedField) => boolean }).isOffLimitsButton.call({}, field);
  check("the learner's off-limits test refuses the same \"Pay Fees\" face", off === true, JSON.stringify(field.selector));
}

if (failures) { console.error(`\n${failures} face-words gate check(s) FAILED.`); process.exit(1); }
console.log("\nAll face-words gate checks passed.");
process.exit(0);
