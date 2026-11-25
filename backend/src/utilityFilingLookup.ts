// ---------------------------------------------------------------------------
// WHERE THE UTILITY APPLICATION IS FILED — and what the utility's program IS.
//
// New-AHJ e2e (2026-09-26): "utility filing location" was 0/6. Every utility track said
// "Utility NEM portal" and was labelled "Utility net metering (NEM)", including Oncor (a
// Texas wires-only distribution utility: no utility net metering — any export credit is the
// customer's retail provider's) and SRP (export-credit price plans, not net metering). The
// real answers were public: FirstEnergy's page names its own interconnection portal, SRP and
// Eversource say PowerClerk, Oncor names its installer portal.
//
// One web-grounded lookup per UTILITY (shared knowledge, like permit_process_lookups: a
// utility's filing location learned once helps every tenant), with the per-job permit
// lookup's discipline:
//   - every answer carries a source URL the search returned or a page the model opened, and the
//     page's own words, which must themselves state the answer — or it is NOT FOUND;
//   - a portal URL is kept only when its OWN host was attested by the search, it is somewhere an
//     application is filed (never a help page or a PDF), and it fits the NEM track (hard rule 5:
//     a city/county PERMIT portal is never a utility filing location — portalChannel's one
//     predicate, hostFitsTrackAndEntity);
//   - nothing from model memory is kept (an ungrounded answer is NOT FOUND);
//   - a person's VERIFIED row is never overwritten by a lookup (hard rule 3).
// The track is labelled by what the program IS — net metering only when a cited page says so.
// ---------------------------------------------------------------------------

import type { SiteVouch } from "../../shared/src/types";
import { isOfficialSourceHost } from "../../shared/src/officialSource";
import { findSiteVouches, mergeVouches } from "./governmentVouches";
import type { AppDb } from "./db";
import type { CitedFact, EligibilityLimits, LLMProvider, ProjectRecord, WebLookupResult } from "../../shared/src/types";
import { hostFitsTrackAndEntity, isInformationalPageUrl, namedInterconnectionPlatforms, portalHostOf } from "./portalChannel";
import { logger } from "./logger";
import { knownPowerClerkUtility } from "./utilityIdentity";
import { isVerifiedKnowledge, knowledgeProfileKey } from "./knowledgeBase";
import { portalEntityEvidence } from "./portalRecipes";
import { acceptProposedLimits, landLookupEligibilityRecord, type RetrievedLimitPage } from "./eligibilityLimits";
// Text constants only (the prompt); the landing is imported where it runs, so this module and
// utilityRequirements.ts (which reads this one's keys) never load each other at start-up.
import { UTILITY_REQUIREMENTS_RESEARCH_RULE, UTILITY_REQUIREMENTS_RESEARCH_SCHEMA } from "./utilityRequirementsResearchPrompt";
import type { UtilityRequirementsLanding } from "./utilityRequirementsResearch";
import type { UtilityFeeLanding } from "./utilityFeeLanding";
import type { PageReader, ReadPage } from "./agencyPageReader";
import { quoteStatesFee, quoteStatesReviewTime } from "./citedReviewTime";

export type UtilityProgramKind = "net_metering" | "net_billing" | "interconnection_only";
/**
 * HOW the application is filed, when that is not "on a portal of the utility's own" (#664).
 *
 * "with_ahj_permit": the utility takes its interconnection / net-metering application INSIDE the
 * AHJ's permit application — one application in the city's permit system carries the building
 * permit and the net-metering paperwork (municipal utilities in many states). It NEVER carries a URL:
 * nothing is resolved or launched on the NEM track (hard rule 5 untouched — this is not the rule-5
 * carve-out of a NEM run on the city's host; it is no NEM run at all). A SEEDED row with this method is
 * a proposal: only a person's VERIFIED row switches the NEM track to it (nemFiledWithPermit, rule 3).
 */
export type UtilityFilingMethod = "with_ahj_permit";
export const FILED_WITH_AHJ_PERMIT: UtilityFilingMethod = "with_ahj_permit";
export interface UtilityFilingLocation {
  /** The portal or method as the utility names it ("PowerClerk", "Interconnection Portal", "email"). */
  name: string;
  /** The application portal's own entry URL — null when the utility names a method, not a URL. */
  url: string | null;
  /** Set only for a method that is not a portal (#664). A with-permit location's url is always null. */
  method?: UtilityFilingMethod;
  /** With-permit only: the utility's own documents its page lists for the application that rides in
   *  the permit packet ("net metering agreement signed by the property owner", "one-line diagram on
   *  our form"), in its words. Absent when the page lists none. */
  documents?: string[];
}
/** The filing fact as stored. `droppedUrls` (PR #369, review round 4): the filing URL(s) the answer
 *  named that the door (acceptFilingUrl) did NOT keep — a permit vendor's portal, a host the search
 *  never returned, a page off the platform the answer names. Kept as EVIDENCE of where the utility's
 *  own lookup says it files (infoPages reads it as caution, and by host), never as a portal: nothing
 *  resolves, shows or launches it. Rows written before round 4 do not carry it. */
export type UtilityFilingFact = CitedFact<UtilityFilingLocation> & { droppedUrls?: string[] };
export interface UtilityFee { label: string; amountUsd: number }
export interface UtilityServiceArea {
  /** The other utilities the page names as serving some locations of this one's area. */
  sharedWith: string[];
  /** Where the page says to check an address (its service-area map), when it names one. */
  mapUrl?: string;
}
export interface UtilityFilingLookup {
  profileKey: string;
  state: string;
  utility: string;
  confidence: "seeded" | "verified";
  filing: UtilityFilingFact;
  program: CitedFact<UtilityProgramKind>;
  /** The program in the utility's own words ("Customer Generation", "Net Metering Rider"). */
  programName?: string;
  /** The utility's own fees for a residential application (lookup-battery-and-fees), each cited, the
   *  quote printing the amount. Display (the utility track) and available to pricing; never a gate. */
  fees?: Array<CitedFact<UtilityFee>>;
  /** The review time the utility's page states, cited. Display only. */
  reviewTime?: CitedFact<string>;
  /** A SHARED SERVICE AREA (bot-vs-research 2026-11-10, a co-op and an investor-owned utility in one
   *  city): the utility's own page says some locations are served by another utility, and where to check
   *  an address (its map). Cited; a warning on the utility track, never a decision. */
  serviceArea?: CitedFact<UtilityServiceArea>;
  /** Pages Keelix's reader was refused (403 / challenge / back-off): a person reads them in a browser. */
  needsPersonRead?: Array<{ url: string; reason: string }>;
  /** CITED FEES THAT DID NOT LAND IN THE FEE SCHEDULE and need a person (utilityFeeLanding: two
   *  application fees, a fee by size or level, a page Keelix could not re-read, a difference from the
   *  fee on file). Shown on the fee quote; never a number Keelix charges. */
  feesHeld?: Array<{ label: string; amountUsd: number; sourceUrl: string; reason: string }>;
  /** Government pages that link this utility's own non-government site (governmentVouches.ts). */
  siteVouches?: SiteVouch[];
  lookedUpAt: string;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** "PGE", "Portland General Electric Co." → normalized words. EXACT key, no fuzzy bridge. */
export function normalizeUtilityName(utility: string): string {
  return str(utility).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|co|corp|company|llc)\b/g, " ").replace(/\s+/g, " ").trim();
}
export function utilityFilingKey(state: string, utility: string): string {
  return `${str(state).toLowerCase()}|${normalizeUtilityName(utility)}`;
}

// ── Store: the utility_filing_lookups table is created by db.ts migration v37 (never lazily
// here — a CREATE TABLE inside a read path broke the "reads write nothing" invariant). ──────────

function rowToLookup(row: Record<string, unknown> | undefined | null): UtilityFilingLookup | null {
  if (!row) return null;
  try {
    const payload = JSON.parse(str(row.payload_json) || "{}") as UtilityFilingLookup;
    return {
      ...payload,
      profileKey: str(row.profile_key),
      confidence: row.verified_at ? "verified" : "seeded",
      verifiedAt: row.verified_at ? str(row.verified_at) : null,
      verifiedBy: row.verified_by ? str(row.verified_by) : null,
    };
  } catch {
    return null;
  }
}

export function getUtilityFilingLookup(db: AppDb, state: string, utility: string): UtilityFilingLookup | null {
  if (!normalizeUtilityName(utility)) return null;
  try {
    return rowToLookup(db.get<Record<string, unknown>>("SELECT * FROM utility_filing_lookups WHERE profile_key = ?", [utilityFilingKey(state, utility)]));
  } catch {
    return null;
  }
}

/** THE WRITE PATH. A lookup lands 'seeded'; a person's verified row is never overwritten by one. */
export function saveUtilityFilingLookup(
  db: AppDb,
  input: Omit<UtilityFilingLookup, "profileKey" | "confidence"> & { confidence?: "seeded" | "verified" },
  opts: { verifiedBy?: string } = {},
): { saved: boolean; reason: string; lookup: UtilityFilingLookup | null } {
  if (!normalizeUtilityName(input.utility)) return { saved: false, reason: "no utility name", lookup: null };
  const key = utilityFilingKey(input.state, input.utility);
  const existing = db.get<Record<string, unknown>>("SELECT * FROM utility_filing_lookups WHERE profile_key = ?", [key]);
  const wantsVerified = input.confidence === "verified" && Boolean(opts.verifiedBy);
  if (existing?.verified_at && !wantsVerified) {
    return { saved: false, reason: "a person verified this utility's filing location; a lookup never overwrites it", lookup: rowToLookup(existing) };
  }
  const now = new Date().toISOString();
  const payload: UtilityFilingLookup = { ...input, profileKey: key, confidence: wantsVerified ? "verified" : "seeded", lookedUpAt: input.lookedUpAt || now };
  db.run(
    `INSERT INTO utility_filing_lookups (profile_key, state, utility, confidence, payload_json, looked_up_at, updated_at, verified_at, verified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_key) DO UPDATE SET state = excluded.state, utility = excluded.utility, confidence = excluded.confidence,
       payload_json = excluded.payload_json, looked_up_at = excluded.looked_up_at, updated_at = excluded.updated_at,
       verified_at = excluded.verified_at, verified_by = excluded.verified_by`,
    [key, input.state, input.utility, payload.confidence, JSON.stringify(payload), payload.lookedUpAt, now,
      wantsVerified ? now : null, wantsVerified ? String(opts.verifiedBy) : null],
  );
  return { saved: true, reason: payload.confidence, lookup: getUtilityFilingLookup(db, input.state, input.utility) };
}

// ── FILED WITH THE AHJ PERMIT APPLICATION (#664) ──────────────────────────────────────────────
/** A utility that takes its application inside the AHJ's permit application, as a PERSON verified it. */
export interface NemFiledWithPermit {
  state: string;
  utility: string;
  /** The method in the utility's words ("City building permit application"). */
  name: string;
  sourceUrl: string;
  quote: string;
  /** The utility's own documents for the application, as the verified row lists them ([] = none listed). */
  documents: string[];
  verifiedBy: string;
  verifiedAt: string;
}

/**
 * THE ONE ANSWER to "does this job's NEM application ride in the permit application?" (#664) — read by
 * the NEM track card (status follows the permit, no portal), Stage (refuses the NEM track: there is no
 * separate filing to stage), autopilot (skips it), nextStep (the NEM track is filed when the permit is)
 * and the document inventory (its documents join the permit packet).
 *
 * ONLY A PERSON'S VERIFIED ROW (hard rule 3 / Helm's strictest baseline): a seeded lookup that says
 * "with the permit" is a proposal, and the track stays "filing location not yet identified" with a
 * human step, exactly as an unknown utility does. The row must cite its page, and it never carries a
 * URL (rule 5: nothing is resolved or launched on the NEM track). Fees and the owner's signature stay
 * human whichever way the application travels (rule 1). A read: writes nothing.
 */
export function filedWithPermitOf(lookup: UtilityFilingLookup | null | undefined): NemFiledWithPermit | null {
  if (!lookup || lookup.confidence !== "verified" || !lookup.verifiedAt) return null;
  const v = lookup.filing?.value;
  if (!v || v.method !== FILED_WITH_AHJ_PERMIT || v.url) return null;
  const sourceUrl = str(lookup.filing.sourceUrl);
  if (!/^https?:\/\//i.test(sourceUrl)) return null;
  return {
    state: lookup.state, utility: lookup.utility, name: str(v.name) || "AHJ permit application", sourceUrl, quote: str(lookup.filing.quote),
    documents: (Array.isArray(v.documents) ? v.documents : []).map(str).filter(Boolean),
    verifiedBy: str(lookup.verifiedBy), verifiedAt: str(lookup.verifiedAt),
  };
}
export function nemFiledWithPermit(db: AppDb | null, project: Pick<ProjectRecord, "state" | "utility">): NemFiledWithPermit | null {
  if (!db || !normalizeUtilityName(project.utility ?? "")) return null;
  return filedWithPermitOf(getUtilityFilingLookup(db, project.state ?? "", project.utility ?? ""));
}
/** Every utility key (utilityFilingKey) a person verified as filing with the permit — ONE query, for the
 *  batched readers (nextStep's list tier). A read. */
export function verifiedWithPermitKeys(db: AppDb): Set<string> {
  const out = new Set<string>();
  try {
    for (const row of db.query<Record<string, unknown>>("SELECT * FROM utility_filing_lookups WHERE verified_at IS NOT NULL AND verified_at != ''")) {
      const lookup = rowToLookup(row);
      if (filedWithPermitOf(lookup)) out.add(str(row.profile_key));
    }
  } catch { /* table missing on an old schema: nothing is verified */ }
  return out;
}

/** What a named person states when the utility's application rides in the permit application. */
export interface WithPermitStatement {
  name?: string;
  /** The page it was read on (the utility's or the city's own). */
  sourceUrl: string;
  /** The page's words that say so. */
  quote: string;
  /** The utility's own documents for it, as the page lists them. */
  documents?: string[];
}

/**
 * A NAMED PERSON VERIFIES this utility's filing row (#664) — as it stands, or replacing its filing with
 * the with-permit method they read on a cited page. Lands 'verified'; a lookup never overwrites it
 * again (rule 3). Only the with-permit method can be STATED here: a person-stated portal URL would be a
 * new door onto the NEM track, which this does not open (rule 5). The program fact is kept as it was.
 */
export function verifyUtilityFilingLookup(
  db: AppDb,
  where: { state: string; utility: string },
  opts: { verifiedBy: string; filedWithPermit?: WithPermitStatement },
): { saved: boolean; reason: string; lookup: UtilityFilingLookup | null } {
  const who = str(opts.verifiedBy).slice(0, 120);
  if (!who) return { saved: false, reason: "a utility filing row is verified by a named person", lookup: null };
  if (!normalizeUtilityName(where.utility) || !str(where.state)) return { saved: false, reason: "no utility name", lookup: null };
  const existing = getUtilityFilingLookup(db, where.state, where.utility);
  const stated = opts.filedWithPermit;
  if (!existing && !stated) return { saved: false, reason: "no filing lookup is on file to verify — state the with-permit method you read, with its page and words", lookup: null };
  let filing: UtilityFilingFact = existing?.filing ?? { value: null, sourceUrl: "", quote: "", origin: "operator", notFound: "not stated" };
  if (stated) {
    const sourceUrl = str(stated.sourceUrl);
    const quote = str(stated.quote).slice(0, 300);
    if (!/^https?:\/\//i.test(sourceUrl)) return { saved: false, reason: "a fact a person states carries the http(s) page it was read on", lookup: existing };
    if (quote.length < 8) return { saved: false, reason: "a fact a person states carries the page's own words", lookup: existing };
    const documents = (stated.documents ?? []).map((d) => str(d).slice(0, 200)).filter(Boolean).slice(0, 12);
    filing = {
      value: { name: str(stated.name).slice(0, 160) || "AHJ permit application", url: null, method: FILED_WITH_AHJ_PERMIT, ...(documents.length ? { documents } : {}) },
      sourceUrl, quote, origin: "operator",
      // The URLs an earlier lookup dropped stay evidence (infoPages reads them), never a portal.
      ...(existing?.filing?.droppedUrls?.length ? { droppedUrls: existing.filing.droppedUrls } : {}),
    };
  } else if (!filing.value) {
    return { saved: false, reason: "the row on file found no filing location — state what you read instead of verifying a blank", lookup: existing };
  }
  const program: CitedFact<UtilityProgramKind> = existing?.program ?? { value: null, sourceUrl: "", quote: "", origin: "operator", notFound: "not stated by the person who verified this row" };
  return saveUtilityFilingLookup(db, {
    state: existing?.state || where.state, utility: existing?.utility || where.utility, filing, program,
    ...(existing?.programName ? { programName: existing.programName } : {}),
    lookedUpAt: existing?.lookedUpAt || new Date().toISOString(), confidence: "verified",
  }, { verifiedBy: who });
}

// ── Acceptance (the cited discipline) ────────────────────────────────────────────────────────
type RawFact = { value?: unknown; sourceUrl?: unknown; quote?: unknown; notFound?: unknown; programName?: unknown } | null | undefined;

const GENERIC_WORDS = new Set(["the", "and", "for", "our", "portal", "online", "application", "applications", "interconnection", "system", "web", "site", "page", "utility", "customer", "generation", "net", "metering"]);
const distinctive = (s: string) => str(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));

/** Does the quote NAME this filing location? The URL's host, or every distinctive word of its
 *  name, must be in the quote ("You will use our PowerClerk portal" names "PowerClerk"). A name
 *  of only generic words ("Interconnection Portal") needs the host, or the name's own words. */
export function quoteNamesFiling(value: UtilityFilingLocation, quote: string): boolean {
  const q = str(quote).toLowerCase();
  const host = value.url ? portalHostOf(value.url) : "";
  if (host && (q.includes(host) || q.includes(host.split(".").slice(-2).join(".")))) return true;
  const words = distinctive(value.name);
  if (words.length) return words.every((w) => q.includes(w));
  const all = str(value.name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return Boolean(all) && q.replace(/[^a-z0-9]+/g, " ").includes(all);
}

// THE APPLICATION RIDES IN THE PERMIT APPLICATION (#664): a filing word, and a link word that puts it
// IN / WITH / THROUGH a permit within a few words ("apply through the city's building permit portal",
// "submitted with your building permit application", "included in the permit packet"). A page that
// keeps the two apart ("separate from", "in addition to", "also obtain a building permit") does not.
// Two more shapes real municipal pages use (bot-vs-research comparison, 2026-11-10):
//   - THE PERMIT SYSTEM BY ITS OWN NAME: "submitted on-line through the <system> portal", where <system>
//     is the AHJ's own permit portal already on file for the service city (permitSystemNames: its host's
//     distinctive label, its platform name) — the caller supplies the names, this module names none;
//   - THE UTILITY'S DOCUMENT ATTACHED TO THE APPLICATION: "net meter agreement … (attachment available
//     on-line w/application)" — an attach/upload/submit word, the utility's own agreement or
//     interconnection document, and "with / w/ the (online) application".
// Either way it stays a SEEDED proposal: only a person-VERIFIED row switches the NEM track to it
// (nemFiledWithPermit, rule 3), and no URL is ever kept on the NEM track for this method (rule 5).
const WITH_PERMIT_FILING_WORD = /\b(?:appl(?:y|ies|ied|ication|ications)|submit\w*|fil(?:e|ed|es|ing)|includ\w*|process\w*|accept\w*|tak(?:e|es|en))\b/i;
const WITH_PERMIT_LINK = /\b(?:with|through|in|into|as part of|along with|inside|within|via)\s+(?:(?:the|your|a|an|its|our)\s+)?(?:[\w'\u2019-]+\s+){0,3}permit\b/i;
const PERMIT_KEPT_APART = /\b(?:separate(?:ly)?(?: from)?|in addition to|apart from|independent(?:ly)? of|not (?:part of|through|with|in)|also (?:obtain|need|get|apply for))\b[^.;]{0,40}\bpermit\b/i;
const UTILITY_DOCUMENT = /\bnet[- ]?(?:energy )?meter(?:ing|ed)?\b[^.;]{0,40}\b(?:agreement|application|form)\b|\binterconnection\b[^.;]{0,40}\b(?:agreement|application|form)\b/i;
const ATTACH_WORD = /\b(?:attach\w*|upload\w*|submit\w*|includ\w*)\b/i;
const WITH_APPLICATION = /\bwith\s+(?:(?:the|your|its)\s+)?(?:on-?line\s+)?(?:building\s+)?(?:permit\s+)?application\b/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Does the quote STATE that the utility's application is filed with the AHJ's permit application?
 *  `permitSystemNames`: the service city's own permit system as it is on file (caller-supplied). */
export function quoteStatesFiledWithPermit(quote: string, permitSystemNames: readonly string[] = []): boolean {
  // "w/" is how checklists write "with".
  const q = str(quote).replace(/\bw\/\s*/gi, "with ");
  if (PERMIT_KEPT_APART.test(q)) return false;
  if (WITH_PERMIT_FILING_WORD.test(q) && WITH_PERMIT_LINK.test(q)) return true;
  const names = permitSystemNames.map((n) => str(n).toLowerCase()).filter((n) => n.length >= 4);
  if (names.length) {
    const viaSystem = new RegExp(`\\b(?:with|through|in|into|via|on)\\s+(?:(?:the|your|a|an|its|our)\\s+)?(?:[\\w'\\u2019-]+\\s+){0,2}(?:${names.map(escapeRe).join("|")})\\b`, "i");
    if (WITH_PERMIT_FILING_WORD.test(q) && viaSystem.test(q)) return true;
  }
  return ATTACH_WORD.test(q) && UTILITY_DOCUMENT.test(q) && WITH_APPLICATION.test(q);
}

/** Does the quote support this filing location — a portal it names, or (#664) the with-permit method? */
export function quoteSupportsFiling(value: UtilityFilingLocation, quote: string, permitSystemNames: readonly string[] = []): boolean {
  return value.method === FILED_WITH_AHJ_PERMIT ? quoteStatesFiledWithPermit(quote, permitSystemNames) : quoteNamesFiling(value, quote);
}

const DENIES_NEM = /\b(?:no|not|does not|doesn't|do not|don't|without)\b[^.;]{0,40}\bnet[- ]?(?:energy )?meter/i;
/** Does the quote STATE this program kind? */
export function quoteStatesProgram(kind: UtilityProgramKind, quote: string): boolean {
  const q = str(quote);
  if (kind === "net_metering") return /\bnet[- ]?(?:energy )?meter(?:ing|ed)?\b|\bNEM\b/i.test(q) && !DENIES_NEM.test(q);
  if (kind === "net_billing") return /\bexport(?:ed|s)?\b[^.;]{0,80}\b(?:credit|price|rate|c(?:ents)?\/kwh|¢)|\bbuy[- ]?back\b|net[\s-]?billing\b|\bavoided cost\b|\bcredited\b[^.;]{0,60}\b(?:price|rate)\b/i.test(q);
  return DENIES_NEM.test(q) || /\bretail electric provider\b|\bREPs?\b|\bwires[- ]only\b|\btransmission and distribution (?:service )?provider\b/i.test(q);
}

function cited<T>(raw: RawFact, seenUrls: string[], coerce: (v: unknown) => T | null, supports: (v: T, quote: string) => boolean, what: string): CitedFact<T> {
  const notFound = (why: string): CitedFact<T> => ({ value: null, sourceUrl: str(raw?.sourceUrl), quote: str(raw?.quote).slice(0, 300), origin: "lookup", notFound: why });
  if (!raw || raw.value == null || raw.value === "") return notFound(str(raw?.notFound) || `no source stated the ${what}`);
  const value = coerce(raw.value);
  if (value == null) return notFound(`the ${what} returned was not usable`);
  const sourceUrl = str(raw.sourceUrl);
  const quote = str(raw.quote).slice(0, 300);
  if (!/^https?:\/\//i.test(sourceUrl) || quote.length < 8) return notFound(`the ${what} came without a source page and its words — not kept`);
  const host = portalHostOf(sourceUrl);
  if (!seenUrls.some((u) => portalHostOf(u) === host)) return notFound(`the ${what}'s source (${host}) is not a page the search returned — not kept`);
  if (!supports(value, quote)) return notFound(`the quoted words do not state the ${what} ("${quote.slice(0, 80)}")`);
  return { value, sourceUrl, quote, origin: "lookup" };
}

/** A filing URL is kept only when it is a real application portal on the NEM track whose OWN host
 *  the search attested — and, when the answer names an interconnection platform (its name or its
 *  quote says PowerClerk…), on that platform's domain (issue #31). Otherwise the location keeps its
 *  name and loses the URL. */
export function acceptFilingUrl(url: string, seenUrls: string[], namedPlatform: string[] = []): { url: string | null; why: string } {
  const u = str(url);
  if (!/^https?:\/\//i.test(u)) return { url: null, why: "no URL" };
  const host = portalHostOf(u);
  if (!seenUrls.some((s) => portalHostOf(s) === host)) return { url: null, why: `${host} is not a host the search returned` };
  if (isInformationalPageUrl(u)) return { url: null, why: `${u} is an information page, not an application portal` };
  const fit = hostFitsTrackAndEntity("nem", null, u, "research", { namedPlatform });
  if (!fit.fits) return { url: null, why: fit.reason };
  return { url: u, why: "" };
}

/** The words say some locations are SERVED by each named other utility ("served by Central Electric or
 *  Pacific Power, or … may be served by either utility"). */
export function quoteStatesServiceArea(v: UtilityServiceArea, quote: string): boolean {
  const q = str(quote).toLowerCase();
  if (!/\bserv(?:ed|es|ice|ing)\b/.test(q) || !v.sharedWith.length) return false;
  return v.sharedWith.every((name) => {
    const w = normalizeUtilityName(name).split(" ").filter((x) => x.length > 2 && !["electric", "power", "energy", "cooperative", "utility", "utilities", "the"].includes(x));
    return w.length > 0 && w.every((x) => q.includes(x));
  });
}
const coerceServiceArea = (seenUrls: string[], sourceUrl: unknown) => (v: unknown): UtilityServiceArea | null => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const sharedWith = (Array.isArray(o.sharedWith) ? o.sharedWith : []).map(str).filter(Boolean).slice(0, 4);
  if (!sharedWith.length) return null;
  // The map is kept only when it is the cited page itself or a page the search returned / opened.
  const map = str(o.mapUrl);
  const seenKeys = new Set([...seenUrls, str(sourceUrl)].map((u) => u.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase()));
  const mapUrl = /^https?:\/\//i.test(map) && seenKeys.has(map.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase()) ? map : undefined;
  return { sharedWith, ...(mapUrl ? { mapUrl } : {}) };
};
export function parseUtilityFilingAnswer(text: string, seenUrls: string[], ctx: { permitSystemNames?: readonly string[] } = {}): { filing: UtilityFilingFact; program: CitedFact<UtilityProgramKind>; programName: string; dropped: string[]; limits: EligibilityLimits; rawRequirements?: unknown; fees?: Array<CitedFact<UtilityFee>>; reviewTime?: CitedFact<string>; serviceArea?: CitedFact<UtilityServiceArea> } {
  let json: Record<string, unknown> | null = null;
  const t = str(text);
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { json = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>; } catch { json = null; }
  }
  const dropped: string[] = [];
  const droppedUrls: string[] = [];
  const rawFiling = (json?.filing ?? null) as RawFact;
  const cites = cited<UtilityFilingLocation>(
    rawFiling, seenUrls,
    (v) => {
      const o = (v && typeof v === "object" ? v : { name: v }) as Record<string, unknown>;
      const named = [str(o.name), str(rawFiling?.quote)];
      // A nameless answer whose quote names the platform is filed under that platform's name, so a
      // dropped off-platform URL still leaves "PowerClerk — tenant URL unconfirmed" on the card.
      // FILED WITH THE AHJ PERMIT APPLICATION (#664): a method, never a portal. Any URL the answer
      // gave (the city's permit portal, typically) is DROPPED — kept only as evidence, like every URL
      // the door refuses — so nothing on the NEM track can resolve or launch it (hard rule 5).
      if (str(o.method).toLowerCase() === FILED_WITH_AHJ_PERMIT) {
        if (str(o.url)) {
          dropped.push(`filing URL ${str(o.url)} dropped: the utility files with the AHJ permit application — that method never keeps a URL on the NEM track (hard rule 5)`);
          if (portalHostOf(str(o.url))) droppedUrls.push(str(o.url).slice(0, 500));
        }
        const documents = (Array.isArray(o.documents) ? o.documents : []).map((d) => str(d).slice(0, 200)).filter(Boolean).slice(0, 12);
        return { name: str(o.name).slice(0, 160) || "AHJ permit application", url: null, method: FILED_WITH_AHJ_PERMIT, ...(documents.length ? { documents } : {}) };
      }
      const name = str(o.name) || namedInterconnectionPlatforms(named)[0] || "";
      const accepted = acceptFilingUrl(str(o.url), seenUrls, named);
      if (str(o.url) && !accepted.url) {
        dropped.push(`filing URL ${str(o.url)} dropped: ${accepted.why}`);
        // The URL as the answer named it — evidence, never a portal (UtilityFilingFact).
        if (portalHostOf(str(o.url))) droppedUrls.push(str(o.url).slice(0, 500));
      }
      if (!name && !accepted.url) return null;
      return { name: name || portalHostOf(accepted.url!), url: accepted.url };
    },
    (v, q) => quoteSupportsFiling(v, q, ctx.permitSystemNames ?? []), "filing location",
  );
  const filing: UtilityFilingFact = droppedUrls.length ? { ...cites, droppedUrls } : cites;
  const rawProgram = (json?.program ?? null) as RawFact;
  const program = cited<UtilityProgramKind>(
    rawProgram, seenUrls,
    (v) => (["net_metering", "net_billing", "interconnection_only"].includes(str(v)) ? (str(v) as UtilityProgramKind) : null),
    quoteStatesProgram, "program",
  );
  // PROGRAM LIMITS (#679), under the same cited discipline: a page the search returned, words that carry the value.
  const proposed = acceptProposedLimits(json?.limits, seenUrls);
  dropped.push(...proposed.dropped.map((d) => `limit ${d}`));
  // THE APPLICATION'S REQUIREMENT ITEMS (utilityRequirementsResearch.ts): passed through raw; the run
  // shape-checks and lands them after the row is saved.
  // FEES AND REVIEW TIME (lookup-battery-and-fees): the same cited discipline; display only.
  const fees: Array<CitedFact<UtilityFee>> = [];
  for (const r of (Array.isArray(json?.fees) ? json!.fees as unknown[] : []).slice(0, 6)) {
    const f = cited<UtilityFee>(r as RawFact, seenUrls, (v) => {
      const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      const amountUsd = typeof o.amountUsd === "number" ? o.amountUsd : Number(str(o.amountUsd).replace(/[$,]/g, ""));
      return str(o.label) && Number.isFinite(amountUsd) ? { label: str(o.label).slice(0, 120), amountUsd } : null;
    }, quoteStatesFee, "utility fee");
    if (f.value) fees.push(f); else dropped.push(`fee: ${f.notFound}`);
  }
  const reviewTime = json?.reviewTime != null ? cited<string>(json.reviewTime as RawFact, seenUrls, (v) => str(v).slice(0, 120) || null, quoteStatesReviewTime, "review time") : null;
  if (reviewTime && !reviewTime.value && json?.reviewTime && (json.reviewTime as Record<string, unknown>).value) dropped.push(`review time: ${reviewTime.notFound}`);
  const serviceArea = json?.serviceArea != null ? cited<UtilityServiceArea>(json.serviceArea as RawFact, seenUrls, coerceServiceArea(seenUrls, (json.serviceArea as RawFact)?.sourceUrl), quoteStatesServiceArea, "shared service area") : null;
  if (serviceArea && !serviceArea.value && (json?.serviceArea as Record<string, unknown> | undefined)?.value) dropped.push(`shared service area: ${serviceArea.notFound}`);
  return { filing, program, programName: program.value ? str(rawProgram?.programName).slice(0, 120) : "", dropped, limits: proposed.limits,
    ...(fees.length ? { fees } : {}), ...(reviewTime?.value ? { reviewTime } : {}), ...(serviceArea?.value ? { serviceArea } : {}),
    ...(json && json.applicationRequirements !== undefined ? { rawRequirements: json.applicationRequirements } : {}) };
}

// ── THE FILING DOOR FROM THE UTILITY'S OWN LINKS (bot-vs-research comparison, 2026-11-10) ─────────
// A utility's page usually LINKS its application ("Submit an online application", "Application Form –
// Solar PV…") without naming the form's host in words, so quoteNamesFiling refused a door the model had
// found. The permit lookup already reads the agency's page itself ("agency page (our read)"); this is the
// same read for the utility: the page the answer cited, read by Keelix's polite reader, and a LINK ON IT
// attests the filing URL — the link's words must be about applying, the target must pass the same door
// as every filing URL (acceptFilingUrl: the NEM track's rule-5 fit, never an information page or a
// document), and when the answer named a URL the link must point at that URL. The quote becomes
// "<link words>" -> <target>, so the citation shows exactly what attested it. The result lands SEEDED,
// like every lookup answer: where a filing goes stays a person's fact (rule 3), offered for the one-click
// Confirm (filingDestinationProposals). Nothing here names a utility, a platform tenant or a state.
// A net-metering / interconnection AGREEMENT link is the application at many co-ops and munis ("Small
// Net-Metering Agreement" -> its online form; bot-vs-research round 2).
const APPLY_LINK_WORDS = /\b(?:apply|applications?|submit\w*|interconnection request|interconnect(?:ion)? application|new request|start (?:a |an |your )?(?:new )?(?:application|request)|net[\s-]?meter(?:ing|ed)?[\s-]+(?:interconnection )?agreement|interconnection agreement)\b/i;
const NOT_APPLY_LINK_WORDS = /\b(?:inspection|schedule|pay(?:ment)?s?|bill|status|track(?:ing)?|faq|guide|handbook|checklist|instructions?|rates?|tariff|schedule \d+|outage|contact)\b/i;
/** Is this link's wording about applying (and not about inspections, payments, status or help)? */
export function isApplyLinkWords(words: string): boolean {
  const w = str(words);
  return APPLY_LINK_WORDS.test(w) && !NOT_APPLY_LINK_WORDS.test(w);
}
const sameTarget = (a: string, b: string): boolean => {
  const norm = (u: string) => { try { const x = new URL(u); return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "").toLowerCase()}`; } catch { return ""; } };
  const na = norm(a), nb = norm(b);
  return Boolean(na) && na === nb;
};
/** The filing location, attested by a link on the page the answer cited (a page WE read), or null.
 *  `raw` is the answer's filing member; `page` our read of raw.sourceUrl; `seenUrls` the search's. */
export function filingFromPageLinks(
  raw: RawFact,
  page: Pick<ReadPage, "ok" | "url" | "finalUrl" | "links"> | null,
  seenUrls: string[],
): { fact: UtilityFilingFact | null; why: string } {
  const o = (raw?.value && typeof raw.value === "object" ? raw.value : null) as Record<string, unknown> | null;
  if (!o) return { fact: null, why: "no filing answer" };
  if (str(o.method).toLowerCase() === FILED_WITH_AHJ_PERMIT) return { fact: null, why: "a with-permit method never takes a URL (rule 5)" };
  if (!page?.ok) return { fact: null, why: "the cited page was not read" };
  const cited = str(raw?.sourceUrl);
  const host = portalHostOf(cited);
  if (!host || !seenUrls.some((u) => portalHostOf(u) === host)) return { fact: null, why: "the cited page is not one the search returned" };
  const claimed = str(o.url);
  const named = [str(o.name), str(raw?.quote)];
  const candidates = (page.links ?? []).filter((l) => isApplyLinkWords(l.text)).filter((l) => {
    // The link on a page we read is the attestation of its host (the permit side's agencyLinks rule).
    return Boolean(acceptFilingUrl(l.href, [...seenUrls, l.href], named).url);
  });
  const uniq = [...new Map(candidates.map((l) => [l.href, l])).values()];
  const pick = claimed ? uniq.find((l) => sameTarget(l.href, claimed)) : uniq.length === 1 ? uniq[0] : undefined;
  if (!pick) {
    return { fact: null, why: claimed ? `no application link on ${cited} points at ${claimed}` : uniq.length ? `${uniq.length} application links on ${cited} and the answer named none` : `no application link on ${cited} fits the NEM track` };
  }
  const name = str(o.name) || namedInterconnectionPlatforms([pick.text, pick.href])[0] || portalHostOf(pick.href);
  return {
    fact: { value: { name: name.slice(0, 160), url: pick.href }, sourceUrl: page.finalUrl || page.url || cited, quote: `"${str(pick.text).slice(0, 120)}" -> ${pick.href}`.slice(0, 300), origin: "lookup" },
    why: "",
  };
}

/** The service city's own permit system as it is on file — the names quoteStatesFiledWithPermit may
 *  read "through the <system> portal" against: each portal host's distinctive label (the registrable
 *  domain's first label, e.g. a vendor's name) and the portal name a row records. Shared tables only. */
export function permitSystemNamesFor(db: AppDb | null, state: string, city: string | undefined, permitPortalUrls: readonly string[] = []): string[] {
  if (!db || !str(city)) return [];
  const out = new Set<string>();
  const addUrl = (u: string) => {
    const h = portalHostOf(u);
    if (!h) return;
    const parts = h.split(".");
    const label = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (label && label.length >= 4) out.add(label);
  };
  permitPortalUrls.forEach(addUrl);
  try {
    const row = db.get<{ portal_url?: string }>("SELECT portal_url FROM permit_utility_knowledge WHERE profile_key = ?", [knowledgeProfileKey({ state, ahj: str(city) })]);
    if (row?.portal_url) addUrl(row.portal_url);
  } catch { /* the table is created by migrations; a read failure leaves the names empty */ }
  return [...out];
}

// ── The lookup ───────────────────────────────────────────────────────────────────────────────
export const UTILITY_FILING_SYSTEM = `You find, for ONE electric utility in the United States, WHERE a residential rooftop solar installer files that utility's interconnection application, and WHAT the utility's customer-generation program is.

1. filing — where the interconnection / net-metering application is SUBMITTED: the online application portal (a PowerClerk tenant, the utility's own interconnection portal, an installer portal) or, when the utility takes it another way, that way (e.g. email to an address, a paper form). value: {"name": "<the portal or method, as the utility names it>", "url": "<the portal's own entry URL, or null>"}. The url is NEVER a city or county PERMIT portal, never a help page or a PDF. ONE EXCEPTION, a method and not a portal: when the utility's OWN page says its interconnection / net-metering application is submitted WITH or THROUGH the city's or county's building PERMIT application (one application in the permit system carries both), value: {"name": "<as the page names it>", "url": null, "method": "with_ahj_permit", "documents": ["<each utility document the page lists for it, in its words>"]} — and the quote must say so. Never use that method for a utility that has its own portal or form, or when the page only says a building permit is ALSO required. Prefer the utility's own interconnection / "for contractors" / "for installers" page. When the utility files on PowerClerk (or another platform), the url is the utility's OWN tenant login on that platform's domain (e.g. <tenant>.powerclerk.com/MvcAccount/Login) — search for it and give it only when a search result or a page you opened shows that host; a program, resource or info page on the utility's own website is never the url. If you cannot find the tenant's host, give the name (e.g. "PowerClerk") with "url": null. When the utility's own page LINKS its application ("Submit an online application", "Apply online") without naming it, give that link's target as the url, that page as sourceUrl and the link's words as the quote: Keelix reads the page and keeps the url only if the link is there.
2. program — "net_metering" when the utility credits exported energy under a net-metering tariff or rider; "net_billing" when exports are credited at a set export / buyback rate or price plan that is not net metering; "interconnection_only" when the utility only interconnects and does not itself credit exports (e.g. a wires-only distribution utility whose customers' retail electric provider sets any buyback). Also give "programName" in the utility's own words.

EVERY value carries "sourceUrl" (a page your search returned or you opened) and "quote" (the exact words on that page that state it, under 250 characters, containing the answer itself: the portal's name or link for the filing; the words net metering / export credit / retail provider for the program). If no page states it, "value": null and say what you searched in "notFound". Never answer from memory. Never guess.

3. limits — ONLY where the program page or tariff you read states them for residential customers: "maxDcKw" / "maxAcKw" (the program's size cap in kW), "productionMeterRequired" (true when a separate production / generation meter is required), "installerCertification" ({"name": "<the certification>", "effectiveFrom": "YYYY-MM-DD" or ""}). Each as {"value": ..., "citation": {"sourceName": "<the page or tariff by name>", "sourceUrl": "", "quote": "<the exact words, containing the value>"}}. Leave out any limit no page states; {} when none.
4. fees — the utility's OWN fees for a residential application (an application / net-metering / meter fee), ONE ENTRY PER PRINTED FEE: the fee every application owes under the name the page gives it, and each charge owed only in some cases (a return trip, a modification, a transfer of ownership, a study) as its own entry whose label names that case; a fee that depends on system size or application level is one entry per band, the band in its label. Each {"value": {"label": "<as printed>", "amountUsd": <number>}, "sourceUrl": "", "quote": "<the printed words with the amount>"}; [] when no page prints one. reviewTime — the review / processing time the utility's page states ("up to 10 business days"), {"value": "<as printed>", "sourceUrl": "", "quote": ""}, or null.
5. serviceArea — ONLY when the utility's own page says some locations in or near its area are served by ANOTHER utility (an overlapping or shared territory): {"value": {"sharedWith": ["<the other utility as named>"], "mapUrl": "<the page's service-area map, if it names one>"}, "sourceUrl": "", "quote": "<the words saying so>"}; null otherwise.

${UTILITY_REQUIREMENTS_RESEARCH_RULE}

Return ONLY JSON:
{"filing": {"value": {"name": "", "url": null, "method"?: "with_ahj_permit", "documents"?: []}|null, "sourceUrl": "", "quote": "", "notFound": ""},
 "program": {"value": "net_metering"|"net_billing"|"interconnection_only"|null, "programName": "", "sourceUrl": "", "quote": "", "notFound": ""},
 "limits": {},
 "fees": [{"value": {"label": "", "amountUsd": 0}, "sourceUrl": "", "quote": ""}],
 "reviewTime": {"value": null, "sourceUrl": "", "quote": ""},
 "serviceArea": null,
 ${UTILITY_REQUIREMENTS_RESEARCH_SCHEMA}}`;

const lookupTimeoutMs = () => Math.max(120000, Number(process.env.UTILITY_FILING_LOOKUP_TIMEOUT_MS) || 240000);

/** THE BUDGETS. "full" is the first try. "tight" is the one background retry after a timeout
 *  (issue #9: PNM's lookup ran 6 searches + 3 page reads for 240s and was aborted with nothing):
 *  half the searches, one page read, a smaller answer — the same time budget, so it finishes. */
export const UTILITY_FILING_BUDGETS = {
  full: { maxSearches: 6, maxFetches: 3, maxTokens: 4000 },
  tight: { maxSearches: 3, maxFetches: 1, maxTokens: 3000 },
} as const;
export type UtilityFilingBudget = keyof typeof UTILITY_FILING_BUDGETS;

export interface UtilityFilingLookupRun {
  saved: boolean;
  reason: string;
  lookup: UtilityFilingLookup | null;
  grounded: number;
  dropped: string[];
  error?: string;
  /** The call hit its time budget (the trigger retries it once, tighter). */
  timedOut?: boolean;
  /** The application requirement items the lookup proposed, landed (utilityRequirementsResearch.ts). */
  requirements?: UtilityRequirementsLanding;
  /** What became of the cited application fee: landed in the fee schedule, or held for a person. */
  feeLanding?: UtilityFeeLanding;
}

/** The answer's filing member as the model wrote it (null when the text is not JSON). */
function rawFilingOf(text: string): RawFact {
  const t = str(text);
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return ((JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>).filing ?? null) as RawFact; } catch { return null; }
}

/** Pages read to confirm a lookup's program limits (each limit usually cites one tariff or program page). */
const LIMIT_CONFIRM_MAX_READS = 3;

const isTimeout = (r: Pick<WebLookupResult, "timedOut" | "error">) => Boolean(r.timedOut) || /\b(?:abort(?:ed)?|timed? ?out)\b/i.test(str(r.error));

export async function runUtilityFilingLookup(
  db: AppDb,
  llm: Pick<LLMProvider, "webLookup">,
  input: {
    state: string; utility: string; city?: string; force?: boolean; budget?: UtilityFilingBudget;
    /** Reads the official pages that confirm requirement items (undefined = the default reader;
     *  null = none, everything lands seeded). Tests pass one over a fake fetch. */
    reader?: PageReader | null;
  },
): Promise<UtilityFilingLookupRun> {
  const existing = getUtilityFilingLookup(db, input.state, input.utility);
  if (existing?.confidence === "verified") return { saved: false, reason: "a person verified this utility's filing location", lookup: existing, grounded: 0, dropped: [] };
  if (existing && !input.force) return { saved: false, reason: "already looked up (seeded)", lookup: existing, grounded: 0, dropped: [] };
  if (!llm.webLookup) return { saved: false, reason: "no web lookup available (no model key)", lookup: existing, grounded: 0, dropped: [] };
  const budget = UTILITY_FILING_BUDGETS[input.budget ?? "full"];
  let r: WebLookupResult;
  try {
    r = await llm.webLookup({
      label: "utilityFilingLookup", system: UTILITY_FILING_SYSTEM,
      user: `Utility: ${input.utility}\nState: ${input.state}${input.city ? `\nService address city: ${input.city}` : ""}`,
      maxTokens: budget.maxTokens, maxSearches: budget.maxSearches, readPages: true, maxFetches: budget.maxFetches, timeoutMs: lookupTimeoutMs(),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { saved: false, reason: "lookup failed", lookup: existing, grounded: 0, dropped: [], error, timedOut: isTimeout({ error }) };
  }
  const timedOut = isTimeout(r);
  const seen = [...r.resultUrls, ...(r.fetchedUrls ?? [])];
  const ungrounded = r.groundedSearches <= 0;
  // The service city's own permit system, for "filed through the <system> portal" (#664 widened).
  let permitSystemNames: string[] = [];
  if (!ungrounded && str(input.city)) {
    try {
      const pp = await import("./permitProcess");
      const lk = pp.getPermitProcessLookup(db, input.state, str(input.city));
      const urls = (lk?.permits ?? []).map((p) => str(p.portalUrl?.value)).filter(Boolean);
      permitSystemNames = permitSystemNamesFor(db, input.state, input.city, urls);
    } catch { permitSystemNames = []; }
  }
  const parsed = ungrounded
    ? {
      filing: { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: r.error ? `lookup failed: ${r.error.slice(0, 120)}` : "no web search returned results — nothing kept from memory" },
      program: { value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: "no grounded search" },
      programName: "", dropped: [] as string[], limits: {} as EligibilityLimits,
    }
    : parseUtilityFilingAnswer(r.text, seen, { permitSystemNames });
  // THE DOOR FROM THE UTILITY'S OWN LINKS: when the answer's filing came back with no URL (its words did
  // not name the form, or its host was not a search result), read the page it cited and let an
  // application link on it attest the URL (filingFromPageLinks). One read, on the lookup's reader.
  let reader: PageReader | null | undefined = input.reader;
  const getReader = async (): Promise<PageReader | null> => {
    if (reader === undefined) reader = (await import("./permitProcessLookup")).defaultLookupReader(6);
    return reader ?? null;
  };
  if (!ungrounded) {
    const rawFiling = rawFilingOf(r.text);
    const f = parsed.filing;
    // Read only when the door REFUSED the answer's filing, or kept its name but dropped the URL it gave —
    // a name the quote already states with no URL claimed (an email address, a named office) needs no read.
    const claimedUrl = str((rawFiling?.value as Record<string, unknown> | undefined)?.url);
    const noUrl = !f.value || (!f.value.url && f.value.method !== FILED_WITH_AHJ_PERMIT && Boolean(claimedUrl));
    const cite = str(rawFiling?.sourceUrl);
    if (noUrl && rawFiling && /^https?:\/\//i.test(cite)) {
      try {
        const rd = await getReader();
        const page = rd ? await rd.read(cite) : null;
        const got = filingFromPageLinks(rawFiling, page, seen);
        if (got.fact) {
          parsed.dropped.push(`filing URL ${got.fact.value?.url} attested by a link on ${cite} (our read)`);
          parsed.filing = f.droppedUrls ? { ...got.fact, droppedUrls: f.droppedUrls } : got.fact;
        } else if (page) {
          parsed.dropped.push(`filing link read of ${cite}: ${got.why}`);
        }
      } catch (err) {
        logger.warn("utility-filing", `could not read ${cite} for the filing link: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // An aborted call that found nothing is not stored — a retry later may succeed. A grounded
  // "not found" IS stored, so the same utility is not searched on every project.
  if (ungrounded && r.error) return { saved: false, reason: `lookup failed: ${r.error.slice(0, 160)}`, lookup: existing, grounded: 0, dropped: [], error: r.error, timedOut };
  // A FAILED call that DID ground (a timeout's partial evidence): whatever passes the same cited
  // discipline is kept — but a partial that kept nothing is NOT a grounded "not found". Storing it
  // would pin the utility to "not yet identified" for a week on the strength of an unfinished search.
  if (r.error && !parsed.filing.value && !parsed.program.value) {
    return { saved: false, reason: `lookup failed: ${r.error.slice(0, 160)} (nothing usable in its partial results)`, lookup: existing, grounded: r.groundedSearches, dropped: parsed.dropped, error: r.error, timedOut };
  }
  // A RE-RUN NEVER LOSES A CITED ANSWER IT ALREADY HAD (issue #54: an incomplete row is looked up
  // again; a second search that finds less keeps the first one's filing / program).
  const keepFiling = !parsed.filing.value && existing?.filing?.value;
  const keepProgram = !parsed.program.value && existing?.program?.value;
  const programName = keepProgram ? existing?.programName ?? "" : parsed.programName;
  // A GOVERNMENT PAGE VOUCHES (owner, 2026-11-13; governmentVouches.ts): when the answer's pages sit on
  // a non-government site that could be this utility's and is not yet recorded as its own, the
  // government pages among the search's results (a state commission's list of utilities, ≤ 2) are read
  // for a link to that site in the utility's name.
  let siteVouchRun: { vouches: SiteVouch[]; read: string[] } = { vouches: [], read: [] };
  if (!ungrounded) {
    try {
      const { utilityOfficialHosts } = await import("./utilityRequirements");
      const candidateUrls = [str(parsed.filing.sourceUrl), str(parsed.program.sourceUrl), ...seen].filter(Boolean);
      siteVouchRun = await findSiteVouches(await getReader(), { kind: "utility", state: input.state, names: [input.utility] },
        { candidateUrls, officialHosts: utilityOfficialHosts(db, input.state, input.utility) });
    } catch (err) {
      logger.warn("utility-filing", `site vouch read failed for ${input.utility}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const siteVouches = mergeVouches(existing?.siteVouches, siteVouchRun.vouches, siteVouchRun.read);
  const save = saveUtilityFilingLookup(db, {
    state: input.state, utility: input.utility,
    ...(siteVouches.length ? { siteVouches } : {}),
    filing: (keepFiling ? existing!.filing : parsed.filing) as UtilityFilingFact,
    program: (keepProgram ? existing!.program : parsed.program) as CitedFact<UtilityProgramKind>,
    ...(programName ? { programName } : {}),
    // A re-run that found none keeps the earlier cited fees / review time.
    ...(parsed.fees?.length ? { fees: parsed.fees } : existing?.fees?.length ? { fees: existing.fees } : {}),
    // ...and the earlier fees' held-for-a-person list with them (a new set of fees is judged afresh below).
    ...(!parsed.fees?.length && existing?.fees?.length && existing.feesHeld?.length ? { feesHeld: existing.feesHeld } : {}),
    ...(parsed.reviewTime?.value ? { reviewTime: parsed.reviewTime } : existing?.reviewTime?.value ? { reviewTime: existing.reviewTime } : {}),
    ...(parsed.serviceArea?.value ? { serviceArea: parsed.serviceArea } : existing?.serviceArea?.value ? { serviceArea: existing.serviceArea } : {}),
    lookedUpAt: new Date().toISOString(),
  });
  // The cited program limits land as the utility's own eligibility record (official-source slice 4):
  // OFFICIAL when every limit's quote is in a page Keelix read here, on the utility's own official host
  // (vouches included, the row just saved carries this run's); SEEDED otherwise. Never over a person's
  // record (a differing official read is a conflict for a person), never over an official one except
  // from its own hosts (landLookupEligibilityRecord, rule 3).
  if (Object.keys(parsed.limits).length) {
    try {
      const { utilityOfficialHosts } = await import("./utilityRequirements");
      const hosts = utilityOfficialHosts(db, input.state, input.utility);
      const pages = new Map<string, RetrievedLimitPage>();
      const urls = [...new Set(Object.values(parsed.limits).map((l) => str((l as { citation?: { sourceUrl?: string } })?.citation?.sourceUrl)))]
        .filter((u) => isOfficialSourceHost(u, hosts));
      const rd = urls.length ? await getReader() : null;
      for (const url of rd ? urls.slice(0, LIMIT_CONFIRM_MAX_READS) : []) {
        try {
          const page = await rd!.read(url);
          if (page.ok && page.text) pages.set(url, { text: page.text, fetchedAt: new Date().toISOString() });
        } catch (err) {
          logger.warn("utility-filing", `could not read ${url} to confirm program limits: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const landed = landLookupEligibilityRecord(db, { authorityKind: "utility_program", state: input.state, authority: input.utility, programName: programName || `${input.utility} customer-generation program`, limits: parsed.limits }, { pages, authorityHosts: hosts });
      parsed.dropped.push(`program limits: ${landed.reason}`);
    } catch (err) {
      logger.warn("utility-filing", `could not store program limits for ${input.utility}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // WHAT THE UTILITY'S APPLICATION ASKS FOR, as the search's pages state it: proposals, landed on the row
  // just saved (official only through #683's landing on bytes read here; never over a person's item).
  const requirements = save.saved && !ungrounded ? await landLookupRequirements(db, input, parsed.rawRequirements, seen, r.groundedSearches > 0) : undefined;
  if (requirements) parsed.dropped.push(...requirements.dropped);
  // ONE STORE FOR FEES (fee round, 2026-11): the application fee this run cited lands in the fee
  // schedule through saveFeeSchedule (seeded, never over a person's row), after Keelix re-reads its
  // page. A fee the earlier row carried forward is not re-landed. What does not land is held for a person.
  let feeLanding: UtilityFeeLanding | undefined;
  if (save.saved && save.lookup && !ungrounded && parsed.fees?.length) {
    try {
      const { landUtilityLookupFees } = await import("./utilityFeeLanding");
      const { utilityOfficialHosts } = await import("./utilityRequirements");
      feeLanding = await landUtilityLookupFees(db, save.lookup, { reader: await getReader(), verifiedHosts: utilityOfficialHosts(db, input.state, input.utility) });
      parsed.dropped.push(`utility fee: ${feeLanding.reason}`);
    } catch (err) {
      logger.warn("utility-filing", `could not land the utility fee for ${input.utility}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A REFUSED READ IS NOT SILENT (as the permit lookup, lookup-door-fixes 5): pages the reader was refused
  // are recorded on the row for a person's browser. The reader's one try and host back-off are unchanged.
  let lookup = save.lookup;
  const refused = (await import("./permitProcessLookup")).readsNeedingAPerson([...((reader ?? null)?.log ?? []), ...(requirements?.readLog ?? [])]);
  const feesHeld = feeLanding?.held ?? [];
  if (save.saved && lookup && (refused.length || feesHeld.length)) {
    const again = saveUtilityFilingLookup(db, { ...lookup, ...(refused.length ? { needsPersonRead: refused } : {}), ...(feesHeld.length ? { feesHeld } : {}), confidence: "seeded" });
    if (again.saved) lookup = again.lookup;
  }
  return { saved: save.saved, reason: r.error ? `${save.reason} (partial results kept after: ${r.error.slice(0, 120)})` : save.reason, lookup, grounded: r.groundedSearches, dropped: parsed.dropped,
    ...(requirements?.landing ? { requirements: requirements.landing } : {}),
    ...(feeLanding ? { feeLanding } : {}),
    ...(r.error ? { error: r.error, timedOut } : {}) };
}

/** The lookup's requirement proposals, shape-checked and landed. Never throws: a failure here never
 *  costs the filing row the lookup just saved. */
async function landLookupRequirements(
  db: AppDb,
  input: { state: string; utility: string; reader?: PageReader | null },
  raw: unknown,
  seenUrls: string[],
  webGrounded: boolean,
): Promise<{ landing?: UtilityRequirementsLanding; dropped: string[]; readLog?: PageReader["log"] } | undefined> {
  if (raw === undefined) return undefined;
  try {
    const research = await import("./utilityRequirementsResearch");
    const { reads, dropped } = research.utilityRequirementReadsOf(raw, seenUrls, webGrounded);
    if (!reads.length) return { dropped };
    const reader = input.reader !== undefined ? input.reader : (await import("./permitProcessLookup")).defaultLookupReader(research.UTILITY_REQUIREMENTS_CONFIRM_MAX_READS);
    const landing = await research.landResearchedUtilityRequirements(db, { state: input.state, utility: input.utility }, reads, { reader });
    logger.info("utility-filing", `application requirements for ${input.utility} (${input.state}): ${landing.reason}`, { landed: landing.landed, skipped: landing.skipped.length, conflicts: landing.conflicts.length });
    return { landing, dropped, readLog: reader?.log ?? [] };
  } catch (err) {
    logger.warn("utility-filing", `could not land application requirements for ${input.utility}: ${err instanceof Error ? err.message : String(err)}`);
    return { dropped: [] };
  }
}

/** INCOMPLETE for the retry rule: nothing found at all, OR a named interconnection platform with
 *  no tenant URL (issue #54: PNM's "PowerClerk — tenant URL unconfirmed" was otherwise permanent).
 *  A method answer with no URL ("email to …") is complete. A verified row is never re-looked-up —
 *  the caller checks that first. */
export function isIncompleteFilingLookup(lookup: Pick<UtilityFilingLookup, "filing" | "program"> | null | undefined): boolean {
  if (!lookup) return true;
  const filing = lookup.filing?.value ?? null;
  if (!filing && !lookup.program?.value) return true;
  return Boolean(filing && !filing.url && namedInterconnectionPlatforms(filing.name).length);
}

const inFlight = new Map<string, number>();
const RETRY_MS = 24 * 3600 * 1000;
const EMPTY_RETRY_MS = 7 * 24 * 3600 * 1000;
/** After the background retry ALSO timed out, the next form-research pass (pipeline or the
 *  operator's "Find official form") may start a fresh attempt this soon — not a day later. */
const TIMED_OUT_RETRY_MS = 3600 * 1000;

/** What the trigger is doing for a utility, IN MEMORY (a read path writes nothing): the track card
 *  says "timed out, retrying" instead of a silent "not yet identified". */
export interface UtilityFilingLookupStatus { state: "running" | "retrying" | "timed_out" | "failed"; at: string; error?: string; retryAfter?: string }
const statusByKey = new Map<string, UtilityFilingLookupStatus>();
export function utilityFilingLookupStatus(state: string, utility: string): UtilityFilingLookupStatus | null {
  return statusByKey.get(utilityFilingKey(state, utility)) ?? null;
}
/**
 * THE TRIGGER, fire-and-forget: look up a project's utility once (per utility, shared), when a
 * model key is configured and nothing is on file. Returns true when a lookup was started. Callers
 * never await the lookup's result; the tracks read the stored row on their next render.
 */
export function ensureUtilityFilingLookedUp(
  db: AppDb,
  project: Pick<ProjectRecord, "state" | "utility" | "city">,
  llm: Pick<LLMProvider, "webLookup"> | null,
): boolean {
  if (/^(off|0|false)$/i.test(str(process.env.UTILITY_FILING_LOOKUP)) || !process.env.ANTHROPIC_API_KEY) return false;
  if (!llm?.webLookup || !str(project.utility) || !str(project.state)) return false;
  const key = utilityFilingKey(project.state, project.utility);
  const stored = getUtilityFilingLookup(db, project.state, project.utility);
  // A grounded search that found NOTHING is stored (the same utility is not searched on every
  // project) — but not forever: with no route to re-run a row, one bad search day would pin a
  // utility to "not yet confirmed" for good. An INCOMPLETE seeded row older than EMPTY_RETRY_MS is
  // looked up again; a complete or verified row never is (rule 3).
  const emptyAndStale = stored && stored.confidence !== "verified" && isIncompleteFilingLookup(stored)
    && Date.now() - Date.parse(stored.lookedUpAt || "") > EMPTY_RETRY_MS;
  if (stored && !emptyAndStale) return false;
  const last = inFlight.get(key);
  if (last && Date.now() - last < RETRY_MS) return false;
  inFlight.set(key, Date.now());
  statusByKey.set(key, { state: "running", at: new Date().toISOString() });
  const base = { state: project.state, utility: project.utility, city: project.city, force: Boolean(emptyAndStale) };
  const log = (run: UtilityFilingLookupRun, attempt: string) =>
    logger.info("utility-filing", `utility filing lookup for ${project.utility} (${project.state})${attempt}: ${run.reason}`, { grounded: run.grounded, dropped: run.dropped.length, timedOut: Boolean(run.timedOut) });
  void (async () => {
    let run = await runUtilityFilingLookup(db, llm, base);
    log(run, "");
    // A TIMEOUT IS NOT A VERDICT (issue #9). One background retry on the tight budget; a partial
    // that was kept (run.saved) needs none.
    if (run.timedOut && !run.saved) {
      statusByKey.set(key, { state: "retrying", at: new Date().toISOString(), error: run.error });
      run = await runUtilityFilingLookup(db, llm, { ...base, budget: "tight" });
      log(run, " (retry, tight budget)");
    }
    if (run.saved || !run.error) {
      statusByKey.delete(key);
    } else {
      // A double timeout: the next form-research pass may try again within the hour, not tomorrow.
      if (run.timedOut) inFlight.set(key, Date.now() - RETRY_MS + TIMED_OUT_RETRY_MS);
      const retryAfter = new Date((inFlight.get(key) ?? Date.now()) + RETRY_MS).toISOString();
      statusByKey.set(key, { state: run.timedOut ? "timed_out" : "failed", at: new Date().toISOString(), error: run.error, retryAfter });
    }
  })().catch((err) => {
    statusByKey.set(key, { state: "failed", at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) });
    logger.warn("utility-filing", `utility filing lookup failed for ${project.utility}: ${err instanceof Error ? err.message : String(err)}`);
  });
  return true;
}

// ── What the utility track shows ─────────────────────────────────────────────────────────────
/** Utilities whose program and portal this codebase already knew as fact before this module
 *  (Oregon net metering, ORS 757.300; their PowerClerk tenants are the recorded channels). */
function knownOregonNemUtility(project: Pick<ProjectRecord, "state" | "utility">): { channel: string; url: string } | null {
  // Oregon net metering only (the PROGRAM fact is Oregon's); WHICH utility is the one state-gated
  // identity (utilityIdentity) every other door asks.
  if (str(project.state).toUpperCase() !== "OR") return null;
  const known = knownPowerClerkUtility(project);
  if (known === "portland_general") return { channel: "PowerClerk (PGE NEM portal)", url: "" };
  if (known === "pacificorp") return { channel: "Pacific Power NEM portal (PowerClerk: pacificorpnetmetering.powerclerk.com)", url: "https://pacificorpnetmetering.powerclerk.com/" };
  return null;
}

export interface UtilityTrackPresentation {
  /** The track card's title — what the filing IS. */
  label: string;
  /** Where it is filed, with the basis. */
  channel: string;
  /** The filing portal URL (cited) when one is known — for the credential chip / recorder. */
  portalUrl: string;
  program: UtilityProgramKind | "unknown";
  /** "cited" | "verified" | "known" | "profile" (a seeded KB row) | "unknown" — how the label/channel are known. */
  basis: "cited" | "verified" | "known" | "profile" | "unknown";
  /** #664: a person VERIFIED that this utility's application rides in the AHJ permit application
   *  (nemFiledWithPermit). Absent otherwise — a seeded with-permit row never sets it. */
  filedWithPermit?: NemFiledWithPermit;
  /** Set only when the address the track shows is the utility's SEEDED knowledge-base row (basis
   *  "profile", no person's verify): the row's portal name, its address (already through rule 5's
   *  hostFitsTrackAndEntity in utilityKbChannel) and the page the row names as its source ("" when it
   *  names none). Read by the Destinations queue to offer it for a person's Edit-and-save
   *  (filingDestinationProposals); it decides nothing here. */
  seededDoor?: { name: string; url: string; source: string };
}

export const UTILITY_TRACK_LABELS: Record<UtilityProgramKind | "unknown", string> = {
  net_metering: "Utility net metering (NEM) / interconnection",
  net_billing: "Utility interconnection + export credit (net billing — not net metering)",
  interconnection_only: "Utility interconnection only (no utility net metering)",
  unknown: "Utility interconnection application (net-metering program not yet confirmed)",
};

/** What the card says while the lookup is not settled — never a silent "not yet identified". */
export const UTILITY_LOOKUP_STATUS_TEXT: Record<UtilityFilingLookupStatus["state"], string> = {
  running: "lookup in progress",
  retrying: "lookup timed out, retrying with a smaller search",
  timed_out: "lookup timed out twice — retry: \"Find official form\" (or the next research pass) looks it up again",
  failed: "lookup failed — retry: \"Find official form\" (or the next research pass) looks it up again",
};

/**
 * THE UTILITY'S OWN KB ROW (permit_utility_knowledge, utility-wide: no AHJ, exact profile key) as a
 * filing channel — only its portal URL that FITS the NEM track and this utility by the one rule-5
 * predicate, hostFitsTrackAndEntity, with every platform the row AND the lookup name (issue #31's
 * `namedPlatform`: a lookup that says PowerClerk never takes the utility's info page). Read-only.
 */
function utilityKbChannel(db: AppDb, project: Pick<ProjectRecord, "state" | "utility">, lookupNames: string[]): { url: string; name: string; verified: boolean; source: string } | null {
  if (!str(project.utility)) return null;
  let row: Record<string, unknown> | null | undefined;
  try {
    row = db.get<Record<string, unknown>>("SELECT * FROM permit_utility_knowledge WHERE profile_key = ?", [knowledgeProfileKey({ state: project.state, utility: project.utility })]);
  } catch {
    return null;
  }
  if (!row || str(row.ahj)) return null;
  const named = [str(row.portal_name), str(row.portal_platform), ...lookupNames];
  const entity = portalEntityEvidence(db, { scope: "utility", state: project.state, name: project.utility });
  // Both columns: reference imports file the link in portal_name (as the stage's KB read does).
  const url = [str(row.portal_url), str(row.portal_name)]
    .filter((u) => /^https?:\/\/\S+$/i.test(u))
    .find((u) => hostFitsTrackAndEntity("nem", entity, u, "kb", { namedPlatform: named }).fits);
  if (!url) return null;
  let source = "";
  try {
    const sources = JSON.parse(str(row.sources_json) || "[]") as unknown;
    if (Array.isArray(sources)) source = sources.map((x) => (typeof x === "string" ? x : str((x as { url?: unknown })?.url))).find((x) => /^https?:\/\//i.test(x)) ?? "";
  } catch { /* no citation — the tag still says seeded / verified */ }
  const platform = str(row.portal_platform) || namedInterconnectionPlatforms(named)[0] || "";
  const name = str(row.portal_name) && !/^https?:/i.test(str(row.portal_name)) ? str(row.portal_name) : platform || "Utility interconnection portal";
  return { url, name, verified: isVerifiedKnowledge(row), source };
}

/** THE UTILITY'S OWN FEES AND REVIEW TIME, as its cited page prints them (lookup-battery-and-fees):
 *  one sentence for the utility track card, "" when none is on file. Display only. */
export function utilityFeesAndReviewSentence(db: AppDb | null, project: Pick<ProjectRecord, "state" | "utility">): string {
  if (!db || !str(project.utility)) return "";
  let lookup: UtilityFilingLookup | null = null;
  try { lookup = getUtilityFilingLookup(db, project.state, project.utility); } catch { return ""; }
  const fees = (lookup?.fees ?? []).filter((f) => f.value);
  const parts: string[] = [];
  if (fees.length) {
    const money = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
    parts.push(`Utility fees (from its page): ${fees.map((f) => `${f.value!.label} ${money(f.value!.amountUsd)}`).join("; ")} — ${[...new Set(fees.map((f) => f.sourceUrl))].join(", ")}`);
  }
  if (lookup?.reviewTime?.value) parts.push(`Utility review time (from its page): ${lookup.reviewTime.value} — ${lookup.reviewTime.sourceUrl}`);
  const area = lookup?.serviceArea?.value;
  if (area) parts.push(`Check which utility serves the address: ${project.utility}'s page says some locations are served by ${area.sharedWith.join(" or ")} (${area.mapUrl ?? lookup!.serviceArea!.sourceUrl})`);
  const blocked = lookup?.needsPersonRead ?? [];
  if (blocked.length) parts.push(`Needs a person to read (the site refused Keelix's read): ${blocked.map((b) => b.url).join(", ")}`);
  return parts.length ? ` ${parts.join(". ")}.` : "";
}
export function utilityTrackPresentation(db: AppDb | null, project: Pick<ProjectRecord, "state" | "utility">): UtilityTrackPresentation {
  const lookup = db ? getUtilityFilingLookup(db, project.state, project.utility) : null;
  const verified = lookup?.confidence === "verified";
  const known = knownOregonNemUtility(project);
  const program: UtilityProgramKind | "unknown" = lookup?.program?.value ?? (known ? "net_metering" : "unknown");
  const lookupFiling = lookup?.filing?.value ?? null;
  const programLabelFor = () => {
    const programLabel = UTILITY_TRACK_LABELS[program];
    return lookup?.program?.value && lookup.programName ? `${programLabel} — ${lookup.programName}` : programLabel;
  };
  // FILED WITH THE AHJ PERMIT APPLICATION, AS A PERSON VERIFIED IT (#664): no portal, no URL — the
  // application rides in the permit's. Ahead of every portal source, a verified KB portal included:
  // two verified records that disagree resolve to the one that launches nothing (strictest).
  const withPermit = filedWithPermitOf(lookup);
  if (withPermit) {
    return {
      label: programLabelFor(),
      channel: `Filed inside the AHJ permit application (${withPermit.name}) — no separate utility filing (verified by ${withPermit.verifiedBy || "a person"}: ${withPermit.sourceUrl})`,
      portalUrl: "",
      program,
      basis: "verified",
      filedWithPermit: withPermit,
    };
  }
  // A SEEDED with-permit answer is a proposal (rule 3): the track stays "not yet identified" with its
  // human step, saying what the lookup read — never "included in the permit", never a portal.
  if (lookupFiling?.method === FILED_WITH_AHJ_PERMIT) {
    const kbSeeded = db ? utilityKbChannel(db, project, [lookupFiling.name, str(lookup?.filing?.quote)]) : null;
    if (!kbSeeded?.verified) {
      return {
        label: programLabelFor(),
        channel: `Utility interconnection filing location — not yet identified: the utility's page reads as filing with the AHJ permit application ("${lookupFiling.name}", cited: ${lookup!.filing.sourceUrl}) — filing location unverified until a named person verifies it (verify on the utility's interconnection page)`,
        portalUrl: "",
        program,
        basis: "cited",
      };
    }
  }
  // WHICH SOURCE NAMES THE PORTAL (issue #54): verified KB beats seeded lookup beats unconfirmed
  // research. The utility's KB row is consulted when the lookup has no URL ("PowerClerk — tenant URL
  // unconfirmed" from research, while #36's seeded row holds the tenant login), or when a PERSON
  // verified the KB row. A person's verified lookup gives way only to a person's verified KB URL,
  // and only when it has none of its own; nothing here writes (rule 3).
  const kb = db && !(verified && lookupFiling?.url)
    ? utilityKbChannel(db, project, lookupFiling ? [lookupFiling.name, str(lookup?.filing?.quote)] : [])
    : null;
  if (kb && (verified ? kb.verified && !lookupFiling?.url : kb.verified || !lookupFiling?.url)) {
    const tag = kb.verified ? "verified by a person" : "seeded knowledge base — verify";
    const programLabel = UTILITY_TRACK_LABELS[program];
    return {
      label: lookup?.program?.value && lookup.programName ? `${programLabel} — ${lookup.programName}` : programLabel,
      channel: `${kb.name} — ${kb.url} (${tag}${kb.source ? `: ${kb.source}` : ""})`,
      portalUrl: kb.url,
      program,
      basis: kb.verified ? "verified" : "profile",
      ...(kb.verified ? {} : { seededDoor: { name: kb.name, url: kb.url, source: kb.source } }),
    };
  }
  const filing = lookupFiling;
  const tag = verified ? "verified by a person" : "cited";
  const status = filing || known ? null : utilityFilingLookupStatus(project.state, project.utility);
  // A named platform with no tenant URL (issue #31: the answer said PowerClerk but gave the utility's
  // own page, which acceptFilingUrl dropped) says so — never a silent bare "PowerClerk".
  const tenantUnconfirmed = filing && !filing.url && namedInterconnectionPlatforms(filing.name).length ? " — tenant URL unconfirmed, verify" : "";
  const channel = filing
    ? `${filing.name}${filing.url ? ` — ${filing.url}` : tenantUnconfirmed} (${tag}: ${lookup!.filing.sourceUrl})`
    : known
      ? known.channel
      : status
        // "not yet identified" stays in the sentence: channelKindOf / the next action read it as unknown.
        ? `Utility interconnection portal — not yet identified: ${UTILITY_LOOKUP_STATUS_TEXT[status.state]}${status.retryAfter ? ` after ${status.retryAfter.slice(0, 16).replace("T", " ")} UTC` : ""} (verify on the utility's interconnection page meanwhile)`
        : "Utility interconnection portal — not yet identified (verify on the utility's interconnection page)";
  const programLabel = UTILITY_TRACK_LABELS[program];
  return {
    label: lookup?.program?.value && lookup.programName ? `${programLabel} — ${lookup.programName}` : programLabel,
    channel,
    portalUrl: filing?.url || known?.url || "",
    program,
    basis: lookup?.program?.value || filing ? (verified ? "verified" : "cited") : known ? "known" : "unknown",
  };
}
