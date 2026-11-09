// ---------------------------------------------------------------------------
// BULK JOB-FOLDER DROP (#538, owner request 2026-11-02).
//
// A new installer hands us its backlog on day one: one zip (or, for the operator, one server
// folder) holding ONE SUB-FOLDER PER JOB. Each top-level folder becomes one job, run through email
// intake's own per-job pipeline (emailIntake.placeIntakeJob: the same slot rules, the same read of
// the documents' text, the same createProject, documents and enqueueStageSteps; called, never
// copied). Before this, a 100-job drop meant 100 Parser sessions or 100 emails.
//
// TWO STEPS, SO THE COUNT IS SEEN FIRST. Uploading the zip (or naming the folder) only extracts it
// and lists its job folders: nothing is read and no model is called. Start queues one
// `bulk_job_folder` job per folder. Each is one model read, the Parser's cost, so the preview's
// count is the drop's cost in Parser reads.
//
// ONE JOB PER FOLDER, NOT ONE JOB FOR THE DROP. A 100-folder drop read in one job would hold the
// queue for an hour (JOB_CONCURRENCY defaults to 1), and the chain each new project queues would
// wait behind the whole drop. Per-folder jobs run at priority 3, under stage_step's 4, so a created
// project's QC chain runs between folders. One bad folder never sinks the batch: its job ends
// unsorted (or failed, after the queue's retries) and every other folder still runs. A retry is
// safe: the same address for the same client attaches, and a file already on the project (same
// slot, name and size) is not added again.
//
// RULE 6. The org is the CHOSEN CLIENT's, never anything in the archive: the client must be in the
// caller's org (else 404), the zip is extracted under that org's upload root, each job is stamped
// with that org, and the runner re-reads the client IN THE JOB'S ORG and re-confines the folder to
// that org's root (unless an operator queued it) before reading a byte.
// RULE 2. Only the documents' text goes to the extractor (placeIntakeJob, as email intake does).
// NOTHING TOUCHES A PORTAL: the chain enqueueStageSteps queues stops at ready_to_stage.
// No server path is ever returned to the browser: a drop is named by its folder's own name.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import type {
  BulkDropFolderStatus, BulkDropFolderView, BulkDropPreview, BulkDropView, EmailIntakeFile,
} from "../../shared/src/types";
import { addAuditLog } from "./audit";
import { batchUploadRoot, extractZipToWorkdir, folderScanJobAllowed, folderWithinRoot, mayScanFolder } from "./batchZip";
import { HttpError } from "./httpError";
import { intakeClientInOrg, placeIntakeJob, type IntakeClient, type IntakeExtractor } from "./emailIntake";
import { enqueueJob, type JobRecord } from "./jobQueue";
import { text } from "./json";
import { logger } from "./logger";

type Row = Record<string, unknown>;
const ACTOR = "bulk job drop";
/** Folder jobs run under stage_step (4), so a created project's chain is not stuck behind the drop. */
const FOLDER_JOB_PRIORITY = 3;
/** The pipeline refuses a file past its 20th (emailIntake MAX_FILES); reading more is wasted. */
const MAX_FILES_READ = 21;

function maxJobs(): number {
  const n = Number(process.env.BULK_DROP_MAX_JOBS || 500);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

const IGNORED = new Set(["__macosx", "thumbs.db", "desktop.ini"]);
/** Archive litter, never a job or a document: dot-files, macOS resource forks, Windows thumbnails. */
function visible(name: string): boolean {
  return !name.startsWith(".") && !IGNORED.has(name.toLowerCase());
}

function entriesOf(dir: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!visible(e.name) || e.isSymbolicLink()) continue;
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile()) files.push(e.name);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  return { dirs: dirs.sort(byName), files: files.sort(byName) };
}

/**
 * The job folders of a drop. A zip made by zipping ONE folder ("Backlog/Job 1/…, Backlog/Job 2/…")
 * has a single wrapper: when the top level is exactly one folder, with no files beside it, whose own
 * contents are only folders, those are the jobs. A single job zipped alone ("12 Elm St/plan.pdf")
 * has files in its one folder and stays one job.
 */
export function jobFolders(root: string): { base: string; jobs: Array<{ folder: string; dir: string }>; looseFiles: string[] } {
  let base = root;
  for (let depth = 0; depth < 3; depth++) {
    const top = entriesOf(base);
    if (top.dirs.length !== 1 || top.files.length) break;
    const inner = entriesOf(path.join(base, top.dirs[0]));
    if (!inner.dirs.length || inner.files.length) break;
    base = path.join(base, top.dirs[0]);
  }
  const top = entriesOf(base);
  return { base, jobs: top.dirs.map((folder) => ({ folder, dir: path.join(base, folder) })), looseFiles: top.files };
}

/** Every visible file in a job folder, nested folders included, in name order (capped). */
function folderFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    const { dirs, files } = entriesOf(d);
    for (const f of files) { if (out.length >= MAX_FILES_READ) return; out.push(path.join(d, f)); }
    for (const sub of dirs) { if (out.length >= MAX_FILES_READ) return; walk(path.join(d, sub)); }
  };
  walk(dir);
  return out;
}

function countFiles(dir: string): number {
  let n = 0;
  const walk = (d: string): void => {
    const { dirs, files } = entriesOf(d);
    n += files.length;
    for (const sub of dirs) walk(path.join(d, sub));
  };
  walk(dir);
  return n;
}

// ---------------------------------------------------------------------------
// The doors (routes call these).
// ---------------------------------------------------------------------------

export interface DropScope { orgId: string; crossOrg: boolean }

/** The chosen client, in the caller's scope (rule 6: another org's client, or an unknown id, is a 404). */
export function dropClient(db: AppDb, scope: DropScope, clientId: unknown): IntakeClient {
  const idText = typeof clientId === "string" ? clientId.trim() : "";
  if (!idText) throw new HttpError(400, "Choose the client these jobs are for.");
  const row = db.get<{ org_id?: string }>("SELECT org_id FROM clients WHERE id = ?", [idText]);
  const orgId = text(row?.org_id) || DEFAULT_ORG_ID;
  if (!row || (!scope.crossOrg && orgId !== scope.orgId)) throw new HttpError(404, "Client not found.");
  const client = intakeClientInOrg(db, idText, orgId);
  if (!client) throw new HttpError(404, "Client not found.");
  return client;
}

const UPLOAD_PREFIX = "jobs-";

/** An uploaded drop's folder, named by its id under the CLIENT's org root, else a 404. */
function uploadFolder(client: IntakeClient, uploadId: unknown): string {
  const idText = typeof uploadId === "string" ? uploadId.trim() : "";
  const root = batchUploadRoot(client.org_id || DEFAULT_ORG_ID);
  const dir = path.join(root, idText);
  if (!idText.startsWith(UPLOAD_PREFIX) || path.basename(idText) !== idText || !folderWithinRoot(dir, root) || !fs.existsSync(dir)) {
    throw new HttpError(404, "That upload was not found. Drop the zip again.");
  }
  return dir;
}

/** A server folder named by the caller: the operator anywhere, a tenant only inside its own upload
 *  root (batchZip.mayScanFolder, the folder scan's one answer). Refused is the same 404 as missing. */
function namedFolder(scope: DropScope, folderPath: unknown): string {
  const dir = typeof folderPath === "string" ? folderPath.trim() : "";
  // A tenant's scope.orgId IS the client's org here (dropClient held it), so its root is the client's.
  if (!dir || !mayScanFolder(scope, dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new HttpError(404, `Folder not found: ${dir}`);
  return dir;
}

function previewOf(dir: string, clientId: string, uploadId: string): BulkDropPreview {
  const { jobs, looseFiles } = jobFolders(dir);
  if (jobs.length > maxJobs()) {
    throw new HttpError(400, `This drop holds ${jobs.length} job folders; the limit is ${maxJobs()} per drop (BULK_DROP_MAX_JOBS). Split it.`);
  }
  return { uploadId, clientId, jobs: jobs.map((j) => ({ folder: j.folder, files: countFiles(j.dir) })), looseFiles };
}

/** Extract an uploaded zip under the chosen client's org root and list its job folders. Reads
 *  nothing and queues nothing: the person sees the count first. */
export function previewUploadedDrop(db: AppDb, scope: DropScope, clientId: unknown, zip: Buffer): BulkDropPreview {
  const client = dropClient(db, scope, clientId);
  let extracted;
  try {
    extracted = extractZipToWorkdir(zip, "jobs", client.org_id || DEFAULT_ORG_ID);
  } catch (err) {
    throw new HttpError(400, `Could not read that zip file. ${(err as Error).message || ""}`.trim());
  }
  const preview = previewOf(extracted.folderPath, client.id, path.basename(extracted.folderPath));
  if (!preview.jobs.length) {
    fs.rmSync(extracted.folderPath, { recursive: true, force: true });
    throw new HttpError(400, "The zip has no job folders. Put each job's files in its own folder, then zip those folders together.");
  }
  return preview;
}

/** List a server folder's job folders (operator, or inside the caller's own upload root). */
export function previewFolderDrop(db: AppDb, scope: DropScope, clientId: unknown, folderPath: unknown): BulkDropPreview {
  const client = dropClient(db, scope, clientId);
  return previewOf(namedFolder(scope, folderPath), client.id, "");
}

/** Queue one bulk_job_folder job per job folder, each stamped with the CLIENT's org. */
export function startDrop(
  db: AppDb, scope: DropScope, body: { clientId?: unknown; uploadId?: unknown; folderPath?: unknown }, by: string,
): { batchId: string; queued: number } {
  const client = dropClient(db, scope, body.clientId);
  const orgId = client.org_id || DEFAULT_ORG_ID;
  const fromUpload = typeof body.uploadId === "string" && body.uploadId.trim() !== "";
  const dir = fromUpload ? uploadFolder(client, body.uploadId) : namedFolder(scope, body.folderPath);
  const { jobs } = jobFolders(dir);
  if (!jobs.length) throw new HttpError(400, "This drop has no job folders.");
  if (jobs.length > maxJobs()) throw new HttpError(400, `This drop holds ${jobs.length} job folders; the limit is ${maxJobs()} per drop.`);
  // The worker re-confines each folder to the job org's upload root unless an operator queued it
  // (the folder scan's `scanAs` marker, batchZip.folderScanJobAllowed). An upload always lies inside.
  const scanAs = !fromUpload && !folderWithinRoot(dir, batchUploadRoot(orgId)) ? "operator" : "org";
  const batchId = crypto.randomUUID();
  const startedBy = by || "operator";
  for (const job of jobs) {
    enqueueJob(db, "bulk_job_folder", {
      batchId, folder: job.folder, folderPath: job.dir, clientId: client.id, scanAs, startedBy,
    }, { priority: FOLDER_JOB_PRIORITY, maxRetries: 2, orgId });
  }
  addAuditLog(db, null, "human", startedBy, "bulk_drop.started", { batchId, clientId: client.id, jobs: jobs.length, source: fromUpload ? "zip" : "folder" });
  logger.info("bulk-drop", `queued ${jobs.length} job folder(s)`, { batchId });
  return { batchId, queued: jobs.length };
}

// ---------------------------------------------------------------------------
// The runner (one job folder).
// ---------------------------------------------------------------------------

const REASON_TEXT: Record<string, string> = {
  no_usable_attachments: "No PDF or photo in this folder that we can use.",
  address_unreadable: "The project address could not be read from this folder's documents (a scanned plan set, or no plan set). Create this job in the Parser.",
  plan_set_names_another_client: "The plan set's licence number belongs to a different client than the one this drop is for.",
  failed: "Processing failed.",
};

export interface FolderJobResult extends Record<string, unknown> {
  batchId: string;
  folder: string;
  status: "created" | "attached" | "unsorted";
  reason: string;
  projectId: string | null;
  files: EmailIntakeFile[];
  missing: string[];
}

/** The model read, replaceable in tests only (the queue runs the real one: extractParserFields). */
let extractSeam: IntakeExtractor | null = null;
export function setBulkDropExtractorForTests(fn: IntakeExtractor | null): void {
  if (process.env.AUTOPILOT_TEST_SEAMS !== "1") throw new Error("setBulkDropExtractorForTests needs AUTOPILOT_TEST_SEAMS=1 — it is a test seam only.");
  extractSeam = fn;
}

/** Run one job folder through the per-job pipeline. Throws (the queue retries, then fails it) only
 *  when the folder could not be read at all or the pipeline itself broke. */
export async function runBulkJobFolder(db: AppDb, job: Pick<JobRecord, "id" | "orgId" | "payload">, opts: { extract?: IntakeExtractor } = {}): Promise<FolderJobResult> {
  const p = job.payload as { batchId?: unknown; folder?: unknown; folderPath?: unknown; clientId?: unknown; startedBy?: unknown };
  const batchId = text(p.batchId);
  const folder = text(p.folder);
  const folderPath = text(p.folderPath);
  // RULE 6 AT RUN TIME: the client in the JOB's org (stamped from the client at start), never a
  // client the payload could point across orgs; and the folder inside that org's root.
  const client = intakeClientInOrg(db, text(p.clientId), job.orgId || DEFAULT_ORG_ID);
  if (!client) throw new Error("The client this drop was for is no longer in this org.");
  if (!folderScanJobAllowed(job.payload, job.orgId || DEFAULT_ORG_ID) || !fs.existsSync(folderPath)) {
    throw new Error(`Job folder not found: ${folder}`);
  }
  const files = folderFiles(folderPath).map((f) => ({ filename: path.basename(f), content: fs.readFileSync(f) }));
  const by = text(p.startedBy) || ACTOR;
  const placed = await placeIntakeJob(db, { client, files, extract: opts.extract ?? extractSeam ?? undefined, uploadedBy: by, source: "bulk_drop" });
  const fileViews: EmailIntakeFile[] = placed.files.map(({ name, size, docType, refused }) => ({ name, size, ...(refused ? { refused } : { docType }) }));
  if (placed.outcome === "unsorted") {
    logger.info("bulk-drop", `folder unsorted: ${placed.reason}`, { batchId, files: files.length });
    return { batchId, folder, status: "unsorted", reason: placed.reason, projectId: null, files: fileViews, missing: [] };
  }
  addAuditLog(db, placed.projectId, "human", by, placed.outcome === "attached" ? "project.files_attached_from_bulk_drop" : "project.created_from_bulk_drop", {
    batchId, jobId: job.id, files: fileViews.map((f) => ({ docType: f.docType ?? null, refused: Boolean(f.refused) })),
    unsure: placed.unsure, missing: placed.missing.length,
  });
  return { batchId, folder, status: placed.outcome, reason: "", projectId: placed.projectId, files: fileViews, missing: placed.missing };
}

// ---------------------------------------------------------------------------
// The list (progress and per-folder outcome).
// ---------------------------------------------------------------------------

function folderView(row: Row): BulkDropFolderView {
  let payload: Row = {};
  let result: Row | null = null;
  try { payload = JSON.parse(text(row.payload) || "{}"); } catch { payload = {}; }
  try { result = row.result ? JSON.parse(text(row.result)) : null; } catch { result = null; }
  const status = text(row.status);
  const base = { folder: text(payload.folder), projectId: null, files: [] as EmailIntakeFile[], missing: [] as string[] };
  if (status === "pending") return { ...base, status: "queued", reason: Number(row.retry_count) > 0 ? "retrying" : "", reasonText: Number(row.retry_count) > 0 ? "Failed once; it will be tried again." : "" };
  if (status === "running") return { ...base, status: "running", reason: "", reasonText: "" };
  if (status === "failed" || !result) {
    const why = text(row.error).slice(0, 300);
    return { ...base, status: "unsorted", reason: "failed", reasonText: why ? `${REASON_TEXT.failed} ${why}` : REASON_TEXT.failed };
  }
  const reason = text(result.reason);
  const st = text(result.status) as BulkDropFolderStatus;
  return {
    folder: base.folder,
    status: st === "created" || st === "attached" ? st : "unsorted",
    reason,
    reasonText: reason ? REASON_TEXT[reason] ?? reason : "",
    projectId: text(result.projectId) || null,
    files: Array.isArray(result.files) ? result.files as EmailIntakeFile[] : [],
    missing: Array.isArray(result.missing) ? (result.missing as unknown[]).map(String) : [],
  };
}

/** The latest drops with every folder's outcome. `orgFilter` null reads every org (superadmin). */
export function listBulkDrops(db: AppDb, orgFilter: string | null, limit = 10): BulkDropView[] {
  const where = orgFilter === null ? "" : " AND org_id = ?";
  const rows = db.query<Row>(
    `SELECT id, org_id, payload, status, result, error, retry_count, created_at FROM job_queue
     WHERE job_type = 'bulk_job_folder'${where} ORDER BY created_at DESC LIMIT 5000`,
    orgFilter === null ? [] : [orgFilter],
  );
  const byBatch = new Map<string, Row[]>();
  for (const row of rows) {
    let batchId = "";
    try { batchId = text(JSON.parse(text(row.payload) || "{}").batchId); } catch { batchId = ""; }
    if (!batchId) continue;
    if (!byBatch.has(batchId)) {
      if (byBatch.size >= limit) continue;
      byBatch.set(batchId, []);
    }
    byBatch.get(batchId)!.push(row);
  }
  const names = new Map<string, string>();
  return [...byBatch.entries()].map(([batchId, batchRows]) => {
    const folderOf = (r: Row): string => { try { return text(JSON.parse(text(r.payload) || "{}").folder); } catch { return ""; } };
    const ordered = [...batchRows].sort((a, b) => folderOf(a).localeCompare(folderOf(b), undefined, { numeric: true, sensitivity: "base" }));
    let first: Row = {};
    try { first = JSON.parse(text(ordered[0].payload) || "{}"); } catch { first = {}; }
    const createdAt = batchRows.map((r) => text(r.created_at)).sort()[0] || "";
    const clientId = text(first.clientId);
    if (!names.has(clientId)) names.set(clientId, text(db.get<Row>("SELECT company_name FROM clients WHERE id = ?", [clientId])?.company_name));
    const folders = ordered.map(folderView);
    const counts: Record<BulkDropFolderStatus, number> = { queued: 0, running: 0, created: 0, attached: 0, unsorted: 0 };
    for (const f of folders) counts[f.status] += 1;
    return {
      batchId, clientId, clientName: names.get(clientId) || "", startedBy: text(first.startedBy),
      createdAt, total: folders.length, counts, folders,
    };
  });
}
