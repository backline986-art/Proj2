// Street-address parsing for portal address-search forms (Accela ACA and kin), pure and
// browser-free so BOTH sides of a recipe can share it: the learn/stage adapters that fill
// the search form live, and the backend's resolveRecipeFieldValues that binds the same
// values at replay (a recorded recipe must never replay the LEARN project's address).
// Live-verified against Oregon ePermitting (originally in oregonEPermitting.ts).
import type { RecipeStep } from "../../shared/src/types";
import { contactRoleOfStep } from "../../shared/src/contactRoles";
import { DIRECTION_CANON, DIRECTIONAL, STATE, SUFFIXES, UNIT_WORD } from "./draftCreated";

// The street LINE only — the part before the first comma. projectAddress is stored as
// "925 N Grant St, Lafayette, OR, 97127"; everything after the first comma is city/state/zip
// and must not leak into the street-number/name/direction parsing (it returns zero results).
function streetLine(address: string): string {
  return (address || "").split(",")[0].trim();
}

export function parseStreetNumber(address: string): string {
  return streetLine(address).split(/\s+/)[0] ?? "";
}

// ── THE STREET LINE, READ ONCE (#236 fix round) ─────────────────────────────────────────────────
//
// THE NUMBER, DIRECTION, NAME AND TYPE BOXES OF ONE SEARCH ARE CUT FROM ONE READING. Accela's split
// search asks for each piece in its own control; when the name box and the type box were read by two
// grammars they disagreed on the same address: "1234 North Ave" searched name "Ave" (the old name
// parser took "North" for a direction), "1234 Example Cove" searched name "Example Cove" with type CV,
// and the component reader — built on draftCreated.siteKey, which stops at any token spelling a state
// code — read every NE-quadrant address ("ne" = Nebraska) and every Court ("ct" = Connecticut) as
// having no direction or no type, and the binder then said so as fact (#236 review: Corvallis has NE
// addresses; 5 of the scratch DB's 41 street lines carry such a token).
//
// So one reader, with the one street vocabulary (draftCreated DIRECTIONAL / SUFFIXES / UNIT_WORD /
// DIRECTION_CANON), read from the right of the street line (the part before the first comma, so a
// state code inside it is a street word, never a place): cut at a unit word that follows a street
// word; then ONE trailing directional; then ONE suffix with a word before it; then a leading
// directional only when a name word is left after it. parseStreetName, parseStreetDirection and
// addressComponentFields are all this reading. siteKey is untouched: it matches list rows, and draft
// verification and the #575 typeahead read it.
//
// `readable` is false when the line cannot be read with confidence — no house number first, no name
// word left, or an address written WITHOUT a comma whose line carries a ZIP or ends in a state code
// that is not also a street word (its city and state may be in the "street"). The component keys are
// then not emitted, and the binder hands those controls to a person instead of claiming the address
// has no direction (recipeReplayBinding R13): an unknown must not read as an answer.
export interface StreetLineParts {
  /** The first token of the street line (parseStreetNumber's answer). */
  number: string;
  /** The leading directional as written ("N", "Northeast"); "" when there is none. */
  direction: string;
  /** The core street name as written ("Grant", "Pan American", "North"). */
  name: string;
  /** The suffix, canonical lowercase ("ave"); "" when none from the shared list was read. */
  suffix: string;
  /** A trailing directional, canonical lowercase ("nw"); "" when there is none. */
  postDirection: string;
  /** The USPS unit designator ("APT"); "" when the line names none ("#4" names no type). */
  unitType: string;
  readable: boolean;
}
const streetWord = (w: string): string => w.toLowerCase().replace(/[.,]/g, "");

export function readStreetLine(address: string): StreetLineParts {
  const raw = String(address || "");
  const tokens = streetLine(raw).split(/\s+/).filter(Boolean);
  const number = tokens[0] ?? "";
  let parts = tokens.slice(1);
  // A unit word or "#" ends the street — but only after a street word: "1234 No Name Rd" is a street.
  let unitType = "";
  const unitAt = parts.findIndex((p, k) => (p.startsWith("#") || UNIT_WORD.test(streetWord(p)))
    && parts.slice(0, k).some((q) => !DIRECTIONAL.test(streetWord(q))));
  if (unitAt >= 0) {
    unitType = UNIT_TYPE_CANON[streetWord(parts[unitAt])] ?? "";
    parts = parts.slice(0, unitAt);
  }
  let postDirection = "";
  if (parts.length >= 2 && DIRECTIONAL.test(streetWord(parts[parts.length - 1]))) {
    const w = streetWord(parts.pop() as string);
    postDirection = DIRECTION_CANON[w] ?? w;
  }
  let suffix = "";
  if (parts.length >= 2 && SUFFIXES[streetWord(parts[parts.length - 1])]) suffix = SUFFIXES[streetWord(parts.pop() as string)];
  let direction = "";
  if (parts.length >= 2 && DIRECTIONAL.test(streetWord(parts[0]))) direction = (parts.shift() as string).replace(/[.,]/g, "");
  const name = parts.join(" ");
  const tail = tokens.slice(1).map(streetWord);
  const last = tail[tail.length - 1] ?? "";
  const carriesPlace = !raw.includes(",")
    && (tail.some((w) => /^\d{5}(?:-\d{4})?$/.test(w)) || (STATE.test(last) && !SUFFIXES[last] && !DIRECTIONAL.test(last)));
  const readable = /^\d+[a-z]?$/i.test(streetWord(number)) && name.length > 0 && !carriesPlace;
  return { number, direction, name, suffix, postDirection, unitType, readable };
}

// Accela's "Street Name" search field wants the CORE name only — e.g. "925 N Grant St" must
// be searched as "Grant" (the leading direction and trailing street-type suffix belong in
// separate fields). Including them returns zero results, which silently breaks the flow.
export function parseStreetName(address: string): string {
  return readStreetLine(address).name;
}

// Leading directional of the street as written, upper-cased ("N", "NORTHEAST"), for Accela's
// separate direction dropdown.
export function parseStreetDirection(address: string): string {
  return readStreetLine(address).direction.toUpperCase();
}

// THE STREET LINE, WHOLE. City/state/zip removed, nothing else.
//
// The three parsers above all SUBTRACT, and they are right to: Accela's work-location search
// splits an address across Street No / Direction / Street Name / Suffix boxes, and putting
// "Grant St" in the name box returns zero results. But the same subtraction applied to a
// portal with ONE combined address box is how Miami's iBuild spent a whole walk searching
// "3500 Pan American" and then "Pan American" for a property its own database holds as
// "3500 PAN AMERICAN DR" — the suffix is what the search matches on, and dropping it turns
// a hit into "Property Address not found."
//
// How much of an address to strip depends on how many boxes the portal splits it into. This
// is the un-stripped form, for the portals that ask for the whole thing.
export function parseStreetLine(address: string, city?: string): string {
  let line = streetLine(address);
  if (line && city) {
    const esc = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    line = line.replace(new RegExp(`\\s+${esc}(\\s+[A-Za-z]{2})?(\\s+\\d{5}(-\\d{4})?)?\\s*$`, "i"), "").trim() || line;
  }
  return line;
}

// DOES THIS FORM SPLIT THE ADDRESS, OR ASK FOR IT WHOLE?
//
// The question the truncation correction turns on. Accela's work-location search puts the
// house number, direction, street name and suffix in four separate controls and wants the
// CORE name in the name box; Miami's iBuild has one box and wants the whole line. Same
// project address, opposite right answers, and the only way to tell them apart is the
// controls the page is showing.
//
// Reads split only on a control that could hold a PIECE of a street address: a street/house
// NUMBER box, a street TYPE/SUFFIX control, or a street DIRECTION control. Never on
// "Street Address" or "Property Address", which are the combined case. A bare "Suffix" is
// the street suffix; "Name Suffix" (Jr./Sr.) on a contact block is not, so the bare form
// must match the whole label.
//
// Erring toward "split" is the safe direction: it declines the correction and leaves the
// planner's choice alone, which is today's behaviour.
export function isSplitAddressForm(labels: Array<string | undefined>): boolean {
  return labels.some((raw) => {
    const label = (raw || "").replace(/\s+/g, " ").trim();
    if (!label) return false;
    // The street type / suffix / direction control: the ONE component grammar (addressComponentOfLabel,
    // #236) the binder asks too. A bare "Direction" is not enough here — it may be an array's — but a
    // bare "Suffix" always was. A UNIT TYPE or POST-DIRECTION control alone never makes a form split:
    // a combined "Property Address" box sits beside a "Unit Type" select on forms that want the whole
    // line (#236 review: the learner's Miami correction would have been skipped there).
    const component = addressComponentOfLabel(label);
    if (component && (component.component === "suffix" || (component.component === "direction" && component.explicit))) return true;
    return /(street|house)\s*(no\.?\b|num\b|number\b)/i.test(label);
  });
}

// ── ADDRESS-COMPONENT CONTROLS ARE THIS PROJECT'S ADDRESS, NEVER THE LEARN JOB'S (#236) ─────────
//
// A split address search asks for the house number, the street DIRECTION, the street name and the
// street TYPE (suffix) in separate controls. The number and the name were bound from the start
// (streetNumber / streetNameCore); the direction and the type are closed-vocabulary selects, so the
// literal binder kept them as "portal constants" and replay chose them unconditionally. Measured in
// the 2026-11-14 recipe audit: both City of Corvallis recipes replay Direction "NW" and Street Type
// "ST" — the learn job's address — and a replay for an "SE … Ave" project searched NW … ST.
//
// So a control whose label names an address component binds to that component of THIS project's
// address (addressComponentFields, in resolveRecipeFieldValues), at learn time
// (convertLiteralsToBoundFields) and on every replay (recipeReplayBinding R13). Read by readStreetLine
// above — the same reading the number and name boxes get — with the one street vocabulary.
//
// The VALUE keeps the portal's own vocabulary: a recorded "ST" means the select lists USPS
// abbreviations, a recorded "Street" means it lists words. Both forms are emitted ("AVE" and
// "Avenue"), and the binding picks the one the recorded literal spoke. Picking the wrong form is
// not harmless: selectWithFallback's contains pass would put "ST" on "Crest".

export type AddressComponent = "direction" | "postDirection" | "suffix" | "unitType";

/** The keys an address-component control binds to, abbreviation form first. */
export const ADDRESS_COMPONENT_KEYS: Readonly<Record<AddressComponent, { abbr: string; word: string }>> = Object.freeze({
  direction: Object.freeze({ abbr: "streetDirection", word: "streetDirectionWord" }),
  postDirection: Object.freeze({ abbr: "streetPostDirection", word: "streetPostDirectionWord" }),
  suffix: Object.freeze({ abbr: "streetSuffix", word: "streetSuffixWord" }),
  unitType: Object.freeze({ abbr: "unitType", word: "unitTypeWord" }),
});
/** WHICH COMPONENTS THE READER COULD NOT READ for this address, as the component keys (both forms),
 *  comma-joined. resolveRecipeFieldValues carries it so the binder can tell "this address has no
 *  direction" (the key is "", an answer) from "the direction could not be read" (named here; the
 *  control goes to a person — recipeReplayBinding R13). */
export const ADDRESS_COMPONENTS_UNREAD_KEY = "addressComponentsUnread";
/** Every key above, and the unread marker — the planner view leaves them out (the binder places them,
 *  never the model), and the save-time value match never binds to them (they are placed by a control's
 *  LABEL: a "Roof Facing" = "Southwest" literal on a learn job at "… SW …" is not the street direction). */
export const ADDRESS_COMPONENT_FIELD_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(ADDRESS_COMPONENT_KEYS).flatMap((k) => [k.abbr, k.word]),
  ADDRESS_COMPONENTS_UNREAD_KEY,
]);
/** The keys an address SEARCH binds its number and name to — a bare "Direction" / "Suffix" label is an
 *  address component only on a page that searches an address this way. */
export const ADDRESS_SEARCH_FIELD_KEYS: ReadonlySet<string> = new Set(["streetNumber", "streetNameCore", "streetNameSearchPortion"]);

/** USPS unit designators, read from the words UNIT_WORD knows (a "#" names no type). One table:
 *  "CANON Word spelling spelling…" per designator — the canon, its display word, then every spelling
 *  that names it. (The Floor designator's canon is the same two letters as a state's postal code; the
 *  place-name guard reads a bare two-letter literal as that state, so the table is one string, not a
 *  map of two-letter literals — these are USPS unit designators, no place is named.) */
const UNIT_TYPES = [
  "APT Apartment apt apartment", "UNIT Unit unit", "STE Suite ste suite", "BLDG Building bldg building",
  "LOT Lot lot", "SPC Space space spc", "TRLR Trailer trlr", "RM Room rm room", "FL Floor fl floor",
].map((row) => row.split(" "));
const UNIT_TYPE_CANON: Readonly<Record<string, string>> = Object.fromEntries(
  UNIT_TYPES.flatMap(([canon, , ...spellings]) => spellings.map((s) => [s, canon] as const)),
);
const UNIT_TYPE_WORD: Readonly<Record<string, string>> = Object.fromEntries(UNIT_TYPES.map(([canon, word]) => [canon, word] as const));
const titleCase = (w: string): string => (w ? w[0].toUpperCase() + w.slice(1) : "");
/** "n" → "North", "se" → "Southeast" (DIRECTION_CANON read backwards). */
function directionWord(canon: string): string {
  const word = Object.keys(DIRECTION_CANON).find((w) => DIRECTION_CANON[w] === canon);
  return word ? titleCase(word) : "";
}
/** "st" → "Street", "ave" → "Avenue" — the longest SUFFIXES spelling of that canonical suffix. */
function suffixWord(canon: string): string {
  const words = Object.keys(SUFFIXES).filter((w) => SUFFIXES[w] === canon).sort((a, b) => b.length - a.length);
  return words.length ? titleCase(words[0]) : "";
}

/** THIS PROJECT'S ADDRESS COMPONENTS, both vocabularies: { streetDirection: "SE", streetDirectionWord:
 *  "Southeast", streetSuffix: "AVE", streetSuffixWord: "Avenue", … }, read by readStreetLine. Three
 *  states per component, never two:
 *    a value  — the address has it;
 *    ""       — the address certainly has none: a directionless street has no direction (the
 *               directionals are a closed list), and no unit word means no unit type;
 *    unread   — no key, and the component named under ADDRESS_COMPONENTS_UNREAD_KEY: the whole line
 *               when it is not readable, a suffix when none from the shared list was read (SUFFIXES
 *               is not every USPS suffix — "Plz", "Xing" — so "no type" is never claimed), and the
 *               leading direction when the address writes its directional after the street ("Main St
 *               NW": a single "Direction" control may want that NW). */
export function addressComponentFields(address: string): Record<string, string> {
  const k = ADDRESS_COMPONENT_KEYS;
  const p = readStreetLine(address);
  const unread = (...cs: AddressComponent[]): Record<string, string> =>
    ({ [ADDRESS_COMPONENTS_UNREAD_KEY]: cs.flatMap((c) => [k[c].abbr, k[c].word]).join(",") });
  if (!p.readable) return unread("direction", "postDirection", "suffix", "unitType");
  const lead = streetWord(p.direction);
  const direction = lead ? (DIRECTION_CANON[lead] ?? lead) : "";
  const out: Record<string, string> = {
    [k.postDirection.abbr]: p.postDirection.toUpperCase(),
    [k.postDirection.word]: directionWord(p.postDirection),
    [k.unitType.abbr]: p.unitType,
    [k.unitType.word]: UNIT_TYPE_WORD[p.unitType] ?? "",
  };
  const notRead: AddressComponent[] = [];
  if (direction || !p.postDirection) Object.assign(out, { [k.direction.abbr]: direction.toUpperCase(), [k.direction.word]: directionWord(direction) });
  else notRead.push("direction");
  if (p.suffix) Object.assign(out, { [k.suffix.abbr]: p.suffix.toUpperCase(), [k.suffix.word]: suffixWord(p.suffix) });
  else notRead.push("suffix");
  return notRead.length ? { ...out, ...unread(...notRead) } : out;
}

/** WHICH ADDRESS COMPONENT DOES THIS CONTROL ASK FOR? `explicit` when the label says so on its own
 *  ("Street Type", "Street Direction", "Pre-Direction", "Unit Type"); a bare "Direction" or "Suffix"
 *  is a component only beside an address search (an array's "Direction" takes compass values too). */
export function addressComponentOfLabel(raw: unknown): { component: AddressComponent; explicit: boolean } | null {
  const label = String(raw ?? "").replace(/[*:?]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!label) return null;
  if (/\b(?:post|suffix|trailing)[\s-]*dir(?:ection)?\b/.test(label)) return { component: "postDirection", explicit: true };
  if (/\bstreet\s*dir(?:ection)?\b|\bst\.?\s*dir(?:ection)?\b|\bpre(?:fix)?[\s-]*dir(?:ection)?\b/.test(label)) return { component: "direction", explicit: true };
  if (/^dir(?:ection)?\.?$/.test(label)) return { component: "direction", explicit: false };
  if (/\bstreet\s*(?:type|suffix)\b|\bst\.?\s*(?:type|suffix)\b/.test(label)) return { component: "suffix", explicit: true };
  if (/^suffix$/.test(label)) return { component: "suffix", explicit: false };
  if (/\bunit\s*(?:type|designator)\b|\b(?:apt|apartment|suite)\s*type\b/.test(label)) return { component: "unitType", explicit: true };
  return null;
}

/** THE KEY A RECORDED ADDRESS-COMPONENT STEP BINDS TO, or null. The recorded literal must speak the
 *  component's vocabulary (a direction, a street type, a unit designator — or be empty); its form
 *  picks the abbreviation or the word key. `addressSearchOnPage`: a step on the same page is bound
 *  to the address search's number or name (a bare label needs it). */
export function addressComponentKeyFor(label: unknown, recorded: unknown, ctx: { addressSearchOnPage: boolean }): string | null {
  const found = addressComponentOfLabel(label);
  if (!found) return null;
  if (!found.explicit && !ctx.addressSearchOnPage) return null;
  const keys = ADDRESS_COMPONENT_KEYS[found.component];
  const v = String(recorded ?? "").trim().toLowerCase().replace(/\./g, "");
  if (!v) return keys.abbr;
  let word: boolean;
  if (found.component === "direction" || found.component === "postDirection") {
    if (!DIRECTIONAL.test(v)) return null;
    word = v.length > 2;
  } else if (found.component === "suffix") {
    const canon = SUFFIXES[v];
    if (!canon) return null;
    word = v !== canon && v === suffixWord(canon).toLowerCase();
  } else {
    const canon = UNIT_TYPE_CANON[v];
    if (!canon) return null;
    word = v !== canon.toLowerCase() && v === String(UNIT_TYPE_WORD[canon] ?? "").toLowerCase();
  }
  return word ? keys.word : keys.abbr;
}

/** For each recorded step, the address-component key it binds to (or null): an unbound, unframed
 *  fill/select whose label names a component, outside the filing company's own contact block (the
 *  contractor's mailing address is not the site's). A page is the run of steps between clicks and
 *  navigations, so a bare "Direction" counts only beside the search it belongs to. */
export function addressComponentKeysForSteps(steps: ReadonlyArray<RecipeStep>): Array<string | null> {
  const pageOf: number[] = [];
  let page = 0;
  steps.forEach((s, i) => {
    if (s.action === "click" || s.action === "goto" || s.action === "stopForReview") page++;
    pageOf[i] = page;
  });
  const searchPages = new Set<number>();
  steps.forEach((s, i) => { if (ADDRESS_SEARCH_FIELD_KEYS.has(String(s.field ?? ""))) searchPages.add(pageOf[i]); });
  return steps.map((s, i) => {
    if ((s.action !== "select" && s.action !== "fill") || s.field || s.sensitive || s.selector?.frame) return null;
    if (contactRoleOfStep(s) === "company") return null;
    const label = String(s.selector?.label || s.selector?.name || s.note || "");
    return addressComponentKeyFor(label, s.value, { addressSearchOnPage: searchPages.has(pageOf[i]) });
  });
}

const normalizeAddr = (s: string): string => (s || "").toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();

/** A planner fill, as far as this correction cares. */
export interface AddressFillCandidate { value: string; field?: string }

// A COMBINED ADDRESS BOX GETS THE WHOLE STREET LINE.
//
// The planner is offered `street` (whole), `streetNumber`, `streetNameCore` (suffix and
// leading direction removed) and `streetNameSearchPortion` (first three characters) — a
// dictionary written for Accela's split form, with nothing in it that says which one a
// single search box wants. On Miami it picked the split-form keys and the search failed
// every time, then failed differently as it picked a shorter one.
//
// So decide it here instead of hoping: on a page with no separate street-number box and no
// street-type/direction control, a fill holding a TRUNCATION of the street line is expanded
// to the whole line and rebound to `street` (a recipe is shared across projects — the value
// must stay bound, never frozen as this project's literal).
//
// Only ever an EXPANSION. The correction is refused unless the full line actually contains
// what the planner chose, so this can add the missing "DR" but can never swap one address
// for another. Split forms are left completely alone: their core-name behaviour is
// live-verified against Oregon ePermitting and is correct there.
export function correctTruncatedAddressFill(
  fill: AddressFillCandidate,
  ctx: { fullStreetLine: string; projectAddress: string; splitForm: boolean },
): AddressFillCandidate | null {
  if (ctx.splitForm) return null;
  const full = (ctx.fullStreetLine || "").trim();
  if (!full) return null;
  const value = (fill.value ?? "").trim();
  const fullNorm = normalizeAddr(full);
  if (!value && fill.field !== "streetNameCore" && fill.field !== "streetNameSearchPortion") return null;
  if (value && normalizeAddr(value) === fullNorm) return null; // already whole

  const core = parseStreetName(ctx.projectAddress);
  const number = parseStreetNumber(ctx.projectAddress);
  const truncations = [core, core.slice(0, 3), `${number} ${core}`, `${number} ${core.slice(0, 3)}`]
    .map(normalizeAddr)
    .filter((t) => t.length > 0 && t !== fullNorm);

  const byKey = fill.field === "streetNameCore" || fill.field === "streetNameSearchPortion";
  const byValue = value.length > 0 && truncations.includes(normalizeAddr(value));
  if (!byKey && !byValue) return null;
  // Expansion only: whatever the planner chose has to be part of the whole line.
  if (value && !fullNorm.includes(normalizeAddr(value))) return null;
  return { value: full, field: "street" };
}
