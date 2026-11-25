// ---------------------------------------------------------------------------
// HOW A CLIENT SAYS IT FILES WITH EACH AUTHORITY (brief: client-filing-details).
//
// On the Company setup page (clientOnboarding.ts) a client may say, for each authority its service
// area names (a permit issuer or a utility), how it files there today: the portal address or the
// intake email it uses, whether it already holds an account there (yes or no — NEVER the login), and
// optionally a recent permit or application number as an example.
//
// WHAT A STATEMENT IS, AND IS NOT:
//   · It is the CLIENT's word, stored on the client's own rows here (client_id; rule 6). It is never
//     verified and never official, and it is not a filing door: nothing that decides a channel,
//     stages a run, launches a portal or sends an email reads this table. The only readers are
//     filingDestinationProposals.ts (which shows it as a "client-supplied" proposal for a named
//     person to check) and the staff view of the client. clientFilingDetails.test pins the importers.
//   · It never replaces a person-verified door. Where a person's record already says where the
//     authority takes filings and the client says otherwise, the difference is shown as a conflict
//     for a person; the verified record is not touched.
//   · A person confirms a destination through the Destinations queue exactly as before
//     (decideFilingDestination, unchanged): a client-supplied proposal has no page of the authority's
//     and no words from it, so one-click Confirm is refused and the person states the destination as
//     their own check (the page they read and its words).
//   · Nothing here is logged or sent to a model; audit rows carry counts and the authority's name.
//
// Universal: any authority, any state. No city, utility, portal or state is named here.
// ---------------------------------------------------------------------------
import type { AppDb } from "./db";
import { addAuditLog } from "./audit";
import { deadLinkHostReason } from "./clientLinkGuard";
import { HttpError } from "./httpError";
import { id } from "./ids";
import { nowIso } from "./time";

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
const oneLine = (v: unknown, max: number): string => str(v).replace(/\s+/g, " ").slice(0, max);

export const FILING_ANSWERS_MAX = 120;
export type FilingStatementKind = "portal" | "email";
export type HasAccount = "yes" | "no" | "";

/** An authority the page may ask about: one the client's service area names. `key` is
 *  "<kind>|<profileKey>", the same key the Destinations queue uses. */
export interface FilingAuthorityOption { key: string; kind: "ahj" | "utility"; name: string; state: string; profileKey: string }

/** One checked answer, ready to store. */
export interface FilingAnswer {
  authorityKey: string;
  kind: FilingStatementKind;
  address: string;
  hasAccount: HasAccount;
  example: string;
}

export interface FilingStatement {
  id: string;
  clientId: string;
  authority: { kind: "ahj" | "utility"; name: string; state: string; profileKey: string };
  kind: FilingStatementKind;
  address: string;
  hasAccount: HasAccount;
  example: string;
  statedAt: string;
}

const EMAIL = /^[^\s@<>()",;:]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const EXAMPLE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9 .\-/#]{0,39}$/;
const SECRET_QUERY = /token|key|secret|pass|pwd|auth|code|session|sid|sig/i;

/** The portal address as an https URL without anything a sign-in link could carry; "" + why when it
 *  is not a public website's address. */
function portalAddress(raw: string): { url: string; problem: string } {
  const v = raw.replace(/[).,;]+$/, "");
  const withScheme = /^https?:\/\//i.test(v) ? v : /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]\S*)?$/i.test(v) ? `https://${v}` : "";
  let u: URL;
  try { u = new URL(withScheme); } catch { return { url: "", problem: "enter the portal's web address (for example https://permits.example.gov) or the email address applications go to" }; }
  if (u.username || u.password) return { url: "", problem: "copy the address without a user name or password in it" };
  if ([...u.searchParams.keys()].some((k) => SECRET_QUERY.test(k)) || /[#&?](?:access_)?token=/i.test(u.hash)) return { url: "", problem: 'copy the address without anything after the "?"' };
  if (!u.hostname.includes(".") || deadLinkHostReason(u.hostname)) return { url: "", problem: "that is not a public website's address" };
  return { url: `https://${u.host}${u.pathname === "/" ? "" : u.pathname}${u.search}`.slice(0, 400), problem: "" };
}

/**
 * What the page sent, checked. A row with nothing in it is dropped; a row that names no listed
 * authority, or whose address is neither a web address nor one email address, is named in `problems`
 * and left out. The typed rows (for a draft) are returned capped, as strings. Pure.
 */
export function normalizeFilingAnswers(raw: unknown, authorities: readonly FilingAuthorityOption[]): { answers: FilingAnswer[]; typed: Array<Record<string, string>>; problems: string[] } {
  const problems: string[] = [];
  if (raw == null) return { answers: [], typed: [], problems };
  if (!Array.isArray(raw)) return { answers: [], typed: [], problems: ["Send the filing answers as a list."] };
  if (raw.length > FILING_ANSWERS_MAX) return { answers: [], typed: [], problems: [`At most ${FILING_ANSWERS_MAX} filing answers.`] };
  const byKey = new Map(authorities.map((a) => [a.key, a]));
  const answers: FilingAnswer[] = [];
  const typed: Array<Record<string, string>> = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const o = r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : {};
    for (const k of Object.keys(o)) if (!["authorityKey", "address", "hasAccount", "example"].includes(k)) { problems.push("A filing answer carries only the address, the account yes/no and an example number."); break; }
    const row = { authorityKey: oneLine(o.authorityKey, 300), address: oneLine(o.address, 400), hasAccount: oneLine(o.hasAccount, 3).toLowerCase(), example: oneLine(o.example, 60) };
    if (!row.address && !row.hasAccount && !row.example) continue;
    typed.push(row);
    const a = byKey.get(row.authorityKey);
    if (!a) { problems.push("A filing answer names a place that is not in your service area. Add the place first."); continue; }
    if (seen.has(a.key)) continue; // one answer per authority: the first row wins
    seen.add(a.key);
    if (!["", "yes", "no"].includes(row.hasAccount)) { problems.push(`${a.name}: answer the account question with yes or no.`); continue; }
    if (row.example && !EXAMPLE_NUMBER.test(row.example)) { problems.push(`${a.name}: the example number is letters, digits, spaces and - / # . only.`); continue; }
    if (!row.address) { problems.push(`${a.name}: add the portal's web address or the email address applications go to, or clear the row.`); continue; }
    if (row.address.includes("@") && !/^https?:\/\//i.test(row.address)) {
      if (!EMAIL.test(row.address)) { problems.push(`${a.name}: "${row.address.slice(0, 80)}" is not one email address.`); continue; }
      answers.push({ authorityKey: a.key, kind: "email", address: row.address.toLowerCase(), hasAccount: row.hasAccount as HasAccount, example: row.example });
      continue;
    }
    const p = portalAddress(row.address);
    if (!p.url) { problems.push(`${a.name}: ${p.problem}.`); continue; }
    answers.push({ authorityKey: a.key, kind: "portal", address: p.url, hasAccount: row.hasAccount as HasAccount, example: row.example });
  }
  return { answers, typed: typed.slice(0, FILING_ANSWERS_MAX), problems };
}

/** Store the client's answers (the caller's transaction). The client's earlier answer for the same
 *  authority is superseded: the newest is the one a person sees. Returns how many were stored. */
export function recordFilingStatements(db: AppDb, input: { clientId: string; linkId: string; answers: readonly FilingAnswer[]; authorities: readonly FilingAuthorityOption[]; now?: string }): number {
  const byKey = new Map(input.authorities.map((a) => [a.key, a]));
  const now = input.now ?? nowIso();
  let n = 0;
  for (const ans of input.answers) {
    const a = byKey.get(ans.authorityKey);
    if (!a) continue;
    db.run("UPDATE client_filing_statements SET status = 'superseded' WHERE client_id = ? AND authority_kind = ? AND profile_key = ? AND status = 'current'", [input.clientId, a.kind, a.profileKey]);
    db.run(
      `INSERT INTO client_filing_statements (id, client_id, link_id, authority_kind, authority_state, authority_name, profile_key, kind, address, has_account, example_number, source, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'client-supplied', 'current', ?)`,
      [id(), input.clientId, input.linkId, a.kind, a.state, a.name, a.profileKey, ans.kind, ans.address, ans.hasAccount, ans.example, now],
    );
    n++;
  }
  return n;
}

interface Row { id: string; client_id: string; authority_kind: string; authority_state: string; authority_name: string; profile_key: string; kind: string; address: string; has_account: string; example_number: string; created_at: string }
const view = (r: Row): FilingStatement => ({
  id: str(r.id), clientId: str(r.client_id),
  authority: { kind: r.authority_kind === "utility" ? "utility" : "ahj", name: str(r.authority_name), state: str(r.authority_state), profileKey: str(r.profile_key) },
  kind: r.kind === "email" ? "email" : "portal", address: str(r.address),
  hasAccount: (["yes", "no"].includes(str(r.has_account)) ? str(r.has_account) : "") as HasAccount,
  example: str(r.example_number), statedAt: str(r.created_at),
});
const COLUMNS = "id, client_id, authority_kind, authority_state, authority_name, profile_key, kind, address, has_account, example_number, created_at";

/** THIS client's current statements about one authority. Reads only; [] on a database older than the
 *  table (the migration creates it; a read never does). */
export function filingStatementsFor(db: AppDb, clientId: string, authority: { kind: string; profileKey: string }): FilingStatement[] {
  if (!str(clientId)) return [];
  try {
    return db.query<Row>(
      `SELECT ${COLUMNS} FROM client_filing_statements WHERE client_id = ? AND authority_kind = ? AND profile_key = ? AND status = 'current' ORDER BY created_at DESC, id`,
      [clientId, authority.kind, authority.profileKey],
    ).map(view);
  } catch { return []; }
}

/** Every current statement of one client (the staff view of that client). Reads only. */
export function listFilingStatements(db: AppDb, clientId: string): FilingStatement[] {
  try {
    return db.query<Row>(`SELECT ${COLUMNS} FROM client_filing_statements WHERE client_id = ? AND status = 'current' ORDER BY authority_kind, authority_state, authority_name, id`, [clientId]).map(view);
  } catch { return []; }
}

/** A NAMED PERSON sets a client's statement aside (it was wrong, or the verified door stands): it
 *  stops being shown as a proposal or a conflict. The client's row only; no door is touched. */
export function dismissFilingStatement(db: AppDb, clientId: string, statementId: string, by: string): { dismissed: boolean } {
  const who = oneLine(by, 120);
  if (!who) throw new HttpError(400, "A client's filing answer is set aside by a named person.");
  const row = db.get<Row>(`SELECT ${COLUMNS} FROM client_filing_statements WHERE id = ? AND client_id = ? AND status = 'current'`, [str(statementId), clientId]);
  if (!row) return { dismissed: false };
  db.run("UPDATE client_filing_statements SET status = 'dismissed', dismissed_by = ?, dismissed_at = ? WHERE id = ? AND client_id = ?", [who, nowIso(), row.id, clientId]);
  addAuditLog(db, null, "human", who, "client.filing_statement_dismissed", { clientId, statementId: row.id, authorityKind: row.authority_kind, authority: row.authority_name, state: row.authority_state, kind: row.kind });
  return { dismissed: true };
}
