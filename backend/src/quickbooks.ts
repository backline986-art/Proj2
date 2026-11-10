// ---------------------------------------------------------------------------
// QUICKBOOKS ONLINE PUSH (#701). SAFETY-CRITICAL: a new stored credential and the first outbound
// write to an external system of record.
//
// WHAT IT DOES, AND ONLY THIS
//   - Connect ONE QuickBooks company per org (OAuth2), by a named person's click.
//   - "Send to QuickBooks": a named person's click creates the QuickBooks invoice for one of our
//     invoices, ONCE. The client becomes a QuickBooks Customer (id saved on the client); each line
//     maps to one of three Items a PERSON chose in settings (service fee, pass-through fee, onboarding
//     fee). The QuickBooks id is saved in client_invoices.external_ref, which is UNIQUE.
//   - Once a day, READ the payment status of the invoices already sent, and record it here.
//
// WHAT IT NEVER DOES
//   - Never charges a card, takes a payment, or asks QuickBooks to email the customer (rule 1 in
//     spirit: money moves only by a person). The invoice is created with no email status and the
//     send endpoint is never called; emailing stays a person's click inside QuickBooks.
//   - Never pushes on a schedule: the only scheduled work is the read-only status read.
//   - Never touches the network when QUICKBOOKS_SYNC is not "1": every entry point that would
//     call out refuses first (pinned by a test that fails on any fetch).
//   - Never writes a token anywhere but the encrypted envelope in quickbooks_connections, never logs
//     one, never returns one to the browser, and nothing outside this module reads that column (a
//     test fences it, so no prompt builder can reach it: rule 2).
//
// IDEMPOTENT ON OUR INVOICE ID. Three layers, so a double click, a retry or a restart creates no
// second QuickBooks invoice: (1) an invoice with external_ref set is never sent again; (2) the push
// claims the row (qb_push_started_at) inside a transaction before any network call, and a second
// claim within the window is refused; (3) the create carries `requestid=<our invoice id>`, which
// QuickBooks answers with the SAME invoice on a repeat, and before creating we look for an invoice
// already carrying our number (DocNumber) and adopt it.
//
// Universal: nothing here knows a utility, state or price. The Items are data a person picks.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import type { AppDb } from "./db";
import { encryptStorageState, decryptStorageState } from "../../portal-bot/src/cryptoStorage";
import { HttpError } from "./httpError";
import { getClientInvoice, type ClientInvoice, type LedgerLine } from "./clientInvoices";
import { addAuditLog } from "./audit";
import { logger } from "./logger";
import { text } from "./json";
import { nowIso } from "./time";

type Row = Record<string, unknown>;

/** QUICKBOOKS_SYNC=1 turns this on. Anything else, including unset, is OFF: zero network. */
export function quickBooksSyncOn(): boolean {
  return String(process.env.QUICKBOOKS_SYNC ?? "").trim() === "1";
}

function requireSyncOn(): void {
  if (!quickBooksSyncOn()) {
    throw new HttpError(409, "QuickBooks sync is off (QUICKBOOKS_SYNC is not 1). Nothing was sent to QuickBooks.");
  }
}

// ── transport (injectable so tests run against a local mock server) ───────────────────────
export interface QuickBooksTransport {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
}
const DEFAULT_TRANSPORT: QuickBooksTransport = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
let transport: QuickBooksTransport = DEFAULT_TRANSPORT;
/** Tests only: route every call to a mock, and make backoff instant. */
export function setQuickBooksTransport(t: Partial<QuickBooksTransport> | null): void {
  transport = t ? { ...DEFAULT_TRANSPORT, ...t } : DEFAULT_TRANSPORT;
}

// ── configuration ────────────────────────────────────────────────────────────────────────
// Intuit's published endpoints. QUICKBOOKS_AUTH_URL / _TOKEN_URL / _API_BASE override them (the mock
// server in tests; nothing in a test ever names an Intuit host).
function endpoints(): { authUrl: string; tokenUrl: string; apiBase: string } {
  const sandbox = String(process.env.QUICKBOOKS_ENVIRONMENT || "").toLowerCase() === "sandbox";
  return {
    authUrl: process.env.QUICKBOOKS_AUTH_URL || "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: process.env.QUICKBOOKS_TOKEN_URL || "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    apiBase: (process.env.QUICKBOOKS_API_BASE || (sandbox ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com")).replace(/\/+$/, ""),
  };
}
const MINOR_VERSION = "75";
const SCOPE = "com.intuit.quickbooks.accounting";

function appCredentials(): { clientId: string; clientSecret: string } {
  const clientId = String(process.env.QUICKBOOKS_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.QUICKBOOKS_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    throw new HttpError(409, "QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET are not set. Create the app in the Intuit developer portal first (docs in .env.example).");
  }
  return { clientId, clientSecret };
}

function redirectUri(): string {
  const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4173}`).replace(/\/+$/, "");
  return process.env.QUICKBOOKS_REDIRECT_URI || `${base}/api/quickbooks/oauth/callback`;
}

// ── the connection row ───────────────────────────────────────────────────────────────────
interface Tokens { accessToken: string; refreshToken: string }

function connectionRow(db: AppDb, orgId: string): Row | null {
  return db.get<Row>("SELECT * FROM quickbooks_connections WHERE org_id = ?", [orgId]);
}

function readTokens(row: Row): Tokens {
  const blob = text(row.encrypted_tokens);
  if (!blob) throw new HttpError(409, "QuickBooks is not connected for this organisation. A person connects it first.");
  const t = decryptStorageState(blob) as Partial<Tokens>;
  if (!t?.accessToken || !t?.refreshToken) throw new HttpError(409, "The stored QuickBooks connection is unreadable. Connect QuickBooks again.");
  return { accessToken: String(t.accessToken), refreshToken: String(t.refreshToken) };
}

function saveTokens(db: AppDb, orgId: string, tokens: Tokens, accessExpiresInS: number, refreshExpiresInS: number, extra: { realmId?: string; by?: string } = {}): void {
  const ts = nowIso();
  const now = Date.now();
  const accessExp = new Date(now + Math.max(60, accessExpiresInS || 3600) * 1000).toISOString();
  const refreshExp = refreshExpiresInS ? new Date(now + refreshExpiresInS * 1000).toISOString() : "";
  const envelope = encryptStorageState({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
  const existing = connectionRow(db, orgId);
  if (!existing) {
    db.run(
      `INSERT INTO quickbooks_connections (org_id, realm_id, encrypted_tokens, access_expires_at, refresh_expires_at, connected_by, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, text(extra.realmId), envelope, accessExp, refreshExp, text(extra.by), ts, ts],
    );
    return;
  }
  db.run(
    `UPDATE quickbooks_connections SET encrypted_tokens = ?, access_expires_at = ?,
       refresh_expires_at = CASE WHEN ? = '' THEN refresh_expires_at ELSE ? END,
       realm_id = CASE WHEN ? = '' THEN realm_id ELSE ? END,
       connected_by = CASE WHEN ? = '' THEN connected_by ELSE ? END,
       connected_at = CASE WHEN ? = '' THEN connected_at ELSE ? END,
       last_error = '', updated_at = ? WHERE org_id = ?`,
    [envelope, accessExp, refreshExp, refreshExp, text(extra.realmId), text(extra.realmId),
      text(extra.by), text(extra.by), text(extra.by), extra.by ? ts : "", ts, orgId],
  );
}

/** A provider error, reduced to what is safe to show and log: the status and Intuit's own short
 *  error code/message. A response body is never echoed whole, so a token can never ride along. */
async function safeProviderError(res: Response, what: string): Promise<HttpError> {
  let detail = "";
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const fault = (body.Fault ?? body.fault) as { Error?: Array<{ Message?: string; Detail?: string; code?: string }> } | undefined;
    const e = fault?.Error?.[0];
    detail = e ? [e.code, e.Message, e.Detail].filter(Boolean).join(": ") : text(body.error_description) || text(body.error);
  } catch { /* not JSON */ }
  return new HttpError(502, `QuickBooks ${what} failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}.`);
}

// ── status ───────────────────────────────────────────────────────────────────────────────
export interface QuickBooksStatus {
  syncOn: boolean;
  appConfigured: boolean;
  connected: boolean;
  realmId: string;
  connectedBy: string;
  connectedAt: string;
  refreshExpiresAt: string;
  items: {
    service: { id: string; name: string };
    passthrough: { id: string; name: string };
    onboarding: { id: string; name: string };
  };
  settingsBy: string;
  lastStatusSyncAt: string;
  lastError: string;
}

/** What the settings card shows. Never a token. No network. */
export function quickBooksStatus(db: AppDb, orgId: string): QuickBooksStatus {
  const row = connectionRow(db, orgId);
  return {
    syncOn: quickBooksSyncOn(),
    appConfigured: Boolean(String(process.env.QUICKBOOKS_CLIENT_ID || "").trim() && String(process.env.QUICKBOOKS_CLIENT_SECRET || "").trim()),
    connected: Boolean(row && text(row.encrypted_tokens) && text(row.realm_id)),
    realmId: text(row?.realm_id),
    connectedBy: text(row?.connected_by),
    connectedAt: text(row?.connected_at),
    refreshExpiresAt: text(row?.refresh_expires_at),
    items: {
      service: { id: text(row?.service_item_id), name: text(row?.service_item_name) },
      passthrough: { id: text(row?.passthrough_item_id), name: text(row?.passthrough_item_name) },
      onboarding: { id: text(row?.onboarding_item_id), name: text(row?.onboarding_item_name) },
    },
    settingsBy: text(row?.settings_by),
    lastStatusSyncAt: text(row?.last_status_sync_at),
    lastError: text(row?.last_error),
  };
}

// ── connect / disconnect ─────────────────────────────────────────────────────────────────
const STATE_TTL_MS = 10 * 60 * 1000;

/** CONNECT, step 1: a named person asks; we mint a single-use state bound to their org and hand back
 *  Intuit's consent URL. No network. */
export function beginQuickBooksConnect(db: AppDb, orgId: string, by: string): { url: string } {
  requireSyncOn();
  const { clientId } = appCredentials();
  const state = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  db.run(
    "INSERT INTO quickbooks_oauth_states (state, org_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    [state, orgId, text(by).slice(0, 120), new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString()],
  );
  const params = new URLSearchParams({ client_id: clientId, response_type: "code", scope: SCOPE, redirect_uri: redirectUri(), state });
  return { url: `${endpoints().authUrl}?${params.toString()}` };
}

/** CONNECT, step 2: Intuit sends the browser back with code, state and realmId. The org comes from the
 *  state alone (single use, ten minutes), never from the request. */
export async function completeQuickBooksConnect(db: AppDb, input: { code?: unknown; state?: unknown; realmId?: unknown }): Promise<{ orgId: string; realmId: string }> {
  requireSyncOn();
  const code = text(input.code).trim();
  const state = text(input.state).trim();
  const realmId = text(input.realmId).trim();
  if (!code || !state || !realmId || !/^[0-9A-Za-z-]{1,40}$/.test(realmId)) throw new HttpError(400, "The QuickBooks callback is missing its code, state or company id.");
  const row = db.get<Row>("SELECT * FROM quickbooks_oauth_states WHERE state = ?", [state]);
  if (!row || text(row.used_at) || Date.parse(text(row.expires_at)) < Date.now()) {
    throw new HttpError(400, "This QuickBooks connect link is unknown, used or expired. Press Connect again.");
  }
  db.run("UPDATE quickbooks_oauth_states SET used_at = ? WHERE state = ?", [nowIso(), state]);
  const orgId = text(row.org_id);
  const existing = connectionRow(db, orgId);
  if (existing && text(existing.realm_id) && text(existing.realm_id) !== realmId && text(existing.encrypted_tokens)) {
    throw new HttpError(409, "This organisation is already connected to a different QuickBooks company. Disconnect it first: one company per organisation.");
  }
  const tokens = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() }, "connect");
  saveTokens(db, orgId, tokens.tokens, tokens.expiresIn, tokens.refreshExpiresIn, { realmId, by: text(row.created_by) });
  addAuditLog(db, null, "human", text(row.created_by) || "quickbooks", "quickbooks.connected", { orgId, realmId });
  return { orgId, realmId };
}

/** Disconnect: the tokens are deleted here. (Revoking the app's access is also possible inside
 *  QuickBooks; deleting locally means this app can no longer reach the company.) No network. */
export function disconnectQuickBooks(db: AppDb, orgId: string, by: string): QuickBooksStatus {
  db.run("UPDATE quickbooks_connections SET encrypted_tokens = '', access_expires_at = '', refresh_expires_at = '', realm_id = '', updated_at = ? WHERE org_id = ?", [nowIso(), orgId]);
  addAuditLog(db, null, "human", text(by) || "operator", "quickbooks.disconnected", { orgId });
  return quickBooksStatus(db, orgId);
}

async function tokenRequest(params: Record<string, string>, what: string): Promise<{ tokens: Tokens; expiresIn: number; refreshExpiresIn: number }> {
  const { clientId, clientSecret } = appCredentials();
  const res = await transport.fetch(endpoints().tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw await safeProviderError(res, what === "connect" ? "connection" : "token refresh");
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; x_refresh_token_expires_in?: number };
  if (!data.access_token || !data.refresh_token) throw new HttpError(502, `QuickBooks ${what} returned no tokens.`);
  return {
    tokens: { accessToken: data.access_token, refreshToken: data.refresh_token },
    expiresIn: Number(data.expires_in) || 3600,
    refreshExpiresIn: Number(data.x_refresh_token_expires_in) || 0,
  };
}

/** Refresh the access token (QuickBooks rotates the refresh token too; the new one is stored). */
async function refreshAccessToken(db: AppDb, orgId: string): Promise<Tokens> {
  const row = connectionRow(db, orgId);
  if (!row) throw new HttpError(409, "QuickBooks is not connected for this organisation.");
  const current = readTokens(row);
  try {
    const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: current.refreshToken }, "refresh");
    saveTokens(db, orgId, fresh.tokens, fresh.expiresIn, fresh.refreshExpiresIn);
    return fresh.tokens;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.run("UPDATE quickbooks_connections SET last_error = ?, updated_at = ? WHERE org_id = ?", [`${msg} Connect QuickBooks again if this repeats.`.slice(0, 400), nowIso(), orgId]);
    throw err;
  }
}

// ── the one request path ─────────────────────────────────────────────────────────────────
const MAX_429_RETRIES = 4;

/** Every API call goes through here: flag check, fresh token, one retry on 401 after a refresh, and
 *  backoff on 429 (Retry-After, else 1s, 2s, 4s, 8s). */
async function qbRequest(db: AppDb, orgId: string, method: "GET" | "POST", pathAndQuery: string, body?: unknown, what = "request"): Promise<Record<string, unknown>> {
  requireSyncOn();
  const row = connectionRow(db, orgId);
  if (!row || !text(row.realm_id)) throw new HttpError(409, "QuickBooks is not connected for this organisation. A person connects it first.");
  const realmId = text(row.realm_id);
  let tokens = readTokens(row);
  if (Date.parse(text(row.access_expires_at)) - Date.now() < 120_000) tokens = await refreshAccessToken(db, orgId);
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url = `${endpoints().apiBase}/v3/company/${encodeURIComponent(realmId)}${pathAndQuery}${sep}minorversion=${MINOR_VERSION}`;
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const res = await transport.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      tokens = await refreshAccessToken(db, orgId);
      continue;
    }
    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      const after = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000 * 2 ** attempt;
      logger.warn("quickbooks", `rate limited (429) on ${what}; waiting ${waitMs}ms before retry ${attempt + 1}/${MAX_429_RETRIES}`);
      await transport.sleep(waitMs);
      continue;
    }
    if (!res.ok) throw await safeProviderError(res, what);
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }
}

/** A value inside a QuickBooks query string literal. */
function qLit(v: string): string {
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

async function qbQuery(db: AppDb, orgId: string, query: string, what: string): Promise<Record<string, unknown>> {
  const out = await qbRequest(db, orgId, "GET", `/query?query=${encodeURIComponent(query)}`, undefined, what);
  return (out.QueryResponse ?? {}) as Record<string, unknown>;
}

// ── items (settings) ─────────────────────────────────────────────────────────────────────
export interface QuickBooksItem { id: string; name: string; type: string }

/** The company's active Items, for a person to choose from. Read-only. */
export async function listQuickBooksItems(db: AppDb, orgId: string): Promise<QuickBooksItem[]> {
  const qr = await qbQuery(db, orgId, "select Id, Name, Type, Active from Item where Active = true maxresults 1000", "item list");
  return ((qr.Item ?? []) as Array<Record<string, unknown>>).map((i) => ({ id: text(i.Id), name: text(i.Name), type: text(i.Type) }));
}

/** A PERSON picks which Item each kind of line posts to. The ids are checked against the company's
 *  own list (a read), and the names are kept so the screen can show them. Service and pass-through
 *  are required; onboarding only when an invoice carries an onboarding line. */
export async function saveQuickBooksItemSettings(
  db: AppDb,
  orgId: string,
  input: { serviceItemId?: unknown; passthroughItemId?: unknown; onboardingItemId?: unknown },
  by: string,
): Promise<QuickBooksStatus> {
  const service = text(input.serviceItemId).trim();
  const pass = text(input.passthroughItemId).trim();
  const onboarding = text(input.onboardingItemId).trim();
  if (!service || !pass) throw new HttpError(400, "Choose the Item for our service fee and the Item for pass-through fees.");
  if (service === pass) throw new HttpError(400, "Service fees and pass-through fees must post to different Items: pass-through money is not revenue.");
  const items = await listQuickBooksItems(db, orgId);
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const [label, idv] of [["service fee", service], ["pass-through fee", pass], ["onboarding fee", onboarding]] as const) {
    if (idv && !byId.has(idv)) throw new HttpError(400, `The ${label} Item is not an active Item in this QuickBooks company.`);
  }
  db.run(
    `UPDATE quickbooks_connections SET service_item_id = ?, service_item_name = ?, passthrough_item_id = ?, passthrough_item_name = ?,
       onboarding_item_id = ?, onboarding_item_name = ?, settings_by = ?, updated_at = ? WHERE org_id = ?`,
    [service, byId.get(service)!.name, pass, byId.get(pass)!.name, onboarding, onboarding ? byId.get(onboarding)!.name : "",
      text(by).slice(0, 120), nowIso(), orgId],
  );
  addAuditLog(db, null, "human", text(by) || "operator", "quickbooks.items_chosen", { orgId, service, passthrough: pass, onboarding });
  return quickBooksStatus(db, orgId);
}

// ── customer upsert ──────────────────────────────────────────────────────────────────────
function displayNameFor(client: Row): string {
  return (text(client.company_name) || text(client.legal_business_name) || text(client.id))
    .replace(/[\t\r\n]+/g, " ").replace(/:/g, " -").trim().slice(0, 100);
}

/** The client as a QuickBooks Customer: the saved id if there is one (its name and billing email kept
 *  in step), else an existing Customer with the same display name, else a new one. The id is saved. */
export async function upsertQuickBooksCustomer(db: AppDb, orgId: string, clientId: string, billTo: string): Promise<string> {
  const client = db.get<Row>("SELECT * FROM clients WHERE id = ?", [clientId]);
  if (!client) throw new HttpError(404, "Client not found.");
  const name = displayNameFor(client);
  const savedId = text(client.quickbooks_customer_id);
  if (savedId) {
    const got = await qbRequest(db, orgId, "GET", `/customer/${encodeURIComponent(savedId)}`, undefined, "customer read");
    const c = (got.Customer ?? {}) as Record<string, unknown>;
    const email = text((c.PrimaryEmailAddr as Record<string, unknown> | undefined)?.Address);
    if (text(c.DisplayName) !== name || (billTo && email !== billTo)) {
      await qbRequest(db, orgId, "POST", "/customer", {
        Id: savedId, SyncToken: text(c.SyncToken), sparse: true, DisplayName: name, CompanyName: name,
        ...(billTo ? { PrimaryEmailAddr: { Address: billTo } } : {}),
      }, "customer update");
    }
    return savedId;
  }
  const found = await qbQuery(db, orgId, `select Id, DisplayName from Customer where DisplayName = ${qLit(name)}`, "customer lookup");
  let customerId = text(((found.Customer ?? []) as Array<Record<string, unknown>>)[0]?.Id);
  if (!customerId) {
    const created = await qbRequest(db, orgId, "POST", "/customer", {
      DisplayName: name, CompanyName: name, ...(billTo ? { PrimaryEmailAddr: { Address: billTo } } : {}),
    }, "customer create");
    customerId = text((created.Customer as Record<string, unknown> | undefined)?.Id);
    if (!customerId) throw new HttpError(502, "QuickBooks did not return the new Customer's id.");
  }
  db.run("UPDATE clients SET quickbooks_customer_id = ? WHERE id = ?", [customerId, clientId]);
  return customerId;
}

// ── the push ─────────────────────────────────────────────────────────────────────────────
/** How long a push claim holds before a later click may re-try (and re-find) it. */
const PUSH_CLAIM_MS = 10 * 60 * 1000;

/** Which Item each of our line kinds posts to. A line already paid (the gate) or a payment-received
 *  line is not billed again, so it is not sent; it is noted on the invoice instead. */
function itemFor(line: LedgerLine, items: QuickBooksStatus["items"]): { id: string; name: string } | null {
  if (line.kind === "reimbursement") return items.passthrough;
  if (line.kind === "service") return items.service;
  if (line.kind === "onboarding") return items.onboarding;
  return null;
}

export function quickBooksLinesFor(inv: ClientInvoice, items: QuickBooksStatus["items"]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const l of inv.lines) {
    if (l.kind === "received" || l.alreadyPaid || l.amountUsd === 0) continue;
    const item = itemFor(l, items);
    if (!item?.id) {
      throw new HttpError(409, `Choose the QuickBooks Item for ${l.kind === "onboarding" ? "the onboarding fee" : l.kind === "service" ? "our service fee" : "pass-through fees"} in QuickBooks settings first.`);
    }
    const date = /^\d{4}-\d{2}-\d{2}/.test(l.eventAt) ? l.eventAt.slice(0, 10) : "";
    const desc = [l.projectLabel, l.description, l.provisional ? "(provisional: from the published schedule)" : ""].filter(Boolean).join(" — ").slice(0, 4000);
    out.push({
      DetailType: "SalesItemLineDetail",
      Amount: l.amountUsd,
      Description: desc,
      SalesItemLineDetail: {
        ItemRef: { value: item.id, name: item.name },
        Qty: 1,
        UnitPrice: l.amountUsd,
        ...(date ? { ServiceDate: date } : {}),
      },
    });
  }
  return out;
}

export interface QuickBooksPushResult {
  created: boolean;
  adopted: boolean;
  externalRef: string;
  invoice: ClientInvoice;
}

/**
 * "SEND TO QUICKBOOKS": a named person's click (the route requires one). Creates the QuickBooks invoice
 * for this one invoice, once. Never emails it, never takes a payment.
 */
export async function pushInvoiceToQuickBooks(db: AppDb, clientId: string, invoiceId: string, by: string): Promise<QuickBooksPushResult> {
  requireSyncOn();
  const inv = getClientInvoice(db, clientId, invoiceId);
  if (inv.externalRef) return { created: false, adopted: false, externalRef: inv.externalRef, invoice: inv };
  if (inv.status !== "draft" && inv.status !== "sent") {
    throw new HttpError(409, `Invoice ${inv.number} is ${inv.status}; only a draft or sent invoice goes to QuickBooks.`);
  }
  if (inv.dueTotalUsd < 0) throw new HttpError(409, `Invoice ${inv.number} totals below zero; a credit note is a person's job in QuickBooks.`);
  const clientRow = db.get<Row>("SELECT org_id FROM clients WHERE id = ?", [clientId]);
  const orgId = text(clientRow?.org_id) || "org-default";
  const status = quickBooksStatus(db, orgId);
  if (!status.connected) throw new HttpError(409, "QuickBooks is not connected for this organisation. A person connects it first.");
  const lines = quickBooksLinesFor(inv, status.items);
  if (!lines.length) throw new HttpError(409, `Invoice ${inv.number} has nothing still due to send to QuickBooks.`);

  // THE CLAIM, before any network call. A second click (or a second process) inside the window is refused.
  const claimedAt = nowIso();
  db.transaction(() => {
    const row = db.get<Row>("SELECT external_ref, qb_push_started_at FROM client_invoices WHERE id = ?", [invoiceId]);
    if (text(row?.external_ref)) throw new HttpError(409, `Invoice ${inv.number} is already in QuickBooks.`);
    const started = text(row?.qb_push_started_at);
    if (started && Date.now() - Date.parse(started) < PUSH_CLAIM_MS) {
      throw new HttpError(409, `Invoice ${inv.number} is already being sent to QuickBooks. Wait a few minutes before trying again.`);
    }
    db.run("UPDATE client_invoices SET qb_push_started_at = ? WHERE id = ?", [claimedAt, invoiceId]);
  });

  let externalRef = "";
  let adopted = false;
  let balance: number | null = null;
  try {
    const customerId = await upsertQuickBooksCustomer(db, orgId, clientId, inv.billTo);
    // A restart after QuickBooks created it but before we saved its id: find it by our number.
    const found = await qbQuery(db, orgId, `select Id, Balance, CustomerRef from Invoice where DocNumber = ${qLit(inv.number)}`, "invoice lookup");
    const prior = ((found.Invoice ?? []) as Array<Record<string, unknown>>)
      .find((i) => text((i.CustomerRef as Record<string, unknown> | undefined)?.value) === customerId);
    if (prior) {
      externalRef = text(prior.Id);
      balance = prior.Balance == null ? null : Number(prior.Balance);
      adopted = true;
    } else {
      const paidNote = inv.receivedTotalUsd > 0
        ? `Already paid before this invoice (not billed here): $${inv.receivedTotalUsd.toFixed(2)}.`
        : "";
      const created = await qbRequest(db, orgId, "POST", `/invoice?requestid=${encodeURIComponent(inv.id)}`, {
        CustomerRef: { value: customerId },
        DocNumber: inv.number,
        TxnDate: claimedAt.slice(0, 10),
        Line: lines,
        PrivateNote: `Ledger invoice ${inv.number} (${inv.id}), period ${inv.periodStart} to ${inv.periodEnd}.`.slice(0, 4000),
        ...(paidNote ? { CustomerMemo: { value: paidNote } } : {}),
        ...(inv.billTo ? { BillEmail: { Address: inv.billTo } } : {}),
        // EmailStatus is deliberately NOT set ("NotSet"): QuickBooks emails the customer only when a
        // person presses Send inside QuickBooks.
      }, "invoice create");
      const qbInv = (created.Invoice ?? {}) as Record<string, unknown>;
      externalRef = text(qbInv.Id);
      balance = qbInv.Balance == null ? null : Number(qbInv.Balance);
      if (!externalRef) throw new HttpError(502, "QuickBooks did not return the new invoice's id.");
    }
  } catch (err) {
    // A clean failure releases the claim so a person can retry now. (A crash leaves it to expire,
    // and the retry then finds the invoice by its number or QuickBooks answers the same requestid.)
    db.run("UPDATE client_invoices SET qb_push_started_at = '' WHERE id = ? AND qb_push_started_at = ?", [invoiceId, claimedAt]);
    throw err;
  }
  const ts = nowIso();
  db.run(
    `UPDATE client_invoices SET external_ref = ?, qb_pushed_by = ?, qb_pushed_at = ?, qb_status = 'open', qb_balance_usd = ?,
       qb_checked_at = ?, qb_push_started_at = '', updated_at = ? WHERE id = ?`,
    [externalRef, text(by).slice(0, 120), ts, balance, ts, ts, invoiceId],
  );
  addAuditLog(db, null, "human", text(by) || "operator", "invoice.quickbooks_sent", {
    clientId, invoiceId, number: inv.number, externalRef, adopted,
  });
  return { created: !adopted, adopted, externalRef, invoice: getClientInvoice(db, clientId, invoiceId) };
}

// ── the daily status read (read-only toward QuickBooks) ──────────────────────────────────
export interface QuickBooksStatusSync { checked: number; paid: number; partial: number; missing: number }

/**
 * READ the balance of every invoice this org sent to QuickBooks that is not yet paid or void here, and
 * record it. Balance 0 marks ours paid (the system of record says the money arrived); a partial payment
 * is recorded as partial; an invoice QuickBooks no longer has is flagged for a person. Nothing is
 * written to QuickBooks.
 */
export async function syncQuickBooksPaymentStatus(db: AppDb, orgId: string): Promise<QuickBooksStatusSync> {
  requireSyncOn();
  const rows = db.query<Row>(
    `SELECT i.id, i.external_ref FROM client_invoices i JOIN clients c ON c.id = i.client_id
      WHERE COALESCE(c.org_id, 'org-default') = ? AND i.external_ref != '' AND i.status IN ('draft', 'sent')`,
    [orgId],
  );
  const result: QuickBooksStatusSync = { checked: 0, paid: 0, partial: 0, missing: 0 };
  for (let i = 0; i < rows.length; i += 30) {
    const chunk = rows.slice(i, i + 30);
    const ids = chunk.map((r) => qLit(text(r.external_ref))).join(", ");
    const qr = await qbQuery(db, orgId, `select Id, Balance, TotalAmt from Invoice where Id in (${ids}) maxresults 30`, "payment status read");
    const byId = new Map(((qr.Invoice ?? []) as Array<Record<string, unknown>>).map((q) => [text(q.Id), q]));
    const ts = nowIso();
    for (const r of chunk) {
      result.checked++;
      const q = byId.get(text(r.external_ref));
      if (!q) {
        result.missing++;
        db.run("UPDATE client_invoices SET qb_status = 'not found in QuickBooks', qb_checked_at = ?, updated_at = ? WHERE id = ?", [ts, ts, text(r.id)]);
        continue;
      }
      const bal = Number(q.Balance);
      const total = Number(q.TotalAmt);
      if (Number.isFinite(bal) && bal <= 0 && Number.isFinite(total) && total > 0) {
        result.paid++;
        db.run(
          `UPDATE client_invoices SET qb_status = 'paid', qb_balance_usd = 0, qb_checked_at = ?, status = 'paid', paid_at = ?,
             paid_reference = ?, issued_at = CASE WHEN issued_at = '' THEN ? ELSE issued_at END, updated_at = ? WHERE id = ? AND status IN ('draft', 'sent')`,
          [ts, ts, `QuickBooks invoice ${text(r.external_ref)}: balance 0 on ${ts.slice(0, 10)}`, ts, ts, text(r.id)],
        );
        addAuditLog(db, null, "system", "quickbooks", "invoice.quickbooks_paid", { invoiceId: text(r.id), externalRef: text(r.external_ref) });
      } else {
        const partial = Number.isFinite(bal) && Number.isFinite(total) && bal < total;
        if (partial) result.partial++;
        db.run("UPDATE client_invoices SET qb_status = ?, qb_balance_usd = ?, qb_checked_at = ?, updated_at = ? WHERE id = ?",
          [partial ? "partly paid" : "open", Number.isFinite(bal) ? bal : null, ts, ts, text(r.id)]);
      }
    }
  }
  db.run("UPDATE quickbooks_connections SET last_status_sync_at = ?, last_error = '', updated_at = ? WHERE org_id = ?", [nowIso(), nowIso(), orgId]);
  return result;
}

/** One pass of the daily read, for every connected org. OFF (QUICKBOOKS_SYNC not 1) = does nothing at
 *  all and returns []. Reads only; never sends an invoice. */
export async function runQuickBooksDailyRead(db: AppDb): Promise<Array<QuickBooksStatusSync & { orgId: string }>> {
  if (!quickBooksSyncOn()) return [];
  const out: Array<QuickBooksStatusSync & { orgId: string }> = [];
  const orgs = db.query<Row>("SELECT org_id FROM quickbooks_connections WHERE encrypted_tokens != '' AND realm_id != ''");
  for (const o of orgs) {
    const orgId = text(o.org_id);
    try {
      const r = await syncQuickBooksPaymentStatus(db, orgId);
      out.push({ orgId, ...r });
      logger.info("quickbooks", `daily payment status read: ${r.checked} checked, ${r.paid} paid, ${r.partial} partly paid, ${r.missing} not found`, { orgId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.run("UPDATE quickbooks_connections SET last_error = ?, updated_at = ? WHERE org_id = ?", [msg.slice(0, 400), nowIso(), orgId]);
      logger.warn("quickbooks", `daily payment status read failed: ${msg}`, { orgId });
    }
  }
  return out;
}

/** Once a day (first pass five minutes after start). Reads only; never sends an invoice. */
export function startQuickBooksStatusScheduler(db: AppDb): void {
  const tick = (): void => { void runQuickBooksDailyRead(db); };
  setTimeout(tick, 5 * 60 * 1000).unref();
  setInterval(tick, 24 * 60 * 60 * 1000).unref();
}
