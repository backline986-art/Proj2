// ---------------------------------------------------------------------------------------------
// THE BATTERY (ESS) REVIEW, THE WAY THE AHJ DOES IT (review-audit draft 05).
//
// The whole storage review used to be one keyword check (city.ess.details-missing): a warning when a
// package mentioned a battery and none of "clearance / working space / 706 / R328 / 1207 / NFPA 855 /
// fire separation" appeared anywhere. Any one of those words cleared it, and nothing read the facts a
// plans examiner checks. This module reads them and compares them with the rules.
//
// THE FACTS (readEssFacts), deterministic, label- and unit-anchored like the other readers, from the
// package's own sheets and spec sheets (sheet = document-stated) and the parser's fields (derived):
//   unit count, kWh per unit, aggregate kWh, the location class (garage / accessory structure /
//   exterior wall / outdoors / utility space / habitable room), spacing between units, distance to
//   doors and windows, UL 9540 / UL 9540A named, the residential-dwelling marking, the ESS
//   disconnecting means and whether it (or its remote control) is outside, its marking, vehicle-impact
//   protection, smoke / heat alarm, wall protection. Unknown stays unknown — never a pass.
// A sentence that states a REQUIREMENT ("ESS SHALL NOT BE INSTALLED IN SLEEPING ROOMS", a copied code
// note) is never read as the job's quantity or location: those come only from statements of fact.
//
// THE RULES (resolveEssRules): the model-code baseline (shared/src/essRules.ts, the strictest model
// requirement) everywhere; a jurisdiction's own value from its code profile's essRules where a person
// verified it or it was read on the authority's official page (#683). A seeded value is applied only
// where it is stricter than the baseline. Keyed to the adopted editions: the IRC section is the
// adopted cycle's, and a 2017-or-earlier NEC drops the "disconnect outside" rule.
//
// THE FINDINGS:
//   - a stated fact that breaks a rule -> a MEASURED finding (reviewerVision.MEASURED_FINDING_IDS: a
//     picture of the sheet never relaxes arithmetic). WARNING by default; BLOCKER only when the rule
//     is the jurisdiction's, person-verified or official, its citation names the source, gives the URL
//     and quotes the value (Helm's #637 bar), AND the fact is stated on the package's own sheets,
//     unambiguously. A model-code baseline or a parser reading alone never blocks a filing;
//   - every fact the rules need that the package does not state -> ONE warning, "ESS detail not
//     shown: …", listing them (city.ess.details-missing, the id the keyword check had).
//
// Universal: nothing here names a utility, a portal, a city or a state; product names appear only as
// storage words a sheet uses. Read-only.
// ---------------------------------------------------------------------------------------------

import type { CodeReference, EssLocationClass, JurisdictionEssRules, ProjectRecord, ReviewerFinding, ReviewerFindingEvidence } from "../../shared/src/types";
import { essModelDefaults, essRuleStricter, type EssRuleKey } from "../../shared/src/essRules";
import { officialCitationFor, quoteNamesValue, sourceHostOf } from "../../shared/src/officialSource";
import type { EffectiveCodeContext } from "./codeProfiles";
import { packageReadSources, PARSED_FIELDS_SOURCE, residentialCodeRef, type DesignTextSource } from "./designCriteria";
import { adoptedNecEdition } from "./necEditions";
import { codeFamilyOf, modelBaseOf } from "./codeFamilies";

export const ESS_DETAILS_MISSING_ID = "city.ess.details-missing";
export const ESS_UNIT_RATING_OVER_ID = "city.ess.unit-rating-over";
export const ESS_AGGREGATE_OVER_ID = "city.ess.aggregate-rating-over";
export const ESS_LOCATION_NOT_PERMITTED_ID = "city.ess.location-not-permitted";
export const ESS_SPACING_UNDER_ID = "city.ess.unit-spacing-under";
export const ESS_OPENING_CLEARANCE_UNDER_ID = "city.ess.opening-clearance-under";
/** The comparisons of a stated value with a rule: vision may never relax them. */
export const ESS_MEASURED_FINDING_IDS: readonly string[] = [
  ESS_UNIT_RATING_OVER_ID, ESS_AGGREGATE_OVER_ID, ESS_LOCATION_NOT_PERMITTED_ID, ESS_SPACING_UNDER_ID, ESS_OPENING_CLEARANCE_UNDER_ID,
];

// --- the facts --------------------------------------------------------------------------------

export interface EssReading<T> {
  value: T;
  source: string;
  excerpt: string;
  /** Stated on the package's own sheets (a document, the sheet text) — not a parser field or summary. */
  sheet: boolean;
}

export interface EssFacts {
  unitCount: EssReading<number>[];
  unitKwh: EssReading<number>[];
  aggregateKwh: EssReading<number>[];
  locations: EssReading<EssLocationClass>[];
  spacingIn: EssReading<number>[];
  openingClearanceIn: EssReading<number>[];
  ul9540: EssReading<true> | null;
  ul9540A: EssReading<true> | null;
  residentialMarking: EssReading<true> | null;
  disconnect: EssReading<true> | null;
  disconnectOutside: EssReading<true> | null;
  disconnectLabel: EssReading<true> | null;
  impactProtection: EssReading<true> | null;
  alarm: EssReading<true> | null;
  wallProtection: EssReading<true> | null;
}

interface Source { label: string; text: string; sheet: boolean }

const STORAGE = /\b(?:batter(?:y|ies)|ESS|energy\s+storage|powerwalls?|encharge|storage\s+(?:units?|systems?|cabinets?))\b/i;
/** A sentence that states what the code requires, not what this job does. */
const REQUIREMENT_WORDING = /\b(?:shall|must|is\s+required|are\s+required|is\s+prohibited|are\s+prohibited|is\s+not\s+permitted|are\s+not\s+permitted|permitted\s+only)\b/i;
const NEGATED_BEFORE = /\b(?:no|not|never|without|none|except)\b[^.;]{0,25}$/i;
const NEGATED_AFTER = /^\s*[:–—-]?\s*\(?\s*(?:n\/a|none|not\s+(?:used|provided|shown|required|applicable|included)|no\b(?!\.\s*\d))/i;

const LENGTH = String.raw`(\d{1,3}(?:\.\d+)?)\s*(in(?:ch(?:es)?)?\b\.?|"|ft\b\.?|feet\b|foot\b|')`;
function inches(n: string, unit: string): number | null {
  const v = Number.parseFloat(n);
  if (!Number.isFinite(v)) return null;
  return /^(?:ft|feet|foot|')/i.test(unit.trim()) ? Math.round(v * 12 * 100) / 100 : v;
}

function sentences(text: string): string[] {
  return String(text || "").replace(/\s+/g, " ").split(/(?<=[.;])\s+(?!\d)/).map((s) => s.trim()).filter(Boolean);
}

function excerptOf(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index), Math.min(text.length, index + Math.max(length, 1))).trim().slice(0, 140);
}

function snap(project: ProjectRecord, key: string): string {
  const v = project.parserSnapshot?.[key];
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function positive(raw: string): number | null {
  if (!/^\s*\d+(?:\.\d+)?\s*(?:kwh)?\s*$/i.test(raw)) return null;
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The texts the reader takes: the package's (one source per document, sheet vs reading), never the
 *  splitter's page map (it prints "07 Battery / ESS specs: not detected" on every job). */
function readSources(project: ProjectRecord, documentTexts: DesignTextSource[]): Source[] {
  return packageReadSources(project, documentTexts)
    .filter((s) => s.label !== "Split page mapping")
    .map((s) => ({ label: s.label, text: s.text, sheet: s.sheet && !s.derived }));
}

const LOCATION_PATTERNS: Array<[EssLocationClass, RegExp]> = [
  ["habitable", /\b(?:bed\s*rooms?|sleeping\s+(?:rooms?|areas?)|living\s+(?:rooms?|areas?|spaces?)|habitable\s+(?:rooms?|spaces?|areas?)|family\s+rooms?|closets?\s+(?:off|opening\s+(?:in)?to|in)\s+(?:the\s+|a\s+)?(?:master\s+)?(?:bed\s*room|sleeping))\b/i],
  ["accessory", /\b(?:detached\s+(?:garage|structure|building|shop|carport)|accessory\s+(?:structure|building)|outbuilding|shed)\b/i],
  ["exteriorWall", /\b(?:exterior|outside|outdoor|external)\s+(?:wall|face\s+of\s+(?:the\s+)?(?:house|home|dwelling|residence|building))\b|\bwall[-\s]mounted\s+(?:outside|outdoors|on\s+(?:the\s+)?exterior)\b/i],
  ["utilitySpace", /\b(?:utility\s+(?:rooms?|closets?|spaces?|areas?)|basements?|storage\s+(?:rooms?|closets?|spaces?)|mechanical\s+(?:rooms?|closets?)|equipment\s+rooms?)\b/i],
  ["garage", /(?<!detached\s)\bgarages?\b/i],
  ["outdoor", /\b(?:installed|located|mounted|placed)\s+(?:outdoors|outside)\b(?!\s+(?:wall|face))|\boutdoors\b|\bon\s+(?:a\s+)?(?:concrete\s+)?(?:pad|slab)\b|\bground[-\s]mounted\s+(?:pad|enclosure|cabinet)\b/i],
];

/** The location classes a phrase names (an "ESS LOCATION:" value, a location field). */
export function classifyEssLocation(phrase: string): EssLocationClass[] {
  const out: EssLocationClass[] = [];
  for (const [cls, re] of LOCATION_PATTERNS) if (re.test(phrase)) out.push(cls);
  // "EXTERIOR WALL OF GARAGE" is the wall, not the garage interior.
  if (out.includes("exteriorWall") && out.includes("garage") && /\b(?:exterior|outside|outdoor|external)\s+wall\s+of\s+(?:the\s+)?garage\b/i.test(phrase)) out.splice(out.indexOf("garage"), 1);
  return out;
}

function affirmedHit(sources: Source[], re: RegExp, accept?: (sentence: string, m: RegExpExecArray) => boolean): EssReading<true> | null {
  let fallback: EssReading<true> | null = null;
  for (const s of sources) {
    for (const sentence of sentences(s.text)) {
      const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = g.exec(sentence))) {
        if (!m[0]) { g.lastIndex++; continue; }
        if (NEGATED_BEFORE.test(sentence.slice(Math.max(0, m.index - 30), m.index))) continue;
        if (NEGATED_AFTER.test(sentence.slice(m.index + m[0].length, m.index + m[0].length + 30))) continue;
        if (accept && !accept(sentence, m)) continue;
        const hit: EssReading<true> = { value: true, source: s.label, excerpt: excerptOf(sentence, m.index, m[0].length), sheet: s.sheet };
        if (s.sheet) return hit;
        fallback ??= hit;
      }
    }
  }
  return fallback;
}

const DISCONNECT = /\b(?:ESS|battery|energy\s+storage(?:\s+system)?|storage)\s+disconnect(?:ing\s+means|\s+switch)?\b|\b706\.15\b|\bdisconnect(?:ing\s+means|\s+switch)?\s+(?:for\s+(?:the\s+)?)?(?:ESS|batter(?:y|ies)|energy\s+storage)\b/i;
const OUTSIDE_OR_REMOTE = /\b(?:exterior|outside|outdoors?)\b|\bremote\s+(?:control|actuat\w*|switch|shut\s*down|initiat\w*|stop)\b/i;

export function readEssFacts(project: ProjectRecord, documentTexts: DesignTextSource[] = []): EssFacts {
  const sources = readSources(project, documentTexts);
  const facts: EssFacts = {
    unitCount: [], unitKwh: [], aggregateKwh: [], locations: [], spacingIn: [], openingClearanceIn: [],
    ul9540: null, ul9540A: null, residentialMarking: null, disconnect: null, disconnectOutside: null, disconnectLabel: null,
    impactProtection: null, alarm: null, wallProtection: null,
  };

  // Parser fields (a reading of the documents: never sheet-stated).
  const field = (label: string, excerpt: string) => ({ source: PARSED_FIELDS_SOURCE, excerpt: `${label}: ${excerpt}`, sheet: false });
  for (const key of ["batteryQty", "batteryQuantity"]) {
    const v = positive(snap(project, key));
    if (v != null && Number.isInteger(v)) { facts.unitCount.push({ value: v, ...field(key, snap(project, key)) }); break; }
  }
  for (const key of ["essKwh", "batteryCapacityKwh"]) {
    // QC's definition: the battery system's usable energy, ALL units together.
    const v = positive(snap(project, key));
    if (v != null) { facts.aggregateKwh.push({ value: v, ...field(key, snap(project, key)) }); break; }
  }
  const labelledLocations: EssReading<EssLocationClass>[] = [];
  for (const key of ["essLocation", "batteryLocation"]) {
    const raw = snap(project, key);
    for (const cls of raw ? classifyEssLocation(raw) : []) labelledLocations.push({ value: cls, ...field(key, raw) });
  }

  const contextual: EssReading<EssLocationClass>[] = [];
  for (const s of sources) {
    for (const sentence of sentences(s.text)) {
      const storage = STORAGE.test(sentence);
      const statesFact = !REQUIREMENT_WORDING.test(sentence);
      const at = (m: RegExpExecArray) => ({ source: s.label, excerpt: excerptOf(sentence, m.index, m[0].length), sheet: s.sheet });
      if (statesFact) {
        // "2 x 13.5 kWh", "(2) EXAMPLE BATTERY 13.5 KWH", "(2) … 27 KWH TOTAL".
        for (const m of sentence.matchAll(/\b(\d{1,2})\s*(?:x|×|@)\s*(\d{1,3}(?:\.\d+)?)\s*kwh\b/gi)) {
          facts.unitCount.push({ value: Number(m[1]), ...at(m as RegExpExecArray) });
          facts.unitKwh.push({ value: Number(m[2]), ...at(m as RegExpExecArray) });
        }
        for (const m of sentence.matchAll(/\((\d{1,2})\)\s*([^().;]{0,60}?)\b(\d{1,3}(?:\.\d+)?)\s*kwh\b(?!\s*(?:\/|per)\s*(?:yr|year|mo|month|day))(\s*(?:total|combined|aggregate))?/gi)) {
          if (!STORAGE.test(m[2]) && !STORAGE.test(sentence.slice(0, m.index ?? 0).slice(-40))) continue;
          facts.unitCount.push({ value: Number(m[1]), ...at(m as RegExpExecArray) });
          if (m[4]) facts.aggregateKwh.push({ value: Number(m[3]), ...at(m as RegExpExecArray) });
          else facts.unitKwh.push({ value: Number(m[3]), ...at(m as RegExpExecArray) });
        }
        if (storage && !/\b(?:annual|production|generation|offset|usage|consumption)\b|\/\s*(?:yr|year)/i.test(sentence)) {
          for (const m of sentence.matchAll(/\b(?:total|aggregate|combined)\b[^.;\d]{0,40}?(\d{1,3}(?:\.\d+)?)\s*kwh\b|\b(\d{1,3}(?:\.\d+)?)\s*kwh\s*(?:total|combined|aggregate)\b/gi)) {
            if (/^\(\d/.test(sentence.slice(Math.max(0, (m.index ?? 0) - 70), m.index ?? 0).match(/\(\d{1,2}\)[^()]*$/)?.[0] ?? "")) continue; // the paren form took it
            facts.aggregateKwh.push({ value: Number(m[1] ?? m[2]), ...at(m as RegExpExecArray) });
          }
          for (const m of sentence.matchAll(/\b(\d{1,3}(?:\.\d+)?)\s*kwh\s*(?:per\s+unit|each|ea\b\.?)/gi)) facts.unitKwh.push({ value: Number(m[1]), ...at(m as RegExpExecArray) });
          for (const m of sentence.matchAll(/\b(?:quantity|qty)\s*[:=]?\s*\(?(\d{1,2})\)?(?!\s*(?:kw|v|a)\b)/gi)) facts.unitCount.push({ value: Number(m[1]), ...at(m as RegExpExecArray) });
        }
        // "ESS LOCATION: GARAGE" — the label decides.
        for (const m of sentence.matchAll(/\b(?:ESS|battery|batteries|energy\s+storage(?:\s+system)?|storage)\s+(?:unit\s+|system\s+)?location\s*[:–—-]\s*([^.;]{1,60})/gi)) {
          for (const cls of classifyEssLocation(m[1])) labelledLocations.push({ value: cls, ...at(m as RegExpExecArray) });
        }
        // Otherwise a location word near a storage word in a sentence of fact.
        if (storage) {
          const storageAt = [...sentence.matchAll(new RegExp(STORAGE.source, "gi"))].map((m) => m.index ?? 0);
          for (const [cls, re] of LOCATION_PATTERNS) {
            for (const m of sentence.matchAll(new RegExp(re.source, "gi"))) {
              const i = m.index ?? 0;
              if (NEGATED_BEFORE.test(sentence.slice(Math.max(0, i - 30), i))) continue;
              if (!storageAt.some((j) => Math.abs(j - i) <= 80)) continue;
              if (cls === "garage" && /\b(?:exterior|outside|outdoor|external)\s+wall\s+of\s+(?:the\s+)?$/i.test(sentence.slice(Math.max(0, i - 30), i))) continue;
              contextual.push({ value: cls, ...at(m as RegExpExecArray) });
            }
          }
        }
        // Spacing between units.
        if (storage || /\bunits\b/i.test(sentence)) {
          for (const m of sentence.matchAll(new RegExp(String.raw`${LENGTH}\s*(?:min(?:imum)?\.?\s*)?(?:spacing|separation|apart|clear(?:ance)?\s+between)\b`, "gi"))) {
            const v = inches(m[1], m[2]); if (v != null) facts.spacingIn.push({ value: v, ...at(m as RegExpExecArray) });
          }
          for (const m of sentence.matchAll(new RegExp(String.raw`\b(?:spacing|separation|clearance)\s+between\s+(?:the\s+)?(?:units|batter(?:y|ies)|ESS(?:\s+units)?|cabinets)\s*(?:of\s+|is\s+|[:=]\s*)?(?:min(?:imum)?\.?\s*)?${LENGTH}`, "gi"))) {
            const v = inches(m[1], m[2]); if (v != null) facts.spacingIn.push({ value: v, ...at(m as RegExpExecArray) });
          }
          for (const m of sentence.matchAll(new RegExp(String.raw`\b(?:units|batter(?:y|ies)|ESS)\s+(?:spaced|separated)\s+(?:by\s+)?(?:a\s+min(?:imum)?\s+of\s+|at\s+least\s+)?${LENGTH}`, "gi"))) {
            const v = inches(m[1], m[2]); if (v != null) facts.spacingIn.push({ value: v, ...at(m as RegExpExecArray) });
          }
          if (storage) for (const m of sentence.matchAll(/\bside[-\s]by[-\s]side\b|\bstacked\b|\bzero\s+(?:clearance|spacing)\b/gi)) facts.spacingIn.push({ value: 0, ...at(m as RegExpExecArray) });
        }
        // Distance to doors and windows.
        for (const m of sentence.matchAll(new RegExp(String.raw`${LENGTH}\s*(?:min(?:imum)?\.?\s*)?(?:clear(?:ance)?\s+)?(?:from|to)\s+(?:any\s+|all\s+|the\s+|nearest\s+)?(?:operable\s+)?(?:doors?|windows?|openings?)\b`, "gi"))) {
          const v = inches(m[1], m[2]); if (v != null) facts.openingClearanceIn.push({ value: v, ...at(m as RegExpExecArray) });
        }
        for (const m of sentence.matchAll(new RegExp(String.raw`\b(?:doors?|windows?|openings?)(?:\s+(?:and|or|\/)\s+(?:doors?|windows?))?\s*(?:clearance|distance|separation)?\s*[:=]\s*${LENGTH}`, "gi"))) {
          const v = inches(m[1], m[2]); if (v != null) facts.openingClearanceIn.push({ value: v, ...at(m as RegExpExecArray) });
        }
      }
    }
  }
  facts.locations = labelledLocations.length ? labelledLocations : contextual;

  facts.ul9540 = affirmedHit(sources, /\bUL\s*-?\s*9540(?!\s*-?\s*A\b)\b/i);
  facts.ul9540A = affirmedHit(sources, /\bUL\s*-?\s*9540\s*-?\s*A\b/i);
  facts.residentialMarking = affirmedHit(sources, /\bfor\s+use\s+in\s+residential\s+dwelling\s+units?\b/i);
  facts.disconnect = affirmedHit(sources, DISCONNECT);
  facts.disconnectOutside = affirmedHit(sources, DISCONNECT, (sentence) => OUTSIDE_OR_REMOTE.test(sentence));
  facts.disconnectLabel = affirmedHit(sources, /\benergy\s+storage\s+system\s+disconnect\b/i)
    ?? affirmedHit(sources.filter((s) => /label/i.test(s.label)), DISCONNECT)
    ?? affirmedHit(sources, DISCONNECT, (sentence) => /\b(?:label(?:ed|led)?|placard|signage|sign|marking|marked)\b/i.test(sentence));
  facts.impactProtection = affirmedHit(sources, /\bbollards?\b|\b(?:vehicle|vehicular)\s+(?:impact|damage|barriers?|protection)\b|\bimpact\s+(?:protection|barriers?|guards?)\b|\bwheel\s+stops?\b|\bprotected\s+from\s+(?:vehicle|vehicular)\b|\bout\s+of\s+(?:the\s+)?(?:vehicle|parking|drive)\s+(?:path|area)\b/i);
  facts.alarm = affirmedHit(sources, /\bsmoke\s+(?:alarms?|detectors?)\b|\bheat\s+(?:alarms?|detectors?)\b/i);
  facts.wallProtection = affirmedHit(sources, /\btype\s*['"]?\s*x\b|\b5\/8\s*(?:"|in\.?|inch)?\s*(?:type\s*x\s*)?(?:gyp\w*|drywall|sheetrock|gwb)\b|\bgypsum\s+(?:wall)?board\b|\bdrywall\b|\bsheetrock\b|\bnon-?combustible\s+(?:walls?|surfaces?|construction|backing)\b|\bfinished\s+(?:walls?|ceilings?)\b|\bR\s*302\.6\b/i);
  return facts;
}

// --- the rules --------------------------------------------------------------------------------

export interface ResolvedEssRule<T extends number | boolean> {
  value: T;
  /** "model": the baseline. "jurisdiction": the jurisdiction's own value, applied. */
  origin: "model" | "jurisdiction";
  tier: "model" | "seeded" | "official" | "verified";
  /** May a finding resting on this rule block (Helm's #637 bar)? */
  blocks: boolean;
  /** The citation a jurisdiction value carries (or a seeded value not applied). */
  citation?: { label: string; sourceUrl: string; quote: string };
  /** Words for the finding: whose rule and how confirmed. */
  provenance: string;
  /** A seeded value on file that was NOT applied (it would relax the baseline). */
  unappliedSeeded?: T;
}

type ResolvedRules = { [K in EssRuleKey]-?: ResolvedEssRule<NonNullable<JurisdictionEssRules[K]>> };

function fieldTier(ctx: EffectiveCodeContext, key: EssRuleKey): { tier: "seeded" | "official" | "verified"; owner: string; host?: string; verifiedBy?: string } {
  const field = `essRules.${key}`;
  const src = ctx.profile?.fieldSources?.[field];
  const owner = (src ? src.ahj : ctx.profile?.ahj) || (src?.state || ctx.profile?.state || ctx.state || "the state");
  if (src) {
    if (src.confidence === "verified") return { tier: "verified", owner, verifiedBy: src.verifiedBy };
    if (src.confidence === "official") return { tier: "official", owner, host: src.officialSource?.host };
    return { tier: "seeded", owner };
  }
  if (ctx.profile?.confidence === "verified") return { tier: "verified", owner, verifiedBy: ctx.profile.verifiedBy };
  const official = ctx.profile ? officialCitationFor(ctx.profile.citations, field) : null;
  return official ? { tier: "official", owner, host: official.host } : { tier: "seeded", owner };
}

function citationOf(ctx: EffectiveCodeContext, key: EssRuleKey): { label: string; sourceUrl: string; quote: string } | undefined {
  const c = (ctx.profile?.citations ?? []).filter((x) => x && x.field === `essRules.${key}`).pop();
  return c ? { label: String(c.label || "").trim(), sourceUrl: String(c.sourceUrl || "").trim(), quote: String(c.quote || "").trim() } : undefined;
}

/** The #637 bar: the source named, its URL given, and its own words carrying the value. */
function meetsCitationBar(c: { label: string; sourceUrl: string; quote: string } | undefined, value: number | boolean): boolean {
  if (!c || !c.label || !sourceHostOf(c.sourceUrl) || c.quote.length < 3) return false;
  return typeof value === "number" ? quoteNamesValue(c.quote, value) : true;
}

/** Every ESS rule for this job's jurisdiction, with whose it is and whether it may block. */
export function resolveEssRules(ctx: EffectiveCodeContext | undefined): ResolvedRules {
  const nec = ctx?.profile?.adoptedCodes?.length ? adoptedNecEdition(ctx.adoptedCodes) : null;
  const defaults = essModelDefaults(nec);
  const out = {} as Record<EssRuleKey, ResolvedEssRule<number | boolean>>;
  for (const key of Object.keys(defaults) as EssRuleKey[]) {
    const base = defaults[key];
    const model: ResolvedEssRule<number | boolean> = { value: base, origin: "model", tier: "model", blocks: false, provenance: "the model-code baseline" };
    const own = ctx?.profile?.essRules?.[key];
    if (!ctx || own === undefined) { out[key] = model; continue; }
    const t = fieldTier(ctx, key);
    const citation = citationOf(ctx, key);
    const confirmed = t.tier === "verified" || t.tier === "official";
    const words = t.tier === "official"
      ? `${t.owner}'s rule (from ${t.host || "its official page"}, the jurisdiction's own official page)`
      : t.tier === "verified"
        ? `${t.owner}'s rule (human-verified${t.verifiedBy ? ` by ${t.verifiedBy}` : ""})`
        : `${t.owner}'s rule (seeded — researched/imported, not yet human-verified)`;
    if (confirmed) {
      out[key] = { value: own, origin: "jurisdiction", tier: t.tier, blocks: meetsCitationBar(citation, own), citation, provenance: words };
    } else if (essRuleStricter(key, own, base)) {
      // A seeded rule stricter than the baseline is applied (strictest wins) — and only warns.
      out[key] = { value: own, origin: "jurisdiction", tier: "seeded", blocks: false, citation, provenance: words };
    } else {
      out[key] = { ...model, ...(own !== base ? { unappliedSeeded: own, citation } : {}) };
    }
  }
  return out as unknown as ResolvedRules;
}

// --- the citations ----------------------------------------------------------------------------

/** The adopted residential code's year when the profile records one (IRC, or a state code built on it). */
function adoptedIrcEdition(ctx: EffectiveCodeContext | undefined): number | null {
  if (!ctx?.profile?.adoptedCodes?.length) return null;
  for (const c of ctx.adoptedCodes) {
    if (codeFamilyOf(c) !== "residential" && modelBaseOf(c) !== "IRC") continue;
    const year = String(c.basedOn || "").match(/\b(?:19|20)\d{2}\b/)?.[0] ?? String(c.edition || "").match(/\b(?:19|20)\d{2}\b/)?.[0];
    if (year) return Number(year);
  }
  return null;
}

function ircRef(ctx: EffectiveCodeContext | undefined, sub: string, title: string, note: string): CodeReference {
  // The 2018 IRC's storage section is R327 (stationary storage batteries, pointing at the IFC); the
  // 2021 cycle moved ESS to R328 with the kWh and location limits applied here as the baseline.
  const year = adoptedIrcEdition(ctx);
  const older = year != null && year < 2021;
  const section = older ? "R327" : `R328${sub}`;
  const fullNote = older
    ? `${note} The adopted ${year} IRC's storage section is R327 (it refers to the IFC); the 2021 IRC R328 limits are applied as the strictest model baseline.`
    : note;
  if (ctx) return residentialCodeRef(ctx, section, title, fullNote);
  return {
    code: "IRC", section, title,
    adoptionScope: "Model residential code; verify the locally adopted edition and amendments.",
    sourceUrl: "https://codes.iccsafe.org/content/IRC2021P1/chapter-3-building-planning",
    note: fullNote,
  };
}

function necRef(ctx: EffectiveCodeContext | undefined, section: string, title: string, note: string): CodeReference {
  const fallback: CodeReference = {
    code: "NEC", section, title,
    adoptionScope: "Energy storage systems; verify the locally adopted NEC edition.",
    sourceUrl: "https://www.nfpa.org/codes-and-standards/nfpa-70-standard-development/70",
    note,
  };
  return ctx ? ctx.citationFor("NEC", section, title, fallback) : fallback;
}

function ruleRef(rule: ResolvedEssRule<number | boolean>, title: string): CodeReference | null {
  if (rule.origin !== "jurisdiction") return null;
  return {
    code: "Jurisdiction ESS rule",
    section: rule.citation?.label || "(source not named)",
    title,
    adoptionScope: rule.provenance,
    sourceUrl: sourceHostOf(rule.citation?.sourceUrl ?? "") ? String(rule.citation?.sourceUrl) : "",
    note: rule.citation?.quote ? `"${rule.citation.quote}"` : "No verbatim quote on file: a finding on this rule only warns.",
  };
}

// --- the findings -----------------------------------------------------------------------------

const LOCATION_WORDS: Record<EssLocationClass, string> = {
  garage: "a garage",
  accessory: "a detached garage or accessory structure",
  exteriorWall: "an exterior wall",
  outdoor: "outdoors",
  utilitySpace: "a utility closet, basement or storage/utility space",
  habitable: "a sleeping or habitable room",
};
const AGGREGATE_KEY: Record<Exclude<EssLocationClass, "habitable">, EssRuleKey> = {
  garage: "maxAggregateKwhGarage",
  accessory: "maxAggregateKwhAccessory",
  exteriorWall: "maxAggregateKwhExteriorWall",
  outdoor: "maxAggregateKwhOutdoor",
  utilitySpace: "maxAggregateKwhUtilitySpace",
};

function evidenceOf(r: EssReading<unknown>, label: string): ReviewerFindingEvidence {
  const field = r.source === PARSED_FIELDS_SOURCE;
  return {
    kind: field ? "field_value" : "source_excerpt",
    label, source: r.source, excerpt: r.excerpt,
    confidence: r.sheet ? "high" : "medium",
    pageHint: "", screenshotPath: "",
    verifier: field ? "parser" : "rule_engine",
    note: r.sheet ? "Stated on the package's own sheet." : "A reading of the package (parser field or summary), not a sheet: it never blocks on its own.",
  };
}

/** The largest reading, and whether every reading agrees (one value). */
function largest(readings: EssReading<number>[]): { reading: EssReading<number>; unambiguous: boolean } | null {
  if (!readings.length) return null;
  const top = [...readings].sort((a, b) => b.value - a.value || Number(b.sheet) - Number(a.sheet))[0];
  return { reading: top, unambiguous: new Set(readings.map((r) => r.value)).size === 1 };
}
function smallest(readings: EssReading<number>[]): { reading: EssReading<number>; unambiguous: boolean } | null {
  if (!readings.length) return null;
  const low = [...readings].sort((a, b) => a.value - b.value || Number(b.sheet) - Number(a.sheet))[0];
  return { reading: low, unambiguous: new Set(readings.map((r) => r.value)).size === 1 };
}

function measured(input: {
  id: string; title: string; message: string; cityFeedback: string; designTeamAction: string;
  rule: ResolvedEssRule<number | boolean>; sheetStated: boolean; refs: CodeReference[]; evidence: ReviewerFindingEvidence[];
}): ReviewerFinding {
  const block = input.rule.blocks && input.sheetStated;
  const why = block
    ? ` This is ${input.rule.provenance}, cited verbatim, and the value is stated on the package's own sheets.`
    : input.rule.origin === "model"
      ? " The limit is the model-code baseline: a warning until the jurisdiction's own cited rule is on file."
      : !input.rule.blocks
        ? ` The limit is ${input.rule.provenance}; without a named source, URL and verbatim quote of the value it only warns.`
        : " The value is not stated unambiguously on the package's own sheets, so it only warns.";
  const ref = ruleRef(input.rule, input.title);
  return {
    id: input.id,
    severity: block ? "blocker" : "warning",
    category: "electrical",
    title: input.title,
    message: `${input.message}${why}`,
    cityFeedback: input.cityFeedback,
    designTeamAction: input.designTeamAction,
    evidenceNeeded: input.evidence.map((e) => `${e.label}: ${e.excerpt} (${e.source})`),
    codeReferences: [...(ref ? [ref] : []), ...input.refs],
    installerCallout: true,
    evidenceFound: input.evidence,
  };
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100);
const inchesWords = (n: number): string => (n % 12 === 0 && n > 0 ? `${n / 12} ft (${fmt(n)} in)` : `${fmt(n)} in`);

/**
 * The ESS review for a job WITH storage (the caller decides that). `ctx` absent: the model-code
 * baseline only, cited generically.
 */
export function evaluateEssFindings(project: ProjectRecord, ctx: EffectiveCodeContext | undefined, documentTexts: DesignTextSource[] = []): ReviewerFinding[] {
  const facts = readEssFacts(project, documentTexts);
  const rules = resolveEssRules(ctx);
  const out: ReviewerFinding[] = [];
  const missing: string[] = [];
  const jurisdiction = ctx?.ahj || ctx?.state || "the jurisdiction";

  // Count and ratings: derive what the package implies when it states only part of it.
  const count = largest(facts.unitCount);
  let unit = largest(facts.unitKwh);
  let aggregate = largest(facts.aggregateKwh);
  if (!unit && aggregate && count && count.reading.value > 0) {
    const value = Math.round((aggregate.reading.value / count.reading.value) * 100) / 100;
    unit = { reading: { value, source: `${aggregate.reading.source} ÷ ${count.reading.source}`, excerpt: `${fmt(aggregate.reading.value)} kWh ÷ ${count.reading.value} units`, sheet: aggregate.reading.sheet && count.reading.sheet }, unambiguous: aggregate.unambiguous && count.unambiguous };
  }
  if (!aggregate && unit && count) {
    const value = Math.round(unit.reading.value * count.reading.value * 100) / 100;
    aggregate = { reading: { value, source: `${count.reading.source} × ${unit.reading.source}`, excerpt: `${count.reading.value} × ${fmt(unit.reading.value)} kWh`, sheet: unit.reading.sheet && count.reading.sheet }, unambiguous: unit.unambiguous && count.unambiguous };
  }
  const classes = [...new Set(facts.locations.map((l) => l.value))];
  const exempt = rules.listedResidentialExemption.value === true && !!facts.ul9540 && !!facts.residentialMarking;

  // 1. The listing.
  if (rules.listingRequired.value && !facts.ul9540) missing.push("UL 9540 listing of the ESS (the spec sheet or equipment schedule naming it)");

  // 2. One unit's rating.
  if (!unit) missing.push("Energy rating of each battery unit (kWh) and the number of units");
  else if (!exempt && unit.reading.value > rules.maxUnitKwh.value) {
    out.push(measured({
      id: ESS_UNIT_RATING_OVER_ID,
      title: "Battery/ESS unit rating over the residential limit",
      message: `Each ESS unit is ${fmt(unit.reading.value)} kWh; the limit for one unit is ${fmt(rules.maxUnitKwh.value)} kWh. Larger units go under the fire code's ESS provisions (IFC 1207) rather than the residential section.`,
      cityFeedback: `Individual ESS units are limited to ${fmt(rules.maxUnitKwh.value)} kWh. Revise the equipment or show compliance with the fire code's ESS provisions (IFC 1207.1 through 1207.9).`,
      designTeamAction: "Confirm the per-unit kWh rating on the spec sheet; choose units within the limit or prepare the IFC 1207 compliance package.",
      rule: rules.maxUnitKwh, sheetStated: unit.reading.sheet && unit.unambiguous,
      refs: [ircRef(ctx, ".5", "Energy ratings of ESS units", "Individual ESS units have a maximum rating of 20 kWh in the 2021 model.")],
      evidence: [evidenceOf(unit.reading, "ESS unit rating")],
    }));
  }

  // 3. Location: where it is, whether it may be there, and the aggregate there.
  if (!classes.length) {
    missing.push("ESS location (garage, exterior wall, outdoors, utility closet/basement…) — it decides the aggregate kWh limit and the protection required");
  } else {
    const habitable = facts.locations.find((l) => l.value === "habitable");
    if (habitable && rules.habitableLocationProhibited.value) {
      out.push(measured({
        id: ESS_LOCATION_NOT_PERMITTED_ID,
        title: "Battery/ESS location not permitted",
        message: "The plans place the ESS in a sleeping or habitable room (or a space opening into one), where the residential code permits no ESS.",
        cityFeedback: "ESS may not be installed in sleeping rooms, closets or spaces opening directly into sleeping rooms, or habitable spaces. Relocate it and show the new location.",
        designTeamAction: "Move the ESS to a permitted location (garage, exterior wall, outdoors, utility space) and revise the site plan.",
        rule: rules.habitableLocationProhibited, sheetStated: habitable.sheet && classes.length === 1,
        refs: [ircRef(ctx, ".4", "ESS locations", "ESS are not permitted in sleeping rooms, spaces opening into them, or habitable spaces in the 2021 model.")],
        evidence: [evidenceOf(habitable, "ESS location")],
      }));
    }
    const placed = classes.filter((c): c is Exclude<EssLocationClass, "habitable"> => c !== "habitable");
    if (!exempt && aggregate && placed.length) {
      // Several locations read: the strictest of their limits (the units' split is not stated).
      const limited = placed.map((c) => ({ cls: c, rule: rules[AGGREGATE_KEY[c]] })).sort((a, b) => Number(a.rule.value) - Number(b.rule.value))[0];
      if (aggregate.reading.value > Number(limited.rule.value)) {
        out.push(measured({
          id: ESS_AGGREGATE_OVER_ID,
          title: "Battery/ESS aggregate rating over the limit for its location",
          message: `The ESS totals ${fmt(aggregate.reading.value)} kWh in ${LOCATION_WORDS[limited.cls]}; the aggregate limit there is ${fmt(Number(limited.rule.value))} kWh.${placed.length > 1 ? ` The plans name more than one location (${placed.map((c) => LOCATION_WORDS[c]).join(", ")}), so the strictest limit is used.` : ""}`,
          cityFeedback: `The aggregate ESS rating in ${LOCATION_WORDS[limited.cls]} is limited to ${fmt(Number(limited.rule.value))} kWh. Reduce the storage, split it between permitted locations with their own limits, or show compliance with IFC 1207.`,
          designTeamAction: "State the kWh in each location, and keep each location within its limit.",
          rule: limited.rule, sheetStated: aggregate.reading.sheet && aggregate.unambiguous && placed.length === 1,
          refs: [ircRef(ctx, ".5", "Aggregate ESS ratings by location", "2021 model: 40 kWh in utility closets, basements and storage or utility spaces; 80 kWh in garages, accessory structures, on exterior walls and outdoors.")],
          evidence: [evidenceOf(aggregate.reading, "ESS aggregate rating"), ...facts.locations.filter((l) => l.value === limited.cls).slice(0, 1).map((l) => evidenceOf(l, "ESS location"))],
        }));
      }
    }
    const indoor = classes.some((c) => c === "garage" || c === "utilitySpace");
    if (classes.includes("garage") && rules.impactProtectionInGarage.value && !facts.impactProtection) missing.push("Vehicle-impact protection for the garage ESS (bollards, barrier, or mounting out of the vehicle path)");
    if (indoor && rules.alarmRequired.value && !facts.alarm) missing.push("Smoke alarm (or a heat detector interconnected to the smoke alarms) in the room or garage where the ESS is installed");
    if (indoor && rules.wallProtectionRequired.value && !facts.wallProtection) missing.push(classes.includes("utilitySpace")
      ? "Wall and ceiling finish at the ESS (finished or noncombustible; 5/8\" Type X gypsum on unfinished wood framing)"
      : "Garage-to-dwelling separation at the ESS (the residential code's garage separation; 5/8\" Type X gypsum on unfinished wood framing)");
    if (classes.some((c) => c === "exteriorWall" || c === "outdoor")) {
      const near = smallest(facts.openingClearanceIn);
      if (!near) missing.push(`Distance from the outdoor / exterior-wall ESS to doors and windows into the dwelling (${inchesWords(rules.minOpeningClearanceIn.value)} or more)`);
      else if (near.reading.value < rules.minOpeningClearanceIn.value) {
        out.push(measured({
          id: ESS_OPENING_CLEARANCE_UNDER_ID,
          title: "Battery/ESS too close to doors or windows",
          message: `The outdoor / exterior-wall ESS is ${inchesWords(near.reading.value)} from a door or window into the dwelling; the least distance is ${inchesWords(rules.minOpeningClearanceIn.value)}.`,
          cityFeedback: `Locate the ESS at least ${inchesWords(rules.minOpeningClearanceIn.value)} from doors and windows directly entering the dwelling, and dimension it on the site plan.`,
          designTeamAction: "Relocate the ESS and dimension its distance to the nearest door and window.",
          rule: rules.minOpeningClearanceIn, sheetStated: near.reading.sheet && near.unambiguous,
          refs: [ircRef(ctx, ".4", "ESS locations: distance to doors and windows", "Outdoor and exterior-wall ESS are not less than 3 ft from doors and windows directly entering the dwelling in the 2021 model.")],
          evidence: [evidenceOf(near.reading, "Distance to doors/windows")],
        }));
      }
    }
  }

  // 4. Spacing between units.
  if (count && count.reading.value > 1 && !exempt) {
    const reduction = rules.spacingReductionBy9540A.value === true && !!facts.ul9540A;
    const gap = smallest(facts.spacingIn);
    if (!gap) {
      if (!reduction) missing.push(facts.ul9540A
        ? `Spacing between ESS units: UL 9540A is named, but ${jurisdiction} has no rule on file accepting less than ${inchesWords(rules.minUnitSpacingIn.value)} on it — show the spacing, or confirm the AHJ accepts the test basis`
        : `Spacing between ESS units (${inchesWords(rules.minUnitSpacingIn.value)}, or the UL 9540A large-scale fire test basis for less)`);
    } else if (gap.reading.value < rules.minUnitSpacingIn.value && !reduction) {
      out.push(measured({
        id: ESS_SPACING_UNDER_ID,
        title: "Battery/ESS units closer than the required spacing",
        message: `ESS units are ${inchesWords(gap.reading.value)} apart; the required spacing is ${inchesWords(rules.minUnitSpacingIn.value)}.${facts.ul9540A ? ` UL 9540A is named, but ${jurisdiction} has no rule on file accepting reduced spacing on large-scale fire testing.` : " Less is allowed only where large-scale fire testing (UL 9540A) supports it and the AHJ accepts it."}`,
        cityFeedback: `Separate ESS units by at least ${inchesWords(rules.minUnitSpacingIn.value)}, or provide the UL 9540A large-scale fire test report supporting the reduced spacing.`,
        designTeamAction: "Respace the units, or attach the manufacturer's UL 9540A report and confirm the AHJ accepts it.",
        rule: facts.ul9540A ? rules.spacingReductionBy9540A : rules.minUnitSpacingIn, sheetStated: gap.reading.sheet && gap.unambiguous,
        refs: [ircRef(ctx, ".4", "Spacing between ESS units", "ESS units are separated by 3 ft unless large-scale fire testing documents a smaller distance in the 2021 model.")],
        evidence: [evidenceOf(gap.reading, "Spacing between units")],
      }));
    }
  }

  // 5. The disconnecting means.
  if (!facts.disconnect) missing.push("ESS disconnecting means (NEC 706.15) on the SLD");
  else {
    if (rules.disconnectOutside.value && !facts.disconnectOutside) missing.push("Location of the ESS disconnect, or its remote control, at a readily accessible place outside the dwelling (NEC 706.15(A))");
    if (!facts.disconnectLabel) missing.push("Marking of the ESS disconnecting means (\"ENERGY STORAGE SYSTEM DISCONNECT\", with its nominal voltage) on the labels sheet");
  }

  if (missing.length) {
    const necNote = "Disconnecting means for the ESS; for one- and two-family dwellings the 2020 and later NEC put it, or its remote control, outside the building.";
    out.push({
      id: ESS_DETAILS_MISSING_ID,
      severity: "warning",
      category: "electrical",
      title: "Battery/ESS detail not reviewable",
      message: `ESS detail not shown: ${missing.join("; ")}.`,
      cityFeedback: "Provide the ESS details the residential code and NEC 706 review: listing, per-unit and total kWh, location on the site plan, spacing, protection, alarm and the disconnecting means with its marking.",
      designTeamAction: "Add an ESS detail sheet (or notes on the site plan and SLD) stating each item listed, and attach the ESS spec sheet.",
      evidenceNeeded: missing,
      codeReferences: [
        ircRef(ctx, "", "Energy storage systems", "Listing, location, ratings, spacing, fire detection and impact protection for residential ESS."),
        necRef(ctx, "706.15", "ESS disconnecting means", necNote),
      ],
      installerCallout: true,
    });
  }
  return out;
}
