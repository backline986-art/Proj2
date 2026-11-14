// WHAT A RECORDED SELECTOR'S `name` MEANS — ONE predicate (#229).
//
// `RecipeSelector.name` has carried two different things. Beside a `role` it is the control's
// ACCESSIBLE name ({ role: "button", name: "Next" } → getByRole). On its own it was the input's
// HTML `name` ATTRIBUTE: toExtractedField fell back to `raw.name` for an input with no usable
// label or placeholder. Replay read only the first meaning, so a bare name matched no strategy
// and threw "Recipe step has no usable selector." Live, City of Star (iWorQ) 2026-11-14: the
// valuation box `<input type="number" id="fee244341" name="fee244341">`, whose label is not tied
// to it, was recorded `{ name: "fee244341", fallbacks: [{ css: "#fee244341" }] }`, and replay
// failed step 8 without ever trying the #id.
//
// So the ROLE decides, here and nowhere else: with a role, `name` is the accessible name; without
// one, it is the name attribute. Every locator builder (replay, learner, login, review digest)
// and every reader that wants the words a person sees asks these functions, never `sel.name`
// directly. The learner no longer writes a bare name (it writes nameAttributeCss), but recipes
// saved before that still carry one and cannot be re-recorded on demand, so the reading stays.

type NamedSelector = { role?: string | null; name?: string | null };

/** The accessible name a selector records — its `name` only when a `role` stands beside it. */
export function accessibleNameOf(sel: NamedSelector | null | undefined): string {
  return sel?.role && sel.name ? String(sel.name) : "";
}

/** The HTML name attribute a selector records — a `name` with NO role beside it. */
export function nameAttributeOf(sel: NamedSelector | null | undefined): string {
  return sel && !sel.role && sel.name ? String(sel.name) : "";
}

/** A CSS selector for the control whose name ATTRIBUTE is `name`.
 *
 *  A RADIO'S OR CHECKBOX'S NAME IS ITS GROUP'S, NOT ITS OWN. Every option of a radio group
 *  carries the same name, so `[name="grp"]` matches them all and the first visible one would be
 *  taken — the wrong answer, checked with nothing raised. A saved step that recorded a group's
 *  name as a bare `name` has its option's #id as a fallback, so the name level must match
 *  nothing there and let the #id decide. The value is quoted with `\` and `"` escaped (Node has
 *  no CSS.escape); ASP.NET names (`ctl00$Main$txtValue`) need nothing more inside quotes. */
export function nameAttributeCss(name: string): string {
  const v = String(name)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n|\f/g, "\\a ");
  return `[name="${v}"]:not([type="radio"]):not([type="checkbox"])`;
}
