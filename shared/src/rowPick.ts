// THE WORD A RESULTS ROW'S OWN ACTION CARRIES — one predicate for the learner and the replay.
//
// A lookup's results grid (a contact search, a licence register, a parcel list) gives each row its
// own control: "Select", "Add", "Add Contact", "Use This Address", a radio. The learner records the
// row it chose by that control (#221); the replay chooses this job's row and presses the same kind of
// control (#235). Both must ask the SAME question, or the learn presses one thing and the replay
// another — live City of Tigard (Tyler EnerGov "Add Contact"), replay v10 of 2026-11-15: every result
// row BEGINS with a favourite star whose aria-label is "Add Favorite"; the replay's looser reading
// ("a control whose text carries the word add") took the star, the row's "Add" was never pressed, and
// the walk stopped on a page that had not moved, while the learner's exact reading had pressed "Add".
//
// The pick word stands alone, or with the noun of what is picked. Not "Add Favorite", "Add Note",
// "Unselect", "Selected". An icon ligature glued to the label ("person_add Add") is dropped first.

export const ROW_PICK_WORDS = /^(select|add|choose|pick|use)(\s+(this\s+)?(contact|record|contractor|licen[cs]e|company|applicant|professional|row|address|parcel|location))?$/i;

/** Icon-font ligature tokens ("person_add", "arrow_forward") read as text beside a label. */
const LIGATURE = /\b[a-z]+_[a-z_]+\b/g;

/** Does this one name of a control (its text, value, aria-label or title) say "pick this row"? */
export function isRowPickName(text: string | null | undefined): boolean {
  return ROW_PICK_WORDS.test(String(text ?? "").replace(LIGATURE, " ").replace(/\s+/g, " ").trim());
}
