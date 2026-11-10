// ---------------------------------------------------------------------------
// EMAIL-IN INTAKE (#489, owner request #485).
//
// Every job used to start with a person uploading the plan set and bill in the Parser and
// pressing Save to project. Now an installer can email the job to the intake address with their
// tag — intake+acme@… — and the server creates the project, attaches the files, runs the same
// extraction and local chain as the Parser path, and replies with the project's status link and
// what is still missing. Anything it cannot place waits on the unsorted intake list for a person.
//
// WHICH MESSAGES. Only mail addressed to EMAIL_INTAKE_ADDRESS (To, Cc, Delivered-To or
// X-Original-To), with or without a +tag. That address is distinct from the status-tracking
// tags (permits+acme@…): the poller hands intake mail here and never to the status tracker, and
// mail to any other address never reaches this module. Unset = intake is off.
//
// WHICH CLIENT (rule 6). The tag picks the client (clients.intake_tag), and the org is that
// client's org — never anything the message text or the plan set says. The sender must be one of
// that client's own addresses (contact, business, updates, billing) or an entry an operator added
// to clients.intake_senders; anything else is unsorted, never filed on a guessed client. A
// message whose DMARC result is a fail is unsorted too, and with EMAIL_INTAKE_REQUIRE_AUTH on so is
// one without a passing result from the receiving server (intakeAuth.ts, #510). A plan set whose licence number binds to
// a DIFFERENT client (the parser's exact-CCB auto-assign) is unsorted rather than filed under
// either. A per-client IMAP source (a DB row) only ever matches clients in its own org.
//
// WHICH FILES. Each attachment is sniffed by its bytes (fileTypes.ts) and saved through the same
// saveProjectDocument the documents route uses, so the same type checks apply; a refused file is
// listed in the reply and never drops the others (compare #311). Inline signature images are not
// attachments and are skipped.
//
// THE PARSE. The documents' text is read on the server (batchImport.extractPdfText) and handed to
// extractParserFields — the function behind /api/parser/llm-extract, not a copy. A field the
// model flagged as low-confidence is NOT written (a doubt never becomes a fact on an application);
// it is named in the reply as something we will confirm. Then the project is created exactly as
// the Parser's save creates it (createProject) and the local chain is queued (enqueueStageSteps),
// which splits the plan set and reads a photographed bill as it does for any project.
//
// SAME JOB TWICE. The same street address (and ZIP, when both have one) for the same client within
// EMAIL_INTAKE_DEDUPE_DAYS (default 30) attaches the files to that project instead of making a
// second one; a file already on it (same slot, name and size) is not added again. The same MESSAGE
// is never processed twice: every message is recorded by its Message-ID (else a hash of it), and
// a poll that fails before its read cursor moves reads the same messages again (#539). Intake runs
// in an email_intake job, never inline in the monitor tick.
//
// RULE 2. Reading the customer's own bill at intake is the one allowed read: its text goes to the
// extraction, as on the Parser page. Nothing is logged from it, and the reply never carries the
// account or meter number (labels only, then redactSecretValues with the project's own values).
// The email's own body is never sent to a model.
//
// THE REPLY. Only to a known sender, only once a project was created or attached, to the From
// address (never the incoming message's Reply-To). Scrubbed with the project's own secret values (projectSecretValuesById)
// and the read's; when those cannot be read the reply is withheld, never sent unscrubbed. SMTP_HOST + SMTP_FROM set and PUBLIC_BASE_URL set → sent; otherwise a
// DRAFT communication on the project, like every other client email. EMAIL_INTAKE_AUTO_REPLY=off
// or CLIENT_NOTIFICATIONS=off keeps it a draft.
//
// THE WAY BACK TO THE JOB (#540). The reply asks for what is still missing ("reply with these"), so
// a Reply must come back HERE, not to SMTP_FROM (the status tracker's mailbox, which ignores
// attachments). The reply carries Reply-To: intake+<the client's own tag>@<intake domain> — only the
// tag, nothing secret (rule 2) — and a Message-ID of our own that names the project it answers
// (intakeReplyMessageId). A message that comes back with that id in its In-Reply-To or References
// attaches to THAT project, even when its files carry no readable address (a bill photo alone):
// only after the tag, the sender and its authentication chose the client, only a project of that
// same client in that same org (rule 6), never an archived one, and never when the files read a
// DIFFERENT street (a new job sent as a reply is still a new job). Otherwise the normal path runs:
// the same address attaches, a new one creates.
//
// UNSORTED NEVER SITS UNSEEN (#541). A message that lands unsorted raises ONE staff alert
// (staffAlerts.alertStaffOnUnsortedIntake: the sender's domain, the day and the reason in our own
// words — never the subject, the body or a file name; rule 2), deduped per row. Its raw message is
// kept beside its files, so a person can place it in one step instead of redoing the job in the
// Parser:
//   File under client …  re-runs this same per-message pipeline with the client the person chose
//                        (in the message's own org, else 404: rule 6). The person's choice stands in
//                        for the tag and the sender check — that is what choosing the client means —
//                        and, when it is the row's own reason, for the DMARC check or the plan set's
//                        other licence. Every other check runs again; a message that trips one lands
//                        unsorted again with that reason, for the person to see and decide on.
//   Retry                re-runs a `failed` message exactly as the poll would have.
// The person's name is audited on the row and the project. A reply to a sender the person vouched for
// (not one of the client's own addresses, or one that failed authentication) is kept as a DRAFT on
// the project, never sent automatically. Only an `unsorted` row can be re-run, and only one run per
// row at a time; a placed or dismissed message is never processed again (its key stays recorded).
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Attachment, ParsedMail } from "mailparser";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import type {
  EmailIntakeFile, EmailIntakeReason, EmailIntakeRunResult, EmailIntakeStatus, EmailIntakeView,
  ParserExtractionResponse, ParserPayload, ProjectRecord,
} from "../../shared/src/types";
import { redactSecretValues } from "../../shared/src/portalSafety";
import { addAuditLog } from "./audit";
import { enqueueStageSteps } from "./autoStageSteps";
import { classifyDoc, extractPdfText } from "./batchImport";
import { BRAND } from "./clientUpdates";
import { clientEmailsOffFor, ensureStatusShareToken, formatProjectAddress, sendEmail, smtpConfigured, statusShareUrl } from "./clientNotifier";
import { mapEmailText, renderEmail, type EmailContent, type EmailSection } from "./emailLayout";
import { addCommunication } from "./crm";
import { clientLinkRefusal } from "./clientLinkGuard";
import { describeKind, isImageKind, looksLikeCad, sniffFileKind } from "./fileTypes";
import { HttpError } from "./httpError";
import { intakeAuthRefusal } from "./intakeAuth";
import { id } from "./ids";
import { text } from "./json";
import { logger } from "./logger";
import { normalizeProject, normalizeTokens } from "./normalize";
import { saveProjectDocument } from "./projectDocuments";
import { isPlannerSecretKey, projectSecretValuesById } from "./projectSecrets";
import { createProject, getProjectDetail } from "./repository";
import { alertStaffOnUnsortedIntake } from "./staffAlerts";
import { backendDataDir } from "./statePaths";
import { nowIso } from "./time";

type Row = Record<string, unknown>;
const ACTOR = "email intake";
const MAX_FILES = 20;

/** `html`: the layout part (emailLayout.ts), rendered from the same scrubbed content as `body`. */
export type IntakeSender = (to: string, subject: string, body: string, html?: string, headers?: IntakeReplyHeaders) => Promise<void>;
/** The reply's way back to the job (#540): Reply-To intake+<tag>@… and a Message-ID naming the project. */
export interface IntakeReplyHeaders { replyTo?: string; messageId?: string }
export type IntakeExtractor = (input: { planText: string; utilityBillText: string; structuralLetterText: string }, orgId: string) => Promise<ParserExtractionResponse>;

export interface IntakeOptions {
  /** Org of the polling source. A DB-row IMAP source passes its org and `restrictToOrg`; the
   *  central (env) inbox and Gmail are operator-level and match a tag in any org. */
  sourceOrgId?: string;
  restrictToOrg?: boolean;
  /** Test doors: the model read and the mail send. Production uses extractParserFields / SMTP. */
  extract?: IntakeExtractor;
  send?: IntakeSender;
}

// ---------------------------------------------------------------------------
// The intake address.
// ---------------------------------------------------------------------------

export function intakeAddressSetting(): { local: string; domain: string } | null {
  const m = /^([^@\s+]+)@([^@\s]+)$/.exec(String(process.env.EMAIL_INTAKE_ADDRESS ?? "").trim().toLowerCase());
  return m ? { local: m[1], domain: m[2] } : null;
}

/** Intake is configured (EMAIL_INTAKE_ADDRESS is an address). */
export function intakeEnabled(): boolean {
  return intakeAddressSetting() !== null;
}

/** The tag an intake recipient carries: "" for the bare intake address, null when no recipient is
 *  the intake address at all. A tagged recipient wins over a bare one. */
export function intakeTagFrom(recipients: string[], addr = intakeAddressSetting()): string | null {
  if (!addr) return null;
  let found: string | null = null;
  for (const r of recipients) {
    const m = /^([^@\s]+)@([^@\s]+)$/.exec(String(r).trim().toLowerCase());
    if (!m || m[2] !== addr.domain) continue;
    const [base, ...tagParts] = m[1].split("+");
    if (base !== addr.local) continue;
    const tag = tagParts.join("+");
    if (tag) return tag;
    found = "";
  }
  return found;
}

/** Where a client's Reply to the intake acknowledgement goes (#540): the intake address with the
 *  client's OWN tag, so the reply comes back through intake to the same client. Null when intake is
 *  off or the client has no tag: the bare intake address would land the reply unsorted (no_tag), so
 *  then no Reply-To is set at all. */
export function intakeReplyToAddress(db: AppDb, clientId: string, addr = intakeAddressSetting()): string | null {
  if (!addr) return null;
  const tag = text(db.get<Row>("SELECT intake_tag FROM clients WHERE id = ?", [clientId])?.intake_tag).trim().toLowerCase();
  return tag ? `${addr.local}+${tag}@${addr.domain}` : null;
}

const REPLY_REF_RE = /<intake-reply\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[0-9a-f]+@([^<>\s@]+)>/gi;

/** The acknowledgement's own Message-ID: it names the project it answers, so a reply to it (whose
 *  In-Reply-To / References carry it back) reaches that project (#540). The project id is not a
 *  secret (the status link's token is); the random part keeps every acknowledgement's id unique. */
export function intakeReplyMessageId(projectId: string, addr = intakeAddressSetting()): string | undefined {
  if (!addr || !/^[0-9a-f-]{36}$/i.test(projectId)) return undefined;
  return `<intake-reply.${projectId.toLowerCase()}.${crypto.randomBytes(8).toString("hex")}@${addr.domain}>`;
}

/** The projects a message says it answers: our own acknowledgement ids (intakeReplyMessageId) in
 *  its In-Reply-To first, then its References newest first. Ids minted for another domain are
 *  not ours and are ignored. Only candidates: placeIntakeJob holds each to the chosen client. */
export function answeredProjectIds(parsed: Pick<ParsedMail, "inReplyTo" | "references">, addr = intakeAddressSetting()): string[] {
  if (!addr) return [];
  const refs = Array.isArray(parsed.references) ? parsed.references.join(" ") : String(parsed.references ?? "");
  const ordered = [String(parsed.inReplyTo ?? ""), ...refs.split(/\s+/).reverse()].join(" ");
  const out: string[] = [];
  for (const m of ordered.matchAll(REPLY_REF_RE)) {
    const projectId = m[1].toLowerCase();
    if (m[2].toLowerCase() === addr.domain && !out.includes(projectId)) out.push(projectId);
  }
  return out;
}

const ADDRESS_RE = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+/g;

/** A header as plain text, whatever shape mailparser gave it (a string, an address object, a
 *  structured { value } header, or an array of those when the header repeats). */
function flatHeader(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(flatHeader).join(" ");
  if (typeof v === "object") {
    const o = v as { text?: unknown; value?: unknown };
    return o.text != null ? String(o.text) : flatHeader(o.value);
  }
  return String(v);
}
function headerText(parsed: ParsedMail, name: string): string {
  return flatHeader(parsed.headers?.get(name) as unknown);
}

/** Each occurrence of a repeated header, in message order (top first), as plain text. */
function headerValues(parsed: ParsedMail, name: string): string[] {
  const v = parsed.headers?.get(name) as unknown;
  return (v == null ? [] : Array.isArray(v) ? v : [v]).map(flatHeader).filter((t) => t.trim());
}

/** Every address the message was delivered to: To, Cc, and the Delivered-To / X-Original-To a
 *  server adds (the only trace of a Bcc). */
export function messageRecipients(parsed: ParsedMail): string[] {
  const out: string[] = [];
  for (const field of [parsed.to, parsed.cc]) {
    for (const obj of field ? (Array.isArray(field) ? field : [field]) : []) {
      for (const a of obj.value ?? []) if (a.address) out.push(a.address);
    }
  }
  for (const name of ["delivered-to", "x-original-to"]) out.push(...(headerText(parsed, name).match(ADDRESS_RE) ?? []));
  return out.map((a) => a.toLowerCase());
}

/** Is this parsed message addressed to the intake address? */
export function isIntakeMessage(parsed: ParsedMail): boolean {
  return intakeTagFrom(messageRecipients(parsed)) !== null;
}

// ---------------------------------------------------------------------------
// Client and sender.
// ---------------------------------------------------------------------------

export interface IntakeClient {
  id: string; org_id: string; company_name: string;
  contact_email: string; business_email: string; updates_inbox: string; billing_contact_email: string; intake_senders: string;
}
type ClientRow = IntakeClient;

/** The client with this id IN THIS ORG, else null (rule 6: a person's choice of client never
 *  reaches across orgs — "File under client" and the bulk job-folder drop both ask this). */
export function intakeClientInOrg(db: AppDb, clientId: string, orgId: string): IntakeClient | null {
  return db.get<IntakeClient>(
    "SELECT id, org_id, company_name, contact_email, business_email, updates_inbox, billing_contact_email, intake_senders FROM clients WHERE id = ? AND org_id = ?",
    [String(clientId || ""), orgId],
  ) ?? null;
}

function clientsForTag(db: AppDb, tag: string, opts: IntakeOptions): ClientRow[] {
  const sql = "SELECT id, org_id, company_name, contact_email, business_email, updates_inbox, billing_contact_email, intake_senders FROM clients WHERE intake_tag = ?";
  return opts.restrictToOrg
    ? db.query<ClientRow>(`${sql} AND org_id = ?`, [tag, opts.sourceOrgId || DEFAULT_ORG_ID])
    : db.query<ClientRow>(sql, [tag]);
}

/** The client's own addresses plus its intake_senders entries ("@domain" allows a whole domain). */
export function senderIsKnown(client: Pick<ClientRow, "contact_email" | "business_email" | "updates_inbox" | "billing_contact_email" | "intake_senders">, sender: string): boolean {
  const from = sender.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(from)) return false;
  const entries = [client.contact_email, client.business_email, client.updates_inbox, client.billing_contact_email, ...String(client.intake_senders || "").split(/[\s,;]+/)]
    .map((e) => String(e || "").trim().toLowerCase())
    .filter(Boolean);
  const domain = from.slice(from.lastIndexOf("@"));
  return entries.some((e) => (e.startsWith("@") ? e === domain : e === from));
}


// ---------------------------------------------------------------------------
// Attachments.
// ---------------------------------------------------------------------------

export interface WorkingFile extends EmailIntakeFile {
  content: Buffer;
  kind: string;
  pdfText: string;
}

/** One file handed to the per-job pipeline: an email's attachment, or a file in one job folder of
 *  a bulk drop (#538). Only its name and bytes: nothing else about where it came from is read. */
export interface IntakeJobFile { filename?: string; content: Buffer | Uint8Array }

function maxFileBytes(): number {
  const mb = Number(process.env.EMAIL_INTAKE_MAX_FILE_MB || 100);
  return (Number.isFinite(mb) && mb > 0 ? mb : 100) * 1024 * 1024;
}

/** The message's real attachments: an inline image a signature or a quoted reply embeds
 *  (cid:, multipart/related) is part of the body, not a file the installer sent. */
function realAttachments(parsed: ParsedMail): Attachment[] {
  return (parsed.attachments ?? []).filter((a) => !(a.related || (a.contentDisposition === "inline" && a.cid && /^image\//i.test(a.contentType || ""))));
}

async function pdfTextOf(content: Buffer): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "email-intake-"));
  try {
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, content);
    return await extractPdfText(file, 60);
  } catch {
    return ""; // an encrypted or broken PDF reads as a scan: kept, never parsed
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Sniff, refuse what no slot can take, read each PDF's text, and give every usable file a slot. */
async function sortAttachments(attachments: IntakeJobFile[]): Promise<WorkingFile[]> {
  const files: WorkingFile[] = [];
  for (const [i, a] of attachments.entries()) {
    const name = (a.filename || `attachment-${i + 1}`).trim().slice(0, 200);
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? []);
    const kind = sniffFileKind(content);
    const f: WorkingFile = { name, size: content.length, content, kind, pdfText: "" };
    if (i >= MAX_FILES) f.refused = `More than ${MAX_FILES} files in one job; send the rest separately.`;
    else if (!content.length) f.refused = "The file is empty.";
    else if (content.length > maxFileBytes()) f.refused = `Larger than ${Math.round(maxFileBytes() / 1024 / 1024)} MB.`;
    else if (looksLikeCad(name, kind)) f.refused = "A CAD drawing, not a submittable document: export the plan set to PDF and send that.";
    else if (kind !== "pdf" && !isImageKind(kind)) f.refused = `${describeKind(kind, name)}, not a PDF or a photo.`;
    else if (kind === "pdf") f.pdfText = await pdfTextOf(content);
    files.push(f);
  }
  const usable = files.filter((f) => !f.refused);
  const base = (f: WorkingFile) => path.basename(f.name, path.extname(f.name));
  for (const f of usable) {
    if (/meter/i.test(base(f)) && !/bill|statement/i.test(base(f))) f.docType = "meter_photo";
    else if (f.kind === "pdf" ? classifyDoc(f.name, f.pdfText) === "utility_bill" : /bill|statement|invoice|account/i.test(base(f))) f.docType = "utility_bill";
    else if (f.kind === "pdf" && /struct|engineer|stamp|letter|calc/i.test(base(f))) f.docType = "structural_letter";
  }
  // THE PLAN SET is the PDF with the most text among those not yet placed (a scan has none: then
  // the largest one). Every other PDF is kept as "other"; an image nobody named stays a "photo" —
  // guessing a photo is the bill would hand a meter shot to the bill reader.
  const pdfs = usable.filter((f) => f.kind === "pdf" && !f.docType);
  const plan = pdfs.sort((a, b) => b.pdfText.length - a.pdfText.length || b.size - a.size)[0];
  if (plan) plan.docType = "plan_set";
  for (const f of usable) if (!f.docType) f.docType = f.kind === "pdf" ? "other" : "photo";
  return files;
}

// ---------------------------------------------------------------------------
// The parse → project payload.
// ---------------------------------------------------------------------------

/** THE FIELDS THE PARSER PAGE SAVES from a model read: its LLM_SNAPSHOT_KEYS and the keys of its
 *  LLM_FIELD_TARGETS (frontend/parser.html; emailIntake.test fails when the two drift). An
 *  ALLOWLIST, as the page's is: a key the model invents — "client_id", say, from a plan set that
 *  tries to steer it — never reaches createProject (rule 6), and the contractor block (a client
 *  suggestion on the page) and structureDescription (a person's answer there) are not in it. */
export const PARSER_PROJECT_FIELDS: ReadonlySet<string> = new Set([
  "owner", "street", "city", "state", "zip", "ahj", "utility", "account", "meter", "dcKw", "acKw", "interco",
  "moduleMake", "moduleModel", "moduleWattage", "moduleQty", "invMake", "invModel", "invQty", "batteryMake",
  "batteryModel", "batteryQty", "batteryCapacityKwh", "batteryOutputKw", "essInverterModel", "essBreaker", "batteryMode",
  "newModulesOnSchedule", "newModulesOnSld", "roofMaterial", "mounting", "rackingSystem", "roofRafterSpan", "invOutputW",
  "pvMicroMake", "pvMicroModel", "pvMicroQty", "pvMicroOutputW", "inverterSettings", "moduleVoc",
  "moduleIsc", "moduleVocTempCoeff", "pvMicroMaxDcInputV", "modulesPerString", "siteLowTempC",
  "dwellingUnits", "constructionCategory", "invMaxDcInputV", "siteHighTempC", "acConductor",
  "acConductorCount", "acRunLengthFt", "roofMaterialSubtype", "tileAttachmentMethod", "attachmentHardware",
  "busRating", "mainBreaker", "pvBreaker", "acDiscReq", "acDiscMakeModel", "acDiscQty", "acDiscAmps",
  "acDiscFused", "acDiscVoltage", "snow", "deadLoad", "roofRafterSpacing", "roofRafterSize", "woodGrade", "wind", "permitPath", "windSpeed",
  "riskCategory", "lightFrame", "framingType", "roofLayers", "moduleHeightAboveRoof", "gravityWindDesign",
  "manufacturerInstallation", "rafterExceptionCompliant", "moduleFiguresCompliant", "attachmentToFraming",
  "attachmentSpacingIn", "attachmentEdgeSpacingIn", "attachmentsOutsideEdgeZone",
  "standingSeamMethod2Compliant", "moduleListingAgency", "existingSystem", "existingDcKw", "existingAcKw",
  "existingModuleMake", "existingModuleModel", "existingModuleQty", "existingInvMake", "existingInvModel",
  "existingInvQty", "combinedDcKw", "combinedAcKw", "utilitySchedule", "serviceVoltage", "servicePhase",
  "numberOfCircuits", "parcelNumber", "jobValue", "homeownerEmail", "homeownerPhone", "statedValuation",
  "azimuth", "tilt", "roofSlope", "mainServiceRating", "pvArrays", "stampRecommendation",
  "electricalCalcText", "structuralCalcText", "sitePlanNotesText", "roofPlanNotesText", "labelsText",
  "projectDescriptionText", "locateCalloutText",
]);

/** Every confident extracted value the Parser page would save, keyed by its own field ids
 *  (normalizeProject reads them). Low-confidence fields are left out and returned as `unsure`. */
export function payloadFromExtraction(extraction: Pick<ParserExtractionResponse, "fields" | "lowConfidenceFields">): { payload: ParserPayload; unsure: string[] } {
  const payload: ParserPayload = {};
  const unsure: string[] = [];
  const low = new Set(extraction.lowConfidenceFields ?? []);
  for (const [key, field] of Object.entries(extraction.fields ?? {})) {
    if (!PARSER_PROJECT_FIELDS.has(key)) continue;
    const value = field?.value;
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) continue;
    if (low.has(key)) { unsure.push(key); continue; }
    payload[key] = value as ParserPayload[string];
  }
  // The page fills its Racking box from the racking callouts' product (LLM_FIELD_TARGETS), and its
  // save sends that box as `racking`.
  if (payload.rackingSystem != null && payload.racking == null) payload.racking = payload.rackingSystem;
  return { payload, unsure };
}

/** The street line, normalised: what "the same address" compares. */
function streetKey(address: string): string {
  return normalizeTokens(String(address || "").split(",")[0]);
}

function dedupeDays(): number {
  const n = Number(process.env.EMAIL_INTAKE_DEDUPE_DAYS || 30);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

/** The client's project at the same street (and ZIP when both have one) created within the window. */
export function recentProjectAtAddress(db: AppDb, orgId: string, clientId: string, project: Pick<ProjectRecord, "projectAddress" | "zip">): string | null {
  const key = streetKey(project.projectAddress);
  if (!key) return null;
  const since = new Date(Date.now() - dedupeDays() * 86_400_000).toISOString();
  const rows = db.query<Row>(
    `SELECT id, project_address, zip FROM projects
     WHERE org_id = ? AND client_id = ? AND created_at >= ? AND COALESCE(archived_at, '') = ''
     ORDER BY created_at DESC`,
    [orgId, clientId, since],
  );
  const hit = rows.find((r) => sameAddress({ projectAddress: text(r.project_address), zip: text(r.zip) }, project));
  return hit ? text(hit.id) : null;
}

/** The same street, and the same ZIP when both have one: what "the same job" means. */
function sameAddress(a: Pick<ProjectRecord, "projectAddress" | "zip">, b: Pick<ProjectRecord, "projectAddress" | "zip">): boolean {
  const key = streetKey(b.projectAddress);
  const za = String(a.zip || "").trim();
  const zb = String(b.zip || "").trim();
  return Boolean(key) && streetKey(a.projectAddress) === key && (!za || !zb || za === zb);
}

/** The first of the candidate projects that is THIS client's, in THIS org, and not archived (#540). */
function answeredProject(db: AppDb, orgId: string, clientId: string, candidates: string[]): { id: string; projectAddress: string; zip: string } | null {
  for (const candidate of candidates) {
    const row = db.get<Row>(
      "SELECT id, project_address, zip FROM projects WHERE id = ? AND org_id = ? AND client_id = ? AND COALESCE(archived_at, '') = ''",
      [candidate, orgId, clientId],
    );
    if (row) return { id: text(row.id), projectAddress: text(row.project_address), zip: text(row.zip) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Records.
// ---------------------------------------------------------------------------

const REASON_TEXT: Record<EmailIntakeReason, string> = {
  no_tag: "Sent to the intake address without a client tag (intake+<tag>@…), so no client could be chosen.",
  unknown_tag: "No client has this intake tag.",
  ambiguous_tag: "More than one client has this intake tag.",
  unknown_sender: "The sender is not one of this client's addresses. Add it to the client's intake senders if it should be.",
  sender_not_authenticated: "The From address could not be verified: the sender's domain failed its DMARC check, or EMAIL_INTAKE_REQUIRE_AUTH is on and the mail server recorded no passing result for it.",
  no_usable_attachments: "None of the attachments is a PDF or a photo we can use.",
  address_unreadable: "The project address could not be read from the documents (a scanned plan set, or no plan set). Open the files in the Parser.",
  plan_set_names_another_client: "The plan set's licence number belongs to a different client than the tag.",
  failed: "Processing failed; the files are kept here.",
};

function intakeDir(rowId: string): string {
  return path.join(backendDataDir(), "email-intake", rowId);
}

/** The kept raw message (what a re-run reads) and how its poll was scoped (#541). */
const RAW_FILE = "message.eml";
const SOURCE_FILE = "source.json";
interface KeptSource { sourceOrgId: string; restrictToOrg: boolean }

/** Keep an unplaced message whole, so "File under client" and "Retry" re-run the real pipeline on
 *  the real headers (authentication results included), not on a reconstruction. */
function keepRaw(rowId: string, raw: Buffer, opts: IntakeOptions): void {
  const dir = intakeDir(rowId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, RAW_FILE), raw);
  const source: KeptSource = { sourceOrgId: opts.sourceOrgId || DEFAULT_ORG_ID, restrictToOrg: Boolean(opts.restrictToOrg) };
  fs.writeFileSync(path.join(dir, SOURCE_FILE), JSON.stringify(source));
}

function hasRaw(rowId: string): boolean {
  return fs.existsSync(path.join(intakeDir(rowId), RAW_FILE));
}

/** Reasons a person can place by choosing the client (the rest need different files, or a Retry). */
const FILEABLE_REASONS: ReadonlySet<string> = new Set<EmailIntakeReason>([
  "no_tag", "unknown_tag", "ambiguous_tag", "unknown_sender", "sender_not_authenticated", "plan_set_names_another_client",
]);
/** Reasons a person's "File under client" overrides only when it is the row's OWN reason: each is a
 *  check the person must have seen named before vouching past it. */
const OVERRIDABLE_ONLY_WHEN_SEEN: ReadonlySet<string> = new Set<EmailIntakeReason>(["sender_not_authenticated", "plan_set_names_another_client"]);

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "file";
}

interface StoredFile extends EmailIntakeFile { stored?: string }

function mapRow(row: Row): EmailIntakeView {
  let files: StoredFile[] = [];
  try { files = JSON.parse(text(row.files_json) || "[]"); } catch { files = []; }
  const reason = text(row.reason) as EmailIntakeReason | "";
  const rerunnable = text(row.status) === "unsorted" && hasRaw(text(row.id));
  return {
    id: text(row.id),
    status: text(row.status) as EmailIntakeStatus,
    reason,
    reasonText: reason ? REASON_TEXT[reason] ?? reason : "",
    sender: text(row.sender),
    intakeTag: text(row.intake_tag),
    subject: text(row.subject),
    clientId: text(row.client_id) || null,
    projectId: text(row.project_id) || null,
    files: files.map(({ stored: _stored, ...f }) => f),
    replyStatus: text(row.reply_status),
    receivedAt: text(row.received_at),
    createdAt: text(row.created_at),
    canFile: rerunnable && FILEABLE_REASONS.has(reason),
    canRetry: rerunnable && reason === "failed",
  };
}

function insertRow(db: AppDb, row: {
  id: string; key: string; orgId: string; clientId: string | null; projectId: string | null; status: EmailIntakeStatus;
  reason: EmailIntakeReason | ""; sender: string; tag: string; subject: string; files: StoredFile[]; replyStatus: string; receivedAt: string;
}): EmailIntakeView {
  db.run(
    `INSERT INTO email_intake_messages
       (id, message_key, org_id, client_id, project_id, status, reason, sender, intake_tag, subject, files_json, reply_status, received_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.key, row.orgId, row.clientId, row.projectId, row.status, row.reason, row.sender.slice(0, 320), row.tag.slice(0, 80),
      row.subject.slice(0, 240), JSON.stringify(row.files), row.replyStatus, row.receivedAt, nowIso()],
  );
  return mapRow(db.get<Row>("SELECT * FROM email_intake_messages WHERE id = ?", [row.id])!);
}

/** A re-run (#541) writes its outcome onto the message's existing row: the key stays, so the poll
 *  still never reads the message again. */
function updateRow(db: AppDb, row: {
  id: string; orgId: string; clientId: string | null; projectId: string | null; status: EmailIntakeStatus;
  reason: EmailIntakeReason | ""; files: StoredFile[]; replyStatus: string;
}): EmailIntakeView {
  const placed = row.status === "created" || row.status === "attached";
  db.run(
    `UPDATE email_intake_messages SET org_id = ?, client_id = ?, project_id = ?, status = ?, reason = ?, files_json = ?, reply_status = ?, resolved_at = ?
     WHERE id = ?`,
    [row.orgId, row.clientId, row.projectId, row.status, row.reason, JSON.stringify(row.files), row.replyStatus, placed ? nowIso() : "", row.id],
  );
  return mapRow(db.get<Row>("SELECT * FROM email_intake_messages WHERE id = ?", [row.id])!);
}

/** Keep an unplaced message's attachments for the person who will place it. */
function keepFiles(rowId: string, attachments: Attachment[], working: WorkingFile[] | null): StoredFile[] {
  if (!attachments.length) return [];
  const dir = intakeDir(rowId);
  fs.mkdirSync(dir, { recursive: true });
  return attachments.slice(0, MAX_FILES).map((a, i) => {
    const w = working?.[i];
    const name = w?.name ?? (a.filename || `attachment-${i + 1}`).slice(0, 200);
    const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? []);
    const out: StoredFile = { name, size: content.length, ...(w?.docType ? { docType: w.docType } : {}), ...(w?.refused ? { refused: w.refused } : {}) };
    if (content.length && content.length <= maxFileBytes()) {
      const stored = path.join(dir, `${i + 1}-${safeName(name)}`);
      fs.writeFileSync(stored, content);
      out.stored = stored;
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// The reply.
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  owner: "Homeowner name", street: "Project address", city: "City", state: "State", zip: "ZIP", ahj: "Permitting jurisdiction (AHJ)",
  utility: "Utility", account: "Utility account number", meter: "Meter number", dcKw: "System size (DC kW)", acKw: "System size (AC kW)",
  moduleMake: "Module make", moduleModel: "Module model", moduleQty: "Module count", invMake: "Inverter make", invModel: "Inverter model",
  moduleWattage: "Module wattage", invQty: "Inverter count", invOutputW: "Inverter output (W)",
  batteryMake: "Battery make", batteryModel: "Battery model", batteryQty: "Battery count",
  pvMicroMake: "Microinverter make", pvMicroModel: "Microinverter model", pvMicroQty: "Microinverter count",
  roofMaterial: "Roof material", roofMaterialSubtype: "Roof material type", mounting: "Mounting type", rackingSystem: "Racking system",
  roofRafterSpan: "Rafter span", roofRafterSpacing: "Rafter spacing", roofRafterSize: "Rafter size", woodGrade: "Lumber grade", roofLayers: "Roof layers", framingType: "Roof framing type",
  interco: "Interconnection method", busRating: "Main panel bus rating (A)", mainBreaker: "Main breaker (A)", pvBreaker: "PV breaker (A)",
  snow: "Snow load", wind: "Wind speed", windSpeed: "Wind speed", existingSystem: "Existing solar system",
};

/** A field's name in words for a client email. Every key has one: the table above, else the key
 *  itself split at its capitals ("acRunLengthFt" -> "Ac run length ft"), never the raw camelCase
 *  name (an intake reply once asked a client to double-check "roofMaterial"). */
export function intakeFieldLabel(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(key);
}

export function intakeReplyEmail(input: {
  project: ProjectRecord; attached: boolean; link: string; missing: string[]; unsure: string[]; refused: EmailIntakeFile[];
  /** Every secret value to scrub (projectSecretValuesById plus the read's own secret fields). */
  secrets: string[];
}): { subject: string; body: string; html: string } {
  const address = formatProjectAddress(input.project) || "your job";
  const sections: EmailSection[] = [];
  if (input.missing.length) sections.push({ heading: "Still needed — reply with these, or send them in a new email to the same address", items: input.missing });
  if (input.unsure.length) sections.push({ heading: "We will double-check these against your documents before anything is filed", items: input.unsure });
  if (input.refused.length) sections.push({ heading: "Files we could not use", items: input.refused.map((f) => `${f.name}: ${f.refused}`) });
  const content: EmailContent = {
    audience: "client",
    preheader: input.attached
      ? `We received your email for ${address} and added the files to the project.`
      : `We received your email for ${address} and started a new project for it.`,
    eyebrow: "Files received",
    headline: input.attached ? "Files added to your project" : "New project started",
    greeting: "Hello,",
    intro: [input.attached
      ? `We received your email for ${address} and added the files to the project we already have for that address.`
      : `We received your email for ${address} and started a new project for it.`],
    sections,
    action: { label: "View live status", textLabel: "Live status page (no login needed)", url: input.link },
    signoff: ["Thank you,", BRAND],
  };
  const secrets = [...input.secrets, String(input.project.accountNumber ?? ""), String(input.project.meterNumber ?? "")];
  // Both parts from the SCRUBBED content (rule 2), and the text twin once more whole, as before.
  const { text: body, html } = renderEmail(mapEmailText(content, (s) => redactSecretValues(s, secrets)));
  return {
    subject: redactSecretValues(`Received: ${address}`, secrets),
    body: redactSecretValues(body, secrets),
    html,
  };
}

function autoReplyOff(clientId: string | null | undefined): string {
  if (/^(0|false|off)$/i.test(String(process.env.EMAIL_INTAKE_AUTO_REPLY ?? "").trim())) return "EMAIL_INTAKE_AUTO_REPLY is off, so no send was attempted.";
  if (clientEmailsOffFor(clientId)) return "CLIENT_NOTIFICATIONS is off, so no send was attempted.";
  return "";
}

const sendWithLayout: IntakeSender = (to, subject, body, html, headers) => sendEmail(to, subject, body, [], { html, ...headers });

async function reply(db: AppDb, input: { project: ProjectRecord; orgId: string; to: string; subject: string; body: string; html: string; headers: IntakeReplyHeaders; draftOnly?: string }, opts: IntakeOptions): Promise<string> {
  let status: "sent" | "draft" | "failed" = "draft";
  let detail = input.draftOnly || autoReplyOff(input.project.clientId);
  // NO DEAD LINK TO A CLIENT (clientLinkGuard.ts): the other dead bases, and a scan of the reply's links.
  const linkRefusal = clientLinkRefusal({ body: input.body, html: input.html });
  if (detail) { /* stays a draft */ }
  else if (!String(process.env.PUBLIC_BASE_URL ?? "").trim()) detail = "PUBLIC_BASE_URL is not set, so the status link would point at this machine; nothing was sent.";
  // NO DEAD LINK TO A CLIENT (clientLinkGuard.ts): the other dead bases, and a scan of the reply's links.
  else if (linkRefusal) detail = linkRefusal;
  else if (!opts.send && !smtpConfigured()) detail = "SMTP is not configured (SMTP_HOST / SMTP_FROM are unset), so no send was attempted.";
  else {
    try { await (opts.send ?? sendWithLayout)(input.to, input.subject, input.body, input.html, input.headers); status = "sent"; }
    catch (err) { status = "failed"; detail = err instanceof Error ? err.message : String(err); }
  }
  addCommunication(db, {
    projectId: input.project.id, direction: "outbound", channel: "email", subject: input.subject, body: input.body,
    loggedBy: `${ACTOR} (automated)`, deliveryStatus: status, deliveryDetail: detail, recipient: input.to, orgId: input.orgId,
  });
  if (status !== "sent") logger.warn("email-intake", `reply ${status} for project ${input.project.id}: ${detail}`);
  return status;
}

// ---------------------------------------------------------------------------
// One message.
// ---------------------------------------------------------------------------

function messageKey(parsed: ParsedMail, raw: Buffer): string {
  const mid = String(parsed.messageId || "").trim().toLowerCase();
  return mid ? `mid:${mid}` : `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

function defaultExtractor(db: AppDb): IntakeExtractor {
  return async (input, orgId) => {
    const { createLLMProvider } = await import("./llm");
    const { extractParserFields } = await import("./parserExtraction");
    return extractParserFields(db, createLLMProvider(), input, orgId);
  };
}

const MISSING_DOCS: Array<[string, string]> = [["plan_set", "The plan set (PDF)"], ["utility_bill", "The customer's utility bill (PDF or photo)"]];
const IDENTITY_FIELDS: Array<[keyof ProjectRecord, string]> = [
  ["homeownerName", "Homeowner name"], ["utility", "Utility"], ["ahj", "Permitting jurisdiction (AHJ)"], ["systemSizeDcKw", "System size (DC kW)"],
];

/** What the per-job pipeline did with one job's files. */
export type IntakeJobPlacement =
  | { outcome: "unsorted"; reason: Extract<EmailIntakeReason, "no_usable_attachments" | "address_unreadable" | "plan_set_names_another_client">; files: WorkingFile[] }
  | {
    outcome: "created" | "attached"; projectId: string; project: ProjectRecord; files: WorkingFile[];
    extraction: ParserExtractionResponse | null; unsure: string[]; missing: string[]; refused: EmailIntakeFile[];
    /** Attached because the message is a reply to this project's acknowledgement (#540). */
    viaReply: boolean;
  };

/**
 * THE PER-JOB PIPELINE: one job's files, for a client already decided, become a project (or are
 * attached to the same job sent again). Email intake calls it once per message, after the tag, the
 * sender and its authentication have chosen the client; the bulk job-folder drop (#538) calls it
 * once per folder with the client a person chose. ONE pipeline, so the two doors slot, read, dedupe
 * and create alike:
 *   slot the files (sortAttachments) → read the documents' text only (rule 2) → a plan set licensed
 *   to another client stays unsorted → no address stays unsorted → the same address for the same
 *   client within EMAIL_INTAKE_DEDUPE_DAYS attaches, else createProject → save each document →
 *   enqueueStageSteps (the local chain, which stops at ready_to_stage: nothing here touches a portal).
 * The org is the client's (rule 6) and nothing the files say changes it. Throws only on a failure
 * the caller records as `failed`.
 */
export async function placeIntakeJob(db: AppDb, input: {
  client: IntakeClient;
  files: IntakeJobFile[];
  extract?: IntakeExtractor;
  /** Who the documents and audit name: "email intake", or the person who filed or dropped them. */
  uploadedBy: string;
  /** project_documents.source: "email_intake" or "bulk_drop". */
  source: string;
  /** A person already saw "the plan set's licence names another client" and vouched past it (#541). */
  otherLicenceVouched?: boolean;
  /** The projects the message says it answers (answeredProjectIds, #540): candidates only, each
   *  held here to this client and its org. */
  answersProjectIds?: string[];
}): Promise<IntakeJobPlacement> {
  const { client } = input;
  const orgId = client.org_id || DEFAULT_ORG_ID;
  const files = await sortAttachments(input.files);
  const usable = files.filter((f) => !f.refused);
  if (!usable.length) return { outcome: "unsorted", reason: "no_usable_attachments", files };

  // THE PARSE: the documents' own text only — never the email body (rule 2).
  const textOf = (docType: string) => usable.find((f) => f.docType === docType)?.pdfText ?? "";
  const texts = { planText: textOf("plan_set"), utilityBillText: textOf("utility_bill"), structuralLetterText: textOf("structural_letter") };
  let extraction: ParserExtractionResponse | null = null;
  if (texts.planText.trim() || texts.utilityBillText.trim() || texts.structuralLetterText.trim()) {
    extraction = await (input.extract ?? defaultExtractor(db))(texts, orgId);
  }
  const resolution = extraction?.clientResolution;
  if (resolution?.decision === "auto_assign" && resolution.clientId && resolution.clientId !== client.id
    && !input.otherLicenceVouched) {
    return { outcome: "unsorted", reason: "plan_set_names_another_client", files };
  }
  const { payload, unsure } = extraction ? payloadFromExtraction(extraction) : { payload: {} as ParserPayload, unsure: [] };
  const probe = normalizeProject("probe", payload);

  // A REPLY TO THIS JOB'S ACKNOWLEDGEMENT (#540) attaches to it: a project of THIS client in THIS
  // org (rule 6), not archived, and only when the files read no street or the same street — a
  // different address sent as a reply is a different job and takes the normal path below.
  const answered = answeredProject(db, orgId, client.id, input.answersProjectIds ?? []);
  const replyTarget = answered && (!streetKey(probe.projectAddress) || sameAddress(answered, probe)) ? answered.id : null;
  const viaReply = replyTarget !== null;
  if (!viaReply && !probe.projectAddress.trim()) return { outcome: "unsorted", reason: "address_unreadable", files };

  // CREATE, or ATTACH to the same job sent again.
  const existingId = replyTarget ?? recentProjectAtAddress(db, orgId, client.id, probe);
  let projectId: string;
  if (existingId) {
    projectId = existingId;
  } else {
    projectId = createProject(db, { ...payload, clientId: client.id }, orgId).project.id;
  }
  const existingDocs = new Set(
    db.query<Row>("SELECT doc_type, original_filename, size_bytes FROM project_documents WHERE project_id = ?", [projectId])
      .map((d) => `${text(d.doc_type)}|${text(d.original_filename)}|${Number(d.size_bytes)}`),
  );
  for (const f of usable) {
    if (existingDocs.has(`${f.docType}|${f.name}|${f.size}`)) continue;
    try {
      saveProjectDocument(db, projectId, { filename: f.name, docType: f.docType, contentType: f.kind === "pdf" ? "application/pdf" : `image/${f.kind}`, buffer: f.content, source: input.source, uploadedBy: input.uploadedBy });
    } catch (err) {
      // The same door as an upload refuses it; it is reported, and the others still go on.
      f.refused = err instanceof HttpError || err instanceof Error ? err.message : String(err);
    }
  }
  // The chain is queued after the files are on the project, so its first step sees the plan set.
  try { enqueueStageSteps(db, projectId); } catch { /* the chain is a convenience, not the intake */ }

  const project = getProjectDetail(db, projectId).project;
  const docTypes = new Set(db.query<Row>("SELECT doc_type FROM project_documents WHERE project_id = ?", [projectId]).map((d) => text(d.doc_type)));
  const missing = [
    ...IDENTITY_FIELDS.filter(([k]) => project[k] == null || String(project[k]).trim() === "").map(([, label]) => label),
    ...MISSING_DOCS.filter(([t]) => !docTypes.has(t)).map(([, label]) => label),
  ];
  const refused = files.filter((f) => f.refused).map(({ name, size, refused: why }) => ({ name, size, refused: why }));
  return { outcome: existingId ? "attached" : "created", projectId, project, files, extraction, unsure, missing, refused, viaReply };
}

/** A person's re-run of one kept message (#541). */
interface Rerun {
  rowId: string;
  /** The client a person chose ("File under client …"): stands in for the tag and the sender check. */
  client?: ClientRow;
  /** The row's own reason, when it is one a person may vouch past (OVERRIDABLE_ONLY_WHEN_SEEN). */
  overridden?: EmailIntakeReason;
  by: string;
}

async function processOne(db: AppDb, raw: Buffer, opts: IntakeOptions, result: EmailIntakeRunResult, rerun?: Rerun): Promise<void> {
  const { simpleParser } = await import("mailparser");
  const parsed = await simpleParser(raw);
  const recipientTag = intakeTagFrom(messageRecipients(parsed));
  if (recipientTag === null && !rerun) return; // not intake mail: never ours
  const tag = recipientTag ?? "";
  result.scanned += 1;
  const key = messageKey(parsed, raw);
  if (!rerun && db.get("SELECT id FROM email_intake_messages WHERE message_key = ?", [key])) { result.skippedDuplicates += 1; return; }

  const rowId = rerun?.rowId ?? id();
  const sender = String(parsed.from?.value?.[0]?.address || "").trim().toLowerCase();
  const subject = String(parsed.subject || "").trim();
  const receivedAt = parsed.date ? parsed.date.toISOString() : nowIso();
  const attachments = realAttachments(parsed);
  const base = { id: rowId, key, sender, tag, subject, receivedAt, replyStatus: "" };

  const unsorted = (reason: EmailIntakeReason, orgId: string, clientId: string | null, working: WorkingFile[] | null): void => {
    // A message with nothing attached is recorded (so it is never re-read) but never listed: the
    // unsorted list is for jobs a person can place, not for every stray email to the address.
    const status: EmailIntakeStatus = attachments.length ? "unsorted" : "ignored";
    const files = keepFiles(rowId, attachments, working);
    if (status === "unsorted" && !rerun) keepRaw(rowId, raw, opts);
    const fields = { orgId, clientId, projectId: null, status, reason, files };
    const item = rerun ? updateRow(db, { ...fields, id: rowId, replyStatus: "" }) : insertRow(db, { ...base, ...fields });
    if (status === "unsorted") { result.unsorted += 1; result.items.push(item); }
    logger.info("email-intake", `message ${status}: ${reason}`, { tag, files: attachments.length });
    // THE ALERT (#541): once, when the poll lands it. A person's own re-run is already in front of them.
    if (status === "unsorted" && !rerun) void alertStaffOnUnsortedIntake(db, { orgId, intakeId: rowId, from: sender, receivedAt, reason, files: attachments.length });
  };

  const sourceOrg = opts.sourceOrgId || DEFAULT_ORG_ID;
  let client: ClientRow;
  if (rerun?.client) {
    // A PERSON CHOSE THE CLIENT: that answers which client this is and whether this sender sends
    // for it. fileEmailIntake already held the choice to the message's own org (rule 6).
    client = rerun.client;
  } else {
    if (!tag) return unsorted("no_tag", sourceOrg, null, null);
    const clients = clientsForTag(db, tag, opts);
    if (!clients.length) return unsorted("unknown_tag", sourceOrg, null, null);
    if (clients.length > 1) return unsorted("ambiguous_tag", sourceOrg, null, null);
    client = clients[0];
  }
  const orgId = client.org_id || DEFAULT_ORG_ID;
  const knownSender = senderIsKnown(client, sender);
  if (!knownSender && !rerun?.client) return unsorted("unknown_sender", orgId, client.id, null);
  // A stated DMARC fail always refuses; with EMAIL_INTAKE_REQUIRE_AUTH on, so does the absence of a
  // pass in the topmost Authentication-Results header (intakeAuth.ts says why the topmost only).
  // A person's re-run vouches past it only when it is the reason they were shown.
  const authRefusal = intakeAuthRefusal(headerValues(parsed, "authentication-results"), sender);
  const authOverridden = Boolean(authRefusal) && rerun?.overridden === "sender_not_authenticated";
  if (authRefusal && !authOverridden) {
    logger.info("email-intake", `sender authentication: ${authRefusal}`, { tag });
    return unsorted("sender_not_authenticated", orgId, client.id, null);
  }

  const placed = await placeIntakeJob(db, {
    client, files: attachments, extract: opts.extract, uploadedBy: rerun ? rerun.by : ACTOR, source: "email_intake",
    otherLicenceVouched: rerun?.overridden === "plan_set_names_another_client",
    answersProjectIds: answeredProjectIds(parsed),
  });
  if (placed.outcome === "unsorted") return unsorted(placed.reason, orgId, client.id, placed.files);
  const { projectId, project, files, extraction, unsure, missing, refused, viaReply } = placed;
  const existingId = placed.outcome === "attached" ? projectId : null;
  // A sender only a PERSON vouched for (not one of the client's own addresses, or one whose mail
  // failed authentication) never gets an automatic reply: it is a draft a person sends.
  const draftOnly = !knownSender || authOverridden
    ? "Filed by a person for a sender that intake could not verify, so the reply is a draft for a person to send."
    : "";
  // THE SCRUB FAILS CLOSED (rule 2): the reply is written only when the project's own secret values
  // could be read (projectSecretValuesById); the read's secret fields are added, so even a value
  // too unsure to be written to the project is never echoed.
  const projectSecrets = projectSecretValuesById(db, projectId);
  let replyStatus = "withheld";
  if (projectSecrets === null) {
    logger.warn("email-intake", `reply withheld for project ${projectId}: its secret values could not be read to scrub it`);
  } else {
    const readSecrets = Object.entries(extraction?.fields ?? {})
      .filter(([k, f]) => isPlannerSecretKey(k) && (typeof f?.value === "string" || typeof f?.value === "number"))
      .map(([, f]) => String(f.value));
    const email = intakeReplyEmail({
      project, attached: Boolean(existingId), link: statusShareUrl(ensureStatusShareToken(db, projectId)),
      missing, unsure: unsure.map((k) => intakeFieldLabel(k)), refused, secrets: [...projectSecrets, ...readSecrets],
    });
    // THE WAY BACK (#540): a Reply goes to intake+<this client's tag>@… and names this project.
    const replyTo = intakeReplyToAddress(db, client.id);
    const messageId = intakeReplyMessageId(projectId);
    const headers: IntakeReplyHeaders = { ...(replyTo ? { replyTo } : {}), ...(messageId ? { messageId } : {}) };
    replyStatus = await reply(db, { project, orgId, to: sender, ...email, headers, draftOnly }, opts);
  }

  const status: EmailIntakeStatus = existingId ? "attached" : "created";
  const placedFiles = files.map(({ name, size, docType, refused: why }) => ({ name, size, ...(why ? { refused: why } : { docType }) }));
  const fields = { orgId, clientId: client.id, projectId, status, reason: "" as const, replyStatus, files: placedFiles };
  const item = rerun ? updateRow(db, { ...fields, id: rowId }) : insertRow(db, { ...base, ...fields });
  // Placed: the files are on the project now, so the kept copies (and the raw message) go.
  if (rerun) fs.rmSync(intakeDir(rowId), { recursive: true, force: true });
  addAuditLog(db, projectId, rerun ? "human" : "system", rerun ? rerun.by : ACTOR, existingId ? "project.files_attached_from_email" : "project.created_from_email", {
    intakeId: rowId, files: item.files.map((f) => ({ docType: f.docType ?? null, refused: Boolean(f.refused) })), unsure, missing: missing.length, reply: replyStatus,
    ...(viaReply ? { matchedBy: "reply" } : {}),
    ...(rerun ? { placedBy: rerun.by, clientChosenByPerson: Boolean(rerun.client), overridden: rerun.overridden ?? null } : {}),
  });
  if (existingId) result.attached += 1; else result.created += 1;
  result.items.push(item);
}

/** Process raw RFC822 messages. Messages not addressed to the intake address are ignored. Never
 *  throws: a message that fails is recorded unsorted (reason "failed") with its files kept. */
export async function processIntakeMessages(db: AppDb, raws: Buffer[], opts: IntakeOptions = {}): Promise<EmailIntakeRunResult> {
  const result: EmailIntakeRunResult = { scanned: 0, created: 0, attached: 0, unsorted: 0, skippedDuplicates: 0, items: [] };
  if (!intakeEnabled()) return result;
  for (const raw of raws) {
    try {
      await processOne(db, raw, opts, result);
    } catch (err) {
      logger.warn("email-intake", `message failed: ${err instanceof Error ? err.message : String(err)}`);
      try {
        const { simpleParser } = await import("mailparser");
        const parsed = await simpleParser(raw);
        const key = messageKey(parsed, raw);
        if (!db.get("SELECT id FROM email_intake_messages WHERE message_key = ?", [key])) {
          const rowId = id();
          const orgId = opts.sourceOrgId || DEFAULT_ORG_ID;
          const sender = String(parsed.from?.value?.[0]?.address || "").toLowerCase();
          const receivedAt = parsed.date ? parsed.date.toISOString() : nowIso();
          const attachments = realAttachments(parsed);
          const files = keepFiles(rowId, attachments, null);
          keepRaw(rowId, raw, opts); // so a person can Retry it (#541)
          const item = insertRow(db, {
            id: rowId, key, orgId, clientId: null, projectId: null, status: "unsorted", reason: "failed",
            sender, tag: intakeTagFrom(messageRecipients(parsed)) ?? "",
            subject: String(parsed.subject || ""), files, replyStatus: "", receivedAt,
          });
          result.unsorted += 1;
          result.items.push(item);
          void alertStaffOnUnsortedIntake(db, { orgId, intakeId: rowId, from: sender, receivedAt, reason: "failed", files: attachments.length });
        }
      } catch { /* an unparseable message is left for the next poll */ }
    }
  }
  return result;
}

/** Split an MBOX file's text into raw messages (the "From " separator line removed, the
 *  writer's ">From " escape undone). */
export function mboxMessages(mboxText: string): Buffer[] {
  return mboxText.replace(/\r\n/g, "\n")
    .split(/\n(?=From [^\n]*\n)/g)
    .map((m) => m.replace(/^From [^\n]*\n/, "").replace(/\n>From /g, "\nFrom ").trim())
    .filter(Boolean)
    .map((m) => Buffer.from(`${m}\n`, "utf8"));
}

// ---------------------------------------------------------------------------
// The unsorted list (routes).
// ---------------------------------------------------------------------------

/** Unsorted messages waiting on a person, and the most recent ones placed. `orgFilter` null reads
 *  every org (superadmin); a string, one org. */
export function listEmailIntake(db: AppDb, orgFilter: string | null): { enabled: boolean; address: string; unsorted: EmailIntakeView[]; recent: EmailIntakeView[] } {
  const where = orgFilter === null ? "" : " AND org_id = ?";
  const params = orgFilter === null ? [] : [orgFilter];
  const addr = intakeAddressSetting();
  return {
    enabled: Boolean(addr),
    address: addr ? `${addr.local}+<client tag>@${addr.domain}` : "",
    unsorted: db.query<Row>(`SELECT * FROM email_intake_messages WHERE status = 'unsorted'${where} ORDER BY created_at DESC LIMIT 100`, params).map(mapRow),
    recent: db.query<Row>(`SELECT * FROM email_intake_messages WHERE status IN ('created', 'attached')${where} ORDER BY created_at DESC LIMIT 20`, params).map(mapRow),
  };
}

/** The row, or a 404 when it is outside the caller's org (never a 403: rule 6). */
function rowInScope(db: AppDb, intakeId: string, orgFilter: string | null): Row {
  const row = db.get<Row>("SELECT * FROM email_intake_messages WHERE id = ?", [intakeId]);
  if (!row || (orgFilter !== null && text(row.org_id) !== orgFilter)) throw new HttpError(404, "Intake message not found.");
  return row;
}

export function emailIntakeFile(db: AppDb, intakeId: string, index: number, orgFilter: string | null): { path: string; filename: string } {
  const row = rowInScope(db, intakeId, orgFilter);
  let files: StoredFile[] = [];
  try { files = JSON.parse(text(row.files_json) || "[]"); } catch { files = []; }
  const f = files[index];
  const dir = path.resolve(intakeDir(text(row.id)));
  if (!f?.stored || !path.resolve(f.stored).startsWith(dir + path.sep) || !fs.existsSync(f.stored)) throw new HttpError(404, "File not found.");
  return { path: f.stored, filename: f.name };
}

/** A person cleared it: the row stays (so the message is never re-read), its files go. */
export function dismissEmailIntake(db: AppDb, intakeId: string, orgFilter: string | null, by: string): EmailIntakeView {
  const row = rowInScope(db, intakeId, orgFilter);
  if (text(row.status) !== "unsorted") throw new HttpError(409, "Only an unsorted message can be dismissed.");
  db.run("UPDATE email_intake_messages SET status = 'dismissed', resolved_at = ? WHERE id = ?", [nowIso(), text(row.id)]);
  fs.rmSync(intakeDir(text(row.id)), { recursive: true, force: true });
  addAuditLog(db, null, "human", by || "operator", "email_intake.dismissed", { intakeId: text(row.id), reason: text(row.reason) });
  return mapRow(db.get<Row>("SELECT * FROM email_intake_messages WHERE id = ?", [text(row.id)])!);
}

// ---------------------------------------------------------------------------
// File under client / Retry (#541).
// ---------------------------------------------------------------------------

/** One re-run per row at a time. The server is one process (one SQLite connection), so an in-memory
 *  set is the lock; a crash mid-run leaves the row `unsorted`, never hidden in a half state. */
const inFlight = new Set<string>();

async function rerunIntake(
  db: AppDb, row: Row, rerun: Omit<Rerun, "rowId">, action: "filed" | "retried", opts: IntakeOptions,
): Promise<EmailIntakeView> {
  const rowId = text(row.id);
  if (!intakeEnabled()) throw new HttpError(409, "Email-in intake is off (EMAIL_INTAKE_ADDRESS is not set).");
  if (!hasRaw(rowId)) {
    throw new HttpError(409, "This message arrived before re-filing was possible, so it cannot be re-run. Download its files and use the Parser.");
  }
  if (inFlight.has(rowId)) throw new HttpError(409, "This message is already being filed.");
  inFlight.add(rowId);
  const before = { status: text(row.status), reason: text(row.reason), clientId: text(row.client_id) || null };
  try {
    let source: KeptSource = { sourceOrgId: text(row.org_id) || DEFAULT_ORG_ID, restrictToOrg: true };
    try { source = { ...source, ...JSON.parse(fs.readFileSync(path.join(intakeDir(rowId), SOURCE_FILE), "utf8")) }; } catch { /* the row's org, restricted: never wider */ }
    const raw = fs.readFileSync(path.join(intakeDir(rowId), RAW_FILE));
    const result: EmailIntakeRunResult = { scanned: 0, created: 0, attached: 0, unsorted: 0, skippedDuplicates: 0, items: [] };
    try {
      await processOne(db, raw, { ...opts, sourceOrgId: source.sourceOrgId, restrictToOrg: source.restrictToOrg }, result, { ...rerun, rowId });
    } catch (err) {
      logger.warn("email-intake", `re-run failed: ${err instanceof Error ? err.message : String(err)}`);
      db.run("UPDATE email_intake_messages SET status = 'unsorted', reason = 'failed' WHERE id = ?", [rowId]);
    }
    const view = mapRow(db.get<Row>("SELECT * FROM email_intake_messages WHERE id = ?", [rowId])!);
    addAuditLog(db, view.projectId, "human", rerun.by || "operator", `email_intake.${action}`, {
      intakeId: rowId, before, clientId: rerun.client?.id ?? null, overridden: rerun.overridden ?? null,
      outcome: view.status, reason: view.reason, projectId: view.projectId,
    });
    return view;
  } finally {
    inFlight.delete(rowId);
  }
}

/** "File under client …": re-run the message with the client a person chose. The client must be in
 *  the message's own org (rule 6: another org's client, or an unknown id, is a 404). */
export async function fileEmailIntake(
  db: AppDb, intakeId: string, clientId: string, orgFilter: string | null, by: string, opts: IntakeOptions = {},
): Promise<EmailIntakeView> {
  const row = rowInScope(db, intakeId, orgFilter);
  const orgId = text(row.org_id) || DEFAULT_ORG_ID;
  const client = intakeClientInOrg(db, clientId, orgId);
  if (!client) throw new HttpError(404, "Client not found.");
  if (text(row.status) !== "unsorted") throw new HttpError(409, "Only an unsorted message can be filed; this one was already placed or dismissed.");
  const reason = text(row.reason);
  if (!FILEABLE_REASONS.has(reason)) {
    throw new HttpError(409, reason === "failed"
      ? "This message failed while it was processed: use Retry."
      : "Choosing a client does not change this: the files themselves need a person. Download them and use the Parser.");
  }
  const overridden = OVERRIDABLE_ONLY_WHEN_SEEN.has(reason) ? reason as EmailIntakeReason : undefined;
  return rerunIntake(db, row, { client, overridden, by }, "filed", opts);
}

/** "Retry": re-run a message that failed partway, exactly as the poll would have. */
export async function retryEmailIntake(
  db: AppDb, intakeId: string, orgFilter: string | null, by: string, opts: IntakeOptions = {},
): Promise<EmailIntakeView> {
  const row = rowInScope(db, intakeId, orgFilter);
  if (text(row.status) !== "unsorted") throw new HttpError(409, "Only an unsorted message can be retried; this one was already placed or dismissed.");
  if (text(row.reason) !== "failed") throw new HttpError(409, "Only a message that failed can be retried. Choose a client to file it under instead.");
  return rerunIntake(db, row, { by }, "retried", opts);
}
