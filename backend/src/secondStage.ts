// ---------------------------------------------------------------------------------------------
// TWO-STAGE PERMIT FILINGS, PART 1 (#28): THE SECOND STAGE AS A TRACKED HUMAN STEP.
//
// Some agencies split a permit filing. The application goes into one portal and its fee is paid
// there; only then does the agency send an invite (usually an email) that opens ANOTHER system
// where the plans are uploaded. Until now the run ended at the fee stop, a person pressed Paid, the
// track read "filed" and the second stage was invisible.
//
// What this module does — display and status only, no automation and no new door:
//
//   DESCRIBED  A cited description of the second stage: the per-job lookup's own answer
//              (permits[].secondStage) or the shipped reference row
//              (citations[field=secondStage], value = the system, trigger = what opens it). It is
//              shown on the track card with its page and words. IT CHANGES NOTHING.
//   VERIFIED   A named person's Confirm (permit_second_stages, written only here, by a person —
//              rule 3). Only then does the track ask for the second stage.
//   THE JOB    On a verified agency, a person's record of the FIRST stage (Paid at the fee stop, or
//              "the application is made" for one filed by hand) lands as a submission that is
//              `awaiting_second_stage` — never `submitted`. Every reader of "is it filed" (the
//              card, the client pages, the timeline, the filing notice, the tracker) therefore
//              reads NOT FILED without being taught anything. The track waits for the invite, then
//              for the hand upload; a named person marks the upload done with the confirmation
//              number or a screenshot (audited), and ONLY THEN is the filing recorded
//              (markTrackSubmitted: tracking target, client notice, quote snapshot — the ordinary
//              filing door).
//   THE INVITE The filings inbox's ordinary match (reply threading, record number, address) places
//              an email on the job; the tracker hands it here and, when the track waits on its
//              second stage and the email reads as the invite, it is shown on the track. Its link
//              is shown only when its host passes rule 5's one predicate for a permit track and
//              this agency (portalChannel.hostFitsTrackAndEntity), judged when matched AND again
//              at every read. Nothing opens it, follows it or stores it as a portal.
//
// NEVER HERE (part 2, after a supervised local learn): a recipe, a replay or an upload in the
// second system, or any filing door for it. Automation never pays (rule 1, unchanged).
// No state, city, agency or system is named in this file: all of it is data.
// ---------------------------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppDb } from "./db";
import type { ProjectRecord, SubmittalTrackType } from "../../shared/src/types";
import { HttpError } from "./httpError";
import { nowIso } from "./time";
import { addAuditLog } from "./audit";
import { agencyNameKey } from "./agencyName";
import { wholeCitations, separateCounterFor } from "./ahjRowCitations";
import { findAhjProcessProfile } from "./processProfiles";
import { permitProcessFor, projectForTrack } from "./permitProcess";
import { hostFitsTrackAndEntity, portalHostOf, recipeDisciplineForTrack } from "./portalChannel";
import { portalEntityEvidence } from "./portalRecipes";
import { sniffFileKind } from "./fileTypes";
import { DOCS_DIR } from "./projectDocuments";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v == null ? "" : String(v));
const clean = (v: unknown, max: number): string => s(v).replace(/\s+/g, " ").trim().slice(0, max);

/** The submission status of an application that is made (and paid) but whose plans are not uploaded. */
export const AWAITING_SECOND_STAGE = "awaiting_second_stage" as const;

/** The tracks a second stage can belong to: an agency's permit filing, never the utility's. */
const PERMIT_TRACKS: ReadonlySet<string> = new Set(["building", "electrical", "combo", "permit", "mpu"]);

// ── The description (cited; changes nothing) ─────────────────────────────────────────────────

export interface SecondStageDescription {
  system: string;
  trigger: string;
  sourceUrl: string;
  quote: string;
  fetchedAt?: string;
  /** Where the description is on file: the per-job lookup, or the shipped reference row. */
  from: "lookup" | "reference";
}

const WORDS = (v: string): string[] => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 1);
/** Does the quote NAME the system (every word of its name, in the page's own words)? A description
 *  whose quote never names the system it claims is not a description. */
export function quoteNamesSystem(system: string, quote: string): boolean {
  const need = WORDS(system);
  const have = new Set(WORDS(quote));
  const joined = quote.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return need.length > 0 && need.every((w) => have.has(w) || joined.includes(w));
}

/** The permit disciplines a track's lookup answer is read from. */
function disciplinesOf(track: string): string[] {
  const d = recipeDisciplineForTrack(track);
  return d === "electrical" ? ["electrical", "combo"] : d === "structural" ? ["structural", "combo"] : ["combo", "structural", "electrical"];
}

type TrackProject = Pick<ProjectRecord, "state" | "ahj"> & { city?: string | null; trackView?: unknown };

/** THE CITED DESCRIPTION for the agency that issues this track (the track's own view): the per-job
 *  lookup's answer first, else the shipped row's citation. null when none is on file. A read. */
export function describedSecondStage(trackProject: TrackProject, track: string): SecondStageDescription | null {
  try {
    const lookup = permitProcessFor(trackProject);
    const wanted = disciplinesOf(track);
    for (const p of lookup?.permits ?? []) {
      const f = p.secondStage;
      if (!f?.value || !wanted.includes(p.discipline)) continue;
      const system = clean(f.value.system, 120);
      if (system && /^https?:\/\//i.test(s(f.sourceUrl)) && quoteNamesSystem(system, s(f.quote))) {
        return { system, trigger: clean(f.value.trigger, 200), sourceUrl: s(f.sourceUrl), quote: clean(f.quote, 300), from: "lookup" };
      }
    }
  } catch { /* no lookup on file */ }
  try {
    const row = findAhjProcessProfile(trackProject as never);
    for (const c of wholeCitations(row, "secondStage")) {
      const system = clean(c.value, 120);
      if (!system || !quoteNamesSystem(system, c.quote)) continue;
      return { system, trigger: clean(c.trigger, 200), sourceUrl: c.sourceUrl, quote: clean(c.quote, 300), fetchedAt: c.fetchedAt, from: "reference" };
    }
  } catch { /* no reference row */ }
  return null;
}

// ── A person's Confirm (the only thing that changes what a track asks for) ───────────────────

export interface VerifiedSecondStage {
  id: string;
  state: string;
  agency: string;
  system: string;
  trigger: string;
  sourceUrl: string;
  quote: string;
  verifiedBy: string;
  verifiedAt: string;
}

function authorityOf(trackProject: TrackProject): { state: string; agency: string; key: string } | null {
  const state = s(trackProject.state).trim().toUpperCase();
  const agency = s(trackProject.ahj).trim();
  const key = agencyNameKey(agency);
  return state && key ? { state, agency, key } : null;
}

/** The second stage a named person confirmed for the agency that issues this track, or null. */
export function verifiedSecondStage(db: AppDb, trackProject: TrackProject): VerifiedSecondStage | null {
  const a = authorityOf(trackProject);
  if (!a) return null;
  let row: Row | null | undefined;
  try {
    row = db.get<Row>("SELECT * FROM permit_second_stages WHERE state = ? AND agency_key = ?", [a.state, a.key]);
  } catch { return null; } // an older schema has no such table: no second stage
  if (!row || !s(row.verified_by).trim() || !s(row.verified_at).trim()) return null;
  return {
    id: s(row.id), state: s(row.state), agency: s(row.agency) || a.agency, system: s(row.system_name), trigger: s(row.trigger_text),
    sourceUrl: s(row.source_url), quote: s(row.quote), verifiedBy: s(row.verified_by), verifiedAt: s(row.verified_at),
  };
}

/** The track's own issuer view, or null for a track that has no second stage of its own: the
 *  utility's track, and a permit bought at a separate counter of the same agency (its filing is that
 *  counter's, not the agency's portal flow). */
function stageProject(project: ProjectRecord, track: string): ProjectRecord | null {
  if (!PERMIT_TRACKS.has(track)) return null;
  const view = projectForTrack(project, track);
  if (separateCounterFor(view, track)) return null;
  return view;
}

/** THE ONE QUESTION every door asks: does this track's filing have a person-verified second stage? */
export function trackSecondStage(db: AppDb, project: ProjectRecord, track: string): VerifiedSecondStage | null {
  const view = stageProject(project, track);
  return view ? verifiedSecondStage(db, view) : null;
}

/**
 * A NAMED PERSON CONFIRMS the second stage for the agency that issues this track. The system and
 * trigger are the cited description's unless the person typed their own (their page and words are
 * kept beside it either way). Requires a name; refuses a track that can have none. Audited.
 */
export function confirmSecondStage(
  db: AppDb,
  project: ProjectRecord,
  track: SubmittalTrackType,
  input: { system?: unknown; trigger?: unknown },
  verifiedBy: string,
): VerifiedSecondStage {
  const by = clean(verifiedBy, 120);
  if (!by) throw new HttpError(400, "A second stage is confirmed by a named person: sign in, or give your name.");
  const view = stageProject(project, track);
  const a = view ? authorityOf(view) : null;
  if (!view || !a) throw new HttpError(400, `The ${track} track has no agency filing a second stage could belong to.`);
  const described = describedSecondStage(view, track);
  const system = clean(input.system, 120) || described?.system || "";
  if (!system) throw new HttpError(400, "Name the system the plans are uploaded in (as the agency names it).");
  if (/https?:\/\/|www\.|@/i.test(system)) throw new HttpError(400, "Name the system, not an address: a second stage is a step a person does by hand, never a filing destination.");
  const trigger = clean(input.trigger, 200) || described?.trigger || "";
  const ts = nowIso();
  const existing = db.get<Row>("SELECT id FROM permit_second_stages WHERE state = ? AND agency_key = ?", [a.state, a.key]);
  const rowId = existing ? s(existing.id) : randomUUID();
  if (existing) {
    db.run(
      "UPDATE permit_second_stages SET agency = ?, system_name = ?, trigger_text = ?, source_url = ?, quote = ?, verified_by = ?, verified_at = ? WHERE id = ?",
      [a.agency, system, trigger, described?.sourceUrl ?? "", described?.quote ?? "", by, ts, rowId],
    );
  } else {
    db.run(
      `INSERT INTO permit_second_stages (id, state, agency_key, agency, system_name, trigger_text, source_url, quote, verified_by, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rowId, a.state, a.key, a.agency, system, trigger, described?.sourceUrl ?? "", described?.quote ?? "", by, ts],
    );
  }
  addAuditLog(db, project.id, "human", by, "second_stage.confirmed", {
    track, state: a.state, agency: a.agency, system, trigger, describedFrom: described?.from ?? "", sourceUrl: described?.sourceUrl ?? "",
  });
  return verifiedSecondStage(db, view)!;
}

/** A named person says this agency has NO second stage (any more). Jobs already waiting on theirs
 *  keep their own row and can still be marked; new first stages file as an ordinary filing. Audited. */
export function removeSecondStage(db: AppDb, project: ProjectRecord, track: SubmittalTrackType, removedBy: string): boolean {
  const by = clean(removedBy, 120);
  if (!by) throw new HttpError(400, "A second stage is removed by a named person: sign in, or give your name.");
  const view = stageProject(project, track);
  const a = view ? authorityOf(view) : null;
  if (!a) return false;
  const row = db.get<Row>("SELECT id, system_name FROM permit_second_stages WHERE state = ? AND agency_key = ?", [a.state, a.key]);
  if (!row) return false;
  db.run("DELETE FROM permit_second_stages WHERE id = ?", [s(row.id)]);
  addAuditLog(db, project.id, "human", by, "second_stage.removed", { track, state: a.state, agency: a.agency, system: s(row.system_name) });
  return true;
}

// ── One job's progress ───────────────────────────────────────────────────────────────────────

export interface TrackSecondStageRow {
  id: string;
  track: string;
  submissionId: string;
  system: string;
  firstStageAt: string;
  firstStageNumber: string;
  firstStageBy: string;
  firstStageVia: string;
  inviteSubject: string;
  inviteFrom: string;
  inviteReceivedAt: string;
  inviteLink: string;
  inviteLinkHiddenHost: string;
  inviteLinkHiddenWhy: string;
  uploadedAt: string;
  uploadedBy: string;
  confirmationNumber: string;
  screenshotPath: string;
}

function mapRow(r: Row): TrackSecondStageRow {
  return {
    id: s(r.id), track: s(r.track), submissionId: s(r.submission_id), system: s(r.system_name),
    firstStageAt: s(r.first_stage_at), firstStageNumber: s(r.first_stage_number), firstStageBy: s(r.first_stage_by), firstStageVia: s(r.first_stage_via),
    inviteSubject: s(r.invite_subject), inviteFrom: s(r.invite_from), inviteReceivedAt: s(r.invite_received_at),
    inviteLink: s(r.invite_link), inviteLinkHiddenHost: s(r.invite_link_hidden_host), inviteLinkHiddenWhy: s(r.invite_link_hidden_why),
    uploadedAt: s(r.uploaded_at), uploadedBy: s(r.uploaded_by), confirmationNumber: s(r.confirmation_number), screenshotPath: s(r.screenshot_path),
  };
}

/** This job's second-stage row for the track, or null. A read. */
export function trackSecondStageRow(db: AppDb, projectId: string, track: string): TrackSecondStageRow | null {
  try {
    const r = db.get<Row>("SELECT * FROM track_second_stages WHERE project_id = ? AND track = ?", [projectId, track]);
    return r ? mapRow(r) : null;
  } catch { return null; }
}

/** Is this track's application made while its plans are NOT yet uploaded? The row, or null. */
export function secondStagePending(db: AppDb, projectId: string, track: string): TrackSecondStageRow | null {
  const row = trackSecondStageRow(db, projectId, track);
  return row && !row.uploadedAt ? row : null;
}

/**
 * THE FIRST STAGE IS DONE: a person paid at the fee stop (trackPaid) or made the application by hand.
 * Called only for a track whose agency has a person-verified second stage. The application lands as
 * an `awaiting_second_stage` submission holding the record number — never `submitted`, never a
 * tracking target, never a client "filed" notice: the track is not filed until the upload is marked.
 * The staging run that waited (on the fee, or on the person's submit) is closed, exactly as a manual
 * filing closes it, so nothing can stage or auto-submit that application again.
 */
export function recordFirstStage(
  db: AppDb,
  project: ProjectRecord,
  track: SubmittalTrackType,
  input: { recordNumber: string; by: string; via: "paid" | "by_hand"; note?: string },
  /** The track's permit_type family (submittalTracks.trackPermitTypes), passed in: this module does
   *  not import submittalTracks (which imports it). */
  family: readonly string[],
): TrackSecondStageRow {
  const stage = trackSecondStage(db, project, track);
  if (!stage) throw new HttpError(409, `No person has confirmed a second stage for the ${track} track's agency: record this filing the ordinary way.`);
  const recordNumber = clean(input.recordNumber, 80);
  if (!recordNumber) throw new HttpError(400, "Enter the record or application number the portal shows for this application.");
  const prior = trackSecondStageRow(db, project.id, track);
  if (prior) {
    throw new HttpError(409, prior.uploadedAt
      ? `The ${track} track's second stage is already marked done (${prior.uploadedAt.slice(0, 10)}).`
      : `The ${track} track's application is already on record as ${prior.firstStageNumber}; it waits on the plan upload in ${prior.system}.`);
  }
  if (db.get<Row>(
    `SELECT id FROM submissions WHERE project_id = ? AND permit_type IN (${family.map(() => "?").join(",")}) AND status = 'submitted' LIMIT 1`,
    [project.id, ...family],
  )) {
    throw new HttpError(409, `The ${track} track already has a filing on record. A second stage is tracked from the application, not after the filing.`);
  }
  const ts = nowIso();
  const by = clean(input.by, 120);
  const note = clean(input.note, 300) || `Application made${input.via === "paid" ? " and its fee paid" : ""}; the plans go into ${stage.system} by hand. Not filed until that upload is marked done.`;
  const rowId = randomUUID();
  let submissionId = "";
  db.transaction(() => {
    const awaiting = db.get<Row>(
      `SELECT id FROM submissions WHERE project_id = ? AND permit_type = ? AND status IN ('awaiting_human_submit', 'awaiting_payment')
        ORDER BY created_at DESC LIMIT 1`,
      [project.id, track],
    );
    if (awaiting) {
      submissionId = s(awaiting.id);
      // submitted_at stays as it is (null unless an approved click stamped it): this is not the filing.
      db.run("UPDATE submissions SET status = ?, application_number = ?, submitted_by = ?, notes = ? WHERE id = ?",
        [AWAITING_SECOND_STAGE, recordNumber, by, note, submissionId]);
    } else {
      submissionId = randomUUID();
      db.run(
        `INSERT INTO submissions
          (id, project_id, portal_profile_id, submission_type, permit_type, status, application_number, permit_number,
           confirmation_number, submitted_at, submitted_by, screenshots_path, notes, created_at)
         VALUES (?, ?, NULL, 'permit', ?, ?, ?, '', '', NULL, ?, '', ?, ?)`,
        [submissionId, project.id, track, AWAITING_SECOND_STAGE, recordNumber, by, note, ts],
      );
    }
    // The run that waited is closed: the application IS on the first portal (a filed application is
    // never staged or auto-submitted again).
    db.run(
      `UPDATE portal_runs SET status = 'submitted', finished_at = COALESCE(finished_at, ?)
        WHERE project_id = ? AND permit_type IN (${family.map(() => "?").join(",")}) AND status IN ('awaiting_payment', 'awaiting_human_submit')`,
      [ts, project.id, ...family],
    );
    db.run(
      `INSERT INTO track_second_stages (id, project_id, track, submission_id, system_name, first_stage_at, first_stage_number, first_stage_by, first_stage_via, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [rowId, project.id, track, submissionId, stage.system, ts, recordNumber, by, input.via, ts],
    );
  });
  addAuditLog(db, project.id, "human", by || "operator", "second_stage.first_stage_recorded", {
    track, via: input.via, system: stage.system, agency: stage.agency,
  });
  return trackSecondStageRow(db, project.id, track)!;
}

// ── The person's screenshot (evidence for the mark; staff-only) ──────────────────────────────

const SHOT_MAX_BYTES = 10 * 1024 * 1024;
const shotDir = (projectId: string): string => path.join(DOCS_DIR, projectId, "second-stage");

/** Keep the person's own picture of the second system's confirmation for this track. PNG or JPEG by
 *  its BYTES, under 10 MB. Stored beside the project's documents but never as a project document
 *  (it is evidence that the upload happened, never a file any filing carries or any model reads). */
export function saveSecondStageScreenshot(db: AppDb, project: ProjectRecord, track: SubmittalTrackType, buffer: Buffer, by: string): { ok: true } {
  const row = secondStagePending(db, project.id, track);
  if (!row) throw new HttpError(409, `The ${track} track is not waiting on a second-stage upload.`);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new HttpError(400, "A PNG or JPEG screenshot is required.");
  if (buffer.length > SHOT_MAX_BYTES) throw new HttpError(413, "The screenshot is larger than 10 MB.");
  const kind = sniffFileKind(buffer);
  if (kind !== "png" && kind !== "jpeg") throw new HttpError(400, "The screenshot must be a PNG or a JPEG image.");
  const dir = shotDir(project.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${row.id}.${kind === "png" ? "png" : "jpg"}`);
  fs.writeFileSync(file, buffer);
  db.run("UPDATE track_second_stages SET screenshot_path = ? WHERE id = ?", [file, row.id]);
  addAuditLog(db, project.id, "human", clean(by, 120) || "operator", "second_stage.screenshot_saved", { track, bytes: buffer.length, kind });
  return { ok: true };
}

/** The file the screenshot route serves: only this project's own row's picture, inside this
 *  project's second-stage folder, on disk. null otherwise (the route answers 404). */
export function secondStageScreenshotFile(db: AppDb, projectId: string, track: string): { path: string; contentType: string } | null {
  const row = trackSecondStageRow(db, projectId, track);
  const stored = row?.screenshotPath ?? "";
  if (!stored) return null;
  const dir = path.resolve(shotDir(projectId));
  const resolved = path.resolve(stored);
  if (path.dirname(resolved) !== dir) return null;
  try { if (!fs.statSync(resolved).isFile()) return null; } catch { return null; }
  return { path: resolved, contentType: resolved.endsWith(".png") ? "image/png" : "image/jpeg" };
}

/**
 * THE PERSON'S MARK, VALIDATED: the plans are uploaded in the second system. Requires a name and the
 * confirmation number or a saved screenshot. Returns what the caller (submittalTracks) needs to record
 * the filing through the ordinary door; `finish` stamps the mark and audits it once that succeeded.
 */
export function beginSecondStageUpload(
  db: AppDb,
  project: ProjectRecord,
  track: SubmittalTrackType,
  input: { confirmationNumber?: unknown; uploadedBy?: unknown },
): { row: TrackSecondStageRow; confirmationNumber: string; uploadedBy: string; finish: () => void } {
  const uploadedBy = clean(input.uploadedBy, 120);
  if (!uploadedBy) throw new HttpError(400, "The upload is marked done by a named person: sign in, or give your name.");
  const row = trackSecondStageRow(db, project.id, track);
  if (!row) throw new HttpError(409, `The ${track} track is not waiting on a second-stage upload: its application has not been recorded.`);
  if (row.uploadedAt) throw new HttpError(409, `The ${track} track's plan upload is already marked done (${row.uploadedAt.slice(0, 10)}, ${row.uploadedBy}).`);
  const confirmationNumber = clean(input.confirmationNumber, 80);
  const hasShot = Boolean(secondStageScreenshotFile(db, project.id, track));
  if (!confirmationNumber && !hasShot) {
    throw new HttpError(400, `Enter the confirmation number ${row.system || "the second system"} showed after the upload, or attach a screenshot of its confirmation.`);
  }
  return {
    row, confirmationNumber, uploadedBy,
    finish: () => {
      const ts = nowIso();
      db.run("UPDATE track_second_stages SET uploaded_at = ?, uploaded_by = ?, confirmation_number = ? WHERE id = ?", [ts, uploadedBy, confirmationNumber, row.id]);
      addAuditLog(db, project.id, "human", uploadedBy, "second_stage.upload_marked_done", {
        track, system: row.system, confirmationNumberGiven: Boolean(confirmationNumber), screenshot: hasShot,
        inviteOnFile: Boolean(row.inviteReceivedAt || row.inviteSubject),
      });
    },
  };
}

// ── The invite email ─────────────────────────────────────────────────────────────────────────

const INVITE_WORDS = /\binvit(?:e|ed|ation|ing)\b/i;
const URL_RE = /https?:\/\/[^\s<>"'()\[\]]+/gi;

/** The links an email's text carries, as written (trailing punctuation dropped), first 12. */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of s(text).match(URL_RE) ?? []) {
    const u = m.replace(/[.,;:!?>\]]+$/, "");
    if (portalHostOf(u) && !out.includes(u)) out.push(u);
    if (out.length >= 12) break;
  }
  return out;
}

/** May this link be SHOWN on this track? Rule 5's one predicate for a permit track and the agency
 *  that issues it, with the email treated as the weakest source there is ("research"): a utility's
 *  portal, another agency's portal, a host that is not the portal a person verified for this agency,
 *  and an information page are all refused. AND, stricter than the predicate alone: an email is a
 *  third party's text placed on the job by a match, so where NO person has verified this agency's
 *  permit portal there is nothing to hold its link against and it is not shown at all (the predicate
 *  would pass any host no record claims). So a link that is shown always sits on the host a person
 *  verified for this agency. Shown is all it ever is: nothing opens it. */
export function inviteLinkFit(db: AppDb, project: ProjectRecord, track: string, url: string): { fits: boolean; host: string; reason: string } {
  const view = stageProject(project, track) ?? project;
  const entity = portalEntityEvidence(db, { scope: "ahj", state: view.state, name: view.ahj });
  const fit = hostFitsTrackAndEntity(track, entity, url, "research");
  const host = portalHostOf(url);
  if (fit.fits && !(entity?.verifiedPortals ?? []).length) {
    return { fits: false, host, reason: `no person has verified where ${s(view.ahj).trim() || "this agency"} takes permit applications, so a link from an email is not shown` };
  }
  return { fits: fit.fits, host, reason: fit.reason };
}

/** The jobs whose application waits on a plan-upload invite that is not on file yet (every org:
 *  the tracker's own org-scoped match decides which of them an email may be placed on). A read. */
export function projectsAwaitingInvite(db: AppDb): Set<string> {
  try {
    return new Set(db.query<Row>("SELECT DISTINCT project_id FROM track_second_stages WHERE uploaded_at = '' AND invite_signature = ''").map((r) => s(r.project_id)));
  } catch { return new Set(); }
}

export interface InboundEmailForInvite {
  subject: string;
  from: string;
  /** The email's text (subject, sender and body): read here, never stored. */
  text: string;
  occurredAt: string;
  signature: string;
}

/**
 * AN EMAIL THE TRACKER PLACED ON THIS JOB: is it the plan-upload invite a track is waiting for?
 * Yes when a track of the job waits on its second stage, no invite is on file for it yet, the email
 * is not older than the application, and its text names the second system or reads as an invitation.
 * Kept: subject, sender, date, and its first link whose host fits (else the first link's HOST and
 * why it is not shown — never the link). `onlyTrack`: a threaded reply names its own track.
 * Returns the tracks it was recorded on. Never throws into the tracker.
 */
export function noteSecondStageInvite(db: AppDb, project: ProjectRecord, email: InboundEmailForInvite, onlyTrack?: string | null): string[] {
  const noted: string[] = [];
  try {
    const rows = db.query<Row>(
      "SELECT * FROM track_second_stages WHERE project_id = ? AND uploaded_at = '' AND invite_signature = '' ORDER BY created_at ASC",
      [project.id],
    ).map(mapRow);
    const text = `${email.subject}\n${email.text}`;
    // An email that NAMES one waiting application's number is that application's invite and no other
    // track's; one that names none may be any waiting track's (two permits at one agency).
    const squash = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]+/g, "");
    const flat = squash(text);
    const named = rows.filter((r) => squash(r.firstStageNumber).length >= 4 && flat.includes(squash(r.firstStageNumber)));
    for (const row of named.length ? named : rows) {
      if (onlyTrack && onlyTrack !== row.track && !(onlyTrack === "permit" && PERMIT_TRACKS.has(row.track))) continue;
      const namesSystem = row.system ? quoteNamesSystem(row.system, text) : false;
      if (!namesSystem && !INVITE_WORDS.test(text)) continue;
      const at = Date.parse(email.occurredAt);
      const first = Date.parse(row.firstStageAt);
      // An email dated before the application (a day of clock slack) is not its invite.
      if (Number.isFinite(at) && Number.isFinite(first) && at < first - 24 * 3600 * 1000) continue;
      let link = "", hiddenHost = "", hiddenWhy = "";
      for (const u of linksIn(email.text)) {
        const fit = inviteLinkFit(db, project, row.track, u);
        if (fit.fits) { link = u; hiddenHost = ""; hiddenWhy = ""; break; }
        if (!hiddenHost) { hiddenHost = fit.host; hiddenWhy = fit.reason; }
      }
      db.run(
        `UPDATE track_second_stages SET invite_signature = ?, invite_subject = ?, invite_from = ?, invite_received_at = ?,
                invite_link = ?, invite_link_hidden_host = ?, invite_link_hidden_why = ? WHERE id = ? AND invite_signature = ''`,
        [email.signature || randomUUID(), clean(email.subject, 240), clean(email.from, 160), Number.isFinite(at) ? new Date(at).toISOString() : nowIso(),
          link, hiddenHost, clean(hiddenWhy, 300), row.id],
      );
      addAuditLog(db, project.id, "system", "email tracker", "second_stage.invite_matched", {
        track: row.track, system: row.system, namesSystem, linkShown: Boolean(link), hiddenHost,
      });
      noted.push(row.track);
    }
  } catch { /* the invite is a convenience: a failure here never disturbs the tracker */ }
  return noted;
}

// ── The card's view ──────────────────────────────────────────────────────────────────────────

export type SecondStageState = "described" | "before_application" | "waiting_invite" | "upload" | "uploaded";

export interface SecondStageView {
  /** The agency that issues this track's permit. */
  agency: string;
  /** "described": a cited description awaiting a person's Confirm (it changes nothing).
   *  "verified": a named person confirmed it; the track asks for the second stage. */
  basis: "described" | "verified";
  system: string;
  trigger: string;
  sourceUrl: string;
  quote: string;
  /** described only: where the description is on file. */
  from?: "lookup" | "reference";
  verifiedBy?: string;
  verifiedAt?: string;
  state: SecondStageState;
  /** True while the application is made and the plans are not uploaded: the track is NOT filed. */
  pending: boolean;
  statusLabel: string;
  /** What a person does next, in one sentence. */
  sentence: string;
  application?: { number: string; at: string; by: string; via: string };
  invite?: { subject: string; from: string; receivedAt: string; link?: string; linkHidden?: { host: string; why: string } };
  uploaded?: { at: string; by: string; confirmationNumber: string; screenshotUrl?: string };
  screenshotUrl?: string;
}

const day = (iso: string): string => s(iso).slice(0, 10);

/** The second-stage block of one track's card, or null when the track's agency has none on file and
 *  the job carries no second-stage row. A read: writes nothing. */
export function secondStageView(db: AppDb, project: ProjectRecord, track: SubmittalTrackType): SecondStageView | null {
  const view = stageProject(project, track);
  if (!view) return null;
  const verified = verifiedSecondStage(db, view);
  const row = trackSecondStageRow(db, project.id, track);
  const described = verified ? null : describedSecondStage(view, track);
  if (!verified && !row && !described) return null;
  const agency = s(view.ahj).trim();
  const shot = row && secondStageScreenshotFile(db, project.id, track)
    ? `/api/projects/${encodeURIComponent(project.id)}/submittal-tracks/${encodeURIComponent(track)}/second-stage/screenshot`
    : "";

  if (!verified && !row) {
    const d = described!;
    return {
      agency, basis: "described", system: d.system, trigger: d.trigger, sourceUrl: d.sourceUrl, quote: d.quote, from: d.from,
      state: "described", pending: false, statusLabel: "",
      sentence: `${agency || "This agency"}'s page says the plans are uploaded in ${d.system} after the application${d.trigger ? ` (${d.trigger})` : ""}. Not confirmed by a person: confirm it and this track will wait for that upload before it reads as filed.`,
    };
  }

  // A job row outlives its agency's record (a person removed it later): the row's own system name.
  const system = verified?.system || row?.system || "";
  const base = {
    agency, basis: "verified" as const, system, trigger: verified?.trigger ?? "", sourceUrl: verified?.sourceUrl ?? "", quote: verified?.quote ?? "",
    ...(verified ? { verifiedBy: verified.verifiedBy, verifiedAt: verified.verifiedAt } : {}),
  };
  if (!row) {
    return {
      ...base, state: "before_application", pending: false, statusLabel: "",
      sentence: `Two-stage filing: the application and its fee go in first; ${agency || "the agency"} then sends an invite${base.trigger ? ` (${base.trigger})` : ""} and the plans are uploaded in ${system} by hand. After paying at the fee stop press We paid the portal (or record an application made by hand below); the track reads as filed only once the upload is marked done.`,
    };
  }
  const application = { number: row.firstStageNumber, at: row.firstStageAt, by: row.firstStageBy, via: row.firstStageVia };
  // The link is judged AGAIN at read time: what is on file about this agency can have changed.
  let invite: SecondStageView["invite"];
  if (row.inviteReceivedAt || row.inviteSubject) {
    invite = { subject: row.inviteSubject, from: row.inviteFrom, receivedAt: row.inviteReceivedAt };
    if (row.inviteLink) {
      const fit = inviteLinkFit(db, project, track, row.inviteLink);
      if (fit.fits) invite.link = row.inviteLink;
      else invite.linkHidden = { host: fit.host, why: fit.reason };
    } else if (row.inviteLinkHiddenHost) {
      invite.linkHidden = { host: row.inviteLinkHiddenHost, why: row.inviteLinkHiddenWhy };
    }
  }
  if (row.uploadedAt) {
    return {
      ...base, state: "uploaded", pending: false, statusLabel: "", application, ...(invite ? { invite } : {}),
      uploaded: { at: row.uploadedAt, by: row.uploadedBy, confirmationNumber: row.confirmationNumber, ...(shot ? { screenshotUrl: shot } : {}) },
      sentence: `Plans uploaded in ${system} ${day(row.uploadedAt)} (marked by ${row.uploadedBy}).`,
    };
  }
  const tail = ` Automation does not open the invite or upload anything; mark the upload done here with the confirmation number or a screenshot.`;
  if (!invite) {
    return {
      ...base, state: "waiting_invite", pending: true, statusLabel: "Application made — waiting for the plan-upload invite", application,
      ...(shot ? { screenshotUrl: shot } : {}),
      sentence: `Application ${row.firstStageNumber} is made${row.firstStageVia === "paid" ? " and its fee paid" : ""} (${day(row.firstStageAt)}). Waiting for ${agency || "the agency"}'s plan-upload invite${base.trigger ? ` (${base.trigger})` : ""}. NOT filed yet. When it arrives (it may reach another inbox), upload the plans in ${system} by hand.${tail}`,
    };
  }
  return {
    ...base, state: "upload", pending: true, statusLabel: "Invite received — upload the plans by hand", application, invite,
    ...(shot ? { screenshotUrl: shot } : {}),
    sentence: `The plan-upload invite arrived ${day(invite.receivedAt)}. Upload the plans in ${system} by hand (the documents listed below). NOT filed yet.${tail}`,
  };
}

// ── The client's page ────────────────────────────────────────────────────────────────────────

/** WHAT THE CLIENT IS TOLD while a permit of this job waits on its second stage, in plain words —
 *  or null when none does. Names no system, no number and no person: only the agency that issues
 *  the waiting permit (a split-issuer job's electrical permit is another office's). A read. */
export function secondStageClientLine(db: AppDb, project: ProjectRecord): string | null {
  let rows: TrackSecondStageRow[];
  try {
    rows = db.query<Row>("SELECT * FROM track_second_stages WHERE project_id = ? AND uploaded_at = '' ORDER BY created_at ASC", [project.id]).map(mapRow);
  } catch { return null; }
  if (!rows.length) return null;
  let agency = s(project.ahj).trim();
  try { agency = s(projectForTrack(project, rows[0].track as SubmittalTrackType).ahj).trim() || agency; } catch { /* the job's own AHJ */ }
  const office = agency || "the permit office";
  const made = rows.every((r) => r.firstStageVia === "paid") ? "Application made and fee paid." : "Application made.";
  return rows.some((r) => r.inviteReceivedAt || r.inviteSubject)
    ? `${made} ${office} has invited us to upload the plans, and we are uploading them. Not filed until the plans are in.`
    : `${made} Waiting on the invitation from ${office} to upload the plans. Not filed until the plans are in.`;
}
