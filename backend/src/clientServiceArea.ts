// ---------------------------------------------------------------------------
// A CLIENT'S SERVICE AREA (owner's delegation, 2026-11-10; brief client-service-area.md).
//
// Since the door gate, every authority needs one named person's Confirm or Verify before automation
// may file there. "Destinations to confirm" listed only the authorities of OPEN JOBS, so a new client's
// doors could not be confirmed before its first job. This is where the client works: the states, the
// cities or counties and the utilities it files with, recorded by staff on the client screen or by the
// onboarding script. The queue and the coverage report then list every authority in the area that no
// open job names yet, marked "service area".
//
// WHAT THE AREA IS, AND IS NOT:
//   · CLIENT DATA. It lives on the client's own row (clients.service_area_json, v80), so it is org-scoped
//     exactly like the row (rule 6). It never goes into a shared knowledge table (nothing here writes
//     one) and never into a prompt (no model door imports this module; clientServiceArea.test pins it).
//   · A LIST OF NAMES, nothing more. It decides nothing about any job, any channel or any filing. An
//     authority it names is resolved on READ, through the existing name matching
//     (knowledgeBase.knowledgeNameMatchScore, utilityIdentity for utilities) against the names already
//     on file IN THAT STATE ONLY: a state mismatch always loses, and a row with no state is not a match.
//     A county entry only ever names a county, a city entry never a county (processProfiles'
//     jurisdictionKind). With nothing on file, the typed name stands, and it is shown as typed.
//   · A whole-state entry names no authority by itself: it says the company works there. A state-issued
//     permit reaches the list through a city entry, the way it reaches a job (permitProcess.projectForTrack).
//
// Universal: kinds and states are data; no state, city, utility or portal is named here.
// ---------------------------------------------------------------------------
import type { ClientServiceAreaEntry } from "../../shared/src/types";
import type { AppDb } from "./db";
import { knowledgeNameMatchScore } from "./knowledgeBase";
import { allAhjProcessProfiles, jurisdictionCore, jurisdictionKind } from "./processProfiles";
import { provablyDifferentUtility, sameUtilityEntity } from "./utilityIdentity";
import { shippedUtilityRequirementRecords } from "./utilityRequirements";
import { parseServiceArea, serviceAreaEntryKey } from "./serviceAreaEntries";

export { mergeServiceArea, parseServiceArea, serviceAreaEntryKey, serviceAreaProblems, SERVICE_AREA_KINDS, SERVICE_AREA_MAX_ENTRIES } from "./serviceAreaEntries";
export type { ClientServiceAreaEntry, ServiceAreaKind } from "./serviceAreaEntries";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** "Example County" for a county entry typed without the word; a city entry as typed. */
function queryName(e: ClientServiceAreaEntry): string {
  if (e.kind !== "county") return e.name;
  return jurisdictionKind(e.name) === "county" ? e.name : `${e.name} County`;
}

export interface ServiceAreaAuthority {
  /** The entry as stored, and its key (what a confirm from the area names). */
  entry: ClientServiceAreaEntry;
  entryKey: string;
  kind: "ahj" | "utility";
  state: string;
  /** The authority's name as it is on file (or as typed, when nothing on file matches). */
  name: string;
  /** Where the name came from: a name already on file, or the entry as typed. */
  matchedFrom: "job" | "reference" | "knowledge" | "lookup" | "typed";
}

type Candidate = { name: string; from: ServiceAreaAuthority["matchedFrom"] };
const FROM_RANK: Record<ServiceAreaAuthority["matchedFrom"], number> = { job: 4, reference: 3, knowledge: 2, lookup: 1, typed: 0 };

function sameState(a: unknown, b: string): boolean {
  return str(a).toUpperCase() === b;
}

/** Names on file for AHJs in one state: the shipped reference profiles, the shared knowledge rows and
 *  the per-AHJ lookups. Reads only. */
function ahjNamesOnFile(db: AppDb, state: string): Candidate[] {
  const out: Candidate[] = [];
  try { for (const p of allAhjProcessProfiles()) if (sameState(p.state, state) && str(p.ahj)) out.push({ name: str(p.ahj), from: "reference" }); } catch { /* no reference file */ }
  try { for (const r of db.query<{ ahj: string }>("SELECT DISTINCT ahj FROM permit_utility_knowledge WHERE upper(state) = ? AND ahj != ''", [state])) out.push({ name: str(r.ahj), from: "knowledge" }); } catch { /* table absent */ }
  try { for (const r of db.query<{ ahj: string }>("SELECT DISTINCT ahj FROM permit_process_lookups WHERE upper(state) = ? AND ahj != ''", [state])) out.push({ name: str(r.ahj), from: "lookup" }); } catch { /* table absent */ }
  return out;
}

function utilityNamesOnFile(db: AppDb, state: string): Candidate[] {
  const out: Candidate[] = [];
  try {
    for (const r of shippedUtilityRequirementRecords()) {
      if (!(r.states ?? []).some((st) => sameState(st, state))) continue;
      for (const n of [r.utility, r.displayName]) if (str(n)) out.push({ name: str(n), from: "reference" });
    }
  } catch { /* no reference file */ }
  try { for (const r of db.query<{ utility: string }>("SELECT DISTINCT utility FROM permit_utility_knowledge WHERE upper(state) = ? AND utility != ''", [state])) out.push({ name: str(r.utility), from: "knowledge" }); } catch { /* table absent */ }
  try { for (const r of db.query<{ utility: string }>("SELECT DISTINCT utility FROM utility_filing_lookups WHERE upper(state) = ? AND utility != ''", [state])) out.push({ name: str(r.utility), from: "lookup" }); } catch { /* table absent */ }
  return out;
}

/**
 * THE AUTHORITY AN ENTRY NAMES, resolved through the existing name matching inside the entry's state.
 * `jobNames` are the names THIS client's own open jobs use in that state (so an entry and a job that
 * name the same city resolve to the same authority). Null for a whole-state entry. Reads only.
 */
export function resolveServiceAreaEntry(
  db: AppDb,
  entry: ClientServiceAreaEntry,
  jobNames: { ahj: Array<{ state: string; name: string }>; utility: Array<{ state: string; name: string }> } = { ahj: [], utility: [] },
): ServiceAreaAuthority | null {
  if (entry.kind === "state") return null;
  const state = entry.state;
  const entryKey = serviceAreaEntryKey(entry);
  const pick = (candidates: Candidate[], score: (name: string) => number, fallback: string): Pick<ServiceAreaAuthority, "name" | "matchedFrom"> => {
    let best: { c: Candidate; score: number } | null = null;
    for (const c of candidates) {
      const sc = score(c.name);
      if (sc < 60) continue;
      if (!best || sc > best.score || (sc === best.score && FROM_RANK[c.from] > FROM_RANK[best.c.from])) best = { c, score: sc };
    }
    return best ? { name: best.c.name, matchedFrom: best.c.from } : { name: fallback, matchedFrom: "typed" };
  };
  if (entry.kind === "utility") {
    const candidates: Candidate[] = [
      ...jobNames.utility.filter((j) => sameState(j.state, state)).map((j) => ({ name: j.name, from: "job" as const })),
      ...utilityNamesOnFile(db, state),
    ];
    const r = pick(candidates, (name) => {
      if (sameUtilityEntity(state, entry.name, name)) return 100;
      if (provablyDifferentUtility(state, entry.name, name)) return 0;
      return knowledgeNameMatchScore(entry.name, name);
    }, entry.name);
    return { entry, entryKey, kind: "utility", state, ...r };
  }
  // A city or county: the same KIND of government (a county entry names a county; a city entry never
  // does) with the same place-name core, scored by the knowledge base's own name matcher.
  const wanted = queryName(entry);
  const core = jurisdictionCore(wanted);
  const kindFits = (name: string): boolean => (entry.kind === "county" ? jurisdictionKind(name) === "county" : jurisdictionKind(name) !== "county");
  const candidates: Candidate[] = [
    ...jobNames.ahj.filter((j) => sameState(j.state, state)).map((j) => ({ name: j.name, from: "job" as const })),
    ...ahjNamesOnFile(db, state),
  ];
  const r = pick(candidates, (name) => (kindFits(name) && core && jurisdictionCore(name) === core ? Math.max(knowledgeNameMatchScore(wanted, name), 60) : 0), wanted);
  return { entry, entryKey, kind: "ahj", state, ...r };
}

/** The client's stored area, read from its own row. Reads only. */
export function clientServiceArea(db: AppDb, clientId: string): ClientServiceAreaEntry[] {
  const row = db.get<{ service_area_json?: string }>("SELECT service_area_json FROM clients WHERE id = ?", [clientId]);
  return parseServiceArea(row?.service_area_json ?? "[]");
}

/** The AHJ and utility names this client's own open jobs use (state + name), for resolution. */
export function clientJobNames(db: AppDb, clientId: string): { ahj: Array<{ state: string; name: string }>; utility: Array<{ state: string; name: string }> } {
  const rows = db.query<{ state: string; ahj: string; utility: string }>(
    "SELECT DISTINCT state, ahj, utility FROM projects WHERE client_id = ? AND COALESCE(archived_at, '') = ''",
    [clientId],
  );
  return {
    ahj: rows.filter((r) => str(r.ahj)).map((r) => ({ state: str(r.state).toUpperCase(), name: str(r.ahj) })),
    utility: rows.filter((r) => str(r.utility)).map((r) => ({ state: str(r.state).toUpperCase(), name: str(r.utility) })),
  };
}

/** Every authority a client's area names, resolved. Reads only. */
export function serviceAreaAuthorities(db: AppDb, clientId: string): ServiceAreaAuthority[] {
  const area = clientServiceArea(db, clientId);
  if (!area.length) return [];
  const jobs = clientJobNames(db, clientId);
  return area.map((e) => resolveServiceAreaEntry(db, e, jobs)).filter((a): a is ServiceAreaAuthority => !!a);
}
