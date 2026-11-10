// ---------------------------------------------------------------------------
// DROPPING A STORAGE JOB'S UTILITY TRACK — ONLY ON A PERSON'S RECORD (draft 10, stacked on #673).
//
// The strict default stands: every job with a utility files an interconnection application. A track
// comes off ONE job only when ALL of these hold, decided here at each QC run and stamped on the job
// (projects.nem_track_exemption_json, v73) so requiredTracks() — the one predicate every door asks,
// through utilityStorageModes.nemTrackDropFor — reads it without a db:
//   - the job adds no new PV and its battery mode is classified (nemStorageExemption);
//   - the utility's storage record that lists that mode is a PERSON's: tier "person", a named
//     verifier, a date, the page and its own words (storageModeRecordUsable). A seeded import or an
//     OFFICIAL-tier read never drops it (rule 3 / rule 1: the official tier never decides WHETHER a
//     filing is sent): it is shown on the job as information for a person to verify;
//   - no person put the track back on this job (keptBy);
//   - nothing is under way on the track already (a staged or sent filing, a portal run, a status
//     check): work in flight is never hidden.
// Anything else clears the stamp, so withdrawing the record, a new module on the plan set, a changed
// mode or a changed utility brings the track back at the next QC run.
// ---------------------------------------------------------------------------

import type { AppDb } from "./db";
import type { NemTrackDrop, NemTrackExemptionState, ParserPayload } from "../../shared/src/types";
import { nemStorageExemption } from "./utilityStorageModes";
import { utilityFilingKey } from "./utilityFilingLookup";
import { nowIso } from "./time";

/** The job's stamp as stored (empty when nothing is dropped or kept). A read. */
export function nemTrackStateOf(db: AppDb, projectId: string): NemTrackExemptionState {
  return readState(db, projectId);
}

function readState(db: AppDb, projectId: string): NemTrackExemptionState {
  try {
    const row = db.get<{ nem_track_exemption_json?: string }>("SELECT nem_track_exemption_json FROM projects WHERE id = ?", [projectId]);
    const raw = String(row?.nem_track_exemption_json ?? "").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as NemTrackExemptionState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(db: AppDb, projectId: string, state: NemTrackExemptionState): void {
  const keep = Boolean(state.keptBy);
  const next = state.drop || keep ? JSON.stringify(keep ? { drop: state.drop ?? null, keptBy: state.keptBy, keptAt: state.keptAt } : { drop: state.drop }) : "";
  db.run("UPDATE projects SET nem_track_exemption_json = ? WHERE id = ? AND nem_track_exemption_json IS NOT ?", [next, projectId, next]);
}

/** Anything already under way on this job's utility track: a submission row of any status, a portal
 *  run, or a status-check target. A drop never hides work in flight. */
export function nemTrackHasWork(db: AppDb, projectId: string): boolean {
  const probes = [
    "SELECT 1 FROM submissions WHERE project_id = ? AND permit_type = 'nem' LIMIT 1",
    "SELECT 1 FROM portal_runs WHERE project_id = ? AND permit_type = 'nem' LIMIT 1",
    "SELECT 1 FROM permit_check_targets WHERE project_id = ? AND target_type = 'nem' LIMIT 1",
  ];
  return probes.some((sql) => {
    try { return Boolean(db.get(sql, [projectId])); } catch { return false; }
  });
}

export interface NemTrackDecision {
  /** dropped: the stamp is on. kept: a person put the track back. in_flight: work already on the track.
   *  unverified: the record is not a person's (seeded / official / no tier). none: nothing to say. */
  outcome: "dropped" | "kept" | "in_flight" | "unverified" | "none";
  /** The sentence QC shows on the job (empty for none). */
  message: string;
  drop: NemTrackDrop | null;
}

/** Decide the job's utility track and write the stamp. Called by QC inside its transaction. */
export function settleNemTrackDrop(
  db: AppDb,
  project: { id: string; state: string; utility: string; parserSnapshot: ParserPayload },
): NemTrackDecision {
  const state = readState(db, project.id);
  const exemption = nemStorageExemption(db, project);
  const decide = (outcome: NemTrackDecision["outcome"], message: string, drop: NemTrackDrop | null): NemTrackDecision => {
    writeState(db, project.id, { ...state, drop });
    return { outcome, message, drop };
  };
  if (!exemption) return decide("none", "", null);
  const { record, mode, utility } = exemption;
  const cited = `${record.sourceUrl}: "${record.quote}"`;
  if (!exemption.personVerified) {
    const tier = record.tier === "official" ? "an official-source read" : record.tier === "seeded" ? "a seeded (unverified) record" : "a record no person verified";
    return decide("unverified",
      `${utility}'s page says a ${mode} battery needs no interconnection application (${tier}, ${cited}). `
      + "The utility track stays on this job: only a person's verified record drops it. Verify the page and record it to take the track off.",
      null);
  }
  if (state.keptBy) {
    return decide("kept",
      `${utility} takes no interconnection application for a ${mode} battery, as recorded by ${record.verifiedBy} from ${cited}. `
      + `${state.keptBy} put the utility track back on this job${state.keptAt ? ` on ${state.keptAt.slice(0, 10)}` : ""}, so it stays.`,
      null);
  }
  if (nemTrackHasWork(db, project.id)) {
    return decide("in_flight",
      `${utility} takes no interconnection application for a ${mode} battery, as recorded by ${record.verifiedBy} from ${cited}. `
      + "This job already has utility filing work on record, so the track stays; close it by hand if the filing is not needed.",
      null);
  }
  const drop: NemTrackDrop = {
    utility,
    mode,
    sourceUrl: record.sourceUrl,
    quote: record.quote,
    verifiedBy: record.verifiedBy,
    verifiedAt: record.verifiedAt,
    decidedAt: nowIso(),
  };
  return decide("dropped",
    `Utility track dropped: ${utility} takes no interconnection application for a ${mode} battery, as ${record.verifiedBy} recorded on ${record.verifiedAt.slice(0, 10)} from ${cited}. `
    + "Put the track back on this job from the submittal tracks if the filing is still wanted.",
    drop);
}

/** A named person puts the utility track back on this job (keep = true) or lets the record drop it
 *  again (keep = false). The caller reruns QC, which writes the stamp. */
export function setNemTrackKept(db: AppDb, projectId: string, keep: boolean, by: string): NemTrackExemptionState {
  const state = readState(db, projectId);
  const next: NemTrackExemptionState = keep
    ? { drop: null, keptBy: by, keptAt: nowIso() }
    : { drop: state.drop ?? null };
  writeState(db, projectId, next);
  return next;
}

/** Every job whose stamp drops a track on this utility's record: withdrawing the record reruns QC on
 *  each, so the track comes back everywhere at once, not only on the job the person was looking at. */
export function projectsDroppedFor(db: AppDb, state: string, utility: string): string[] {
  const key = utilityFilingKey(state, utility);
  try {
    return db.query<{ id: string; state: string; utility: string; nem_track_exemption_json: string }>(
      "SELECT id, state, utility, nem_track_exemption_json FROM projects WHERE nem_track_exemption_json <> ''",
    ).filter((r) => {
      try {
        const st = JSON.parse(String(r.nem_track_exemption_json)) as NemTrackExemptionState;
        return Boolean(st?.drop) && utilityFilingKey(String(r.state ?? ""), String(st.drop?.utility ?? r.utility ?? "")) === key;
      } catch { return false; }
    }).map((r) => String(r.id));
  } catch {
    return [];
  }
}
