// ---------------------------------------------------------------------------
// THE EMAIL FILING CHANNEL (#667): file the application with an authority that takes it BY EMAIL,
// once a person has verified that it does, then follow the reply like any authority email.
//
// Owner ask (2026-11-09): "have the bot send emails to the companies that intake via email once
// verified they do, then monitor the email for the update as we would normally". Universal: the
// channel is per-authority DATA (a utility's filing lookup row, an AHJ's process row), never code
// keyed to one utility, city or state.
//
// HARD RULES, AND HOW THIS MODULE KEEPS THEM:
//   · Rule 1 — sending the application by email IS a filing (Helm ruling 2026-11-09). The email is
//     STAGED AS A DRAFT by default (the stopForReview equivalent): a person downloads it and sends
//     it, then marks the track submitted. Automation sends it ONLY when the ONE gate passes —
//     shared/src/portalSafety.finalSubmitRefusals with channel "email": a named person's approval of
//     exactly THIS run (the Approve & auto-submit claim, consumed at the top of prepareSubmission and
//     burned by any refusal), the process switch FILING_EMAIL_ALLOW_SEND=1 (its OWN switch — turning
//     portals on never turns email on), a usable verified filing-email record, and no earlier send on
//     the track. One send per filing: the row is claimed draft → sending atomically before SMTP is
//     touched; a send that failed, or a process that died mid-send, is never retried automatically.
//     Fees are never paid here: an emailed fee request is a reply the tracker reads, and paying is a
//     person's step.
//   · Rule 2 — no account or meter number in the subject, the body, a log, or the audit copy. The
//     template carries the address, the client's name and the document labels only, and is scrubbed
//     with the project's own secret values anyway. Secrets travel only INSIDE the attached filled
//     forms the authority requires, to the verified address (Helm ruling). Attachments are named by
//     us ("2-utility_bill.pdf"), never by an uploader's file name. Nothing here reaches a model.
//   · Rule 3 — the filing-email record is a PERSON's act (setFilingEmail, a named person through the
//     route), in its OWN column, so a lookup's write (which replaces payload_json) never touches it.
//     Nothing infers an address from a reply-to, a stray address, a lookup or a model.
//
// THE WAY BACK. The authority's reply goes to the From address (SMTP_FROM: the filings mailbox the
// tracker polls), NOT to intake+<tag>@ — an authority is not a client sending a job, and client
// intake would park its reply unsorted. The #540 mechanism is reused for the match: the message
// carries a Message-ID of ours naming the project, and a reply whose In-Reply-To / References carry
// it (or whose subject keeps our "Ref …" tag) is filed on THIS project's track by the email tracker
// (filingEmailReplyProject, read by repository.runEmailTracker), where the existing status /
// correction mapping reads it — and, as for every email, can never FINISH a track by itself.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import type { ProjectRecord, SubmittalTrackType } from "../../shared/src/types";
import { filingEmailEnvAllows, finalSubmitRefusals, redactSecretValues } from "../../shared/src/portalSafety";
import { normalizeUtilityName, utilityFilingKey } from "./utilityFilingLookup";
import { normalizeAhjName, permitProcessKey, projectForTrack } from "./permitProcess";
import { projectSecretValues } from "./projectSecrets";
import { submissionDocumentsByType } from "./submissionDocuments";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { nowIso } from "./time";
import { senderAddress } from "./emailLayout";
import { buildMailOptions, sendEmail, smtpConfigured } from "./clientNotifier";
import { markTrackSubmitted, requiredTracks, TRACK_LABELS } from "./submittalTracks";
import type { HandoffAttachment } from "./handoffDocuments";

const str = (v: unknown): string => (v == null ? "" : String(v).trim());

// ── WHO THE TRACK FILES WITH ─────────────────────────────────────────────────────────────────

export type FilingAuthorityKind = "utility" | "ahj";
export interface FilingAuthority {
  kind: FilingAuthorityKind;
  state: string;
  /** The utility, or the AHJ that issues THIS track's permit (permitProcess.projectForTrack). */
  name: string;
  table: "utility_filing_lookups" | "permit_process_lookups";
  profileKey: string;
}

/** The authority a track files with: NEM → the project's utility; any permit track → the issuer of
 *  that track (the project AHJ, or the per-track issuer of a split-issuer project). Null when the
 *  project names none. */
export function authorityForTrack(project: ProjectRecord, track: SubmittalTrackType): FilingAuthority | null {
  if (track === "nem") {
    const name = str(project.utility);
    if (!normalizeUtilityName(name)) return null;
    return { kind: "utility", state: str(project.state), name, table: "utility_filing_lookups", profileKey: utilityFilingKey(project.state, name) };
  }
  const issuer = projectForTrack(project, track);
  const name = str(issuer.ahj);
  if (!normalizeAhjName(name)) return null;
  return { kind: "ahj", state: str(issuer.state), name, table: "permit_process_lookups", profileKey: permitProcessKey(issuer.state, name) };
}

// ── THE RECORD ───────────────────────────────────────────────────────────────────────────────

/** "This authority takes applications by email at <address>", as a person verified it. */
export interface FilingEmailRecord {
  address: string;
  /** The authority's page the person read it on. */
  sourceUrl: string;
  /** That page's own words — they must contain the address verbatim. */
  quote: string;
  verifiedBy: string;
  verifiedAt: string;
}

function parseRecord(raw: unknown): FilingEmailRecord | null {
  const t = str(raw);
  if (!t) return null;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    if (!o || typeof o !== "object") return null;
    return { address: str(o.address), sourceUrl: str(o.sourceUrl), quote: str(o.quote), verifiedBy: str(o.verifiedBy), verifiedAt: str(o.verifiedAt) };
  } catch {
    return null;
  }
}

/** The record on file for an authority, and whether its lookup row exists at all. Reads only. */
export function readFilingEmail(db: AppDb, authority: FilingAuthority): { rowExists: boolean; record: FilingEmailRecord | null } {
  try {
    const row = db.get<{ filing_email_json?: string }>(`SELECT filing_email_json FROM ${authority.table} WHERE profile_key = ?`, [authority.profileKey]);
    return { rowExists: Boolean(row), record: row ? parseRecord(row.filing_email_json) : null };
  } catch {
    return { rowExists: false, record: null };
  }
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})$/i;
/** Personal mailbox providers: an authority's application address is never one of these. */
const PERSONAL_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com", "comcast.net",
]);
/** A government domain: .gov / .mil, a US locality's .us (ci.salem.or.us, state.ut.us), or a
 *  country's gov second level (gov.uk, gc.ca stays out on purpose: unknown is not reassurance). */
export function isGovernmentDomain(domain: string): boolean {
  const d = str(domain).toLowerCase();
  return /\.(gov|mil)$/.test(d) || /\.[a-z]{2}\.us$/.test(d) || /(^|\.)state\.[a-z]{2}\.us$/.test(d) || /\.gov\.[a-z]{2}$/.test(d);
}
/** The registrable part of a host, for "is this the authority's own domain": its last two labels. */
const siteOf = (host: string): string => str(host).toLowerCase().replace(/\.$/, "").split(".").slice(-2).join(".");
const hostOf = (url: string): string => {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
};

/**
 * WHY A FILING-EMAIL RECORD IS NOT USABLE. Empty = usable. Pure. The address must be one address,
 * on a government domain or on the same site as the authority's own page the person cited, never a
 * personal mailbox; it must appear verbatim in that page's quoted words; and a named person must
 * have verified it.
 */
export function filingEmailRecordProblems(record: FilingEmailRecord | null | undefined): string[] {
  if (!record) return ["no filing-email record is on file for this authority"];
  const out: string[] = [];
  const address = str(record.address).toLowerCase();
  const m = EMAIL_RE.exec(address);
  if (!m) out.push(`"${record.address}" is not one email address`);
  if (!str(record.verifiedBy) || !str(record.verifiedAt)) out.push("no named person verified that this authority takes applications at this address");
  const sourceUrl = str(record.sourceUrl);
  if (!/^https?:\/\//i.test(sourceUrl) || !hostOf(sourceUrl)) out.push("the record names no http(s) page the address was read on");
  const quote = str(record.quote);
  if (quote.length < 8) out.push("the record carries no words from the authority's page");
  else if (address && !quote.toLowerCase().includes(address)) out.push("the address does not appear verbatim in the quoted words");
  if (m) {
    const domain = m[1].toLowerCase();
    if (PERSONAL_MAIL_DOMAINS.has(domain)) out.push(`${domain} is a personal mailbox provider, not an authority's domain`);
    else if (!isGovernmentDomain(domain) && (!hostOf(sourceUrl) || siteOf(domain) !== siteOf(hostOf(sourceUrl)))) {
      out.push(`${domain} is neither a government domain nor the domain of the authority's own page the address was read on (${hostOf(sourceUrl) || "no page"})`);
    }
  }
  return out;
}

/**
 * A NAMED PERSON RECORDS (AND SO VERIFIES) THE AUTHORITY'S FILING EMAIL — the only writer of
 * filing_email_json. Refuses a record that would not be usable, and an authority with no lookup row
 * on file (run its lookup first: the row is where the rest of the authority's process lives).
 */
export function setFilingEmail(
  db: AppDb,
  authority: FilingAuthority,
  input: { address: string; sourceUrl: string; quote: string },
  verifiedBy: string,
): { saved: boolean; reason: string; record: FilingEmailRecord | null; problems: string[] } {
  const who = str(verifiedBy).slice(0, 120);
  if (!who) return { saved: false, reason: "a filing email is verified by a named person", record: null, problems: [] };
  const { rowExists, record: existing } = readFilingEmail(db, authority);
  if (!rowExists) {
    return { saved: false, reason: `no ${authority.kind === "utility" ? "utility filing lookup" : "permit process lookup"} is on file for ${authority.name} — run its lookup first`, record: existing, problems: [] };
  }
  const record: FilingEmailRecord = {
    address: str(input.address).toLowerCase().slice(0, 254),
    sourceUrl: str(input.sourceUrl).slice(0, 600),
    quote: str(input.quote).slice(0, 600),
    verifiedBy: who,
    verifiedAt: nowIso(),
  };
  const problems = filingEmailRecordProblems(record);
  if (problems.length) return { saved: false, reason: problems.join("; "), record: existing, problems };
  db.run(`UPDATE ${authority.table} SET filing_email_json = ? WHERE profile_key = ?`, [JSON.stringify(record), authority.profileKey]);
  return { saved: true, reason: "verified", record, problems: [] };
}

/** A named person withdraws the record: the authority's channel goes back to its portal. */
export function clearFilingEmail(db: AppDb, authority: FilingAuthority): boolean {
  const { record } = readFilingEmail(db, authority);
  if (!record) return false;
  db.run(`UPDATE ${authority.table} SET filing_email_json = '' WHERE profile_key = ?`, [authority.profileKey]);
  return true;
}

/** Does this track file by email? True when its authority has a filing-email record on file — a
 *  person's act, so it chooses the channel. Whether automation may SEND is the gate's question. */
export function filingEmailChannelFor(db: AppDb, project: ProjectRecord, track: SubmittalTrackType): { authority: FilingAuthority; record: FilingEmailRecord } | null {
  const authority = authorityForTrack(project, track);
  if (!authority) return null;
  const { record } = readFilingEmail(db, authority);
  return record ? { authority, record } : null;
}

// ── THE PACKET ───────────────────────────────────────────────────────────────────────────────

export interface FilingPacketFile {
  docType: string;
  /** The name WE give it on the email. */
  filename: string;
  label: string;
  sha256: string;
  /** In memory only — never stored, never logged (a path can carry a homeowner's name). */
  path: string;
}

const humanDocType = (t: string): string => {
  const s = str(t).replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Document";
};

/** EXACTLY the files this track's filing carries — the same track-scoped selection the portal
 *  replay uploads (submissionDocuments.submissionDocumentsByType), ordered by doc type. */
export function filingPacket(db: AppDb, project: ProjectRecord, track: SubmittalTrackType): FilingPacketFile[] {
  const docs = submissionDocumentsByType(db, project, track);
  const out: FilingPacketFile[] = [];
  for (const [docType, file] of Object.entries(docs).sort((a, b) => a[0].localeCompare(b[0]))) {
    let buf: Buffer;
    try { buf = fs.readFileSync(file); } catch { continue; }
    const ext = path.extname(file).toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : "";
    const safeType = docType.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60) || "document";
    out.push({
      docType,
      filename: `${out.length + 1}-${safeType}${safeExt}`,
      label: humanDocType(docType),
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
      path: file,
    });
  }
  return out;
}

// ── THE EMAIL (deterministic: no model) ──────────────────────────────────────────────────────

/** The job reference the subject carries: the project id's first 8 hex digits and the track. */
export function filingRefTag(projectId: string, track: SubmittalTrackType): string {
  return `${str(projectId).replace(/[^0-9a-f]/gi, "").slice(0, 8).toUpperCase()}-${track.toUpperCase()}`;
}
const REF_TAG_RE = /\bRef ([0-9A-F]{8}-[A-Z]{2,12})\b/;

/** Our Message-ID for a filing email: names the project (the #540 shape), unique per run. */
export function filingMessageId(projectId: string, runId: string, fromAddress = senderAddress(process.env.SMTP_FROM)): string {
  const domain = (/@([^@\s>]+)$/.exec(str(fromAddress))?.[1] || "filing.invalid").toLowerCase();
  const runPart = str(runId).replace(/[^0-9a-f]/gi, "").slice(0, 12) || crypto.randomBytes(6).toString("hex");
  return `<filing.${str(projectId).toLowerCase()}.${runPart.toLowerCase()}@${domain}>`;
}

const serviceAddress = (p: ProjectRecord): string => {
  const base = str(p.projectAddress);
  const parts = [base];
  if (p.city && !base.toLowerCase().includes(String(p.city).toLowerCase())) parts.push(str(p.city));
  if (p.state && !new RegExp(`\\b${str(p.state)}\\b`, "i").test(base)) parts.push(str(p.state));
  return parts.filter(Boolean).join(", ");
};

/**
 * THE TEMPLATE. Subject: what is filed, where, and our Ref tag. Body: who files it, the attached
 * documents by label and file name, and how to answer. No account or meter number is ever an input,
 * and the result is scrubbed with the project's own secret values (rule 2) all the same.
 */
export function composeFilingEmail(input: {
  project: ProjectRecord; track: SubmittalTrackType; authorityName: string; files: Array<Pick<FilingPacketFile, "filename" | "label">>;
  submitterName: string; refTag: string;
}): { subject: string; body: string } {
  const what = TRACK_LABELS[input.track] || "Application";
  const where = serviceAddress(input.project) || "the project address on the attached application";
  const submitter = str(input.submitterName) || "the installing contractor";
  const subject = `${what} application — ${where} [Ref ${input.refTag}]`;
  const body = [
    `To ${str(input.authorityName) || "the application desk"}:`,
    "",
    `Please accept the attached ${what.toLowerCase()} application for the solar installation at ${where}, submitted by ${submitter}.`,
    "",
    `Attached (${input.files.length}):`,
    ...input.files.map((f) => `  - ${f.label} (${f.filename})`),
    "",
    `Please reply to this email with the application or record number, and with any corrections or fees due. Reference: ${input.refTag}.`,
    "",
    submitter,
  ].join("\n");
  const secrets = projectSecretValues(input.project);
  return { subject: redactSecretValues(subject, secrets), body: redactSecretValues(body, secrets) };
}

// ── THE SEND ROWS ────────────────────────────────────────────────────────────────────────────

export interface FilingEmailSendView {
  id: string; projectId: string; track: string; runId: string; status: string;
  authorityKind: string; authorityName: string; recipient: string; subject: string; body: string;
  refTag: string; messageId: string; attachments: Array<{ docType: string; filename: string; label: string; sha256: string }>;
  approvedBy: string; refusals: string[]; detail: string; createdAt: string; sentAt: string | null;
}
type Row = Record<string, unknown>;
const json = <T>(t: unknown, d: T): T => { try { return JSON.parse(str(t) || "null") ?? d; } catch { return d; } };
function rowView(row: Row): FilingEmailSendView {
  return {
    id: str(row.id), projectId: str(row.project_id), track: str(row.track), runId: str(row.run_id), status: str(row.status),
    authorityKind: str(row.authority_kind), authorityName: str(row.authority_name), recipient: str(row.recipient),
    subject: str(row.subject), body: String(row.body ?? ""), refTag: str(row.ref_tag), messageId: str(row.message_id),
    attachments: json(row.attachments_json, []), approvedBy: str(row.approved_by), refusals: json(row.refusals_json, []),
    detail: str(row.detail), createdAt: str(row.created_at), sentAt: row.sent_at ? str(row.sent_at) : null,
  };
}

export function listFilingEmailSends(db: AppDb, projectId: string, track?: string | null): FilingEmailSendView[] {
  const rows = track
    ? db.query<Row>("SELECT * FROM filing_email_sends WHERE project_id = ? AND track = ? ORDER BY created_at DESC, rowid DESC", [projectId, track])
    : db.query<Row>("SELECT * FROM filing_email_sends WHERE project_id = ? ORDER BY created_at DESC, rowid DESC", [projectId]);
  return rows.map(rowView);
}

/** A send for this track is on record — sent, in flight, or failed (which may have left anyway). */
const SEND_ON_RECORD = "('sending', 'sent', 'failed')";
export function priorFilingEmailSend(db: AppDb, projectId: string, track: string): boolean {
  return Boolean(db.get(`SELECT id FROM filing_email_sends WHERE project_id = ? AND track = ? AND status IN ${SEND_ON_RECORD} LIMIT 1`, [projectId, track]));
}

/** The test door for the SMTP send. Production: clientNotifier.sendEmail. */
export type FilingEmailSender = (to: string, subject: string, body: string, attachments: HandoffAttachment[], opts: { messageId: string }) => Promise<void>;
let senderForTests: FilingEmailSender | null = null;
export function setFilingEmailSenderForTests(fn: FilingEmailSender | null): void {
  senderForTests = fn;
}

/**
 * FILE ONE TRACK BY EMAIL — called by repository.prepareSubmission once every generic staging gate
 * has passed (hold, payment, duplicate, QC / reviewer gate, documents, permit path, client) and the
 * track's authority has a filing-email record. Always stages the draft (and the track's
 * awaiting_human_submit submission). Sends only when the one gate passes. Never throws after the
 * draft is written: a failed send is recorded and reported, not retried.
 */
export async function fileTrackByEmail(db: AppDb, input: {
  project: ProjectRecord;
  track: SubmittalTrackType;
  runId: string;
  /** The approval THIS run claimed (prepareSubmission's claimRunApproval), or null. */
  approval: { approver: string } | null;
  wantsFinalSubmit: boolean;
  relaxedSinceApproval: string[];
  submitterName: string;
  env?: Record<string, string | undefined>;
}): Promise<FilingEmailSendView> {
  const { project, track, runId } = input;
  const channel = filingEmailChannelFor(db, project, track);
  if (!channel) throw new HttpError(409, "This track's authority has no filing-email record; it files on its portal.");
  const { authority, record } = channel;
  if (!requiredTracks(project).includes(track)) throw new HttpError(400, `This project does not require a "${track}" filing.`);
  const files = filingPacket(db, project, track);
  if (!files.length) throw new HttpError(409, `Nothing to attach: the ${TRACK_LABELS[track]} filing has no documents.`);
  const refTag = filingRefTag(project.id, track);
  const messageId = filingMessageId(project.id, runId);
  const { subject, body } = composeFilingEmail({ project, track, authorityName: authority.name, files, submitterName: input.submitterName, refTag });
  const recordProblems = filingEmailRecordProblems(record);
  const runApproval = input.approval ? { approver: input.approval.approver, runId } : null;
  const refusals = input.wantsFinalSubmit
    ? finalSubmitRefusals({
      channel: "email", envAllows: filingEmailEnvAllows(input.env ?? process.env), runApproval, runId,
      recordProblems, priorSendOnTrack: priorFilingEmailSend(db, project.id, track), relaxedSinceApproval: input.relaxedSinceApproval,
    })
    : ["no automatic send was asked for — the email is staged for a person to send"];
  if (input.wantsFinalSubmit && refusals.length === 0 && !senderForTests && !smtpConfigured()) {
    refusals.push("SMTP is not configured (SMTP_HOST / SMTP_FROM), so nothing can be sent");
  }
  const attachmentsAudit = files.map(({ docType, filename, label, sha256 }) => ({ docType, filename, label, sha256 }));
  const sendId = id();
  const ts = nowIso();
  const label = TRACK_LABELS[track];
  db.transaction(() => {
    // An older unsent draft of this track is superseded by this one (the packet may have changed).
    db.run("UPDATE filing_email_sends SET status = 'superseded' WHERE project_id = ? AND track = ? AND status = 'draft'", [project.id, track]);
    db.run(
      `INSERT INTO filing_email_sends (id, project_id, track, run_id, status, authority_kind, authority_name, recipient, subject, body,
         ref_tag, message_id, attachments_json, approved_by, refusals_json, detail, created_at, sent_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, NULL)`,
      [sendId, project.id, track, runId, authority.kind, authority.name, record.address, subject, body, refTag, messageId,
        JSON.stringify(attachmentsAudit), input.approval?.approver ?? "", JSON.stringify(refusals), ts],
    );
    db.run(
      `INSERT INTO submissions (id, project_id, portal_profile_id, submission_type, permit_type, status, application_number, permit_number,
         confirmation_number, submitted_at, submitted_by, screenshots_path, notes, created_at)
       VALUES (?, ?, NULL, ?, ?, 'awaiting_human_submit', '', '', '', NULL, '', '', ?, ?)`,
      [id(), project.id, track === "nem" ? "interconnection" : "permit", track,
        `${label}: filing email to ${record.address} (${authority.name}) staged as a draft — ${files.length} attachment(s). A person sends it (download it from the track), then marks the track submitted.`, ts],
    );
    db.run("UPDATE projects SET status = 'awaiting_human_submit', current_stage = ?, stage_detail = 'staged_for_review', updated_at = ? WHERE id = ?", [
      `${label}: filing email staged for ${authority.name}. Human must verify and send it.`, ts, project.id,
    ]);
  });
  addAuditLog(db, project.id, "system", "email filing", "filing_email.staged", {
    track, runId, sendId, authority: authority.name, recipient: record.address, refTag, attachments: attachmentsAudit.map((a) => a.filename),
  });
  if (refusals.length) {
    if (input.wantsFinalSubmit) {
      addAuditLog(db, project.id, "system", "submit gate", "filing_email.auto_send_declined", { track, runId, approvedBy: input.approval?.approver ?? null, reasons: refusals });
    }
    return rowView(db.get<Row>("SELECT * FROM filing_email_sends WHERE id = ?", [sendId])!);
  }

  // THE ONE SEND. Claimed draft → sending atomically, and only while no other send of this track is
  // on record, BEFORE SMTP is touched: a second run, a retry or a restart finds 'sending'/'sent'/
  // 'failed' and never sends again.
  db.run(
    `UPDATE filing_email_sends SET status = 'sending' WHERE id = ? AND status = 'draft'
       AND NOT EXISTS (SELECT 1 FROM filing_email_sends o WHERE o.project_id = ? AND o.track = ? AND o.id <> ? AND o.status IN ${SEND_ON_RECORD})`,
    [sendId, project.id, track, sendId],
  );
  if (Number(db.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0) !== 1) {
    db.run("UPDATE filing_email_sends SET refusals_json = ? WHERE id = ?", [JSON.stringify(["another send of this track is on record"]), sendId]);
    addAuditLog(db, project.id, "system", "submit gate", "filing_email.auto_send_declined", { track, runId, reasons: ["another send of this track is on record"] });
    return rowView(db.get<Row>("SELECT * FROM filing_email_sends WHERE id = ?", [sendId])!);
  }
  addAuditLog(db, project.id, "system", "submit gate", "filing_email.auto_send_allowed", { track, runId, approvedBy: input.approval!.approver, recipient: record.address });
  const attachments: HandoffAttachment[] = files.map((f) => ({ filename: f.filename, path: f.path, label: f.label }));
  try {
    await (senderForTests ?? ((to, s, b, a, o) => sendEmail(to, s, b, a, o)))(record.address, subject, body, attachments, { messageId });
  } catch (err) {
    // Reported, never retried: the message may have left before the error. The scrubbed reason only.
    const detail = redactSecretValues(err instanceof Error ? err.message : String(err), projectSecretValues(project)).slice(0, 400);
    db.run("UPDATE filing_email_sends SET status = 'failed', detail = ? WHERE id = ?", [detail, sendId]);
    addAuditLog(db, project.id, "system", "email filing", "filing_email.send_failed", { track, runId, sendId, detail });
    return rowView(db.get<Row>("SELECT * FROM filing_email_sends WHERE id = ?", [sendId])!);
  }
  const sentAt = nowIso();
  db.run("UPDATE filing_email_sends SET status = 'sent', sent_at = ? WHERE id = ?", [sentAt, sendId]);
  addAuditLog(db, project.id, "system", "email filing", "filing_email.sent", {
    track, runId, sendId, approvedBy: input.approval!.approver, recipient: record.address, messageId, attachments: attachmentsAudit.map((a) => a.filename),
  });
  // THE SEND IS THE TRACK'S SUBMISSION: the awaiting row becomes the filing, a tracking target is
  // ensured, the client hears (markTrackSubmitted — the same door a person's "mark submitted" uses).
  const { getProjectDetail } = await import("./repository");
  try {
    markTrackSubmitted(db, getProjectDetail(db, project.id).project, track, {
      submittedAt: sentAt,
      submittedBy: `automation (filing email approved by ${input.approval!.approver})`,
      notes: `${label} filed by email to ${record.address} (${authority.name}), Message-ID ${messageId}, Ref ${refTag}; attached: ${attachmentsAudit.map((a) => a.filename).join(", ")}. No fee paid.`,
    });
  } catch (err) {
    // The email LEFT; only the bookkeeping failed. Said on the row and in the audit — never re-sent.
    const detail = `sent, but recording the filing failed: ${err instanceof Error ? err.message : String(err)} — mark the track submitted by hand`.slice(0, 400);
    db.run("UPDATE filing_email_sends SET detail = ? WHERE id = ?", [detail, sendId]);
    addAuditLog(db, project.id, "system", "email filing", "filing_email.record_failed", { track, runId, sendId, detail });
  }
  return rowView(db.get<Row>("SELECT * FROM filing_email_sends WHERE id = ?", [sendId])!);
}

// ── THE DRAFT, FOR A PERSON TO SEND ──────────────────────────────────────────────────────────

/**
 * The staged draft as an .eml a person opens in their mail client and sends (X-Unsent: 1 opens it
 * as an editable draft). Rebuilt from the track's packet NOW, and refused when the packet no longer
 * matches what the draft listed (a document replaced since staging) — stage again instead. A sent or
 * in-flight row is never handed out again.
 */
export async function filingEmailDraftEml(db: AppDb, project: ProjectRecord, sendId: string): Promise<{ filename: string; content: Buffer }> {
  const row = db.get<Row>("SELECT * FROM filing_email_sends WHERE id = ? AND project_id = ?", [sendId, project.id]);
  if (!row) throw new HttpError(404, "No such filing email on this project.");
  const view = rowView(row);
  if (view.status === "sent" || view.status === "sending") throw new HttpError(409, `This filing email is ${view.status === "sent" ? "already sent" : "being sent (or its send never finished — check the mailbox's Sent folder)"}; it is not handed out again.`);
  if (view.status === "superseded") throw new HttpError(409, "A newer draft of this filing replaced this one.");
  const files = filingPacket(db, project, view.track as SubmittalTrackType);
  const now = files.map((f) => `${f.filename}:${f.sha256}`).join("|");
  const then = view.attachments.map((f) => `${f.filename}:${f.sha256}`).join("|");
  if (now !== then) throw new HttpError(409, "The filing's documents changed since this draft was staged. Stage the track again for a fresh draft.");
  const options = buildMailOptions(view.recipient, view.subject, view.body, files.map((f) => ({ filename: f.filename, path: f.path, label: f.label })), { messageId: view.messageId });
  const { default: MailComposer } = await import("nodemailer/lib/mail-composer");
  const content = await new MailComposer({ ...options, headers: { "X-Unsent": "1" } }).compile().build();
  return { filename: `filing-${view.refTag.toLowerCase()}.eml`, content };
}

// ── THE WAY BACK ─────────────────────────────────────────────────────────────────────────────

/**
 * WHICH PROJECT AND TRACK AN INBOUND EMAIL ANSWERS, when it answers one of our filing emails: its
 * In-Reply-To / References carry a Message-ID we recorded, else its subject keeps our Ref tag.
 * Only a project in the polling source's own scope (org, and client when the source names one) —
 * rule 6. Null otherwise: the tracker's ordinary match runs.
 */
export function filingEmailReplyProject(
  db: AppDb,
  message: { threadRefs?: string; subject?: string },
  scope: { orgId: string; clientId?: string },
): { projectId: string; track: SubmittalTrackType; via: "message_id" | "ref_tag" } | null {
  const inScope = (projectId: string): boolean => Boolean(scope.clientId
    ? db.get("SELECT id FROM projects WHERE id = ? AND org_id = ? AND client_id = ?", [projectId, scope.orgId, scope.clientId])
    : db.get("SELECT id FROM projects WHERE id = ? AND org_id = ?", [projectId, scope.orgId]));
  try {
    const ids = [...new Set((str(message.threadRefs).match(/<[^<>\s]+@[^<>\s]+>/g) ?? []).map((m) => m.toLowerCase()))].slice(0, 40);
    for (const mid of ids.reverse()) {
      const row = db.get<Row>("SELECT project_id, track FROM filing_email_sends WHERE message_id = ? ORDER BY created_at DESC LIMIT 1", [mid]);
      if (row && inScope(str(row.project_id))) return { projectId: str(row.project_id), track: str(row.track) as SubmittalTrackType, via: "message_id" };
    }
    const tag = REF_TAG_RE.exec(str(message.subject))?.[1];
    if (tag) {
      const rows = db.query<Row>("SELECT DISTINCT project_id, track FROM filing_email_sends WHERE ref_tag = ?", [tag]).filter((r) => inScope(str(r.project_id)));
      // A tag shared by two projects in scope names neither.
      if (rows.length === 1) return { projectId: str(rows[0].project_id), track: str(rows[0].track) as SubmittalTrackType, via: "ref_tag" };
    }
  } catch { /* an unreadable table never places an email */ }
  return null;
}
