// Street-address parsing for portal address-search forms (Accela ACA and kin), pure and
// browser-free so BOTH sides of a recipe can share it: the learn/stage adapters that fill
// the search form live, and the backend's resolveRecipeFieldValues that binds the same
// values at replay (a recorded recipe must never replay the LEARN project's address).
// Live-verified against Oregon ePermitting (originally in oregonEPermitting.ts).
import type { RecipeStep } from "../../shared/src/types";
import { contactRoleOfStep } from "../../shared/src/contactRoles";
import { DIRECTION_CANON, DIRECTIONAL, SUFFIXES, UNIT_WORD, siteKey } from "./draftCreated";

// The street LINE only — the part before the first comma. projectAddress is stored as
// "925 N Grant St, Lafayette, OR, 97127"; everything after the first comma is city/state/zip
// and must not leak into the street-number/name/direction parsing (it returns zero results).
function streetLine(address: string): string {
  return (address || "").split(",")[0].trim();
}

export function parseStreetNumber(address: string): string {
  return streetLine(address).split(/\s+/)[0] ?? "";
}

const STREET_DIRECTIONS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west"]);
const STREET_SUFFIXES = new Set([
  "st", "street", "ave", "avenue", "blvd", "boulevard", "rd", "road", "dr", "drive",
  "ln", "lane", "ct", "court", "way", "pl", "place", "ter", "terrace", "cir", "circle",
  "hwy", "highway", "pkwy", "parkway", "loop", "trl", "trail",
]);
const clean = (w: string) => w.toLowerCase().replace(/[.,]/g, "");

// Accela's "Street Name" search field wants the CORE name only — e.g. "925 N Grant St" must
// be searched as "Grant" (the leading direction and trailing street-type suffix belong in
// separate fields). Including them returns zero results, which silently breaks the flow.
export function parseStreetName(address: string): string {
  const parts = streetLine(address).split(/\s+/);
  parts.shift(); // remove street number
  if (parts.length > 1 && STREET_DIRECTIONS.has(clean(parts[0]))) parts.shift(); // leading direction
  const unitKeywords = new Set(["apt", "unit", "ste", "suite", "#"]);
  const unitIdx = parts.findIndex((p) => unitKeywords.has(p.toLowerCase()));
  let core = unitIdx === -1 ? parts : parts.slice(0, unitIdx);
  // strip trailing street-type suffix and/or trailing direction (e.g. "Grant St", "Main St NW")
  while (core.length > 1 && (STREET_SUFFIXES.has(clean(core[core.length - 1])) || STREET_DIRECTIONS.has(clean(core[core.length - 1])))) {
    core = core.slice(0, -1);
  }
  return core.join(" ");
}

// Leading directional (N/S/E/W) of the street, for Accela's separate direction dropdown.
export function parseStreetDirection(address: string): string {
  const parts = streetLine(address).split(/\s+/);
  parts.shift(); // street number
  return parts.length > 1 && STREET_DIRECTIONS.has(clean(parts[0])) ? parts[0].toUpperCase().replace(/[.,]/g, "") : "";
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
    // The street type / suffix / direction / unit-type control: the ONE component grammar
    // (addressComponentOfLabel, #236) the binder asks too. A bare "Direction" is not enough here —
    // it may be an array's — but a bare "Suffix" always was.
    const component = addressComponentOfLabel(label);
    if (component && (component.explicit || component.component === "suffix")) return true;
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
// (convertLiteralsToBoundFields) and on every replay (recipeReplayBinding R13). Read with the one
// street vocabulary (draftCreated DIRECTIONAL / SUFFIXES / UNIT_WORD, which siteKey parses with) —
// never a third list.
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
/** Every key above — the planner view leaves them out (the binder places them, never the model). */
export const ADDRESS_COMPONENT_FIELD_KEYS: ReadonlySet<string> = new Set(
  Object.values(ADDRESS_COMPONENT_KEYS).flatMap((k) => [k.abbr, k.word]),
);
/** The keys an address SEARCH binds its number and name to — a bare "Direction" / "Suffix" label is an
 *  address component only on a page that searches an address this way. */
export const ADDRESS_SEARCH_FIELD_KEYS: ReadonlySet<string> = new Set(["streetNumber", "streetNameCore", "streetNameSearchPortion"]);

/** USPS unit designators, read from the words UNIT_WORD knows (a "#" names no type). */
const UNIT_TYPE_CANON: Readonly<Record<string, string>> = {
  apt: "APT", apartment: "APT", unit: "UNIT", ste: "STE", suite: "STE", bldg: "BLDG", building: "BLDG",
  lot: "LOT", space: "SPC", spc: "SPC", trlr: "TRLR", rm: "RM", room: "RM", fl: "FL", floor: "FL",
};
const UNIT_TYPE_WORD: Readonly<Record<string, string>> = {
  APT: "Apartment", UNIT: "Unit", STE: "Suite", BLDG: "Building", LOT: "Lot", SPC: "Space", TRLR: "Trailer", RM: "Room", FL: "Floor",
};
const titleCase = (w: string): string => (w ? w[0].toUpperCase() + w.slice(1) : "");
const tokensOf = (s: string): string[] => String(s || "").toLowerCase().replace(/[^a-z0-9#]+/g, " ").split(" ").filter(Boolean);
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

/** The four components of the project's street line, canonical lowercase ("se", "ave", "apt"). */
function addressComponentsOf(address: string): Record<AddressComponent, string> {
  const line = streetLine(address);
  const none = { direction: "", postDirection: "", suffix: "", unitType: "" };
  const key = siteKey({ street: line }, true);
  if (!key) return none;
  const toks = tokensOf(line);
  const house = toks.findIndex((w) => /^\d+[a-z]?$/.test(w));
  const next = toks[house + 1] ?? "";
  // A leading directional is one only when a street name follows it ("123 N Main St"), which siteKey
  // has already established by finding words.
  const direction = DIRECTIONAL.test(next) ? (DIRECTION_CANON[next] ?? next) : "";
  const postDirection = (direction ? key.dirs.slice(1) : key.dirs)[0] ?? "";
  const unitWord = toks.slice(house + 1).find((w) => UNIT_WORD.test(w) && UNIT_TYPE_CANON[w]) ?? "";
  return { direction, postDirection: postDirection === direction && direction ? "" : postDirection, suffix: key.suffix, unitType: unitWord ? UNIT_TYPE_CANON[unitWord] : "" };
}

/** THIS PROJECT'S ADDRESS COMPONENTS, both vocabularies: { streetDirection: "SE", streetDirectionWord:
 *  "Southeast", streetSuffix: "AVE", streetSuffixWord: "Avenue", … }. "" for a component the
 *  address does not have — a directionless street has no direction, and that is an answer. */
export function addressComponentFields(address: string): Record<string, string> {
  const c = addressComponentsOf(address);
  const k = ADDRESS_COMPONENT_KEYS;
  return {
    [k.direction.abbr]: c.direction.toUpperCase(),
    [k.direction.word]: directionWord(c.direction),
    [k.postDirection.abbr]: c.postDirection.toUpperCase(),
    [k.postDirection.word]: directionWord(c.postDirection),
    [k.suffix.abbr]: c.suffix.toUpperCase(),
    [k.suffix.word]: suffixWord(c.suffix),
    [k.unitType.abbr]: c.unitType,
    [k.unitType.word]: UNIT_TYPE_WORD[c.unitType] ?? "",
  };
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
