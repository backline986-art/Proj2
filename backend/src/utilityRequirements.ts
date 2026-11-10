// ---------------------------------------------------------------------------
// WHAT EACH UTILITY'S OWN APPLICATION ASKS FOR, AS CITED DATA (review-audit draft 03).
//
// The reviewer gate used to check the utility side of a job for two utilities, by name: Portland
// General (account verification) and PacifiCorp (meter photo, inverter settings). Every other utility
// (Idaho Power, a city-owned utility) got nothing beyond the generic account / meter-missing blockers,
// and the gate was silent about it. The owner's rule (2026-11-09): a generic mechanism plus data per
// utility, never logic keyed to one utility.
//
// One list of typed items per utility (UtilityRequirementKey: meter_photo, one_line, …), each carrying
// its source by name, URL and the page's own words, at a tier:
//   - SEEDED: backend/data/reference-utility-application-requirements.json (shipped; matched by state
//     and the utility's names as data), or a lookup's proposal;
//   - OFFICIAL (#683): read from the utility's own official page, the quote found in the bytes read —
//     honoured only when the row still passes the shared predicate (isOfficialSourceHost + fetchedAt +
//     a quote); otherwise read as seeded;
//   - VERIFIED: a NAMED PERSON recorded it (PUT /api/projects/:id/utility-filing/application-requirements).
// The non-seeded items live on the utility's filing row (utility_filing_lookups.application_requirements_
// json, migration v70): its own column, so a lookup's payload write never touches it (rule 3), and
// beside #673's storage_modes_json, which it never reads or writes. Per key, the higher tier wins; a
// verified item is never replaced by anything less.
//
// What the gate does with an item (strictest baseline, Helm's #637 bar), in reviewerEngine:
//   - the item's evidence is read with the existing evidenceForTopic readers; high confidence = met;
//   - shown but not proven = a WARNING;
//   - missing = a WARNING, or a BLOCKER only when the item says whenMissing "blocker" AND it may block:
//     a person verified it, it is official, or its row quotes a named http(s) source verbatim and the
//     quote names the item (a quote about meters never backs a one-line blocker);
//   - no list on file for the job's utility = one callout saying the utility side was not reviewed.
// Nothing here names a utility, a state or a portal. Reads write nothing.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UtilityApplicationRequirement, UtilityRequirementKey, UtilityRequirementList, UtilityRequirementTier } from "../../shared/src/types";
import { UTILITY_REQUIREMENT_KEYS } from "../../shared/src/types";
import { isOfficialSourceHost } from "../../shared/src/officialSource";
import type { AppDb } from "./db";
import { usStateCode } from "./permitPath";
import { normalizeUtilityName, utilityFilingKey } from "./utilityFilingLookup";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** Does the page's quote name this item? A quote that backs a blocker must be about the thing it blocks on. */
export const QUOTE_NAMES_REQUIREMENT: Record<UtilityRequirementKey, (quote: string) => boolean> = {
  account_verification: (q) => /\baccount\b|\bbill\b/i.test(q),
  meter_photo: (q) => /\bmeter\b/i.test(q) && /\bphoto|\bpicture|\bimage/i.test(q),
  inverter_settings: (q) => /\bsettings?\b/i.test(q),
  inverter_listing_ul1741sb: (q) => /\b1741\b/i.test(q),
  one_line: (q) => /\bone[-\s]?line\b|\bsingle[-\s]?line\b|\bthree[-\s]?line\b|\bSLD\b/i.test(q),
  site_plan: (q) => /\bsite\s+(?:plan|map|drawing)|\bplot\s+plan/i.test(q),
  ac_disconnect: (q) => /\bdisconnect/i.test(q),
  storage_mode_declaration: (q) => /\bbatter(?:y|ies)\b|\bstorage\b|\bESS\b/i.test(q),
  owner_signature: (q) => /\bsign(?:ed|ature|s)?\b/i.test(q),
};

const TIER_RANK: Record<UtilityRequirementTier, number> = { seeded: 0, official: 1, verified: 2 };

function isKey(v: unknown): v is UtilityRequirementKey {
  return (UTILITY_REQUIREMENT_KEYS as readonly string[]).includes(str(v));
}

/** One item, cleaned. Unknown keys and items naming no source at all are dropped (a guess is not a requirement). */
export function sanitizeRequirement(raw: unknown, tier: UtilityRequirementTier): UtilityApplicationRequirement | null {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isKey(o.key)) return null;
  const sourceUrl = /^https?:\/\//i.test(str(o.sourceUrl)) ? str(o.sourceUrl).slice(0, 500) : "";
  const sourceName = str(o.sourceName).slice(0, 200);
  if (!sourceUrl && !sourceName) return null;
  const fetchedAt = str(o.fetchedAt);
  const findingId = str(o.findingId);
  return {
    key: o.key,
    whenMissing: str(o.whenMissing) === "blocker" ? "blocker" : "warning",
    tier,
    sourceName,
    sourceUrl,
    quote: str(o.quote).slice(0, 600),
    ...(/^\d{4}-\d{2}-\d{2}/.test(fetchedAt) ? { fetchedAt: fetchedAt.slice(0, 40) } : {}),
    // Only the reviewer's own namespace: a data row can keep a legacy id, never mint another rule's.
    ...(/^reviewer\.utility\.[a-z0-9-]+$/.test(findingId) ? { findingId } : {}),
    ...(str(o.verifiedBy) ? { verifiedBy: str(o.verifiedBy).slice(0, 120) } : {}),
    ...(str(o.verifiedAt) ? { verifiedAt: str(o.verifiedAt).slice(0, 40) } : {}),
  };
}

/**
 * MAY THIS ITEM BLOCK? (Helm's #637 bar.) A named person's item, or an official one; or a seeded item
 * whose row names its source, gives the http(s) page and quotes it with words that name the item.
 * Anything else warns. whenMissing "warning" never blocks, whatever the tier.
 */
export function requirementMayBlock(item: UtilityApplicationRequirement): boolean {
  if (item.whenMissing !== "blocker") return false;
  if (item.tier === "verified" && str(item.verifiedBy)) return true;
  if (item.tier === "official") return true;
  const quote = str(item.quote);
  return Boolean(str(item.sourceName)) && /^https?:\/\//i.test(item.sourceUrl) && quote.length >= 8 && QUOTE_NAMES_REQUIREMENT[item.key](quote);
}

/** Merge per key: the higher tier wins; at the same tier the later list (the filing row) wins. */
export function mergeRequirements(...lists: UtilityApplicationRequirement[][]): UtilityApplicationRequirement[] {
  const byKey = new Map<UtilityRequirementKey, UtilityApplicationRequirement>();
  for (const list of lists) {
    for (const item of list) {
      const held = byKey.get(item.key);
      if (!held || TIER_RANK[item.tier] >= TIER_RANK[held.tier]) byKey.set(item.key, item);
    }
  }
  return [...byKey.values()];
}

// ── Shipped reference rows (seeded) ──────────────────────────────────────────────────────────
export interface ShippedUtilityRequirementRecord {
  states: string[];
  utility: string;
  displayName: string;
  /** Names this record answers to, as whole words of the job's normalized utility name. Data, not code. */
  matchNames: string[];
  requirements: UtilityApplicationRequirement[];
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
function referencePath(): string {
  const explicit = str(process.env.UTILITY_REQUIREMENTS_REFERENCE_PATH);
  if (explicit) return path.resolve(explicit);
  return path.resolve(moduleDir, "..", "data", "reference-utility-application-requirements.json");
}

/** Lower-case words; "&" is "and", so "PG&E" never reads as "PGE". */
export function utilityMatchText(name: string): string {
  return str(name).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

let shippedCache: { file: string; records: ShippedUtilityRequirementRecord[] } | null = null;
/** The shipped reference records. Read once per file; a missing or broken file is no records. */
export function shippedUtilityRequirementRecords(filePath = referencePath()): ShippedUtilityRequirementRecord[] {
  if (shippedCache?.file === filePath) return shippedCache.records;
  let records: ShippedUtilityRequirementRecord[] = [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as { records?: unknown[] };
    for (const raw of data.records ?? []) {
      const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const states = (Array.isArray(o.states) ? o.states : []).map((s) => usStateCode(s)).filter(Boolean);
      const matchNames = (Array.isArray(o.matchNames) ? o.matchNames : []).map((n) => utilityMatchText(str(n))).filter(Boolean);
      const requirements = (Array.isArray(o.requirements) ? o.requirements : []).map((r) => sanitizeRequirement(r, "seeded")).filter((r): r is UtilityApplicationRequirement => r != null);
      if (!states.length || !matchNames.length || !requirements.length) continue;
      records.push({ states, utility: str(o.utility), displayName: str(o.displayName) || str(o.utility), matchNames, requirements });
    }
  } catch { records = []; }
  shippedCache = { file: filePath, records };
  return records;
}

/** The shipped record for this job's state and utility name, or null. An unknown state matches nothing. */
export function shippedRecordFor(state: string, utility: string, records = shippedUtilityRequirementRecords()): ShippedUtilityRequirementRecord | null {
  const st = usStateCode(state);
  const name = ` ${utilityMatchText(utility)} `;
  if (!st || !name.trim()) return null;
  return records.find((r) => r.states.includes(st) && r.matchNames.some((m) => name.includes(` ${m} `))) ?? null;
}

// ── The utility's filing row (utility_filing_lookups.application_requirements_json, v70) ─────────
interface StoredRequirements {
  requirements: unknown[];
}

/** An item stored as official still has to pass the shared predicate when read; one that does not is seeded. */
function honouredTier(item: UtilityApplicationRequirement): UtilityApplicationRequirement {
  if (item.tier === "verified") return str(item.verifiedBy) && str(item.verifiedAt) ? item : { ...item, tier: "seeded" };
  if (item.tier === "official") {
    const ok = isOfficialSourceHost(item.sourceUrl) && str(item.quote).length >= 8 && Boolean(item.fetchedAt);
    return ok ? item : { ...item, tier: "seeded" };
  }
  return item;
}

/** The items on the utility's filing row (seeded proposals, official reads, a person's), and whether the row exists. A read. */
export function filingRowRequirements(db: AppDb | null, state: string, utility: string): { rowExists: boolean; requirements: UtilityApplicationRequirement[] } {
  if (!db || !normalizeUtilityName(utility)) return { rowExists: false, requirements: [] };
  try {
    const row = db.get<{ application_requirements_json?: string }>("SELECT application_requirements_json FROM utility_filing_lookups WHERE profile_key = ?", [utilityFilingKey(state, utility)]);
    if (!row) return { rowExists: false, requirements: [] };
    let stored: StoredRequirements = { requirements: [] };
    try { stored = JSON.parse(str(row.application_requirements_json) || "{}") as StoredRequirements; } catch { stored = { requirements: [] }; }
    const requirements = (Array.isArray(stored.requirements) ? stored.requirements : [])
      .map((r) => {
        const tier = str((r as Record<string, unknown>)?.tier);
        return sanitizeRequirement(r, tier === "verified" || tier === "official" ? tier : "seeded");
      })
      .filter((r): r is UtilityApplicationRequirement => r != null)
      .map(honouredTier);
    return { rowExists: true, requirements };
  } catch {
    return { rowExists: false, requirements: [] };
  }
}

/**
 * THE ONE ANSWER: the requirement list the gate reads for this job's utility — the shipped seed for its
 * state and name, overlaid per key by the utility's filing row. null when neither has anything (the gate
 * then says the utility's requirements are not on file). `db` null = the shipped seed alone. A read.
 */
export function resolveUtilityRequirements(db: AppDb | null, state: string, utility: string): UtilityRequirementList | null {
  if (!str(utility)) return null;
  const shipped = shippedRecordFor(state, utility);
  const row = filingRowRequirements(db, state, utility);
  const requirements = mergeRequirements(shipped?.requirements ?? [], row.requirements);
  if (!requirements.length) return null;
  return { displayName: shipped?.displayName || str(utility), requirements };
}

/**
 * A NAMED PERSON records what the utility's application asks for, each item with the page and its words
 * (rule 3: lands 'verified', and nothing less replaces it). Refused when the utility has no filing row
 * yet (its lookup runs first; this never invents one) or an item is uncited. Replaces the person-recorded
 * items wholesale; official and seeded items on the row for other keys stay.
 */
export function recordUtilityApplicationRequirements(
  db: AppDb,
  where: { state: string; utility: string },
  input: { requirements: Array<{ key: UtilityRequirementKey; whenMissing: "blocker" | "warning"; sourceName?: string; sourceUrl: string; quote: string }>; verifiedBy: string },
): { saved: boolean; reason: string; requirements: UtilityApplicationRequirement[] } {
  const who = str(input.verifiedBy).slice(0, 120);
  if (!who) return { saved: false, reason: "A utility's application requirements are recorded by a named person.", requirements: [] };
  const { rowExists, requirements: onRow } = filingRowRequirements(db, where.state, where.utility);
  if (!rowExists) return { saved: false, reason: "No filing record is on file for this utility yet; its filing lookup runs first.", requirements: [] };
  const now = new Date().toISOString();
  const stated: UtilityApplicationRequirement[] = [];
  for (const r of input.requirements) {
    const item = sanitizeRequirement({ ...r, sourceName: str(r.sourceName) || "Recorded by a person", fetchedAt: now, verifiedBy: who, verifiedAt: now }, "verified");
    if (!item || !/^https?:\/\//i.test(item.sourceUrl) || item.quote.length < 8 || !QUOTE_NAMES_REQUIREMENT[item.key](item.quote)) {
      return { saved: false, reason: `Each item carries the http(s) page it was read on and that page's words, which must name it (${str(r.key) || "unknown item"}).`, requirements: [] };
    }
    stated.push(item);
  }
  const statedKeys = new Set(stated.map((s) => s.key));
  const kept = onRow.filter((r) => r.tier !== "verified" && !statedKeys.has(r.key));
  const all = [...kept, ...stated];
  db.run("UPDATE utility_filing_lookups SET application_requirements_json = ? WHERE profile_key = ?", [JSON.stringify({ requirements: all }), utilityFilingKey(where.state, where.utility)]);
  return { saved: true, reason: "recorded", requirements: all };
}

/** A named person withdraws the person-recorded items (the shipped seed and any official reads stand). */
export function clearUtilityApplicationRequirements(db: AppDb, where: { state: string; utility: string }): void {
  const { rowExists, requirements } = filingRowRequirements(db, where.state, where.utility);
  if (!rowExists) return;
  const kept = requirements.filter((r) => r.tier !== "verified");
  db.run("UPDATE utility_filing_lookups SET application_requirements_json = ? WHERE profile_key = ?", [kept.length ? JSON.stringify({ requirements: kept }) : "", utilityFilingKey(where.state, where.utility)]);
}
