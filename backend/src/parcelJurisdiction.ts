// CONFIRM THE JOB'S JURISDICTION FROM THE PARCEL, NOT THE MAILING CITY (review-audit draft 09).
//
// The AHJ comes from the plan set / intake and the address's mailing city. A mailing city is a postal
// name, not a jurisdiction: an address that says one city can sit on a parcel in the unincorporated
// county around it, and a permit filed with the city for a county parcel is refused (the fee is often
// not refunded). An AHJ intake desk checks this first; so does the gate now.
//
// ONE GENERIC MECHANISM, PER-COUNTY DATA. Which service answers "which jurisdiction is this address
// in" is DATA: backend/data/reference-jurisdiction-lookup-sources.json, one record per county (its
// public parcel / city-limits query URL, which field holds the jurisdiction, which values mean the
// unincorporated county, which mailing cities / ZIPs it covers), at a tier — seeded | official |
// verified. No county, city or state is named in code.
//
// THE NETWORK READ IS A JOB, NEVER A PAGE READ. QC (a write path) queues one
// `parcel_jurisdiction_check` job for a permit-track job whose address a record covers and whose
// answer is not cached (ensureParcelJurisdictionChecked). The job asks the county's service with one
// plain HTTP GET — only when the query URL is on a GOVERNMENT host (the one shared predicate,
// officialSource.isOfficialSourceHost, with no other domain admitted), no redirect followed, no model
// anywhere — and caches the answer by a HASH of the address (parcel_jurisdiction_checks, migration
// v77): the address itself is never stored there, never put in the job's payload or result, and
// never logged. The gate reads only that cache (readParcelJurisdiction), so "reads write nothing"
// stays true.
//
// ONE EXCEPTION TO "GOVERNMENT HOSTS ONLY" (draft 16 B; owner 2026-11-10, "Yes that is okay"; Helm's
// conditions): many counties publish their parcel map on a hosted map platform (ArcGIS Online, run by
// Esri), never a government host. Such a record is usable ONLY when the county's own GOVERNMENT page is
// shown to link that service, and the record names the exact service root (host + path):
//   - by a NAMED PERSON (tier verified): the page URL and a verbatim quote naming the linked host are
//     recorded with who checked; or
//   - by KEELIX ITSELF (tier official; owner 2026-11-12, "would like it to be automated"): before any
//     address is sent, the job reads the county's page and finds the link in the bytes it retrieved
//     (parcelServiceLink.ts), recording the page, the link as written, the page's own words around it
//     and when it read it. Until that read confirms it — and again after 30 days, or once the page stops
//     linking it — the service is not asked.
// The shared #683 predicate never learns the platform (the county's link vouches, never the platform),
// and any other third-party host is still refused. What goes there is the address the template asks
// for (street, city / ZIP), nothing else: no name, no account, no credential.
//
// WHAT THE GATE DOES WITH IT (strictest default; Helm's #637 bar for when data may block):
//   - the parcel's jurisdiction disagrees with the project AHJ -> a BLOCKER on permit tracks (a filing
//     to the wrong agency), when the record may block (verified, official, or a seeded record that
//     names and quotes its source); a WARNING when it is an uncited seeded record;
//   - it agrees (the same agency, or one that issues for the other per the cited permit-process
//     lookup) -> a pass;
//   - not checked (no record covers the address, the service is down, nothing matched, the job is
//     still queued) -> today's callout, worded "not checked", with the reason.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectRecord } from "../../shared/src/types";
import { isGovernmentHost, isOfficialSourceHost, quoteText, sourceHostOf } from "../../shared/src/officialSource";
import type { AppDb } from "./db";
import { agencyNameKey, sameAgencyName } from "./agencyName";
import { usStateCode } from "./permitPath";
import { STATE_NAMES } from "./permitPlatformCatalog";
import { getPermitProcessLookup } from "./permitProcess";
import { confirmParcelServiceLink, confirmationHolds, linkCheckFresh, readServiceLinkCheck, type ServiceLinkCheck } from "./parcelServiceLink";
import { logger } from "./logger";
import { nowIso } from "./time";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

export const PARCEL_JURISDICTION_JOB = "parcel_jurisdiction_check" as const;

export type LookupSourceTier = "seeded" | "official" | "verified";
const TIER_RANK: Record<LookupSourceTier, number> = { seeded: 0, official: 1, verified: 2 };

/** One county's parcel / city-limits service, as the data file gives it (cleaned). */
export interface JurisdictionLookupSource {
  /** `${STATE}|${county lower-case}` — identity of the record. */
  key: string;
  state: string;
  /** The county as an agency name ("Example County"): the AHJ of an unincorporated parcel. */
  county: string;
  coversCities: string[];
  coversZips: string[];
  queryUrl: string;
  recordsPath: string;
  jurisdictionField: string;
  unincorporatedValues: string[];
  cityNames: Record<string, string>;
  addressStyle: "usps" | "full";
  /** The tier as HONOURED (official / verified only when their conditions hold). */
  tier: LookupSourceTier;
  /** May a disagreement from this record block? (Helm's #637 bar; sourceMayBlock.) */
  mayBlock: boolean;
  sourceName: string;
  sourceUrl: string;
  quote: string;
  fetchedAt: string;
  verifiedBy: string;
  /** Where the service lives: "government" (the #683 predicate), or "map_platform" — a hosted map
   *  platform, admitted only when the county's own government page is shown to link it (draft 16 B). */
  hostedOn: "government" | "map_platform";
  /** map_platform only: the exact service root (https://host/path...) the county's link was checked
   *  against; every query must sit under it. "" for a government host. */
  verifiedService: string;
  /** map_platform only: who shows the county links it — "person" (tier verified, verifiedBy) or
   *  "keelix" (tier official: Keelix reads the county's page itself, parcelServiceLink.ts). "" for a
   *  government host. */
  linkCheck: "person" | "keelix" | "";
  /** keelix only, attached from the database (withLinkChecks): Keelix's latest read of the county's
   *  page. The service is asked only while it holds (parcelServiceLink.confirmationHolds). */
  linkConfirmation?: ServiceLinkCheck | null;
  /** A hash of everything that decides the answer: a cached answer from an older record is stale. */
  fingerprint: string;
}

// ── The data ──────────────────────────────────────────────────────────────────────────────────
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
function referencePath(): string {
  const explicit = str(process.env.JURISDICTION_LOOKUP_SOURCES_PATH);
  if (explicit) return path.resolve(explicit);
  return path.resolve(moduleDir, "..", "data", "reference-jurisdiction-lookup-sources.json");
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The honoured tier: official only with a government source page, a quote naming the service's host
 *  and a fetched-at; verified only with a named person. Anything short of that is seeded. */
function honouredTier(claimed: string, o: { sourceUrl: string; quote: string; fetchedAt: string; verifiedBy: string; serviceHost: string }): LookupSourceTier {
  if (claimed === "verified") return o.verifiedBy ? "verified" : "seeded";
  if (claimed === "official") {
    const ok = isOfficialSourceHost(o.sourceUrl) && quoteNamesHost(o.quote, o.serviceHost) && /^\d{4}-\d{2}-\d{2}/.test(o.fetchedAt);
    return ok ? "official" : "seeded";
  }
  return "seeded";
}

/** Does the quote name the service's host (the page's own words point at THIS service)? */
function quoteNamesHost(quote: string, host: string): boolean {
  const q = quoteText(quote).toLowerCase();
  return q.length >= 8 && !!host && q.includes(host.toLowerCase());
}

/** MAY A DISAGREEMENT FROM THIS RECORD BLOCK? (Helm's #637 bar.) A named person's record or an official
 *  one; or a seeded record that names its source, gives its http(s) page and quotes it with words that
 *  name the service's host. Anything else warns. */
export function sourceMayBlock(s: Pick<JurisdictionLookupSource, "tier" | "sourceName" | "sourceUrl" | "quote" | "queryUrl">): boolean {
  if (s.tier === "verified" || s.tier === "official") return true;
  return Boolean(str(s.sourceName)) && /^https?:\/\//i.test(str(s.sourceUrl)) && quoteNamesHost(s.quote, sourceHostOf(s.queryUrl));
}

/** HOSTED MAP PLATFORMS a county record may name, once a person verified, or Keelix confirmed, that the
 *  county's own government page links the service (draft 16 B; owner 2026-11-10 and 2026-11-12, for
 *  Esri-hosted county maps). A vendor, not a place: widening this list needs the owner's word, so it
 *  is code, reviewed, never data. officialSource's predicate never learns these. */
const PERSON_VERIFIED_MAP_PLATFORMS: readonly string[] = ["arcgis.com"];

export function isPersonVerifiedMapPlatformHost(host: string): boolean {
  const h = str(host).toLowerCase().replace(/\.$/, "");
  return !!h && PERSON_VERIFIED_MAP_PLATFORMS.some((p) => h === p || h.endsWith(`.${p}`));
}

/** Does `url` sit under the verified service root (the root, then "/", "?" or the end)? */
function underServiceRoot(url: string, root: string): boolean {
  if (!root || !url.startsWith(root)) return false;
  const next = url.charAt(root.length);
  return next === "" || next === "/" || next === "?";
}

/** Why a record on a hosted map platform cannot be used ("" = it can). Draft 16 B: a named person
 *  verified it; the county's own GOVERNMENT page links the service and is quoted naming the linked
 *  host; the record names the exact service root, with a path (on a shared platform host the path
 *  names the county's own organisation); never seeded, never official. */
function mapPlatformRefusal(o: Record<string, unknown>, queryUrl: string, serviceHost: string): string {
  if (str(o.tier) !== "verified" || !str(o.verifiedBy)) return "a hosted map service is used only on a person-verified record (tier verified, verifiedBy)";
  const root = str(o.verifiedService).replace(/\/+$/, "");
  if (!root) return "no verifiedService (the exact service root the person checked)";
  if (!/^https:\/\//i.test(root) || sourceHostOf(root) !== serviceHost) return `verifiedService is not on ${serviceHost}`;
  let rootPath = "";
  try { rootPath = new URL(root).pathname.replace(/\/+$/, ""); } catch { rootPath = ""; }
  if (!rootPath) return "verifiedService names a host but no service path";
  if (!underServiceRoot(queryUrl.replace(/\{[a-zA-Z]+\}/g, "x"), root)) return "queryUrl is not under verifiedService";
  const pageHost = sourceHostOf(str(o.sourceUrl));
  if (!pageHost || !isGovernmentHost(pageHost)) return `sourceUrl${pageHost ? ` (${pageHost})` : ""} is not the county's own government page`;
  const linked = str(o.pageLinksHost).toLowerCase() || serviceHost;
  if (!isPersonVerifiedMapPlatformHost(linked)) return "pageLinksHost is not on the hosted map platform";
  if (!quoteNamesHost(str(o.quote), linked)) return `the quote does not name ${linked}`;
  if (!/^\d{4}-\d{2}-\d{2}/.test(str(o.fetchedAt))) return "no fetchedAt";
  return "";
}

/** Why a record on a hosted map platform cannot wait for KEELIX to confirm the county's link ("" = it
 *  can; owner 2026-11-12). The record names the exact service root (serviceRoot, or verifiedService),
 *  with a path, on the query's own host, the query sits under it, and its sourceUrl is an https page on
 *  a GOVERNMENT host (the county's own page, which Keelix will read). No quote is taken from the data:
 *  the evidence is what Keelix finds in the page's bytes. */
function keelixLinkRefusal(o: Record<string, unknown>, queryUrl: string, serviceHost: string): string {
  const root = (str(o.serviceRoot) || str(o.verifiedService)).replace(/\/+$/, "");
  if (!root) return "no serviceRoot (the exact service root the county's page must link)";
  if (!/^https:\/\//i.test(root) || sourceHostOf(root) !== serviceHost) return `serviceRoot is not on ${serviceHost}`;
  let rootPath = "";
  try { rootPath = new URL(root).pathname.replace(/\/+$/, ""); } catch { rootPath = ""; }
  if (!rootPath) return "serviceRoot names a host but no service path";
  if (!underServiceRoot(queryUrl.replace(/\{[a-zA-Z]+\}/g, "x"), root)) return "queryUrl is not under serviceRoot";
  const sourceUrl = str(o.sourceUrl);
  const pageHost = sourceHostOf(sourceUrl);
  if (!/^https:\/\//i.test(sourceUrl) || !pageHost || !isGovernmentHost(pageHost)) return `sourceUrl${pageHost ? ` (${pageHost})` : ""} is not an https page on the county's own government host`;
  return "";
}

/** One record, cleaned; null (with the reason) when it cannot be used. A query URL off a government
 *  host is refused here — the one exception being a record on a hosted map platform whose county link
 *  a person verified (mapPlatformRefusal) or Keelix will confirm (keelixLinkRefusal; asked only once
 *  confirmed) — so no code path can ever be handed any other host. */
export function sanitizeLookupSource(raw: unknown): { source: JurisdictionLookupSource | null; problem: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const state = usStateCode(o.state);
  const county = str(o.county).slice(0, 120);
  const label = `${state || "?"} ${county || "?"}`;
  if (!state || !county) return { source: null, problem: `${label}: no state or county` };
  const queryUrl = str(o.queryUrl).slice(0, 2000);
  if (!/^https:\/\//i.test(queryUrl)) return { source: null, problem: `${label}: queryUrl is not https` };
  // THE ONE PREDICATE (#683), with no authority domain admitted: a government host only — or, draft
  // 16 B, a person-verified record on a hosted map platform.
  const probeHost = sourceHostOf(queryUrl.replace(/\{[a-zA-Z]+\}/g, "x"));
  let hostedOn: "government" | "map_platform" = "government";
  let linkCheck: "person" | "keelix" | "" = "";
  if (!isOfficialSourceHost(queryUrl.replace(/\{[a-zA-Z]+\}/g, "x"))) {
    const notGov = `${label}: ${probeHost || "queryUrl"} is not a government host`;
    if (!isPersonVerifiedMapPlatformHost(probeHost)) return { source: null, problem: notGov };
    const personWhy = mapPlatformRefusal(o, queryUrl, probeHost);
    if (personWhy) {
      const keelixWhy = keelixLinkRefusal(o, queryUrl, probeHost);
      if (keelixWhy) return { source: null, problem: `${notGov} (${personWhy}; nor can Keelix confirm the county links it: ${keelixWhy})` };
      linkCheck = "keelix";
    } else linkCheck = "person";
    hostedOn = "map_platform";
  }
  const jurisdictionField = str(o.jurisdictionField);
  if (!jurisdictionField) return { source: null, problem: `${label}: no jurisdictionField` };
  const covers = (o.covers && typeof o.covers === "object" ? o.covers : {}) as Record<string, unknown>;
  const coversCities = (Array.isArray(covers.cities) ? covers.cities : []).map(str).filter(Boolean);
  const coversZips = (Array.isArray(covers.zips) ? covers.zips : []).map((z) => str(z).slice(0, 5)).filter((z) => /^\d{5}$/.test(z));
  if (!coversCities.length && !coversZips.length) return { source: null, problem: `${label}: covers no city or ZIP` };
  const cityNamesRaw = (o.cityNames && typeof o.cityNames === "object" ? o.cityNames : {}) as Record<string, unknown>;
  const cityNames: Record<string, string> = {};
  for (const [k, v] of Object.entries(cityNamesRaw)) if (str(k) && str(v)) cityNames[str(k).toUpperCase()] = str(v);
  const sourceUrl = /^https?:\/\//i.test(str(o.sourceUrl)) ? str(o.sourceUrl).slice(0, 500) : "";
  const quote = str(o.quote).slice(0, 600);
  const fetchedAt = str(o.fetchedAt).slice(0, 40);
  const verifiedBy = str(o.verifiedBy).slice(0, 120);
  const serviceHost = sourceHostOf(queryUrl.replace(/\{[a-zA-Z]+\}/g, "x"));
  // A record Keelix will confirm is official (#683: Keelix's own read of the county's page), never a
  // person's: it carries no verifiedBy.
  const tier: LookupSourceTier = linkCheck === "keelix" ? "official" : honouredTier(str(o.tier), { sourceUrl, quote, fetchedAt, verifiedBy, serviceHost });
  const base = {
    key: `${state}|${county.toLowerCase()}`,
    state, county, coversCities, coversZips, queryUrl,
    recordsPath: str(o.recordsPath),
    jurisdictionField,
    unincorporatedValues: (Array.isArray(o.unincorporatedValues) ? o.unincorporatedValues : []).map((v) => str(v).toUpperCase()),
    cityNames,
    addressStyle: (str(o.addressStyle) === "full" ? "full" : "usps") as "usps" | "full",
    tier,
    sourceName: str(o.sourceName).slice(0, 200),
    sourceUrl, quote, fetchedAt,
    verifiedBy: linkCheck === "keelix" ? "" : verifiedBy,
    hostedOn,
    verifiedService: linkCheck === "person" ? str(o.verifiedService).replace(/\/+$/, "")
      : linkCheck === "keelix" ? (str(o.serviceRoot) || str(o.verifiedService)).replace(/\/+$/, "") : "",
    linkCheck,
  };
  // Belt and braces: a map-platform record is a person's (verified) or Keelix's to confirm (official), or nothing.
  if (hostedOn === "map_platform" && !((linkCheck === "person" && tier === "verified" && base.verifiedBy) || (linkCheck === "keelix" && tier === "official")))
    return { source: null, problem: `${label}: ${probeHost} is not a government host (no county link to verify)` };
  // A record Keelix confirms also hangs on its source page: a new page is a new check, and a new answer.
  const fingerprint = sha(JSON.stringify([base.key, base.queryUrl, base.verifiedService, base.recordsPath, base.jurisdictionField, base.unincorporatedValues, base.cityNames, base.addressStyle, ...(linkCheck === "keelix" ? [base.sourceUrl] : [])])).slice(0, 16);
  return { source: { ...base, mayBlock: sourceMayBlock(base), fingerprint }, problem: "" };
}

let sourcesCache: { file: string; sources: JurisdictionLookupSource[]; problems: string[] } | null = null;
let sourcesForTests: unknown[] | null = null;

/** Tests hand records in directly (null = read the file again). */
export function setJurisdictionLookupSourcesForTests(records: unknown[] | null): void {
  sourcesForTests = records;
  sourcesCache = null;
}

function loadSources(): { sources: JurisdictionLookupSource[]; problems: string[] } {
  const file = sourcesForTests ? "(tests)" : referencePath();
  if (sourcesCache?.file === file) return sourcesCache;
  let raw: unknown[] = [];
  if (sourcesForTests) raw = sourcesForTests;
  else {
    try { raw = (JSON.parse(fs.readFileSync(file, "utf8")) as { records?: unknown[] }).records ?? []; } catch { raw = []; }
  }
  const sources: JurisdictionLookupSource[] = [];
  const problems: string[] = [];
  for (const r of raw) {
    const { source, problem } = sanitizeLookupSource(r);
    if (source) sources.push(source);
    else problems.push(problem);
  }
  if (problems.length) logger.warn("parcel-jurisdiction", `jurisdiction lookup records dropped: ${problems.join("; ").slice(0, 600)}`);
  sourcesCache = { file, sources, problems };
  return sourcesCache;
}

/** Every usable record, and why any record was dropped (for a person reading the data). */
export function jurisdictionLookupSources(): { sources: JurisdictionLookupSource[]; problems: string[] } {
  const { sources, problems } = loadSources();
  return { sources: [...sources], problems: [...problems] };
}

const cityKey = (c: string): string => str(c).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The records covering an address's state + mailing city / ZIP, strongest tier first. */
export function sourcesCovering(state: string, city: string, zip: string): JurisdictionLookupSource[] {
  const st = usStateCode(state);
  if (!st) return [];
  const zip5 = str(zip).slice(0, 5);
  const ck = cityKey(city);
  return loadSources().sources
    .filter((s) => s.state === st && ((zip5 && s.coversZips.includes(zip5)) || (ck && s.coversCities.some((c) => cityKey(c) === ck))))
    .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier]);
}

// ── The address ───────────────────────────────────────────────────────────────────────────────
/** USPS street-word abbreviations, as data (backend/data/usps-street-abbreviations.json). Read once; a
 *  missing file abbreviates nothing (the street is sent as written, upper-cased). */
let uspsCache: { suffixes: Record<string, string>; directionals: Record<string, string> } | null = null;
function uspsWords(): { suffixes: Record<string, string>; directionals: Record<string, string> } {
  if (uspsCache) return uspsCache;
  const clean = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (str(k) && str(x)) out[str(k).toUpperCase()] = str(x).toUpperCase();
    return out;
  };
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(moduleDir, "..", "data", "usps-street-abbreviations.json"), "utf8")) as Record<string, unknown>;
    uspsCache = { suffixes: clean(raw.suffixes), directionals: clean(raw.directionals) };
  } catch { uspsCache = { suffixes: {}, directionals: {} }; }
  return uspsCache;
}

/** The street line of a project address ("1200 Example Rd, Town, ST 00000" -> "1200 EXAMPLE RD"),
 *  unit dropped, upper-cased, punctuation removed; USPS abbreviations unless the record says "full". */
export function normalizeStreet(projectAddress: string, style: "usps" | "full" = "usps"): string {
  let s = str(projectAddress).split(",")[0] ?? "";
  s = s.toUpperCase().replace(/[.#]/g, " ").replace(/\s+/g, " ").trim();
  // A unit is not part of the parcel's site address.
  s = s.replace(/\s+(?:APT|APARTMENT|UNIT|STE|SUITE|SPC|SPACE|LOT|BLDG)\s+\S+$/, "").trim();
  if (style === "usps") {
    const { suffixes, directionals } = uspsWords();
    s = s.split(" ").map((w, i, all) => {
      if (directionals[w] && (i === 1 || i === all.length - 1)) return directionals[w];
      if (suffixes[w] && i > 1) return suffixes[w];
      return w;
    }).join(" ");
  }
  return /^\d+[A-Z]?\s+\S/.test(s) ? s : "";
}

/** The cache key: a hash of state + street + ZIP (or the mailing city when there is no ZIP). The
 *  address itself is never stored in the cache, a job payload or a log. */
export function parcelAddressKey(project: Pick<ProjectRecord, "projectAddress" | "city" | "state" | "zip">): string {
  const street = normalizeStreet(project.projectAddress, "usps");
  const st = usStateCode(project.state);
  if (!street || !st) return "";
  const where = str(project.zip).slice(0, 5) || cityKey(project.city);
  if (!where) return "";
  return sha(`${st}|${street}|${where}`);
}

/** The fingerprint of the records an answer was read against: when the data changes, the answer is stale. */
function coverFingerprint(sources: JurisdictionLookupSource[]): string {
  return sha(sources.map((s) => s.fingerprint).sort().join(",")).slice(0, 16);
}

// ── The service's answer ──────────────────────────────────────────────────────────────────────
function getPath(obj: unknown, dotted: string): unknown {
  if (!dotted) return obj;
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function titleCase(s: string): string {
  return str(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** The URL for one address against one record: each placeholder SQL-quote-escaped (a `where` clause
 *  quotes it) then URL-encoded. */
export function buildQueryUrl(source: JurisdictionLookupSource, project: Pick<ProjectRecord, "projectAddress" | "city" | "state" | "zip">): string {
  const street = normalizeStreet(project.projectAddress, source.addressStyle);
  const m = /^(\d+[A-Z]?)\s+(.+)$/.exec(street);
  const values: Record<string, string> = {
    street,
    houseNumber: m?.[1] ?? "",
    streetName: m?.[2] ?? "",
    city: str(project.city).toUpperCase(),
    zip: str(project.zip).slice(0, 5),
    state: usStateCode(project.state),
  };
  return source.queryUrl.replace(/\{([a-zA-Z]+)\}/g, (_, k: string) => encodeURIComponent(String(values[k] ?? "").replace(/'/g, "''")));
}

export type ParcelAnswer =
  | { status: "found"; raw: string; agency: string; incorporated: boolean }
  | { status: "no_match"; detail: string }
  | { status: "unavailable"; detail: string };

/** Read one service answer: the jurisdiction value of every match, mapped to an agency name. More than
 *  one jurisdiction among the matches is not an answer (no_match, named). Pure. */
export function parseParcelAnswer(text: string, source: JurisdictionLookupSource): ParcelAnswer {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return { status: "unavailable", detail: "the service's answer is not JSON" }; }
  if (body && typeof body === "object" && (body as Row).error) return { status: "unavailable", detail: "the service answered with an error" };
  const recs = getPath(body, source.recordsPath);
  const list = Array.isArray(recs) ? recs : recs && typeof recs === "object" ? [recs] : [];
  if (!list.length) return { status: "no_match", detail: "no parcel matched the address" };
  const agencies = new Map<string, { raw: string; agency: string; incorporated: boolean }>();
  for (const rec of list) {
    const v = getPath(rec, source.jurisdictionField);
    const raw = v == null ? "" : str(v);
    const up = raw.toUpperCase();
    let hit: { raw: string; agency: string; incorporated: boolean } | null = null;
    if (source.unincorporatedValues.includes(up)) hit = { raw, agency: source.county, incorporated: false };
    else if (raw) {
      const name = source.cityNames[up] ?? titleCase(raw);
      const agency = /^(city|town|village|borough|municipality) of /i.test(name) ? titleCase(name).replace(/ Of /, " of ") : `City of ${name}`;
      hit = { raw, agency, incorporated: true };
    }
    if (hit) agencies.set(agencyNameKey(hit.agency), hit);
  }
  if (!agencies.size) return { status: "no_match", detail: "the matching parcel names no jurisdiction" };
  if (agencies.size > 1) return { status: "no_match", detail: `the address matched parcels in more than one jurisdiction (${[...agencies.values()].map((a) => a.agency).join(", ")})` };
  return { status: "found", ...[...agencies.values()][0] };
}

// ── The fetch (a seam: tests never reach a network) ───────────────────────────────────────────
export type ParcelFetch = (url: string) => Promise<{ status: number; text: string }>;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ANSWER_BYTES = 2_000_000;

/** One plain GET. No redirect is followed (a government URL that bounces elsewhere is not an answer),
 *  no cookie, no credential; the answer is size-capped. */
const defaultFetch: ParcelFetch = async (url) => {
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; jurisdiction-check)" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = (await res.text()).slice(0, MAX_ANSWER_BYTES);
  return { status: res.status, text };
};
let fetchForTests: ParcelFetch | null = null;
/** Tests answer with a fake parcel service. null = the real fetch. */
export function setParcelFetchForTests(fn: ParcelFetch | null): void {
  fetchForTests = fn;
}

/** May this built URL be asked for this record? A government host; or, for a map-platform record
 *  (draft 16 B), the record's own service root and nothing else — when a person verified the county
 *  links it, or Keelix's own read of the county's page confirms it NOW (confirmationHolds). */
export function mayAskServiceUrl(
  source: Pick<JurisdictionLookupSource, "hostedOn" | "tier" | "verifiedService" | "verifiedBy" | "sourceUrl"> & Partial<Pick<JurisdictionLookupSource, "linkCheck" | "linkConfirmation">>,
  url: string,
  now = Date.now(),
): boolean {
  if (isOfficialSourceHost(url)) return true;
  const host = sourceHostOf(url);
  if (source.hostedOn !== "map_platform" || !isPersonVerifiedMapPlatformHost(host) || host !== sourceHostOf(source.verifiedService) || !underServiceRoot(url, source.verifiedService)) return false;
  if (source.linkCheck === "keelix") return source.tier === "official" && confirmationHolds(source.linkConfirmation, source, now);
  return source.tier === "verified" && !!source.verifiedBy;
}

/** The records with Keelix's latest read of each county page attached (a keelix record only). Reads only. */
export function withLinkChecks(db: AppDb, sources: JurisdictionLookupSource[]): JurisdictionLookupSource[] {
  return sources.map((s) => (s.linkCheck === "keelix" ? { ...s, linkConfirmation: readServiceLinkCheck(db, s.key, s.sourceUrl, s.verifiedService) } : s));
}

/** Ask one record's service about one address. Refuses (unavailable) any URL off a government host,
 *  except a person-verified map-platform record's own service root (mayAskServiceUrl). */
export async function askParcelService(source: JurisdictionLookupSource, project: Pick<ProjectRecord, "projectAddress" | "city" | "state" | "zip">): Promise<ParcelAnswer & { host: string }> {
  const url = buildQueryUrl(source, project);
  const host = sourceHostOf(url);
  // At the door as well as at load: nothing but a government host (or the service root a person
  // verified, or Keelix confirmed, the county links — draft 16 B) is ever asked.
  if (!mayAskServiceUrl(source, url)) return { status: "unavailable", detail: `${host || "the query URL"} is not a government host or the person-verified service, nor a service the county's own page is confirmed to link`, host };
  try {
    const res = await (fetchForTests ?? defaultFetch)(url);
    if (res.status < 200 || res.status >= 300) return { status: "unavailable", detail: `the service answered HTTP ${res.status}`, host };
    return { ...parseParcelAnswer(res.text, source), host };
  } catch (err) {
    const msg = err instanceof Error ? err.name === "TimeoutError" ? "timed out" : err.message : String(err);
    return { status: "unavailable", detail: `the service did not answer (${msg.slice(0, 120)})`, host };
  }
}

// ── The cache (parcel_jurisdiction_checks, migration v77) ─────────────────────────────────────
/** A found answer is good for 180 days; "nothing matched" for 30; a service that did not answer is
 *  asked again after 6 hours (the gate says "not checked" meanwhile). */
const FOUND_TTL_MS = 180 * 24 * 3600_000;
const NO_MATCH_TTL_MS = 30 * 24 * 3600_000;
const UNAVAILABLE_RETRY_MS = 6 * 3600_000;

interface CachedCheck {
  status: "found" | "no_match" | "unavailable";
  sourceKey: string;
  fingerprint: string;
  raw: string;
  agency: string;
  incorporated: boolean;
  host: string;
  detail: string;
  checkedAt: string;
}

function readCache(db: AppDb, addressKey: string): CachedCheck | null {
  const row = db.get<Row>("SELECT * FROM parcel_jurisdiction_checks WHERE address_key = ?", [addressKey]);
  if (!row) return null;
  const status = str(row.status);
  if (status !== "found" && status !== "no_match" && status !== "unavailable") return null;
  return {
    status, sourceKey: str(row.source_key), fingerprint: str(row.source_fingerprint), raw: str(row.jurisdiction_raw),
    agency: str(row.parcel_agency), incorporated: Number(row.incorporated) === 1, host: str(row.service_host),
    detail: str(row.detail), checkedAt: str(row.checked_at),
  };
}

function cacheFresh(c: CachedCheck, fingerprint: string, now = Date.now()): boolean {
  if (c.fingerprint !== fingerprint) return false;
  const age = now - Date.parse(c.checkedAt);
  if (!Number.isFinite(age)) return false;
  if (c.status === "found") return age < FOUND_TTL_MS;
  if (c.status === "no_match") return age < NO_MATCH_TTL_MS;
  return age < UNAVAILABLE_RETRY_MS;
}

function writeCache(db: AppDb, addressKey: string, state: string, fingerprint: string, c: Omit<CachedCheck, "fingerprint" | "checkedAt">, checkedAt: string): void {
  db.run(
    `INSERT INTO parcel_jurisdiction_checks
       (address_key, state, source_key, source_fingerprint, status, jurisdiction_raw, parcel_agency, incorporated, service_host, detail, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address_key) DO UPDATE SET
       state = excluded.state, source_key = excluded.source_key, source_fingerprint = excluded.source_fingerprint,
       status = excluded.status, jurisdiction_raw = excluded.jurisdiction_raw, parcel_agency = excluded.parcel_agency,
       incorporated = excluded.incorporated, service_host = excluded.service_host, detail = excluded.detail,
       checked_at = excluded.checked_at`,
    [addressKey, state, c.sourceKey, fingerprint, c.status, c.raw.slice(0, 200), c.agency.slice(0, 200), c.incorporated ? 1 : 0, c.host.slice(0, 200), c.detail.slice(0, 400), checkedAt],
  );
}

// ── The reading the gate takes (reads only) ──────────────────────────────────────────────────
export interface ParcelJurisdictionReading {
  status: "agrees" | "disagrees" | "not_checked";
  /** Why it was not checked, in a person's words (for not_checked). */
  reason: string;
  /** A record covers the job's address (the county's service exists in the data). */
  covered: boolean;
  /** The agency the parcel is in ("City of X" / the county), when the service answered. */
  parcelAgency?: string;
  county?: string;
  host?: string;
  checkedAt?: string;
  tier?: LookupSourceTier;
  mayBlock?: boolean;
  /** The answer came from a hosted map platform (draft 16 B): who verified that the county links it. */
  serviceVerifiedBy?: string;
  /** The answer came from a hosted map platform whose county link KEELIX confirmed (owner 2026-11-12):
   *  the county's page it read, and when. Official, never a person's verification. */
  serviceConfirmedFrom?: { pageUrl: string; pageHost: string; readAt: string };
  /** A NAMED PERSON accepted that the project AHJ files for this parcel although the parcel lies in
   *  another jurisdiction (draft 16 A). Present only on an "agrees" reading that this record turned. */
  acceptedBy?: { by: string; at: string; reason: string };
}

// ── A named person's acceptance (draft 16 A) ───────────────────────────────────────────────────
/** "This AHJ files for this parcel": a named person's answer to ONE disagreement, bound to the address
 *  (hash), the project AHJ and the parcel's jurisdiction it was given against. */
export interface ParcelJurisdictionAcceptance {
  ahj: string;
  parcelAgency: string;
  addressKey: string;
  reason: string;
  by: string;
  at: string;
}

/** The job's acceptance record, or null. Reads only. */
export function parcelAcceptanceOf(db: AppDb, projectId: string): ParcelJurisdictionAcceptance | null {
  try {
    const row = db.get<Row>("SELECT parcel_jurisdiction_acceptance_json AS j FROM projects WHERE id = ?", [projectId]);
    const raw = str(row?.j);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const rec = { ahj: str(o.ahj), parcelAgency: str(o.parcelAgency), addressKey: str(o.addressKey), reason: str(o.reason), by: str(o.by), at: str(o.at) };
    return rec.by && rec.ahj && rec.parcelAgency && rec.addressKey ? rec : null;
  } catch { return null; }
}

/** Does the acceptance answer THIS disagreement? The same address, the same AHJ and the same parcel
 *  jurisdiction it was given against; anything changed and the blocker is back. */
function acceptanceApplies(a: ParcelJurisdictionAcceptance | null, addressKey: string, ahj: string, parcelAgency: string): boolean {
  return !!a && a.addressKey === addressKey && sameAgencyName(a.ahj, ahj) && sameAgencyName(a.parcelAgency, parcelAgency);
}

/** Why an acceptance cannot be recorded now (null = it can): only a CURRENT disagreement can be accepted. */
function acceptRefusal(reading: ParcelJurisdictionReading): string | null {
  if (reading.status === "disagrees") return null;
  if (reading.acceptedBy) return "This parcel's jurisdiction is already accepted for this AHJ.";
  if (reading.status === "agrees") return "The parcel already agrees with the project AHJ: there is nothing to accept.";
  return `The parcel's jurisdiction has not been checked (${reading.reason}): there is nothing to accept yet.`;
}

/**
 * A NAMED PERSON ACCEPTS THAT THE PROJECT AHJ FILES FOR THIS PARCEL (draft 16 A). Only against a
 * current disagreement, with a reason; `by` is the person the route named (server.namedPersonDecider —
 * never automatic). The gate then shows a pass naming the person instead of the blocker, until the
 * address, the AHJ or the parcel's answer changes. Audited; the gate is re-judged.
 */
export async function acceptParcelJurisdiction(
  db: AppDb,
  project: Pick<ProjectRecord, "id" | "projectAddress" | "city" | "state" | "zip" | "ahj">,
  input: { reason: string; by: string },
): Promise<ParcelJurisdictionReading> {
  const { HttpError } = await import("./httpError");
  const by = str(input.by).slice(0, 120);
  if (!by) throw new HttpError(400, "Name the person accepting the parcel's jurisdiction.");
  const reason = str(input.reason).replace(/\s+/g, " ").slice(0, 500);
  if (reason.length < 8) throw new HttpError(400, "Say why this AHJ files for this parcel (for example, the agreement or the agency's own words).");
  const reading = readParcelJurisdiction(db, project);
  const refusal = acceptRefusal(reading);
  if (refusal) throw new HttpError(409, refusal);
  const record: ParcelJurisdictionAcceptance = {
    ahj: str(project.ahj), parcelAgency: str(reading.parcelAgency), addressKey: parcelAddressKey(project), reason, by, at: nowIso(),
  };
  db.run("UPDATE projects SET parcel_jurisdiction_acceptance_json = ? WHERE id = ?", [JSON.stringify(record), project.id]);
  const { addAuditLog } = await import("./audit");
  addAuditLog(db, project.id, "human", by, "parcel_jurisdiction.accepted", {
    ahj: record.ahj, parcelAgency: record.parcelAgency, reason, county: reading.county ?? "", host: reading.host ?? "",
  });
  await rejudgeAfterAcceptance(db, project.id, "parcel_jurisdiction_accepted");
  return readParcelJurisdiction(db, project);
}

/** A named person withdraws the job's acceptance: the blocker returns if the parcel still disagrees. */
export async function withdrawParcelJurisdictionAcceptance(db: AppDb, projectId: string, by: string): Promise<boolean> {
  const { HttpError } = await import("./httpError");
  const who = str(by).slice(0, 120);
  if (!who) throw new HttpError(400, "Name the person withdrawing the acceptance.");
  const held = parcelAcceptanceOf(db, projectId);
  if (!held) return false;
  db.run("UPDATE projects SET parcel_jurisdiction_acceptance_json = '' WHERE id = ?", [projectId]);
  const { addAuditLog } = await import("./audit");
  addAuditLog(db, projectId, "human", who, "parcel_jurisdiction.acceptance_withdrawn", { ahj: held.ahj, parcelAgency: held.parcelAgency, acceptedBy: held.by });
  await rejudgeAfterAcceptance(db, projectId, "parcel_jurisdiction_acceptance_withdrawn");
  return true;
}

async function rejudgeAfterAcceptance(db: AppDb, projectId: string, trigger: string): Promise<void> {
  try {
    const { rejudgeReviewerGateForProject } = await import("./repository");
    await rejudgeReviewerGateForProject(db, projectId, trigger);
  } catch (err) {
    logger.warn("parcel-jurisdiction", `re-judge after ${trigger} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** An AHJ that is a STATE agency (a state's electrical division) is not a local jurisdiction: the
 *  parcel's city or county is not compared with it. */
export function isStateLevelAgency(ahj: string, state: string): boolean {
  const key = agencyNameKey(ahj);
  if (!key) return false;
  if (/\b(city|town|county|village|borough|township|parish)\b/.test(key)) return false;
  const full = STATE_NAMES[usStateCode(state).toLowerCase()] ?? "";
  if (/^state\b|\bstate of\b/.test(str(ahj).toLowerCase())) return true;
  return !!full && (key === full || key === `state of ${full}`);
}

/** The agency that issues a jurisdiction's permits per its cited permit-process lookup (a county can
 *  issue for a city), or "". Reads only. */
function issuerOf(db: AppDb, state: string, name: string): string {
  try { return str(getPermitProcessLookup(db, state, name)?.issuingAgency?.value); } catch { return ""; }
}

/** Do the project AHJ and the parcel's jurisdiction name the same filing agency? The same agency by
 *  name (agencyName.sameAgencyName), or one issues for the other per a cited permit-process lookup. */
export function agenciesAgree(db: AppDb | null, state: string, ahj: string, parcelAgency: string): boolean {
  const left = [ahj, db ? issuerOf(db, state, ahj) : ""].filter(Boolean);
  const right = [parcelAgency, db ? issuerOf(db, state, parcelAgency) : ""].filter(Boolean);
  return left.some((a) => right.some((b) => sameAgencyName(a, b)));
}

/** Is a parcel check for this project queued or running? */
function checkQueued(db: AppDb, projectId: string): boolean {
  try {
    return !!db.get<Row>(
      "SELECT id FROM job_queue WHERE job_type = ? AND project_id = ? AND status IN ('pending','running') LIMIT 1",
      [PARCEL_JURISDICTION_JOB, projectId],
    );
  } catch { return false; }
}

/**
 * WHAT THE PARCEL SAYS ABOUT THIS JOB'S JURISDICTION — read from the cache only. No network, no write,
 * no job queued: a page read stays a read. The gate (repository.buildReviewerReportFor) takes this.
 */
export function readParcelJurisdiction(db: AppDb, project: Pick<ProjectRecord, "id" | "projectAddress" | "city" | "state" | "zip" | "ahj">): ParcelJurisdictionReading {
  const notChecked = (reason: string, covered: boolean): ParcelJurisdictionReading => ({ status: "not_checked", reason, covered });
  const sources = sourcesCovering(project.state, project.city, project.zip);
  if (!sources.length) return notChecked("no parcel lookup is on file for this address's county", false);
  const addressKey = parcelAddressKey(project);
  if (!addressKey) return notChecked("the job has no street address to look up", true);
  const fingerprint = coverFingerprint(sources);
  let cached: CachedCheck | null = null;
  try { cached = readCache(db, addressKey); } catch { cached = null; }
  if (!cached || cached.fingerprint !== fingerprint || (cached.status !== "unavailable" && !cacheFresh(cached, fingerprint))) {
    return notChecked(checkQueued(db, project.id) ? "the parcel lookup is queued" : "the parcel has not been looked up yet", true);
  }
  const found = sources.find((s) => s.key === cached!.sourceKey);
  const source = found ? withLinkChecks(db, [found])[0] : undefined;
  const link = source?.linkCheck === "keelix" ? source.linkConfirmation ?? null : null;
  const at = {
    county: source?.county ?? sources[0].county, host: cached.host, checkedAt: cached.checkedAt,
    ...(source?.hostedOn === "map_platform" && source.linkCheck === "person" && source.verifiedBy ? { serviceVerifiedBy: source.verifiedBy } : {}),
    ...(link?.status === "confirmed" ? { serviceConfirmedFrom: { pageUrl: link.pageUrl, pageHost: sourceHostOf(link.pageUrl), readAt: link.checkedAt } } : {}),
  };
  if (cached.status === "unavailable") return { ...notChecked(`the county's parcel service did not answer: ${cached.detail}`, true), ...at };
  if (cached.status === "no_match") return { ...notChecked(`the county's parcel service could not place the address: ${cached.detail}`, true), ...at };
  if (!source) return notChecked("the parcel has not been looked up yet", true);
  // KEELIX'S CONFIRMATION (owner 2026-11-12): an answer from a hosted map stands while Keelix's read of
  // the county's page is on file and has not since found the link gone.
  if (source.linkCheck === "keelix") {
    if (!link) return notChecked("Keelix has not yet confirmed that the county's own page links its hosted parcel map", true);
    if (link.status === "refused" && Date.parse(link.checkedAt) >= Date.parse(cached.checkedAt))
      return { ...notChecked(`the county's own page no longer confirms its hosted parcel map (read ${link.checkedAt.slice(0, 10)}: ${link.detail})`, true), county: source.county, host: cached.host };
  }
  const ahj = str(project.ahj);
  if (!ahj) return { ...notChecked("the job has no AHJ to compare", true), ...at, parcelAgency: cached.agency };
  if (isStateLevelAgency(ahj, project.state)) return { ...notChecked(`the project AHJ (${ahj}) is a state agency; the parcel is in ${cached.agency}`, true), ...at, parcelAgency: cached.agency };
  const agree = agenciesAgree(db, project.state, ahj, cached.agency);
  // A NAMED PERSON'S ACCEPTANCE (draft 16 A) answers this disagreement only — the same address, AHJ
  // and parcel answer it was given against.
  const accepted = !agree ? parcelAcceptanceOf(db, project.id) : null;
  const applies = acceptanceApplies(accepted, addressKey, ahj, cached.agency);
  return {
    status: agree || applies ? "agrees" : "disagrees", reason: "", covered: true, ...at,
    parcelAgency: cached.agency, tier: source.tier, mayBlock: source.mayBlock,
    ...(applies && accepted ? { acceptedBy: { by: accepted.by, at: accepted.at, reason: accepted.reason } } : {}),
  };
}

// ── The job ──────────────────────────────────────────────────────────────────────────────────
/**
 * QUEUE THE PARCEL CHECK FOR A PERMIT-TRACK JOB. Called from QC (a write path) — never from a page
 * read. Only where a record covers the address and no fresh answer is cached; one pending job per
 * project. Off with PARCEL_LOOKUP=off, and in a process that runs no job worker (the smoke, unit tests
 * and scripts never start background network reads by running QC). Best-effort: never throws.
 */
export async function ensureParcelJurisdictionChecked(db: AppDb, projectId: string): Promise<number> {
  try {
    if (process.env.PARCEL_LOOKUP === "off") return 0;
    const jobQueue = await import("./jobQueue");
    if (!jobQueue.jobWorkerRunning()) return 0;
    return queueParcelCheck(db, projectId, jobQueue.enqueueJob);
  } catch {
    return 0;
  }
}

/** The enqueue decision itself (exported for tests, which pass their own enqueue). */
export function queueParcelCheck(
  db: AppDb,
  projectId: string,
  enqueue: (db: AppDb, type: typeof PARCEL_JURISDICTION_JOB, payload: Record<string, unknown>, opts: { priority: number; maxRetries: number; projectId: string }) => unknown,
): number {
  const row = db.get<Row>("SELECT project_address, city, state, zip FROM projects WHERE id = ?", [projectId]);
  if (!row) return 0;
  const project = { projectAddress: str(row.project_address), city: str(row.city), state: str(row.state), zip: str(row.zip) };
  const sources = sourcesCovering(project.state, project.city, project.zip);
  if (!sources.length) return 0;
  const addressKey = parcelAddressKey(project);
  if (!addressKey) return 0;
  const cached = readCache(db, addressKey);
  if (cached && cacheFresh(cached, coverFingerprint(sources))) return 0;
  if (checkQueued(db, projectId)) return 0;
  // The payload names the project and the address HASH only: never the address.
  enqueue(db, PARCEL_JURISDICTION_JOB, { projectId, addressKey }, { priority: 3, maxRetries: 2, projectId });
  logger.info("parcel-jurisdiction", "parcel jurisdiction check queued", { projectId });
  return 1;
}

/**
 * THE JOB BODY. Reads the project's address at run time, asks each covering record's service (strongest
 * tier first) until one places the address, and caches the answer by the address hash. A service that
 * is down is cached as "unavailable" (the gate says "not checked"; asked again after 6 hours). The
 * result names no address.
 */
export async function runParcelJurisdictionCheck(db: AppDb, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projectId = str(payload.projectId);
  const row = projectId ? db.get<Row>("SELECT project_address, city, state, zip FROM projects WHERE id = ?", [projectId]) : null;
  if (!row) return { skipped: true, reason: "no such project" };
  const project = { projectAddress: str(row.project_address), city: str(row.city), state: str(row.state), zip: str(row.zip) };
  const sources = sourcesCovering(project.state, project.city, project.zip);
  if (!sources.length) return { skipped: true, reason: "no parcel lookup on file for this address" };
  const addressKey = parcelAddressKey(project);
  if (!addressKey) return { skipped: true, reason: "no street address" };
  const fingerprint = coverFingerprint(sources);
  const state = usStateCode(project.state);
  let outcome: Omit<CachedCheck, "fingerprint" | "checkedAt"> | null = null;
  const misses: string[] = [];
  let anyUnavailable = false;
  for (const listed of sources) {
    let source = withLinkChecks(db, [listed])[0];
    // A hosted map Keelix confirms: read the county's own page FIRST (nothing of this job goes there),
    // unless a fresh read is on file; the service is asked only when the read confirms the link.
    if (source.linkCheck === "keelix" && !linkCheckFresh(source.linkConfirmation ?? null)) {
      source = { ...source, linkConfirmation: await confirmParcelServiceLink(db, source) };
    }
    if (source.linkCheck === "keelix" && !confirmationHolds(source.linkConfirmation, source)) {
      anyUnavailable = true;
      misses.push(`${source.county}: the county's own page does not confirm its hosted parcel map (${source.linkConfirmation?.detail || "not read"})`);
      continue;
    }
    const answer = await askParcelService(source, project);
    if (answer.status === "found") {
      outcome = { status: "found", sourceKey: source.key, raw: answer.raw, agency: answer.agency, incorporated: answer.incorporated, host: answer.host, detail: "" };
      break;
    }
    if (answer.status === "unavailable") anyUnavailable = true;
    misses.push(`${source.county}: ${answer.detail}`);
  }
  if (!outcome) {
    const last = sources[sources.length - 1];
    outcome = {
      status: anyUnavailable ? "unavailable" : "no_match",
      sourceKey: last.key, raw: "", agency: "", incorporated: false,
      host: sourceHostOf(last.queryUrl.replace(/\{[a-zA-Z]+\}/g, "x")), detail: misses.join("; ").slice(0, 400),
    };
  }
  writeCache(db, addressKey, state, fingerprint, outcome, nowIso());
  return {
    status: outcome.status, county: sources.find((s) => s.key === outcome!.sourceKey)?.county ?? "",
    ...(outcome.status === "found" ? { parcelAgency: outcome.agency, incorporated: outcome.incorporated } : { detail: outcome.detail }),
    host: outcome.host,
  };
}
