import type { AuthorityEligibilityRecord, JobScope, ParserPayload, QcStatus, Severity, UtilityApplicationRequirement, UtilityRequirementKey, UtilityRequirementList } from "../../shared/src/types";
import type { EffectiveCodeContext } from "./codeProfiles";
import { requirementForGate, requirementMayBlock, resolveUtilityRequirements, shippedQcRuleDefinitions, strictDefaultRequirements } from "./utilityRequirements";
import { batteryStatus } from "../../shared/src/batteryControls";
import { jurisdictionScreenMayBlock, matchJurisdiction, recordForIdPrefix, shippedJurisdictionQcRecords, shippedJurisdictionRuleDefinitions, type JurisdictionQcRecord, type JurisdictionQcScreen, type SubmittalItemKey } from "./jurisdictionQcRules";
import { isBillHolderName, nemApplicantName } from "./accountHolders";
import { evaluateEligibility, productionMeterShown, shippedEligibilityRecords, stringsPerInverterOf } from "./eligibilityLimits";
import { usStateCode } from "./permitPath";
import { deriveJobScope, scopeHasNewPv, storageOperatingMode } from "./jobScope";

export interface BaselineRuleDefinition {
  id: string;
  ruleType: "qc" | "correction" | "monitor";
  name: string;
  jurisdictionScope: string;
  utilityScope: string;
  source: string;
  severity: Severity;
  trigger: string;
  action: string;
}

export interface BaselineQcResult {
  ruleId: string;
  ruleName: string;
  qcStatus: QcStatus;
  severity: Severity;
  message: string;
  fieldName?: string;
}

export const baselineRuleDefinitions: BaselineRuleDefinition[] = [
  {
    id: "xcheck-nem-account-holder",
    ruleType: "qc",
    name: "Applicant vs utility account holder",
    jurisdictionScope: "Any",
    utilityScope: "Any interconnection portal",
    source: "Utility interconnection practice (observed: application APP-111681 suspended)",
    severity: "warning",
    trigger: "The name on the application differs from the account holder printed on the utility bill",
    action: "Add the applicant to the account, put the service in their name, or name the account holder on the application — before filing.",
  },
  {
    id: "or-nem-residential-25kw",
    ruleType: "qc",
    name: "Oregon residential NEM size screen",
    jurisdictionScope: "Oregon",
    utilityScope: "PGE/Pacific Power/general Oregon public utility",
    source: "OAR 860-039-0010",
    severity: "warning",
    trigger: "Residential net metering facility over 25 kW DC",
    action: "Flag for non-standard NEM review or commercial/non-residential confirmation.",
  },
  // Each jurisdiction's screens (prescriptive, export, disconnect, city submittal lists) are catalogued
  // by the shipped jurisdiction data (reference-jurisdiction-qc-rules.json), in this place in the list.
  ...shippedJurisdictionRuleDefinitions(),
  // The per-utility QC rules (pacpower-*, pge-powerclerk-docs, utility-application-package,
  // utility-requirements-not-researched) are catalogued by the shipped requirement data, appended below.
];
for (const def of shippedQcRuleDefinitions()) {
  if (!baselineRuleDefinitions.some((d) => d.id === def.id)) baselineRuleDefinitions.push({ ...def, ruleType: "qc", severity: "warning" });
}

function str(payload: ParserPayload, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function num(payload: ParserPayload, key: string): number | null {
  const cleaned = str(payload, key).replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

// THE AC DISCONNECT PART — ONE ANSWER FOR QC AND FOR THE PORTAL FILING (leak sweep 2026-09-28).
//
// The plan set's part (acDiscMakeModel, split into make + model; the legacy acDiscMake/acDiscModel
// keys win when a snapshot carries them) beats the installer's standard part. The standard part is a
// default for a plan set that leaves the part to the installer, and it is cross-checked against the
// plan set's own rating and fusing — a disagreement is named for the operator, never filed.
export interface PlanSetDisconnectPart { make: string; model: string; named: boolean }
export function planSetDisconnectPart(payload: Record<string, unknown>): PlanSetDisconnectPart {
  const s = (k: string): string => String(payload[k] ?? "").trim();
  let make = s("acDiscMake");
  let model = s("acDiscModel");
  const combined = s("acDiscMakeModel").replace(/\s+/g, " ");
  if (combined && !/^(n\/?a|none|unknown|not (specified|shown|listed))$/i.test(combined) && (!make || !model)) {
    const tokens = combined.split(" ");
    // The model is the first part-number-shaped token after the make ("Square D DU222RB",
    // "Eaton DG222NRB 60A" -> DG222NRB): letters AND digits, 4+ characters, not a rating.
    const idx = tokens.findIndex((t, i) => i > 0 && /[a-z]/i.test(t) && /\d/.test(t) && t.replace(/[^a-z0-9]/gi, "").length >= 4 && !/^\d+(a|v|amps?|volts?)$/i.test(t));
    // No part number and the words describe a RATING ("60A NON-FUSIBLE AC DISCONNECT") — that is the
    // schedule's rating line, not a manufacturer; it names no part.
    const ratingText = idx <= 0 && /\bdisconnect\b|\bfus(?:ed|ible)\b|^\d+\s*a\b|\bamps?\b|\bvolts?\b|\b\d+\s*v\b/i.test(combined);
    const splitMake = idx > 0 ? tokens.slice(0, idx).join(" ") : ratingText ? "" : combined;
    const splitModel = idx > 0 ? tokens[idx] : "";
    make = make || splitMake;
    model = model || splitModel;
  }
  return { make, model, named: Boolean(make || model) };
}
export interface DisconnectConflict { ruleId: "xcheck-disconnect-fusing" | "xcheck-disconnect-rating"; ruleName: string; message: string; fieldName: string }
/** Where the installer's standard part contradicts the plan set's rating or fusing. Asserts only what
 *  the part number itself states (Eaton DG-series: "DG221URB" — "U" unfused, frame "221" = 30 A /
 *  2-pole / 240 V); an unrecognised model asserts nothing. */
export function standardDisconnectConflicts(stdModel: string, plan: { fused?: string | null; amps?: number | null }): DisconnectConflict[] {
  const out: DisconnectConflict[] = [];
  const model = String(stdModel ?? "").trim();
  if (!model) return out;
  const discFused = String(plan.fused ?? "").toLowerCase();
  const modelIsNonFused = /dg\d{3}u/i.test(model);
  const modelIs30A = /dg2\s*2\s*1/i.test(model.replace(/[^a-z0-9]/gi, ""));
  if (modelIsNonFused && /fusible/.test(discFused) && !/non/.test(discFused)) {
    out.push({
      ruleId: "xcheck-disconnect-fusing", ruleName: "AC disconnect fusing vs the standard part", fieldName: "acDiscFused",
      message: `The plan set specifies a FUSIBLE AC disconnect, but the installer's standard part (${model}) is non-fusible. Confirm which is actually being installed before the utility application is filed — the disconnect make/model is left blank on the utility application until then.`,
    });
  }
  if (modelIs30A && plan.amps != null && plan.amps > 30) {
    out.push({
      ruleId: "xcheck-disconnect-rating", ruleName: "AC disconnect rating vs the standard part", fieldName: "acDiscAmps",
      message: `The plan set calls for a ${plan.amps} A AC disconnect, but the installer's standard part (${model}) is rated 30 A. Confirm the disconnect size before filing — the disconnect make/model is left blank on the utility application until then.`,
    });
  }
  return out;
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function result(
  ruleId: string,
  ruleName: string,
  qcStatus: QcStatus,
  severity: Severity,
  message: string,
  fieldName?: string,
): BaselineQcResult {
  return { ruleId, ruleName, qcStatus, severity, message, fieldName };
}

/**
 * Do two names refer to the same person (or a household that includes them)?
 *
 * Deliberately GENEROUS — a false alarm on "ROBERT J SMITH" vs "Bob Smith" would train
 * operators to click past the one warning that stops a suspended application. It answers
 * "could these be the same person / is the applicant on this account", not "are these
 * strings equal". Only a genuine disagreement of PERSON is reported.
 *
 * Joint accounts are the common shape ("JOHN & JANE SMITH", "SMITH, JOHN A"), so the bill
 * side is treated as a SET of names: agreement means the applicant appears among them.
 */
export function namesAgree(applicant: string, accountHolder: string): boolean {
  const TITLES = /^(mr|mrs|ms|miss|dr|rev|sir|madam|mister)$/;
  const SUFFIXES = /^(jr|sr|ii|iii|iv|v)$/;
  const tokens = (s: string): string[] =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[.,]/g, " ")
      .replace(/[^a-z\s&]/g, " ")
      .split(/\s+/)
      .filter((t) => t && !TITLES.test(t) && !SUFFIXES.test(t) && t !== "and" && t !== "&");

  const a = tokens(applicant);
  const b = tokens(accountHolder);
  if (a.length === 0 || b.length === 0) return true; // nothing to compare — say nothing

  // The account holder's surname is the last token of the LAST name on the bill; a joint
  // account usually shares it ("JOHN & JANE SMITH"). If the applicant shares no surname
  // with the account at all, they are plainly a different household.
  const aLast = a[a.length - 1];
  const bSet = new Set(b);
  if (!bSet.has(aLast)) return false;

  // Surname matches. Now the given name must also be accounted for, or this is a
  // DIFFERENT PERSON IN THE SAME HOUSEHOLD — a spouse, which is exactly the Mockdata case
  // and exactly what the utility rejects.
  const aGiven = a.slice(0, -1);
  if (aGiven.length === 0) return true; // surname only — nothing more to disagree about

  return aGiven.some((g) => {
    if (bSet.has(g)) return true;
    // Initial vs full name, in either direction: "J Smith" vs "John Smith".
    if (g.length === 1) return b.some((t) => t.startsWith(g));
    return b.some((t) => t.length === 1 && g.startsWith(t));
  });
}

/** The eligibility inputs QC supplies (#679). Omitted: the shipped reference rows only, no
 *  certification read, and no "program not on file" notice (the pure legacy callers). */
export interface BaselineEligibilityContext {
  /** The records on file for the job's state (eligibilityRecordsForState). */
  records: AuthorityEligibilityRecord[];
  /** The project's client's certifications; null when there is no client record. */
  clientCertifications: string[] | null;
  /** Say so when no utility-program record matches the job's utility (strictest baseline). */
  reportUnknownProgram?: boolean;
  today?: string;
}

/** The job's utility's requirement list for the QC baseline (utilityRequirements.ts). */
export interface BaselineUtilityContext {
  /** The list resolved with the DB (shipped seed + the utility's filing row). undefined = the shipped
   *  seed alone; null = read, and nothing is on file for this utility. */
  requirements?: UtilityRequirementList | null;
  /** With no list on file, check the strictest common set and say the utility is not researched
   *  (qc.ts sets it; like eligibility's reportUnknownProgram, off for bare callers). */
  reportUnresearched?: boolean;
  /** What the job installs (#673), resolved with the DB (qc.ts: resolveJobScope, a named person's scope
   *  included). Absent = what the job's own evidence says (deriveJobScope), which stays "pv" unless the
   *  plan set itself shows no new modules: the strict default keeps every PV item. */
  scope?: JobScope;
  /** The job's AC disconnect part, ONLY when its own plan set names that part at its AC-disconnect
   *  label (acDisconnectIntake.capturedDisconnectPart, computed by qc.ts on the plan-set text the gate
   *  sees). "" / absent = none: the ac_disconnect item reads the package text alone, as before. */
  disconnectPartOnPlanSet?: string;
  /** True when the job's plan-set text names an AC / utility disconnect in the wordings the reviewer
   *  gate reads (acDisconnectIntake.planTextNamesAcDisconnect, the one list; qc.ts hands it in on the
   *  same plan-set text), or, for a plan set with no text, when the server's own image read of the
   *  job's stored plan set named one (planSetImageReads, #135). Absent / false = the ac_disconnect item reads the split-page list and the
   *  upload notes alone, as before (#134). */
  planSetNamesAcDisconnect?: boolean;
  /** True when the CEC's own inverter list prints UL 1741 SB "Y" for every listing the job's inverter
   *  model can be (cecEquipment.jobInverterUl1741Sb, read by qc.ts; the reviewer gate reads the same
   *  answer). Absent / false = the inverter_listing_ul1741sb item reads the package text alone, as before. */
  inverterUl1741SbOnCecList?: boolean;
  /** True when the CEC list certifies the inverter AND the operator's standing answer says installs use
   *  the utility's required settings (cecEquipment.inverterSettingsByStandingAnswer, read by qc.ts).
   *  Absent / false = the inverter_settings item reads the package text alone, as before. */
  inverterSettingsByStandingAnswer?: boolean;
}

/** The jurisdiction records the QC baseline reads (jurisdictionQcRules.ts). */
export interface BaselineJurisdictionContext {
  /** Resolved with the DB (shipped seed + the state's "qc" rows in state_permit_rules). Absent = the
   *  shipped seed alone. */
  records?: JurisdictionQcRecord[];
}

export function evaluateBaselineRules(payload: ParserPayload, ctx?: EffectiveCodeContext, eligibility?: BaselineEligibilityContext, utilityCtx: BaselineUtilityContext = {}, jurisdictionCtx: BaselineJurisdictionContext = {}): BaselineQcResult[] {
  const out: BaselineQcResult[] = [];
  const state = str(payload, "state").toUpperCase();
  const ahj = str(payload, "ahj");
  const utility = str(payload, "utility");
  const utilityUpper = utility.toUpperCase();
  const dcKw = num(payload, "dcKw");
  // System additions: NEM program caps apply to the TOTAL generation on the
  // service, so screen on the combined (new + existing) size when present.
  const combinedDcKw = num(payload, "combinedDcKw");
  const screenDcKw = combinedDcKw != null && (dcKw == null || combinedDcKw > dcKw) ? combinedDcKw : dcKw;
  const combinedNote = screenDcKw !== dcKw ? " (combined new + existing system size)" : "";
  const exportKw = num(payload, "exportKw");
  const snow = num(payload, "snow");
  const deadLoad = num(payload, "deadLoad");
  const rafterSpacing = num(payload, "roofRafterSpacing");
  const wind = str(payload, "wind");
  const split = `${str(payload, "splitPagesText")}\n${str(payload, "utilityDownloadChecklistText")}`;
  const notes = `${str(payload, "utilityUploadNotesText")}\n${str(payload, "projectDescriptionText")}\n${str(payload, "sitePlanNotesText")}`;
  // WHICH JURISDICTION'S RECORDS APPLY, as data (jurisdictionQcRules.ts; no state or city is named
  // here). A job that names its state falls under that state's record; the AHJ-name fallback is only
  // for a job with no state, so "Portland" (Maine), "Salem" (Massachusetts) or "Washington County"
  // (Pennsylvania) never pull another state's program, prescriptive limits or city list in.
  const jurisdictionRecords = jurisdictionCtx.records ?? shippedJurisdictionQcRecords();
  const jurisdiction = matchJurisdiction(jurisdictionRecords, state, ahj);
  const jurisdictionPrescriptive = jurisdiction.stateRecord?.prescriptive;

  // PRESCRIPTIVE-PATH SCREENS — data-driven when a jurisdiction code context is
  // provided (the per-AHJ adopted-codes profile), so any state/county with limits
  // recorded gets the same screening. Without a context, the jurisdiction record's own
  // defaults are screened (the historical constants, now data).
  // Utility-PROGRAM size caps are not adopted building-code data either: they are cited
  // per-authority records (eligibilityLimits.ts, #679). Rule ids keep the legacy form a jurisdiction
  // record names (blocker gating, QC history, and the goldens key off them) and use
  // "<state>-…" elsewhere.
  // A LIMIT FRAGMENT IS NOT A PRESCRIPTIVE PATH (permitPath.ts says the same): Florida's seeded
  // state profile carries allowedWindExposures ["B","C","D"] — correct design-criteria data that
  // says nothing about a prescriptive PV path — and this file's screens printed "should be B or C
  // or D for the prescriptive path" from it. The screens run where the jurisdiction's record says it
  // publishes a prescriptive path, where its own research names one, or where a NUMERIC structural
  // limit (snow, dead load, spacing) is recorded for it — an exposure list alone is not a screen. A
  // researched "publishes no prescriptive path" (false) switches every screen off, unless the record
  // says it publishes one.
  const rawLimits = ctx
    ? ctx.prescriptive
    : jurisdictionPrescriptive?.defaults ?? {};
  const screensApply = jurisdictionPrescriptive?.publishesPath === true || rawLimits.hasPrescriptivePath === true
    || (rawLimits.hasPrescriptivePath !== false && [rawLimits.maxGroundSnowPsf, rawLimits.maxPvDeadLoadPsf, rawLimits.maxRafterSpacingIn].some((v) => typeof v === "number"));
  const limits = screensApply ? rawLimits : { ...(rawLimits.maxExportKwWithoutStudy != null ? { maxExportKwWithoutStudy: rawLimits.maxExportKwWithoutStudy } : {}) };
  // What the screens call the jurisdiction: the state record that names it; with a context and none,
  // the context's own AHJ or state.
  const jurisLabel = ctx
    ? (jurisdiction.labelRecord ? jurisdiction.labelRecord.displayName : (ctx.ahj || ctx.state || "the jurisdiction"))
    : (jurisdiction.stateRecord?.displayName ?? "the jurisdiction");
  // Whose rule ids: the context's state (or, with no context, the job's record); a record that names
  // its own ids keeps them.
  const idRecord = ctx ? recordForIdPrefix(jurisdictionRecords, (ctx.state || "jurisdiction").toLowerCase()) : jurisdiction.stateRecord;
  const idPrefix = (ctx ? ctx.state || "jurisdiction" : jurisdiction.stateRecord?.state || "jurisdiction").toLowerCase();
  const legacyIds = idRecord?.prescriptive?.ruleIds ?? {};
  const prescriptiveIds = {
    snow: legacyIds.snow ?? `${idPrefix}-prescriptive-snow`,
    dead: legacyIds.dead ?? `${idPrefix}-prescriptive-deadload`,
    framing: legacyIds.framing ?? `${idPrefix}-prescriptive-roof-framing`,
    wind: legacyIds.wind ?? `${idPrefix}-prescriptive-wind-exposure`,
    fire: legacyIds.fire ?? `${idPrefix}-fire-pathways`,
    export: legacyIds.export ?? `${idPrefix}-export-study-screen`,
  };
  const exportWords = idRecord?.prescriptive?.exportScreen;

  // -------------------------------------------------------------------------
  // DETERMINISTIC PARSER CROSS-CHECKS — jurisdiction-agnostic arithmetic over
  // the parsed payload. These catch exactly the extraction errors (transposed
  // digits, unit swaps, wrong-system values) that otherwise surface as an AHJ
  // correction cycle days later. Warning severity only: never a hard block.
  // -------------------------------------------------------------------------
  const moduleQty = num(payload, "moduleQty") ?? num(payload, "moduleQuantity");
  const moduleWattage = num(payload, "moduleWattage") ?? num(payload, "moduleWatts");
  if (moduleQty != null && moduleWattage != null && dcKw != null && moduleQty > 0 && moduleWattage > 0) {
    const computedDc = (moduleQty * moduleWattage) / 1000;
    // Tolerance: 150 W absolute floor, or 1.5% for larger systems — plan sets
    // legitimately round the nameplate (140 × 430 W = 60.2 stated as "60 kW").
    const tolerance = Math.max(0.15, dcKw * 0.015);
    if (Math.abs(computedDc - dcKw) > tolerance) {
      out.push(result(
        "xcheck-module-math",
        "Module math vs DC size",
        "warning",
        "warning",
        `${moduleQty} × ${moduleWattage} W = ${computedDc.toFixed(2)} kW DC, but dcKw is ${dcKw}. One of the three was misread — verify against the plan set before staging.`,
        "dcKw",
      ));
    }
  }
  const existingDcKw = num(payload, "existingDcKw");
  if (dcKw != null && existingDcKw != null && combinedDcKw != null && Math.abs(combinedDcKw - (dcKw + existingDcKw)) > 0.1) {
    out.push(result(
      "xcheck-combined-size",
      "Combined system size arithmetic",
      "warning",
      "warning",
      `combinedDcKw ${combinedDcKw} ≠ new ${dcKw} + existing ${existingDcKw} = ${(dcKw + existingDcKw).toFixed(2)} kW. Verify which value the plan set actually states.`,
      "combinedDcKw",
    ));
  }
  const acKw = num(payload, "acKw");
  if (dcKw != null && acKw != null && dcKw > 0 && acKw > dcKw * 1.1) {
    out.push(result(
      "xcheck-dc-ac-ratio",
      "DC/AC ratio sanity",
      "warning",
      "warning",
      `AC size ${acKw} kW exceeds DC size ${dcKw} kW by >10% — almost always a swapped or misread value. Verify both against the plan set.`,
      "acKw",
    ));
  }
  // NEC 705/240: the backfed PV breaker must be ≥ 125% of the inverters'
  // continuous output current. invOutputW/pvMicroOutputW hold rated output
  // CURRENT in amps per unit (see the parser prompt).
  const pvBreaker = num(payload, "pvBreaker");
  const unitAmps = num(payload, "invOutputW") ?? num(payload, "pvMicroOutputW");
  const unitQty = num(payload, "invOutputW") != null ? (num(payload, "invQty") ?? 1) : (num(payload, "pvMicroQty") ?? num(payload, "invQty") ?? 1);
  // PLAUSIBILITY GUARD: these fields are DOCUMENTED as amps per unit, but real
  // payloads sometimes carry the WATT rating (e.g. an IQ8M parsed as 325). A
  // per-unit residential inverter output above 100 A — or a computed minimum
  // beyond any residential backfeed breaker — means the units are off, and a
  // false warning would erode trust in every other cross-check. Stay silent.
  if (pvBreaker != null && unitAmps != null && unitAmps > 0 && unitAmps <= 100 && unitQty > 0) {
    const minBreaker = 1.25 * unitAmps * unitQty;
    if (minBreaker <= 400 && pvBreaker < minBreaker - 0.01) {
      out.push(result(
        "xcheck-pv-breaker-125",
        "PV breaker 125% continuous-output check",
        "warning",
        "warning",
        `PV breaker ${pvBreaker} A is below 125% of the inverters' continuous output (${unitQty} × ${unitAmps} A × 1.25 = ${minBreaker.toFixed(1)} A minimum). Verify the breaker size or the inverter output current.`,
        "pvBreaker",
      ));
    }
  }

  // AC DISCONNECT vs the installer's STANDARD part. Utility portals require a disconnect
  // make and model, and a plan set's equipment schedule specifies only the RATING ("60A
  // NON-FUSIBLE AC DISCONNECT, 240V") — it leaves the part to the installer, so make/model
  // comes from a per-installer default. That default is a CONSTANT while the plan set
  // varies per job, which is exactly where a silent mismatch hides: filing a 30 A
  // non-fusible part against a plan set calling for a 60 A FUSIBLE switch is wrong on the
  // application AND wrong on the roof. Surface the disagreement instead of letting the
  // default quietly win. Observed on real plan sets: two of four called for FUSIBLE while
  // the installer's standard part is non-fusible.
  // The client's standard part reaches this payload from runQcForProject (qc.ts), read from the
  // project's OWN client row; a plan set that names its own disconnect part is filed as named
  // (portalRecipes), so the standard part is not in play and nothing is cross-checked.
  const stdModel = String((payload as Record<string, unknown>).standardDisconnectModel ?? "").trim();
  if (stdModel && !planSetDisconnectPart(payload).named) {
    for (const c of standardDisconnectConflicts(stdModel, { fused: str(payload, "acDiscFused"), amps: num(payload, "acDiscAmps") })) {
      out.push(result(c.ruleId, c.ruleName, "warning", "warning", c.message, c.fieldName));
    }
  }

  // THE APPLICANT MUST BE ON THE UTILITY ACCOUNT.
  // An interconnection application is filed against a SERVICE, and the utility will only
  // accept it from someone listed on that service's account. The homeowner on the plan set
  // and the name printed on the utility bill are two different facts, and when they
  // disagree the application is suspended — not corrected, suspended, with a clock on it.
  //
  // Live: Finley Mockdata' PacifiCorp application (APP-111681) was filed with
  // homeownerName "Finley Mockdata" while the bill we had already parsed read
  // "STEPHANIE MOCKDATA". PacifiCorp's reply: "Finley Mockdata is not listed on the account.
  // They will need to be added to the account as a co-customer or have the electric service
  // put into their name; and/or to have the primary electric account holders name added to
  // the application" — 10 business days to fix or the request may be withdrawn. Both names
  // were in the payload at QC time; nothing compared them.
  //
  // Utility-agnostic: every interconnection portal asks who holds the account.
  const applicantName = str(payload, "homeownerName") || str(payload, "owner");
  const accountHolder = str(payload, "ubAccountHolder");
  const utilityName = str(payload, "utility");
  // A bill read that is not a holder at all — the utility's website ("Pnm.Com", #28), a phone or
  // number line, the utility's own name, a bill label — is not a different person: comparing it
  // told the operator the application would be filed in the name of a web address. Ask for the
  // holder instead. The rejected read is NOT echoed: it may be a number line off the bill.
  if (accountHolder && !isBillHolderName(accountHolder, utilityName)) {
    out.push(result(
      "xcheck-nem-account-holder",
      "Applicant vs utility account holder",
      "warning",
      "warning",
      `Utility account holder not read from the bill — verify. What the bill reader returned is not a person or ` +
        `business (a web address, email, phone or number line, the utility's own name, or a bill label), so it is ` +
        `ignored. Enter the account holder exactly as the bill's customer block prints it: the interconnection ` +
        `application names the account holder${applicantName ? `, and until one is entered it names ${applicantName}` : ""}.`,
      "ubAccountHolder",
    ));
  } else if (applicantName && accountHolder && !namesAgree(applicantName, accountHolder)) {
    out.push(result(
      "xcheck-nem-account-holder",
      "Applicant vs utility account holder",
      "warning",
      "warning",
      `The application names ${applicantName}, but the utility bill's account holder is ${accountHolder}. ` +
        `An interconnection request from someone not listed on the account gets suspended. Before filing, either add ` +
        `the applicant to the account as a co-customer, put the service in their name, or name ${accountHolder} on the ` +
        `application as the account holder. As filed, the interconnection application names ${nemApplicantName(accountHolder, applicantName, utilityName)} ` +
        `(the bill's primary holder — operator ruling 2026-09-28); the permits keep ${applicantName}.`,
      "ubAccountHolder",
    ));
  }

  // PROGRAM AND PERMIT-PATH ELIGIBILITY, AS CITED PER-AUTHORITY DATA (#679). The 25 kW residential
  // net-metering screen that used to be coded here under a state test is now the first shipped row
  // of backend/data/reference-eligibility-limits.json, with the same rule id, name and wording; any
  // utility program or simplified permit path with cited limits screens the same way. The job's
  // state is its own, or — for a payload with none — the AHJ-name inference this function already
  // makes above (the legacy fallback the rest of these screens use).
  const combinedAcKw = num(payload, "combinedAcKw");
  const eligibilityState = usStateCode(state) || (jurisdiction.stateRecord?.state ?? "");
  const eligibilityRecords = eligibility?.records ?? shippedEligibilityRecords().filter((r) => r.state === eligibilityState);
  const findings = evaluateEligibility(eligibilityRecords, {
    state: eligibilityState, utility, ahj,
    programDcKw: screenDcKw,
    programAcKw: combinedAcKw != null && (acKw == null || combinedAcKw > acKw) ? combinedAcKw : acKw,
    combinedNote,
    dcKw, acKw,
    stringsPerInverter: stringsPerInverterOf((k) => num(payload, k)),
    micro: !str(payload, "invModel") && Boolean(str(payload, "pvMicroModel")),
    productionMeterShown: productionMeterShown([split, notes, str(payload, "planSetExtractedText"), str(payload, "meterNotes")]),
    clientCertifications: eligibility?.clientCertifications ?? null,
    today: eligibility?.today ?? new Date().toISOString().slice(0, 10),
  }, { reportUnknownProgram: eligibility?.reportUnknownProgram === true });
  for (const f of findings) out.push(result(f.ruleId, f.ruleName, f.qcStatus, f.severity, f.message, f.fieldName));

  // Export-study screen: threshold from the jurisdiction profile. The DC arm stays at 2x the export
  // limit, matching the legacy export/generation pair. A jurisdiction record may name the screen in its
  // own words (its program's tier names).
  const exportLimit = limits.maxExportKwWithoutStudy;
  if (exportLimit != null && ((screenDcKw != null && screenDcKw > exportLimit * 2) || (exportKw != null && exportKw > exportLimit))) {
    const fill = (t: string) => t.replace(/\{dcKw\}/g, String(screenDcKw ?? "?")).replace(/\{combinedNote\}/g, combinedNote).replace(/\{exportKw\}/g, String(exportKw ?? "?")).replace(/\{limit\}/g, String(exportLimit));
    out.push(result(
      prescriptiveIds.export,
      exportWords ? exportWords.ruleName : `${jurisLabel} export/interconnection study screen`,
      "warning",
      "warning",
      fill(exportWords ? exportWords.message : "Generation/export may exceed the {limit} kW screen ({dcKw} kW DC{combinedNote} / {exportKw} kW export). Confirm the utility study path."),
      "exportKw",
    ));
  }

  // THE JURISDICTION'S MANUAL-DISCONNECT SCREEN (data: a "manual_disconnect" screen on its record).
  for (const screen of jurisdictionScreens(jurisdiction.stateRecord, jurisdiction.cityRecords, "manual_disconnect")) {
    if (/yes|required|provided|shown|lockable|visible/i.test(str(payload, "acDiscReq"))) continue;
    out.push(screenResult(screen, screen.message));
  }

  if (limits.maxGroundSnowPsf != null && (snow == null || snow > limits.maxGroundSnowPsf)) {
    out.push(result(
      prescriptiveIds.snow,
      `${jurisLabel} prescriptive snow limit`,
      "warning",
      "warning",
      snow == null ? "Ground snow load is missing for prescriptive-path screening." : `Ground snow load ${snow} psf exceeds ${jurisLabel} prescriptive ${limits.maxGroundSnowPsf} psf screen.`,
      "snow",
    ));
  }

  if (limits.maxPvDeadLoadPsf != null && (deadLoad == null || deadLoad > limits.maxPvDeadLoadPsf)) {
    out.push(result(
      prescriptiveIds.dead,
      `${jurisLabel} prescriptive dead load limit`,
      "warning",
      "warning",
      deadLoad == null ? "PV dead load is missing for prescriptive-path screening." : `PV dead load ${deadLoad} psf exceeds ${jurisLabel} prescriptive ${limits.maxPvDeadLoadPsf} psf screen.`,
      "deadLoad",
    ));
  }

  if (limits.maxRafterSpacingIn != null && (rafterSpacing == null || rafterSpacing > limits.maxRafterSpacingIn)) {
    out.push(result(
      prescriptiveIds.framing,
      `${jurisLabel} prescriptive roof framing`,
      "warning",
      "warning",
      rafterSpacing == null ? "Roof framing spacing is missing." : `Roof framing spacing ${rafterSpacing} inches exceeds ${jurisLabel} prescriptive ${limits.maxRafterSpacingIn} inch screen.`,
      "roofRafterSpacing",
    ));
  }

  const allowedWind = limits.allowedWindExposures;
  if (allowedWind && allowedWind.length && wind && !allowedWind.some((w) => new RegExp(`\\b${w}\\b`, "i").test(wind))) {
    out.push(result(
      prescriptiveIds.wind,
      `${jurisLabel} prescriptive wind exposure`,
      "warning",
      "warning",
      `Wind exposure "${wind}" should be ${allowedWind.join(" or ")} for the prescriptive path.`,
      "wind",
    ));
  }

  // Fire pathway screen follows the prescriptive screens: any jurisdiction with
  // prescriptive limits recorded (or legacy Oregon) expects pathway evidence.
  const firePathwayScreen = Object.values(limits).some((v) => v != null && (!Array.isArray(v) || v.length > 0));
  if (firePathwayScreen && !hasAny(`${split}\n${notes}`, [/fire/i, /pathway/i, /access path/i, /escape path/i, /site.*plan/i])) {
    out.push(result(
      prescriptiveIds.fire,
      `${jurisLabel} PV firefighter pathways`,
      "warning",
      "warning",
      "No site/fire pathway evidence found. Confirm required firefighter access and escape pathways are shown.",
      "splitPagesText",
    ));
  }

  // THE JURISDICTION'S SUBMITTAL-DOCUMENT LIST (data: a "submittal_documents" screen, usually a city's).
  for (const screen of jurisdictionScreens(jurisdiction.stateRecord, jurisdiction.cityRecords, "submittal_documents")) {
    const missing = (screen.items ?? []).filter((item) => !SUBMITTAL_SHOWN[item.key](split, notes)).map((item) => item.label);
    if (missing.length) out.push(screenResult(screen, screen.message.replace(/\{missing\}/g, missing.join(", "))));
  }

  // WHAT THE JOB'S UTILITY'S OWN APPLICATION ASKS FOR, as cited per-utility data (utilityRequirements.ts),
  // read by one generic rule — no utility is named here. A utility with no list on file gets the strict
  // default (the strictest common set), as a warning that says it is not researched.
  out.push(...utilityRequirementResults(payload, state, utility, split, notes, utilityCtx));

  // EXISTING-SYSTEM / NEM-ADDITION SCREENS (advisory — warnings only, never a
  // blocker). Additions must disclose the existing system on interconnection
  // applications; screen for the disclosure data being present and for the CA
  // NEM1/NEM2 grandfathering expansion allowance.
  const hasExisting = /^yes$/i.test(str(payload, "hasExistingSystem")) || /^yes$/i.test(str(payload, "existingSystem"));
  if (hasExisting) {
    const existingDcKw = num(payload, "existingDcKw");
    const existingInvMake = str(payload, "existingInvMake") || str(payload, "existingInverterMake");
    const existingInvModel = str(payload, "existingInvModel") || str(payload, "existingInverterModel");
    const disclosureMissing: string[] = [];
    if (existingDcKw == null) disclosureMissing.push("existing system DC size (existingDcKw)");
    if (!existingInvMake || !existingInvModel) disclosureMissing.push("existing inverter make/model");
    if (combinedDcKw == null) disclosureMissing.push("combined (existing + new) DC size (combinedDcKw)");
    if (disclosureMissing.length) {
      out.push(result(
        "existing-system-disclosure",
        "Existing-system disclosure",
        "warning",
        "warning",
        `Addition to an existing system: interconnection applications must disclose the existing system, but these are missing: ${disclosureMissing.join(", ")}. Enter them from the plan set / prior NEM paperwork.`,
        "existingDcKw",
      ));
    }

    const agreementNumber =
      str(payload, "existingNemAgreementNumber") || str(payload, "nemAgreementNumber") || str(payload, "agreementNumber");
    if (!agreementNumber) {
      out.push(result(
        "existing-system-nem-agreement",
        "Existing NEM agreement number",
        "warning",
        "warning",
        "Addition to an existing system: the NEM/interconnection application usually asks for the EXISTING interconnection agreement number, and none was captured. Pull it from the prior PTO letter / NEM agreement.",
        "existingNemAgreementNumber",
      ));
    }

    // CA NEM1/NEM2 grandfathering: a legacy-tariff system generally keeps its
    // grandfathered status only within a ONE-TIME expansion allowance of
    // max(1 kW, 10% of the existing size). A larger addition can move the whole
    // system to the current tariff (NEM3/NBT). Advisory only.
    const nemTariff = str(payload, "nemTariff") || str(payload, "existingNemTariff");
    if (/nem\s*-?\s*[12]\b|nem\s*-?\s*2\.0|nem\s*-?\s*1\.0/i.test(nemTariff) && existingDcKw != null && combinedDcKw != null) {
      const additionKw = combinedDcKw - existingDcKw;
      const allowanceKw = Math.max(1, 0.10 * existingDcKw);
      if (additionKw > allowanceKw) {
        out.push(result(
          "existing-system-nem-grandfathering",
          "NEM grandfathering expansion allowance",
          "warning",
          "warning",
          `Existing system is on ${nemTariff}: the addition of ${additionKw.toFixed(2)} kW DC exceeds the one-time expansion allowance of ${allowanceKw.toFixed(2)} kW (greater of 1 kW / 10% of the existing ${existingDcKw} kW). The expansion may forfeit grandfathered NEM status and move the whole system to the current tariff — confirm with the utility before submitting.`,
          "combinedDcKw",
        ));
      }
    }
  }

  return out;
}

// ── THE UTILITY'S APPLICATION REQUIREMENTS, CHECKED ON THE PACKAGE (QC) ─────────────────────────
// What QC reads for each KIND of item: the package text the plan-set split and the upload notes carry,
// and the parser's account / meter fields. Kinds, never utilities.
type QcReadInput = { payload: ParserPayload; split: string; notes: string; newPv: boolean; disconnectPart: string; disconnectNamed: boolean; sbOnCecList: boolean; settingsByStandingAnswer: boolean };
const QC_SHOWN: Record<UtilityRequirementKey, (t: QcReadInput) => boolean> = {
  account_verification: ({ payload }) => Boolean(str(payload, "account") || str(payload, "ubAccountNumber")),
  meter_photo: ({ payload }) => Boolean(str(payload, "meter") || str(payload, "ubMeterNumber")),
  // The operator's standing answer (installs are commissioned with the utility's settings) on an
  // inverter the CEC list certifies to UL 1741 SB answers it (owner, 2026-11-13).
  inverter_settings: ({ split, notes, settingsByStandingAnswer }) => settingsByStandingAnswer || hasAny(`${split}\n${notes}`, [/UL\s*1741\s*SB/i, /inverter settings/i, /smart inverter/i]),
  // VERIFIED FIRST (owner, 2026-11-13): the CEC's own list printing UL 1741 SB "Y" for the job's inverter
  // answers the listing, so the package text need not say it again. Settings (inverter_settings) are a
  // different question the list does not answer.
  inverter_listing_ul1741sb: ({ split, notes, sbOnCecList }) => sbOnCecList || hasAny(`${split}\n${notes}`, [/UL\s*1741\s*SB/i]),
  // A ONE-LINE DIAGRAM IS AN SLD: "one-line", "one line", "1-line" and "single-line" name the same sheet,
  // so a package that calls it only that must not read as missing it.
  one_line: ({ split }) => hasAny(split, [/SLD/i, /3-line/i, /single line/i, /\b(?:one|1|single)[\s-]line\b/i]),
  site_plan: ({ split }) => hasAny(split, [/site/i, /plot/i]),
  module_spec: ({ split }) => hasAny(split, [/module/i]),
  // On a scope that adds no modules the inverter is the battery inverter / PCS (#673's storage rows), whose
  // sheet may name it only that.
  inverter_spec: ({ split, newPv }) => hasAny(split, newPv ? [/inverter/i, /microinverter/i] : [/inverter/i, /microinverter/i, /\bPCS\b/i, /power conversion/i]),
  // The job's part that its own plan set names counts (acDisconnectIntake.capturedDisconnectPart, the
  // ONE reader the reviewer gate's acDisconnect topic uses too; qc.ts hands its answer in, with the
  // plan-set text the gate sees); or that plan-set text names an AC / utility disconnect in the gate's
  // own wordings (the one list, also handed in by qc.ts, #134); else the package text names a disconnect.
  ac_disconnect: ({ split, notes, disconnectPart, disconnectNamed }) => Boolean(disconnectPart) || disconnectNamed || hasAny(`${split}\n${notes}`, [/disconnect/i]),
  // The job's own operating-mode field counts (the one reader QC's storage row and the reviewer gate use).
  storage_mode_declaration: ({ payload, split, notes }) => Boolean(storageOperatingMode(payload)) || hasAny(`${split}\n${notes}`, [/operating mode/i, /back[-\s]?up/i, /self[-\s]?consumption/i, /export/i]),
  owner_signature: ({ split, notes }) => hasAny(`${split}\n${notes}`, [/signature/i, /signed/i, /owner authorization/i]),
};
const QC_LABEL: Record<UtilityRequirementKey, string> = {
  account_verification: "utility account",
  meter_photo: "meter evidence",
  inverter_settings: "UL 1741 SB / inverter settings evidence",
  inverter_listing_ul1741sb: "UL 1741 SB inverter listing",
  one_line: "SLD/3-line",
  site_plan: "site/plot plan",
  module_spec: "module spec",
  inverter_spec: "inverter spec",
  ac_disconnect: "AC disconnect",
  storage_mode_declaration: "battery operating mode",
  owner_signature: "owner signature",
};
// An item with no QC wording of its own reports in this one generic result.
const GENERIC_QC = {
  ruleId: "utility-application-package",
  ruleName: "{utility} application package",
  message: "{utility}'s application may be missing: {missing}.",
  fieldName: "utilityDownloadChecklistText",
};

function fill(template: string, utility: string, missing: string[]): string {
  return template.replaceAll("{utility}", utility).replaceAll("{missing}", missing.join(", "));
}

/**
 * ONE GENERIC RULE: each item of the job's utility's list (or, with none on file and
 * `reportUnresearched`, the strict default) that the package does not show. Items sharing a QC rule id
 * report as one result naming each missing item. A WARNING, unless every condition for a block holds:
 * the item's QC wording asks for a blocker AND the item may block (a person's, an official one, or a
 * seeded row quoting its named source in words that name it — Helm's #637 bar). A storage item is
 * checked only on a battery job.
 */
function utilityRequirementResults(payload: ParserPayload, state: string, utility: string, split: string, notes: string, ctx: BaselineUtilityContext): BaselineQcResult[] {
  if (!utility) return [];
  const list = ctx.requirements === undefined ? resolveUtilityRequirements(null, state, utility) : ctx.requirements;
  let items: UtilityApplicationRequirement[];
  let name: string;
  if (list && list.requirements.length) {
    items = list.requirements;
    name = list.displayName || utility;
  } else if (ctx.reportUnresearched && usStateCode(state)) {
    items = strictDefaultRequirements();
    name = utility;
  } else {
    return [];
  }
  const battery = batteryStatus(payload as Record<string, unknown>) === "yes";
  // WHAT THE JOB INSTALLS (#673): a job that adds no modules is never asked for a module spec, and its
  // inverter is the battery inverter / PCS.
  const newPv = scopeHasNewPv(ctx.scope ?? deriveJobScope(payload).scope);
  const read: QcReadInput = { payload, split, notes, newPv, disconnectPart: String(ctx.disconnectPartOnPlanSet ?? "").trim(), disconnectNamed: ctx.planSetNamesAcDisconnect === true, sbOnCecList: ctx.inverterUl1741SbOnCecList === true, settingsByStandingAnswer: ctx.inverterSettingsByStandingAnswer === true };
  const groups = new Map<string, { qc: { ruleId: string; ruleName: string; message: string; fieldName: string }; order: number; first: number; missing: string[]; block: boolean }>();
  items.forEach((item, index) => {
    if (!requirementForGate(item, "qc")) return;
    if (item.key === "storage_mode_declaration" && !battery) return;
    if (item.key === "module_spec" && !newPv) return;
    if (QC_SHOWN[item.key](read)) return;
    const qc = item.qc ?? GENERIC_QC;
    const held = groups.get(qc.ruleId) ?? { qc, order: item.qc?.order ?? 100, first: index, missing: [], block: false };
    const label = item.qc?.label || QC_LABEL[item.key];
    // On a job that adds no modules the generic "inverter spec" is worded as what it is there (the battery
    // inverter / PCS); a record's own, different wording stays as written.
    held.missing.push(item.key === "inverter_spec" && !newPv && label === QC_LABEL.inverter_spec ? "battery inverter / PCS spec" : label);
    if (item.qc?.severity === "blocker" && requirementMayBlock(item)) held.block = true;
    groups.set(qc.ruleId, held);
  });
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.first - b.first)
    .map((g) => result(
      g.qc.ruleId,
      fill(g.qc.ruleName, name, g.missing),
      g.block ? "fail" : "warning",
      g.block ? "blocker" : "warning",
      fill(g.qc.message, name, g.missing),
      g.qc.fieldName,
    ));
}

// ── EACH JURISDICTION'S SCREENS, READ BY KIND (jurisdictionQcRules.ts) ──────────────────────────────
// What the package must show for each item a submittal-documents screen can ask for. Kinds, never places.
const SUBMITTAL_SHOWN: Record<SubmittalItemKey, (split: string, notes: string) => boolean> = {
  site_plan: (split) => hasAny(split, [/site/i, /plot/i]),
  fire_access_path: (split, notes) => hasAny(`${split}\n${notes}`, [/fire/i, /pathway/i, /access path/i]),
  roof_framing: (split) => hasAny(split, [/roof/i, /framing/i]),
  roof_cross_section: (split) => hasAny(split, [/section/i, /cross/i]),
  racking_attachment: (split) => hasAny(split, [/rack/i, /mount/i, /attachment/i]),
};

/** The screens of one kind the job's state record and city records carry, state first. */
function jurisdictionScreens(stateRecord: JurisdictionQcRecord | null, cityRecords: JurisdictionQcRecord[], kind: JurisdictionQcScreen["kind"]): JurisdictionQcScreen[] {
  return [stateRecord, ...cityRecords].flatMap((r) => (r ? r.screens.filter((s) => s.kind === kind) : []));
}

/** A screen's result: a blocker only when it asks for one and passes the #637 bar; else a warning. */
function screenResult(screen: JurisdictionQcScreen, message: string): BaselineQcResult {
  const blocks = screen.severity === "blocker" && jurisdictionScreenMayBlock(screen);
  return result(screen.ruleId, screen.ruleName, blocks ? "fail" : "warning", blocks ? "blocker" : "warning", message, screen.fieldName);
}
