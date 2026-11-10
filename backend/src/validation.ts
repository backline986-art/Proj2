// Runtime request-body validation using Zod.
// Import the schema and call .safeParse(req.body) — on failure, throw HttpError(400)
// with the first validation message so the client always gets a clear error.

import { z } from "zod";
import { HttpError } from "./httpError";

export { z };

export function validate<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues;
    const first = issues[0];
    const field = first.path.length ? first.path.join(".") : "body";
    throw new HttpError(400, `${field}: ${first.message}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const portalCredentialCreateSchema = z.object({
  portalType: z.string().max(120).optional(),
  portalUrl: z.string().url("portalUrl must be a valid URL").max(1000).or(z.literal("")).optional(),
  username: z.string().min(1, "username is required").max(320),
  password: z.string().min(1, "password is required").max(1024),
  notes: z.string().max(2000).optional(),
  // The per-portal kickoff answers (migration v18). Declared here because zod STRIPS every key a
  // schema does not name: until these three were listed, a POST or PUT carrying them answered
  // 201/200 and stored nothing. feeResponsibility is a plain string ON PURPOSE — its vocabulary
  // has exactly one gate, normalizeFeeResponsibility in portalCredentials.ts (400 on anything
  // else), and a second list here would be a second predicate that can drift from it.
  mfaRequired: z.boolean().optional(),
  mfaCodeDestination: z.string().max(500).optional(),
  feeResponsibility: z.string().max(40).optional(),
});

export const portalCredentialUpdateSchema = z.object({
  portalType: z.string().max(120).optional(),
  portalUrl: z.string().url("portalUrl must be a valid URL").max(1000).or(z.literal("")).optional(),
  username: z.string().max(320).optional(),
  password: z.string().max(1024).optional(),
  notes: z.string().max(2000).optional(),
  // Same three as the create schema. Optional and stripped-when-absent, which is exactly the
  // `key in payload` semantics updatePortalCredential needs: an omitted answer is kept.
  mfaRequired: z.boolean().optional(),
  mfaCodeDestination: z.string().max(500).optional(),
  feeResponsibility: z.string().max(40).optional(),
});

// scope: the frontend sends "ahj" or "utility"; "permit"/"nem" accepted as aliases.
export const autoLearnSchema = z.object({
  scope: z.enum(["ahj", "permit", "utility", "nem"]).optional(),
  portalUrl: z.string().url().max(1000).optional(),
  createdBy: z.string().max(120).optional(),
  // For AHJ portals where one address resolves to both a city and a county authority
  // (e.g. Accela / Oregon ePermitting), which permit discipline this pass files.
  permitType: z.enum(["structural", "electrical"]).optional(),
});

// --- Jurisdiction code profiles (review gate) --------------------------------
export const codeProfileResearchSchema = z.object({
  state: z.string().min(2, "state is required").max(40),
  ahj: z.string().max(160).optional().default(""),
});

// A calendar day ("2025-01-18"), checked as a real date: an edition's phase-in reads these.
const isoDay = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date, YYYY-MM-DD")
  .refine((d) => { const t = Date.parse(`${d}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d; }, "must be a real calendar date");
// EFFECTIVE DATES (#561): the verify route kept only code/edition/title/source/notes, so a person
// could not record when an edition took effect, when it became mandatory, or which edition it
// replaced — and the edition phase-in (codeFamilies.editionsInEffect) could never apply.
const codeEditionSchema = z.object({
  code: z.string().min(1).max(24),
  edition: z.string().min(1).max(12),
  title: z.string().max(240).optional(),
  sourceUrl: z.string().max(500).optional(),
  notes: z.string().max(500).optional(),
  effectiveDate: isoDay.optional(),
  mandatoryDate: isoDay.optional(),
  previousEdition: z.string().trim().min(1).max(12).optional(),
}).refine((c) => !c.effectiveDate || !c.mandatoryDate || c.mandatoryDate >= c.effectiveDate, {
  message: "mandatoryDate cannot be before effectiveDate", path: ["mandatoryDate"],
});

// A PERSON VERIFIES OR REPLACES AN AHJ'S PERMIT-PROCESS LOOKUP (#560). No `permits`: verify the row
// as it stands. `permits`: the person's list replaces the row's (permitProcess.verifyPermitProcessLookup).
// No portal and no fee field: the portal door and the fee path are their own (rule 5, fee research).
const personFactUrl = z.string().trim().max(500).regex(/^https?:\/\//i, "must be the http(s) page the fact was read on");
export const permitProcessVerifySchema = z.object({
  verifiedBy: z.string().max(120).optional(),
  permits: z.array(z.object({
    discipline: z.enum(["structural", "electrical", "combo", "other"]),
    label: z.string().max(160).optional(),
    issuingAgency: z.object({ value: z.string().trim().min(1).max(300), sourceUrl: personFactUrl, quote: z.string().max(300).optional() }).optional(),
    recordType: z.object({ value: z.string().trim().min(1).max(300), sourceUrl: personFactUrl, quote: z.string().max(300).optional() }).optional(),
    documents: z.object({ value: z.array(z.string().trim().min(1).max(300)).min(1).max(40), sourceUrl: personFactUrl, quote: z.string().max(300).optional() }).optional(),
  })).min(1).max(6).optional(),
});

// #664: a named person verifies the project's utility filing row — as it stands, or stating that the
// utility takes its application inside the AHJ permit application (a method, never a URL: rule 5).
export const utilityFilingVerifySchema = z.object({
  verifiedBy: z.string().max(120).optional(),
  filedWithPermit: z.object({
    name: z.string().trim().max(160).optional(),
    sourceUrl: personFactUrl,
    quote: z.string().trim().min(8).max(300),
    documents: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  }).strict().optional(),
});

/** PUT /api/projects/:id/job-scope (#673): a named person sets what the job installs, or clears it
 *  (scope null) so the plan set's evidence decides again. */
export const jobScopeSchema = z.object({
  scope: z.enum(["pv", "pv+storage", "storage-added-to-existing-pv", "storage-only"]).nullable(),
  decidedBy: z.string().max(120).optional(),
}).strict();

/** PUT /api/projects/:id/utility-track/keep (draft 10): a named person puts the utility track back on
 *  this job (keep: true) though a person's storage record drops it, or lets the record drop it again. */
export const nemTrackKeepSchema = z.object({
  keep: z.boolean(),
  decidedBy: z.string().max(120).optional(),
}).strict();

/** PUT /api/projects/:id/utility-filing/storage-modes (#673 item 3): a named person records which
 *  storage modes this project's utility takes NO application for, with the page and its words. */
export const utilityStorageModesSchema = z.object({
  modesWithoutApplication: z.array(z.enum(["export", "non-export", "backup-only"])).min(1).max(3),
  sourceUrl: personFactUrl,
  quote: z.string().trim().min(8).max(300),
  decidedBy: z.string().max(120).optional(),
}).strict();

/** PUT /api/projects/:id/utility-filing/application-requirements (review-audit draft 03): a named person
 *  records what this project's utility's own application asks for, each item with the page and its words. */
export const utilityApplicationRequirementsSchema = z.object({
  requirements: z.array(z.object({
    key: z.enum(["account_verification", "meter_photo", "inverter_settings", "inverter_listing_ul1741sb", "one_line", "site_plan", "ac_disconnect", "storage_mode_declaration", "owner_signature"]),
    whenMissing: z.enum(["blocker", "warning"]),
    sourceName: z.string().trim().max(200).optional(),
    sourceUrl: personFactUrl,
    quote: z.string().trim().min(8).max(600),
  }).strict()).min(1).max(12),
  decidedBy: z.string().max(120).optional(),
}).strict();

export const codeProfileVerifySchema = z.object({
  state: z.string().min(2).max(40),
  ahj: z.string().max(160).optional().default(""),
  adoptedCodes: z.array(codeEditionSchema).max(16).default([]),
  amendments: z.array(z.object({
    code: z.string().min(1).max(24),
    section: z.string().max(60).optional(),
    summary: z.string().min(1).max(500),
    sourceUrl: z.string().max(500).optional(),
  })).max(30).default([]),
  designCriteria: z.object({
    groundSnowLoadPsf: z.number().finite().optional(),
    // Allowable-stress pg(asd): the type always had it; the verify panel dropped it (#211).
    groundSnowLoadAsdPsf: z.number().finite().optional(),
    roofSnowLoadPsf: z.number().finite().optional(),
    windSpeedMph: z.number().finite().optional(),
    windExposure: z.string().max(8).optional(),
    specialWindRegion: z.boolean().optional(),
    seismicDesignCategory: z.string().max(8).optional(),
    frostDepthIn: z.number().finite().optional(),
    riskCategory: z.string().max(8).optional(),
    weathering: z.enum(["negligible", "moderate", "severe"]).optional(),
    termite: z.string().max(120).optional(),
    soilBearingPsf: z.number().finite().optional(),
    sourceUrl: z.string().max(500).optional(),
  }).default({}),
  prescriptive: z.object({
    maxGroundSnowPsf: z.number().finite().optional(),
    // The minimum ground snow load Pg a design may use, by permit path (Oregon: ORSC 2023
    // R301.2.3.1 — 36 psf prescriptive, 25 psf non-prescriptive), and where it comes from.
    minGroundSnowPsfPrescriptive: z.number().finite().positive().max(400).optional(),
    minGroundSnowPsfEngineered: z.number().finite().positive().max(400).optional(),
    minGroundSnowCitation: z.string().max(200).optional(),
    maxPvDeadLoadPsf: z.number().finite().optional(),
    maxRafterSpacingIn: z.number().finite().optional(),
    allowedWindExposures: z.array(z.string().max(4)).max(6).optional(),
    maxExportKwWithoutStudy: z.number().finite().optional(),
    engineerStampOverKwDc: z.number().finite().optional(),
  }).default({}),
  fireSetbacks: z.array(z.object({
    id: z.string().min(1).max(60),
    description: z.string().min(1).max(500),
  })).max(20).default([]),
  // The battery (ESS) rules a person checked against their cited sources (review-audit draft 05).
  // Optional: a verify that sends none stores none (codeProfiles.upsert).
  essRules: z.object({
    maxUnitKwh: z.number().finite().positive().max(10000).optional(),
    maxAggregateKwhUtilitySpace: z.number().finite().positive().max(10000).optional(),
    maxAggregateKwhGarage: z.number().finite().positive().max(10000).optional(),
    maxAggregateKwhAccessory: z.number().finite().positive().max(10000).optional(),
    maxAggregateKwhExteriorWall: z.number().finite().positive().max(10000).optional(),
    maxAggregateKwhOutdoor: z.number().finite().positive().max(10000).optional(),
    minUnitSpacingIn: z.number().finite().positive().max(10000).optional(),
    spacingReductionBy9540A: z.boolean().optional(),
    minOpeningClearanceIn: z.number().finite().positive().max(10000).optional(),
    listingRequired: z.boolean().optional(),
    habitableLocationProhibited: z.boolean().optional(),
    impactProtectionInGarage: z.boolean().optional(),
    alarmRequired: z.boolean().optional(),
    wallProtectionRequired: z.boolean().optional(),
    disconnectOutside: z.boolean().optional(),
    listedResidentialExemption: z.boolean().optional(),
  }).optional(),
  citations: z.array(z.object({
    label: z.string().max(200),
    sourceUrl: z.string().min(1).max(500),
    // Which value a citation backs ("essRules.maxUnitKwh") and the source's own words: a battery rule
    // blocks only when its citation quotes the value (Helm's #637 bar), so a verify keeps both.
    field: z.string().max(80).optional(),
    quote: z.string().max(600).optional(),
  })).max(30).default([]),
});

// --- Standalone review submissions (review gate) ------------------------------
export const reviewSubjectSchema = z.object({
  workType: z.enum(["solar_pv_residential", "reroof", "water_heater", "adu", "deck", "general"]).default("general"),
  state: z.string().min(2, "state is required").max(40),
  ahj: z.string().min(1, "ahj is required").max(160),
  utility: z.string().max(160).optional(),
  applicant: z.object({
    name: z.string().max(200).optional(),
    address: z.string().max(300).optional(),
    city: z.string().max(120).optional(),
    zip: z.string().max(20).optional(),
  }).optional(),
  system: z.object({
    sizeDcKw: z.number().finite().optional(),
    sizeAcKw: z.number().finite().optional(),
    interconnectionMethod: z.string().max(200).optional(),
  }).optional(),
  fields: z.record(z.string(), z.union([z.string().max(30000), z.number(), z.null()])).optional(),
});
