// ---------------------------------------------------------------------------
// WHICH SUGGESTION IS THIS JOB'S? — the one answer for a search-as-you-type box (#575).
//
// A city's GIS address search (Cityworks PublicAccess "Location": an EDITABLE <input
// role="combobox" aria-autocomplete="list">) offers suggestions only after you type, and the
// application cannot advance until one of them is picked. Picking is the dangerous half: a permit
// filed against a GIS record for a neighbour's house is worse than a stop, and the live case
// (2026-11-03) was exactly the near miss — the city's records give the house the same number and
// street name as the project, but a DIFFERENT street direction (S vs W). So:
//
//   - an ADDRESS suggestion is picked only when it is unmistakably the job's address: the same
//     house number, the same street words in the same order, the same directional(s), no unit
//     disagreement, and the job's city / ZIP whenever the suggestion shows one. Case, punctuation
//     and street suffixes (Dr / Drive) are normalized by the shared site key (draftCreated
//     siteKey — the draft finder's own address tokenizer, so the two never disagree on what a
//     suffix, a unit or a ZIP is) and its row verdict (rowFit) decides unit / ZIP / city;
//   - a near miss (a directional, a unit, a city the suggestion names that is not the job's) or
//     several equally good suggestions pick NOTHING: the run stops with a plain question for a
//     person ("The portal's address list shows … ; the project says … . Use the portal's?");
//   - any other lookup (a contractor, a parcel) is picked only on an exact match of the bound
//     value (case, spacing and punctuation ignored), exactly one.
//
// Pure (no browser): the learner (autoLearnAdapter) and the replay (recipeAdapter) both reach it
// through typeaheadFill.ts, so a learn that picks a suggestion replays by the same rule.
// ---------------------------------------------------------------------------
import { isAutocompleteWidgetClass } from "../../shared/src/portalSafety";
import { parseStreetName, parseStreetNumber } from "./addressParse";
import { DIRECTIONAL, SUFFIXES, rowFit, siteKey, type SiteKey } from "./draftCreated";
import { matchFilerIdentityOption, normalizeCompanyLabel } from "./filerIdentitySelect";

/** What to do with a list of suggestions. */
export type TypeaheadChoice =
  /** Exactly one suggestion is the job's: click it. */
  | { kind: "pick"; index: number; text: string; why: string }
  /** A near miss or several equal candidates: pick nothing; ask a person `question`. */
  | { kind: "ask"; question: string; candidates: string[]; why: string }
  /** Nothing offered is the job's (or nothing was offered). */
  | { kind: "none"; why: string };

/** The job's address, as the typeahead is judged against it. `city` / `zip` only when the value
 *  being typed IS the project's address (never a contractor's mailing address). */
export interface TypeaheadSite { street: string; city?: string; zip?: string; state?: string }

/** A list row that is the widget saying it has nothing, not a suggestion. */
const NOT_A_SUGGESTION = /^(?:no\s+(?:results?|matches|matching\b.*|suggestions?|records?|addresses|items?|data|options?)(?:\s+(?:were\s+)?found)?|nothing\s+found|not\s+found|searching|loading|please\s+wait|type\s+(?:to|at\s+least)\b.*|enter\s+at\s+least\b.*)\W*$/i;

/** THE PORTAL SAYING ITS SEARCH FOUND NOTHING (#139): "The search value did not match an address"
 *  (a CityView location search, after Enter), "No results match your search" (an iWorQ property
 *  and contractor search), "No results found", "Property Address not found." The ONE reading of
 *  those words: a list row that says it is not a suggestion, and the message a no-match stop quotes.
 *  Short text only — a paragraph that happens to contain "not found" is not the search answering. */
const NO_MATCH_SAID = /\b(?:no\s+(?:results?|matches|match(?:ing)?|suggestions?|records?|addresses|propert(?:y|ies)|locations?|parcels?|contractors?)\b(?:\s+(?:were\s+|was\s+)?found)?|did\s+not\s+match|does\s+not\s+match|didn'?t\s+match|(?:could|can)\s*not\s+(?:be\s+)?(?:find|found|locate|located)|not\s+found|nothing\s+found|0\s+results?)\b/i;

/** The portal's own no-match words, trimmed ("" when `raw` does not say that). */
export function noMatchSaid(raw: unknown): string {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  return t && t.length <= 200 && NO_MATCH_SAID.test(t) ? t : "";
}

/** One suggestion's words, trimmed; "" for a widget's own status row ("No results found",
 *  "No results match your search"). */
export function suggestionText(raw: unknown): string {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!t || NOT_A_SUGGESTION.test(t)) return "";
  // A status row that is a no-match sentence and names no house number is not an address.
  if (noMatchSaid(t) && !/\d/.test(t)) return "";
  return t.slice(0, 200);
}

/** THE JOB'S ADDRESS AS ONE LINE (#139): "street, city, ST zip" from the parts the project holds —
 *  what a person types into a location search, and what a CityView search took (the owner, by hand,
 *  2026-11-11: "718 NE 8th St, Bend, OR 97701" + Enter selected the location; the street-name core
 *  "718 NE 8th" was "did not match"). "" without a street line. */
export function oneLineAddress(site: TypeaheadSite): string {
  const street = streetLineOf(site.street);
  if (!street) return "";
  const tail = [String(site.state ?? "").trim(), String(site.zip ?? "").trim()].filter(Boolean).join(" ");
  return [street, String(site.city ?? "").trim(), tail].filter(Boolean).join(", ");
}

const loose = (s: string): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const streetLineOf = (street: string): string => String(street ?? "").split(",")[0].replace(/\s+/g, " ").trim();
const dirsWord = (dirs: string[]): string => (dirs.length ? dirs.join(" ").toUpperCase() : "none");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The part of a suggestion from the job's house number on ("Parcel 12-34 | 123 W Example Dr" →
 *  "123 W Example Dr"), so a parcel id or a label in front of the address is not read as its house
 *  number. The whole text when the house number is not in it. */
function addressPart(text: string, house: string): string {
  const m = new RegExp(`(^|[^0-9a-z])(${escapeRe(house)})([^0-9a-z]|$)`, "i").exec(text);
  return m ? text.slice(m.index + m[1].length) : text;
}

// A STATE CODE THAT IS ALSO A STREET WORD. siteKey stops a street at a state code before it asks
// whether the token is a suffix or a directional, so "Quillfeather CT" reads as Connecticut (no
// suffix, which then matches ANY suffix — a Court for a Drive), "123 NE Example St" and
// "123 Mt Example Rd" read as Nebraska / Montana right after the house number (no street at all).
// Right after the house number (and a directional) neither can be a state, so they are spelled out
// before keying; a trailing CT is compared below as the suffix it is in that position.
const keyable = (s: string): string => String(s ?? "")
  .replace(/^(\s*\d+[A-Za-z]?\s+)NE\b\.?/i, "$1Northeast")
  .replace(/^(\s*\d+[A-Za-z]?\s+(?:(?:[NSEW]|N[EW]|S[EW]|North|South|East|West|Northeast|Northwest|Southeast|Southwest)\.?\s+)?)Mt\b\.?/i, "$1Mount");

/** The suffix written right after the street words (from the house number on), canonical; "" when
 *  that token is not a suffix. "ct" there is Court — after the street words it is not a state. */
function suffixAfterWords(text: string, key: SiteKey): string {
  const toks = String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ");
  let i = toks.indexOf(key.house);
  if (i < 0) return "";
  i++;
  let w = 0;
  while (i < toks.length && w < key.words.length) {
    if (toks[i] === key.words[w]) { w++; i++; continue; }
    if (w === 0 && DIRECTIONAL.test(toks[i])) { i++; continue; }
    return "";
  }
  if (w < key.words.length) return "";
  const t = toks[i] ?? "";
  return SUFFIXES[t] ?? (t === "ct" ? "ct" : "");
}

type Verdict = { kind: "exact" } | { kind: "near"; why: string } | { kind: "other" };

/** How one suggestion fits the job's site key. */
function fitSuggestion(text: string, key: SiteKey, city: string, projectStreet: string): Verdict {
  const part = keyable(addressPart(text, key.house));
  const rk = siteKey({ street: part, city }, true);
  if (!rk || rk.house !== key.house) return { kind: "other" };
  // THE STREET NAME EXACTLY: rowFit only asks that the project's words appear in the row, so
  // "Example" would also fit "Example Ridge". A suggestion is picked on the same words in order.
  if (rk.words.join(" ") !== key.words.join(" ")) return { kind: "other" };
  // ...AND THE SAME SUFFIX when both write one (Court is not Drive), read where it is written.
  const ownSuffix = suffixAfterWords(keyable(streetLineOf(projectStreet)), key);
  const theirSuffix = suffixAfterWords(part, rk);
  if (ownSuffix && theirSuffix && ownSuffix !== theirSuffix) return { kind: "other" };
  const fit = rowFit(part, key);
  const reasons: string[] = [];
  if (fit.fit === "other") {
    // A unit that disagrees is the same building, another door: a person says which. A suffix
    // (Ct vs Dr) or a ZIP that disagrees is another address.
    if (/^the row is unit\b/.test(fit.why)) reasons.push(fit.why.replace(/^the row/, "the suggestion"));
    else return { kind: "other" };
  } else if (fit.fit === "ambiguous") {
    reasons.push(fit.why.replace(/\bthe row\b/g, "the suggestion"));
  }
  if (rk.dirs.join(" ") !== key.dirs.join(" ")) {
    reasons.push(`the street direction differs: ${dirsWord(rk.dirs)} on the portal, ${dirsWord(key.dirs)} on the project`);
  }
  return reasons.length ? { kind: "near", why: reasons.join("; ") } : { kind: "exact" };
}

/**
 * THE ADDRESS PREDICATE: which of `suggestions` (in the widget's order) is the job's address.
 * Exactly one exact suggestion → pick it (near misses beside it are other doors of the same street,
 * not doubt about this one). Several exact → ask. None exact and one or more near → ask, naming
 * them. Nothing near → none.
 */
export function chooseAddressSuggestion(suggestions: unknown[], site: TypeaheadSite): TypeaheadChoice {
  const street = streetLineOf(site.street);
  const key = siteKey({ street: keyable(String(site.street ?? "")), city: site.city, zip: site.zip });
  if (!key) return { kind: "none", why: `the project's address ("${street}") has no house number and street name to match a suggestion against` };
  const city = String(site.city ?? "");
  const texts = (Array.isArray(suggestions) ? suggestions : []).map(suggestionText);
  const exact: Array<{ index: number; text: string }> = [];
  const near: Array<{ index: number; text: string; why: string }> = [];
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index];
    if (!text) continue;
    const v = fitSuggestion(text, key, city, String(site.street ?? ""));
    if (v.kind === "exact") exact.push({ index, text });
    else if (v.kind === "near") near.push({ index, text, why: v.why });
  }
  const offered = texts.filter(Boolean);
  if (exact.length === 1) {
    return { kind: "pick", index: exact[0].index, text: exact[0].text, why: `"${exact[0].text}" is the project's address (house number, street, direction${key.unit ? ", unit" : ""}${key.city || key.zip ? " and city/ZIP where shown" : ""})` };
  }
  if (exact.length > 1) {
    const list = exact.slice(0, 5).map((e) => `"${e.text}"`).join(" | ");
    return {
      kind: "ask",
      candidates: exact.map((e) => e.text),
      why: `${exact.length} suggestions read as the project's address equally well`,
      question: `The portal's address list shows ${exact.length} entries that each match the project's address "${street}": ${list}. Which one is this job's?`,
    };
  }
  if (near.length === 1) {
    const n = near[0];
    return {
      kind: "ask",
      candidates: [n.text],
      why: n.why,
      question: `The portal's address list shows "${n.text}"; the project says "${street}" (${n.why}). Use the portal's?`,
    };
  }
  if (near.length > 1) {
    const list = near.slice(0, 5).map((n) => `"${n.text}"`).join(" | ");
    return {
      kind: "ask",
      candidates: near.map((n) => n.text),
      why: `${near.length} suggestions are close to the project's address and none is exact`,
      question: `The portal's address list shows ${near.length} addresses close to the project's "${street}" but none exactly: ${list}. Which one, if any, is this job's?`,
    };
  }
  return {
    kind: "none",
    why: offered.length
      ? `none of the ${offered.length} suggestion(s) is the project's address "${street}" (offered: ${offered.slice(0, 5).map((t) => `"${t}"`).join(" | ")})`
      : "the box offered no suggestions",
  };
}

/** ANY OTHER LOOKUP: the one suggestion equal to the bound value (case, spacing, punctuation
 *  ignored). Several equal → ask; none → none. Never a containment match: "Sun Co" is not
 *  "Sun Co Northwest". */
export function chooseExactSuggestion(suggestions: unknown[], value: string): TypeaheadChoice {
  const want = loose(value);
  if (!want) return { kind: "none", why: "there is no value to match a suggestion against" };
  const texts = (Array.isArray(suggestions) ? suggestions : []).map(suggestionText);
  const hits: number[] = [];
  for (let i = 0; i < texts.length; i++) if (texts[i] && loose(texts[i]) === want) hits.push(i);
  const offered = texts.filter(Boolean);
  if (hits.length === 1) return { kind: "pick", index: hits[0], text: texts[hits[0]], why: `"${texts[hits[0]]}" is exactly the value` };
  if (hits.length > 1) {
    return {
      kind: "ask",
      candidates: hits.map((i) => texts[i]),
      why: `${hits.length} suggestions read exactly "${value}"`,
      question: `The portal's list shows ${hits.length} entries reading exactly "${String(value).trim()}". Which one is this job's?`,
    };
  }
  return {
    kind: "none",
    why: offered.length
      ? `none of the ${offered.length} suggestion(s) is exactly "${String(value).trim()}" (offered: ${offered.slice(0, 5).map((t) => `"${t}"`).join(" | ")})`
      : "the box offered no suggestions",
  };
}

/** THE SUBMITTING COMPANY IN A CONTRACTOR SEARCH (#244): the one suggestion that is this client's
 *  company, by the SAME rule a company select is answered by (filerIdentitySelect
 *  matchFilerIdentityOption, #524) — the exact name wins, else the one suggestion that folds to the
 *  same name ("Acme Solar & Electric LLC" is "ACME SOLAR AND ELECTRIC LLC"); words are never dropped,
 *  so "Acme Solar" is never "Acme Solar of Idaho". Two that read as the name → ask; none → none. Why:
 *  an iWorQ "Contractor(s)" search (City of Star, live 2026-11-15) decides who files the permit, and
 *  a second, looser reading of "is this row my company?" would let the two answers disagree. */
export function chooseCompanySuggestion(suggestions: unknown[], company: string): TypeaheadChoice {
  const want = String(company ?? "").replace(/\s+/g, " ").trim();
  if (!normalizeCompanyLabel(want)) return { kind: "none", why: "there is no company name to match a suggestion against" };
  const texts = (Array.isArray(suggestions) ? suggestions : []).map(suggestionText);
  const options = texts.map((label, i) => ({ value: String(i), label })).filter((o) => o.label);
  const offered = texts.filter(Boolean);
  const m = matchFilerIdentityOption(options, want, "company");
  if ("hit" in m) {
    const index = Number(m.hit.value);
    return { kind: "pick", index, text: texts[index], why: `"${texts[index]}" is the submitting company "${want}"` };
  }
  const folded = normalizeCompanyLabel(want);
  const same = offered.filter((t) => normalizeCompanyLabel(t) === folded);
  if (same.length > 1) {
    return {
      kind: "ask",
      candidates: same,
      why: m.why,
      question: `The portal's list shows ${same.length} entries that read as the submitting company "${want}": ${same.slice(0, 5).map((t) => `"${t}"`).join(" | ")}. Which one is this job's?`,
    };
  }
  return {
    kind: "none",
    why: offered.length
      ? `none of the ${offered.length} suggestion(s) is the submitting company "${want}" (offered: ${offered.slice(0, 5).map((t) => `"${t}"`).join(" | ")})`
      : "the box offered no suggestions",
  };
}

/** What a box's own markup says about it, read in the page (typeaheadFill typeaheadBoxFactsInPage)
 *  and judged here by typeaheadBoxSays. */
export interface TypeaheadBoxFacts {
  /** An <input> of type text or search (or no type). */
  textBox: boolean;
  /** Not read-only and not disabled (natively or by aria). */
  editable: boolean;
  role?: string;
  ariaAutocomplete?: string;
  /** The box's own class attribute. */
  className?: string;
  id?: string;
  ariaLabel?: string;
  /** The class attributes of the box's own widget, nearest first: its ancestors up to the highest one
   *  that holds no other text-entry control (at most four levels, never past a <form>). */
  widgetClasses?: string[];
}

/** A word that names a search-as-you-type widget, inside one class token / id / label word. */
const TYPEAHEAD_WORD = /autocomplete|typeahead|autosuggest/;
/** A token that says the opposite ("autocomplete-off", "noautocomplete", "typeahead-disabled") —
 *  the reading isAutocompleteWidgetClass applies to the box's own stamp. */
const NEGATED_TOKEN = /off|no|disable/;
const namesTypeahead = (token: string): boolean => {
  const t = String(token ?? "").toLowerCase();
  return !!t && TYPEAHEAD_WORD.test(t) && !NEGATED_TOKEN.test(t);
};
const classTokens = (cls: unknown): string[] => String(cls ?? "").toLowerCase().split(/\s+/).filter(Boolean);

/**
 * IS THIS BOX A SEARCH-AS-YOU-TYPE BOX? — THE ONE ANSWER, FROM THE BOX'S OWN MARKUP (#244). The
 * reason ("" when it is not). The learner asks it at its fill door, the replay at its own, so a step
 * recorded as a plain fill before the box was recognised still types and picks: the markup decides,
 * not the recording. An editable text/search <input> only, and any of:
 *   1. ARIA: role=combobox with aria-autocomplete list|both (#575, a Cityworks GIS "Location");
 *   2. an autocomplete widget's stamp on the box (portalSafety isAutocompleteWidgetClass, #139 — the
 *      predicate the Enter question reads; READ here, never widened here);
 *   3. THE WIDGET NAMES ITSELF ONE, with no ARIA and no stamp: an "autocomplete" / "typeahead" /
 *      "autosuggest" token in the box's own id, its aria-label, its class, or the class of its own
 *      widget container — never a token that says the opposite. Live City of Star (iWorQ,
 *      2026-11-15): <input id="autocomplete_1" aria-label="properties autocomplete" class="form-control"
 *      placeholder="Search properties…"> inside div.autocomplete-template, no role, no name; recorded
 *      as a plain fill, the replay typed the address, picked nothing, and called the step verified.
 * Never "Search…" wording alone: a keyword box (Tigard's) is typed into and searched, not picked from.
 */
export function typeaheadBoxSays(f: TypeaheadBoxFacts | null | undefined): string {
  if (!f || !f.textBox || !f.editable) return "";
  const role = String(f.role ?? "").trim().toLowerCase();
  const completes = String(f.ariaAutocomplete ?? "").trim().toLowerCase();
  if (role === "combobox" && (completes === "list" || completes === "both")) return `role=combobox with aria-autocomplete=${completes}`;
  if (isAutocompleteWidgetClass(f.className)) return `an autocomplete widget's stamp on the box (class "${String(f.className ?? "").trim().slice(0, 60)}")`;
  const id = String(f.id ?? "").trim();
  if (namesTypeahead(id)) return `its own id "${id.slice(0, 60)}" names it an autocomplete`;
  const aria = String(f.ariaLabel ?? "").replace(/\s+/g, " ").trim();
  if (!/\b(?:off|disabled?|no|not|without)\b/i.test(aria) && aria.split(" ").some(namesTypeahead)) return `its aria-label "${aria.slice(0, 60)}" names it an autocomplete`;
  const own = classTokens(f.className).find(namesTypeahead);
  if (own) return `its class "${own.slice(0, 60)}" names it an autocomplete`;
  for (const cls of f.widgetClasses ?? []) {
    const tok = classTokens(cls).find(namesTypeahead);
    if (tok) return `its widget ("${tok.slice(0, 60)}") names itself an autocomplete`;
  }
  return "";
}

/** What to TYPE into an address search, in order: the house number and the street's core name
 *  ("123 Example" — no directional, no suffix, so a list holding "123 S EXAMPLE DR" still answers),
 *  then the house number alone (wider: a list that matches from the start of its entries). An
 *  address without a numeric house number is typed as its street line. */
export function addressQueries(street: string): string[] {
  const line = streetLineOf(street);
  const house = parseStreetNumber(line);
  const core = parseStreetName(line);
  if (!/^\d+[A-Za-z]?$/.test(house) || !core) return line ? [line] : [];
  const out = [`${house} ${core}`, house];
  return out.filter((q, i) => q && out.indexOf(q) === i);
}

/** The bindings whose value IS the project's site address (resolveRecipeFieldValues: `street` is
 *  the street line, `projectAddress` the whole line). Only these are judged with the job's city and
 *  ZIP. */
const SITE_ADDRESS_FIELDS = new Set(["street", "projectAddress"]);

/** How a typeahead fill is judged: "site" — the project's own address (house, street, direction,
 *  unit, city/ZIP); "address" — some other street address (a mailing address: no city/ZIP check);
 *  "company" — the submitting company (#244: bound to installerCompanyName, judged by
 *  chooseCompanySuggestion); "exact" — anything else. By the binding first; then a value that IS the
 *  project's street line (same house number and street words — a literal of the job's own address);
 *  then, for a value in a box labelled as an address, the address rule without the job's city. Never
 *  by "the value starts with a digit" alone ("100 Amp"). */
export function typeaheadMatchMode(fill: { field?: string | null; label?: string | null; value?: string | null; projectStreet?: string | null }): "site" | "address" | "exact" | "company" {
  const field = String(fill.field ?? "").trim();
  if (SITE_ADDRESS_FIELDS.has(field)) return "site";
  if (field === "installerCompanyName") return "company";
  const own = siteKey({ street: keyable(String(fill.value ?? "")) });
  if (!own) return "exact";
  const project = siteKey({ street: keyable(String(fill.projectStreet ?? "")) });
  if (project && project.house === own.house && project.words.join(" ") === own.words.join(" ")) return "site";
  // An address in a box labelled as one: judged as an address, without the city/ZIP (the job's city
  // would be wrong for a contractor's or an owner's mailing address).
  return /\b(?:address|location|street|site)\b/i.test(String(fill.label ?? "")) ? "address" : "exact";
}
