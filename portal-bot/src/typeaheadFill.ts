// ---------------------------------------------------------------------------
// FILL A SEARCH-AS-YOU-TYPE BOX BY TYPING AND PICKING THE MATCH (#575).
//
// An editable <input role="combobox" aria-autocomplete="list"> — a city's GIS address search, a
// contractor or parcel lookup — offers its suggestions only AFTER you type, and the form keeps the
// value only once a suggestion is picked. The select path (comboboxFill) was written for the
// opposite widget, PowerClerk's READONLY filtered-select that shows its options on open: on a
// typeahead it opened an empty list, picked nothing, and the value dropped in silence (live
// Cityworks, 2026-11-03: "Location" stayed empty, Next did nothing, the page re-planned until the
// walk gave up).
//
// So, for the learner and the replay alike:
//   0. THE JOB'S OWN ADDRESS GOES IN WHOLE FIRST (#139): the one-line "street, city, ST zip"
//      (oneLineAddress). If the box offers no list for it, ENTER — a CityView location search takes
//      no pick, it searches on Enter (its form's FIRST submit is a hidden, unlabelled default meant
//      for exactly that) and shows the selection in a table / a "location you have selected" box,
//      the search box itself coming back empty (live Bend 2026-11-11: the street-name core "718 NE
//      8th" was "did not match an address"; the owner typed "718 NE 8th St, Bend, OR 97701" + Enter
//      and it was selected). What appeared is read back and judged by the SAME predicate as a list
//      (chooseAddressSuggestion): the job's address exactly is a pick, a near miss is a question,
//      anything else is no selection. Enter only on that whole line — a partial + Enter can let a
//      portal select its first hit, a neighbour — and only when the shared in-page Enter question
//      (portalSafety.enterRefusalInPage, hard rule 1) allows it in this box;
//   1. type the value (an address: house number + street name next, the house number alone only
//      if nothing came back) with real keystrokes — typeaheads listen to key/input events;
//   2. wait, bounded, for the box's OWN list (aria-controls / aria-owns, read document-wide since
//      overlays teleport it to <body>), else a list that was not on screen before typing — never a
//      page-wide row search, which reads the site navigation as suggestions;
//   3. let the one predicate (typeaheadMatch) choose: exactly one match is clicked; a near miss or
//      several equal candidates pick NOTHING and come back as a question for a person;
//   4. read the box back: empty after the pick is a NAMED failure, never a silent drop — and so is a
//      pick the widget's own selected value never took (#244: a hidden value the widget itself
//      emptied when the query was typed, still empty after the pick and its blur commit). A hidden
//      input that was empty all along is never read as the widget's selection.
// WHICH boxes take this path is the box's own markup (typeaheadBoxSays, #244), asked by the learner
// and the replay at their fill doors; the list is the box's own, a fresh popup, or a list that
// appeared inside the box's own widget (an iWorQ Vue autocomplete renders it there, unnamed).
// Never Enter but in step 0, behind the shared gate (the form's default button may file); never a
// containment guess; the box is cleared whenever nothing was picked, so no half-typed address is
// left for the portal to take. A box that found nothing says what the PORTAL said (noMatchSaid).
// Every wait has its own bound and the whole fill one deadline; no message says "timeout" (the
// retry wrapper retries on that word and would retype the address four times).
// ---------------------------------------------------------------------------
// Loose typing: adapters hold the Playwright Page/Locator as `any` (see comboboxFill).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { PORTAL_SAFETY_GLOBAL, PORTAL_SAFETY_IN_PAGE_SOURCE } from "../../shared/src/portalSafety";
import { FRESH_POPUP_SELECTORS, clearPopupMarks, markExistingPopups } from "./comboboxFill";
import { withAutomationInput } from "./filingBackstop";
import { normalizeCompanyLabel } from "./filerIdentitySelect";
import { addressQueries, chooseAddressSuggestion, chooseCompanySuggestion, chooseExactSuggestion, noMatchSaid, oneLineAddress, suggestionText, typeaheadBoxSays, type TypeaheadBoxFacts, type TypeaheadSite } from "./typeaheadMatch";

/** What a typeahead fill did. Only "picked" wrote a value the portal kept. `via: "enter"` — the
 *  portal selected it on Enter and shows it OUTSIDE the box (`held` is that shown text); the search
 *  box itself may be empty afterwards, and a read-back of the box must not call that a miss. */
export type TypeaheadOutcome =
  | { outcome: "picked"; picked: string; held: string; typed: string; why: string; via?: "list" | "enter" | "search";
      /** #161 — the required read-only box(es) of the box's form the forward question judges: one
       *  labelled as a location selection ("The location you have selected"), or one the pick changed
       *  to the job's address / tax lot (locationResultBoxesOf, locationResultRefusal). */
      resultBoxes?: LocationResultBox[] }
  /** A near miss or several equal candidates: nothing picked, the box cleared; ask `question`. */
  | { outcome: "ask"; question: string; offered: string[]; typed: string; why: string }
  /** `portalSaid`: the portal's own no-match words, when it printed any. */
  | { outcome: "no_suggestions"; why: string; typed: string[]; portalSaid?: string;
      /** `portalSaid` appeared AFTER the typing (it was not on screen before): the portal's answer to
       *  this search, not static copy or another box's leftover panel. Only such an answer is
       *  remembered as "already answered" (typeaheadPortalAnswered). */
      portalSaidFresh?: true }
  /** `listChanged`: the list re-rendered between the read and the click — not the portal's answer. */
  | { outcome: "no_match"; why: string; offered: string[]; typed: string; portalSaid?: string; listChanged?: true }
  /** A suggestion was clicked and the box does not hold it. */
  | { outcome: "not_held"; why: string; picked: string }
  /** The box cannot be typed into (hidden, read-only, disabled) or there is nothing to type. */
  | { outcome: "unusable"; why: string };

export interface TypeaheadRequest {
  /** The value to enter (the planner's / the recipe's resolved value). */
  value: string;
  /** typeaheadMatch.typeaheadMatchMode: "site" (the job's own address: city/ZIP checked where a
   *  suggestion shows them), "address" (another street address), "company" (the submitting company,
   *  chooseCompanySuggestion), "exact" (any other lookup). */
  mode: "site" | "address" | "exact" | "company";
  /** The job's address for "site" (street, city, ZIP); for "address" only `street` is read. */
  site?: TypeaheadSite;
  /** #139 fix round — THE ENTER DOOR the caller's recorded Enter goes through: "" = Enter may be
   *  pressed in this box, else the refusal (the caller records it where its own refusals go). The
   *  replay passes its guardAction (the full click gate on the form's default button, then the shared
   *  enterRefusalInPage); without one, the shared enterRefusalInPage alone. */
  enterGate?: (loc: any) => Promise<string>;
  /** #198 — THE CLICK DOOR for the box's own search control: "" = it may be clicked, else the
   *  refusal. The replay passes its guardAction (the full click gate); without one, the control's
   *  own in-page checks (never a submitter, never submit- or pay-worded) are the gate. */
  clickGate?: (loc: any) => Promise<string>;
  /** #161 — the job's tax lot / parcel numbers: a location selection may show one instead of the street. */
  parcels?: string[];
  /** How long one query waits for its suggestions to settle. Default 5 s. */
  suggestWaitMs?: number;
  /** The whole fill's deadline, every query included. Default 30 s — far inside the walk's stall
   *  watchdog (300 s) and one planner-door click's budget (90 s). */
  budgetMs?: number;
}

/** How long the box's own search is given to show its result rows (#198, Tigard): a geocode is a
 *  network round trip. Bounded, and never past the fill's deadline. */
const SEARCH_RESULT_WAIT_MS = 10_000;
/** The budget the SEARCH PHASE adds to the fill's deadline when it begins (#198, Tigard): each query
 *  pressed on the box's own search costs a selection read (6 s), the row wait above and a settle,
 *  and two queries are tried. Charged against the suggestion budget, the first query's empty search
 *  left the second one no turn at all (typeaheadFill smoke, the "one" shape). The whole fill stays
 *  bounded: suggestions, then this. */
const SEARCH_PHASE_BUDGET_MS = 40_000;
const SUGGEST_WAIT_DEFAULT_MS = 5_000;
/** #161 — the second look for a list before any Enter (a list that came late is picked, not entered). */
const LATE_LIST_WAIT_MS = 1_500;
const TYPEAHEAD_BUDGET_DEFAULT_MS = 30_000;
const NAME_SHIM = "globalThis.__name = globalThis.__name || function (f) { return f; };";

const loose = (s: string): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Runs IN THE PAGE (#244). What the box's own markup says about it, for typeaheadBoxSays: its role,
 * aria-autocomplete, id, aria-label and class, and the classes of ITS OWN WIDGET — its ancestors up
 * to the highest one that holds no other text-entry control (at most four levels, never past a
 * <form>): the iWorQ box sits in div.input-group > div.autocomplete-template > its section, and the
 * row above that holds the contractor box. With `mark`, the box (data-al-ta-box) and that widget
 * (data-al-ta-widget) are marked for the fill's list and selected-value reads. No nested functions
 * (esbuild keepNames → __name).
 */
export function typeaheadBoxFactsInPage(el: Element, mark: boolean): TypeaheadBoxFacts {
  if (mark) {
    const old = document.querySelectorAll("[data-al-ta-widget], [data-al-ta-box], [data-al-ta-pre]");
    for (let i = 0; i < old.length; i++) {
      old[i].removeAttribute("data-al-ta-widget");
      old[i].removeAttribute("data-al-ta-box");
      old[i].removeAttribute("data-al-ta-pre");
    }
  }
  const box = el as HTMLInputElement;
  const type = String(el.getAttribute("type") || "text").toLowerCase();
  const textBox = el.tagName === "INPUT" && (type === "text" || type === "search");
  const editable = !box.readOnly && !box.disabled && el.getAttribute("aria-readonly") !== "true" && el.getAttribute("aria-disabled") !== "true";
  const ENTRY = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea, [contenteditable="true"], [contenteditable=""]';
  const widgetClasses: string[] = [];
  let widget: Element | null = null;
  let p: Element | null = el.parentElement;
  for (let depth = 0; depth < 4 && p && p !== document.body && p !== document.documentElement && p.tagName !== "FORM"; depth++) {
    const entries = p.querySelectorAll(ENTRY);
    let other = false;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i] !== el) { other = true; break; }
    }
    if (other) break;
    widget = p;
    widgetClasses.push(String(p.getAttribute("class") || "").slice(0, 300));
    p = p.parentElement;
  }
  if (mark) {
    el.setAttribute("data-al-ta-box", "1");
    if (widget) widget.setAttribute("data-al-ta-widget", "1");
  }
  return {
    textBox,
    editable,
    role: String(el.getAttribute("role") || ""),
    ariaAutocomplete: String(el.getAttribute("aria-autocomplete") || ""),
    className: String(el.getAttribute("class") || "").slice(0, 300),
    id: String(el.getAttribute("id") || "").slice(0, 120),
    ariaLabel: String(el.getAttribute("aria-label") || "").slice(0, 200),
    widgetClasses,
  };
}

/**
 * Runs IN THE PAGE (#244). Stamp what is on screen inside the box's widget (data-al-ta-pre) before a
 * query is typed, so a list that appears there afterwards is told from what was already showing — a
 * Vue list kept in the DOM while hidden (v-show) counts as new when it shows. No nested functions.
 */
export function stampTypeaheadWidgetInPage(): void {
  const old = document.querySelectorAll("[data-al-ta-pre]");
  for (let i = 0; i < old.length; i++) old[i].removeAttribute("data-al-ta-pre");
  const widget = document.querySelector("[data-al-ta-widget]");
  if (!widget) return;
  const all = widget.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const n = all[i] as HTMLElement;
    const r = n.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const s = getComputedStyle(n);
    if (s.visibility === "hidden" || s.display === "none") continue;
    n.setAttribute("data-al-ta-pre", "1");
  }
}

/** #244 fix round — the mark on a hidden input a fill has SEEN its widget empty when a query was typed:
 *  the widget's own selection, remembered for this document (a later fill of the same box starts
 *  from an empty value, because the first one's typing or clear emptied it). */
export const TYPEAHEAD_OWNED_ATTR = "data-al-ta-owned";

/**
 * Runs IN THE PAGE (#244). The hidden inputs inside the box's widget, in order, each keyed by its
 * name (or id) and its ordinal among inputs of that name, so two reads are compared input by input,
 * with whether an earlier fill marked it the widget's own (TYPEAHEAD_OWNED_ATTR). Which of them is
 * the widget's SELECTED value is decided by the caller (selectionInputsToWatch), never by being
 * hidden and nearby. No nested functions.
 */
export function typeaheadWidgetHiddenInPage(): Array<{ key: string; name: string; value: string; owned: boolean }> {
  const out: Array<{ key: string; name: string; value: string; owned: boolean }> = [];
  const widget = document.querySelector("[data-al-ta-widget]");
  if (!widget) return out;
  const hidden = widget.querySelectorAll('input[type="hidden"]');
  const seen: Record<string, number> = {};
  for (let i = 0; i < hidden.length; i++) {
    const h = hidden[i] as HTMLInputElement;
    const name = String(h.getAttribute("name") || h.getAttribute("id") || "").slice(0, 60);
    seen[name] = (seen[name] ?? 0) + 1;
    out.push({ key: `${name}#${seen[name]}`, name, value: String(h.value ?? ""), owned: h.getAttribute("data-al-ta-owned") === "1" });
  }
  return out;
}

/** Runs IN THE PAGE (#244 fix round). Mark the widget's hidden inputs named by `keys` (as keyed by
 *  typeaheadWidgetHiddenInPage) as its own selection. No nested functions. */
export function markOwnedHiddenInPage(keys: string[]): void {
  const widget = document.querySelector("[data-al-ta-widget]");
  if (!widget || !Array.isArray(keys) || !keys.length) return;
  const hidden = widget.querySelectorAll('input[type="hidden"]');
  const seen: Record<string, number> = {};
  for (let i = 0; i < hidden.length; i++) {
    const h = hidden[i];
    const name = String(h.getAttribute("name") || h.getAttribute("id") || "").slice(0, 60);
    seen[name] = (seen[name] ?? 0) + 1;
    if (keys.indexOf(`${name}#${seen[name]}`) >= 0) h.setAttribute("data-al-ta-owned", "1");
  }
}

/** THE WIDGET'S OWN SELECTED VALUE, BY WHAT IT DID (#244 fix round): the hidden inputs in the box's
 *  widget that are EMPTY once the query is typed and that the widget demonstrably owns — it emptied
 *  them itself (a value before anything was typed, none after), or an earlier fill in this document
 *  saw it do so (TYPEAHEAD_OWNED_ATTR: that fill's typing or clear is why this one starts empty). A
 *  pick must write one of them again. A hidden input that was empty all along proves nothing about
 *  ownership and is never watched: an unrelated empty ClientState beside the box (Accela's shape)
 *  and a widget that writes its id only on change/blur both failed correct picks when every empty
 *  hidden input in the widget was watched (review of 5eb51ad3, shapes S1 and S2). */
export function selectionInputsToWatch(
  atRest: ReadonlyArray<{ key: string; value: string }> | null | undefined,
  typed: ReadonlyArray<{ key: string; name: string; value: string; owned?: boolean }> | null | undefined,
): Array<{ key: string; name: string }> {
  const rest = new Map((Array.isArray(atRest) ? atRest : []).map((h) => [h.key, String(h.value ?? "")]));
  return (Array.isArray(typed) ? typed : [])
    .filter((h) => String(h.value ?? "") === "" && (!!rest.get(h.key) || h.owned === true))
    .map((h) => ({ key: h.key, name: h.name }));
}

/** Did the pick write the widget's selection again? Any watched input holding a value again is a
 *  yes; one that is gone (the widget re-rendered) is no opinion, so a yes; none watched is a yes. */
export function selectionRewritten(
  watched: ReadonlyArray<{ key: string }>,
  after: ReadonlyArray<{ key: string; value: string }> | null | undefined,
): boolean {
  if (!watched.length) return true;
  const now = new Map((Array.isArray(after) ? after : []).map((h) => [h.key, String(h.value ?? "")]));
  return watched.some((w) => !now.has(w.key) || now.get(w.key) !== "");
}

/** THE BOX'S OWN MARKUP, JUDGED (#244): the reason it is a search-as-you-type box, "" when it is not
 *  or cannot be read. One read, bounded; the learner's, the replay's and the gap-fill's fill doors
 *  all ask it. Never throws (a stub locator's evaluate may not even return a promise). */
export async function typeaheadBoxReason(loc: any): Promise<string> {
  if (!loc || typeof loc.evaluate !== "function") return "";
  try {
    const facts = await loc.evaluate(typeaheadBoxFactsInPage, false, { timeout: 1500 });
    return typeaheadBoxSays(facts as TypeaheadBoxFacts | null);
  } catch {
    return "";
  }
}

/**
 * Runs IN THE PAGE. The visible suggestion rows of the box's list, in order, each marked
 * data-al-sugg="<its index>" so the row that was read is the row that is clicked. The list is the
 * one the box names (aria-controls / aria-owns), else the last list that was not on screen before
 * typing (comboboxFill's fresh-popup stamp), else (#244) a list that appeared INSIDE the box's own
 * widget since the query was typed (data-al-ta-widget / data-al-ta-pre) — an iWorQ Vue autocomplete
 * renders its results there with no role and no menu/option class, so neither reading above saw
 * them (City of Star, live 2026-11-15: the panel spans the widget's column, not the box). No nested
 * functions (esbuild keepNames → __name).
 */
export function readSuggestionsInPage(args: { controlsId: string; fresh: string }): string[] {
  const out: string[] = [];
  const marked = document.querySelectorAll("[data-al-sugg]");
  for (let i = 0; i < marked.length; i++) marked[i].removeAttribute("data-al-sugg");
  const lists: Element[] = [];
  if (args.controlsId) {
    for (const id of args.controlsId.split(/\s+/)) {
      const own = id ? document.getElementById(id) : null;
      if (own) lists.push(own);
    }
  }
  if (!lists.length && args.fresh) {
    const fresh = Array.from(document.querySelectorAll(args.fresh));
    for (let i = fresh.length - 1; i >= 0; i--) lists.push(fresh[i]);
  }
  // #244 — read only when nothing above had rows: the outermost lists inside the box's widget that
  // were not on screen before typing (and do not hold the box), then, as a last reading, the widget
  // itself, whose rows are only the option / li elements that appeared since typing.
  const widget = document.querySelector("[data-al-ta-widget]");
  const boxEl = document.querySelector("[data-al-ta-box]");
  if (widget) {
    const found = widget.querySelectorAll('[role="listbox"], [role="list"], ul, ol');
    const own: Element[] = [];
    for (let i = 0; i < found.length; i++) {
      const l = found[i];
      if (l.hasAttribute("data-al-ta-pre") || (boxEl && l.contains(boxEl))) continue;
      let inner = false;
      for (let j = 0; j < own.length; j++) {
        if (own[j].contains(l)) { inner = true; break; }
      }
      if (!inner) own.push(l);
    }
    for (let i = 0; i < own.length; i++) lists.push(own[i]);
    lists.push(widget);
  }
  for (const list of lists) {
    const lr = (list as HTMLElement).getBoundingClientRect();
    const ls = getComputedStyle(list as HTMLElement);
    if (lr.width <= 0 || lr.height <= 0 || ls.visibility === "hidden" || ls.display === "none") continue;
    let rows: Element[] = [];
    if (list === widget) {
      const cand = widget.querySelectorAll('[role="option"], li');
      for (let i = 0; i < cand.length; i++) {
        if (!cand[i].hasAttribute("data-al-ta-pre") && !(boxEl && cand[i].contains(boxEl))) rows.push(cand[i]);
      }
    } else {
      rows = Array.from(list.querySelectorAll('[role="option"]'));
      if (!rows.length) rows = Array.from(list.querySelectorAll("li"));
      if (!rows.length) rows = Array.from(list.children);
    }
    for (const row of rows) {
      const r = (row as HTMLElement).getBoundingClientRect();
      const s = getComputedStyle(row as HTMLElement);
      if (r.width <= 0 || r.height <= 0 || s.visibility === "hidden" || s.display === "none") continue;
      if (row.getAttribute("aria-disabled") === "true") continue;
      const text = String((row as HTMLElement).innerText || row.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      row.setAttribute("data-al-sugg", String(out.length));
      out.push(text.slice(0, 300));
      if (out.length >= 50) break;
    }
    if (out.length) break; // the first list with rows is the box's list
  }
  return out;
}

/**
 * Runs IN THE PAGE. Whether the box's suggestion panel shows that it is still loading: a visible
 * progress bar, spinner or aria-busy in the list the box names (and up to three of its ancestors,
 * the overlay pane it sits in) or around the box itself. A list that is still loading is not an
 * empty one — a city's GIS search showed its progress bar for longer than the per-query wait, and
 * the fill gave up on a list that was about to answer (#575, live). No nested functions.
 */
export function suggestionsLoadingInPage(args: { controlsId: string }): boolean {
  const roots: Element[] = [];
  if (args.controlsId) {
    for (const id of args.controlsId.split(/\s+/)) {
      let el: Element | null = id ? document.getElementById(id) : null;
      for (let i = 0; i < 4 && el; i++) { roots.push(el); el = el.parentElement; }
    }
  }
  let box: Element | null = document.activeElement;
  for (let i = 0; i < 4 && box && box !== document.body; i++) { roots.push(box); box = box.parentElement; }
  const SEL = '[role="progressbar"], mat-progress-bar, mat-spinner, mat-progress-spinner, [aria-busy="true"], [class*="progress"], [class*="spinner"], [class*="loading"]';
  for (const root of roots) {
    if (root.getAttribute("aria-busy") === "true") return true;
    const found = root.querySelectorAll(SEL);
    for (let i = 0; i < found.length; i++) {
      const el = found[i] as HTMLElement;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0") return true;
    }
  }
  return false;
}

/**
 * Runs IN THE PAGE (#139). What the page SHOWS, for a before/after reading around an Enter:
 *   - `shown`: every visible table row, list row, description value, and the value of every visible
 *     textarea / read-only or disabled text box — where a portal puts the location it selected (a
 *     "Locations" table, a read-only "The location you have selected" box). Never an editable box
 *     (the search box holds what WE typed), and never a row of a suggestion list (a list is not a
 *     selection: an open menu holding the job's address picked nothing);
 *   - `notes`: short visible texts (alerts, status lines, list rows, validation messages) — where a
 *     portal says its search found nothing. Judged in Node (noMatchSaid).
 * No nested functions (esbuild keepNames → __name).
 */
export function pageShowsInPage(): { shown: string[]; notes: string[] } {
  const shown: string[] = [];
  const notes: string[] = [];
  const LIST = "[role=listbox], [role=option], [role=menu], [role=menuitem], .ui-autocomplete, .ui-menu, [data-al-sugg]";
  const rows = document.querySelectorAll("tr, li, dd, [role=row], [role=listitem], textarea, input");
  for (let i = 0; i < rows.length && shown.length < 300; i++) {
    const el = rows[i] as HTMLElement;
    if (el.closest && el.closest(LIST)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0 || cs.visibility === "hidden" || cs.display === "none") continue;
    let text = "";
    if (el.tagName === "TEXTAREA") text = (el as HTMLTextAreaElement).value;
    else if (el.tagName === "INPUT") {
      const box = el as HTMLInputElement;
      const type = String(box.type || "text").toLowerCase();
      if (type !== "text" && type !== "search") continue;
      if (!box.readOnly && !box.disabled) continue;
      text = box.value;
    } else text = String(el.innerText || el.textContent || "");
    text = text.replace(/\s+/g, " ").trim();
    if (text && text.length <= 300 && shown.indexOf(text) < 0) shown.push(text);
  }
  const msgs = document.querySelectorAll("[role=alert], [role=status], [aria-live], li, p, span, div, td, strong, em, label");
  for (let i = 0; i < msgs.length && notes.length < 200; i++) {
    const el = msgs[i] as HTMLElement;
    if (el.getAttribute("aria-live") === "off") continue;
    const text = String(el.innerText || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 200 || notes.indexOf(text) >= 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    notes.push(text);
  }
  return { shown, notes };
}

/** Read pageShowsInPage in `doc`, tolerating a document that is mid-navigation (null then). */
async function readShows(doc: any): Promise<{ shown: string[]; notes: string[] } | null> {
  await doc.evaluate(NAME_SHIM).catch(() => null);
  const r = await doc.evaluate(pageShowsInPage).catch(() => null);
  return r && Array.isArray(r.shown) && Array.isArray(r.notes) ? r : null;
}

/** The no-match sentence in `after` that was not on screen in `before`, else one at all ("" when
 *  none) — THE SHORTEST, so it is the portal's own words and not a container that holds them (#244:
 *  the quote read "* Property Information No results match your search * Contractor(s) Contractors
 *  with expired licenses…", the whole row of an iWorQ form, which also named the other box). */
function freshNoMatch(before: string[] | null | undefined, after: string[] | null | undefined, freshOnly = false): string {
  const old = new Set(before ?? []);
  const said = (after ?? []).map(noMatchSaid).filter(Boolean);
  const shortest = (list: string[]): string => list.reduce((a, b) => (b.length < a.length ? b : a), list[0] ?? "");
  // `freshOnly`: only a sentence that was NOT on screen before the typing. The fallback (a sentence
  // that was already there — static help copy "Address not found? Call the permit desk.", another
  // box's leftover panel) is still worth quoting, but it is not the portal's answer to THIS search
  // (review of d1c7acd1): a caller that remembers "already answered" must not remember it.
  return shortest(said.filter((t) => !old.has(t))) || (freshOnly ? "" : shortest(said));
}

/** THE SHARED ENTER QUESTION (hard rule 1), asked of this box in its own document: "" = Enter may be
 *  pressed here; otherwise the refusal. Unreadable → refused. */
async function enterRefusal(doc: any, loc: any): Promise<string> {
  if (typeof doc.evaluate !== "function" || typeof loc.evaluate !== "function") return "the box could not be read";
  await doc.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
  return String(await loc.evaluate((el: Element, g: string) => {
    const ps = (globalThis as any)[g];
    return ps && typeof ps.enterRefusalInPage === "function" ? ps.enterRefusalInPage(el) : "the page's safety predicates are not installed";
  }, PORTAL_SAFETY_GLOBAL).catch(() => "the box could not be read") ?? "the box could not be read");
}

/**
 * Runs IN THE PAGE (#198, Tigard's results panel). The TICKABLE RESULT ROWS a search brought: visible
 * checkboxes that were not on the page before the search (data-al-oldcb), each read by the nearest
 * ancestor (≤4 levels) whose text is a short line holding a digit. "Select All" is never a row. Stamps
 * each row's checkbox data-al-tsr=<index>; returns the texts in order. No nested functions.
 */
export function searchResultRowsInPage(): string[] {
  document.querySelectorAll("[data-al-tsr]").forEach((n) => n.removeAttribute("data-al-tsr"));
  const out: string[] = [];
  const boxes = document.querySelectorAll('input[type=checkbox]:not([data-al-oldcb]), [role=checkbox]:not([data-al-oldcb])');
  for (let i = 0; i < boxes.length && out.length < 25; i++) {
    const cb = boxes[i] as HTMLElement;
    let node: HTMLElement | null = cb.parentElement;
    let text = "";
    let row: HTMLElement | null = null;
    for (let up = 0; up < 4 && node && node !== document.body; up++, node = node.parentElement) {
      const t = String(node.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length >= 5 && t.length <= 300 && /\d/.test(t)) { text = t; row = node; break; }
      if (t.length > 300) break;
    }
    if (!text || !row || /^select\s+all\b/i.test(text)) continue;
    const r = row.getBoundingClientRect();
    const cs = getComputedStyle(row);
    if (r.width <= 0 || r.height <= 0 || cs.visibility === "hidden" || cs.display === "none") continue;
    cb.setAttribute("data-al-tsr", String(out.length));
    out.push(text);
  }
  return out;
}

/**
 * Runs IN THE PAGE, on a ticked result row's checkbox (#198). THE PANEL'S OWN "ADD": searching the
 * row's ancestors outward (≤6 levels, never <body>), the first level holding any visible control whose
 * whole label reads add / add selected / add location / select / use selected — exactly one there, or
 * nothing. Never submit- or pay-worded by the shared predicates. Stamps data-al-tsadd="1".
 */
export function resultPanelAddInPage(cb: Element, g: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ps = (globalThis as any)[g];
  document.querySelectorAll("[data-al-tsadd]").forEach((n) => n.removeAttribute("data-al-tsadd"));
  const WORDS = /^\+?\s*(?:add(?:\s+(?:selected|location|address|parcel|to\s+application))?|select(?:ed)?|use\s+selected)$/i;
  let node: Element | null = cb.parentElement;
  for (let level = 0; level < 6 && node && node !== document.body && node !== document.documentElement; level++, node = node.parentElement) {
    const found = node.querySelectorAll("button, input[type=button], [role=button], a");
    const fit: HTMLElement[] = [];
    const labels: string[] = [];
    for (let i = 0; i < found.length; i++) {
      const c = found[i] as HTMLElement;
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      if (r.width <= 0 || r.height <= 0 || cs.visibility === "hidden" || cs.display === "none") continue;
      const text = String(c.innerText || (c as HTMLInputElement).value || c.getAttribute("aria-label") || c.getAttribute("title") || "").replace(/\s+/g, " ").trim();
      if (!text || !WORDS.test(text)) continue;
      if (ps && ((typeof ps.isSubmitIntent === "function" && ps.isSubmitIntent(text, null)) || (typeof ps.isPayFee === "function" && ps.isPayFee(text)))) continue;
      fit.push(c);
      labels.push(text);
    }
    if (fit.length > 1) return "";
    if (fit.length === 1) { fit[0].setAttribute("data-al-tsadd", "1"); return labels[0]; }
  }
  return "";
}

/** #198 — after the box's own search: tick the ONE result row that is the job's address and press the
 *  results panel's own "Add", then confirm the page now shows the address outside the search box.
 *  "none" when the search brought no tickable rows (the caller reads the page the other ways). */
async function searchResultTickAndAdd(
  page: any, doc: any, loc: any, site: TypeaheadSite, req: TypeaheadRequest, deadline: number,
): Promise<{ kind: "none" } | { kind: "picked"; text: string; why: string; add: string } | { kind: "ask"; question: string; offered: string[]; why: string } | { kind: "failed"; text: string; why: string }> {
  let texts: string[] = [];
  // THE SEARCH IS A NETWORK ROUND TRIP, SO THE ROWS ARE WAITED FOR BY TIME, NOT BY A FEW LOOKS.
  // Live City of Tigard (EnerGov, 2026-11-15): the Esri geocode answers in a few seconds; six looks
  // 400 ms apart read "no rows" where the learn, with more time already spent on the box, had ticked
  // one. Up to SEARCH_RESULT_WAIT_MS, never past the fill's deadline (which the search phase extends
  // for itself in fillTypeahead, so this never starves a later read).
  const rowsUntil = Math.min(Date.now() + SEARCH_RESULT_WAIT_MS, deadline);
  while (Date.now() < rowsUntil) {
    await doc.evaluate(NAME_SHIM).catch(() => null);
    const read = await doc.evaluate(searchResultRowsInPage).catch(() => [] as string[]);
    texts = Array.isArray(read) ? read.map((t: unknown) => String(t ?? "")) : [];
    if (texts.length) break;
    // THE SEARCH MAY ANSWER WITH SUGGESTIONS INSTEAD OF ROWS (the typeaheadFill smoke's "one" shape,
    // an Esri source that lists its hits as options): an address-like option (a digit in it — the
    // row rule) means the search has answered, and the caller reads those options as before. The
    // widget's standing "Use current location" option carries no digit and is not an answer.
    const answered = await doc.evaluate(() => Array.from(document.querySelectorAll("[role='option']")).filter((o) => /\d/.test((o as HTMLElement).textContent || "")).length).catch(() => 0);
    if (Number(answered) > 0) break;
    await page.waitForTimeout?.(400).catch(() => null);
  }
  if (!texts.length) return { kind: "none" };
  const choice = chooseAddressSuggestion(texts, site);
  if (choice.kind === "ask") return { kind: "ask", question: choice.question, offered: texts, why: choice.why };
  if (choice.kind !== "pick") return { kind: "none" };
  const cb = doc.locator(`[data-al-tsr="${choice.index}"]`).first();
  const ticked = await withAutomationInput(page, () => cb.click({ timeout: 3000 })).then(() => true)
    .catch(() => withAutomationInput(page, () => cb.click({ timeout: 3000, force: true })).then(() => true).catch(() => false));
  if (!ticked) return { kind: "failed", text: choice.text, why: `"${choice.text}" was found in the search results but its checkbox could not be ticked` };
  // The panel's "Add" appears once a row is ticked: look for it near the row, briefly.
  let addLabel = "";
  for (let i = 0; i < 6 && !addLabel && Date.now() < deadline; i++) {
    await page.waitForTimeout?.(400).catch(() => null);
    await doc.evaluate(PORTAL_SAFETY_IN_PAGE_SOURCE).catch(() => null);
    addLabel = String(await cb.evaluate(resultPanelAddInPage, PORTAL_SAFETY_GLOBAL).catch(() => "") ?? "");
  }
  if (!addLabel) return { kind: "failed", text: choice.text, why: `ticked "${choice.text}" in the search results and the panel offered no single "Add" to put it on the application` };
  const add = doc.locator('[data-al-tsadd="1"]').first();
  const addRefused = req.clickGate
    ? String(await req.clickGate(add).catch((e: unknown) => `the click gate could not answer (${String((e as Error)?.message ?? e).slice(0, 80)})`) ?? "")
    : "";
  if (addRefused) return { kind: "failed", text: choice.text, why: `ticked "${choice.text}" but the panel's "${addLabel}" was refused: ${addRefused.slice(0, 120)}` };
  const urlBefore = typeof page.url === "function" ? page.url() : "";
  const added = await withAutomationInput(page, () => add.click({ timeout: 4000 })).then(() => true).catch(() => false);
  if (!added) return { kind: "failed", text: choice.text, why: `ticked "${choice.text}" and the panel's "${addLabel}" could not be pressed` };
  // CONFIRMED BY THE PAGE: the results panel's Add is gone (or the page moved) and the job's address
  // is now shown on the page outside any input — the application's location card.
  const house = (String(site.street ?? "").match(/^\s*(\d+[A-Za-z]?)\b/) ?? [])[1] ?? "";
  for (let i = 0; i < 15 && Date.now() < deadline + 5000; i++) {
    await page.waitForTimeout?.(400).catch(() => null);
    const gone = !(await add.isVisible().catch(() => false)) || (typeof page.url === "function" && page.url() !== urlBefore);
    if (!gone) continue;
    const shows = house ? await doc.evaluate((h: string) => {
      const body = String((document.body && (document.body as HTMLElement).innerText) || "");
      return new RegExp(`(^|[^0-9])${h}([^0-9]|$)`).test(body);
    }, house).catch(() => false) : true;
    if (shows) return { kind: "picked", text: choice.text, why: choice.why, add: addLabel };
  }
  return { kind: "failed", text: choice.text, why: `ticked "${choice.text}" and pressed the panel's "${addLabel}", and the page did not then show the address` };
}

/**
 * Runs IN THE PAGE, on the box (#198). THE BOX'S OWN SEARCH CONTROL: searching the box's ancestors
 * outward, at most three levels and never <body>, the first level holding any qualifying control —
 * and exactly ONE there, or nothing. A control qualifies when its whole short label reads as a search
 * ("Search", "Find", "Go", "Look up", "Search address") or, wordless, it is drawn as a magnifier (its
 * own or a child's class / icon name says search or magnif). Never a submitter (a submit / image
 * input, a button that submits its form: the box's form may be the application), never submit- or
 * pay-worded by the shared predicates. Stamps it data-al-tsb="1"; returns its label ("search" when
 * wordless), or "". No nested functions (esbuild keepNames → __name).
 */
export function ownSearchControlInPage(box: Element, g: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ps = (globalThis as any)[g];
  document.querySelectorAll("[data-al-tsb]").forEach((n) => n.removeAttribute("data-al-tsb"));
  const WORDS = /^(?:search|find|go|look\s?-?up|search\s+(?:address(?:es)?|location|parcels?)|find\s+(?:address|location|parcel))$/i;
  let node: Element | null = box.parentElement;
  for (let level = 0; level < 3 && node && node !== document.body && node !== document.documentElement; level++, node = node.parentElement) {
    const found = node.querySelectorAll("button, input[type=button], input[type=submit], input[type=image], [role=button]");
    const fit: HTMLElement[] = [];
    const labels: string[] = [];
    for (let i = 0; i < found.length; i++) {
      const c = found[i] as HTMLElement;
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c);
      if (r.width <= 0 || r.height <= 0 || cs.visibility === "hidden" || cs.display === "none") continue;
      const type = String(c.getAttribute("type") || "").toLowerCase();
      const inForm = !!(c as HTMLButtonElement).form;
      if ((c.tagName === "INPUT" && (type === "submit" || type === "image")) || (c.tagName === "BUTTON" && inForm && (type === "" || type === "submit"))) continue;
      const text = String(c.innerText || (c as HTMLInputElement).value || c.getAttribute("aria-label") || c.getAttribute("title") || "")
        .replace(/\s+/g, " ").trim();
      if (ps && ((typeof ps.isSubmitIntent === "function" && ps.isSubmitIntent(text, null)) || (typeof ps.isPayFee === "function" && ps.isPayFee(text)))) continue;
      let worded = !!text && text.length <= 30 && WORDS.test(text);
      if (!text) {
        const drawn = [String(c.className || ""), c.getAttribute("data-icon") || ""];
        const kids = c.querySelectorAll("svg, i, span, img");
        for (let k = 0; k < kids.length && k < 6; k++) {
          const kid = kids[k] as Element;
          drawn.push(String(kid.getAttribute("class") || ""), kid.getAttribute("data-icon") || "", kid.getAttribute("alt") || "");
        }
        worded = /search|magnif/i.test(drawn.join(" "));
      }
      if (!worded) continue;
      fit.push(c);
      labels.push(text || "search");
    }
    if (fit.length > 1) return "";
    if (fit.length === 1) { fit[0].setAttribute("data-al-tsb", "1"); return labels[0]; }
  }
  return "";
}

/**
 * Press Enter in the box (the whole one-line address is in it) and read what the portal selected:
 * the texts that appeared on the page (pageShowsInPage `shown`, before vs after) judged by the ONE
 * address predicate. A postback reloads the document — every read tolerates that and retries until
 * the page answers, bounded by `untilMs` and the fill's deadline. Returns the choice (a pick or a
 * question over the NEW texts) and the portal's no-match words when it printed any.
 */
async function enterAndReadSelection(
  page: any, doc: any, loc: any, site: TypeaheadSite, before: { shown: string[]; notes: string[] } | null, deadline: number,
  press?: () => Promise<unknown>,
): Promise<{ choice: ReturnType<typeof chooseAddressSuggestion> | null; said: string; saidFresh: boolean; pressed: boolean }> {
  // A box inside a form posts the form back on Enter: wait for THAT navigation (a real postback can
  // take seconds to start), never read the old document's stillness as "nothing selected".
  const inForm = await loc.evaluate((el: Element) => !!(el as HTMLInputElement).form).catch(() => false);
  const navigated = inForm && typeof doc.waitForNavigation === "function"
    ? doc.waitForNavigation({ waitUntil: "domcontentloaded", timeout: Math.max(0, Math.min(8_000, deadline - Date.now())) }).then(() => true).catch(() => false)
    : Promise.resolve(false);
  // `press`: the box's own search control (#198) instead of Enter — read exactly the same way.
  const pressed = await withAutomationInput(page, () => (press ? press() : loc.press("Enter", { timeout: 3000 }))).then(() => true).catch(() => false);
  if (!pressed) return { choice: null, said: "", saidFresh: false, pressed: false };
  await navigated;
  const old = new Set(before?.shown ?? []);
  const until = Math.min(Date.now() + 6_000, deadline);
  let said = "";
  let saidFresh = false;
  let quiet = 0;
  let lastSig = "";
  while (Date.now() < until) {
    await page.waitForTimeout?.(300).catch(() => null);
    await page.waitForLoadState?.("domcontentloaded", { timeout: 3000 }).catch(() => null);
    const now = await readShows(doc);
    if (!now) continue; // mid-navigation
    const fresh = now.shown.filter((t) => !old.has(t));
    const freshSaid = freshNoMatch(before?.notes, now.notes, true);
    if (freshSaid) saidFresh = true;
    said = freshSaid || freshNoMatch(before?.notes, now.notes) || said;
    if (fresh.length) {
      const choice = chooseAddressSuggestion(fresh, site);
      if (choice.kind === "pick" || choice.kind === "ask") return { choice, said, saidFresh, pressed: true };
    }
    // Nothing selected (yet): settle once the page has held still for a moment, or said "no match".
    const sig = JSON.stringify(now.shown);
    quiet = sig === lastSig ? quiet + 1 : 0;
    lastSig = sig;
    if (said && quiet >= 1) break;
    if (quiet >= 4) break;
  }
  return { choice: null, said, saidFresh, pressed: true };
}

/** Poll until the suggestions hold still (two equal reads in a row) or the wait ends. Returns the
 *  last read, raw (indexes line up with the data-al-sugg marks); [] when nothing real was offered.
 *  While the panel shows it is still loading (suggestionsLoadingInPage) the wait carries on past
 *  its own length, never past the fill's deadline. */
async function settledSuggestions(page: any, controlsId: string, waitMs: number, deadline: number): Promise<string[]> {
  const until = Math.min(Date.now() + waitMs, deadline);
  let prev = "";
  let last: string[] = [];
  let loading = false;
  while (Date.now() < until || (loading && Date.now() < deadline)) {
    await page.waitForTimeout?.(250).catch(() => null);
    const read = await page.evaluate(readSuggestionsInPage, { controlsId, fresh: FRESH_POPUP_SELECTORS }).catch(() => [] as string[]);
    const rows = Array.isArray(read) ? read.map((t) => String(t ?? "")) : [];
    const sig = JSON.stringify(rows);
    if (rows.some((t) => suggestionText(t)) && sig === prev) return rows;
    prev = sig;
    last = rows;
    loading = rows.some((t) => suggestionText(t))
      ? false
      : Boolean(await page.evaluate(suggestionsLoadingInPage, { controlsId }).catch(() => false));
  }
  return last.some((t) => suggestionText(t)) ? last : [];
}

/** Empty the box, and close a list it left open. Never Enter. */
async function clearBox(page: any, loc: any, controlsId: string): Promise<void> {
  await loc.fill("", { timeout: 2000 }).catch(() => null);
  await page.waitForTimeout?.(200).catch(() => null);
  const open = await page.evaluate(readSuggestionsInPage, { controlsId, fresh: FRESH_POPUP_SELECTORS }).catch(() => [] as string[]);
  if (Array.isArray(open) && open.length && typeof loc.press === "function") await loc.press("Escape", { timeout: 1000 }).catch(() => null);
  await page.evaluate(() => { document.querySelectorAll("[data-al-sugg]").forEach((n) => n.removeAttribute("data-al-sugg")); }).catch(() => null);
}

/** The document the box lives in: its own frame (an application rendered in an iframe keeps its
 *  list there too), else the page. Reads, marks and the pick's click all happen in it. */
async function ownerScope(page: any, loc: any): Promise<any> {
  try {
    const h = typeof loc.elementHandle === "function" ? await loc.elementHandle({ timeout: 1500 }) : null;
    const f = h && typeof h.ownerFrame === "function" ? await h.ownerFrame() : null;
    await h?.dispose?.().catch(() => null);
    if (f && typeof f.evaluate === "function" && typeof f.locator === "function") return f;
  } catch { /* the page, as before */ }
  return page;
}

/** Type with real keystrokes (typeaheads listen to key and input events), inside the backstop's
 *  automation fence. Bounded. */
async function typeInto(page: any, loc: any, text: string): Promise<boolean> {
  if (typeof loc.pressSequentially === "function") {
    return withAutomationInput(page, () => loc.pressSequentially(text, { delay: 40, timeout: 10_000 })).then(() => true).catch(() => false);
  }
  return loc.fill(text, { timeout: 4000 }).then(() => true).catch(() => false);
}

// ---------------------------------------------------------------------------
// #161 — THE REQUIRED SELECTION A LOCATION PICK FILLS, AND THE FORWARD CLICK THAT DEPENDS ON IT.
//
// A location step is a type-ahead whose pick fills a READ-ONLY, REQUIRED box beside it ("The location
// you have selected"); the step's forward control ("Next Step") posts whatever that box holds. A pick
// the search box shows but that box never took, or a box holding another address, must not be walked
// past: the forward control is refused, named, for a person (owner's settling of #161, 2026-11-24:
// "never click forward on an empty required location"). Read before the fill and again after a
// pick; judged again just before the forward click, in every frame, by id or name (an Enter postback
// re-renders the page). Agreement is the ONE address predicate (chooseAddressSuggestion), or the
// job's tax lot / parcel inside the box's words.
// ---------------------------------------------------------------------------

/** A read-only required box a location pick fills: how it is found again, its label, its value. */
export interface LocationResultBox { key: string; how: "id" | "name" | "mark"; label: string; value: string }

/** A label that names a LOCATION SELECTION (generic; no place names): "The location you have
 *  selected", "Parcel", "Tax lot", "Property address", "Selected address". Never a bare component
 *  ("City", "Zip", "State") or a bare "Address" (a mailing or contractor address may sit beside it). */
export const LOCATION_SELECTION_LABEL = /\blocation\b|\bparcel\b|\btax\s*lot\b|\b(property|site|project|job|work)\s+address\b|\b(selected|chosen)\b.*\baddress\b|\baddress\b.*\b(selected|chosen)\b/i;

/**
 * Runs IN THE PAGE (#161). The VISIBLE read-only (or disabled) text boxes of the type-ahead box's
 * form — the page when it has none — that are REQUIRED (required / aria-required, an asterisk in
 * the label, a label marked required), with their values. Each is keyed by id, else name, else a
 * data-al-locres mark. No nested functions (esbuild keepNames -> __name).
 */
export function locationResultBoxesInPage(el: Element): LocationResultBox[] {
  const own = el as HTMLInputElement;
  const scope: ParentNode = own.form || (el.closest ? el.closest("form") : null) || document;
  const out: LocationResultBox[] = [];
  const all = Array.from(scope.querySelectorAll("input, textarea"));
  let n = 0;
  for (const c of all) {
    if (c === el) continue;
    const type = String(c.getAttribute("type") || "text").toLowerCase();
    if (c.tagName === "INPUT" && type !== "text" && type !== "search") continue;
    const i = c as HTMLInputElement;
    if (!(i.readOnly || i.disabled || c.getAttribute("aria-readonly") === "true")) continue;
    const r = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    if (!(r.width > 1 && r.height > 1) || cs.display === "none" || cs.visibility === "hidden") continue;
    const id = c.getAttribute("id") || "";
    let labelEl: Element | null = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    if (!labelEl) labelEl = c.closest("label");
    const raw = String((labelEl && labelEl.textContent) || c.getAttribute("aria-label") || c.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    const required = i.required || c.getAttribute("aria-required") === "true" || /\*/.test(raw)
      || (!!labelEl && /(^|[\s_-])required($|[\s_-])/i.test(String(labelEl.getAttribute("class") || "")));
    if (!required) continue;
    const name = c.getAttribute("name") || "";
    let key = id;
    let how: "id" | "name" | "mark" = "id";
    if (!key && name) { key = name; how = "name"; }
    if (!key) { n++; key = `r${n}`; how = "mark"; c.setAttribute("data-al-locres", key); }
    out.push({ key, how, label: raw.replace(/\*/g, "").replace(/\s+/g, " ").trim().slice(0, 80), value: String(i.value ?? "").replace(/\s+/g, " ").trim() });
  }
  return out;
}

/** Runs IN THE PAGE (#161). The current value of each keyed box; `found` false where it is not here. */
export function locationResultReadInPage(keys: Array<{ key: string; how: string }>): Array<{ key: string; how: string; found: boolean; value: string }> {
  const out: Array<{ key: string; how: string; found: boolean; value: string }> = [];
  for (const k of keys) {
    let el: Element | null = null;
    if (k.how === "id") el = document.getElementById(k.key);
    else if (k.how === "name") el = document.querySelector(`input[name="${CSS.escape(k.key)}"], textarea[name="${CSS.escape(k.key)}"]`);
    else el = document.querySelector(`[data-al-locres="${CSS.escape(k.key)}"]`);
    out.push({ key: k.key, how: k.how, found: !!el, value: el ? String((el as HTMLInputElement).value ?? "").replace(/\s+/g, " ").trim() : "" });
  }
  return out;
}

/** The boxes, read now in the page and each of its frames (the first frame that has a box answers for it). */
export async function readLocationResultBoxes(page: any, boxes: LocationResultBox[]): Promise<Array<LocationResultBox & { found: boolean }>> {
  const keys = boxes.map((b) => ({ key: b.key, how: b.how }));
  const docs: any[] = [page];
  try {
    const main = typeof page?.mainFrame === "function" ? page.mainFrame() : null;
    for (const f of (typeof page?.frames === "function" ? page.frames() : []) as any[]) if (f && f !== main && typeof f.evaluate === "function") docs.push(f);
  } catch { /* the page alone */ }
  const got = new Map<string, string>();
  for (const d of docs) {
    if (got.size === keys.length) break;
    const read = await d.evaluate?.(locationResultReadInPage, keys).catch(() => null) as Array<{ key: string; how: string; found: boolean; value: string }> | null;
    for (const r of Array.isArray(read) ? read : []) if (r.found && !got.has(`${r.how}\u0000${r.key}`)) got.set(`${r.how}\u0000${r.key}`, r.value);
  }
  return boxes.map((b) => {
    const k = `${b.how}\u0000${b.key}`;
    return { ...b, found: got.has(k), value: got.get(k) ?? "" };
  });
}

/** The boxes the forward question judges, from the reads before and after the pick: a box whose label
 *  names a location selection (LOCATION_SELECTION_LABEL), whatever it holds; or a box the pick
 *  changed TO the job's address or tax lot. Not judged: a box the pick filled with a component (a
 *  "City", a "Zip"), or an empty box with no location wording (a date a later step fills). */
export function locationResultBoxesOf(before: LocationResultBox[], after: Array<LocationResultBox & { found: boolean }>, site: TypeaheadSite, parcels: string[] = []): LocationResultBox[] {
  const out: LocationResultBox[] = [];
  for (const b of before) {
    const a = after.find((x) => x.key === b.key && x.how === b.how);
    if (!a || !a.found) continue;
    const named = LOCATION_SELECTION_LABEL.test(b.label);
    const tookTheJob = !!a.value && a.value !== b.value && locationAgrees(a.value, site, parcels);
    if (named || tookTheJob) out.push({ key: b.key, how: b.how, label: b.label, value: a.value });
  }
  return out;
}

const alnum = (s: string): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Does this box's text name the job's location: the job's address by the ONE address predicate, or
 *  its tax lot / parcel (letters and digits only, at least 6) inside the words. */
export function locationAgrees(value: string, site: TypeaheadSite, parcels: string[] = []): boolean {
  const v = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!v) return false;
  if (chooseAddressSuggestion([v], site).kind === "pick") return true;
  const a = alnum(v);
  return parcels.some((p) => { const k = alnum(p); return k.length >= 6 && a.includes(k); });
}

/** THE FORWARD QUESTION (#161): "" = the step's forward control may be clicked, else why not. Each
 *  box the pick fills, read now: missing from the page is not judged (the page moved on); empty, or
 *  holding something that is not the job's location, refuses. */
export function locationResultRefusal(read: Array<LocationResultBox & { found: boolean }>, site: TypeaheadSite, parcels: string[] = []): string {
  for (const b of read) {
    if (!b.found) continue;
    const name = b.label ? `"${b.label}"` : "the location selection";
    if (!b.value) return `the required ${name} box is empty — the location was not selected, so the step's forward control is not clicked`;
    if (!locationAgrees(b.value, site, parcels)) return `the required ${name} box shows "${b.value.slice(0, 80)}", which is not the job's address (${streetOnly(site)}) — the forward control is not clicked`;
  }
  return "";
}

const streetOnly = (site: TypeaheadSite): string => String(site?.street ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "no street on the project";

/** A forward control by its words (the step's own "Next Step", "Continue", "Save and Continue"). */
export const LOCATION_FORWARD_WORDS = /\b(next|continue|proceed|forward|save\s*(and|&)\s*continue)\b/i;

/**
 * Fill one typeahead box. Never throws; every outcome but "picked" leaves the box empty. A pick of
 * the job's own address (mode "site") also says which required read-only boxes it filled
 * (`resultBoxes`, #161), for the forward question.
 */
export async function fillTypeahead(page: any, loc: any, req: TypeaheadRequest): Promise<TypeaheadOutcome> {
  const before: LocationResultBox[] = req.mode === "site" && loc && typeof loc.evaluate === "function"
    ? await loc.evaluate(locationResultBoxesInPage, undefined, { timeout: 1500 }).catch(() => [] as LocationResultBox[])
    : [];
  const out = await fillTypeaheadInner(page, loc, req);
  if (out.outcome !== "picked" || !Array.isArray(before) || !before.length) return out;
  const site: TypeaheadSite = { street: req.site?.street ?? req.value, city: req.site?.city, zip: req.site?.zip, state: req.site?.state };
  const boxes = locationResultBoxesOf(before, await readLocationResultBoxes(page, before), site, req.parcels ?? []);
  return boxes.length ? { ...out, resultBoxes: boxes } : out;
}

/**
 * The fill itself (fillTypeahead wraps it). Never throws; every outcome but "picked" leaves the box empty.
 */
async function fillTypeaheadInner(page: any, loc: any, req: TypeaheadRequest): Promise<TypeaheadOutcome> {
  const budgetMs = req.budgetMs && req.budgetMs > 0 ? req.budgetMs : TYPEAHEAD_BUDGET_DEFAULT_MS;
  const startedAt = Date.now();
  let deadline = startedAt + budgetMs; // extended once when the search phase begins (SEARCH_PHASE_BUDGET_MS)
  const waitMs = req.suggestWaitMs && req.suggestWaitMs > 0 ? req.suggestWaitMs : SUGGEST_WAIT_DEFAULT_MS;
  const value = String(req.value ?? "").replace(/\s+/g, " ").trim();
  if (!page || !loc) return { outcome: "unusable", why: "the box could not be located" };
  if (!value) return { outcome: "unusable", why: "there is no value to type" };
  const visible = await loc.isVisible().catch(() => false);
  const editable = visible && await loc.isEditable({ timeout: 1500 }).catch(() => false);
  if (!editable) return { outcome: "unusable", why: visible ? "the box is read-only or disabled" : "the box is not visible" };
  const controlsId = String((await loc.getAttribute("aria-controls", { timeout: 1500 }).catch(() => null))
    || (await loc.getAttribute("aria-owns", { timeout: 1500 }).catch(() => null)) || "").trim();
  const street = req.site?.street ?? value;
  const site: TypeaheadSite = req.mode === "site"
    ? { street, city: req.site?.city, zip: req.site?.zip, state: req.site?.state }
    : { street };
  // What is typed, in order. The job's own address: its whole one-line form first (Enter allowed
  // there only), then the house number + street-name core, then the house number alone.
  // A value lookup (a company, any other lookup) is typed as itself; an address is widened.
  const valueMode = req.mode === "exact" || req.mode === "company";
  const tries: Array<{ q: string; enter: boolean }> = (valueMode ? [value] : addressQueries(street)).map((q) => ({ q, enter: false }));
  const whole = req.mode === "site" ? oneLineAddress(site) : "";
  if (whole && !tries.some((t) => loose(t.q) === loose(whole))) tries.unshift({ q: whole, enter: true });
  if (!tries.length) return { outcome: "unusable", why: "there is no address to type" };
  const doc = await ownerScope(page, loc);
  await doc.evaluate(NAME_SHIM).catch(() => null);
  // #244: mark the box and its own widget, and what that widget shows before anything is typed, for
  // the widget-local list and the selected-value read-back.
  if (typeof loc.evaluate === "function") await loc.evaluate(typeaheadBoxFactsInPage, true, { timeout: 1500 }).catch(() => null);
  await doc.evaluate(stampTypeaheadWidgetInPage).catch(() => null);
  // The widget's hidden inputs AT REST, before the first clear and the first keystroke: the pick is
  // judged against the ones the typing then empties (selectionInputsToWatch).
  const hiddenAtRest = await doc.evaluate(typeaheadWidgetHiddenInPage).catch(() => [] as Array<{ key: string; name: string; value: string; owned: boolean }>);

  const typed: string[] = [];
  let rows: string[] = [];
  let usedQuery = "";
  let portalSaid = "";
  let portalSaidFresh = false; // set only by a sentence that appeared after the typing (freshNoMatch freshOnly)
  let enterNote = "";
  let searchNote = "";
  let wholeListed = 0;
  const entered = new Set<number>();
  const typedLine = (): string => typed.map((q, i) => `"${q}"${entered.has(i) ? " + Enter" : ""}`).join(" then ") || "nothing";
  try {
    for (const t of tries) {
      if (Date.now() >= deadline) break;
      await clearBox(doc, loc, controlsId);
      // Whatever list is on screen now is not this box's answer to what we are about to type.
      await markExistingPopups(doc);
      await doc.evaluate(stampTypeaheadWidgetInPage).catch(() => null);
      const before = await readShows(doc);
      typed.push(t.q);
      if (!(await typeInto(page, loc, t.q))) continue;
      rows = await settledSuggestions(doc, controlsId, waitMs, deadline);
      if (rows.length) {
        // A list for the WHOLE address that holds nothing like the job's is not the last word: the
        // core (wider) is still typed — and no Enter here, which could take the list's first row.
        if (t.enter && t !== tries[tries.length - 1] && chooseAddressSuggestion(rows, site).kind === "none") {
          wholeListed = rows.map(suggestionText).filter(Boolean).length;
          rows = [];
          continue;
        }
        usedQuery = t.q;
        break;
      }
      const afterTyping = await readShows(doc);
      const freshSaid = freshNoMatch(before?.notes, afterTyping?.notes, true);
      if (freshSaid) portalSaidFresh = true;
      portalSaid = freshSaid || freshNoMatch(before?.notes, afterTyping?.notes) || portalSaid;
      if (!t.enter || Date.now() >= deadline) continue;
      // #161 — A LIST THAT CAME LATE IS STILL THE ANSWER, NEVER ENTER. A type-ahead whose results
      // arrive just after the wait above (a slow geocode) selects by its suggestion: picking a result
      // is what fills the required selection, and Enter would post the form's hidden default instead.
      // Read once more before any Enter; a list now up is judged exactly as the first read's.
      {
        const late = await settledSuggestions(doc, controlsId, LATE_LIST_WAIT_MS, deadline);
        if (late.length) {
          if (t !== tries[tries.length - 1] && chooseAddressSuggestion(late, site).kind === "none") {
            wholeListed = late.map(suggestionText).filter(Boolean).length;
            continue;
          }
          rows = late;
          usedQuery = t.q;
          break;
        }
      }
      // No list for the whole address: a search that runs on Enter (#139), through the caller's Enter
      // door (the replay's guardAction), else the shared Enter question.
      const refusal = req.enterGate
        ? String(await req.enterGate(loc).catch((e: unknown) => `the Enter gate could not answer (${String((e as Error)?.message ?? e).slice(0, 80)})`) ?? "")
        : await enterRefusal(doc, loc);
      // #198 — ENTER REFUSED: THE BOX'S OWN SEARCH CONTROL, ONCE (live City of Tigard, Tyler EnerGov
      // "Add Location": an Esri "Address & Parcel Search" box offered no suggestions, Enter was refused
      // because the page also holds an invoices menu, and its magnifier beside the box was never
      // pressed). A control the box owns — never a submitter, never submit- or pay-worded — is a
      // search, not the page's Enter; what it brings is read like Enter's answer: a results list
      // (suggestion rows, picked by the same address rule below) or a selection the portal shows.
      if (refusal) {
        const searchLabel = req.mode === "site" && typeof loc.evaluate === "function"
          ? String(await loc.evaluate(ownSearchControlInPage, PORTAL_SAFETY_GLOBAL).catch(() => "") ?? "")
          : "";
        if (!searchLabel) { enterNote = ` (Enter was not pressed: ${refusal.slice(0, 160)})`; continue; }
        const control = doc.locator('[data-al-tsb="1"]').first();
        const clickRefused = req.clickGate
          ? String(await req.clickGate(control).catch((e: unknown) => `the click gate could not answer (${String((e as Error)?.message ?? e).slice(0, 80)})`) ?? "")
          : "";
        if (clickRefused) { enterNote = ` (Enter was not pressed: ${refusal.slice(0, 160)}; the box's own "${searchLabel}" was refused: ${clickRefused.slice(0, 120)})`; continue; }
        // The whole line first; if that finds nothing, THE STREET LINE ALONE (live Tigard run 6: the
        // Esri box answered "There are no matches available." for "13125 SW Hall Blvd, Tigard, OR
        // 97223" — its address source matches the street line, and the city/ZIP tail defeats it).
        const searchQueries = [t.q];
        if (loose(street) && loose(street) !== loose(t.q)) searchQueries.push(street);
        let found = false;
        let pressedAny = false;
        // THE SEARCH PHASE HAS ITS OWN BUDGET, added here, once: the suggestion waits have spent most of
        // the fill's, and a search is a network round trip the box answers in seconds (live City of
        // Tigard 2026-11-15: rows 4.3 s after its Search). SEARCH_PHASE_BUDGET_MS says why.
        deadline = Math.max(deadline, Date.now() + SEARCH_PHASE_BUDGET_MS);
        for (let qi = 0; qi < searchQueries.length && Date.now() < deadline; qi++) {
          const q = searchQueries[qi];
          let beforeQ = before;
          if (qi > 0) {
            await clearBox(doc, loc, controlsId);
            await markExistingPopups(doc);
            beforeQ = await readShows(doc);
            typed.push(q);
            if (!(await typeInto(page, loc, q))) continue;
          }
          await doc.evaluate(() => { document.querySelectorAll('input[type=checkbox], [role=checkbox]').forEach((n) => n.setAttribute("data-al-oldcb", "1")); }).catch(() => null);
          const viaSearch = await enterAndReadSelection(page, doc, loc, site, beforeQ, deadline, () => control.click({ timeout: 3000 }));
          if (viaSearch.said) portalSaid = viaSearch.said;
          if (!viaSearch.pressed) continue;
          pressedAny = true;
          searchNote = ` + the box's own "${searchLabel}"`;
          // A RESULTS PANEL OF TICKABLE ROWS (live City of Tigard, owner's walk-through 2026-11-13): the
          // search lists each parcel as a row with its own checkbox (plus a "Select All"); ticking the
          // row shows the panel's "Add", which puts the location on the application. Text that merely
          // APPEARED is not a selection there — so this is read first, and only rows the search brought.
          const tick = await searchResultTickAndAdd(page, doc, loc, site, req, deadline);
          if (tick.kind === "picked") {
            return { outcome: "picked", picked: tick.text, held: tick.text, typed: q, why: `${tick.why}; ticked in the results of the box's own "${searchLabel}" and added with the panel's "${tick.add}"`, via: "search" };
          }
          if (tick.kind === "ask") return { outcome: "ask", question: tick.question, offered: tick.offered, typed: q, why: tick.why };
          if (tick.kind === "failed") return { outcome: "not_held", why: tick.why, picked: tick.text };
          if (viaSearch.choice?.kind === "pick") {
            return { outcome: "picked", picked: viaSearch.choice.text, held: viaSearch.choice.text, typed: q, why: `${viaSearch.choice.why}; selected by the portal after its own "${searchLabel}"`, via: "search" };
          }
          if (viaSearch.choice?.kind === "ask") {
            return { outcome: "ask", question: `${viaSearch.choice.question} (The portal selected it after its own "${searchLabel}"; check its selection before going on.)`, offered: viaSearch.choice.candidates, typed: q, why: viaSearch.choice.why };
          }
          // A RESULTS LIST: rows the search opened, read and picked like a suggestion list. The
          // selection read above already waited for the page; this is one short settle, not a second
          // full wait (the whole fill's budget is shared).
          const listed = await settledSuggestions(doc, controlsId, Math.min(waitMs, 1500), deadline);
          if (listed.length) { rows = listed; usedQuery = q; found = true; break; }
        }
        if (found) break;
        enterNote = pressedAny
          ? ` (Enter was not pressed: ${refusal.slice(0, 160)}; the box's own "${searchLabel}" brought nothing)`
          : ` (Enter was not pressed: ${refusal.slice(0, 160)}; the box's own "${searchLabel}" could not be pressed)`;
        continue;
      }
      const sel = await enterAndReadSelection(page, doc, loc, site, before, deadline);
      if (sel.said) { portalSaid = sel.said; if (sel.saidFresh) portalSaidFresh = true; }
      if (!sel.pressed) continue;
      entered.add(typed.length - 1);
      if (sel.choice?.kind === "pick") {
        const text = sel.choice.text;
        // The portal moved the job's address out of the box and into its selection: nothing to
        // clear, nothing to blur (the box is the portal's again).
        return { outcome: "picked", picked: text, held: text, typed: t.q, why: `${sel.choice.why}; selected by the portal on Enter`, via: "enter" };
      }
      if (sel.choice?.kind === "ask") {
        return { outcome: "ask", question: `${sel.choice.question} (The portal selected it when the address was searched; check its selection before going on.)`, offered: sel.choice.candidates, typed: t.q, why: sel.choice.why };
      }
    }
    if (!rows.length) {
      await clearBox(doc, loc, controlsId);
      const over = Date.now() >= deadline ? ` (its ${Math.round((deadline - startedAt) / 1000)} s budget ran out)` : "";
      return {
        outcome: "no_suggestions",
        why: `typed ${typedLine()}${searchNote} and the box offered no suggestions${wholeListed ? ` (only ${wholeListed} other address(es) for the whole line)` : ""}${entered.size ? " and the portal selected nothing" : ""}${enterNote}${over}`,
        typed,
        ...(portalSaid ? { portalSaid } : {}),
        ...(portalSaid && portalSaidFresh ? { portalSaidFresh: true as const } : {}),
      };
    }
    const offered = rows.map(suggestionText).filter(Boolean);
    const choice = req.mode === "company" ? chooseCompanySuggestion(rows, value)
      : req.mode === "exact" ? chooseExactSuggestion(rows, value)
        : chooseAddressSuggestion(rows, site);
    if (choice.kind === "ask") {
      await clearBox(doc, loc, controlsId);
      return { outcome: "ask", question: choice.question, offered, typed: usedQuery, why: choice.why };
    }
    if (choice.kind === "none") {
      await clearBox(doc, loc, controlsId);
      return { outcome: "no_match", why: `typed ${typedLine()}: ${choice.why}`, offered, typed: usedQuery, ...(portalSaid ? { portalSaid } : {}) };
    }
    // THE ROW THAT WAS READ IS THE ROW THAT IS CLICKED: by its mark, and only while it still says
    // what it said when it was chosen (a list that re-rendered under us is read again, not guessed).
    const row = doc.locator(`[data-al-sugg="${choice.index}"]`).first();
    const now = suggestionText(await row.textContent({ timeout: 1500 }).catch(() => ""));
    if (now !== choice.text || Date.now() >= deadline) {
      await clearBox(doc, loc, controlsId);
      return { outcome: "no_match", why: `the suggestion list changed while it was being read ("${choice.text}" is no longer the row chosen)`, offered, typed: usedQuery, listChanged: true };
    }
    // THE WIDGET'S OWN SELECTED VALUE (#244). A widget that keeps the selected record's id in a hidden
    // input (the box only shows its words) selected nothing unless that id is written again: the box
    // reading the address is not the portal holding the property. Watched: only what the widget
    // demonstrably owns, a hidden value it emptied itself when the query was typed (a reopened
    // draft's earlier selection), remembered on the input for the next fill of this box in this
    // document (selectionInputsToWatch). Read here, just before the click; judged only after the
    // blur commit, because a widget may write its id on change/blur rather than in the click.
    const watched = selectionInputsToWatch(hiddenAtRest, await doc.evaluate(typeaheadWidgetHiddenInPage).catch(() => []));
    if (watched.length) await doc.evaluate(markOwnedHiddenInPage, watched.map((w) => w.key)).catch(() => null);
    const clicked = await withAutomationInput(page, () => row.click({ timeout: 4000 })).then(() => true).catch(() => false);
    if (!clicked) {
      await clearBox(doc, loc, controlsId);
      return { outcome: "not_held", why: `"${choice.text}" could not be clicked in the list`, picked: choice.text };
    }
    // The box holds the pick (as clicked, or re-worded as the same address / the same value). A GIS
    // widget may write the box only after its own round trip (a geocode, a map zoom), so it is read
    // back for up to 2 s before it is judged: a slow but good pick is not called a miss.
    const holds = (h: string): boolean => !!h && (loose(h) === loose(choice.text)
      || (req.mode === "company" ? normalizeCompanyLabel(h) === normalizeCompanyLabel(value)
        : req.mode === "exact" ? loose(h) === loose(value) : chooseAddressSuggestion([h], site).kind === "pick"));
    let held = "";
    const readUntil = Date.now() + 2000;
    for (;;) {
      await page.waitForTimeout?.(200).catch(() => null);
      held = String((await loc.inputValue({ timeout: 1000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
      if (holds(held) || Date.now() >= readUntil) break;
    }
    if (!held) return { outcome: "not_held", why: `picked "${choice.text}" and the box is empty afterwards`, picked: choice.text };
    const same = holds(held);
    if (!same) {
      await clearBox(doc, loc, controlsId);
      return { outcome: "not_held", why: `picked "${choice.text}" and the box then showed "${held.slice(0, 120)}" — cleared`, picked: choice.text };
    }
    // Commit the way every fill commits (a per-field save on blur).
    if (typeof loc.blur === "function") await loc.blur().catch(() => null);
    // ...and only then ask whether the widget's own selection was written again (read for up to 2 s:
    // a change/blur handler, or the widget's own round trip). Not written: the box is cleared, so no
    // unpicked words stay for the portal to take (a per-field autosave saw the pick's words on the
    // blur and now sees the box emptied).
    if (watched.length) {
      let took = false;
      const takeUntil = Date.now() + 2000;
      for (;;) {
        took = selectionRewritten(watched, await doc.evaluate(typeaheadWidgetHiddenInPage).catch(() => []));
        if (took || Date.now() >= takeUntil) break;
        await page.waitForTimeout?.(200).catch(() => null);
      }
      if (!took) {
        await clearBox(doc, loc, controlsId);
        const names = watched.map((h) => h.name).filter(Boolean).slice(0, 3).map((n) => `"${n}"`).join(", ");
        return { outcome: "not_held", why: `picked "${choice.text}" and the box shows it, but the widget's selected value (its hidden input${names ? ` ${names}` : ""}, which the widget emptied when the search was typed) was not written again — the portal did not take the pick; cleared`, picked: choice.text };
      }
    }
    return { outcome: "picked", picked: choice.text, held, typed: usedQuery, why: choice.why, via: "list" };
  } finally {
    await clearPopupMarks(doc);
    await doc.evaluate(() => { document.querySelectorAll("[data-al-sugg]").forEach((n) => n.removeAttribute("data-al-sugg")); }).catch(() => null);
    await doc.evaluate(() => {
      document.querySelectorAll("[data-al-ta-widget], [data-al-ta-box], [data-al-ta-pre]").forEach((n) => {
        n.removeAttribute("data-al-ta-widget");
        n.removeAttribute("data-al-ta-box");
        n.removeAttribute("data-al-ta-pre");
      });
    }).catch(() => null);
  }
}

/** A replay's stop on a typeahead question (#575): never retried, healed or skipped as optional — a
 *  retry re-asks the same list the same question, and a skip would advance without the address. */
export class TypeaheadStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeaheadStop";
  }
}

/** THE PORTAL ITSELF ANSWERED THIS VALUE WITH NOTHING (#244 fix round): it printed its own no-match
 *  words, or it listed rows and none is the job's. A search that only ran out of time, a list that
 *  re-rendered under the read, or a pick the box did not keep is not an answer — it may differ on
 *  the next try, so a caller that remembers "already searched" (the replay) must not remember it. */
export function typeaheadPortalAnswered(o: TypeaheadOutcome): boolean {
  // Its own words, printed FOR this search — a no-match sentence that was already on screen (static
  // help copy, another box's panel) is quoted but is not an answer (review of d1c7acd1).
  if (o.outcome === "no_suggestions") return !!o.portalSaid && o.portalSaidFresh === true;
  if (o.outcome === "no_match") return !o.listChanged;
  return false;
}

/** One operator-readable line for an outcome that picked nothing ("" for "picked"). */
export function typeaheadFailureLine(label: string, o: TypeaheadOutcome): string {
  const name = `"${String(label || "search box").slice(0, 60)}"`;
  // The portal's own words, quoted, when it printed any (#139: "The search value did not match an
  // address", "No results match your search").
  const said = (o.outcome === "no_suggestions" || o.outcome === "no_match") && o.portalSaid ? ` — the portal said: "${o.portalSaid.slice(0, 160)}"` : "";
  switch (o.outcome) {
    case "picked": return "";
    case "ask": return `${name}: ${o.question} Nothing was picked; a person answers this before the application goes on.`;
    case "no_suggestions": return `${name}: ${o.why}${said} — nothing was picked and the box was left empty.`;
    case "no_match": return `${name}: ${o.why}${said} — nothing was picked and the box was left empty.`;
    case "not_held": return `${name}: ${o.why}.`;
    case "unusable": return `${name}: ${o.why} — nothing was typed.`;
  }
}
