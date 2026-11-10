// SAFETY RULE 2 — ONE SCAN AT THE ONE DOOR WHERE A REQUEST LEAVES FOR A MODEL.
//
// Before this module, rule 2 was kept by each prompt builder on its own: buildPortalPlanner strips
// secret fields, redactSecretValues scrubs the planner digest, visionPageMask paints account/meter
// digits out of page images (#293/#612). Every other builder (reviewer, vision text, triage, the
// correction agent's tool results, web/code/fee research) relied on nobody ever handing it a
// secret. CLAUDE.md rule 2 said so in as many words: "a payload scan across EVERY prompt builder ...
// is still to come". This is that scan.
//
// WHERE IT SITS. Not in any builder: at the model CLIENT. Every Anthropic client in the product is
// built by createModelClient() below, which wraps the SDK so that every send method
// (messages.create / stream / parse / countTokens, the same on beta.messages, and batches.create)
// passes its params through scanModelRequest() first. A builder cannot forget to call it, and a
// new builder gets it for free. modelPayloadScan.test pins that no source file outside this module
// constructs `new Anthropic(` or posts to the Messages API by hand.
//
// WHAT IT LOOKS FOR, in every TEXT part of the request (system, every message, tool inputs the
// history replays, tool results the provider forwards, tool descriptions):
//   1. KNOWN values — the job's project (account, meter, and every parser-snapshot value under a
//      secret key: ESI/SA/agreement/application ids, SSN) and the tenant's stored portal passwords
//      (the project's client; the org's clients when only the org is known), plus process secrets
//      (env values named *_API_KEY / *_SECRET / *_TOKEN / *_PASSWORD ...). Matched exactly the way
//      redactSecretValues matches (digits with any separator ignored, fullwidth forms, alphanumeric
//      ids), and a stored password also as an exact literal even when it carries no digit.
//   2. SECRET-SHAPED text nobody told us about — a labelled account / meter / ESI / SA number, an
//      SSN, a "password: ..." assignment, API keys, bearer tokens, JWTs, private-key blocks.
// Base64 image/document data is NOT read here: images are masked before they get this far
// (#293/#612). Provider-signed or server-produced blocks (thinking, redacted_thinking, server tool
// use and its results) are passed through untouched — editing them breaks their signatures, and
// what they hold is the model's own output or the public web, not something we added.
//
// WHAT IT DOES ON A HIT: replaces the value with "[redacted]" (the same token redactSecretValues
// writes; never ADDS prompt text — PLANNER_USER_TOKEN_BUDGET is untouched), writes ONE audit row
// naming the builder (the call label) and the KIND of each field (never the value), logs a WARN,
// and — under tests (MODEL_PAYLOAD_SCAN_STRICT=1, which scripts/run-unit-tests.ts sets for every
// suite) — THROWS ModelPayloadLeakError so a leak fails loudly instead of being quietly fixed up.
// There is deliberately no switch that turns the scan off.
//
// THE ONE ALLOWED READ (rule 2, operator wording 2026-09-25): INTAKE may read the customer's own
// document (bill, meter photo) to find the account/meter. It is recognised by BOTH of:
//   - the call was made inside withIntakeDocumentRead() (purpose INTAKE_DOCUMENT_READ), which only
//     ClaudeLLMProvider.extractProjectFields and .extractProjectFieldsFromImages wrap themselves in;
//   - the call's label is one of INTAKE_READ_TASKS (exactly those two tasks).
// Either alone exempts nothing. And the exemption covers ONLY the identifiers the read exists to
// find — account, meter and utility ids (ESI/SA/agreement) — never an SSN, a portal password, a
// "password:" assignment or a credential token, which are redacted even inside an intake call.
// The intake response is not logged: recordLlmCall keeps only tokens/stop/latency, and the one
// response sample written on a parse failure (normalizeExtraction) masks digit runs already.
import Anthropic from "@anthropic-ai/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { redactSecretValues } from "../../shared/src/portalSafety";
import { decryptStorageState } from "../../portal-bot/src/cryptoStorage";
import { addAuditLog } from "./audit";
import { currentLlmContext, llmCallStoreDb } from "./llmAccounting";
import { logger } from "./logger";
import { taskForLabel } from "./modelRouting";
import { isPlannerSecretKey } from "./projectSecrets";

export const REDACTED = "[redacted]";
export const MODEL_PAYLOAD_AUDIT_ACTION = "model_payload_redacted";

/** The KIND of a secret — what the audit row names. Never the value. */
export type SecretKind =
  | "account"
  | "meter"
  | "utility-id"
  | "ssn"
  | "portal-password"
  | "password"
  | "credential-token";

export interface KnownSecret { kind: SecretKind; value: string }

/** The kinds the intake read exists to find. Nothing else is ever exempt. */
export const INTAKE_READABLE_KINDS: ReadonlySet<SecretKind> = new Set<SecretKind>(["account", "meter", "utility-id"]);

/** The call purpose that marks rule 2's one allowed read. */
export const INTAKE_DOCUMENT_READ = "intake-customer-document" as const;
export type ModelCallPurpose = typeof INTAKE_DOCUMENT_READ;

/** The only tasks whose calls the intake purpose can exempt (modelRouting.LLM_TASKS names). */
export const INTAKE_READ_TASKS: ReadonlySet<string> = new Set(["extractProjectFields", "extractProjectFieldsFromImages"]);

// ---------------------------------------------------------------------------------------------
// The call scope: which builder is sending, for what purpose, and any secrets the caller holds
// that the job context cannot supply (a classifyCorrection handed a project object).
// ---------------------------------------------------------------------------------------------

interface ModelCallScope { label?: string; purpose?: ModelCallPurpose; secrets?: KnownSecret[] }
const scope = new AsyncLocalStorage<ModelCallScope>();

/** Run `fn` with `add` layered over the current scope (secrets accumulate; label/purpose override). */
export function runInModelCallScope<T>(add: ModelCallScope, fn: () => T): T {
  const cur = scope.getStore() ?? {};
  return scope.run({ ...cur, ...add, secrets: [...(cur.secrets ?? []), ...(add.secrets ?? [])] }, fn);
}

/** Mark the calls inside `fn` as the intake read of the customer's own document. Exempts only an
 *  INTAKE_READ_TASKS label, and only the INTAKE_READABLE_KINDS. */
export function withIntakeDocumentRead<T>(fn: () => T): T {
  return runInModelCallScope({ purpose: INTAKE_DOCUMENT_READ }, fn);
}

/** Add secrets the caller holds (e.g. a project object passed in) to every scan inside `fn`. */
export function withModelSecrets<T>(secrets: KnownSecret[], fn: () => T): T {
  return runInModelCallScope({ secrets }, fn);
}

// ---------------------------------------------------------------------------------------------
// Known values
// ---------------------------------------------------------------------------------------------

/** Which kind a parser/field key's value is (the key already passed isPlannerSecretKey). */
export function secretKindForKey(key: string): SecretKind {
  if (/ssn|social/i.test(key)) return "ssn";
  if (/passw/i.test(key)) return "portal-password";
  if (/meter/i.test(key)) return "meter";
  if (/\besi\b|esiid|service\s*agreement|agreement|application/i.test(key)) return "utility-id";
  return "account";
}

/** Every secret on a project, with its kind: the canonical account/meter plus every parser-snapshot
 *  value under a secret key (the same set projectSecretValues returns, kinds added). */
export function projectKnownSecrets(project: { accountNumber?: unknown; meterNumber?: unknown; parserSnapshot?: unknown } | null | undefined): KnownSecret[] {
  if (!project) return [];
  const out: KnownSecret[] = [];
  const add = (kind: SecretKind, v: unknown) => {
    const s = v == null ? "" : String(v).trim();
    if (s.length >= 4) out.push({ kind, value: s });
  };
  add("account", project.accountNumber);
  add("meter", project.meterNumber);
  const snap = (project.parserSnapshot || {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(snap)) {
    if ((typeof v === "string" || typeof v === "number") && isPlannerSecretKey(k)) add(secretKindForKey(k), v);
  }
  return out;
}

/** Decrypted portal-credential blobs, keyed by the ciphertext itself (a re-saved password is a new
 *  key). scrypt costs tens of ms per blob, and a learn run makes 18-80 model calls, so each blob is
 *  decrypted once per process. The bot already holds these passwords in memory to log in. */
const credentialCache = new Map<string, string[]>();
const CREDENTIAL_CACHE_MAX = 500;

function credentialSecretValues(blob: string): string[] {
  const hit = credentialCache.get(blob);
  if (hit) return hit;
  let values: string[] = [];
  try {
    const d = decryptStorageState(blob) as Record<string, unknown> | null;
    if (d && typeof d === "object") {
      // Everything in the blob but the username (identity the portal shows, not a secret).
      values = Object.entries(d)
        .filter(([k, v]) => k !== "username" && typeof v === "string" && v.trim().length >= 4)
        .map(([, v]) => String(v));
    }
  } catch {
    values = []; // no key in this process, or a blob from another key: nothing to match
  }
  if (credentialCache.size >= CREDENTIAL_CACHE_MAX) credentialCache.clear();
  credentialCache.set(blob, values);
  return values;
}

/** Test seam: forget decrypted credentials (a test that rotates SESSION_ENCRYPTION_KEY). */
export function clearModelScanCredentialCache(): void { credentialCache.clear(); }

/** The job's and tenant's known secrets, read from the job/route context (llmAccounting). */
function contextKnownSecrets(): KnownSecret[] {
  const ctx = currentLlmContext();
  const db = llmCallStoreDb();
  if (!ctx || !db) return [];
  const out: KnownSecret[] = [];
  try {
    let clientIds: string[] = [];
    if (ctx.projectId) {
      const row = db.get<{ account_number: string; meter_number: string; parser_json: string; client_id: string | null }>(
        "SELECT account_number, meter_number, parser_json, client_id FROM projects WHERE id = ?", [ctx.projectId]);
      if (row) {
        let parserSnapshot: unknown = {};
        try { parserSnapshot = row.parser_json ? JSON.parse(row.parser_json) : {}; } catch { parserSnapshot = {}; }
        out.push(...projectKnownSecrets({ accountNumber: row.account_number, meterNumber: row.meter_number, parserSnapshot }));
        if (row.client_id) clientIds = [row.client_id];
      }
    } else if (ctx.orgId) {
      clientIds = db.query<{ id: string }>("SELECT id FROM clients WHERE org_id = ?", [ctx.orgId]).map((r) => r.id);
    }
    for (const clientId of clientIds) {
      const creds = db.query<{ encrypted_secret: string }>(
        "SELECT encrypted_secret FROM portal_credentials WHERE client_id = ? AND encrypted_secret != ''", [clientId]);
      for (const c of creds) for (const v of credentialSecretValues(c.encrypted_secret)) out.push({ kind: "portal-password", value: v });
    }
  } catch (err) {
    logger.warn("llm", "model payload scan could not read the job's known secrets — pattern scan only", { err: err instanceof Error ? err.message : String(err) });
  }
  return out;
}

/** The process's own secrets: env values whose NAME says they are one. */
const PROCESS_SECRET_NAME = /(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|PRIVATE_KEY|ENCRYPTION_KEY)$/i;
function processKnownSecrets(env: NodeJS.ProcessEnv = process.env): KnownSecret[] {
  const out: KnownSecret[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 12 || !PROCESS_SECRET_NAME.test(name)) continue;
    out.push({ kind: "credential-token", value });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Secret-shaped patterns. Each keeps its label (prefix group `p`) and replaces the value (`v`).
// ---------------------------------------------------------------------------------------------

/** 5+ digits with single separators between them (space, dash, dot) — an identifier, not "240 V". */
const ID_VALUE = "(?<v>[0-9](?:[ .\\-\\u2010-\\u2015\\u2212]?[0-9]){4,}[A-Za-z]?)";
const LABEL_TAIL = "\\s*(?:number|num|no\\.?|#|id|serial)?\\s*[:#.]?\\s*";

interface ShapePattern { kind: SecretKind; re: RegExp; check?: (v: string) => boolean }
const hasDigits = (n: number) => (v: string) => (v.match(/[0-9]/g) ?? []).length >= n;

export const SECRET_SHAPED_PATTERNS: readonly ShapePattern[] = [
  // Labelled utility identifiers. Meter needs a qualifier ("meter 200A" is a rating, not an id).
  { kind: "utility-id", re: new RegExp(`(?<p>\\b(?:esi\\s*-?\\s*id|esiid|service\\s+agreement(?:\\s+id)?|sa\\s*(?:id|#|no\\.?|number))\\s*[:#.]?\\s*)${ID_VALUE}`, "gi"), check: hasDigits(5) },
  { kind: "account", re: new RegExp(`(?<p>\\b(?:account|acct)\\b${LABEL_TAIL})${ID_VALUE}`, "gi"), check: hasDigits(5) },
  { kind: "meter", re: new RegExp(`(?<p>\\bmeter\\s*(?:number|num|no\\.?|#|serial|id)\\s*[:#.]?\\s*|\\bmeter\\s*:\\s*)${ID_VALUE}`, "gi"), check: hasDigits(5) },
  // SSN: labelled (any 9 digits), or the unlabelled 3-2-4 dashed shape outside the never-issued ranges.
  { kind: "ssn", re: /(?<p>\b(?:ssn|social\s+security(?:\s+(?:number|no\.?|#))?)\s*[:#.]?\s*)(?<v>\d{3}[- ]?\d{2}[- ]?\d{4})\b/gi },
  { kind: "ssn", re: /(?<p>(?<![\d-]))(?<v>(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4})(?![\d-])/g },
  // A password written out. Masks ("********") and words ("Password: Forgot?") are not secrets:
  // the value must carry a digit, or mixed case AND a symbol that is not just closing punctuation.
  {
    kind: "password",
    re: /(?<p>\b(?:password|passwd|passcode|pwd)\b\s*(?:is\b|=|:)\s*)(?<v>[^\s"'<>]{6,})/gi,
    check: (v) => {
      const core = v.replace(/[?.!,;:)\]]+$/, "");
      return /\d/.test(core) || (/[a-z]/.test(core) && /[A-Z]/.test(core) && /[^A-Za-z0-9]/.test(core));
    },
  },
  // Credentials of any service.
  { kind: "credential-token", re: /(?<p>)(?<v>\bsk-ant-[A-Za-z0-9_-]{16,})/g },
  { kind: "credential-token", re: /(?<p>)(?<v>\bsk-[A-Za-z0-9]{32,}\b)/g },
  { kind: "credential-token", re: /(?<p>)(?<v>\bAKIA[0-9A-Z]{16}\b)/g },
  { kind: "credential-token", re: /(?<p>)(?<v>\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}))/g },
  { kind: "credential-token", re: /(?<p>)(?<v>\bxox[abprs]-[A-Za-z0-9-]{10,})/g },
  { kind: "credential-token", re: /(?<p>)(?<v>-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$))/g },
  { kind: "credential-token", re: /(?<p>)(?<v>\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g },
  { kind: "credential-token", re: /(?<p>\bBearer\s+)(?<v>[A-Za-z0-9._~+/=-]{20,})/g },
];

// ---------------------------------------------------------------------------------------------
// The scan of one string
// ---------------------------------------------------------------------------------------------

type Hits = Map<SecretKind, number>;
const bump = (hits: Hits, kind: SecretKind) => hits.set(kind, (hits.get(kind) ?? 0) + 1);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Scan one text: known values first (redactSecretValues' matching, plus an exact literal for a
 *  stored password), then the secret-shaped patterns. `exempt` kinds are left as they are. */
export function scanText(text: string, known: readonly KnownSecret[], exempt: ReadonlySet<SecretKind>, hits: Hits): string {
  if (!text) return text;
  let out = text;
  const byKind = new Map<SecretKind, string[]>();
  for (const s of known) {
    if (exempt.has(s.kind)) continue;
    const list = byKind.get(s.kind) ?? [];
    list.push(s.value);
    byKind.set(s.kind, list);
  }
  for (const [kind, values] of byKind) {
    out = redactSecretValues(out, values, () => { bump(hits, kind); return REDACTED; });
    if (kind === "portal-password" || kind === "credential-token") {
      // redactSecretValues needs a digit (or 5+ digits) to match; a stored password need not have one.
      for (const v of values) {
        const lit = v.trim();
        if (lit.length < 6 || lit === REDACTED) continue;
        out = out.replace(new RegExp(escapeRe(lit), "g"), () => { bump(hits, kind); return REDACTED; });
      }
    }
  }
  for (const pat of SECRET_SHAPED_PATTERNS) {
    if (exempt.has(pat.kind)) continue;
    out = out.replace(pat.re, (m: string, ...args: unknown[]) => {
      const groups = args[args.length - 1] as { p?: string; v?: string };
      const v = groups?.v ?? "";
      if (!v || (pat.check && !pat.check(v))) return m;
      bump(hits, pat.kind);
      return `${groups.p ?? ""}${REDACTED}`;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The walk over a Messages API request
// ---------------------------------------------------------------------------------------------

/** Blocks the API signs, encrypts or produced itself: passed through untouched. */
function isPassThroughBlock(type: unknown): boolean {
  if (typeof type !== "string") return false;
  if (type === "thinking" || type === "redacted_thinking" || type === "server_tool_use") return true;
  // web_search_tool_result, web_fetch_tool_result, code_execution_tool_result ... (server-side tools,
  // whose payload is encrypted or the public web). The client's own "tool_result" is scanned.
  return type !== "tool_result" && type.endsWith("_tool_result");
}

/** Structural keys of an API block: never text a builder wrote. */
const BLOCK_STRUCTURAL_KEYS = new Set(["type", "id", "tool_use_id", "name", "media_type", "cache_control", "signature", "encrypted_content", "encrypted_index", "citations", "is_error"]);

type Where = Set<string>;

class Walker {
  constructor(private known: readonly KnownSecret[], private exempt: ReadonlySet<SecretKind>, readonly hits: Hits, readonly where: Where) {}

  private text(s: string, at: string): string {
    const before = this.total();
    const out = scanText(s, this.known, this.exempt, this.hits);
    if (this.total() > before) this.where.add(at);
    return out;
  }
  private total(): number { let n = 0; for (const v of this.hits.values()) n += v; return n; }

  /** Every string leaf, no key skipped (a tool_use input, a document's text). */
  deep(v: unknown, at: string): unknown {
    if (typeof v === "string") return this.text(v, at);
    if (Array.isArray(v)) return v.map((x) => this.deep(x, at));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = this.deep(x, at);
      return o;
    }
    return v;
  }

  content(c: unknown, at: string): unknown {
    if (typeof c === "string") return this.text(c, at);
    if (Array.isArray(c)) return c.map((b) => this.block(b, at));
    return c;
  }

  block(b: unknown, at: string): unknown {
    if (!b || typeof b !== "object") return typeof b === "string" ? this.text(b, at) : b;
    const blk = b as Record<string, unknown>;
    const type = blk.type;
    if (isPassThroughBlock(type)) return b;
    const out: Record<string, unknown> = { ...blk };
    switch (type) {
      case "text":
        if (typeof blk.text === "string") out.text = this.text(blk.text, at);
        return out;
      case "tool_use":
        out.input = this.deep(blk.input, "tool_input");
        return out;
      case "tool_result":
        out.content = this.content(blk.content, "tool_result");
        return out;
      case "image":
      case "document": {
        const src = blk.source as Record<string, unknown> | undefined;
        // base64 bytes are masked upstream (#293/#612) — never decoded here.
        if (src && src.type === "text" && typeof src.data === "string") out.source = { ...src, data: this.text(src.data, at) };
        else if (src && src.type === "content") out.source = { ...src, content: this.content(src.content, at) };
        for (const k of ["title", "context"]) if (typeof blk[k] === "string") out[k] = this.text(blk[k] as string, at);
        return out;
      }
      default:
        for (const [k, x] of Object.entries(blk)) {
          if (BLOCK_STRUCTURAL_KEYS.has(k) || k === "source") continue;
          out[k] = this.deep(x, at);
        }
        return out;
    }
  }
}

export interface ModelPayloadScanRecord {
  at: number;
  /** The builder: the call label (a modelRouting task, maybe with a "#n" / "[who]" suffix). */
  label: string;
  task: string | null;
  purpose: ModelCallPurpose | null;
  /** True when this call was the recognised intake read (purpose AND label). */
  intakeRead: boolean;
  /** Kind → count of redactions. Never a value. */
  kinds: Partial<Record<SecretKind, number>>;
  /** Which parts of the request held them: system / message / tool_input / tool_result / tools. */
  where: string[];
}

export class ModelPayloadLeakError extends Error {
  constructor(readonly record: ModelPayloadScanRecord) {
    super(`model payload scan (rule 2): ${record.label} tried to send ${Object.entries(record.kinds).map(([k, n]) => `${k}×${n}`).join(", ")} in ${record.where.join(", ")} — redacted; failing loudly because MODEL_PAYLOAD_SCAN_STRICT=1`);
    this.name = "ModelPayloadLeakError";
  }
}

const RECENT_MAX = 500;
const recent: ModelPayloadScanRecord[] = [];
/** Every scan this process made since `sinceMs` (clean ones too): the builder table test reads it
 *  to prove each request was labelled and scanned. */
export function recentModelPayloadScans(sinceMs = 0): ModelPayloadScanRecord[] {
  return recent.filter((r) => r.at >= sinceMs);
}

export function modelPayloadScanIsStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MODEL_PAYLOAD_SCAN_STRICT === "1";
}

/** THE SCAN. Returns the params to send (a redacted copy when anything hit; the caller's objects are
 *  never mutated, so a history it re-sends is re-scanned the same way and the prompt cache's prefix
 *  stays byte-identical turn to turn). */
export function scanModelRequest<P>(params: P): P {
  if (!params || typeof params !== "object") return params;
  const sc = scope.getStore() ?? {};
  const rawLabel = sc.label || "(unlabelled)";
  const task = taskForLabel(rawLabel);
  const intakeRead = sc.purpose === INTAKE_DOCUMENT_READ && task !== null && INTAKE_READ_TASKS.has(task);
  const exempt: ReadonlySet<SecretKind> = intakeRead ? INTAKE_READABLE_KINDS : new Set<SecretKind>();
  const known = [...contextKnownSecrets(), ...(sc.secrets ?? []), ...processKnownSecrets()];
  // A label can be built from caller data (fee research names the AHJ in it): it is scrubbed too
  // before it is written anywhere, so the audit row never carries a value through the builder's name.
  const label = scanText(rawLabel, known, new Set<SecretKind>(), new Map());
  const hits: Hits = new Map();
  const where: Where = new Set();
  const w = new Walker(known, exempt, hits, where);

  const p = params as Record<string, unknown>;
  const out: Record<string, unknown> = { ...p };
  if (p.system !== undefined) out.system = w.content(p.system, "system");
  if (Array.isArray(p.messages)) {
    out.messages = p.messages.map((m) => {
      if (!m || typeof m !== "object") return m;
      const msg = m as Record<string, unknown>;
      return { ...msg, content: w.content(msg.content, "message") };
    });
  }
  if (Array.isArray(p.tools)) {
    out.tools = p.tools.map((t) => {
      if (!t || typeof t !== "object") return t;
      const tool = t as Record<string, unknown>;
      return typeof tool.description === "string" ? { ...tool, description: w.content(tool.description, "tools") } : tool;
    });
  }

  const record: ModelPayloadScanRecord = {
    at: Date.now(), label, task, purpose: sc.purpose ?? null, intakeRead,
    kinds: Object.fromEntries(hits) as Partial<Record<SecretKind, number>>,
    where: [...where],
  };
  recent.push(record);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  if (hits.size === 0) return params;

  logger.warn("llm", `rule 2: model payload scan redacted secrets from ${label}`, { kinds: record.kinds, where: record.where, purpose: record.purpose });
  const db = llmCallStoreDb();
  if (db) {
    const ctx = currentLlmContext();
    const details = { builder: label, task, purpose: record.purpose, kinds: record.kinds, where: record.where, jobId: ctx?.jobId ?? null };
    try {
      addAuditLog(db, ctx?.projectId ?? null, "system", "modelPayloadScan", MODEL_PAYLOAD_AUDIT_ACTION, details);
    } catch {
      // A project id the audit FK cannot see (deleted mid-run): keep the row, unattached.
      try { addAuditLog(db, null, "system", "modelPayloadScan", MODEL_PAYLOAD_AUDIT_ACTION, { ...details, projectId: ctx?.projectId ?? null }); }
      catch (err) { logger.error("llm", "model payload scan could not write its audit row", { label, err: err instanceof Error ? err.message : String(err) }); }
    }
  }
  if (modelPayloadScanIsStrict()) {
    // LOUD EVEN WHEN SWALLOWED. Many builders degrade on any error (a research call returns
    // found:false, the planner an empty plan), which would hide the throw. The runner reads a
    // "FAIL - " line or a non-zero exit as red, so a leak fails the suite whoever catches it.
    const err = new ModelPayloadLeakError(record);
    console.error(`  FAIL - ${err.message}`);
    process.exitCode = 1;
    throw err;
  }
  return out as P;
}

// ---------------------------------------------------------------------------------------------
// The client: THE ONE PLACE an Anthropic client is constructed.
// ---------------------------------------------------------------------------------------------

const SEND_METHODS = new Set(["create", "stream", "parse", "countTokens"]);
const guarded = new WeakMap<object, object>();

function memo<T extends object>(target: T, make: (t: T) => T): T {
  const hit = guarded.get(target);
  if (hit) return hit as T;
  const p = make(target);
  guarded.set(target, p);
  return p;
}

function guardBatches<T extends object>(res: T): T {
  return memo(res, (r) => new Proxy(r, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t);
      if (typeof v !== "function") return v;
      if (prop === "create") {
        return (body: { requests?: Array<{ params?: unknown }> }, ...rest: unknown[]) =>
          v.call(t, { ...body, requests: (body?.requests ?? []).map((q) => ({ ...q, params: scanModelRequest(q.params) })) }, ...rest);
      }
      return v.bind(t);
    },
  }));
}

function guardMessages<T extends object>(res: T): T {
  return memo(res, (r) => new Proxy(r, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t);
      if (prop === "batches" && v && typeof v === "object") return guardBatches(v as object);
      if (typeof v !== "function") return v;
      if (typeof prop === "string" && SEND_METHODS.has(prop)) {
        return (params: unknown, ...rest: unknown[]) => v.call(t, scanModelRequest(params), ...rest);
      }
      return v.bind(t);
    },
  }));
}

function refuseUnscanned<T extends object>(res: T, name: string): T {
  return memo(res, (r) => new Proxy(r, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t);
      if (typeof v !== "function") return v;
      if (prop === "create") return () => { throw new Error(`${name}.create bypasses the rule-2 model payload scan; use messages`); };
      return v.bind(t);
    },
  }));
}

/** Wrap an SDK client so every request it sends is scanned first. */
export function guardModelClient(client: Anthropic): Anthropic {
  return memo(client as unknown as object, (c) => new Proxy(c, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t);
      if (prop === "messages" && v && typeof v === "object") return guardMessages(v as object);
      if (prop === "completions" && v && typeof v === "object") return refuseUnscanned(v as object, "completions");
      if (prop === "beta" && v && typeof v === "object") {
        return memo(v as object, (b) => new Proxy(b, {
          get(bt, bp) {
            const bv = Reflect.get(bt, bp, bt);
            if (bp === "messages" && bv && typeof bv === "object") return guardMessages(bv as object);
            return typeof bv === "function" ? bv.bind(bt) : bv;
          },
        }));
      }
      return typeof v === "function" ? v.bind(t) : v;
    },
  })) as unknown as Anthropic;
}

/** THE ONE CONSTRUCTOR of a model client in the product (modelPayloadScan.test pins it). */
export function createModelClient(options: ConstructorParameters<typeof Anthropic>[0]): Anthropic {
  return guardModelClient(new Anthropic(options));
}
