// THE ONE READ OF A STATE'S ELIGIBILITY RECORDS FOR SCREENING (official-source slice 4; CLAUDE.md rule 3).
//
// An "official" record (read on the authority's own official source: a shipped row honoured at load, or
// a utility lookup's limits whose quotes Keelix found in the bytes it read — landLookupEligibilityRecord)
// stays official at read time only while every limit's citation still passes the shared bar against the
// authority's own hosts AS THEY STAND NOW. A government page that stops vouching for a site demotes what
// was read there to seeded. A person's record and a seeded one are returned as they are.
//
// Kept apart from eligibilityLimits.ts so that module never loads utilityRequirements.ts (which loads
// utilityFilingLookup.ts, which loads eligibilityLimits.ts) at start-up. Reads only.
import type { AuthorityEligibilityRecord } from "../../shared/src/types";
import type { AppDb } from "./db";
import { eligibilityRecordsForState, shippedRecordTier } from "./eligibilityLimits";
import { utilityOfficialHosts } from "./utilityRequirements";

/** One record's honoured tier. A program's hosts are the utility's (utilityOfficialHosts: person-verified
 *  and government-vouched); a permit path's official rows come only from shipped government-host rows,
 *  so no extra host is accepted for them. Never throws. */
export function honourOfficialRecord(db: AppDb | null, rec: AuthorityEligibilityRecord): AuthorityEligibilityRecord {
  if (rec.confidence !== "official") return rec;
  let hosts: string[] = [];
  if (db && rec.authorityKind === "utility_program") {
    try { hosts = utilityOfficialHosts(db, rec.state, rec.authority); } catch { hosts = []; }
  }
  return shippedRecordTier("official", rec, hosts) === "official" ? rec : { ...rec, confidence: "seeded" };
}

/** The records a screen reads for a job's state, each official one re-checked. */
export function eligibilityRecordsOnFile(db: AppDb | null, state: string): AuthorityEligibilityRecord[] {
  return eligibilityRecordsForState(db, state).map((r) => honourOfficialRecord(db, r));
}
