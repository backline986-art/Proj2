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

// WHICH ROW IS THIS COMPANY — one reading for the learner and the replay (the same lesson as the pick
// word above). A cell IS this company's name when the two read the same once case, punctuation, "&" vs
// "and" and the legal suffix are ignored — nothing else. Not containment (Helm review of PR #247):
// "Acme Solar" sits inside "Acme Solar of Idaho", "Kestrel Energy" inside "Kestrel Energy Supply Inc",
// and another licensed company's record would be attached as this client's. The learner picks its row
// by this key (lookupSearchForm); the replay, which first finds every row whose text carries the
// company's words, narrows several to the one whose cell has this key (pickResultRowForProject).
export const COMPANY_SUFFIX_WORDS = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|pc|dba)\b/g;

/** A company name's key: lower case, "&" read as "and", the legal suffix dropped, punctuation collapsed. */
export function companyKey(v: string | null | undefined): string {
  return String(v ?? "").toLowerCase().replace(/&/g, " and ")
    .replace(new RegExp(COMPANY_SUFFIX_WORDS.source, "g"), " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
