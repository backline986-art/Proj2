// ---------------------------------------------------------------------------------------------
// FIRE ACCESS, READ THE WAY THE AHJ READS IT (review-audit draft 08).
//
// designCriteria.ts measures the roof plan's pathway widths and ridge setback against the AHJ's
// rules or the model-code default. Three things it did not read are read here, as FACTS the
// requirement and the findings use:
//
//   ROOF COVERAGE  — the model code (IRC R324.6.2 / IFC 605.11.3.2.3 and its successors) asks for an
//                    18 in ridge setback where the array covers no more than 33% of the plan-view
//                    roof (66% where the dwelling has an automatic sprinkler system), 36 in above.
//                    Read from the plan's own statement of coverage, or array area / roof area where
//                    the plan states both. Unknown → the requirement takes the stricter 36 in and
//                    says coverage is not stated (strictest default; designCriteria.requiredRoofPlanDimensions).
//   SPRINKLERS     — only a STATEMENT OF FACT about this dwelling ("DWELLING IS EQUIPPED WITH AN NFPA
//                    13D SPRINKLER SYSTEM", "FIRE SPRINKLERS: YES"). A copied code note ("66% for
//                    sprinklered buildings") never counts: it would relax the setback on a claim
//                    nobody made.
//   EMERGENCY ESCAPE AND RESCUE OPENINGS (R324.6) — no modules on the roof below an EERO, and a 36 in
//                    pathway to it. A plan that places modules below one with no 36 in path → a
//                    warning; a plan silent on EEROs → one callout asking the designer to confirm.
//   THE AHJ'S ALTERNATIVE POLICY — typed data on its code profile (firePathwayPolicy). APPLIED (it
//                    replaces the model-code numbers) only when its row is person-verified and the
//                    policy names its page, or it was read on the authority's official page (#683).
//                    A seeded policy is shown as a callout and the model code applies.
//
// Universal: nothing here names a utility, a portal, a city or a state. Read-only, no LLM.
// ---------------------------------------------------------------------------------------------

import type { CodeReference, FireAccessFacts, JurisdictionFirePathwayPolicy, ProjectRecord, ReviewerFinding, RoofCoverageReading } from "../../shared/src/types";
import { officialCitationFor } from "../../shared/src/officialSource";
import { describePolicy } from "../../shared/src/firePathwayPolicy";
import type { EffectiveCodeContext } from "./codeProfiles";
import { packageReadSources, residentialCodeRef, type DesignTextSource } from "./designCriteria";

export const FIRE_EERO_OBSTRUCTED_ID = "city.fire.eero-obstructed";
export const FIRE_EERO_UNCONFIRMED_ID = "city.fire.eero-unconfirmed";
export const FIRE_POLICY_UNAPPLIED_ID = "city.fire.alt-pathway-policy-unverified";


const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`;
const SQFT = String.raw`(?:sq\.?\s*f(?:ee)?t\.?|sqft|s\.?f\.?(?![a-z])|ft\s*(?:²|\^?2))`;
const toNum = (raw: string): number => Number(String(raw).replace(/,/g, ""));
const clip = (text: string, start: number, end: number): string => text.slice(Math.max(0, start), Math.min(text.length, end)).trim().slice(0, 140);

/** Split into clauses on sentence ends and line breaks (a percentage's own "." never splits). */
function clauses(text: string, commas = false): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  const re = commas ? /[^.;,\n]+(?:\.(?=\d)[^.;,\n]*)*/g : /[^.;\n]+(?:\.(?=\d)[^.;\n]*)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (m[0].trim()) out.push({ text: m[0], at: m.index });
  return out;
}

/** A clause that states a REQUIREMENT or quotes the code, not a fact about this job. */
const REQUIREMENT_WORDS = /\b(?:shall|must|required?|where|when|if|unless|per\s+(?:IRC|IFC|code)|R324|605\.11|1204|1205)\b/i;

// ── Roof coverage ──────────────────────────────────────────────────────────────────────────────

const COVERAGE_LABEL = String.raw`(?:(?:pv|solar|array|module|panel)\s+)?(?:roof\s+)?coverage|%\s*(?:of\s+)?(?:total\s+)?roof(?:\s+area)?(?:\s+covered)?|percent(?:age)?\s+of\s+(?:the\s+)?(?:total\s+)?roof(?:\s+area)?(?:\s+covered)?`;
const COVERAGE_LABEL_FIRST = new RegExp(String.raw`\b(?:${COVERAGE_LABEL})\s*(?:\(plan\s+view\))?\s*[:=]?\s*${NUM}\s*%`, "gi");
const COVERAGE_VALUE_FIRST = new RegExp(String.raw`${NUM}\s*%\s*(?:of\s+(?:the\s+)?(?:total\s+)?(?:plan[-\s]view\s+)?roof(?:\s+area)?|roof\s+coverage|coverage)\b`, "gi");
const ARRAY_AREA = new RegExp(String.raw`\b(total\s+)?(?:pv\s+|solar\s+|module\s+)?array\s+area\s*(?:\(plan\s+view\))?\s*[:=]?\s*${NUM}\s*${SQFT}`, "gi");
const ROOF_AREA = new RegExp(String.raw`\b(total\s+)?(?:plan[-\s]view\s+)?roof\s+area\s*(?:\(plan\s+view\))?\s*[:=]?\s*${NUM}\s*${SQFT}`, "gi");
const MODULE_DIMS = new RegExp(String.raw`\b(?:module|panel)\s+(?:dimensions?|dims?|size)\s*[:=]?\s*${NUM}\s*(mm|in(?:ches)?|"|”)?\s*[x×]\s*${NUM}\s*(mm|in(?:ches)?|"|”)`, "gi");

interface Stated { value: number; total: boolean; source: string; excerpt: string }

/** One value per label: a TOTAL-labelled one wins; otherwise one distinct value, else ambiguous (null). */
function oneValue(found: Stated[]): Stated | null {
  const totals = found.filter((f) => f.total);
  const pool = totals.length ? totals : found;
  const distinct = [...new Set(pool.map((f) => f.value))];
  return distinct.length === 1 ? pool[0] : null;
}

function collect(re: RegExp, sources: DesignTextSource[], valueGroup: number, totalGroup?: number): Stated[] {
  const out: Stated[] = [];
  for (const s of sources) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s.text))) {
      const value = toNum(m[valueGroup]);
      if (!Number.isFinite(value) || value <= 0) continue;
      out.push({ value, total: totalGroup ? Boolean(m[totalGroup]) : false, source: s.label, excerpt: clip(s.text, m.index, m.index + m[0].length) });
    }
  }
  return out;
}

/** The array's plan-view area the package states (or modules x the module's stated size). */
export function readArrayAreaSqFt(project: ProjectRecord, sources: DesignTextSource[]): Stated | null {
  const stated = oneValue(collect(ARRAY_AREA, sources, 2, 1));
  if (stated) return stated;
  const qty = Number(String((project.parserSnapshot as Record<string, unknown> | undefined)?.moduleQty ?? "").replace(/,/g, ""));
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const dims: Stated[] = [];
  for (const s of sources) {
    MODULE_DIMS.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MODULE_DIMS.exec(s.text))) {
      const unitA = (m[2] || m[4] || "").toLowerCase();
      const unitB = (m[4] || unitA).toLowerCase();
      const toFt = (v: number, u: string): number => (u === "mm" ? v / 304.8 : v / 12);
      const a = toFt(toNum(m[1]), unitA);
      const b = toFt(toNum(m[3]), unitB);
      // A module is roughly 2-3 ft by 3-8 ft: anything else is not a module's face.
      if (!(a > 1.5 && a < 8.5 && b > 1.5 && b < 8.5)) continue;
      dims.push({ value: Math.round(a * b * qty * 10) / 10, total: false, source: s.label, excerpt: `${qty} modules x ${clip(s.text, m.index, m.index + m[0].length)}` });
    }
  }
  return oneValue(dims);
}

/**
 * How much of the plan-view roof the array covers: the plan's own percentage, or array area / roof
 * area where both are stated. When both ways read, the LARGER coverage (the stricter setback). Null
 * when the package states neither — the requirement then takes 36 in and says so.
 */
export function readRoofCoverage(project: ProjectRecord, sources: DesignTextSource[]): RoofCoverageReading | null {
  const readings: RoofCoverageReading[] = [];
  const pcts = [...collect(COVERAGE_LABEL_FIRST, sources, 1), ...collect(COVERAGE_VALUE_FIRST, sources, 1)].filter((p) => p.value <= 100);
  const distinct = [...new Set(pcts.map((p) => p.value))];
  if (distinct.length) {
    // Several stated percentages (per plane and total): the largest is the strict reading.
    const max = Math.max(...distinct);
    const p = pcts.find((x) => x.value === max)!;
    readings.push({ pct: max, basis: "stated", source: p.source, excerpt: p.excerpt });
  }
  const array = readArrayAreaSqFt(project, sources);
  const roof = oneValue(collect(ROOF_AREA, sources, 2, 1));
  if (array && roof && roof.value > 0 && array.value <= roof.value) {
    const pct = Math.round((array.value / roof.value) * 1000) / 10;
    readings.push({ pct, basis: "areas", source: array.source === roof.source ? array.source : `${array.source}; ${roof.source}`, excerpt: `${array.excerpt} / ${roof.excerpt}` });
  }
  if (!readings.length) return null;
  return readings.reduce((a, b) => (b.pct > a.pct ? b : a));
}

// ── Sprinklers ─────────────────────────────────────────────────────────────────────────────────

const SPRINKLER_FACT = [
  /\b(?:dwelling|house|home|residence|building|structure|garage)\s+(?:is\s+|has\s+been\s+)?(?:fully\s+)?(?:sprinklered|equipped\s+with\s+(?:an?\s+)?(?:automatic\s+|residential\s+|NFPA\s*13D?\s+|fire\s+)*sprinkler)/i,
  /\b(?:fire\s+|automatic\s+)?sprinkler(?:s|\s+system)?\s*(?:[:=]|-)\s*(?:yes|installed|provided|present|existing)\b/i,
  /\bsprinklered\s*(?:[:=]|-)\s*(?:yes|y)\b/i,
];
const SPRINKLER_DENIED = /\b(?:no|not|non|none|without|n\/a)\b/i;

/** The package states, as a fact about this dwelling, that it has an automatic sprinkler system. */
export function readSprinklered(sources: DesignTextSource[]): FireAccessFacts["sprinklered"] {
  for (const s of sources) {
    for (const c of clauses(s.text)) {
      if (REQUIREMENT_WORDS.test(c.text) || SPRINKLER_DENIED.test(c.text)) continue;
      const m = SPRINKLER_FACT.map((re) => re.exec(c.text)).find(Boolean);
      if (m) return { source: s.label, excerpt: c.text.trim().slice(0, 140) };
    }
  }
  return null;
}

// ── The AHJ's alternative policy ───────────────────────────────────────────────────────────────

/**
 * The jurisdiction's alternative roof-access policy and whether it is APPLIED: its layer is
 * person-verified and the policy names the page it was read on, or a citation with field
 * "firePathwayPolicy" was read on the authority's official page (#683). Anything else is shown, not
 * applied (the model code stands).
 */
export function resolveFirePathwayPolicy(ctx: EffectiveCodeContext): FireAccessFacts["policy"] {
  const policy = ctx.profile?.firePathwayPolicy;
  if (!policy) return null;
  const src = ctx.profile?.fieldSources?.firePathwayPolicy;
  const official = src ? (src.confidence === "official" ? src.officialSource ?? null : null)
    : ctx.profile?.confidence !== "verified" ? officialCitationFor(ctx.profile?.citations, "firePathwayPolicy") : null;
  const personVerified = src ? src.confidence === "verified" : ctx.profile?.confidence === "verified";
  const verifiedBy = src ? src.verifiedBy : ctx.profile?.verifiedBy;
  const owner = (src?.ahj || ctx.profile?.ahj || ctx.ahj || src?.state || ctx.state || "the jurisdiction").trim();
  const named = policy.name ? `"${policy.name}"` : "alternative roof-access policy";
  if (official) {
    return { policy, applied: true, provenance: `${owner}'s ${named} (from ${official.host}, the jurisdiction's own official page, read ${official.fetchedAt.slice(0, 10)}: ${official.sourceUrl})` };
  }
  if (personVerified && policy.sourceUrl) {
    return { policy, applied: true, provenance: `${owner}'s ${named} (human-verified${verifiedBy ? ` by ${verifiedBy}` : ""}; ${policy.sourceUrl})` };
  }
  const why = personVerified ? "verified without the page it was read on" : "seeded, not yet human-verified";
  return { policy, applied: false, provenance: `${owner}'s ${named} (${why}${policy.sourceUrl ? `; ${policy.sourceUrl}` : ""})` };
}


/** Every fact the fire access requirement reads, from the package and the jurisdiction's profile. */
export function readFireAccessFacts(project: ProjectRecord, ctx: EffectiveCodeContext, extraTexts: DesignTextSource[] = []): FireAccessFacts {
  const sources = packageReadSources(project, extraTexts);
  const array = readArrayAreaSqFt(project, sources);
  return {
    coverage: readRoofCoverage(project, sources),
    arrayAreaSqFt: array ? array.value : null,
    sprinklered: readSprinklered(sources),
    policy: resolveFirePathwayPolicy(ctx),
  };
}


// ── Findings ───────────────────────────────────────────────────────────────────────────────────

const EERO_WORDS = /\b(?:EEROs?|emergency\s+escape(?:\s+and\s+rescue)?(?:\s+openings?)?|rescue\s+openings?|egress\s+windows?)\b/i;
const EERO_NONE = /\b(?:no|none|n\/a)\b[^.;\n]{0,20}\b(?:EEROs?|emergency\s+escape|rescue\s+openings?|egress\s+windows?)\b|\b(?:EEROs?|emergency\s+escape(?:\s+and\s+rescue)?\s+openings?|egress\s+windows?)\s*[:=-]\s*(?:none|n\/a|no)\b/i;
const MODULES_BELOW = /\b(?:modules?|panels?|arrays?|pv)\b[^.;\n]{0,40}\b(?:below|under|beneath)\b|\b(?:below|under|beneath)\b[^.;\n]{0,40}\b(?:EEROs?|emergency\s+escape|rescue\s+opening|egress\s+window)/i;
const NEGATED = /\b(?:no|not|never|none|without|clear\s+of|free\s+of)\b/i;
const PATH_TO_EERO = /\b(?:3\s*(?:'|ft|feet)|36\s*(?:"|”|in(?:ch(?:es)?)?\b)|3'-0")[^.;\n]{0,50}\b(?:path(?:way)?|access|clear)\b[^.;\n]{0,40}\b(?:EEROs?|emergency\s+escape|rescue\s+opening|egress\s+window)|\b(?:path(?:way)?|access)\b[^.;\n]{0,30}\bto\b[^.;\n]{0,20}\b(?:EEROs?|emergency\s+escape|rescue\s+opening|egress\s+window)[^.;\n]{0,30}\b(?:3\s*(?:'|ft|feet)|36\s*(?:"|”|in))/i;

function eeroRef(ctx: EffectiveCodeContext): CodeReference {
  return residentialCodeRef(ctx, "R324.6", "Roof access and pathways: emergency escape and rescue openings",
    "Panels and modules are not placed on the portion of a roof below an emergency escape and rescue opening, and a pathway not less than 36 in wide is provided to it.");
}

/**
 * EMERGENCY ESCAPE AND RESCUE OPENINGS (R324.6), for a roof-mounted array:
 *   city.fire.eero-obstructed   the plan places modules below an EERO and states no 36 in path to it —
 *                               a WARNING (the model code; a statement read from text, never a blocker);
 *   city.fire.eero-unconfirmed  the package says nothing about EEROs — ONE callout asking the designer
 *                               to confirm (never silent).
 * A plan that says there is none, or that keeps modules clear of it, or that dimensions the path → nothing.
 */
export function evaluateEeroFindings(project: ProjectRecord, ctx: EffectiveCodeContext, extraTexts: DesignTextSource[] = []): ReviewerFinding[] {
  const sources = packageReadSources(project, extraTexts);
  let mentioned = false;
  let obstructed: { source: string; excerpt: string } | null = null;
  let path = false;
  for (const s of sources) {
    if (PATH_TO_EERO.test(s.text)) path = true;
    for (const c of clauses(s.text, true)) {
      if (!EERO_WORDS.test(c.text)) continue;
      mentioned = true;
      if (EERO_NONE.test(c.text) || REQUIREMENT_WORDS.test(c.text) || NEGATED.test(c.text)) continue;
      if (MODULES_BELOW.test(c.text) && !obstructed) obstructed = { source: s.label, excerpt: c.text.trim().slice(0, 140) };
    }
  }
  const codeReferences = [eeroRef(ctx)];
  if (obstructed && !path) {
    return [{
      id: FIRE_EERO_OBSTRUCTED_ID,
      severity: "warning",
      category: "plan_set",
      title: "Modules below an emergency escape and rescue opening",
      message: `The plan places modules below an emergency escape and rescue opening ("${obstructed.excerpt}", ${obstructed.source}) and states no 36 in pathway to it. The model code (R324.6) keeps modules off the roof below an EERO; a warning, read from the plan text.`,
      cityFeedback: "Revise the roof plan so no modules sit on the portion of the roof below an emergency escape and rescue opening, and dimension a pathway at least 36 in wide to it.",
      designTeamAction: "Re-lay the array clear of the roof below each emergency escape and rescue opening and reissue the roof plan with the 36 in path dimensioned.",
      evidenceNeeded: ["Roof plan marking each EERO", "Modules clear of the roof below each EERO", "36 in pathway to each EERO, dimensioned"],
      codeReferences,
      installerCallout: true,
      evidenceStatus: "verified",
      evidenceFound: [{ kind: "source_excerpt", label: "Modules below an EERO", source: obstructed.source, excerpt: obstructed.excerpt, confidence: "medium", pageHint: "", screenshotPath: "", verifier: "rule_engine", note: "No 36 in pathway to the EERO is stated in the package text." }],
    }];
  }
  if (mentioned) return [];
  return [{
    id: FIRE_EERO_UNCONFIRMED_ID,
    severity: "callout",
    category: "plan_set",
    title: "Emergency escape and rescue openings not addressed on the roof plan",
    message: "The package text does not mention emergency escape and rescue openings (EEROs). The model code (R324.6) keeps modules off the roof below an EERO and asks for a 36 in pathway to it; confirm the roof plan does.",
    cityFeedback: "Show any emergency escape and rescue openings on the roof plan, keep modules off the roof below them, and dimension a 36 in pathway to each — or note that none face the array.",
    designTeamAction: "Confirm whether any emergency escape and rescue opening (a bedroom egress window) sits above the array's roof plane; mark it on the roof plan with the 36 in path, or add a note that there is none.",
    evidenceNeeded: ["EEROs marked on the roof plan, or a note that none face the array"],
    codeReferences,
    installerCallout: false,
    evidenceStatus: "missing",
    evidenceFound: [{ kind: "absence_check", label: "No EERO mention", source: "Package text", excerpt: "No emergency escape and rescue opening is mentioned in the package text.", confidence: "low", pageHint: "", screenshotPath: "", verifier: "rule_engine", note: "Absence check over the package text." }],
  }];
}

/** A policy on file that does NOT apply (seeded, or verified without its page): shown so a person can
 *  verify it; the model code stands meanwhile, so a design built to the policy may be warned. */
export function evaluatePolicyFindings(ctx: EffectiveCodeContext, facts: FireAccessFacts): ReviewerFinding[] {
  const p = facts.policy;
  if (!p || p.applied) return [];
  return [{
    id: FIRE_POLICY_UNAPPLIED_ID,
    severity: "callout",
    category: "ahj_profile",
    title: "Alternative roof-access policy on file, not yet verified",
    message: `${p.provenance} relaxes the model-code pathways (${describePolicy(p.policy)}). It is not applied until a person verifies it against its page (or it is read on the jurisdiction's official page); the model-code numbers are used meanwhile.`,
    cityFeedback: "",
    designTeamAction: "If the design relies on the jurisdiction's alternative roof-access policy, say so on the roof plan and have the policy verified on the jurisdiction's code profile.",
    evidenceNeeded: ["The policy's page, checked by a person"],
    codeReferences: [residentialCodeRef(ctx, "R324.6", "Roof access and pathways", "The jurisdiction may adopt an alternative to the model-code pathways.")],
    installerCallout: false,
    evidenceStatus: "weak",
    evidenceFound: [],
  }];
}
