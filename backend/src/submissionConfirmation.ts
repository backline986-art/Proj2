// #569 — THE CONFIRMATION SCREENSHOT OF EVERY FILING, ON THE PROJECT AND THE CARD.
//
// Owner, 2026-11-03: "take a screenshot on the confirmation screen, like 'your app / permit number is
// XYZ'". The proof a client sees that we filed. portal-bot takes it (RecipeAdapter
// captureConfirmationShot) on the page the portal showed after the filing went — the approved final
// submit the portal CONFIRMED, or a person's own submit in the hand-over window whose page read as the
// completion — through #588's maskedFullPageScreenshot, the one masking path, and reports its file only
// when that call proved the mask covered every known secret (rule 2). This module is the backend half:
//
//   - saveSubmissionConfirmation: the file becomes a project document of type `submission_confirmation`
//     named by the track and the number READ OFF THE PAGE ("nem-confirmation-APP-112491.png"), or
//     "…-no-number-read" — never a number nobody read — and the filing record (submissions row)
//     links it (confirmation_document_id, migration v64).
//   - submissionConfirmationFile: what GET /api/projects/:id/submissions/:submissionId/
//     confirmation-screenshot serves — only the document the row names, of THIS project (rule 6:
//     another project's submission or document is a 404).
//   - trackConfirmationView: the newest linked confirmation of a track, for the card's
//     "Submitted: APP-112491 · confirmation screenshot".
//
// Nothing here clicks, fetches or reaches a portal (rule 1): it files a picture a run already took.
// A confirmation screenshot is EVIDENCE OF A FILING, never a document of one: it is kept out of every
// portal upload set (submissionDocuments.uploadedSubmissionDocuments) and out of the documents-changed
// clock QC re-judges on (projectDocuments.documentsChangedAt).
import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import { saveProjectDocument, SUBMISSION_CONFIRMATION_DOC_TYPE } from "./projectDocuments";
import { sniffFileKind } from "./fileTypes";
import { addAuditLog } from "./audit";
import { text as s } from "./json";
import { logger } from "./logger";

type Row = Record<string, unknown>;

/** The document slot a confirmation screenshot is filed under (declared in projectDocuments). */
export { SUBMISSION_CONFIRMATION_DOC_TYPE };

/** Only a file portal-bot named as a confirmation picture is taken (recipeAdapter writes
 *  `zzz-confirmation-<label>.png`): a path that names anything else — the unmasked outcome shot
 *  (`zzz-outcome-…`) above all — is refused, whatever carried it here. */
const CONFIRMATION_FILE = /^zzz-confirmation-[A-Za-z0-9_]{1,40}\.png$/;
/** A full-page PNG of a long completion page stays well under this; anything bigger is not ours. */
const MAX_BYTES = 25 * 1024 * 1024;

/** The document's name: the track and the number read off the page, or "no-number-read". Only the
 *  characters a record number is made of survive — the name never carries page text. */
export function confirmationFileName(track: string, recordNumber: string): string {
  const t = String(track || "permit").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "permit";
  const n = String(recordNumber || "").trim().replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${t}-confirmation-${n || "no-number-read"}.png`;
}

export interface SaveConfirmationInput {
  projectId: string;
  /** The filing record the picture proves (submissions.id, of this project). */
  submissionId: string;
  /** The track it filed (submissions.permit_type: nem, building, electrical, …). */
  track: string;
  /** The number READ OFF THE PAGE by the run ("" when none was read). Never a guess. */
  recordNumber: string;
  /** The masked picture portal-bot reported (in-memory adapter result, never a request body). */
  shotPath: string;
  /** Who filed: "automation" (the approved final submit) or "person" (the hand-over window). */
  filedBy: "automation" | "person";
  runId: string;
}

/**
 * FILE THE CONFIRMATION SCREENSHOT: a project document of type submission_confirmation, linked from
 * the submission row. Returns the document id, or null with the reason logged and audited — a picture
 * that cannot be filed never disturbs the run's record. Refuses: a path not named as a confirmation
 * picture, a file that is missing / empty / too big / not a PNG by its bytes, and a submission row
 * that is not this project's.
 */
export function saveSubmissionConfirmation(db: AppDb, input: SaveConfirmationInput): { documentId: string | null; why: string } {
  const refuse = (why: string): { documentId: null; why: string } => {
    try {
      addAuditLog(db, input.projectId, "portal_bot", "submission confirmation", "submission.confirmation_screenshot_not_kept", {
        track: input.track, runId: input.runId, why,
      });
    } catch { /* the audit is best-effort here */ }
    logger.info("submission-confirmation", "confirmation screenshot not filed", { project: input.projectId, track: input.track, why });
    return { documentId: null, why };
  };
  const file = String(input.shotPath || "");
  if (!file) return refuse("no masked confirmation screenshot was kept by the run");
  if (!CONFIRMATION_FILE.test(path.basename(file))) return refuse("the run's picture is not a confirmation screenshot");
  const sub = db.get<Row>("SELECT id FROM submissions WHERE id = ? AND project_id = ?", [input.submissionId, input.projectId]);
  if (!sub) return refuse("the filing record is not this project's");
  let buffer: Buffer;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) return refuse("the confirmation screenshot file is missing, empty or too large");
    buffer = fs.readFileSync(file);
  } catch {
    return refuse("the confirmation screenshot file could not be read");
  }
  if (sniffFileKind(buffer) !== "png") return refuse("the confirmation screenshot is not a PNG");
  try {
    const doc = saveProjectDocument(db, input.projectId, {
      docType: SUBMISSION_CONFIRMATION_DOC_TYPE,
      filename: confirmationFileName(input.track, input.recordNumber),
      contentType: "image/png",
      buffer,
      source: "portal_run",
      uploadedBy: input.filedBy === "automation" ? "portal-bot (approved final submit)" : "portal-bot (your submit in the review window)",
    });
    db.run("UPDATE submissions SET confirmation_document_id = ? WHERE id = ? AND project_id = ?", [doc.id, input.submissionId, input.projectId]);
    addAuditLog(db, input.projectId, "portal_bot", "submission confirmation", "submission.confirmation_screenshot_saved", {
      track: input.track, runId: input.runId, submissionId: input.submissionId, documentId: doc.id,
      numberRead: Boolean(String(input.recordNumber || "").trim()), filedBy: input.filedBy,
    });
    return { documentId: doc.id, why: "" };
  } catch (err) {
    return refuse(`the confirmation screenshot could not be saved (${err instanceof Error ? err.message.slice(0, 120) : String(err)})`);
  }
}

/** The file the confirmation route serves: ONLY the document the submission row names, of the same
 *  project, of type submission_confirmation, on disk. null otherwise (the route answers 404). */
export function submissionConfirmationFile(db: AppDb, projectId: string, submissionId: string): string | null {
  const row = db.get<Row>(
    `SELECT d.stored_path AS stored_path FROM submissions sb
       JOIN project_documents d ON d.id = sb.confirmation_document_id AND d.project_id = sb.project_id
      WHERE sb.id = ? AND sb.project_id = ? AND sb.confirmation_document_id != '' AND d.doc_type = ?`,
    [submissionId, projectId, SUBMISSION_CONFIRMATION_DOC_TYPE],
  );
  const stored = s(row?.stored_path);
  if (!stored) return null;
  try { return fs.statSync(stored).isFile() ? stored : null; } catch { return null; }
}

/** The card's confirmation line for one track (a read: writes nothing). */
export interface TrackConfirmationView {
  submissionId: string;
  documentId: string;
  /** The project-scoped route that serves the masked picture. */
  url: string;
  /** The number on the filing record ("" when none was read). */
  recordNumber: string;
  /** True when the filing record reads submitted (a number confirmed); false: the page read as the
   *  completion, but no number was read and the record still waits for one. */
  submitted: boolean;
  at: string;
}

/** The newest submission of this track that links a confirmation screenshot, or null. `permitTypes`:
 *  the track's permit_type family (submittalTracks.trackPermitTypes — a trackless filing is "permit"). */
export function trackConfirmationView(db: AppDb, projectId: string, permitTypes: readonly string[]): TrackConfirmationView | null {
  if (!permitTypes.length) return null;
  let row: Row | null | undefined;
  try {
    row = db.get<Row>(
      `SELECT sb.id AS id, sb.status AS status, sb.application_number AS application_number, sb.permit_number AS permit_number,
              sb.confirmation_document_id AS document_id, COALESCE(NULLIF(sb.submitted_at, ''), sb.created_at) AS at
         FROM submissions sb
         JOIN project_documents d ON d.id = sb.confirmation_document_id AND d.project_id = sb.project_id
        WHERE sb.project_id = ? AND sb.permit_type IN (${permitTypes.map(() => "?").join(", ")}) AND sb.confirmation_document_id != '' AND d.doc_type = ?
        ORDER BY sb.created_at DESC, sb.rowid DESC LIMIT 1`,
      [projectId, ...permitTypes, SUBMISSION_CONFIRMATION_DOC_TYPE],
    );
  } catch {
    return null;
  }
  if (!row) return null;
  const submissionId = s(row.id);
  return {
    submissionId,
    documentId: s(row.document_id),
    url: `/api/projects/${encodeURIComponent(projectId)}/submissions/${encodeURIComponent(submissionId)}/confirmation-screenshot`,
    recordNumber: s(row.permit_number) || s(row.application_number),
    submitted: s(row.status) === "submitted",
    at: s(row.at),
  };
}

const CONFIRMATION_ROUTE_RE = /^\/api\/projects\/([^/]+)\/submissions\/([^/]+)\/confirmation-screenshot$/;
/**
 * WHAT A PAID ROW MAY LINK (#665): only this project's own confirmation route — the one that serves
 * the MASKED picture (submissionConfirmationFile), never a run's unmasked outcome shot or any file
 * path (rule 2). Anything else stored in the column reads as ''.
 */
export function paidConfirmationUrl(projectId: string, stored: unknown): string {
  const v = s(stored).trim();
  const m = CONFIRMATION_ROUTE_RE.exec(v);
  if (!m) return "";
  try { return decodeURIComponent(m[1]) === projectId ? v : ""; } catch { return ""; }
}
