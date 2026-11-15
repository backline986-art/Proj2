// ---------------------------------------------------------------------------
// A RECORDED SELECTOR NEVER CARRIES THE LEARN JOB'S DATA OR A DATE AS IDENTITY (#235).
//
// A recipe is shared by every job on its portal, so a selector that names something only the LEARN
// job has can never match another job, or matches it by accident. The 2026-11-14 audit of the 22
// saved recipes found three shapes of it:
//
//   - a results-grid row recorded BY ITS CONTENT: Boise's address, parcel, owner and licence result
//     rows carry the learn property's address, parcel number and owner name, and the filing
//     company's licence number, as the label. On any other job the label misses, the recorded
//     row-position id answers instead, and the audit's probes ticked the NEIGHBOUR's address row
//     (row 1) and skipped the parcel row (the label re-anchor found no shared word);
//   - a contact row keyed by the learn company: Tigard's tr:has-text(<company>):has-text(<street
//     number>) matches nothing for another client, and the replay stalled;
//   - a DATE frozen as a label: an Accela certification tick recorded as "Date: MM/DD/YYYY" (the
//     day's date printed beside the box) resolved by id on any later day, the re-anchor read the
//     box's own label, found no word in common with the date, and skipped the certification.
//
// One module answers both sides of the question, so the learner and the replay cannot disagree:
//   - resultRowRoleOf: is this recorded step a pick of one results row, and of what (the property's
//     address / parcel / owner, the company's licence / contact record)? The replay picks that row
//     by THIS job's own value; the learner records the ROLE instead of the learn job's row content.
//   - isVolatileLabel: are a recorded label's words all volatile (a date, a long digit run, the
//     learn job's own values)? Such a label is not identity evidence — it can neither confirm nor
//     contradict the control a step resolved to.
//   - withoutLearnDataInSelectors: the learner's last pass over a walk's steps.
//
// Pure and browser-free: portal-bot's learner and replay both import it.
// ---------------------------------------------------------------------------
import type { RecipeSelector, RecipeStep, StepFingerprint } from "../../shared/src/types";
import { labelWords } from "../../shared/src/portalSafety";
import { siteKey } from "./draftCreated";

export type ResultRowRole = NonNullable<RecipeStep["rowRole"]>;

/** THE ONE DATE GRAMMAR. A recorded VALUE that is a date (anchored — backend portalRecipes binds such
 *  a literal by its label) and a date printed INSIDE a label share it, so "is this a date" has one
 *  answer: ISO 2026-11-12 or US 11/12/2026. */
const DATE_SOURCE = String.raw`\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}`;
export const DATE_LITERAL = new RegExp(`^(${DATE_SOURCE})$`);
/** What the learner writes where a label printed the day's date — volatile by construction. */
export const DATE_STAND_IN = "[date]";
const DATE_IN_TEXT = new RegExp(`(?<![\\d/-])(?:${DATE_SOURCE})(?![\\d/-])|\\[date\\]`, "gi");
/** A word that only CAPTIONS the date beside it ("Date:", "Today's date", "Signed on"). Volatile only
 *  when the date itself is in the label: a bare "Date:" names a question. */
const DATE_CAPTION = /^(?:date|dated|today|todays|current|as|of|on|signed|effective)$/;

// An apostrophe joins its word ("Today's" is one word, "todays"), never splits off an "s".
const tokensOf = (text: string): string[] =>
  String(text ?? "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const compact = (text: string): string => String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const digitsOf = (text: string): string => String(text ?? "").replace(/\D/g, "");

/** Does the text carry a date (or the learner's stand-in for one)? */
export function carriesDate(text: string): boolean {
  DATE_IN_TEXT.lastIndex = 0;
  const hit = DATE_IN_TEXT.test(String(text ?? ""));
  DATE_IN_TEXT.lastIndex = 0;
  return hit;
}

/** The text with every date replaced by the stand-in ("Date: 11/12/2026" → "Date: [date]"). */
export function withDateStandIn(text: string): string {
  return String(text ?? "").replace(DATE_IN_TEXT, DATE_STAND_IN);
}

/** THE LEARN JOB'S OWN VALUES — the property's and the filing company's. Matched by shape (an address
 *  by house number and street words, a number by its digits, a name by all of its words), never as a
 *  raw substring. Only the learner and the backend's binding pass know them; replay never does. */
export interface LearnIdentity {
  /** The property's street line. */
  siteStreet?: string;
  /** The property owner's name(s). */
  ownerNames?: string[];
  /** The property's parcel / APN. */
  parcels?: string[];
  /** The filing company's names (company, legal name, DBA). */
  companyNames?: string[];
  /** The filing company's street line. */
  companyStreet?: string;
  /** The filing company's phone / email. */
  companyContacts?: string[];
  /** The filing company's licence numbers. */
  licences?: string[];
}

// A DIGIT RUN LONG ENOUGH TO BE SOMEBODY'S NUMBER (a parcel, a licence, a phone, an account) is
// volatile: five digits or more once dashes, dots and spaces between digit groups are closed up
// ("123-45-678", "R1013000280", "014096"). A SLASH is never closed: "120/240" is a voltage — the
// portal's own vocabulary — and must keep contradicting a control labelled anything else.
const LONG_NUMBER_MIN_DIGITS = 5;
const isLongNumberToken = (token: string): boolean => (token.match(/\d/g) ?? []).length >= LONG_NUMBER_MIN_DIGITS;

/** Every value of an identity, as the comparable forms a label is matched against. */
function identityValues(identity: LearnIdentity | undefined): Array<{ role: ResultRowRole; kind: "address" | "number" | "words" | "contact"; value: string }> {
  if (!identity) return [];
  const out: Array<{ role: ResultRowRole; kind: "address" | "number" | "words" | "contact"; value: string }> = [];
  const push = (role: ResultRowRole, kind: "address" | "number" | "words" | "contact", raw: unknown) => {
    const value = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!value) return;
    if (kind === "number" && compact(value).length < 4) return;
    if (kind === "words" && compact(value).length < 4) return;
    out.push({ role, kind, value });
  };
  push("address", "address", identity.siteStreet);
  for (const v of identity.parcels ?? []) push("parcel", "number", v);
  for (const v of identity.licences ?? []) push("licence", "number", v);
  for (const v of identity.ownerNames ?? []) push("owner", "words", v);
  for (const v of identity.companyNames ?? []) push("contact", "words", v);
  push("contact", "address", identity.companyStreet);
  for (const v of identity.companyContacts ?? []) push("contact", "contact", v);
  return out;
}

/** Does `text` carry this identity value? An address: the same house number and every street word.
 *  A number: its alphanumerics inside the text's (a board prefix optional). Words: every word of the
 *  value, in any order. A phone / email: its digits (7+) or the address itself. */
function carriesValue(text: string, v: { kind: string; value: string }): boolean {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  if (v.kind === "address") {
    const want = siteKey({ street: v.value });
    if (!want) return false;
    for (const segment of t.split(/\s*\|\s*/)) {
      const got = siteKey({ street: segment }, true);
      if (got && got.house === want.house && want.words.every((w) => got.words.includes(w))) return true;
    }
    return false;
  }
  if (v.kind === "number") {
    const full = compact(v.value);
    const bare = full.replace(/^[a-z]+/, "");
    const hay = compact(t);
    return (full.length >= 4 && hay.includes(full)) || (bare.length >= 5 && bare !== full && hay.includes(bare));
  }
  if (v.kind === "contact") {
    if (v.value.includes("@")) return t.toLowerCase().includes(v.value.toLowerCase());
    const d = digitsOf(v.value);
    return d.length >= 7 && digitsOf(t).includes(d);
  }
  const want = tokensOf(v.value).filter((w) => w.length >= 2);
  if (!want.length) return false;
  const have = new Set(tokensOf(t));
  return want.every((w) => have.has(w));
}

/** The role of the first identity value `text` carries, or null. */
export function identityRoleIn(text: string, identity: LearnIdentity | undefined): ResultRowRole | null {
  for (const v of identityValues(identity)) if (carriesValue(text, v)) return v.role;
  return null;
}

/** Does `text` carry ANY of the learn job's values (or a date)? The learner's test for a selector
 *  level that must not be written. */
export function carriesLearnData(text: string, identity: LearnIdentity | undefined): boolean {
  return carriesDate(text) || identityRoleIn(text, identity) !== null;
}

/** A label's IDENTITY words: its words with the volatile ones removed — a date with its caption, a
 *  long digit run, and (with an identity) the words of any learn value it carries. */
export function identityWordsOf(label: string, identity?: LearnIdentity): string[] {
  let text = String(label ?? "");
  const hadDate = carriesDate(text);
  text = text.replace(DATE_IN_TEXT, " ");
  // Close up digit groups joined by a dash, dot or space so a parcel "123-45-678" reads as one number.
  text = text.replace(/(\d)[-.\s]+(?=\d)/g, "$1");
  const learnWords = new Set<string>();
  for (const v of identityValues(identity)) {
    if (!carriesValue(label, v)) continue;
    for (const w of tokensOf(v.value)) learnWords.add(w);
    if (v.kind === "number" || v.kind === "contact") learnWords.add(compact(v.value));
  }
  return tokensOf(text).filter((w) =>
    !isLongNumberToken(w)
    && !(hadDate && DATE_CAPTION.test(w))
    && !learnWords.has(w));
}

/** THE ONE ANSWER TO "IS THIS RECORDED LABEL IDENTITY EVIDENCE?" — false when it is: a label whose
 *  every word is volatile (a date and its caption, long digit runs, the learn job's own values)
 *  names nothing a later job's page will print, so it can neither confirm nor contradict the control
 *  a step resolved to. An empty label is not volatile (it is simply absent). */
export function isVolatileLabel(label: string, identity?: LearnIdentity): boolean {
  if (!tokensOf(label).length && !carriesDate(label)) return false;
  return identityWordsOf(label, identity).length === 0;
}

/** Does the text read as a street address ("150 N Example Blvd, Town ST 83702")? A house number, a
 *  street word, and a street suffix or a ZIP — the shared site key's reading (draftCreated.siteKey),
 *  so a record type "424-544-Electrical" or a question "Is the system 2 stories?" never does. */
export function readsAsStreetAddress(text: string): boolean {
  const k = siteKey({ street: String(text ?? "") }, true);
  return !!k && /^\d{1,6}[a-z]?$/.test(k.house) && k.words.some((w) => /[a-z]{2,}/.test(w)) && (!!k.suffix || !!k.zip);
}

// WHAT A CONTROL'S OWN ID SAYS IT BELONGS TO, read as words (shared labelWords, the one splitter):
// "ucOwnerList_gv_CB_0" is an OWNER LIST's box. The LAST role word wins — a grid nests inside a
// panel named for the search that opened it ("…AddressSearchResult_ucParcelList…" is the parcel
// list, not the address one).
const ROLE_WORD = /\b(address|parcel|apn|owner|licen[cs]e|contact|applicant|contractor)\b/gi;
const LISTISH = /\b(list|grid|gv|gdv|results?|rows?|table)\b/i;
const roleOfWord = (w: string): ResultRowRole => {
  const x = w.toLowerCase();
  if (x === "parcel" || x === "apn") return "parcel";
  if (x === "owner") return "owner";
  if (x.startsWith("licen")) return "licence";
  if (x === "address") return "address";
  return "contact";
};
function lastRoleWord(text: string): ResultRowRole | null {
  const words = String(text ?? "").match(ROLE_WORD);
  return words && words.length ? roleOfWord(words[words.length - 1]) : null;
}
/** The recorded control's own ids / names, read as words. */
function controlIdentityWords(step: RecipeStep): string {
  const ids: string[] = [];
  const fp = step.fingerprint as StepFingerprint | undefined;
  if (fp?.id) ids.push(fp.id);
  if (fp?.name) ids.push(fp.name);
  for (const lvl of [step.selector, ...(step.selector?.fallbacks ?? [])]) {
    const m = /^(?:#([\w$:.-]+)|\[id="([^"]+)"\])$/.exec(String(lvl?.css ?? "").trim());
    if (m) ids.push(m[1] || m[2]);
  }
  return ids.map((s) => labelWords(s)).join(" ");
}

/** Notes the replay routes elsewhere, or that name no results row: the record type and its group,
 *  standing answers, the hand-coded Accela passes, advances, lookups, the work-location address
 *  versions (their own matcher), signatures, attachments, the contact-dialog pass, the final submit. */
const NOT_A_RESULT_ROW_NOTE = /^(?:record type|policy default:|accela:|advance:|final submit|lookup:|work location:|navigate to|e-signature|attachment|upload|contact\(|address version:|submit by enter)/i;
/** A css that keys a row by the text in it (`tr:has-text("…")`). */
const ROW_KEYED_CSS = /(?:^|[\s,>])(?:tr|li|\[role=["']?row["']?\])\s*:has-text\(/i;
/** A note that says the row is the filing company's own record. */
const CONTACT_NOTE = /\b(?:client'?s record|company'?s (?:own )?record|contact|contractor|applicant|licensed professional)\b/i;
/** A name as a results row shows one: a few words, no question mark or colon, not a closed answer. */
const CLOSED_ANSWER = /^(?:yes|no|none|n\/?a|other|true|false|agree|accept|i agree)$/i;
function readsAsName(text: string): boolean {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || /[?:]/.test(t) || CLOSED_ANSWER.test(t) || /\d/.test(t)) return false;
  const words = t.split(" ");
  return words.length >= 1 && words.length <= 6 && /[a-z]{2,}/i.test(t);
}

/** Quoted texts of a row-keyed css (`tr:has-text("ACME CO"):has-text("123")` → ["ACME CO", "123"]). */
function rowKeyedTexts(sel: RecipeSelector | undefined): string[] {
  const out: string[] = [];
  for (const lvl of [sel, ...(sel?.fallbacks ?? [])]) {
    const css = String(lvl?.css ?? "");
    if (!ROW_KEYED_CSS.test(css)) continue;
    for (const m of css.matchAll(/:has-text\(\s*["']([^"']+)["']\s*\)/g)) {
      if (!/^(?:select|add|choose|pick|use)$/i.test(m[1].trim()) && !out.includes(m[1])) out.push(m[1]);
    }
  }
  return out;
}

/** What the recorded step SHOWED as its target: the label, name or text of its first level. */
function shownTextOf(step: RecipeStep): string {
  const sel = step.selector;
  return String(sel?.label || sel?.name || sel?.text || "").replace(/\s+/g, " ").trim();
}

/**
 * THE ONE ANSWER TO "IS THIS RECORDED STEP A PICK OF ONE RESULTS ROW, AND OF WHAT?"
 *
 * A check or click whose recorded target is a ROW'S CONTENT rather than a question:
 *   - an explicit `rowRole` (what the learner records now);
 *   - with the learn job's identity (the learner): a target carrying the property's address, parcel
 *     or owner, or the company's name, street, phone, email or licence;
 *   - from the shape alone (the replay, for recipes recorded before): a target that reads as a street
 *     address; a css keyed by row text under a note naming the company's record; or, inside a control
 *     whose own id says it is a LIST of parcels / owners / licences / contacts, a target that is a
 *     long number (parcel, licence) or, in an owner list, a name.
 * Never a step another route owns (record type, policy answers, address versions, the final submit).
 */
export function resultRowRoleOf(step: RecipeStep | null | undefined, identity?: LearnIdentity): ResultRowRole | null {
  if (!step || (step.action !== "check" && step.action !== "click")) return null;
  if (step.rowRole) return step.rowRole;
  if (step.isFinalSubmit || step.companyFactOf || step.field || step.value) return null;
  const note = String(step.note ?? "").trim();
  if (NOT_A_RESULT_ROW_NOTE.test(note)) return null;
  const shown = shownTextOf(step);
  const keyed = rowKeyedTexts(step.selector);
  // A ROW SHOWS VALUES, A QUESTION ASKS: an attestation that merely mentions the owner ("I am the
  // owner, …?") is not a results row, so the identity reading is for short, question-free targets.
  if (identity && !/\?/.test(shown) && tokensOf(shown).length <= 12) {
    const byIdentity = identityRoleIn([shown, ...keyed].filter(Boolean).join(" | "), identity);
    if (byIdentity) return byIdentity;
  }
  if (keyed.length) {
    if (keyed.some(readsAsStreetAddress)) return "address";
    return CONTACT_NOTE.test(note) ? "contact" : null;
  }
  if (!shown) return null;
  if (readsAsStreetAddress(shown)) return "address";
  const control = controlIdentityWords(step);
  if (!LISTISH.test(control)) return null;
  const role = lastRoleWord(control) ?? lastRoleWord(String(step.fingerprint?.section ?? ""));
  if (!role) return null;
  if (isVolatileLabel(shown) && !carriesDate(shown)) return role;
  // A NAME IN AN OWNER LIST IS THE LEARN PROPERTY'S OWNER — an owner list shows nothing else. Not in a
  // contact list: its rows also show a contact's TYPE ("Associated Contact", Corvallis' Select from
  // Account), which is the portal's word, not anybody's data; a contact row needs the learn company's
  // identity or a note naming the company's record.
  if (role === "owner" && readsAsName(shown)) return role;
  return null;
}

/** The note a results-row pick is recorded with — no learn value in it. "address row:" is the wording
 *  replay has routed to its address matcher since the generic results-row pass. */
export const ROW_ROLE_NOTE: Readonly<Record<ResultRowRole, string>> = {
  address: "address row: pick the search result matching this project's address",
  parcel: "parcel row: pick the search result matching this project's parcel number",
  owner: "owner row: pick the search result matching this project's property owner",
  licence: "licence row: pick the search result matching the filing company's licence number",
  contact: "contact row: pick the filing company's own record",
};
/** The marker a results-row pick's selector carries: it exists only during a learn click, so a replay
 *  can never resolve it and always reaches the row picker (the generic results-row pass's precedent). */
export const RESULT_ROW_MARKER_CSS = '[data-al-resultrow="1"]';

/** The recorded control's own id, when a level names one ("#x" / [id="x"]) or the fingerprint does. */
function recordedIdOf(step: RecipeStep): string {
  for (const lvl of [step.selector, ...(step.selector?.fallbacks ?? [])]) {
    const m = /^(?:#([\w$:.-]+)|\[id="([^"]+)"\])$/.exec(String(lvl?.css ?? "").trim());
    if (m) return m[1] || m[2];
  }
  return String((step.fingerprint as StepFingerprint | undefined)?.id ?? "");
}
const frameOf = (step: RecipeStep): string | undefined =>
  step.selector?.frame || step.selector?.fallbacks?.find((f) => f.frame)?.frame || undefined;
/** What a level SAYS: its label / name / text / placeholder and the quoted texts inside its css (a
 *  :has-text("…") or [title="…"]) — never the css's ids and class names, whose digits are not data. */
const levelText = (lvl: RecipeSelector | undefined): string =>
  [lvl?.label, lvl?.name, lvl?.text, lvl?.placeholder,
    ...Array.from(String(lvl?.css ?? "").matchAll(/(?::has-text\(\s*|\[(?:title|value|aria-label|alt|placeholder)\s*[*^$|~]?=\s*)["']([^"']{2,})["']/gi), (m) => m[1])]
    .filter(Boolean).join(" | ");

/**
 * THE LEARNER'S LAST PASS: no step leaves a walk with the learn job's data or a date in its selector.
 *   - A results-row pick becomes a ROW ROLE: the marker selector, the role, a note with no learn value,
 *     and the fingerprint (its id is kept only so replay can find the GRID — never the row).
 *   - A level whose label / name / text carries a date is replaced by the control's own id (the label
 *     was the date printed beside the box, not its name); the note keeps the caption, date stood in.
 *   - Any other level carrying a learn value is dropped when another level remains.
 * Returns the steps and, per change, why (for the run's debug bundle).
 */
export function withoutLearnDataInSelectors(steps: RecipeStep[], identity: LearnIdentity): { steps: RecipeStep[]; changed: string[] } {
  const changed: string[] = [];
  const out = (steps ?? []).map((step, i) => {
    if (!step || !step.selector || step.action === "goto") return step;
    const role = resultRowRoleOf(step, identity);
    if (role && !step.rowRole) {
      const frame = frameOf(step);
      const fp = step.fingerprint;
      const fingerprint: StepFingerprint = {};
      if (fp?.id) fingerprint.id = fp.id;
      if (fp?.name) fingerprint.name = fp.name;
      if (fp?.section && !carriesLearnData(fp.section, identity)) fingerprint.section = fp.section;
      if (!fingerprint.id) { const id = recordedIdOf(step); if (id) fingerprint.id = id; }
      const next: RecipeStep = {
        action: step.action,
        ...(step.phase ? { phase: step.phase } : {}),
        selector: { css: RESULT_ROW_MARKER_CSS, ...(frame ? { frame } : {}) },
        rowRole: role,
        note: ROW_ROLE_NOTE[role],
        ...(step.optional ? { optional: true } : {}),
        ...(Object.keys(fingerprint).length ? { fingerprint } : {}),
      };
      changed.push(`step ${i}: recorded as a results row, role ${role} (the learn job's row content and position dropped)`);
      return next;
    }
    const sel = step.selector;
    const levels: RecipeSelector[] = [{ ...sel, fallbacks: undefined }, ...(sel.fallbacks ?? []).map((f) => ({ ...f, fallbacks: undefined }))];
    const dated = levels.map((l) => carriesDate([l.label, l.name, l.text].filter(Boolean).join(" ")));
    const learned = levels.map((l) => identityRoleIn(levelText(l), identity) !== null);
    if (!dated.some(Boolean) && !learned.some(Boolean)) return step;
    const frame = frameOf(step);
    const clean = levels.filter((_l, k) => !dated[k] && !learned[k]);
    const id = dated.some(Boolean) ? recordedIdOf(step) : "";
    let primary: RecipeSelector | null = null;
    let rest: RecipeSelector[] = clean;
    if (id) {
      primary = { css: `[id="${id.replace(/["\\]/g, "\\$&")}"]` };
      rest = clean.filter((l) => recordedIdOf({ action: step.action, selector: l } as RecipeStep) !== id);
    } else if (clean.length) {
      [primary, ...rest] = clean;
    }
    if (!primary) {
      changed.push(`step ${i}: carries learn data or a date in every selector level and names no id — left as recorded, re-record it`);
      return step;
    }
    const nextSel: RecipeSelector = { ...primary, ...(frame ? { frame } : {}) };
    if (rest.length) nextSel.fallbacks = rest.map((l) => ({ ...l, ...(frame ? { frame } : {}) }));
    const next: RecipeStep = { ...step, selector: nextSel };
    if (step.note && carriesDate(step.note)) next.note = withDateStandIn(step.note);
    changed.push(`step ${i}: ${dated.some(Boolean) ? "a date in the label replaced by the control's own id" : "a level carrying the learn job's data dropped"}`);
    return next;
  });
  return { steps: out, changed };
}
