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
// one, it is the name attribute. The recipe locator builders (replay, learner, login, review
// digest) and the readers that want the words a person sees ask these functions, never `sel.name`
// directly. The learner no longer writes a bare name (it writes nameAttributeCss), but recipes
// saved before that still carry one and cannot be re-recorded on demand, so the reading stays.
// Three places still hand-build a `[name=…]` css of their own and are NOT this builder:
// signatureRequestStep's selectorFor (it addresses checkbox toggles, which nameAttributeCss
// refuses by design), and recordRecipe / humanCapture (person-recorded steps, written in-page).

type NamedSelector = { role?: string | null; name?: string | null; css?: string | null };

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
 *  carries the same name, so `[name="grp"]` matches them all and, with no recorded option id to
 *  tell them apart, replay ticks the first one — an answer nobody recorded, reported as success
 *  (bareNameSelector smoke, red without this). So the name level matches no radio or checkbox:
 *  the option's own #id fallback decides, or the step finds nothing, as it did before #229.
 *
 *  ONLY A FORM CONTROL'S NAME IS A CONTROL'S NAME. `<meta name="description">`, `<form name>`,
 *  `<a name>` and `<iframe name>` carry the attribute too, so an untied `<textarea name=
 *  "description">` matched twice and replay logged a false "matched 2 controls" aging note (#229
 *  review). Every name the learner ever recorded came from an input, select, textarea or button.
 *
 *  The value is quoted with `\` and `"` escaped (Node has no CSS.escape); ASP.NET names
 *  (`ctl00$Main$txtValue`) need nothing more inside quotes. nameAttributeOfCss reads it back. */
export function nameAttributeCss(name: string): string {
  const v = String(name)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n|\f/g, "\\a ");
  return `:is(input,select,textarea,button)[name="${v}"]:not([type="radio"]):not([type="checkbox"])`;
}

const NAME_ATTRIBUTE_CSS = /^:is\(input,select,textarea,button\)\[name="((?:[^"\\]|\\[\s\S])*)"\]:not\(\[type="radio"\]\):not\(\[type="checkbox"\]\)$/;

/** The name attribute a css written by nameAttributeCss addresses, else "".
 *
 *  A WORD-READER READS THE NAME, NEVER THE CSS AROUND IT. The encoding's own scaffolding
 *  (`name`, `type`, `radio`, `button`…) is not the control's words: read as words, an unlabeled
 *  box whose name attribute is "OwnerSigns" became "… name Owner Signs …", which the e-signature
 *  test reads as a signature box, and replay typed the client's signer into it (#229 review). */
export function nameAttributeOfCss(css: string | null | undefined): string {
  const m = NAME_ATTRIBUTE_CSS.exec(String(css ?? ""));
  if (!m) return "";
  return m[1].replace(/\\(?:a |([\s\S]))/g, (_m, c: string | undefined) => (c === undefined ? "\n" : c));
}

/** The name attribute a selector addresses its control by — a bare `name`, or the css
 *  nameAttributeCss wrote — else "". */
export function recordedNameAttribute(sel: NamedSelector | null | undefined): string {
  return nameAttributeOf(sel) || nameAttributeOfCss(sel?.css);
}
