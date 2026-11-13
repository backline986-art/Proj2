// OFFICIAL-SOURCE FEES (owner, 2026-11-11: "If its from an official source we can use it to come into
// us as verified already"; rule 3's official tier, #683, applied to the fee schedule).
//
// The grade is DERIVED each time a fee is read, never stored: a line is official only while its
// stored evidence (the printed row Keelix itself retrieved, its document and its read time) still
// passes the one shared predicate, with the authority's person-verified hosts as they stand today
// (feeSchedules.officialFeeLineSource). So nothing here writes, a person's later un-verify of a
// domain takes the grade away, and code still never writes 'verified' on a fee row.
//
// This module is the half that needs the database: whose hosts a person verified. Permit lines ask
// the permit-process lookup (officialAuthorityHosts); utility lines ask the utility's filing row
// (utilityRequirements.utilityPersonVerifiedHosts). A government host needs neither.
//
// WHAT OFFICIAL NEVER DOES: it never replaces a person's verified amount, never decides where a
// filing goes or whether one is sent, and never pays (rules 1, 3, 5). It is shown as "Verified from
// <host>, <date>" (owner, 2026-11-13; officialSourceWords), never under a person's name.

import { officialSourceWords } from "../../shared/src/officialSource";
import type { AppDb } from "./db";
import {
  officialFeeLineSource, officialFeeResolutionSource,
  type FeeScheduleLine, type FeeTrack, type OfficialFeeSource, type ProjectFeeResolution,
} from "./feeSchedules";
import { personVerifiedAuthorityHosts } from "./officialAuthorityHosts";
import { utilityPersonVerifiedHosts } from "./utilityRequirements";

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();

/** The hosts a person verified as this line's authority's own. Reads only; a broken row reads as none. */
export function verifiedHostsForFeeLine(db: AppDb, state: string, track: FeeTrack, line: Pick<FeeScheduleLine, "authority">): string[] {
  const authority = str(line.authority);
  if (!authority || !str(state)) return [];
  try {
    return track === "nem" ? utilityPersonVerifiedHosts(db, state, authority) : personVerifiedAuthorityHosts(db, state, authority);
  } catch { return []; }
}

/** One line's official source, with its authority's person-verified hosts looked up. */
export function officialSourceOfFeeLine(db: AppDb, state: string, track: FeeTrack, line: FeeScheduleLine): OfficialFeeSource | null {
  return officialFeeLineSource(line, track, verifiedHostsForFeeLine(db, state, track, line));
}

/** The total's official source (the weakest link: null while any line is seeded). */
export function officialSourceOfFeeResolution(db: AppDb, state: string, track: FeeTrack, resolution: ProjectFeeResolution): OfficialFeeSource | null {
  const cache = new Map<string, string[]>();
  return officialFeeResolutionSource(resolution, track, (line) => {
    const key = str(line.authority).toLowerCase();
    if (!cache.has(key)) cache.set(key, verifiedHostsForFeeLine(db, state, track, line));
    return cache.get(key) as string[];
  });
}

/** "Verified from <host>, <date>": the words every screen prints for an official fee. */
export function officialFeeWords(o: OfficialFeeSource): string {
  return officialSourceWords(o.host, o.fetchedAt);
}
