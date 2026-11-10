// THE BATTERY (ESS) RULES A CODE RESEARCH ASKS FOR (ESS data follow-up to review-audit draft 05).
//
// Code research (llm.researchJurisdictionCodes) proposes a jurisdiction's profile; it now also proposes
// the jurisdiction's OWN battery / energy-storage rules, field by field, each with the page that states
// it and the sentence quoted verbatim. Only a rule the jurisdiction (or its state's amendment, or a
// published handout of its own) states counts: the model code (IRC R328 / NEC 706) is the baseline
// every review already applies, so restating it here is not asked for.
//
// What the model answers is only a PROPOSAL: essRuleReadsOf shape-checks it (a number must appear in
// its own quote), and codeProfiles.landResearchedEssRules decides where each value lands — official
// only through #683's one landing function on bytes this process read, otherwise seeded (a seeded value
// only ever warns, and only where it is stricter than the baseline), never over a person's value.
// Nothing here names a utility, a city or a state.

import type { JurisdictionEssRuleRead } from "../../shared/src/types";
import { essRuleReadsOf } from "../../shared/src/essRules";

/** The JSON member the research answer carries (one line of the prompt's schema). */
export const ESS_RULES_RESEARCH_SCHEMA = `"essRules": [{"key": "<one key below>", "value": <number, or true/false>, "publishedValue": <the number as the page prints it, ONLY when you converted a unit>, "sourceUrl": "<page stating it>", "quote": "<the sentence stating it, verbatim>"}],`;

/** The prompt's rule for that member. */
export const ESS_RULES_RESEARCH_RULE = `- essRules is about RESIDENTIAL BATTERY / ENERGY STORAGE SYSTEMS, and only rules THIS jurisdiction states itself (a local or state amendment, its own published battery/ESS handout or code). Do NOT restate the model code (IRC R328 / NEC 706) as the jurisdiction's rule. Keys: maxUnitKwh (kWh per unit), maxAggregateKwhUtilitySpace / maxAggregateKwhGarage / maxAggregateKwhAccessory / maxAggregateKwhExteriorWall / maxAggregateKwhOutdoor (total kWh by location), minUnitSpacingIn and minOpeningClearanceIn (inches: give 3 feet as value 36 with publishedValue 3), spacingReductionBy9540A (true when closer spacing is allowed on UL 9540A testing), listedResidentialExemption (true when a UL 9540 unit listed for dwellings is exempt from the kWh/spacing limits), and true/false requirements listingRequired, habitableLocationProhibited, impactProtectionInGarage, alarmRequired, wallProtectionRequired, disconnectOutside. Each entry needs the page and the sentence copied word for word; a number must appear in that sentence. An empty list is a correct answer.`;

/** The research answer's essRules member, shape-checked. Model memory is never a rule: an answer that
 *  was not web-grounded yields nothing. */
export function researchedEssRules(raw: unknown, webGrounded: boolean): { reads: JurisdictionEssRuleRead[]; dropped: string[] } {
  if (!webGrounded) return { reads: [], dropped: [] };
  return essRuleReadsOf(raw);
}
