// The utility filing lookup's prompt lines for the application requirement items it proposes
// (utilityRequirementsResearch.ts). Text only, no imports: utilityFilingLookup.ts loads it at start-up.

/** The JSON member the lookup's answer carries (one line of the prompt's schema). */
export const UTILITY_REQUIREMENTS_RESEARCH_SCHEMA = `"applicationRequirements": [{"key": "<one key below>", "sourceName": "<the page by name>", "sourceUrl": "<the page that says it>", "quote": "<the sentence saying it, verbatim>"}]`;

/** The prompt's rule for that member. */
export const UTILITY_REQUIREMENTS_RESEARCH_RULE = `4. applicationRequirements — ONLY what the utility's OWN interconnection / net-metering application page (or its application form or checklist) says a residential solar application must include. Keys: meter_photo (a photo of the meter), account_verification (the account number or a utility bill), one_line (a one-line / single-line diagram), site_plan (a site plan), module_spec (module / panel spec sheets), inverter_spec (inverter spec sheets), inverter_settings (inverter settings, e.g. a required settings profile), inverter_listing_ul1741sb (UL 1741 SB listing), ac_disconnect (an AC / visible disconnect), storage_mode_declaration (a battery's operating mode), owner_signature (the customer's signature). Each entry needs the page and the sentence copied word for word, and the sentence must name the item. Never list something the page does not say; never answer from memory. An empty list is a correct answer.`;
