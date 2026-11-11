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
  | { outcome: "picked"; picked: string; held: string; typed: string; why: string; via?: "list" | "enter" }
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
 * Press Enter in the box (the whole one-line address is in it) and read what the portal selected:
 * the texts that appeared on the page (pageShowsInPage `shown`, before vs after) judged by the ONE
 * address predicate. A postback reloads the document — every read tolerates that and retries until
 * the page answers, bounded by `untilMs` and the fill's deadline. Returns the choice (a pick or a
 * question over the NEW texts) and the portal's no-match words when it printed any.
 */
async function enterAndReadSelection(
  page: any, doc: any, loc: any, site: TypeaheadSite, before: { shown: string[]; notes: string[] } | null, deadline: number,
): Promise<{ choice: ReturnType<typeof chooseAddressSuggestion> | null; said: string; pressed: boolean }> {
  // A box inside a form posts the form back on Enter: wait for THAT navigation (a real postback can
  // take seconds to start), never read the old document's stillness as "nothing selected".
  const inForm = await loc.evaluate((el: Element) => !!(el as HTMLInputElement).form).catch(() => false);
  const navigated = inForm && typeof doc.waitForNavigation === "function"
    ? doc.waitForNavigation({ waitUntil: "domcontentloaded", timeout: Math.max(0, Math.min(8_000, deadline - Date.now())) }).then(() => true).catch(() => false)
    : Promise.resolve(false);
  const pressed = await withAutomationInput(page, () => loc.press("Enter", { timeout: 3000 })).then(() => true).catch(() => false);
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
      // No list for the whole address: a search that runs on Enter (#139), behind the shared gate.
      const refusal = await enterRefusal(doc, loc);
      if (refusal) { enterNote = ` (Enter was not pressed: ${refusal.slice(0, 160)})`; continue; }
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
        why: `typed ${typedLine()} and the box offered no suggestions${wholeListed ? ` (only ${wholeListed} other address(es) for the whole line)` : ""}${entered.size ? " and the portal selected nothing" : ""}${enterNote}${over}`,
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
