// ---------------------------------------------------------------------------
// WHO QUALIFIES: a utility's customer-generation PROGRAM limits, and an AHJ's simplified permit
// PATH limits, as cited per-authority DATA (#679).
//
// Before this, the only program limit the code knew was one state's 25 kW net-metering cap, coded
// under a state test in baselineRules. Every other utility's program (a city-owned utility's pilot
// cap, a required production meter, an installer certification required from a date) and every
// city's simplified-packet ceiling (kW, strings per inverter) was invisible, so a job that did not
// qualify was filed and rejected. The owner's rule (2026-11-09): a generic mechanism plus data per
// authority, never logic keyed to one state, utility or city.
//
// One record per authority (authority_eligibility_limits, migration v67), each limit cited by name,
// URL and the source's own words. Rows ship in backend/data/reference-eligibility-limits.json and
// land SEEDED; research may propose more (cited, seeded); a row a person verified is never written
// again (rule 3).
//
// What a screen does with a limit (strictest baseline, Helm's #637 bar):
//   - over the limit is a WARNING by default;
//   - a BLOCKER only when the citation names its source, gives the URL, and quotes words that carry
//     the limit's own value — and the limit binds every job (no `appliesOnlyTo` condition the job
//     data cannot confirm);
//   - an UNKNOWN is a warning that says so, never a pass: no program record on file for the job's
//     utility, a strings count or production meter the plans do not show, a certification the
//     client record does not list.
// A permit path the job exceeds is NOT OFFERED for it (permitPathOffers).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthorityEligibilityRecord, EligibilityCitation, EligibilityLimit, EligibilityLimits, QcStatus, Severity } from "../../shared/src/types";
import { landingTierFor, officialSourceWords, shippedRowTier, sourceHostOf } from "../../shared/src/officialSource";
import type { AppDb } from "./db";
import { addAuditLog } from "./audit";
import { logger } from "./logger";
import { usStateCode } from "./permitPath";

type Kind = AuthorityEligibilityRecord["authorityKind"];

export interface EligibilityFinding {
  ruleId: string;
  ruleName: string;
  qcStatus: QcStatus;
  severity: Severity;
  message: string;
  fieldName?: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** An authority's name as a matching key: words only, corporate suffixes and a leading
 *  "city of" / "town of" dropped. EXACT key — no fuzzy bridge, so a limit never lands on a
 *  neighbour with a similar name. */
export function normalizeAuthorityName(name: string): string {
  return str(name).toLowerCase().replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|co|corp|company|llc)\b/g, " ")
    .replace(/^\s*(?:the\s+)?(?:city|town|village)\s+of\s+/, " ")
    .replace(/\s+/g, " ").trim();
}

export function eligibilityKey(kind: Kind, state: string, authority: string): string {
  return `${kind}|${usStateCode(state).toLowerCase()}|${normalizeAuthorityName(authority)}`;
}

// ── Shipped reference rows ──────────────────────────────────────────────────────────────────
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
function referencePath(): string {
  const explicit = str(process.env.ELIGIBILITY_LIMITS_REFERENCE_PATH);
  if (explicit) return path.resolve(explicit);
  return path.resolve(moduleDir, "..", "data", "reference-eligibility-limits.json");
}

let shippedCache: { file: string; records: AuthorityEligibilityRecord[] } | null = null;
/** The shipped reference rows. Read once per file; a missing or broken file is no rows. A row lands
 *  seeded unless it claims "official" and every one of its limits passes the shared bar
 *  (shippedRowTier: an official host, words that carry the value, fetched-at); a row that falls short
 *  lands seeded and never throws. */
export function shippedEligibilityRecords(filePath = referencePath()): AuthorityEligibilityRecord[] {
  if (shippedCache?.file === filePath) return shippedCache.records;
  let records: AuthorityEligibilityRecord[] = [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as { records?: unknown[] };
    records = (data.records ?? []).map((r): AuthorityEligibilityRecord | null => {
      const rec = sanitizeRecord(r, "seeded");
      return rec ? { ...rec, confidence: shippedRecordTier((r as Record<string, unknown> | null)?.tier, rec) } : null;
    }).filter((r): r is AuthorityEligibilityRecord => r != null);
  } catch { records = []; }
  shippedCache = { file: filePath, records };
  return records;
}

function sanitizeCitation(raw: unknown): EligibilityCitation {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fetchedAt = str(c.fetchedAt);
  return {
    sourceName: str(c.sourceName).slice(0, 200), sourceUrl: /^https?:\/\//i.test(str(c.sourceUrl)) ? str(c.sourceUrl).slice(0, 500) : "", quote: str(c.quote).slice(0, 600),
    ...(/^\d{4}-\d{2}-\d{2}/.test(fetchedAt) ? { fetchedAt: fetchedAt.slice(0, 40) } : {}),
  };
}

function sanitizeLimit<T>(raw: unknown, coerce: (v: unknown) => T | null): EligibilityLimit<T> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const value = coerce(o.value);
  if (value == null) return undefined;
  const citation = sanitizeCitation(o.citation);
  // EVERY LIMIT IS CITED: a limit with no source at all is not a limit, it is a guess.
  if (!citation.sourceName && !citation.sourceUrl) return undefined;
  return {
    value, citation,
    ...(str(o.appliesOnlyTo) ? { appliesOnlyTo: str(o.appliesOnlyTo).slice(0, 200) } : {}),
    ...(str(o.ruleId) ? { ruleId: str(o.ruleId).slice(0, 80) } : {}),
    ...(str(o.ruleName) ? { ruleName: str(o.ruleName).slice(0, 120) } : {}),
    ...(str(o.message) ? { message: str(o.message).slice(0, 400) } : {}),
  };
}

const positiveNumber = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(str(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const trueOnly = (v: unknown): boolean | null => (v === true ? true : null);
const certification = (v: unknown): { name: string; effectiveFrom: string } | null => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const name = str(o.name).slice(0, 120);
  const from = str(o.effectiveFrom);
  return name ? { name, effectiveFrom: /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : "" } : null;
};

export function sanitizeLimits(raw: unknown): EligibilityLimits {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: EligibilityLimits = {};
  const dc = sanitizeLimit(o.maxDcKw, positiveNumber); if (dc) out.maxDcKw = dc;
  const ac = sanitizeLimit(o.maxAcKw, positiveNumber); if (ac) out.maxAcKw = ac;
  const strings = sanitizeLimit(o.maxStringsPerInverter, positiveNumber); if (strings) out.maxStringsPerInverter = strings;
  const meter = sanitizeLimit(o.productionMeterRequired, trueOnly); if (meter) out.productionMeterRequired = meter;
  const cert = sanitizeLimit(o.installerCertification, certification); if (cert) out.installerCertification = cert;
  return out;
}

function sanitizeRecord(raw: unknown, confidence: AuthorityEligibilityRecord["confidence"]): AuthorityEligibilityRecord | null {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = str(o.authorityKind);
  const state = usStateCode(o.state);
  if ((kind !== "utility_program" && kind !== "permit_path") || !state) return null;
  const limits = sanitizeLimits(o.limits);
  if (!Object.keys(limits).length) return null;
  return { authorityKind: kind, state, authority: str(o.authority).slice(0, 200), programName: str(o.programName).slice(0, 200), limits, confidence };
}

/** A shipped record's honoured tier: "official" only when it claims it and EVERY limit's citation
 *  passes shippedRowTier with its own words carrying the limit (quoteCarries, the one test the
 *  research path and the #637 bar already use). A program cap is a fact, never a filing door. */
export function shippedRecordTier(claimed: unknown, rec: Pick<AuthorityEligibilityRecord, "limits">, authorityHosts: readonly string[] = []): "official" | "seeded" {
  const limits = Object.entries(rec.limits) as Array<[keyof EligibilityLimits, EligibilityLimit<unknown>]>;
  if (!limits.length) return "seeded";
  return limits.every(([key, limit]) => shippedRowTier(claimed, {
    sourceUrl: limit.citation.sourceUrl, quote: limit.citation.quote, fetchedAt: limit.citation.fetchedAt,
    verifiedAuthorityHosts: authorityHosts,
    quoteStatesValue: (q) => quoteCarries(key, limit.value, q),
  }).tier === "official") ? "official" : "seeded";
}

/** A page Keelix itself retrieved, by URL: its text and when it was read. */
export interface RetrievedLimitPage { text: string; fetchedAt: string }

/**
 * A LOOKUP-FOUND RECORD'S TIER (official-source slice 4; CLAUDE.md rule 3). "official" only when EVERY
 * limit's citation passes the one landing test, landingTierFor: its host passes the shared predicate
 * (the authority's own hosts include a government page's vouch), its quote is in the bytes this process
 * retrieved from that URL, with the fetched-at of that read; and the quote carries the limit's value
 * (quoteCarries, the same test acceptProposedLimits and the #637 bar use). Anything short is "seeded".
 * The official record's citations carry the fetched-at of the read that confirmed them.
 */
export function lookupRecordTier(
  rec: Pick<AuthorityEligibilityRecord, "limits">,
  pages: ReadonlyMap<string, RetrievedLimitPage>,
  authorityHosts: readonly string[],
): { tier: "official" | "seeded"; limits: EligibilityLimits; reasons: string[] } {
  const entries = Object.entries(rec.limits) as Array<[keyof EligibilityLimits, EligibilityLimit<unknown>]>;
  const reasons: string[] = [];
  const stamped: EligibilityLimits = {};
  for (const [key, limit] of entries) {
    const page = pages.get(limit.citation.sourceUrl);
    // The quote is its own "value" for landingTierFor (the in-bytes and host checks); quoteCarries is
    // the limit-shaped value test (a number, a production meter, a certification's name).
    const land = landingTierFor({
      sourceUrl: limit.citation.sourceUrl, quote: limit.citation.quote, value: limit.citation.quote,
      ...(page ? { fetchedAt: page.fetchedAt, retrievedText: page.text } : {}), verifiedAuthorityHosts: authorityHosts,
    });
    if (land.tier !== "official") reasons.push(...land.reasons.map((r) => `${key}: ${r}`));
    else if (!quoteCarries(key, limit.value, limit.citation.quote)) reasons.push(`${key}: the quote does not carry the limit`);
    (stamped as Record<string, unknown>)[key] = page ? { ...limit, citation: { ...limit.citation, fetchedAt: page.fetchedAt } } : limit;
  }
  if (!entries.length) reasons.push("no limits");
  return reasons.length ? { tier: "seeded", limits: rec.limits, reasons } : { tier: "official", limits: stamped, reasons };
}

/** The hosts a record's limits cite (an official row is refreshed only from the same hosts). */
const citedHosts = (limits: EligibilityLimits): string =>
  [...new Set(Object.values(limits).map((l) => sourceHostOf(str((l as EligibilityLimit<unknown>)?.citation?.sourceUrl))))].sort().join(" ");

// ── Store (authority_eligibility_limits: created by db.ts migration v67, never lazily) ──────────
type Row = Record<string, unknown>;
function rowToRecord(row: Row): AuthorityEligibilityRecord | null {
  let limits: unknown = {};
  try { limits = JSON.parse(str(row.limits_json) || "{}"); } catch { limits = {}; }
  const verified = Boolean(str(row.verified_at));
  // 'official' (#683: read from the authority's own official source) is usable like verified; this
  // module writes it only for a shipped row honoured as official (seedEligibilityRecords, shippedRowTier).
  const confidence = verified ? "verified" : str(row.confidence) === "official" ? "official" : "seeded";
  const rec = sanitizeRecord({ authorityKind: row.authority_kind, state: row.state, authority: row.authority, programName: row.program_name, limits }, confidence);
  if (!rec) return null;
  return verified ? { ...rec, verifiedAt: str(row.verified_at), verifiedBy: str(row.verified_by) } : rec;
}

/**
 * THE WRITE PATH. A seed or a research proposal lands 'seeded'; only a call naming the person
 * (`verifiedBy`) writes 'verified'. A verified row is never overwritten by anything less (rule 3).
 */
export function saveEligibilityRecord(
  db: AppDb,
  input: Omit<AuthorityEligibilityRecord, "confidence" | "verifiedAt" | "verifiedBy">,
  opts: { verifiedBy?: string } = {},
): { saved: boolean; reason: string } {
  const rec = sanitizeRecord(input, "seeded");
  if (!rec) return { saved: false, reason: "not a record: needs a kind, a US state and at least one cited limit" };
  const key = eligibilityKey(rec.authorityKind, rec.state, rec.authority);
  const verifiedBy = str(opts.verifiedBy);
  const existing = db.get<Row>("SELECT verified_at, confidence FROM authority_eligibility_limits WHERE record_key = ?", [key]);
  if (existing && str(existing.verified_at) && !verifiedBy) {
    return { saved: false, reason: "a person verified this record; a seed or lookup never overwrites it" };
  }
  // A row read from the authority's official source (#683 writes it) is not replaced by a seed either.
  if (existing && str(existing.confidence) === "official" && !verifiedBy) {
    return { saved: false, reason: "this record came from an official source; a seed or lookup never overwrites it" };
  }
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO authority_eligibility_limits (record_key, authority_kind, state, authority, program_name, limits_json, confidence, verified_at, verified_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(record_key) DO UPDATE SET authority = excluded.authority, program_name = excluded.program_name,
       limits_json = excluded.limits_json, confidence = excluded.confidence, verified_at = excluded.verified_at,
       verified_by = excluded.verified_by, updated_at = excluded.updated_at`,
    [key, rec.authorityKind, rec.state, rec.authority, rec.programName, JSON.stringify(rec.limits),
      verifiedBy ? "verified" : "seeded", verifiedBy ? now : "", verifiedBy, now],
  );
  return { saved: true, reason: verifiedBy ? "verified" : "seeded" };
}

/** The one official write: replaces a seeded or official row (callers check the person's row and
 *  the same-host refresh rule first). */
function writeOfficialRecord(db: AppDb, key: string, rec: Omit<AuthorityEligibilityRecord, "confidence" | "verifiedAt" | "verifiedBy">): void {
  db.run(
    `INSERT INTO authority_eligibility_limits (record_key, authority_kind, state, authority, program_name, limits_json, confidence, verified_at, verified_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'official', '', '', ?)
     ON CONFLICT(record_key) DO UPDATE SET authority = excluded.authority, program_name = excluded.program_name,
       limits_json = excluded.limits_json, confidence = excluded.confidence, verified_at = excluded.verified_at,
       verified_by = excluded.verified_by, updated_at = excluded.updated_at`,
    [key, rec.authorityKind, rec.state, rec.authority, rec.programName, JSON.stringify(rec.limits), new Date().toISOString()],
  );
}

const LOOKUP_CONFLICT_ACTION = "eligibility_limits.official_conflict";

/**
 * LAND A LOOKUP'S LIMITS (official-source slice 4). Graded by lookupRecordTier against the pages this
 * process read. A seeded grade goes through saveEligibilityRecord (never over a person's or an official
 * row). An official grade replaces a seeded row; refreshes an official row only from the same hosts;
 * and never touches a person's row: an official read that DIFFERS from it is recorded once as a
 * conflict for a person (audit log), the row unchanged. A program limit is a fact, never a filing door.
 */
export function landLookupEligibilityRecord(
  db: AppDb,
  input: Omit<AuthorityEligibilityRecord, "confidence" | "verifiedAt" | "verifiedBy">,
  evidence: { pages: ReadonlyMap<string, RetrievedLimitPage>; authorityHosts: readonly string[] },
): { saved: boolean; tier: "official" | "seeded"; reason: string; conflict?: boolean } {
  const rec = sanitizeRecord(input, "seeded");
  if (!rec) return { saved: false, tier: "seeded", reason: "not a record: needs a kind, a US state and at least one cited limit" };
  const graded = lookupRecordTier(rec, evidence.pages, evidence.authorityHosts);
  if (graded.tier !== "official") {
    const r = saveEligibilityRecord(db, rec);
    return { saved: r.saved, tier: "seeded", reason: r.saved ? `seeded (${graded.reasons.slice(0, 3).join("; ")})` : r.reason };
  }
  const official = { ...rec, limits: graded.limits };
  const key = eligibilityKey(rec.authorityKind, rec.state, rec.authority);
  const row = db.get<Row>("SELECT limits_json, verified_at, confidence FROM authority_eligibility_limits WHERE record_key = ?", [key]);
  let stored: EligibilityLimits = {};
  try { stored = sanitizeLimits(JSON.parse(str(row?.limits_json) || "{}")); } catch { stored = {}; }
  if (row && str(row.verified_at)) {
    const differs = limitValues(stored) !== limitValues(official.limits);
    if (differs) {
      const fp = `${key}|${limitValues(stored)}|${limitValues(official.limits)}|${citedHosts(official.limits)}`;
      const seen = db.get<{ id: string }>("SELECT id FROM audit_logs WHERE action = ? AND details LIKE ? LIMIT 1", [LOOKUP_CONFLICT_ACTION, `%"fingerprint":${JSON.stringify(fp)}%`]);
      if (!seen) {
        addAuditLog(db, null, "system", "eligibility-lookup", LOOKUP_CONFLICT_ACTION, {
          state: rec.state, authority: rec.authority, kind: rec.authorityKind, current: JSON.parse(limitValues(stored)), found: JSON.parse(limitValues(official.limits)),
          sources: Object.values(official.limits).map((l) => (l as EligibilityLimit<unknown>).citation.sourceUrl), fingerprint: fp,
        });
        logger.warn("eligibility", `${rec.authority} (${rec.state}): an official page reads its program limits differently from the record a person verified; kept as a conflict for a person, the record is unchanged`);
      }
    }
    return { saved: false, tier: "official", reason: "a person verified this record; an official read never overwrites it", conflict: differs };
  }
  if (row && str(row.confidence) === "official" && citedHosts(stored) !== citedHosts(official.limits)) {
    return { saved: false, tier: "official", reason: `an official record is on file from ${citedHosts(stored)}; it is refreshed only from the same source` };
  }
  writeOfficialRecord(db, key, official);
  return { saved: true, tier: "official", reason: "official" };
}

/** The limits' values only (no citations), for telling a real difference from a re-citation. */
const limitValues = (limits: EligibilityLimits): string =>
  JSON.stringify(Object.fromEntries(Object.entries(limits).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, l]) => [k, (l as EligibilityLimit<unknown>).value])));

/** Seed the shipped rows. Idempotent; never over a verified row (rule 3). A shipped row honoured as
 *  official (shippedEligibilityRecords) lands official: it replaces a seeded row, refreshes an official
 *  row only from the same hosts, and never touches a person's row. */
export function seedEligibilityRecords(db: AppDb, filePath = referencePath()): number {
  let written = 0;
  for (const rec of shippedEligibilityRecords(filePath)) {
    const key = eligibilityKey(rec.authorityKind, rec.state, rec.authority);
    const row = db.get<Row>("SELECT limits_json, program_name, verified_at, confidence FROM authority_eligibility_limits WHERE record_key = ?", [key]);
    if (row && str(row.verified_at)) continue;
    const storedTier = str(row?.confidence) === "official" ? "official" : "seeded";
    if (row && str(row.limits_json) === JSON.stringify(rec.limits) && str(row.program_name) === rec.programName && storedTier === rec.confidence) continue;
    if (rec.confidence !== "official") {
      if (row && storedTier === "official") continue;
      if (saveEligibilityRecord(db, rec).saved) written += 1;
      continue;
    }
    if (row && storedTier === "official") {
      let stored: EligibilityLimits = {};
      try { stored = sanitizeLimits(JSON.parse(str(row.limits_json) || "{}")); } catch { stored = {}; }
      if (citedHosts(stored) !== citedHosts(rec.limits)) continue;
    }
    writeOfficialRecord(db, key, rec);
    written += 1;
  }
  return written;
}

/** The stored records for one state (both kinds), the shipped rows filling any key the store lacks
 *  (a boot whose seed failed still screens). A failed read is the shipped rows alone. Tiers AS STORED:
 *  screens read eligibilityOfficial.eligibilityRecordsOnFile, which re-checks an official record. */
export function eligibilityRecordsForState(db: AppDb | null, state: string): AuthorityEligibilityRecord[] {
  const code = usStateCode(state);
  if (!code) return [];
  const byKey = new Map<string, AuthorityEligibilityRecord>();
  for (const r of shippedEligibilityRecords()) if (r.state === code) byKey.set(eligibilityKey(r.authorityKind, r.state, r.authority), r);
  if (db) {
    try {
      for (const row of db.query<Row>("SELECT * FROM authority_eligibility_limits WHERE state = ?", [code])) {
        const rec = rowToRecord(row);
        if (rec) byKey.set(eligibilityKey(rec.authorityKind, rec.state, rec.authority), rec);
      }
    } catch { /* table missing on an old DB: the shipped rows still screen */ }
  }
  return [...byKey.values()];
}

// ── Research proposals ───────────────────────────────────────────────────────────────────────
/** The source's words carry this value ("25 kilowatts", "two (2) strings", "production meter"). */
function quoteCarries(limit: keyof EligibilityLimits, value: unknown, quote: string): boolean {
  const q = str(quote).toLowerCase();
  if (!q) return false;
  if (typeof value === "number") return new RegExp(`(^|[^0-9.])${String(value).replace(".", "\\.")}(?![0-9])`).test(q);
  if (limit === "productionMeterRequired") return /\b(?:production|generation|pv|solar|revenue[- ]grade)\s+(?:kwh\s+)?meter/.test(q);
  if (limit === "installerCertification") {
    const words = str((value as { name?: string })?.name).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    return words.length > 0 && words.every((w) => q.includes(w));
  }
  return false;
}

/**
 * A lookup's proposed limits, kept only under the cited discipline every lookup uses: the source
 * URL is a page the search returned or a page it opened, and the quoted words carry the value.
 * Nothing from model memory survives — a limit with no such page and words is dropped.
 */
export function acceptProposedLimits(raw: unknown, seenUrls: string[], fetchedAt = new Date().toISOString()): { limits: EligibilityLimits; dropped: string[] } {
  const host = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
  const seen = new Set(seenUrls.map(host).filter(Boolean));
  const candidate = sanitizeLimits(raw);
  const limits: EligibilityLimits = {};
  const dropped: string[] = [];
  for (const key of Object.keys(candidate) as Array<keyof EligibilityLimits>) {
    const limit = candidate[key] as EligibilityLimit<unknown>;
    // A lookup never sets display overrides — those belong to rows that replaced a coded screen.
    const clean: EligibilityLimit<unknown> = {
      value: limit.value,
      citation: { ...limit.citation, fetchedAt: limit.citation.fetchedAt || fetchedAt },
      ...(limit.appliesOnlyTo ? { appliesOnlyTo: limit.appliesOnlyTo } : {}),
    };
    if (!limit.citation.sourceUrl || !seen.has(host(limit.citation.sourceUrl))) { dropped.push(`${key}: source is not a page the search returned`); continue; }
    if (!quoteCarries(key, limit.value, limit.citation.quote)) { dropped.push(`${key}: the quoted words do not state the limit`); continue; }
    (limits as Record<string, unknown>)[key] = clean;
  }
  return { limits, dropped };
}

// ── Screens ──────────────────────────────────────────────────────────────────────────────────
/** HELM'S #637 BAR: a limit blocks only when its source is named, linked and quoted verbatim with
 *  the limit's own value in the words — and it binds every job (no unconfirmable condition). */
export function limitMayBlock(key: keyof EligibilityLimits, limit: EligibilityLimit<unknown>): boolean {
  if (limit.appliesOnlyTo) return false;
  const c = limit.citation;
  return Boolean(c.sourceName && /^https?:\/\//i.test(c.sourceUrl) && quoteCarries(key, limit.value, c.quote));
}

export interface EligibilityJob {
  state: string;
  utility: string;
  ahj: string;
  /** The size a PROGRAM cap screens: combined new + existing where the job is an addition. */
  programDcKw: number | null;
  programAcKw: number | null;
  combinedNote: string;
  /** The size a PERMIT PATH screens: the system being permitted. */
  dcKw: number | null;
  acKw: number | null;
  /** Strings on the busiest inverter: stated, or a lower bound from the module count. */
  stringsPerInverter: { value: number; estimated: boolean } | null;
  /** True for microinverter systems, where "strings per inverter" does not apply. */
  micro: boolean;
  productionMeterShown: boolean;
  /** The client's certifications; null when there is no client record to read. */
  clientCertifications: string[] | null;
  /** YYYY-MM-DD the job is screened on (an installer certification "from a date"). */
  today: string;
}

function matches(rec: AuthorityEligibilityRecord, job: EligibilityJob): boolean {
  if (rec.state !== usStateCode(job.state)) return false;
  if (!rec.authority) return true;
  const name = rec.authorityKind === "utility_program" ? job.utility : job.ahj;
  return Boolean(normalizeAuthorityName(name)) && normalizeAuthorityName(name) === normalizeAuthorityName(rec.authority);
}

const kindSlug = (k: Kind) => (k === "utility_program" ? "utility-program" : "permit-path");
const recordLabel = (rec: AuthorityEligibilityRecord) => rec.programName || (rec.authorityKind === "utility_program" ? "the utility's program" : "the simplified permit path");
const citeText = (c: EligibilityCitation, conf: AuthorityEligibilityRecord["confidence"]) =>
  `${c.sourceName || c.sourceUrl}${c.quote ? `: "${c.quote}"` : ""}${c.sourceUrl && c.sourceName ? ` (${c.sourceUrl})` : ""}${conf === "seeded" ? " — seeded, verify" : conf === "official" ? ` — ${officialSourceWords(sourceHostOf(c.sourceUrl), c.fetchedAt)}` : ""}`;
const fill = (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));

interface Screen { finding: EligibilityFinding; excludes: boolean }

/** One record's findings for this job. `excludes` marks a limit the job is over (the path is not offered). */
function screenRecord(rec: AuthorityEligibilityRecord, job: EligibilityJob): Screen[] {
  const out: Screen[] = [];
  const program = recordLabel(rec);
  const isPath = rec.authorityKind === "permit_path";
  const base = `eligibility.${kindSlug(rec.authorityKind)}`;
  const over = (key: keyof EligibilityLimits, limit: EligibilityLimit<number>, value: number, unit: string, field: string, what: string, note = "") => {
    const blocks = limitMayBlock(key, limit);
    const amount = `${what ? `${what} ` : ""}${value} ${unit}`;
    const defaultMsg = isPath
      ? `${program} is not offered for this job: ${amount}${note} is over its ${limit.value} ${unit} limit. File the standard path. Source: ${citeText(limit.citation, rec.confidence)}.`
      : `${amount}${note} is over the ${program} limit of ${limit.value} ${unit}${limit.appliesOnlyTo ? ` for ${limit.appliesOnlyTo} — confirm whether it applies` : ""}. Source: ${citeText(limit.citation, rec.confidence)}.`;
    out.push({
      excludes: true,
      finding: {
        ruleId: limit.ruleId || `${base}.${key}`,
        ruleName: limit.ruleName || (isPath ? `Not eligible: ${program}` : `${program} limit`),
        qcStatus: blocks ? "fail" : "warning",
        severity: blocks ? "blocker" : "warning",
        message: limit.message ? fill(limit.message, { value: String(value), limit: String(limit.value), combinedNote: note, program }) : defaultMsg,
        fieldName: field,
      },
    });
  };
  const unknown = (key: keyof EligibilityLimits, limit: EligibilityLimit<unknown>, why: string, field?: string) => {
    out.push({
      excludes: false,
      finding: {
        ruleId: `${base}.${key}.unconfirmed`,
        ruleName: `${program}: not confirmed`,
        qcStatus: "warning", severity: "warning",
        message: `${why} Source: ${citeText(limit.citation, rec.confidence)}.`,
        ...(field ? { fieldName: field } : {}),
      },
    });
  };
  const L = rec.limits;
  // An unread DC / AC size is already the QC blocker critical.dc_kw / critical.ac_kw — not repeated here.
  const dc = isPath ? job.dcKw : job.programDcKw;
  const ac = isPath ? job.acKw : job.programAcKw;
  const note = isPath ? "" : job.combinedNote;
  if (L.maxDcKw && dc != null && dc > L.maxDcKw.value) over("maxDcKw", L.maxDcKw, dc, "kW", "dcKw", "DC size", note);
  if (L.maxAcKw && ac != null && ac > L.maxAcKw.value) over("maxAcKw", L.maxAcKw, ac, "kW", "acKw", "AC size", isPath ? "" : job.combinedNote);
  if (L.maxStringsPerInverter && !job.micro) {
    const s = job.stringsPerInverter;
    if (s && s.value > L.maxStringsPerInverter.value) {
      over("maxStringsPerInverter", L.maxStringsPerInverter, s.value, "strings per inverter", "modulesPerString", s.estimated ? "at least" : "");
    } else if (!s || s.estimated) {
      unknown("maxStringsPerInverter", L.maxStringsPerInverter,
        `${program} allows at most ${L.maxStringsPerInverter.value} strings per inverter, and the plans do not state the string count${s ? ` (the module count gives at least ${s.value})` : ""} — confirm on the single-line diagram.`,
        "modulesPerString");
    }
  }
  if (L.productionMeterRequired && !job.productionMeterShown) {
    unknown("productionMeterRequired", L.productionMeterRequired, `${program} requires a production meter, and the plans do not show one — add it to the single-line diagram and site plan, or confirm it is there.`);
  }
  const cert = L.installerCertification;
  if (cert && (!cert.value.effectiveFrom || cert.value.effectiveFrom <= job.today)) {
    const want = normalizeAuthorityName(cert.value.name);
    const held = (job.clientCertifications ?? []).some((c) => normalizeAuthorityName(c).includes(want));
    if (!held) {
      unknown("installerCertification", cert,
        job.clientCertifications == null
          ? `${program} requires the installer to hold ${cert.value.name}${cert.value.effectiveFrom ? ` (from ${cert.value.effectiveFrom})` : ""}, and there is no client record to check it against.`
          : `${program} requires the installer to hold ${cert.value.name}${cert.value.effectiveFrom ? ` (from ${cert.value.effectiveFrom})` : ""}, and the client record does not list it — add it under the client's certifications once confirmed.`);
    }
  }
  return out;
}

export interface PermitPathOffer {
  programName: string;
  authority: string;
  offered: boolean;
  /** Why not, one line per limit the job is over. */
  reasons: string[];
}

/** THE SIMPLIFIED PERMIT PATHS on file for the job's AHJ, and whether each is offered for this job.
 *  A path whose limit the job exceeds is not offered; an unconfirmed limit leaves it offered with
 *  its warning (the unknown is reported, never silently passed). */
export function permitPathOffers(records: AuthorityEligibilityRecord[], job: EligibilityJob): PermitPathOffer[] {
  return records.filter((r) => r.authorityKind === "permit_path" && matches(r, job)).map((r) => {
    const excluded = screenRecord(r, job).filter((s) => s.excludes);
    return { programName: recordLabel(r), authority: r.authority, offered: excluded.length === 0, reasons: excluded.map((s) => s.finding.message) };
  });
}

/**
 * Every eligibility finding for this job. `reportUnknownProgram`: when no utility-program record
 * matches the job's utility, say so (a warning) — QC passes it; the pure legacy callers do not.
 */
export function evaluateEligibility(records: AuthorityEligibilityRecord[], job: EligibilityJob, opts: { reportUnknownProgram?: boolean } = {}): EligibilityFinding[] {
  const matched = records.filter((r) => matches(r, job));
  const out = matched.flatMap((r) => screenRecord(r, job).map((s) => s.finding));
  if (opts.reportUnknownProgram && str(job.utility) && usStateCode(job.state) && !matched.some((r) => r.authorityKind === "utility_program")) {
    out.push({
      ruleId: "eligibility.utility-program.not-on-file",
      ruleName: "Utility program limits not on file",
      qcStatus: "warning",
      severity: "warning",
      message: `No program limits are on file for ${job.utility} (${usStateCode(job.state)}): its size cap, production-meter and installer-certification requirements are unchecked. Confirm them on the utility's program page before filing.`,
      fieldName: "utility",
    });
  }
  return out;
}

// ── Reading the job ──────────────────────────────────────────────────────────────────────────
const PRODUCTION_METER = /\b(?:production|generation|pv|solar|revenue[- ]grade)\s+(?:kwh\s+)?meter\b/i;
const PRODUCTION_METER_DENIED = /\b(?:no|without|not\s+required)\s+(?:a\s+)?(?:production|generation|pv|solar|revenue[- ]grade)\s+(?:kwh\s+)?meter\b/i;

/** Does any plan text show a production meter (and not deny one)? */
export function productionMeterShown(texts: string[]): boolean {
  return texts.some((t) => PRODUCTION_METER.test(t) && !PRODUCTION_METER_DENIED.test(t));
}

/** Strings on the busiest inverter: the parser's stated value, else a LOWER BOUND from the module
 *  count (modules ÷ the longest string ÷ inverters, rounded up) — marked estimated. */
export function stringsPerInverterOf(read: (k: string) => number | null): { value: number; estimated: boolean } | null {
  const stated = read("stringsPerInverter");
  if (stated != null && stated > 0) return { value: Math.round(stated), estimated: false };
  const modules = read("moduleQty") ?? read("moduleQuantity");
  const perString = read("modulesPerString");
  const inverters = read("invQty") ?? 1;
  if (modules == null || perString == null || modules <= 0 || perString <= 0 || inverters <= 0) return null;
  return { value: Math.ceil(Math.ceil(modules / perString) / inverters), estimated: true };
}

/** The client's certifications as stored: one per line or comma / semicolon separated. */
export function certificationList(raw: unknown): string[] {
  return str(raw).split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
}
