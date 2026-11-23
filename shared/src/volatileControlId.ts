// ---------------------------------------------------------------------------
// IS THIS RECORDED ID (OR NAME) A RENDER COUNTER OR A ROW ORDINAL RATHER THAN AN IDENTITY? (#234)
//
// The ONE answer for every door that asks "does the recorded id still name this control?". Today two
// doors in portal-bot recipeAdapter read it, both only where the recorded label and section already
// confirm another box: the fingerprint re-anchor (a counter is not written instead of that box) and
// the same-label tie-break (a counter does not pick against the recorded section). One predicate in a
// shared leaf, because two regexes answering one question is how this codebase has been bitten.
//
// Why it matters. A counter id is assigned in render order, so the moment one control renders before
// it (an "Existing contact" select appearing, a section re-rendering, a row added), the SAME string
// names the NEIGHBOUR. The 2026-11-14 recipe audit found it live in saved data: one PowerClerk learn
// saw a control as pcInputBase8 and another as pcInputBase79, and Ameren's learns differ by one when
// the contact picker renders. Replaying PGE's applicant steps with the counter moved by one wrote the
// surname into Company and read it back verified; with the numbering restarted it went silently into
// the co-applicant's Last. Such an id may still FIND a control; it never vouches that the control
// is the one recorded.
//
// The families named in the audit, then one generic rule:
//   pcInputBaseN                PowerClerk's render counter.
//   formly_N_...                Angular formly's per-form instance counter (the key after it is
//                               stable, the id as a whole is not).
//   mat-...-N                   Angular Material's component counters (mat-input-1, mat-radio-2-input,
//                               mat-radio-group-1).
//   ..._ctlNN_... / $ctlNN$     ASP.NET naming-container ordinals PAST the first segment: Repeater /
//                               DataList / GridView rows and unnamed controls, numbered by position.
//                               The leading ctl00 of every WebForms id is the master page and is NOT
//                               matched (ctl00_PlaceHolderMain_OwnerEdit_txtEmail is a real identity).
//   ..._gv_CB_N / ..._CB_N      ASP.NET grid row-select checkboxes: the row's index in the results.
//   Dc-N                        Idaho DOPL's render counter.
//   :rNN: / «rN» / _r_N_        React's useId counter (base 32), on any React portal, at the start
//                               of the id or after a library prefix's hyphen.
//   GENERIC: an id whose every word is widget vocabulary ("input", "field", "autocomplete", "ctl")
//   or a one-or-two-letter abbreviation, carrying a SHORT (1-3 digit) number. Such an id has no name
//   of its own: the number is all that tells it apart, and a number of that size is a position.
//   Two things keep a real identity out, both read from the 22 saved recipes: a run of 4+ digits is
//   a server-assigned key (field267055, Input_25393, Applicant_9479Edit), and letters interleaved with
//   digits in one token are a server token (PowerClerk's 6SBQY3V4BA4EFirst, PQE8Z9WHXQ4WInput_25393),
//   both stable across learns. So the generic rule catches autocomplete_1 and Tyler's g_0_f_3, and
//   leaves every PowerClerk field token, Accela id and CityView PRPermit21_att... id alone.
//
// Misreading a stable id as volatile is the cheap direction: the id is then simply not trusted to
// move a write or break a tie, which is what replay did before fingerprints existed. Misreading a
// counter as stable writes the right answer into the wrong box.
// ---------------------------------------------------------------------------

const FAMILIES: ReadonlyArray<{ family: string; re: RegExp }> = [
  { family: "PowerClerk render counter", re: /^pcInputBase\d+$/ },
  { family: "Angular formly form counter", re: /^formly_\d+_/ },
  { family: "Angular Material counter", re: /^mat-(?:mdc-)?[a-z]+(?:-[a-z]+)*-\d+(?:-[a-z]+)*$/ },
  { family: "ASP.NET row ordinal", re: /[_$]ctl\d+(?=[_$]|$)/ },
  { family: "ASP.NET grid row checkbox", re: /(?:^|[_$])(?:gv_)?CB_\d+$/ },
  { family: "DOPL render counter", re: /^Dc-\d+$/ },
  // React's useId is the same counter in base 32, on any React portal: ":r1a:" / ":R6l6:" (18),
  // "«r1»" (19.1), "_r_1_" (19.2), alone or behind a library prefix ("radix-:r3:"). ANCHORED at the
  // start or after a hyphen/underscore: unanchored, every colon-separated JSF / PrimeFaces id with a
  // segment starting in "r" ("form:region:city", "j_idt12:rate:0") read as a counter (review of #234).
  { family: "React useId counter", re: /(?:^|[-_])(?::[rR][0-9a-z]{1,6}:|«[rR][0-9a-z]{1,6}»)|(?:^|-)_[rR]_[0-9a-z]{1,6}_/ },
];

/** Words that name a KIND of widget or a framework, never a question. An id built only from these
 *  (plus a short number) says nothing about which control it is. */
const WIDGET_WORDS = new Set([
  "input", "inputs", "field", "fields", "control", "ctl", "ctrl", "element", "elem", "item", "items",
  "gen", "comp", "cmp", "component", "widget", "base", "auto", "autocomplete", "autogen", "uid", "uuid",
  "node", "row", "cell", "col", "column", "chk", "check", "checkbox", "radio", "radiogroup", "select",
  "option", "opt", "txt", "text", "textbox", "textarea", "ddl", "lbl", "label", "form", "formly",
  "group", "list", "listbox", "combobox", "menu", "button", "btn", "value", "val", "mat", "mdc",
  "ember", "ext", "yui", "react", "idt",
]);

/** The longest number a render counter or row index is taken to be. Corpus: counters reach the low
 *  hundreds (pcInputBase79); server keys run 4-6 digits. */
const MAX_COUNTER_DIGITS = 3;

function genericCounter(id: string): boolean {
  const segments = id.split(/[-_$:.\s]+/).filter(Boolean);
  let counter = false;
  for (const seg of segments) {
    const m = /^([A-Za-z]*)(\d*)$/.exec(seg);
    // Letters and digits interleaved in one token: a server token, which is an identity.
    if (!m) return false;
    const [, letters, digits] = m;
    if (digits) {
      // A long number is a database key, which is an identity.
      if (digits.length > MAX_COUNTER_DIGITS) return false;
      counter = true;
    }
    if (letters) {
      const words = letters.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .toLowerCase().split(" ").filter(Boolean);
      if (!words.every((w) => w.length <= 2 || WIDGET_WORDS.has(w))) return false;
    }
  }
  return counter;
}

/** Which kind of counter or ordinal this recorded id/name is, or null when it reads as an identity. */
export function volatileControlIdKind(id: string | null | undefined): string | null {
  const s = String(id ?? "").trim().replace(/^#/, "");
  if (!s) return null;
  for (const f of FAMILIES) if (f.re.test(s)) return f.family;
  return genericCounter(s) ? "render counter or position" : null;
}

/** THE predicate: true when a recorded id (or name) is a render counter or row ordinal, so it may
 *  locate a control but never vouches that the control is the one recorded. */
export function isVolatileControlId(id: string | null | undefined): boolean {
  return volatileControlIdKind(id) !== null;
}
