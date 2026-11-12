// THE RECORD TYPE IS INSIDE A GROUP THAT HAS TO BE OPENED FIRST (#174).
//
// Watched City of Meridian learn (Accela Citizen Access, 2026-11-12): the "Select Permit Type"
// page lists eleven collapsed GROUPS, each a header toggle followed by a hidden list of radios:
//
//   <div class="ServiceListGroupName">
//     <a onclick="ToggleRecordTypeList(this)"><img alt="Expand"><span>Residential Electrical</span></a>
//   </div>
//   <div class="ServiceItemList" style="display:none"> … <input type="radio" title="Residential Electrical Solar Array"> …
//
// The walk chose the right radio (the person-verified type), could not open its group — the only
// opener it knew was a CATEGORY CHECKBOX, and on this tenant those sit in a hidden filter panel —
// so check() failed, the planner pressed Continue with nothing selected, and the portal answered
// "You have not selected a record type." until the recovery budget ran out.
//
// The fix opens the radio's OWN group by its header (revealHidden.planHiddenReveal: "the toggle
// preceding the hidden container"), records that click BY THE HEADER'S TEXT, and the replay routes
// the step on the note below — resolved by label, never positionally healed: a group opened by
// position on another tenant would expose another list, and the record type ticked after it is
// the permit that gets filed. Generic by construction: the group's name comes from the page, the
// record type from the knowledge base; no portal is named.
import type { RecipeSelector, RecipeStep } from "../../../shared/src/types";

/** The learner's note on the click that opens a record-type group — the replay's routing key. */
export const RECORD_TYPE_GROUP_NOTE = /^\s*record type group:\s*/i;

export function recordTypeGroupNote(group: string): string {
  return `record type group: ${String(group ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}`;
}

/** The group a recorded step opens, or "" when the step is not one. A click only: the check that
 *  follows it is the record type itself (recipeAdapter.isRecordTypeStep). */
export function recordTypeGroupOf(step: Pick<RecipeStep, "action" | "note">): string {
  if (step.action !== "click") return "";
  const note = String(step.note ?? "");
  return RECORD_TYPE_GROUP_NOTE.test(note) ? note.replace(RECORD_TYPE_GROUP_NOTE, "").trim() : "";
}

/** What the learner reads off a group toggle to record its step. */
export interface GroupToggleInfo {
  /** The header's visible words ("Residential Electrical") — the step's note and the first name tried. */
  text: string;
  /** The accessible name a role locator sees: text nodes, img alt and aria-label in order. Meridian's
   *  header reads "Expand Residential Electrical" to getByRole, not "Residential Electrical". */
  accName: string;
  tag: string;
  id: string;
  parentId: string;
  role: "link" | "button" | "";
}

/** Clickables a group header may be — the one list the learner, the expansion pass and the replay
 *  all read (one predicate). Mirrors revealHidden.planHiddenReveal's "toggle preceding the hidden
 *  container" set. */
export const GROUP_TOGGLE_CSS = "a, button, summary, [role=button], [onclick], [aria-expanded]";

/**
 * Runs INSIDE the page (serialized; self-contained; no inner named helpers). Describes the element
 * carrying attribute `attr`. Null when none is tagged.
 */
export function describeTaggedToggle(attr: string): GroupToggleInfo | null {
  const el = document.querySelector(`[${attr}]`) as HTMLElement | null;
  if (!el) return null;
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) { parts.push(n.textContent || ""); continue; }
    const e = n as Element;
    if (e.getAttribute("aria-label")) parts.push(String(e.getAttribute("aria-label")));
    else if (e.tagName === "IMG" && e.getAttribute("alt")) parts.push(String(e.getAttribute("alt")));
  }
  const tag = el.tagName.toLowerCase();
  const explicit = (el.getAttribute("role") || "").toLowerCase();
  const role: GroupToggleInfo["role"] = explicit === "button" || tag === "button" || tag === "summary" ? "button"
    : explicit === "link" || (tag === "a" && el.hasAttribute("href")) ? "link" : "";
  return {
    text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
    accName: (el.getAttribute("aria-label") || parts.join(" ")).replace(/\s+/g, " ").trim().slice(0, 120),
    tag,
    id: el.id || "",
    parentId: el.parentElement?.id || "",
    role,
  };
}

/**
 * Runs INSIDE the page. Tags (with `attr`) the ONE visible clickable whose own words are `text`
 * (whitespace folded, case folded) and returns how many matched — the caller acts only on exactly
 * one. Used by the replay and the expansion pass, which know the group by its words alone.
 */
export function tagToggleByText(args: { text: string; attr: string; css: string }): number {
  document.querySelectorAll(`[${args.attr}]`).forEach((n) => n.removeAttribute(args.attr));
  const want = args.text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!want) return 0;
  const hits: HTMLElement[] = [];
  for (const el of Array.from(document.querySelectorAll(args.css)) as HTMLElement[]) {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") continue;
    const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (t !== want) continue;
    // A clickable nested in a matching clickable (a <span onclick> inside the <a>) is the same
    // control: keep the outermost.
    if (hits.some((h) => h.contains(el))) continue;
    hits.push(el);
  }
  if (hits.length === 1) hits[0].setAttribute(args.attr, "1");
  return hits.length;
}

/**
 * Runs INSIDE the page. Is the list this toggle opens ALREADY showing? Reads the inverse of
 * planHiddenReveal's relation: the first ancestor-or-self of the toggle with a next element sibling,
 * and whether that sibling has a box. A replay that clicked an open group's header would CLOSE it.
 */
export function toggledListOpen(attr: string): boolean | null {
  const el = document.querySelector(`[${attr}]`) as HTMLElement | null;
  if (!el) return null;
  if (el.getAttribute("aria-expanded") === "true") return true;
  if (el.getAttribute("aria-expanded") === "false") return false;
  let node: HTMLElement | null = el;
  for (let depth = 0; node && depth < 4; depth++) {
    const sib = node.nextElementSibling as HTMLElement | null;
    if (sib) {
      const r = sib.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(sib).display !== "none";
    }
    node = node.parentElement;
  }
  return null;
}

/** The selector to record for a toggle: tried in this order on the live page, the first that
 *  resolves to exactly one element becomes the primary, the rest its fallbacks (css last). */
export function toggleSelectorCandidates(info: GroupToggleInfo): RecipeSelector[] {
  const out: RecipeSelector[] = [];
  if (info.role && info.text) out.push({ role: info.role, name: info.text, exact: true });
  if (info.role && info.accName && info.accName !== info.text) out.push({ role: info.role, name: info.accName, exact: true });
  if (info.id) out.push({ css: `#${cssEscape(info.id)}` });
  else if (info.parentId) out.push({ css: `#${cssEscape(info.parentId)} ${info.tag || "*"}` });
  if (info.text) out.push({ text: info.text, exact: true });
  return out;
}

function cssEscape(id: string): string {
  return id.replace(/([^\w-])/g, "\\$1");
}

/**
 * THE TYPE A CATALOG BUTTON APPLIES FOR (live City of Tigard, Tyler EnerGov Application Assistant,
 * 2026-11-12): an application catalog lists each record type as a button worded "Apply <type>" (or
 * "Start …", "Begin …", "New …", "Apply for a …"). Returns the <type> words, or null when the label is
 * not such a button. The one reader the verified record-type pick uses for buttons.
 */
export function recordTypeOfCatalogButton(label: string): string | null {
  const m = /^\s*(?:apply|start|begin|new)\s+(?:for\s+)?(?:an?\s+)?(.+?)\s*$/i.exec(String(label || "").replace(/\s+/g, " "));
  if (!m) return null;
  const rest = m[1].trim();
  // "Apply" alone, "Apply Now", "Start Application", "New Application": a door, not a type.
  if (!rest || /^(now|here|online|application|applications|permit|permits|a permit|an application)$/i.test(rest)) return null;
  return rest;
}
