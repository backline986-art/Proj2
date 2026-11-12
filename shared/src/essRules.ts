// THE BATTERY (ESS) RULES' SHAPE AND THEIR MODEL-CODE BASELINE (review-audit draft 05).
//
// A jurisdiction's ESS rules are DATA on its code profile (JurisdictionCodeProfile.essRules), each
// value cited. This module is the one place that knows the keys, which direction is stricter for
// each, the baseline every jurisdiction starts from, and how a stored value is shape-checked. Pure:
// no DB, no network. Nothing here names a utility, a city or a state.
//
// THE BASELINE IS THE STRICTEST MODEL REQUIREMENT (owner, 2026-11-09): the 2021 IRC R328 limits
// (20 kWh a unit; 40 kWh aggregate in utility closets, basements and storage or utility spaces; 80 kWh
// in garages, accessory structures, on exterior walls and outdoors; 3 ft between units; 3 ft from
// doors and windows; no ESS in sleeping or habitable rooms; UL 9540 listing; smoke/heat alarm; vehicle
// impact protection; finished or Type X walls) and NEC 706.15's disconnecting means — outside the
// dwelling from the 2020 NEC on. Two allowances the model or some amendments grant are OFF in the
// baseline and come on only as a jurisdiction's cited data: spacing below 3 ft on UL 9540A large-scale
// fire testing, and an exemption for a UL 9540 unit marked for residential dwelling units. A baseline
// value is never a person's or an authority's statement, so a finding resting on it only warns.

import type { JurisdictionEssRuleRead, JurisdictionEssRules } from "./types";
import { quoteNamesValue, quoteText } from "./officialSource";

export type EssRuleKey = keyof JurisdictionEssRules;

/** How a key's value orders: a maximum (lower is stricter), a minimum (higher is stricter), a
 *  requirement (true is stricter) or an allowance (false is stricter). */
type EssRuleKind = "max" | "min" | "requirement" | "allowance";

export const ESS_RULE_KINDS: Readonly<Record<EssRuleKey, EssRuleKind>> = {
  maxUnitKwh: "max",
  maxAggregateKwhUtilitySpace: "max",
  maxAggregateKwhGarage: "max",
  maxAggregateKwhAccessory: "max",
  maxAggregateKwhExteriorWall: "max",
  maxAggregateKwhOutdoor: "max",
  minUnitSpacingIn: "min",
  spacingReductionBy9540A: "allowance",
  minOpeningClearanceIn: "min",
  listingRequired: "requirement",
  habitableLocationProhibited: "requirement",
  impactProtectionInGarage: "requirement",
  alarmRequired: "requirement",
  wallProtectionRequired: "requirement",
  disconnectOutside: "requirement",
  listedResidentialExemption: "allowance",
};

export const ESS_RULE_KEYS = Object.keys(ESS_RULE_KINDS) as EssRuleKey[];

/** The model-code baseline. `necEdition`: the adopted NEC year when on file — only a 2017-or-earlier
 *  adoption drops the "outside the dwelling" disconnect (unknown = the newer, stricter rule). */
export function essModelDefaults(necEdition: number | null = null): Required<JurisdictionEssRules> {
  return {
    maxUnitKwh: 20,
    maxAggregateKwhUtilitySpace: 40,
    maxAggregateKwhGarage: 80,
    maxAggregateKwhAccessory: 80,
    maxAggregateKwhExteriorWall: 80,
    maxAggregateKwhOutdoor: 80,
    minUnitSpacingIn: 36,
    spacingReductionBy9540A: false,
    minOpeningClearanceIn: 36,
    listingRequired: true,
    habitableLocationProhibited: true,
    impactProtectionInGarage: true,
    alarmRequired: true,
    wallProtectionRequired: true,
    disconnectOutside: !(necEdition != null && necEdition <= 2017),
    listedResidentialExemption: false,
  };
}

/** Is `value` stricter than `than` for this key? Equal is not stricter. */
export function essRuleStricter(key: EssRuleKey, value: number | boolean, than: number | boolean): boolean {
  switch (ESS_RULE_KINDS[key]) {
    case "max": return Number(value) < Number(than);
    case "min": return Number(value) > Number(than);
    case "requirement": return value === true && than === false;
    case "allowance": return value === false && than === true;
  }
}

/** A stored essRules block, shape-checked (rows are shared data): known keys only, numbers positive
 *  and bounded, flags strictly boolean. Undefined when nothing survives. */
export function essRulesOf(raw: unknown): JurisdictionEssRules | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, number | boolean> = {};
  for (const key of ESS_RULE_KEYS) {
    const v = r[key];
    const kind = ESS_RULE_KINDS[key];
    if (kind === "max" || kind === "min") {
      if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 10000) out[key] = v;
    } else if (typeof v === "boolean") {
      out[key] = v;
    }
  }
  return Object.keys(out).length ? (out as JurisdictionEssRules) : undefined;
}

// ── A RESEARCHED READ OF ONE RULE (ESS data follow-up) ──────────────────────────────────────────
// Research proposes a jurisdiction's ESS rules field by field, each with the page that states it and
// the words on that page. What a model answered is shape-checked here; where it LANDS (official or
// seeded, never over a person's value) is decided by the one landing function (#683) at the write.

/** One researched value: the key, its value, the page that states it and the verbatim words. */
export type EssRuleRead = JurisdictionEssRuleRead;

const READ_URL = /^https?:\/\/[^\s]+$/i;

/**
 * A model's (or a parser's) list of ESS rule reads, shape-checked. A read is KEPT only with a known key,
 * a value of that key's kind within essRulesOf's bounds, an http(s) page and a verbatim quote; a NUMBER
 * must be among the quote's own numbers (as stored, or as published) — a quote that does not state the
 * value is not a citation of it. The first read of a key wins. Every dropped read says why.
 */
export function essRuleReadsOf(raw: unknown): { reads: EssRuleRead[]; dropped: string[] } {
  const reads: EssRuleRead[] = [];
  const dropped: string[] = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, 40) : []) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const key = String(o.key ?? "").trim() as EssRuleKey;
    if (!(key in ESS_RULE_KINDS)) { dropped.push(`${String(o.key ?? "(no key)").slice(0, 40)}: not an ESS rule key`); continue; }
    if (reads.some((r) => r.key === key)) { dropped.push(`${key}: a second value for the same rule`); continue; }
    const numeric = ESS_RULE_KINDS[key] === "max" || ESS_RULE_KINDS[key] === "min";
    const value = numeric ? (typeof o.value === "number" ? o.value : typeof o.value === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(o.value) ? Number(o.value) : NaN) : o.value;
    const clean = essRulesOf({ [key]: value });
    if (!clean) { dropped.push(`${key}: ${numeric ? "not a usable number" : "not true/false"}`); continue; }
    const sourceUrl = String(o.sourceUrl ?? "").trim().slice(0, 500);
    if (!READ_URL.test(sourceUrl)) { dropped.push(`${key}: no source page`); continue; }
    const quote = quoteText(String(o.quote ?? "")).slice(0, 300);
    if (quote.length < 3) { dropped.push(`${key}: no verbatim quote`); continue; }
    const published = typeof o.publishedValue === "number" && Number.isFinite(o.publishedValue) ? o.publishedValue : undefined;
    const v = (clean as Record<string, number | boolean>)[key];
    if (numeric) {
      if (!quoteNamesValue(quote, v as number) && !(published !== undefined && quoteNamesValue(quote, published))) { dropped.push(`${key}: the quote does not state ${String(v)}`); continue; }
    }
    reads.push({ key, value: v, sourceUrl, quote, ...(numeric && published !== undefined && published !== v ? { publishedValue: published } : {}) });
  }
  return { reads, dropped };
}
