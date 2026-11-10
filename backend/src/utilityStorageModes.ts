// ---------------------------------------------------------------------------
// WHICH STORAGE MODES A UTILITY TAKES AN APPLICATION FOR (#673 item 3).
//
// The NEM / interconnection track stays ON for every battery job by default (the strict default:
// most utilities want an application for any storage that can parallel the grid). Some utilities
// say on their own pages that a given mode needs none — typically a backup-only system that never
// operates in parallel. That is DATA per utility, never code per utility: one record on the
// utility's filing row (utility_filing_lookups.storage_modes_json, migration v68), with
//   - the modes that need NO application, in this product's vocabulary (export / non-export /
//     backup-only),
//   - the page it was read on and the page's own words, which must name storage AND each mode,
//   - the NAMED PERSON who recorded it, and when.
//
// RULE 3, STRICTER THAN THE OFFICIAL TIER: the one writer today is a person (PUT
// /api/projects/:id/utility-filing/storage-modes, tier "person"). A lookup never writes the column (its
// own column, so a lookup's payload write never touches it) and a model never does. A future import or
// official-source read must stamp its own tier ("seeded" / "official"): such a record is SHOWN, never
// acted on (coordinator note on #673 and draft 10: a storage exemption drops a track only when a
// person verified it).
//
// nemStorageExemption() is the ONE answer to "does this job's battery need no utility application?".
// QC (nemTrackDrop.ts) acts on it ONLY when the record is a person's (tier "person", a named verifier
// and a date): it stamps the drop on the job (projects.nem_track_exemption_json, v72) and
// requiredTracks() reads the stamp through nemTrackDropFor() below, so done-ness, nextStep, Stage,
// autopilot and the tracks screen all lose the track together, with the reason. A record on any
// other tier (a seeded import, an official-source read: draft 10, rule 3 — the official tier never
// decides WHETHER a filing is sent) is shown on the job as information for a person to verify, and
// the track stays. A named person can put the track back on one job (keptBy), and withdrawing the
// record brings it back on every job at its next QC run.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { NemTrackDrop, ParserPayload, ProjectRecord, StorageOperatingMode } from "../../shared/src/types";
import { STORAGE_OPERATING_MODES } from "../../shared/src/types";
import { normalizeUtilityName, utilityFilingKey } from "./utilityFilingLookup";
import { newModuleEvidence, resolveJobScope, scopeHasNewPv, storageOperatingMode } from "./jobScope";

/** Who stands behind a record. Only "person" ever drops a track; a record with no tier is treated as
 *  NOT a person's (fail closed: a writer that forgets the tier never drops anything). */
export type StorageModeTier = "person" | "official" | "seeded";

export interface UtilityStorageModeRecord {
  /** The modes this utility takes NO application for, as its page says. */
  modesWithoutApplication: StorageOperatingMode[];
  tier?: StorageModeTier;
  sourceUrl: string;
  quote: string;
  verifiedBy: string;
  verifiedAt: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

const NAMES_STORAGE = /\bbatter(?:y|ies)\b|\b(?:energy\s+)?storage\b|\bESS\b/i;
/** Every phrase in which "export" is negated or limited away: none of them names the export mode. */
const NEGATED_EXPORT = /\b(?:non|no|zero|not|never|without)[-\s]?(?:to\s+)?export(?:s|ed|ing)?\b|\b(?:does|do|will|shall|may|can|cannot|must)\s+not\s+export(?:s|ed|ing)?\b|\bexport[-\s]?(?:limit(?:s|ed|ing)?|control(?:s|led)?)\b|\bnon[-\s]?exporting\b/gi;
/** Do the page's words name this mode? */
export const quoteNamesStorageMode: Record<StorageOperatingMode, (quote: string) => boolean> = {
  "backup-only": (q) => /\bback[-\s]?up\b|\bstand[-\s]?by\b|\boff[-\s]?grid\b|\bnot? (?:operate|connected) in parallel\b/i.test(q),
  "non-export": (q) => /\bnon[-\s]?export|\bno[-\s]export|\bzero[-\s]export|\bnot export|\bdoes not export|\bexport[-\s]?limit/i.test(q),
  // A NON-NEGATED "export": the negated phrases are struck first, so a page about non-export,
  // zero-export or export-limited batteries never names the export mode (Helm review of #673).
  export: (q) => /\bexport/i.test(q.replace(NEGATED_EXPORT, " ")),
};

/** The record cites a page whose words name storage and every mode it lists (any tier). */
export function storageModeRecordCited(r: UtilityStorageModeRecord | null | undefined): r is UtilityStorageModeRecord {
  if (!r || !/^https?:\/\//i.test(str(r.sourceUrl))) return false;
  const quote = str(r.quote);
  if (quote.length < 8 || !NAMES_STORAGE.test(quote)) return false;
  const modes = Array.isArray(r.modesWithoutApplication) ? r.modesWithoutApplication : [];
  return modes.length > 0 && modes.every((m) => (STORAGE_OPERATING_MODES as readonly string[]).includes(m) && quoteNamesStorageMode[m](quote));
}

/** The record is a PERSON's: cited, tier "person", a named verifier and a date. The only kind that drops a track. */
export function storageModeRecordUsable(r: UtilityStorageModeRecord | null | undefined): r is UtilityStorageModeRecord {
  return storageModeRecordCited(r) && r.tier === "person" && Boolean(str(r.verifiedBy)) && Boolean(str(r.verifiedAt));
}

function parseRecord(raw: unknown): UtilityStorageModeRecord | null {
  const text = str(raw);
  if (!text) return null;
  try {
    const r = JSON.parse(text) as UtilityStorageModeRecord;
    return r && typeof r === "object" ? r : null;
  } catch {
    return null;
  }
}

/** The record on the utility's filing row (null when none), and whether the row exists. A read. */
export function utilityStorageModes(db: AppDb, state: string, utility: string): { rowExists: boolean; record: UtilityStorageModeRecord | null } {
  if (!normalizeUtilityName(utility)) return { rowExists: false, record: null };
  try {
    const row = db.get<{ storage_modes_json?: string }>("SELECT storage_modes_json FROM utility_filing_lookups WHERE profile_key = ?", [utilityFilingKey(state, utility)]);
    return { rowExists: Boolean(row), record: row ? parseRecord(row.storage_modes_json) : null };
  } catch {
    return { rowExists: false, record: null };
  }
}

/** A NAMED PERSON records which storage modes need no application. Refused unless usable, and when the
 *  utility has no filing row yet (its lookup runs first; this never invents one). */
export function recordUtilityStorageModes(
  db: AppDb,
  where: { state: string; utility: string },
  input: { modesWithoutApplication: StorageOperatingMode[]; sourceUrl: string; quote: string; verifiedBy: string },
): { saved: boolean; reason: string; record: UtilityStorageModeRecord | null } {
  const { rowExists } = utilityStorageModes(db, where.state, where.utility);
  if (!rowExists) return { saved: false, reason: "No filing record is on file for this utility yet; its filing lookup runs first.", record: null };
  const record: UtilityStorageModeRecord = {
    modesWithoutApplication: [...new Set(input.modesWithoutApplication)],
    tier: "person",
    sourceUrl: str(input.sourceUrl),
    quote: str(input.quote).slice(0, 300),
    verifiedBy: str(input.verifiedBy).slice(0, 120),
    verifiedAt: new Date().toISOString(),
  };
  if (!storageModeRecordUsable(record)) {
    return { saved: false, reason: "The page's words must name storage and each mode recorded (backup, non-export…), with the http(s) page they were read on and a named person.", record: null };
  }
  db.run("UPDATE utility_filing_lookups SET storage_modes_json = ? WHERE profile_key = ?", [JSON.stringify(record), utilityFilingKey(where.state, where.utility)]);
  return { saved: true, reason: "recorded", record };
}

/** A named person withdraws the record: every storage mode needs an application again. */
export function clearUtilityStorageModes(db: AppDb, where: { state: string; utility: string }): void {
  if (!normalizeUtilityName(where.utility)) return;
  db.run("UPDATE utility_filing_lookups SET storage_modes_json = '' WHERE profile_key = ?", [utilityFilingKey(where.state, where.utility)]);
}

export interface NemStorageExemption {
  utility: string;
  mode: StorageOperatingMode;
  record: UtilityStorageModeRecord;
  /** A person's record (storageModeRecordUsable): the only kind that may drop the track. Otherwise the
   *  exemption is information for a person to verify. */
  personVerified: boolean;
}

/**
 * THE ONE ANSWER: does this job's battery need no utility application? Only when ALL hold:
 *   - the job adds no new PV (a storage scope from jobScope.ts — new PV always files);
 *   - its operating mode is classified (an unstated mode files);
 *   - the utility's cited storage record lists that mode.
 * Anything else is null. `personVerified` says whether the record may act (a person's) or is only
 * information (seeded / official / no tier). A read.
 */
export function nemStorageExemption(
  db: AppDb | null,
  project: Pick<ProjectRecord, "id" | "state" | "utility"> & { parserSnapshot: ParserPayload | null | undefined },
): NemStorageExemption | null {
  if (!db || !normalizeUtilityName(project.utility ?? "")) return null;
  const scope = resolveJobScope(db, project.id, project.parserSnapshot);
  if (scopeHasNewPv(scope.scope)) return null;
  const mode = storageOperatingMode(project.parserSnapshot);
  if (!mode) return null;
  const { record } = utilityStorageModes(db, project.state ?? "", project.utility ?? "");
  if (!storageModeRecordCited(record) || !record.modesWithoutApplication.includes(mode)) return null;
  return { utility: project.utility, mode, record, personVerified: storageModeRecordUsable(record) };
}

/**
 * THE ONE PREDICATE EVERY DOOR ASKS (through requiredTracks): has this job's utility track been dropped?
 * The QC-written stamp, re-checked against the record in hand so a stale stamp never drops a track:
 * no person kept the track, the stamp names this job's utility, a named verifier, a cited page, the
 * job shows no new modules and its battery mode is still the one the record covers. No db: a read
 * of the ProjectRecord (mapProject maps the column).
 */
export function nemTrackDropFor(project: Pick<ProjectRecord, "utility" | "parserSnapshot" | "nemTrackExemption">): NemTrackDrop | null {
  const state = project.nemTrackExemption;
  const drop = state?.drop;
  if (!drop || str(state?.keptBy)) return null;
  if (!normalizeUtilityName(project.utility ?? "") || normalizeUtilityName(drop.utility) !== normalizeUtilityName(project.utility ?? "")) return null;
  if (!str(drop.verifiedBy) || !str(drop.verifiedAt) || !/^https?:\/\//i.test(str(drop.sourceUrl)) || !str(drop.quote)) return null;
  if (newModuleEvidence(project.parserSnapshot).length > 0) return null;
  if (storageOperatingMode(project.parserSnapshot) !== drop.mode) return null;
  return drop;
}
