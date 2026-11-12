// ---------------------------------------------------------------------------
// A CLIENT SETS ITSELF UP: THE "COMPANY SETUP" LINK (owner, 2026-11-10: "can we make them onboard
// with the customer portal?").
//
// Onboarding was staff-run: a person collected docs/onboarding/INTAKE_CHECKLIST.md by call or email,
// filled the intake template and ran scripts/onboard-company.ts. This is the client doing that part
// itself, on a no-login page (frontend/onboarding.html) in the family of the status, tracker, intake
// and credential pages.
//
// THE LINK. Staff mint it per client on the Clients screen. It is revocable, it expires (14 days by
// default), and the client's answers are saved as a DRAFT across sessions until it submits. Only the
// SHA-256 of the token is stored; the URL is shown once, at mint. Minting a new link revokes the
// client's open one and carries its draft over, so a lost or expired link costs the client nothing.
// It is shared like the other client links (copied by staff); the mint answers with the go-live link
// guard's verdict on PUBLIC_BASE_URL, so staff are told before they share a link a client cannot open.
//
// WHAT THE PAGE COLLECTS: the intake template's client block — identity and business address,
// contacts, the updates inbox and intake senders, licences per state (clients.licenceFor's shape, any
// state), insurance and bond, the authorized signer, the standard AC disconnect, the service area
// (clientServiceArea's shape), the billing contact — and optional certificate uploads.
//
// NOTHING THE CLIENT TYPES OVERWRITES THE CLIENT RECORD. On submit each field that differs from what
// is on file becomes a "client-supplied" PROPOSAL (client_onboarding_proposals). A named staff person
// accepts it (as sent, or edited) or rejects it on the Clients screen, field by field or "accept all";
// only the accept writes, through updateClient — the client record's one writer — and every decision
// is audited. A list (licences, service area) is accepted as ADDITIONS: an accept never removes a
// licence or a place already on file. A blank answer never blanks a stored value.
//
// RULE 2: PORTAL LOGINS NEVER TOUCH THIS PAGE'S DATA. For each portal the client names, the page
// hands off to the EXISTING one-time credential link (credentialRequests.createCredentialRequest,
// unchanged; the password goes through its own route and encryption). This module refuses any body
// that carries a password, security answer or token-shaped field (assertNoSecretShapes), nothing here
// is logged (the request log masks the token in the path; no body or value is ever written to a log or
// an audit row), and no model door imports this module (clientOnboarding.test pins it). Uploads are
// stored as bytes for staff to open; nothing parses them or sends them to a model.
//
// RULE 6: the public routes (/api/public/onboarding/:token…) are scoped to ONE client by the token:
// every read and write below resolves the token to its row and touches only that row's client_id. A
// bad, expired or revoked token answers 404 with one message; a submitted link answers its status and
// checklist only and refuses every write. The staff routes sit under /api/clients/:id (scope-guarded).
//
// Universal: no state, city, utility or portal is named here; states, licence kinds and service-area
// kinds are data.
// ---------------------------------------------------------------------------
import { createHash, randomBytes } from "node:crypto";
import type { ClientRecord, ClientServiceAreaEntry, ClientStateLicense } from "../../shared/src/types";
import { canonicalLicenceKind, LICENCE_KINDS } from "../../shared/src/licenceKinds";
import type { AppDb } from "./db";
import { DEFAULT_ORG_ID } from "./db";
import { addAuditLog } from "./audit";
import { getClient, parseStateLicenses, updateClient } from "./clients";
import { createCredentialRequest } from "./credentialRequests";
import { deadLinkHostReason, publicBaseUrlProblem } from "./clientLinkGuard";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { clientOnboardingChecklist, jurisdictionsFromServiceArea, type ChecklistLine, type ReadinessJurisdiction } from "./onboardingReadiness";
import { mergeServiceArea, parseServiceArea, serviceAreaEntryKey, serviceAreaProblems } from "./serviceAreaEntries";
import { alertStaffOnClientOnboarding } from "./staffAlerts";
import { listFilingStatements, normalizeFilingAnswers, recordFilingStatements, type FilingAuthorityOption, type FilingStatement } from "./clientFilingStatements";
import { nowIso } from "./time";
import { usStateCode } from "./usState";

export const ONBOARDING_TTL_DAYS_DEFAULT = 14;
export const ONBOARDING_TTL_DAYS_MAX = 60;
/** One hand-off may name this many portals, and one link may make this many hand-offs. */
export const ONBOARDING_PORTALS_PER_REQUEST = 10;
export const ONBOARDING_PORTAL_REQUESTS_PER_LINK = 5;
/** Certificates: PDF or a photo, this big, this many per link. */
export const ONBOARDING_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const ONBOARDING_FILES_PER_LINK = 8;
export const ONBOARDING_FILE_KINDS = ["insurance_certificate", "bond_certificate", "licence_certificate", "other_certificate"] as const;
export type OnboardingFileKind = (typeof ONBOARDING_FILE_KINDS)[number];

const DEAD_LINK = "This link is no longer valid. Ask your Keelix contact for a new one.";
const SECRET_REFUSAL = "This page never takes passwords, security answers or access codes. Leave them out — portal logins go through the separate secure login link on this page.";

// ---------------------------------------------------------------------------
// The fields (what the page asks, and how each value is checked).
// ---------------------------------------------------------------------------
type FieldType = "text" | "email" | "phone" | "date" | "state" | "zip" | "senders" | "licences" | "serviceArea";
export interface OnboardingField { key: keyof ClientRecord; label: string; group: string; type: FieldType; hint?: string }

export const ONBOARDING_FIELDS: readonly OnboardingField[] = [
  { key: "companyName", label: "Company name", group: "company", type: "text" },
  { key: "legalBusinessName", label: "Legal business name", group: "company", type: "text", hint: "Exactly as registered with the state" },
  { key: "dba", label: "Doing business as (if different)", group: "company", type: "text" },
  { key: "businessAddress", label: "Street address", group: "address", type: "text" },
  { key: "businessCity", label: "City", group: "address", type: "text" },
  { key: "businessState", label: "State", group: "address", type: "state", hint: "Two letters, e.g. CO" },
  { key: "businessZip", label: "ZIP code", group: "address", type: "zip" },
  { key: "businessPhone", label: "Business phone", group: "address", type: "phone" },
  { key: "businessEmail", label: "Business email", group: "address", type: "email" },
  { key: "contactName", label: "Main contact for permits", group: "contacts", type: "text" },
  { key: "contactEmail", label: "Contact email", group: "contacts", type: "email" },
  { key: "phone", label: "Contact phone", group: "contacts", type: "phone" },
  { key: "updatesInbox", label: "Inbox for job updates", group: "contacts", type: "email", hint: "Where we send status updates for your jobs" },
  { key: "intakeSenders", label: "Who may email us jobs", group: "contacts", type: "senders", hint: "Email addresses, or @yourdomain.com for everyone at your company, separated by commas" },
  { key: "billingContactEmail", label: "Billing contact email", group: "contacts", type: "email" },
  { key: "stateLicenses", label: "Licences", group: "licences", type: "licences" },
  { key: "insuranceCarrier", label: "Insurance carrier", group: "insurance", type: "text" },
  { key: "insuranceExpiry", label: "Insurance expires", group: "insurance", type: "date" },
  { key: "bondCarrier", label: "Bond carrier (surety)", group: "insurance", type: "text" },
  { key: "bondExpiry", label: "Bond expires", group: "insurance", type: "date" },
  { key: "authorizedSignerName", label: "Authorized signer", group: "signer", type: "text", hint: "The person who signs applications for your company" },
  { key: "authorizedSignerTitle", label: "Signer's title", group: "signer", type: "text" },
  { key: "standardDisconnectMake", label: "AC disconnect make", group: "equipment", type: "text", hint: "The disconnect you usually install" },
  { key: "standardDisconnectModel", label: "AC disconnect model", group: "equipment", type: "text" },
  { key: "serviceArea", label: "Where you work", group: "area", type: "serviceArea" },
];
const FIELD_BY_KEY = new Map(ONBOARDING_FIELDS.map((f) => [String(f.key), f]));

// ---------------------------------------------------------------------------
// Rule 2: no secret ever rides in this page's data.
// ---------------------------------------------------------------------------
// Read as WORDS (camelCase and snake_case split), so "legalBusinessName" is not "ssn" and "passport" is
// not "pass": a key is refused when one of its words names a secret.
const SECRET_KEY_WORDS = /\b(?:pass(?:word|words|wd|code|phrase)?|pwd|secret|secrets|security (?:question|answer)s?|answers?|tokens?|api ?keys?|otp|one time (?:code|password)|mfa|2fa|pin|pin code|ssn|social security|credentials?|logins?|sessions?|cookies?)\b/;
function secretKey(k: string): boolean {
  const words = String(k).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").toLowerCase();
  return SECRET_KEY_WORDS.test(words);
}
const TOKEN_PREFIX = /^(?:sk[-_]|pk_live|rk_live|ghp_|gho_|ghs_|github_pat_|xox[abprs]-|AKIA|ASIA|eyJ[A-Za-z0-9_-]{8,}\.)/;
const SSN_SHAPE = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;
const LABELLED_SECRET = /\b(?:password|passwd|pwd|passcode|security answer|pin)\s*[:=]/i;

/** Is this one string a secret by its shape? A long unbroken run of letters AND digits (an API key,
 *  a session token), a known key prefix, an SSN, or a "password: …" label. Emails and URLs are not. */
export function looksSecretShaped(value: string): boolean {
  const v = String(value ?? "").trim();
  if (!v) return false;
  if (TOKEN_PREFIX.test(v) || SSN_SHAPE.test(v) || LABELLED_SECRET.test(v)) return true;
  for (const word of v.split(/[\s,;]+/)) {
    if (word.length < 24 || word.includes("@") || /^https?:\/\//i.test(word)) continue;
    if (/^[A-Za-z0-9_\-+/=.]+$/.test(word) && /[A-Za-z]/.test(word) && /\d/.test(word)) return true;
  }
  return false;
}

/** Refuse a body that carries a password, security answer or token-shaped field — by key or by value
 *  shape, at any depth. The refusal names WHERE (a path of keys), never the value. */
export function assertNoSecretShapes(body: unknown, where = "body", depth = 0): void {
  if (depth > 6) throw new HttpError(400, "That answer is nested too deeply.");
  if (typeof body === "string") {
    if (looksSecretShaped(body)) throw new HttpError(400, SECRET_REFUSAL, { field: where });
    return;
  }
  if (Array.isArray(body)) { body.forEach((v, i) => assertNoSecretShapes(v, `${where}[${i}]`, depth + 1)); return; }
  if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (secretKey(k)) throw new HttpError(400, SECRET_REFUSAL, { field: `${where}.${k.slice(0, 40)}` });
      assertNoSecretShapes(v, `${where}.${k.slice(0, 40)}`, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Value checks. `normalize` turns what was sent into what would be stored, and names what is wrong.
// ---------------------------------------------------------------------------
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
const oneLine = (v: unknown, max = 200): string => str(v).replace(/\s+/g, " ").slice(0, max);
const EMAIL = /^[^\s@<>()",;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DOMAIN = /^@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
function isDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** A state as stored: its code ("Wyoming" → "WY"), or any two letters as typed — the service area's
 *  own rule (serviceAreaEntries.stateOf): tests and unlisted territories use them, as project rows do. */
function stateCode(v: unknown): string {
  const t = str(v);
  return usStateCode(t) || (/^[A-Za-z]{2}$/.test(t) ? t.toUpperCase() : "");
}

const LICENCE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9 .\-/#]{0,39}$/;
export const ONBOARDING_LICENCE_KINDS = LICENCE_KINDS.map((k) => ({ kind: k.kind, label: k.label }));

function normalizeLicences(raw: unknown, problems: string[], label: string): ClientStateLicense[] {
  if (raw == null || raw === "") return [];
  if (!Array.isArray(raw)) { problems.push(`${label}: send a list of licences.`); return []; }
  if (raw.length > 40) problems.push(`${label}: at most 40 licences.`);
  const out: ClientStateLicense[] = [];
  raw.slice(0, 40).forEach((item, i) => {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const state = stateCode(o.state);
    const kind = canonicalLicenceKind(str(o.kind));
    const number = oneLine(o.number, 40);
    const expires = oneLine(o.expires, 10);
    if (!str(o.state) && !str(o.kind) && !number && !expires) return; // an empty row the page left
    const n = `Licence ${i + 1}`;
    if (!state) problems.push(`${n}: choose the state that issued it.`);
    if (!kind) problems.push(`${n}: choose what kind of licence it is.`);
    if (!number) problems.push(`${n}: enter its number.`);
    else if (!LICENCE_NUMBER.test(number)) problems.push(`${n}: a licence number uses letters, digits, spaces and . - / # only.`);
    if (expires && !isDate(expires)) problems.push(`${n}: the expiry must be a date.`);
    if (state && kind && number && LICENCE_NUMBER.test(number)) out.push({ state, kind, number, ...(expires && isDate(expires) ? { expires } : {}) });
  });
  return out;
}

function normalizeServiceArea(raw: unknown, problems: string[]): ClientServiceAreaEntry[] {
  if (raw == null || raw === "") return [];
  const rows = Array.isArray(raw)
    ? raw.filter((e) => e && typeof e === "object" && (str((e as Record<string, unknown>).state) || str((e as Record<string, unknown>).name)))
    : raw;
  for (const p of serviceAreaProblems(rows)) problems.push(p.replace(/^serviceArea\[(\d+)\]/, (_m, i) => `Place ${Number(i) + 1}`));
  return parseServiceArea(rows);
}

function normalizeSenders(raw: unknown, problems: string[], label: string): string {
  const parts = str(raw).split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 20) problems.push(`${label}: at most 20 addresses.`);
  const bad = parts.filter((p) => !EMAIL.test(p) && !DOMAIN.test(p));
  if (bad.length) problems.push(`${label}: "${bad[0].slice(0, 60)}" is not an email address or an @domain.`);
  return parts.filter((p) => EMAIL.test(p) || DOMAIN.test(p)).map((p) => p.toLowerCase()).slice(0, 20).join(", ");
}

type FieldValue = string | ClientStateLicense[] | ClientServiceAreaEntry[];

function normalizeField(f: OnboardingField, raw: unknown, problems: string[]): FieldValue {
  const label = f.label;
  switch (f.type) {
    case "licences": return normalizeLicences(raw, problems, label);
    case "serviceArea": return normalizeServiceArea(raw, problems);
    case "senders": return normalizeSenders(raw, problems, label);
    default: break;
  }
  if (raw != null && typeof raw !== "string" && typeof raw !== "number") { problems.push(`${label}: send text.`); return ""; }
  const v = oneLine(raw);
  if (!v) return "";
  if (str(raw).length > 200) problems.push(`${label}: at most 200 characters.`);
  if (f.type === "email" && !EMAIL.test(v)) problems.push(`${label}: "${v.slice(0, 60)}" is not an email address.`);
  if (f.type === "phone") {
    const digits = v.replace(/\D/g, "");
    if (!/^[0-9()+.\-\s]*(?:(?:x|ext\.?)\s*\d{1,6})?$/i.test(v) || digits.length < 7 || digits.length > 15) problems.push(`${label}: enter a phone number.`);
  }
  if (f.type === "date" && !isDate(v)) problems.push(`${label}: enter a date.`);
  if (f.type === "zip" && !/^\d{5}(?:-\d{4})?$/.test(v)) problems.push(`${label}: enter a 5-digit ZIP code.`);
  if (f.type === "state") {
    const code = stateCode(v);
    if (!code) problems.push(`${label}: "${v.slice(0, 30)}" is not a US state.`);
    return code || v;
  }
  return v;
}

/** What was sent, as it would be stored, and everything wrong with it. Unknown fields are refused,
 *  so nothing can ride in under a name this page does not ask. */
export function normalizeOnboardingFields(raw: unknown): { values: Record<string, FieldValue>; problems: string[] } {
  const problems: string[] = [];
  const values: Record<string, FieldValue> = {};
  if (raw == null) return { values, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) return { values, problems: ["Send the answers as fields."] };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const f = FIELD_BY_KEY.get(k);
    if (!f) { problems.push(`"${k.slice(0, 40)}" is not a question on this page.`); continue; }
    values[k] = normalizeField(f, v, problems);
  }
  return { values, problems };
}

const isEmptyValue = (v: unknown): boolean => (Array.isArray(v) ? v.length === 0 : !str(v));

// ---------------------------------------------------------------------------
// The link.
// ---------------------------------------------------------------------------
interface LinkRow {
  id: string; client_id: string; token_hash: string; status: string; draft_json: string; draft_saved_at: string | null;
  created_by: string; created_at: string; expires_at: string; submitted_at: string | null; revoked_at: string | null;
  revoked_by: string; portal_requests: number;
}

export function hashOnboardingToken(token: string): string {
  return createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");
}

const expired = (r: LinkRow, now = Date.now()): boolean => Date.parse(r.expires_at) < now;

/** The link's state as staff read it. */
function linkState(r: LinkRow): "open" | "submitted" | "revoked" | "expired" {
  if (r.status === "revoked") return "revoked";
  if (r.status === "submitted") return "submitted";
  return expired(r) ? "expired" : "open";
}

function parseDraft(raw: string): Record<string, unknown> {
  try { const v = JSON.parse(raw || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

/** The URL path a link opens (the caller puts PUBLIC_BASE_URL in front). */
export function onboardingPath(token: string): string {
  return `/onboarding?token=${encodeURIComponent(token)}`;
}

export function onboardingUrl(token: string): string {
  const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4173}`).replace(/\/+$/, "");
  return `${base}${onboardingPath(token)}`;
}

/**
 * Staff mint a Company setup link for one client. Any open link of the client's is revoked, and the
 * newest unsubmitted draft carries over. Returns the token ONCE (only its hash is stored).
 */
export function mintOnboardingLink(
  db: AppDb,
  clientId: string,
  opts: { createdBy: string; ttlDays?: number },
): { id: string; token: string; url: string; expiresAt: string; linkProblem: string | null } {
  getClient(db, clientId); // 404 when there is no such client
  const days = Number(opts.ttlDays);
  const ttl = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), ONBOARDING_TTL_DAYS_MAX) : ONBOARDING_TTL_DAYS_DEFAULT;
  const token = randomBytes(32).toString("base64url");
  const linkId = id();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + ttl * 86_400_000).toISOString();
  db.transaction(() => {
    const prior = db.get<LinkRow>(
      "SELECT * FROM client_onboarding_links WHERE client_id = ? AND status = 'open' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      [clientId],
    );
    db.run("UPDATE client_onboarding_links SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE client_id = ? AND status = 'open'", [now, `replaced by a new link (${opts.createdBy})`, clientId]);
    db.run(
      `INSERT INTO client_onboarding_links (id, client_id, token_hash, status, draft_json, draft_saved_at, created_by, created_at, expires_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      [linkId, clientId, hashOnboardingToken(token), prior?.draft_json || "{}", prior?.draft_saved_at ?? null, opts.createdBy, now, expiresAt],
    );
    // A certificate the client uploaded on the old link stays with the client; the new link lists it.
    if (prior) db.run("UPDATE client_onboarding_files SET link_id = ? WHERE link_id = ?", [linkId, prior.id]);
  });
  addAuditLog(db, null, "human", opts.createdBy, "client.onboarding_link_created", { clientId, linkId, expiresAt });
  return { id: linkId, token, url: onboardingUrl(token), expiresAt, linkProblem: publicBaseUrlProblem() };
}

export function revokeOnboardingLink(db: AppDb, clientId: string, linkId: string, by: string): { revoked: boolean } {
  const row = db.get<LinkRow>("SELECT * FROM client_onboarding_links WHERE id = ? AND client_id = ?", [linkId, clientId]);
  if (!row) throw new HttpError(404, "No such link for this client.");
  if (row.status !== "open") return { revoked: false };
  db.run("UPDATE client_onboarding_links SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ?", [nowIso(), by, linkId]);
  addAuditLog(db, null, "human", by, "client.onboarding_link_revoked", { clientId, linkId });
  return { revoked: true };
}

export interface OnboardingLinkView {
  id: string; state: "open" | "submitted" | "revoked" | "expired"; createdBy: string; createdAt: string; expiresAt: string;
  draftSavedAt: string | null; submittedAt: string | null; revokedAt: string | null; revokedBy: string;
}

/** Staff view of a client's links. Never the token (only its hash exists). */
export function listOnboardingLinks(db: AppDb, clientId: string): OnboardingLinkView[] {
  return db.query<LinkRow>("SELECT * FROM client_onboarding_links WHERE client_id = ? ORDER BY created_at DESC, rowid DESC", [clientId]).map((r) => ({
    id: r.id, state: linkState(r), createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at,
    draftSavedAt: r.draft_saved_at, submittedAt: r.submitted_at, revokedAt: r.revoked_at, revokedBy: r.revoked_by,
  }));
}

/** The token's row: a submitted link reads (status and checklist only); `write` needs an open one.
 *  Missing, revoked and expired answer the same 404, so a prober learns nothing. */
function linkFor(db: AppDb, token: string, mode: "read" | "write"): LinkRow {
  const t = String(token ?? "").trim();
  if (t.length < 32 || t.length > 128) throw new HttpError(404, DEAD_LINK);
  const row = db.get<LinkRow>("SELECT * FROM client_onboarding_links WHERE token_hash = ?", [hashOnboardingToken(t)]);
  if (!row || row.status === "revoked" || expired(row)) throw new HttpError(404, DEAD_LINK);
  if (mode === "write" && row.status !== "open") throw new HttpError(409, "These answers were already sent. Ask your Keelix contact if something needs to change.");
  return row;
}

// ---------------------------------------------------------------------------
// What the client sees.
// ---------------------------------------------------------------------------

/** The client record's value for a page field, in the page's shape. */
function recordValue(client: ClientRecord, key: string): FieldValue {
  const v = (client as unknown as Record<string, unknown>)[key];
  if (key === "stateLicenses") return parseStateLicenses(client.stateLicenses ?? []).map((l) => ({ state: l.state, kind: l.kind, number: l.number, ...(l.expires ? { expires: l.expires } : {}) }));
  if (key === "serviceArea") return parseServiceArea(client.serviceArea ?? []);
  return str(v);
}

/** Where the checklist looks for the states and tracks the client files in: its service area (the
 *  draft's when it has one) and its own jobs. */
function checklistJurisdictions(db: AppDb, clientId: string, area: ClientServiceAreaEntry[]): ReadinessJurisdiction[] {
  const rows = db.query<{ state: string; ahj: string; city: string; utility: string }>(
    "SELECT DISTINCT state, ahj, city, utility FROM projects WHERE client_id = ?", [clientId],
  );
  const fromJobs = rows.map((r) => ({ state: str(r.state), ahj: str(r.ahj) || str(r.city), utility: str(r.utility), source: "existing projects" }))
    .filter((j) => j.state || j.ahj || j.utility);
  return [...jurisdictionsFromServiceArea(area), ...fromJobs];
}

/** The record as the page would leave it: the draft's non-blank answers over what is on file, with
 *  list answers ADDED (the accept rule). */
function overlaid(client: ClientRecord, draft: Record<string, FieldValue>): ClientRecord {
  const out = { ...client } as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(draft)) {
    if (isEmptyValue(v)) continue;
    if (k === "stateLicenses") out.stateLicenses = mergeLicenceAdds(client.stateLicenses ?? [], v as ClientStateLicense[]).merged;
    else if (k === "serviceArea") out.serviceArea = mergeServiceArea(client.serviceArea ?? [], v);
    else out[k] = v;
  }
  return out as unknown as ClientRecord;
}

function checklistFor(db: AppDb, client: ClientRecord, draft: Record<string, FieldValue>): ChecklistLine[] {
  const view = overlaid(client, draft);
  return clientOnboardingChecklist(view, checklistJurisdictions(db, client.id, parseServiceArea(view.serviceArea ?? [])));
}

export interface OnboardingFileView { id: string; kind: string; fileName: string; sizeBytes: number; createdAt: string }

function filesFor(db: AppDb, clientId: string, linkId?: string): OnboardingFileView[] {
  const rows = db.query<{ id: string; kind: string; file_name: string; size_bytes: number; created_at: string }>(
    `SELECT id, kind, file_name, size_bytes, created_at FROM client_onboarding_files WHERE client_id = ?${linkId ? " AND link_id = ?" : ""} ORDER BY created_at`,
    linkId ? [clientId, linkId] : [clientId],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, fileName: r.file_name, sizeBytes: Number(r.size_bytes), createdAt: r.created_at }));
}

/** HOW THE CLIENT FILES WITH EACH AUTHORITY (clientFilingStatements.ts): the page asks about the
 *  authorities the client's service area names. Which those are is resolved by the caller (server.ts
 *  hands in filingDestinationProposals.clientFilingAuthorities, so this module reads no proposal and
 *  no door); without it the page asks about none. */
export interface OnboardingContext {
  filingAuthorities?: (clientId: string, draftArea: ClientServiceAreaEntry[]) => FilingAuthorityOption[];
}
/** What the page is told about an authority: its name, kind and state. Nothing on file about it. */
export interface OnboardingFilingAuthority { key: string; kind: "ahj" | "utility"; name: string; state: string }
const FILING_KEY = "filing";

function filingAuthoritiesFor(ctx: OnboardingContext | undefined, clientId: string, draftArea: unknown): FilingAuthorityOption[] {
  if (!ctx?.filingAuthorities) return [];
  try { return ctx.filingAuthorities(clientId, parseServiceArea(Array.isArray(draftArea) ? draftArea : [])); } catch { return []; }
}
const publicAuthorities = (list: FilingAuthorityOption[]): OnboardingFilingAuthority[] => list.map((a) => ({ key: a.key, kind: a.kind, name: a.name, state: a.state }));
/** The page's answers without the filing rows, and the filing rows as sent. */
function splitFiling(fields: Record<string, unknown>): { rest: Record<string, unknown>; filing: unknown } {
  const { [FILING_KEY]: filing, ...rest } = fields;
  return { rest, filing };
}

export interface OnboardingPublicView {
  status: "open" | "submitted";
  companyName: string;
  expiresAt: string;
  submittedAt: string | null;
  draftSavedAt: string | null;
  /** The page's questions (labels and types). */
  fields: Array<{ key: string; label: string; group: string; type: string; hint?: string }>;
  licenceKinds: Array<{ kind: string; label: string }>;
  fileKinds: readonly string[];
  /** The answers to show: the draft over what is on file. Absent once submitted. */
  values?: Record<string, FieldValue>;
  files?: OnboardingFileView[];
  /** What is still missing, in plain words. */
  checklist: ChecklistLine[];
  portalRequestsLeft: number;
  /** The authorities the page asks "how do you file here?" about. Absent once submitted. */
  filingAuthorities?: OnboardingFilingAuthority[];
  /** The filing rows as typed (the draft). Absent once submitted. */
  filing?: Array<Record<string, string>>;
}

/** What the page renders. Scoped to the token's client; carries nothing from any other client and
 *  never a secret (the page asks for none, and the record's secret columns are not page fields). */
export function getOnboardingPublic(db: AppDb, token: string, ctx?: OnboardingContext): OnboardingPublicView {
  const row = linkFor(db, token, "read");
  const client = getClient(db, row.client_id);
  const saved = splitFiling(parseDraft(row.draft_json));
  const draft = normalizeOnboardingFields(saved.rest).values;
  const base = {
    companyName: client.companyName || client.legalBusinessName,
    expiresAt: row.expires_at,
    submittedAt: row.submitted_at,
    draftSavedAt: row.draft_saved_at,
    fields: ONBOARDING_FIELDS.map((f) => ({ key: String(f.key), label: f.label, group: f.group, type: f.type, ...(f.hint ? { hint: f.hint } : {}) })),
    licenceKinds: ONBOARDING_LICENCE_KINDS,
    fileKinds: ONBOARDING_FILE_KINDS,
    checklist: checklistFor(db, client, row.status === "submitted" ? {} : draft),
    portalRequestsLeft: Math.max(0, ONBOARDING_PORTAL_REQUESTS_PER_LINK - Number(row.portal_requests || 0)),
  };
  if (row.status === "submitted") return { status: "submitted", ...base };
  // The page shows what was TYPED (a half-filled licence or place row survives a reload), reduced to
  // the row's own string keys; the checklist above reads the checked values.
  const typed = parseDraft(row.draft_json);
  const rowsOf = (v: unknown, keys: string[]): Array<Record<string, string>> =>
    (Array.isArray(v) ? v : []).slice(0, 300).map((r) => Object.fromEntries(keys.map((k) => [k, oneLine((r as Record<string, unknown>)?.[k], 120)])));
  const values: Record<string, FieldValue> = {};
  for (const f of ONBOARDING_FIELDS) {
    const k = String(f.key);
    if (!(k in draft)) values[k] = recordValue(client, k);
    else if (f.type === "licences") values[k] = rowsOf(typed[k], ["state", "kind", "number", "expires"]) as unknown as ClientStateLicense[];
    else if (f.type === "serviceArea") values[k] = rowsOf(typed[k], ["kind", "state", "name"]) as unknown as ClientServiceAreaEntry[];
    else values[k] = draft[k];
  }
  const authorities = filingAuthoritiesFor(ctx, client.id, draft.serviceArea);
  return {
    status: "open", ...base, values, files: filesFor(db, client.id, row.id),
    filingAuthorities: publicAuthorities(authorities), filing: normalizeFilingAnswers(saved.filing, authorities).typed,
  };
}

/** Save the client's work in progress. Secret-shaped input is refused outright; a value that is not
 *  yet right is kept (it is a draft) and named in `problems`. */
export function saveOnboardingDraft(db: AppDb, token: string, body: unknown, ctx?: OnboardingContext): { savedAt: string; problems: string[]; checklist: ChecklistLine[]; filingAuthorities: OnboardingFilingAuthority[] } {
  const row = linkFor(db, token, "write");
  const sent = bodyFields(body);
  assertNoSecretShapes(sent, "fields");
  const { rest: fields, filing: filingRaw } = splitFiling(sent);
  const { values, problems } = normalizeOnboardingFields(fields);
  if (problems.some((p) => /is not a question on this page|Send the answers/.test(p))) throw new HttpError(400, problems[0]);
  // The draft keeps what was TYPED (so a half-finished licence row survives a reload), capped.
  const kept: Record<string, unknown> = {};
  for (const k of Object.keys(values)) kept[k] = (fields as Record<string, unknown>)[k];
  // The filing rows are checked against the authorities the area names NOW (stored, plus the places
  // typed in this draft); a row that is not right yet is kept as typed and named in `problems`.
  const authorities = filingAuthoritiesFor(ctx, row.client_id, values.serviceArea);
  const filing = normalizeFilingAnswers(filingRaw, authorities);
  if (filing.typed.length) kept[FILING_KEY] = filing.typed;
  problems.push(...filing.problems);
  const json = JSON.stringify(kept);
  if (json.length > 200_000) throw new HttpError(413, "That is more than this page can save. Remove some rows and try again.");
  const savedAt = nowIso();
  db.run("UPDATE client_onboarding_links SET draft_json = ?, draft_saved_at = ? WHERE id = ?", [json, savedAt, row.id]);
  const client = getClient(db, row.client_id);
  return { savedAt, problems, checklist: checklistFor(db, client, values), filingAuthorities: publicAuthorities(authorities) };
}

function bodyFields(body: unknown): Record<string, unknown> {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  for (const k of Object.keys(b)) if (k !== "fields") throw new HttpError(400, `"${k.slice(0, 40)}" is not part of this page.`);
  const f = b.fields;
  if (f == null) return {};
  if (typeof f !== "object" || Array.isArray(f)) throw new HttpError(400, "Send the answers as fields.");
  return f as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Submit: answers become proposals. Nothing here writes the client row.
// ---------------------------------------------------------------------------

/** Licences to ADD to what is on file (state + number identifies one; a known licence's new kind or
 *  expiry counts as a change). The merged list keeps every stored row. */
function mergeLicenceAdds(stored: ClientStateLicense[], incoming: ClientStateLicense[]): { adds: ClientStateLicense[]; merged: ClientStateLicense[] } {
  const norm = (n: string): string => n.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const key = (l: ClientStateLicense): string => `${l.state}|${norm(l.number)}`;
  const current = parseStateLicenses(stored);
  const byKey = new Map(current.map((l) => [key(l), l]));
  const adds: ClientStateLicense[] = [];
  for (const l of incoming) {
    const had = byKey.get(key(l));
    if (had && had.kind === l.kind && (had.expires ?? "") === (l.expires ?? (had.expires ?? ""))) continue;
    adds.push(l);
  }
  const merged = [...current];
  for (const a of adds) {
    const i = merged.findIndex((l) => key(l) === key(a));
    if (i >= 0) merged[i] = { ...merged[i], ...a };
    else merged.push(a);
  }
  return { adds, merged };
}

function serviceAreaAdds(stored: ClientServiceAreaEntry[], incoming: ClientServiceAreaEntry[]): ClientServiceAreaEntry[] {
  const have = new Set(parseServiceArea(stored).map(serviceAreaEntryKey));
  return incoming.filter((e) => !have.has(serviceAreaEntryKey(e)));
}

export function submitOnboarding(db: AppDb, token: string, body: unknown, ctx?: OnboardingContext): { submitted: true; proposals: number; filingAnswers: number; checklist: ChecklistLine[] } {
  const row = linkFor(db, token, "write");
  // The submitted answers are the body's, else the saved draft's (a page may submit what it saved).
  const sent = bodyFields(body);
  const all = Object.keys(sent).length ? sent : parseDraft(row.draft_json);
  assertNoSecretShapes(all, "fields");
  const { rest: fields, filing: filingRaw } = splitFiling(all);
  const { values, problems } = normalizeOnboardingFields(fields);
  // HOW THEY FILE: each answer names an authority the area (stored, or sent with this form) names.
  const authorities = filingAuthoritiesFor(ctx, row.client_id, values.serviceArea);
  const filing = normalizeFilingAnswers(filingRaw, authorities);
  problems.push(...filing.problems);
  if (problems.length) throw new HttpError(400, `Not sent yet: ${problems.slice(0, 5).join(" ")}`, { problems });
  const client = getClient(db, row.client_id);
  const now = nowIso();
  let proposals = 0;
  let filingAnswers = 0;
  db.transaction(() => {
    for (const f of ONBOARDING_FIELDS) {
      const k = String(f.key);
      if (!(k in values) || isEmptyValue(values[k])) continue; // a blank answer never blanks a stored value
      let proposed: FieldValue = values[k];
      const current = recordValue(client, k);
      if (k === "stateLicenses") proposed = mergeLicenceAdds(client.stateLicenses ?? [], proposed as ClientStateLicense[]).adds;
      else if (k === "serviceArea") proposed = serviceAreaAdds(client.serviceArea ?? [], proposed as ClientServiceAreaEntry[]);
      else if (str(proposed) === str(current)) continue;
      if (isEmptyValue(proposed)) continue;
      // The newest answer for a field is the one a person reviews; an older pending one is superseded.
      db.run("UPDATE client_onboarding_proposals SET status = 'superseded', decided_at = ? WHERE client_id = ? AND field = ? AND status = 'pending'", [now, client.id, k]);
      db.run(
        `INSERT INTO client_onboarding_proposals (id, client_id, link_id, field, proposed_json, current_json, source, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'client-supplied', 'pending', ?)`,
        [id(), client.id, row.id, k, JSON.stringify(proposed), JSON.stringify(current), now],
      );
      proposals++;
    }
    // Stored as the CLIENT's word only (never a door): the Destinations queue shows each as a
    // "client-supplied" proposal for a named person, or as a conflict beside a verified door.
    filingAnswers = recordFilingStatements(db, { clientId: client.id, linkId: row.id, answers: filing.answers, authorities, now });
    db.run("UPDATE client_onboarding_links SET status = 'submitted', submitted_at = ?, draft_json = ?, draft_saved_at = ? WHERE id = ?", [now, JSON.stringify({ ...fields, ...(filing.typed.length ? { [FILING_KEY]: filing.typed } : {}) }), now, row.id]);
  });
  // Counts only in the audit row, never a value.
  addAuditLog(db, null, "system", "client-onboarding", "client.onboarding_submitted", { clientId: client.id, linkId: row.id, proposals, filingAnswers });
  const orgId = db.get<{ org_id?: string }>("SELECT org_id FROM clients WHERE id = ?", [client.id])?.org_id || DEFAULT_ORG_ID;
  void alertStaffOnClientOnboarding(db, { orgId, linkId: row.id, companyName: client.companyName || client.legalBusinessName, proposals, files: filesFor(db, client.id, row.id).length, filingAnswers });
  return { submitted: true, proposals, filingAnswers, checklist: checklistFor(db, client, values) };
}

// ---------------------------------------------------------------------------
// Portal logins: hand off to the existing one-time credential link, unchanged.
// ---------------------------------------------------------------------------
const SECRET_QUERY = /token|key|secret|pass|pwd|auth|code|session|sid|sig/i;

/** The client names the portals it holds logins for; this mints the EXISTING one-time credential
 *  request for exactly those (createCredentialRequest, its own route, its own encryption, 72 h, one
 *  use) and returns its page. No login passes through here. */
export function requestOnboardingPortalLogins(db: AppDb, token: string, body: unknown): { path: string; portals: number; expiresAt: string } {
  const row = linkFor(db, token, "write");
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  for (const k of Object.keys(b)) if (k !== "portals") throw new HttpError(400, `"${k.slice(0, 40)}" is not part of this request.`);
  assertNoSecretShapes(b, "portals");
  const list = Array.isArray(b.portals) ? b.portals : [];
  if (!list.length) throw new HttpError(400, "Name at least one portal: its name and the address of its sign-in page.");
  if (list.length > ONBOARDING_PORTALS_PER_REQUEST) throw new HttpError(400, `At most ${ONBOARDING_PORTALS_PER_REQUEST} portals at a time.`);
  if (Number(row.portal_requests || 0) >= ONBOARDING_PORTAL_REQUESTS_PER_LINK) {
    throw new HttpError(429, "This link has made all the secure login requests it can. Ask your Keelix contact for help.");
  }
  const portals = list.map((p, i) => {
    const o = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    for (const k of Object.keys(o)) if (k !== "portalType" && k !== "portalUrl") throw new HttpError(400, `Portal ${i + 1}: only its name and address are asked here.`);
    const portalType = oneLine(o.portalType, 120);
    const rawUrl = str(o.portalUrl);
    let u: URL;
    try { u = new URL(rawUrl); } catch { throw new HttpError(400, `Portal ${i + 1}: enter the full address of its sign-in page (https://…).`); }
    if (u.protocol !== "https:") throw new HttpError(400, `Portal ${i + 1}: the address must start with https://.`);
    if (u.username || u.password) throw new HttpError(400, SECRET_REFUSAL);
    if ([...u.searchParams.keys()].some((k) => SECRET_QUERY.test(k)) || /[#&?](?:access_)?token=/i.test(u.hash)) throw new HttpError(400, `Portal ${i + 1}: copy the sign-in page's address without anything after the "?".`);
    if (deadLinkHostReason(u.hostname)) throw new HttpError(400, `Portal ${i + 1}: that is not a public website's address.`);
    if (!portalType) throw new HttpError(400, `Portal ${i + 1}: give the portal's name (for example, the city or utility it belongs to).`);
    return { portalType, portalUrl: `${u.origin}${u.pathname}${u.search}`.slice(0, 500) };
  });
  const made = createCredentialRequest(db, row.client_id, portals, { createdBy: `client-onboarding:${row.id}` });
  db.run("UPDATE client_onboarding_links SET portal_requests = portal_requests + 1 WHERE id = ?", [row.id]);
  // Counts only: no portal address, name or token in the audit row.
  addAuditLog(db, null, "system", "client-onboarding", "client.onboarding_portal_login_request", { clientId: row.client_id, linkId: row.id, portals: portals.length });
  return { path: `/credentials?token=${encodeURIComponent(made.token)}`, portals: portals.length, expiresAt: made.expiresAt };
}

// ---------------------------------------------------------------------------
// Certificates (optional uploads). Type and size capped, scoped to the client, never parsed, never
// sent to a model: staff open them from the Clients screen.
// ---------------------------------------------------------------------------
function sniffMime(bytes: Buffer): string {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return "";
}

function safeFileName(raw: unknown, mime: string): string {
  const ext = mime === "application/pdf" ? ".pdf" : mime === "image/png" ? ".png" : ".jpg";
  const base = str(raw).replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^A-Za-z0-9 ._-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${base || "certificate"}${ext}`;
}

export function addOnboardingFile(db: AppDb, token: string, input: { kind: unknown; fileName: unknown; bytes: unknown }): OnboardingFileView {
  const row = linkFor(db, token, "write");
  const kind = str(input.kind) as OnboardingFileKind;
  if (!(ONBOARDING_FILE_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "Choose what the certificate is.");
  if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) throw new HttpError(400, "Choose a PDF, PNG or JPEG file.");
  const bytes = input.bytes as Buffer;
  if (bytes.length > ONBOARDING_FILE_MAX_BYTES) throw new HttpError(413, `A certificate can be at most ${ONBOARDING_FILE_MAX_BYTES / 1024 / 1024} MB.`);
  const mime = sniffMime(bytes);
  if (!mime) throw new HttpError(415, "Only a PDF, PNG or JPEG file can be uploaded here.");
  const count = Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM client_onboarding_files WHERE link_id = ?", [row.id])?.n ?? 0);
  if (count >= ONBOARDING_FILES_PER_LINK) throw new HttpError(400, `At most ${ONBOARDING_FILES_PER_LINK} certificates. Remove one first.`);
  assertNoSecretShapes(str(input.fileName), "fileName");
  const fileId = id();
  const view = { id: fileId, kind, fileName: safeFileName(input.fileName, mime), sizeBytes: bytes.length, createdAt: nowIso() };
  db.run(
    `INSERT INTO client_onboarding_files (id, client_id, link_id, kind, file_name, mime, size_bytes, sha256, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [fileId, row.client_id, row.id, kind, view.fileName, mime, bytes.length, createHash("sha256").update(bytes).digest("hex"), bytes, view.createdAt],
  );
  return view;
}

export function removeOnboardingFile(db: AppDb, token: string, fileId: string): { removed: boolean } {
  const row = linkFor(db, token, "write");
  // The link's own uploads only: a token never names another client's (or another link's) file.
  const where = [String(fileId), row.id, row.client_id];
  if (!db.get("SELECT id FROM client_onboarding_files WHERE id = ? AND link_id = ? AND client_id = ?", where)) throw new HttpError(404, "No such certificate on this link.");
  db.run("DELETE FROM client_onboarding_files WHERE id = ? AND link_id = ? AND client_id = ?", where);
  return { removed: true };
}

/** Staff: one certificate's bytes (the route is under /api/clients/:id, scope-guarded). */
export function getOnboardingFile(db: AppDb, clientId: string, fileId: string): { fileName: string; mime: string; bytes: Buffer } {
  const r = db.get<{ file_name: string; mime: string; bytes: Buffer }>(
    "SELECT file_name, mime, bytes FROM client_onboarding_files WHERE id = ? AND client_id = ?", [fileId, clientId],
  );
  if (!r) throw new HttpError(404, "No such certificate.");
  return { fileName: r.file_name, mime: r.mime, bytes: Buffer.from(r.bytes) };
}

// ---------------------------------------------------------------------------
// Staff review: accept (as sent or edited) or reject. The accept is the ONLY write to the client row.
// ---------------------------------------------------------------------------
interface ProposalRow {
  id: string; client_id: string; link_id: string; field: string; proposed_json: string; current_json: string;
  source: string; status: string; created_at: string; decided_by: string; decided_at: string | null; applied_json: string;
}

export interface OnboardingProposalView {
  id: string; field: string; label: string; type: string; source: string; status: string;
  proposed: unknown; current: unknown; createdAt: string; decidedBy: string; decidedAt: string | null;
}

const parseJson = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return null; } };

export function listOnboardingProposals(db: AppDb, clientId: string, opts: { all?: boolean } = {}): { proposals: OnboardingProposalView[]; files: OnboardingFileView[]; links: OnboardingLinkView[]; filingStatements: FilingStatement[] } {
  const rows = db.query<ProposalRow>(
    `SELECT * FROM client_onboarding_proposals WHERE client_id = ?${opts.all ? "" : " AND status = 'pending'"} ORDER BY created_at DESC, rowid`,
    [clientId],
  );
  const order = new Map(ONBOARDING_FIELDS.map((f, i) => [String(f.key), i]));
  const proposals = rows
    .map((r) => ({
      id: r.id, field: r.field, label: FIELD_BY_KEY.get(r.field)?.label ?? r.field, type: FIELD_BY_KEY.get(r.field)?.type ?? "text",
      source: r.source, status: r.status, proposed: parseJson(r.proposed_json), current: parseJson(r.current_json),
      createdAt: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at,
    }))
    .sort((a, b) => (order.get(a.field) ?? 99) - (order.get(b.field) ?? 99));
  // How the client says it files with each authority: its word, decided in Destinations to confirm.
  return { proposals, files: filesFor(db, clientId), links: listOnboardingLinks(db, clientId), filingStatements: listFilingStatements(db, clientId) };
}

/**
 * A named person decides. `accept` ids apply as sent; `edits` (id → value) apply the person's value
 * instead (scalar fields only; it passes the same checks); `reject` ids are closed unapplied. All or
 * nothing: one bad edit refuses the whole decision, nothing written. Each decision is audited with the
 * field name and whether it was edited — never the value.
 */
export function decideOnboardingProposals(
  db: AppDb,
  clientId: string,
  input: { accept?: unknown; reject?: unknown; edits?: unknown },
  decidedBy: string,
): { accepted: number; rejected: number; client: ClientRecord } {
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
  const acceptIds = new Set(ids(input.accept));
  const rejectIds = new Set(ids(input.reject));
  const edits = input.edits && typeof input.edits === "object" && !Array.isArray(input.edits) ? (input.edits as Record<string, unknown>) : {};
  for (const k of Object.keys(edits)) acceptIds.add(k);
  for (const k of acceptIds) if (rejectIds.has(k)) throw new HttpError(400, "A proposal cannot be both accepted and rejected.");
  const wanted = [...acceptIds, ...rejectIds];
  if (!wanted.length) throw new HttpError(400, "Choose at least one answer to accept or reject.");
  const rows = new Map(
    db.query<ProposalRow>(`SELECT * FROM client_onboarding_proposals WHERE client_id = ? AND status = 'pending' AND id IN (${wanted.map(() => "?").join(", ")})`, [clientId, ...wanted])
      .map((r) => [r.id, r]),
  );
  for (const w of wanted) if (!rows.has(w)) throw new HttpError(404, "That answer is no longer waiting (decided, superseded, or not this client's). Reload and try again.");

  // Build the one update payload first; any problem refuses everything.
  const client = getClient(db, clientId);
  const payload: Record<string, unknown> = {};
  const applied = new Map<string, { value: unknown; edited: boolean }>();
  const problems: string[] = [];
  for (const pid of acceptIds) {
    const r = rows.get(pid)!;
    const f = FIELD_BY_KEY.get(r.field);
    if (!f) { problems.push(`${r.field} is not a field this page writes.`); continue; }
    const edited = Object.prototype.hasOwnProperty.call(edits, pid);
    if (edited && (f.type === "licences" || f.type === "serviceArea")) { problems.push(`${f.label}: accept or reject the list; change it afterwards in the editor.`); continue; }
    const raw = edited ? edits[pid] : parseJson(r.proposed_json);
    const value = normalizeField(f, raw, problems);
    if (isEmptyValue(value)) { problems.push(`${f.label}: an accepted answer cannot be blank (reject it instead).`); continue; }
    if (f.type === "licences") payload.stateLicenses = mergeLicenceAdds(client.stateLicenses ?? [], value as ClientStateLicense[]).merged;
    else if (f.type === "serviceArea") payload.serviceArea = mergeServiceArea(client.serviceArea ?? [], value);
    else payload[r.field] = value;
    applied.set(pid, { value, edited });
  }
  if (problems.length) throw new HttpError(400, problems.slice(0, 5).join(" "), { problems });

  const now = nowIso();
  const out = db.transaction(() => {
    const saved = Object.keys(payload).length ? updateClient(db, clientId, payload) : getClient(db, clientId);
    for (const [pid, a] of applied) {
      db.run("UPDATE client_onboarding_proposals SET status = ?, decided_by = ?, decided_at = ?, applied_json = ? WHERE id = ?",
        [a.edited ? "edited" : "accepted", decidedBy, now, JSON.stringify(a.value), pid]);
      addAuditLog(db, null, "human", decidedBy, "client.onboarding_proposal_accepted", { clientId, proposalId: pid, field: rows.get(pid)!.field, edited: a.edited });
    }
    for (const pid of rejectIds) {
      db.run("UPDATE client_onboarding_proposals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?", [decidedBy, now, pid]);
      addAuditLog(db, null, "human", decidedBy, "client.onboarding_proposal_rejected", { clientId, proposalId: pid, field: rows.get(pid)!.field });
    }
    return saved;
  });
  return { accepted: applied.size, rejected: rejectIds.size, client: out };
}

/** Every pending proposal of the client — what "accept all" sends. */
export function pendingOnboardingProposalIds(db: AppDb, clientId: string): string[] {
  return db.query<{ id: string }>("SELECT id FROM client_onboarding_proposals WHERE client_id = ? AND status = 'pending'", [clientId]).map((r) => r.id);
}
