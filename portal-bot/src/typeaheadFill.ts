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
//   4. read the box back: empty after the pick is a NAMED failure, never a silent drop.
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
import { addressQueries, chooseAddressSuggestion, chooseExactSuggestion, noMatchSaid, oneLineAddress, suggestionText, type TypeaheadSite } from "./typeaheadMatch";

/** What a typeahead fill did. Only "picked" wrote a value the portal kept. `via: "enter"` — the
 *  portal selected it on Enter and shows it OUTSIDE the box (`held` is that shown text); the search
 *  box itself may be empty afterwards, and a read-back of the box must not call that a miss. */
export type TypeaheadOutcome =
  | { outcome: "picked"; picked: string; held: string; typed: string; why: string; via?: "list" | "enter" | "search" }
  /** A near miss or several equal candidates: nothing picked, the box cleared; ask `question`. */
  | { outcome: "ask"; question: string; offered: string[]; typed: string; why: string }
  /** `portalSaid`: the portal's own no-match words, when it printed any. */
  | { outcome: "no_suggestions"; why: string; typed: string[]; portalSaid?: string }
  | { outcome: "no_match"; why: string; offered: string[]; typed: string; portalSaid?: string }
  /** A suggestion was clicked and the box does not hold it. */
  | { outcome: "not_held"; why: string; picked: string }
  /** The box cannot be typed into (hidden, read-only, disabled) or there is nothing to type. */
  | { outcome: "unusable"; why: string };

export interface TypeaheadRequest {
  /** The value to enter (the planner's / the recipe's resolved value). */
  value: string;
  /** typeaheadMatch.typeaheadMatchMode: "site" (the job's own address: city/ZIP checked where a
   *  suggestion shows them), "address" (another street address), "exact" (any other lookup). */
  mode: "site" | "address" | "exact";
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
  /** How long one query waits for its suggestions to settle. Default 5 s. */
  suggestWaitMs?: number;
  /** The whole fill's deadline, every query included. Default 30 s — far inside the walk's stall
   *  watchdog (300 s) and one planner-door click's budget (90 s). */
  budgetMs?: number;
}

const SUGGEST_WAIT_DEFAULT_MS = 5_000;
const TYPEAHEAD_BUDGET_DEFAULT_MS = 30_000;
const NAME_SHIM = "globalThis.__name = globalThis.__name || function (f) { return f; };";

const loose = (s: string): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Runs IN THE PAGE. The visible suggestion rows of the box's list, in order, each marked
 * data-al-sugg="<its index>" so the row that was read is the row that is clicked. The list is the
 * one the box names (aria-controls / aria-owns), else the last list that was not on screen before
 * typing (comboboxFill's fresh-popup stamp). No nested functions (esbuild keepNames → __name).
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
  for (const list of lists) {
    const lr = (list as HTMLElement).getBoundingClientRect();
    const ls = getComputedStyle(list as HTMLElement);
    if (lr.width <= 0 || lr.height <= 0 || ls.visibility === "hidden" || ls.display === "none") continue;
    let rows: Element[] = Array.from(list.querySelectorAll('[role="option"]'));
    if (!rows.length) rows = Array.from(list.querySelectorAll("li"));
    if (!rows.length) rows = Array.from(list.children);
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

/** The first no-match sentence in `after` that was not on screen in `before`, else the first one
 *  at all ("" when none). */
function freshNoMatch(before: string[] | null | undefined, after: string[] | null | undefined): string {
  const old = new Set(before ?? []);
  const said = (after ?? []).map(noMatchSaid).filter(Boolean);
  return said.find((t) => !old.has(t)) ?? said[0] ?? "";
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
  for (let i = 0; i < 6 && Date.now() < deadline; i++) {
    await doc.evaluate(NAME_SHIM).catch(() => null);
    const read = await doc.evaluate(searchResultRowsInPage).catch(() => [] as string[]);
    texts = Array.isArray(read) ? read.map((t: unknown) => String(t ?? "")) : [];
    if (texts.length) break;
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
): Promise<{ choice: ReturnType<typeof chooseAddressSuggestion> | null; said: string; pressed: boolean }> {
  // A box inside a form posts the form back on Enter: wait for THAT navigation (a real postback can
  // take seconds to start), never read the old document's stillness as "nothing selected".
  const inForm = await loc.evaluate((el: Element) => !!(el as HTMLInputElement).form).catch(() => false);
  const navigated = inForm && typeof doc.waitForNavigation === "function"
    ? doc.waitForNavigation({ waitUntil: "domcontentloaded", timeout: Math.max(0, Math.min(8_000, deadline - Date.now())) }).then(() => true).catch(() => false)
    : Promise.resolve(false);
  // `press`: the box's own search control (#198) instead of Enter — read exactly the same way.
  const pressed = await withAutomationInput(page, () => (press ? press() : loc.press("Enter", { timeout: 3000 }))).then(() => true).catch(() => false);
  if (!pressed) return { choice: null, said: "", pressed: false };
  await navigated;
  const old = new Set(before?.shown ?? []);
  const until = Math.min(Date.now() + 6_000, deadline);
  let said = "";
  let quiet = 0;
  let lastSig = "";
  while (Date.now() < until) {
    await page.waitForTimeout?.(300).catch(() => null);
    await page.waitForLoadState?.("domcontentloaded", { timeout: 3000 }).catch(() => null);
    const now = await readShows(doc);
    if (!now) continue; // mid-navigation
    const fresh = now.shown.filter((t) => !old.has(t));
    said = freshNoMatch(before?.notes, now.notes) || said;
    if (fresh.length) {
      const choice = chooseAddressSuggestion(fresh, site);
      if (choice.kind === "pick" || choice.kind === "ask") return { choice, said, pressed: true };
    }
    // Nothing selected (yet): settle once the page has held still for a moment, or said "no match".
    const sig = JSON.stringify(now.shown);
    quiet = sig === lastSig ? quiet + 1 : 0;
    lastSig = sig;
    if (said && quiet >= 1) break;
    if (quiet >= 4) break;
  }
  return { choice: null, said, pressed: true };
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

/**
 * Fill one typeahead box. Never throws; every outcome but "picked" leaves the box empty.
 */
export async function fillTypeahead(page: any, loc: any, req: TypeaheadRequest): Promise<TypeaheadOutcome> {
  const budgetMs = req.budgetMs && req.budgetMs > 0 ? req.budgetMs : TYPEAHEAD_BUDGET_DEFAULT_MS;
  const deadline = Date.now() + budgetMs;
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
  const tries: Array<{ q: string; enter: boolean }> = (req.mode === "exact" ? [value] : addressQueries(street)).map((q) => ({ q, enter: false }));
  const whole = req.mode === "site" ? oneLineAddress(site) : "";
  if (whole && !tries.some((t) => loose(t.q) === loose(whole))) tries.unshift({ q: whole, enter: true });
  if (!tries.length) return { outcome: "unusable", why: "there is no address to type" };
  const doc = await ownerScope(page, loc);
  await doc.evaluate(NAME_SHIM).catch(() => null);

  const typed: string[] = [];
  let rows: string[] = [];
  let usedQuery = "";
  let portalSaid = "";
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
      portalSaid = freshNoMatch(before?.notes, afterTyping?.notes) || portalSaid;
      if (!t.enter || Date.now() >= deadline) continue;
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
      if (sel.said) portalSaid = sel.said;
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
      const over = Date.now() >= deadline ? ` (its ${Math.round(budgetMs / 1000)} s budget ran out)` : "";
      return {
        outcome: "no_suggestions",
        why: `typed ${typedLine()}${searchNote} and the box offered no suggestions${wholeListed ? ` (only ${wholeListed} other address(es) for the whole line)` : ""}${entered.size ? " and the portal selected nothing" : ""}${enterNote}${over}`,
        typed,
        ...(portalSaid ? { portalSaid } : {}),
      };
    }
    const offered = rows.map(suggestionText).filter(Boolean);
    const choice = req.mode === "exact" ? chooseExactSuggestion(rows, value) : chooseAddressSuggestion(rows, site);
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
      return { outcome: "no_match", why: `the suggestion list changed while it was being read ("${choice.text}" is no longer the row chosen)`, offered, typed: usedQuery };
    }
    const clicked = await withAutomationInput(page, () => row.click({ timeout: 4000 })).then(() => true).catch(() => false);
    if (!clicked) {
      await clearBox(doc, loc, controlsId);
      return { outcome: "not_held", why: `"${choice.text}" could not be clicked in the list`, picked: choice.text };
    }
    // The box holds the pick (as clicked, or re-worded as the same address / the same value). A GIS
    // widget may write the box only after its own round trip (a geocode, a map zoom), so it is read
    // back for up to 2 s before it is judged: a slow but good pick is not called a miss.
    const holds = (h: string): boolean => !!h && (loose(h) === loose(choice.text)
      || (req.mode === "exact" ? loose(h) === loose(value) : chooseAddressSuggestion([h], site).kind === "pick"));
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
    return { outcome: "picked", picked: choice.text, held, typed: usedQuery, why: choice.why, via: "list" };
  } finally {
    await clearPopupMarks(doc);
    await doc.evaluate(() => { document.querySelectorAll("[data-al-sugg]").forEach((n) => n.removeAttribute("data-al-sugg")); }).catch(() => null);
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
