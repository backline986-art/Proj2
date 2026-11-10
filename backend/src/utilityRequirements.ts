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
//     and the utility's names as data), or a lookup's proposal. A shipped item that claims "official"
//     is honoured at load only through shippedRowTier (official host, a quote naming the item,
//     fetched-at); short of that it is seeded;
//   - OFFICIAL (#683): read from the utility's own official page, the quote found in the bytes read —
//     honoured only when the row still passes the shared predicate (isOfficialSourceHost + fetchedAt +
//     a quote); otherwise read as seeded;
//   - VERIFIED: a NAMED PERSON recorded it (PUT /api/projects/:id/utility-filing/application-requirements).
// The non-seeded items live on the utility's filing row (utility_filing_lookups.application_requirements_
// json, migration v72): its own column, so a lookup's payload write never touches it (rule 3), and
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
import type { UtilityApplicationRequirement, UtilityRequirementGate, UtilityRequirementKey, UtilityRequirementList, UtilityRequirementQc, UtilityRequirementTier } from "../../shared/src/types";
import { UTILITY_REQUIREMENT_KEYS } from "../../shared/src/types";
import { isOfficialSourceHost, shippedRowTier, sourceHostOf } from "../../shared/src/officialSource";
import type { AppDb } from "./db";
import { usStateCode } from "./permitPath";
import { getUtilityFilingLookup, normalizeUtilityName, utilityFilingKey } from "./utilityFilingLookup";
import { isUtilityPlatformUrl } from "./portalChannel";
import { importSeededUtilityKnowledge, knowledgeProfileKey } from "./knowledgeBase";

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
  module_spec: (q) => /\bmodules?\b|\bpanels?\b/i.test(q) && /\bspec|\bdata\s*sheet|\bcut\s*sheet/i.test(q),
  inverter_spec: (q) => /\binverters?\b/i.test(q) && /\bspec|\bdata\s*sheet|\bcut\s*sheet/i.test(q),
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
    ...sanitizeGates(o.gates),
    ...sanitizeQc(o.qc),
    ...(str(o.verifiedBy) ? { verifiedBy: str(o.verifiedBy).slice(0, 120) } : {}),
    ...(str(o.verifiedAt) ? { verifiedAt: str(o.verifiedAt).slice(0, 40) } : {}),
  };
}

function sanitizeGates(raw: unknown): { gates?: UtilityRequirementGate[] } {
  if (!Array.isArray(raw)) return {};
  const gates = [...new Set(raw.map(str).filter((g): g is UtilityRequirementGate => g === "reviewer" || g === "qc"))];
  return gates.length ? { gates } : {};
}

/** A QC presentation, cleaned. A data row can name only a QC rule id of its own shape, never the
 *  reviewer's or another subsystem's namespace. */
function sanitizeQc(raw: unknown): { qc?: UtilityRequirementQc } {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const ruleId = str(o.ruleId);
  const ruleName = str(o.ruleName).slice(0, 160);
  const message = str(o.message).slice(0, 400);
  const fieldName = str(o.fieldName);
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(ruleId) || !ruleName || !message || !/^[A-Za-z][A-Za-z0-9]{0,60}$/.test(fieldName)) return {};
  const order = Number(o.order);
  return {
    qc: {
      ruleId, ruleName, message, fieldName,
      ...(str(o.label) ? { label: str(o.label).slice(0, 80) } : {}),
      ...(str(o.severity) === "blocker" ? { severity: "blocker" as const } : {}),
      ...(Number.isFinite(order) ? { order } : {}),
    },
  };
}

/** Does this gate read the item? An item with no gates listed is read by both. */
export function requirementForGate(item: Pick<UtilityApplicationRequirement, "gates">, gate: UtilityRequirementGate): boolean {
  return !item.gates?.length || item.gates.includes(gate);
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
      // A higher tier takes the item; the QC wording it replaces stays with it (same rule id and words in
      // the QC baseline) unless the new item brings its own.
      if (!held || TIER_RANK[item.tier] >= TIER_RANK[held.tier]) byKey.set(item.key, !item.qc && held?.qc ? { ...item, qc: held.qc } : item);
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
  /** WHERE the utility takes its application, as the utility's own page links it (cited, SEEDED). */
  filingDoor?: ShippedUtilityFilingDoor;
}

/** A utility's filing door as cited data: the link and the page that names it. It lands only as a
 *  SEEDED utility KB row (seedShippedUtilityFilingDoors), never official and never over a row a person
 *  verified: where a filing goes stays a person's word (rule 3). */
export interface ShippedUtilityFilingDoor {
  name: string;
  url: string;
  sourceName: string;
  sourceUrl: string;
  quote: string;
  fetchedAt: string;
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

/** A QC rule's catalogue entry (the `rules` table, db.ts seedBaselineRuleRows), as data. */
export interface ShippedQcRuleDefinition {
  id: string;
  name: string;
  jurisdictionScope: string;
  utilityScope: string;
  source: string;
  trigger: string;
  action: string;
}
interface ShippedFile {
  records: ShippedUtilityRequirementRecord[];
  /** THE STRICT DEFAULT (owner, 2026-11-09): what the QC baseline checks for a utility with no list on
   *  file — the strictest common set the researched utilities ask for, uncited, so it only warns and says
   *  the utility is not researched. Empty = none. */
  strictDefault: UtilityApplicationRequirement[];
  qcRuleDefinitions: ShippedQcRuleDefinition[];
}

let shippedCache: { file: string; data: ShippedFile } | null = null;
function shippedFile(filePath = referencePath()): ShippedFile {
  if (shippedCache?.file === filePath) return shippedCache.data;
  const data: ShippedFile = { records: [], strictDefault: [], qcRuleDefinitions: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { records?: unknown[]; strictDefault?: unknown; qcRuleDefinitions?: unknown };
    data.records = parseRecords(raw);
    const sd = (raw.strictDefault && typeof raw.strictDefault === "object" ? raw.strictDefault : {}) as Record<string, unknown>;
    data.strictDefault = (Array.isArray(sd.requirements) ? sd.requirements : []).map((r) => sanitizeRequirement(r, "seeded")).filter((r): r is UtilityApplicationRequirement => r != null)
      // The default is never a person's or an official word, and never blocks.
      .map((r) => ({ ...r, quote: "", whenMissing: "warning" as const, qc: r.qc ? { ...r.qc, severity: undefined } : r.qc }));
    for (const d of Array.isArray(raw.qcRuleDefinitions) ? raw.qcRuleDefinitions : []) {
      const o = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
      const def: ShippedQcRuleDefinition = { id: str(o.id), name: str(o.name), jurisdictionScope: str(o.jurisdictionScope), utilityScope: str(o.utilityScope), source: str(o.source), trigger: str(o.trigger), action: str(o.action) };
      if (/^[a-z0-9][a-z0-9-]{2,60}$/.test(def.id) && def.name) data.qcRuleDefinitions.push(def);
    }
  } catch { /* a missing or broken file is no data */ }
  shippedCache = { file: filePath, data };
  return data;
}

/** The strict default list for a utility with no list on file (see ShippedFile.strictDefault). */
export function strictDefaultRequirements(filePath = referencePath()): UtilityApplicationRequirement[] {
  return shippedFile(filePath).strictDefault;
}
/** The QC rule catalogue entries the shipped data defines (baselineRuleDefinitions appends them). */
export function shippedQcRuleDefinitions(filePath = referencePath()): ShippedQcRuleDefinition[] {
  return shippedFile(filePath).qcRuleDefinitions;
}

/** The shipped reference records. Read once per file; a missing or broken file is no records. */
export function shippedUtilityRequirementRecords(filePath = referencePath()): ShippedUtilityRequirementRecord[] {
  return shippedFile(filePath).records;
}

/** One shipped item: seeded, unless it claims "official" and passes the shared bar (shippedRowTier:
 *  an official host, a quote that names the item, fetched-at). Short of that it lands seeded and never
 *  throws; a shipped item never claims "verified" (only a person writes that). An application item is
 *  what the utility asks for, never where the filing goes. */
function shippedRequirement(raw: unknown): UtilityApplicationRequirement | null {
  const item = sanitizeRequirement(raw, "seeded");
  if (!item) return null;
  const claimed = (raw && typeof raw === "object" ? (raw as Record<string, unknown>).tier : undefined);
  const { tier } = shippedRowTier(claimed, { sourceUrl: item.sourceUrl, quote: item.quote, fetchedAt: item.fetchedAt, quoteStatesValue: QUOTE_NAMES_REQUIREMENT[item.key] });
  return tier === "official" ? { ...item, tier } : item;
}

function parseRecords(data: { records?: unknown[] }): ShippedUtilityRequirementRecord[] {
  const records: ShippedUtilityRequirementRecord[] = [];
  {
    for (const raw of data.records ?? []) {
      const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const states = (Array.isArray(o.states) ? o.states : []).map((s) => usStateCode(s)).filter(Boolean);
      const matchNames = (Array.isArray(o.matchNames) ? o.matchNames : []).map((n) => utilityMatchText(str(n))).filter(Boolean);
      const requirements = (Array.isArray(o.requirements) ? o.requirements : []).map(shippedRequirement).filter((r): r is UtilityApplicationRequirement => r != null);
      if (!states.length || !matchNames.length || !requirements.length) continue;
      const filingDoor = sanitizeFilingDoor(o.filingDoor);
      records.push({ states, utility: str(o.utility), displayName: str(o.displayName) || str(o.utility), matchNames, requirements, ...(filingDoor ? { filingDoor } : {}) });
    }
  }
  return records;
}

/** A door is kept only whole: an https link, the page that names it, that page's own words and when they
 *  were read. Anything less is no door (the track keeps asking). */
function sanitizeFilingDoor(raw: unknown): ShippedUtilityFilingDoor | null {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const door: ShippedUtilityFilingDoor = {
    name: str(o.name).slice(0, 200), url: str(o.url).slice(0, 500), sourceName: str(o.sourceName).slice(0, 200),
    sourceUrl: str(o.sourceUrl).slice(0, 500), quote: str(o.quote).slice(0, 600), fetchedAt: str(o.fetchedAt).slice(0, 40),
  };
  if (!/^https:\/\/\S+$/i.test(door.url) || !/^https?:\/\//i.test(door.sourceUrl) || door.quote.length < 8 || !/^\d{4}-\d{2}-\d{2}/.test(door.fetchedAt)) return null;
  return door;
}

/**
 * THE SHIPPED FILING DOORS, SEEDED INTO THE UTILITY'S KB ROW (state, "", utility) through the existing
 * reference writer (importSeededUtilityKnowledge: confidence "seeded", skips a row a person verified).
 * Nothing here is official or verified, and nothing here sends or clicks: the door is read where every
 * utility door is read (utilityFilingLookup's KB channel and the stage's utility read), each through
 * portalChannel.hostFitsTrackAndEntity (rule 5). Idempotent, and a no-op for a row that already carries the same door; returns the number of rows written.
 */
export function seedShippedUtilityFilingDoors(db: AppDb, records = shippedUtilityRequirementRecords()): number {
  let written = 0;
  for (const rec of records) {
    const door = rec.filingDoor;
    if (!door || !rec.utility) continue;
    const notes = `Filing door seeded from ${door.sourceName || door.sourceUrl} (${door.sourceUrl}), read ${door.fetchedAt.slice(0, 10)}: "${door.quote}" links ${door.url}. Seeded, not verified: a person verifies where the application goes.`;
    for (const state of rec.states) {
      // UNCHANGED → NO WRITE (Helm nit): the row already carries this door, its name and its note, so a
      // boot re-seed would only bump updated_at and log a knowledge event every start.
      try {
        const cur = db.get<{ portal_url?: string; portal_name?: string; notes?: string }>(
          "SELECT portal_url, portal_name, notes FROM permit_utility_knowledge WHERE profile_key = ?",
          [knowledgeProfileKey({ state, ahj: "", utility: rec.utility })]);
        if (cur && str(cur.portal_url) === door.url && str(cur.portal_name) === door.name && str(cur.notes).includes(notes)) continue;
      } catch { /* no table yet: write */ }
      const outcome = importSeededUtilityKnowledge(db, {
        state,
        utility: rec.utility,
        portalName: door.name,
        portalUrl: door.url,
        notes,
        sourceLabel: `${door.sourceName || "Utility page"} (${door.sourceUrl})`,
      });
      if (outcome === "imported") written += 1;
    }
  }
  return written;
}

/** The shipped record for this job's state and utility name, or null. An unknown state matches nothing. */
export function shippedRecordFor(state: string, utility: string, records = shippedUtilityRequirementRecords()): ShippedUtilityRequirementRecord | null {
  const st = usStateCode(state);
  const name = ` ${utilityMatchText(utility)} `;
  if (!st || !name.trim()) return null;
  return records.find((r) => r.states.includes(st) && r.matchNames.some((m) => name.includes(` ${m} `))) ?? null;
}

// ── The utility's filing row (utility_filing_lookups.application_requirements_json, v72) ─────────
interface StoredRequirements {
  requirements: unknown[];
}

/** An item stored as official still has to pass the shared predicate when read (a government host, or a
 *  domain a person verified as the utility's own: `hosts`); one that does not is seeded, and warns (it
 *  was never confirmed, so it never stands in for a cited seed). */
function honouredTier(item: UtilityApplicationRequirement, hosts: readonly string[]): UtilityApplicationRequirement {
  if (item.tier === "verified") return str(item.verifiedBy) && str(item.verifiedAt) ? item : { ...item, tier: "seeded" };
  if (item.tier === "official") {
    const ok = isOfficialSourceHost(item.sourceUrl, hosts) && str(item.quote).length >= 8 && Boolean(item.fetchedAt);
    return ok ? item : { ...item, tier: "seeded", whenMissing: "warning" };
  }
  return item;
}

/** Hosts a PERSON verified as this utility's own: the pages its person-verified filing row and its
 *  person-recorded requirement items cite (`rowItems`: the row's items as stored, when the caller has
 *  them). An interconnection platform's host (a vendor) never counts. A read. */
export function utilityPersonVerifiedHosts(db: AppDb, state: string, utility: string, rowItems?: UtilityApplicationRequirement[]): string[] {
  const urls: string[] = [];
  const lookup = getUtilityFilingLookup(db, state, utility);
  if (lookup && lookup.confidence === "verified" && str(lookup.verifiedBy)) urls.push(str(lookup.filing?.sourceUrl), str(lookup.program?.sourceUrl));
  for (const item of rowItems ?? filingRowRequirements(db, state, utility, { honour: false }).requirements) {
    if (item.tier === "verified" && str(item.verifiedBy) && str(item.verifiedAt)) urls.push(item.sourceUrl);
  }
  const hosts = new Set<string>();
  for (const u of urls) {
    const host = sourceHostOf(u);
    if (host && !isUtilityPlatformUrl(u)) hosts.add(host);
  }
  return [...hosts];
}

/** The items on the utility's filing row (seeded proposals, official reads, a person's), and whether the
 *  row exists. A read. `honour: false` = the tiers as stored (for writers, so a re-check never writes a
 *  downgrade back); by default each official item is re-checked against the shared predicate. */
export function filingRowRequirements(db: AppDb | null, state: string, utility: string, opts: { honour?: boolean } = {}): { rowExists: boolean; requirements: UtilityApplicationRequirement[] } {
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
      .filter((r): r is UtilityApplicationRequirement => r != null);
    if (opts.honour === false) return { rowExists: true, requirements };
    const hosts = utilityPersonVerifiedHosts(db, state, utility, requirements);
    return { rowExists: true, requirements: requirements.map((r) => honouredTier(r, hosts)) };
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
  input: {
    requirements: Array<{ key: UtilityRequirementKey; whenMissing: "blocker" | "warning"; sourceName?: string; sourceUrl: string; quote: string }>;
    verifiedBy: string;
    /** "replace" (the default): the stated items become the person-recorded list. "merge": the stated
     *  items are added or replace that key's item; other people's items for other keys stay as recorded
     *  (the dashboard panel adds, edits or verifies one item at a time). */
    mode?: "replace" | "merge";
  },
): { saved: boolean; reason: string; requirements: UtilityApplicationRequirement[] } {
  const who = str(input.verifiedBy).slice(0, 120);
  if (!who) return { saved: false, reason: "A utility's application requirements are recorded by a named person.", requirements: [] };
  const { rowExists, requirements: onRow } = filingRowRequirements(db, where.state, where.utility, { honour: false });
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
  const kept = onRow.filter((r) => (input.mode === "merge" || r.tier !== "verified") && !statedKeys.has(r.key));
  const all = [...kept, ...stated];
  db.run("UPDATE utility_filing_lookups SET application_requirements_json = ? WHERE profile_key = ?", [JSON.stringify({ requirements: all }), utilityFilingKey(where.state, where.utility)]);
  return { saved: true, reason: "recorded", requirements: all };
}

/** A named person withdraws the person-recorded items (the shipped seed and any official reads stand). */
export function clearUtilityApplicationRequirements(db: AppDb, where: { state: string; utility: string }): void {
  const { rowExists, requirements } = filingRowRequirements(db, where.state, where.utility, { honour: false });
  if (!rowExists) return;
  const kept = requirements.filter((r) => r.tier !== "verified");
  db.run("UPDATE utility_filing_lookups SET application_requirements_json = ? WHERE profile_key = ?", [kept.length ? JSON.stringify({ requirements: kept }) : "", utilityFilingKey(where.state, where.utility)]);
}

// ── What the dashboard panel shows (a read) ───────────────────────────────────────────────────
/** One item as the panel lists it: where it comes from (the shipped seed or the utility's filing row),
 *  and whether it is the one the gates read for its kind. */
export interface UtilityRequirementView extends UtilityApplicationRequirement {
  origin: "shipped" | "row";
  /** The item the gates read for this kind (the higher tier; the row at the same tier). */
  inEffect: boolean;
}

/** The panel's view of one utility's requirement list: every item the shipped seed and the filing row
 *  carry, each marked with where it comes from and whether it is in effect. A read: writes nothing. */
export function utilityRequirementsView(db: AppDb | null, state: string, utility: string): {
  displayName: string; rowExists: boolean; items: UtilityRequirementView[];
} {
  const shipped = str(utility) ? shippedRecordFor(state, utility) : null;
  const row = filingRowRequirements(db, state, utility);
  const effective = mergeRequirements(shipped?.requirements ?? [], row.requirements);
  const items: UtilityRequirementView[] = [
    ...(shipped?.requirements ?? []).map((r) => ({ ...r, origin: "shipped" as const, inEffect: effective.includes(r) })),
    ...row.requirements.map((r) => ({ ...r, origin: "row" as const, inEffect: effective.some((e) => e.key === r.key && e.tier === r.tier && e.sourceUrl === r.sourceUrl && e.quote === r.quote) })),
  ];
  return { displayName: shipped?.displayName || str(utility), rowExists: row.rowExists, items };
}
