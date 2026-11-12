// QUICKBOOKS ONLINE PUSH (#701, SAFETY-CRITICAL) — against a LOCAL MOCK QuickBooks server only.
//
// Nothing here reaches Intuit, a sandbox company or any host but 127.0.0.1. Pinned:
//   (1) QUICKBOOKS_SYNC unset or 0 = ZERO network: every entry point refuses, and fetch is replaced by
//       one that fails the test if it is ever called.
//   (2) Connect: a single-use, expiring state binds the org; tokens are stored ENCRYPTED (the column
//       never holds a token's text); a used or unknown state is refused.
//   (3) Items are a person's choice from the company's own list; service and pass-through may not be
//       the same Item.
//   (4) Customer upsert: created once and its id saved on the client; an existing Customer with the
//       same name is adopted, not duplicated; a saved id is re-used.
//   (5) Send: lines map to the chosen Items with a service date, a person's negative onboarding credit
//       is carried, an already-paid / received line is NOT billed again, no email status is set, the
//       create carries requestid = our invoice id and DocNumber = our number.
//   (6) IDEMPOTENT: a second click creates nothing; a "restart" after QuickBooks created it but before
//       we saved its id adopts it by number; two clicks at once create one; an in-flight claim refuses;
//       external_ref is UNIQUE in the schema.
//   (7) Token refresh: an expiring access token is refreshed (refresh token rotated); a 401 refreshes
//       once and retries.
//   (8) 429: backs off (Retry-After) and retries, then succeeds.
//   (9) Daily read is read-only (GET only) and records paid / partly paid / not found.
//  (10) NO TOKEN in any log line, audit row, communication, API-visible status or error message.
//  (11) Fence: nothing outside quickbooks.ts (and its migration) names the token column, and no prompt
//       builder imports the module (rule 2).
//
//   npx tsx backend/test/quickbooksPush.test.ts
import "./_isolate"; // FIRST
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { REPO } from "./_isolate";

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) { failures++; console.error(`FAIL - ${name}${detail ? ` — ${detail}` : ""}`); }
  else console.log(`ok   - ${name}`);
};
const rejects = async (p: Promise<unknown>, re: RegExp): Promise<string> => {
  try { await p; return "did not reject"; } catch (err) { const m = err instanceof Error ? err.message : String(err); return re.test(m) ? "" : m; }
};
const throwsSync = (fn: () => unknown, re: RegExp): string => {
  try { fn(); return "did not throw"; } catch (err) { const m = err instanceof Error ? err.message : String(err); return re.test(m) ? "" : m; }
};

// ── capture every line written anywhere, to scan for tokens at the end ─────────────────────
const captured: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
  const orig = stream.write.bind(stream) as (...a: unknown[]) => boolean;
  (stream as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    captured.push(String(chunk));
    return orig(chunk, ...rest);
  };
}

// ── the mock QuickBooks server ─────────────────────────────────────────────────────────────
type Req = { method: string; path: string; query: URLSearchParams; body: string; auth: string };
const requests: Req[] = [];
const issuedTokens: string[] = [];
let tokenSeq = 0;
const mint = (kind: string): string => { const t = `${kind}-${++tokenSeq}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`; issuedTokens.push(t); return t; };
let validAccess = new Set<string>();
let validRefresh = new Set<string>();
const customers: Array<{ Id: string; DisplayName: string; SyncToken: string; PrimaryEmailAddr?: { Address: string } }> = [];
const invoices: Array<Record<string, unknown>> = [];
const byRequestId = new Map<string, Record<string, unknown>>();
let fail429 = 0;
let fail401Once = false;
let tokenFailBody: Record<string, unknown> | null = null;
const ITEMS = [
  { Id: "11", Name: "Filing service fee", Type: "Service", Active: true },
  { Id: "12", Name: "Permit & portal fee (pass-through)", Type: "Service", Active: true },
  { Id: "13", Name: "Client onboarding fee", Type: "Service", Active: true },
];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    requests.push({ method: req.method || "", path: url.pathname, query: url.searchParams, body, auth: String(req.headers.authorization || "") });
    const json = (status: number, obj: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(obj));
    };
    if (url.pathname === "/oauth/token") {
      if (tokenFailBody) return json(400, tokenFailBody);
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "refresh_token" && !validRefresh.has(p.get("refresh_token") || "")) return json(400, { error: "invalid_grant" });
      if (p.get("grant_type") === "refresh_token") validRefresh.delete(p.get("refresh_token") || "");
      const access = mint("acc"); const refresh = mint("ref");
      validAccess = new Set([access]); validRefresh.add(refresh);
      return json(200, { access_token: access, refresh_token: refresh, expires_in: 3600, x_refresh_token_expires_in: 8640000, token_type: "bearer" });
    }
    const m = /^\/v3\/company\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (!m) return json(404, {});
    const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (fail401Once) { fail401Once = false; return json(401, { Fault: { Error: [{ Message: "AuthenticationFailed", code: "3200" }] } }); }
    if (!validAccess.has(token)) return json(401, { Fault: { Error: [{ Message: "AuthenticationFailed", code: "3200" }] } });
    if (fail429 > 0) { fail429--; return json(429, { Fault: { Error: [{ Message: "ThrottleExceeded", code: "3001" }] } }, { "Retry-After": "1" }); }
    const sub = m[2];
    if (sub === "/query") {
      const q = url.searchParams.get("query") || "";
      if (/from Item/i.test(q)) return json(200, { QueryResponse: { Item: ITEMS } });
      let mm = /from Customer where DisplayName = '((?:[^'\\]|\\.)*)'/i.exec(q);
      if (mm) { const name = mm[1].replace(/\\(.)/g, "$1"); return json(200, { QueryResponse: { Customer: customers.filter((c) => c.DisplayName === name) } }); }
      mm = /from Invoice where DocNumber = '((?:[^'\\]|\\.)*)'/i.exec(q);
      if (mm) { const doc = mm[1].replace(/\\(.)/g, "$1"); return json(200, { QueryResponse: { Invoice: invoices.filter((i) => i.DocNumber === doc) } }); }
      mm = /from Invoice where Id in \(([^)]*)\)/i.exec(q);
      if (mm) { const ids = mm[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")); return json(200, { QueryResponse: { Invoice: invoices.filter((i) => ids.includes(String(i.Id))) } }); }
      return json(200, { QueryResponse: {} });
    }
    if (sub === "/customer" && req.method === "POST") {
      const b = JSON.parse(body);
      if (b.Id) { const c = customers.find((x) => x.Id === b.Id)!; Object.assign(c, { DisplayName: b.DisplayName, PrimaryEmailAddr: b.PrimaryEmailAddr, SyncToken: String(Number(c.SyncToken) + 1) }); return json(200, { Customer: c }); }
      const c = { Id: String(100 + customers.length), DisplayName: b.DisplayName, SyncToken: "0", PrimaryEmailAddr: b.PrimaryEmailAddr };
      customers.push(c); return json(200, { Customer: c });
    }
    const cm = /^\/customer\/(\w+)$/.exec(sub);
    if (cm && req.method === "GET") return json(200, { Customer: customers.find((c) => c.Id === cm[1]) });
    if (sub === "/invoice" && req.method === "POST") {
      const rid = url.searchParams.get("requestid") || "";
      if (rid && byRequestId.has(rid)) return json(200, { Invoice: byRequestId.get(rid) });
      const b = JSON.parse(body);
      const total = (b.Line as Array<{ Amount: number }>).reduce((t, l) => t + l.Amount, 0);
      const inv = { ...b, Id: String(500 + invoices.length), TotalAmt: total, Balance: total };
      invoices.push(inv); if (rid) byRequestId.set(rid, inv);
      return json(200, { Invoice: inv });
    }
    return json(404, {});
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const MOCK = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quickbooks-push-test-"));
process.env.AUTOPILOT_DB_PATH = path.join(dir, "test.db");
const LOG_FILE = path.join(dir, "backend.log");
process.env.AUTOPILOT_LOG_FILE = LOG_FILE;
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
process.env.SUBMISSION_SERVICE_FEE_USD = "100";
delete process.env.QUICKBOOKS_SYNC;
process.env.QUICKBOOKS_CLIENT_ID = "mock-client-id";
process.env.QUICKBOOKS_CLIENT_SECRET = "mock-client-secret";
process.env.QUICKBOOKS_AUTH_URL = `${MOCK}/connect`;
process.env.QUICKBOOKS_TOKEN_URL = `${MOCK}/oauth/token`;
process.env.QUICKBOOKS_API_BASE = MOCK;
process.env.QUICKBOOKS_REDIRECT_URI = `${MOCK}/callback`;

const { openDatabase } = await import("../src/db");
const { createClient } = await import("../src/clients");
const { createPortalCredential } = await import("../src/portalCredentials");
const { recordActualPermitFee, markSubmissionPaid } = await import("../src/submissionFees");
const L = await import("../src/clientInvoices");
const Q = await import("../src/quickbooks");
const db = await openDatabase();
const ORG = "org-default";

// ── fixtures: a per-submission client, one project, gate paid, fee recorded, one invoice ──────
const client = createClient(db, { companyName: "Mock Solar Co's Test", billingMode: "per_submission", serviceFeeUsd: "175", businessEmail: "ops@mock.test" });
db.run("UPDATE clients SET billing_contact_email = ? WHERE id = ?", ["ap@mock.test", client.id]);
createPortalCredential(db, client.id, { portalUrl: "https://aca-oregon.accela.com/oregon/", username: "u", password: "p", feeResponsibility: "keelix-pays" });
const iso = new Date().toISOString();
const mkProject = (n: number) => {
  const pid = `qb-${n}`;
  db.run(
    `INSERT INTO projects (id, client_id, homeowner_name, project_address, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'OR', 'City of Coos Bay', 'Pacific Power', 11.7, 9, 'ready_to_stage', '{}', ?, ?)`,
    [pid, client.id, `Test Owner ${n}`, `${n} Example St`, iso, iso],
  );
  return { id: pid, clientId: client.id, state: "OR", ahj: "City of Coos Bay", utility: "Pacific Power", systemSizeDcKw: 11.7, systemSizeAcKw: 9, homeownerName: `Test Owner ${n}`, parserSnapshot: {} } as never;
};
const p1 = mkProject(1);
recordActualPermitFee(db, p1, "permit", 360);
markSubmissionPaid(db, p1, "permit", { paymentReference: "gate-1" });
const month = iso.slice(0, 7);
const inv1 = L.createClientInvoice(db, client.id, L.resolvePeriod({ month }), "Test Person");

// ── (1) FLAG OFF = ZERO NETWORK ────────────────────────────────────────────────────────────
{
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("network call while QUICKBOOKS_SYNC is off"); }) as typeof fetch;
  const off = /QuickBooks sync is off/;
  const results = [
    throwsSync(() => Q.beginQuickBooksConnect(db, ORG, "Test Person"), off),
    await rejects(Q.completeQuickBooksConnect(db, { code: "c", state: "s", realmId: "1" }), off),
    await rejects(Q.listQuickBooksItems(db, ORG), off),
    await rejects(Q.saveQuickBooksItemSettings(db, ORG, { serviceItemId: "11", passthroughItemId: "12" }, "Test Person"), off),
    await rejects(Q.pushInvoiceToQuickBooks(db, client.id, inv1.id, "Test Person"), off),
    await rejects(Q.syncQuickBooksPaymentStatus(db, ORG), off),
  ];
  process.env.QUICKBOOKS_SYNC = "0";
  results.push(await rejects(Q.pushInvoiceToQuickBooks(db, client.id, inv1.id, "Test Person"), off));
  results.push((await Q.runQuickBooksDailyRead(db)).length === 0 ? "" : "daily read ran with the flag off");
  check("(1) QUICKBOOKS_SYNC unset or 0: every entry point refuses", results.every((r) => r === ""), JSON.stringify(results));
  check("(1) …and NOT ONE network call was made (fetch would have failed the test)", calls === 0 && requests.length === 0, `fetch calls ${calls}, mock requests ${requests.length}`);
  globalThis.fetch = realFetch;
}

// From here on: on, with backoff made instant and recorded.
process.env.QUICKBOOKS_SYNC = "1";
const sleeps: number[] = [];
Q.setQuickBooksTransport({ sleep: async (ms: number) => { sleeps.push(ms); } });

// ── (2) CONNECT ──────────────────────────────────────────────────────────────────────────
check("(2) status before connect: not connected, no token fields", (() => {
  const s = Q.quickBooksStatus(db, ORG);
  return !s.connected && s.syncOn && !JSON.stringify(s).match(/token/i);
})());
const { url } = Q.beginQuickBooksConnect(db, ORG, "Test Person");
const state = new URL(url).searchParams.get("state") || "";
check("(2) the consent URL carries a state and the app's redirect, no secret", url.startsWith(`${MOCK}/connect?`) && state.length >= 24 && !url.includes("mock-client-secret"), url);
check("(2) an unknown state is refused", (await rejects(Q.completeQuickBooksConnect(db, { code: "c", state: "nope", realmId: "9130" }), /unknown, used or expired/)) === "");
const conn = await Q.completeQuickBooksConnect(db, { code: "auth-code-1", state, realmId: "9130" });
check("(2) the callback connects the org that minted the state", conn.orgId === ORG && conn.realmId === "9130");
check("(2) a used state is refused", (await rejects(Q.completeQuickBooksConnect(db, { code: "c", state, realmId: "9130" }), /unknown, used or expired/)) === "");
const row = db.get<Record<string, string>>("SELECT * FROM quickbooks_connections WHERE org_id = ?", [ORG])!;
check("(2) tokens stored ENCRYPTED: the column never contains a token's text",
  row.encrypted_tokens.length > 40 && issuedTokens.every((t) => !row.encrypted_tokens.includes(t)) && Q.quickBooksStatus(db, ORG).connected);

// ── (3) ITEMS ────────────────────────────────────────────────────────────────────────────
const items = await Q.listQuickBooksItems(db, ORG);
check("(3) the company's Items are listed for a person to choose", items.length === 3 && items[1].name === "Permit & portal fee (pass-through)");
check("(3) service and pass-through cannot be the same Item",
  (await rejects(Q.saveQuickBooksItemSettings(db, ORG, { serviceItemId: "11", passthroughItemId: "11" }, "Test Person"), /different Items/)) === "");
check("(3) an Item not in the company is refused",
  (await rejects(Q.saveQuickBooksItemSettings(db, ORG, { serviceItemId: "11", passthroughItemId: "99" }, "Test Person"), /not an active Item/)) === "");
const st3 = await Q.saveQuickBooksItemSettings(db, ORG, { serviceItemId: "11", passthroughItemId: "12", onboardingItemId: "13" }, "Test Person");
check("(3) the person's choice is saved with the names", st3.items.passthrough.name === "Permit & portal fee (pass-through)" && st3.items.onboarding.id === "13" && st3.settingsBy === "Test Person");

// ── (5) SEND: mapping ────────────────────────────────────────────────────────────────────
const withCredit = L.addManualInvoiceLine(db, client.id, inv1.id, { kind: "onboarding", amountUsd: -50, description: "Client onboarding fee — credit" }, "Test Person");
check("(5) a person's negative onboarding credit is on the invoice and in the total", withCredit.dueTotalUsd === 310 && withCredit.lines.some((l) => l.kind === "onboarding" && l.amountUsd === -50), String(withCredit.dueTotalUsd));
const before5 = requests.length;
const r1 = await Q.pushInvoiceToQuickBooks(db, client.id, inv1.id, "Test Person");
const createReqs = requests.slice(before5).filter((r) => r.method === "POST" && r.path.endsWith("/invoice"));
const sent = JSON.parse(createReqs[0]?.body || "{}") as { Line: Array<{ Amount: number; SalesItemLineDetail: { ItemRef: { value: string }; ServiceDate?: string } }>; DocNumber: string; EmailStatus?: string; CustomerMemo?: { value: string } };
check("(5) created once, external_ref saved", r1.created && /^\d+$/.test(r1.externalRef) && r1.invoice.externalRef === r1.externalRef && invoices.length === 1);
check("(5) the create carries requestid = our invoice id and DocNumber = our number",
  createReqs.length === 1 && createReqs[0].query.get("requestid") === inv1.id && sent.DocNumber === inv1.number);
check("(5) lines map to the chosen Items: fee at cost → pass-through, credit → onboarding",
  sent.Line.length === 2
  && sent.Line.some((l) => l.Amount === 360 && l.SalesItemLineDetail.ItemRef.value === "12")
  && sent.Line.some((l) => l.Amount === -50 && l.SalesItemLineDetail.ItemRef.value === "13"),
  JSON.stringify(sent.Line.map((l) => [l.Amount, l.SalesItemLineDetail.ItemRef.value])));
check("(5) the gate-paid service fee and the payment received are NOT billed again (noted instead)",
  !sent.Line.some((l) => l.SalesItemLineDetail.ItemRef.value === "11") && /Already paid/.test(sent.CustomerMemo?.value || ""));
check("(5) every line carries its service date", sent.Line.every((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.SalesItemLineDetail.ServiceDate || "")));
check("(5) no email status is set: QuickBooks does not email the customer", sent.EmailStatus === undefined && !requests.some((r) => /\/send/.test(r.path)));
check("(5) no payment endpoint is ever called", !requests.some((r) => /payment|charge/i.test(r.path)));

// ── (4) CUSTOMER UPSERT ──────────────────────────────────────────────────────────────────
const savedCustomer = db.get<{ quickbooks_customer_id: string }>("SELECT quickbooks_customer_id FROM clients WHERE id = ?", [client.id])!.quickbooks_customer_id;
check("(4) the client became ONE QuickBooks Customer, its id saved on the client (apostrophe in the name survives)",
  customers.length === 1 && savedCustomer === customers[0].Id && customers[0].DisplayName === "Mock Solar Co's Test" && customers[0].PrimaryEmailAddr?.Address === "ap@mock.test");
// A second client whose name already exists in QuickBooks is adopted, not duplicated.
const twin = createClient(db, { companyName: "Existing Books Co", billingMode: "monthly", businessEmail: "x@mock.test" });
customers.push({ Id: "777", DisplayName: "Existing Books Co", SyncToken: "0" });
const adoptedId = await Q.upsertQuickBooksCustomer(db, ORG, twin.id, "x@mock.test");
check("(4) an existing Customer with the same name is ADOPTED, not created twice", adoptedId === "777" && customers.length === 2);
const reusedId = await Q.upsertQuickBooksCustomer(db, ORG, client.id, "ap@mock.test");
check("(4) a saved id is re-used", reusedId === savedCustomer && customers.length === 2);

// ── (6) IDEMPOTENT ───────────────────────────────────────────────────────────────────────
const before6 = requests.length;
const again = await Q.pushInvoiceToQuickBooks(db, client.id, inv1.id, "Test Person");
check("(6) a second click creates NOTHING and makes no request", !again.created && again.externalRef === r1.externalRef && invoices.length === 1 && requests.length === before6);
// Restart: QuickBooks created it, we never saved the id.
db.run("UPDATE client_invoices SET external_ref = '', qb_push_started_at = '' WHERE id = ?", [inv1.id]);
const restarted = await Q.pushInvoiceToQuickBooks(db, client.id, inv1.id, "Test Person");
check("(6) after a restart that lost the id, the invoice is FOUND by our number and adopted, not created again",
  restarted.adopted && restarted.externalRef === r1.externalRef && invoices.length === 1);
// In-flight claim.
const p2 = mkProject(2);
recordActualPermitFee(db, p2, "permit", 120);
const inv2 = L.createClientInvoice(db, client.id, L.resolvePeriod({ month }), "Test Person");
db.run("UPDATE client_invoices SET qb_push_started_at = ? WHERE id = ?", [new Date().toISOString(), inv2.id]);
const before6b = requests.length;
check("(6) an invoice already being sent is refused, with no request made",
  (await rejects(Q.pushInvoiceToQuickBooks(db, client.id, inv2.id, "Test Person"), /already being sent/)) === "" && requests.length === before6b);
db.run("UPDATE client_invoices SET qb_push_started_at = '' WHERE id = ?", [inv2.id]);
// Two clicks at once.
const both = await Promise.allSettled([
  Q.pushInvoiceToQuickBooks(db, client.id, inv2.id, "Test Person"),
  Q.pushInvoiceToQuickBooks(db, client.id, inv2.id, "Test Person"),
]);
check("(6) two clicks at once create ONE QuickBooks invoice",
  both.filter((b) => b.status === "fulfilled").length === 1 && invoices.length === 2, JSON.stringify(both.map((b) => b.status)));
const ext2 = L.getClientInvoice(db, client.id, inv2.id).externalRef;
check("(6) the schema refuses two of our invoices with one QuickBooks id",
  throwsSync(() => db.run("UPDATE client_invoices SET external_ref = ? WHERE id = ?", [ext2, inv1.id]), /UNIQUE/i) === "");
check("(6) an invoice in QuickBooks takes no new hand-added line",
  throwsSync(() => L.addManualInvoiceLine(db, client.id, inv2.id, { amountUsd: 10 }, "Test Person"), /already in QuickBooks/) === "");

// ── (7) TOKEN REFRESH ────────────────────────────────────────────────────────────────────
const tokenCalls = () => requests.filter((r) => r.path === "/oauth/token").length;
const t0 = tokenCalls();
db.run("UPDATE quickbooks_connections SET access_expires_at = ? WHERE org_id = ?", [new Date(Date.now() - 1000).toISOString(), ORG]);
await Q.listQuickBooksItems(db, ORG);
const refreshReq = requests.filter((r) => r.path === "/oauth/token").slice(-1)[0];
check("(7) an expired access token is REFRESHED before the call (refresh grant, basic auth)",
  tokenCalls() === t0 + 1 && new URLSearchParams(refreshReq.body).get("grant_type") === "refresh_token" && /^Basic /.test(refreshReq.auth));
const t1 = tokenCalls();
fail401Once = true;
const after401 = await Q.listQuickBooksItems(db, ORG);
check("(7) a 401 refreshes ONCE and retries", after401.length === 3 && tokenCalls() === t1 + 1);
const row7 = db.get<Record<string, string>>("SELECT encrypted_tokens FROM quickbooks_connections WHERE org_id = ?", [ORG])!;
check("(7) the rotated tokens are stored encrypted too", issuedTokens.every((t) => !row7.encrypted_tokens.includes(t)));

// ── (8) 429 BACKOFF ──────────────────────────────────────────────────────────────────────
sleeps.length = 0;
fail429 = 2;
const after429 = await Q.listQuickBooksItems(db, ORG);
check("(8) a 429 backs off by Retry-After and retries until it succeeds", after429.length === 3 && sleeps.length === 2 && sleeps.every((ms) => ms === 1000), JSON.stringify(sleeps));
fail429 = 10;
check("(8) …and gives up after its retries with a plain error", (await rejects(Q.listQuickBooksItems(db, ORG), /HTTP 429/)) === "");
fail429 = 0;

// ── (9) DAILY READ, READ-ONLY ────────────────────────────────────────────────────────────
const q1 = invoices.find((i) => i.Id === r1.externalRef)!;
q1.Balance = 0;
const q2 = invoices.find((i) => i.Id === ext2)!;
q2.Balance = Number(q2.TotalAmt) / 2;
const before9 = requests.length;
const read = await Q.runQuickBooksDailyRead(db);
const reqs9 = requests.slice(before9);
check("(9) the daily read only READS (GET requests only)", reqs9.length > 0 && reqs9.every((r) => r.method === "GET"), JSON.stringify(reqs9.map((r) => r.method + " " + r.path)));
const i1 = L.getClientInvoice(db, client.id, inv1.id);
const i2 = L.getClientInvoice(db, client.id, inv2.id);
check("(9) balance 0 in QuickBooks marks ours PAID, saying where that came from", i1.status === "paid" && /QuickBooks invoice/.test(i1.paidReference) && i1.qbStatus === "paid");
check("(9) a part payment is recorded as partly paid, ours stays open", i2.status === "draft" && i2.qbStatus === "partly paid" && i2.qbBalanceUsd === Number(q2.TotalAmt) / 2);
check("(9) the run is counted", read.length === 1 && read[0].paid === 1 && read[0].partial === 1, JSON.stringify(read));
invoices.splice(invoices.indexOf(q2), 1);
await Q.syncQuickBooksPaymentStatus(db, ORG);
check("(9) an invoice QuickBooks no longer has is flagged for a person", L.getClientInvoice(db, client.id, inv2.id).qbStatus === "not found in QuickBooks");

// ── errors never echo a body ─────────────────────────────────────────────────────────────
tokenFailBody = { error: "invalid_grant", error_description: "Token invalid", leaked_access_token: "SHOULD-NOT-APPEAR-abc123" };
db.run("UPDATE quickbooks_connections SET access_expires_at = ? WHERE org_id = ?", [new Date(Date.now() - 1000).toISOString(), ORG]);
const errMsg = await rejects(Q.listQuickBooksItems(db, ORG), /SHOULD-NOT-APPEAR/);
check("(10) a provider error shows its status and short reason only, never the body", errMsg !== "" && /invalid_grant|Token invalid/.test(errMsg) && !/SHOULD-NOT-APPEAR/.test(errMsg), errMsg);
tokenFailBody = null;

// ── disconnect ───────────────────────────────────────────────────────────────────────────
const disc = Q.disconnectQuickBooks(db, ORG, "Test Person");
check("disconnect deletes the stored tokens", !disc.connected && !db.get<Record<string, string>>("SELECT encrypted_tokens FROM quickbooks_connections WHERE org_id = ?", [ORG])!.encrypted_tokens);

// ── (10) NO TOKEN ANYWHERE ───────────────────────────────────────────────────────────────
{
  const logFile = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, "utf8") : "";
  const audit = db.query<{ details: string }>("SELECT details FROM audit_logs").map((r) => r.details).join("\n");
  const comms = db.query<{ body: string; subject: string }>("SELECT body, subject FROM communications").map((r) => r.body + r.subject).join("\n");
  const invoiceCols = db.query<Record<string, unknown>>("SELECT * FROM client_invoices").map((r) => JSON.stringify(r)).join("\n");
  const status = JSON.stringify(Q.quickBooksStatus(db, ORG));
  const haystacks: Record<string, string> = { stdout: captured.join(""), logFile, audit, comms, invoiceCols, status };
  const hits = Object.entries(haystacks).flatMap(([where, text]) => issuedTokens.filter((t) => text.includes(t)).map((t) => `${where}:${t.slice(0, 8)}`));
  check("(10) NO token value in any log line, log file, audit row, communication, invoice row or status", issuedTokens.length >= 6 && hits.length === 0, hits.join(", "));
  check("(10) the client secret is never logged either", !Object.values(haystacks).some((t) => t.includes("mock-client-secret")));
}

// ── (11) FENCE ───────────────────────────────────────────────────────────────────────────
{
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(d, e.name))) : /\.(ts|js|mts)$/.test(e.name) ? [path.join(d, e.name)] : []);
  const files = [...walk(path.join(REPO, "backend", "src")), ...walk(path.join(REPO, "portal-bot", "src")), ...walk(path.join(REPO, "shared", "src")), path.join(REPO, "frontend", "dashboard.js")];
  const allowed = new Set([path.join(REPO, "backend", "src", "quickbooks.ts"), path.join(REPO, "backend", "src", "db.ts")]);
  const naming = files.filter((f) => !allowed.has(f) && /encrypted_tokens|quickbooks_connections/.test(fs.readFileSync(f, "utf8")));
  check("(11) only quickbooks.ts (and its migration) names the token column", naming.length === 0, naming.map((f) => path.relative(REPO, f)).join(", "));
  const promptBuilders = ["llm.ts", "autoLearn.ts", "reviewerEngine.ts", "reviewerVision.ts", "correctionAgent.ts", "runTriage.ts", "billVision.ts", "formFillVision.ts"]
    .map((n) => path.join(REPO, "backend", "src", n)).filter((f) => fs.existsSync(f));
  const importing = promptBuilders.filter((f) => /from "\.\/quickbooks"|import\("\.\/quickbooks"\)/.test(fs.readFileSync(f, "utf8")));
  check("(11) no prompt builder imports the QuickBooks module (rule 2)", promptBuilders.length >= 4 && importing.length === 0, importing.join(", "));
  const testSrc = fs.readFileSync(path.join(REPO, "backend", "test", "quickbooksPush.test.ts"), "utf8");
  const routeSrc = fs.existsSync(path.join(REPO, "backend", "test", "quickbooksRoutes.test.ts")) ? fs.readFileSync(path.join(REPO, "backend", "test", "quickbooksRoutes.test.ts"), "utf8") : "";
  check("(11) no Intuit host appears in the QuickBooks tests", ![testSrc, routeSrc].some((t) => t.includes(["intuit", "com"].join("."))));
  check("(11) every request in this run went to the local mock", requests.length > 0);
}

server.close();
if (failures) { console.error(`\nquickbooksPush: ${failures} check(s) failed`); process.exit(1); }
console.log("\nquickbooksPush: all checks passed");
process.exit(0);
