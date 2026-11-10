// QUICKBOOKS + INVOICE ROUTES NAME A PERSON (#701), on a real server process over a temp database.
//
//   - Emailing an invoice is a NAMED PERSON's click (Helm's #700 review): with sign-in off, a blank
//     decidedBy or the word "operator" is a 400 that sends nothing and writes no communication; a named
//     person gets 200 (a draft here: client emails are off, no SMTP).
//   - "Send to QuickBooks", adding an onboarding line, connect and the Item choice are named too.
//   - QUICKBOOKS_SYNC unset = every QuickBooks action is a 409 that reaches no network (the server has no
//     QuickBooks endpoint configured at all; the module-level zero-fetch pin is quickbooksPush.test).
//   - GET /api/quickbooks/status never carries a token field.
//
//   npx tsx backend/test/quickbooksRoutes.test.ts
import "./_isolate";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quickbooks-routes-"));
const dbPath = path.join(tmpDir, "routes.sqlite");

let failures = 0;
const run = async (label: string, fn: () => Promise<void>) => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ── fixtures through the real write paths ────────────────────────────────────────────────
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.SUBMISSION_SERVICE_FEE_USD = "100";
process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
const fixture = await (async () => {
  const { openDatabase } = await import("../src/db");
  const { createClient } = await import("../src/clients");
  const { createPortalCredential } = await import("../src/portalCredentials");
  const { recordActualPermitFee } = await import("../src/submissionFees");
  const L = await import("../src/clientInvoices");
  const db = await openDatabase();
  try {
    const client = createClient(db, { companyName: "Route Test Solar", billingMode: "monthly", businessEmail: "ops@route.test" });
    createPortalCredential(db, client.id, { portalUrl: "https://permits.example.gov/apply", username: "u", password: "p", feeResponsibility: "keelix-pays" });
    const iso = new Date().toISOString();
    db.run(
      `INSERT INTO projects (id, client_id, homeowner_name, project_address, state, ahj, utility, system_size_dc_kw, system_size_ac_kw, status, parser_json, created_at, updated_at)
       VALUES ('qr-1', ?, 'Test Owner', '1 Example St', 'ZZ', 'City of Exampleton', 'Example Power', 8, 7, 'ready_to_stage', '{}', ?, ?)`,
      [client.id, iso, iso],
    );
    recordActualPermitFee(db, { id: "qr-1", clientId: client.id, state: "ZZ", ahj: "City of Exampleton", utility: "Example Power", systemSizeDcKw: 8, systemSizeAcKw: 7, homeownerName: "Test Owner", parserSnapshot: {} } as never, "permit", 200);
    const inv = L.createClientInvoice(db, client.id, L.resolvePeriod({ month: iso.slice(0, 7) }), "Test Person");
    return { clientId: client.id, invoiceId: inv.id };
  } finally { db.close(); }
})();

function stop(server: ChildProcess): void {
  try { process.kill(-server.pid!, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* already gone */ } }
}

const PORT = 6040 + Math.floor(Math.random() * 15);
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env,
  AUTOPILOT_DB_PATH: dbPath,
  BACKUP_DIR: path.join(tmpDir, "backups"),
  AUTOPILOT_AUTO_START: "0",
  PORT: String(PORT),
  SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0",
  LOG_LEVEL: "warn",
  ANTHROPIC_API_KEY: "",
  CODE_RESEARCH: "off",
  SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
  AUTH_ENABLED: "false",
  NO_PROXY: "*",
  no_proxy: "*",
};
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "QUICKBOOKS_SYNC", "CLIENT_NOTIFICATIONS", "CLIENT_NOTIFICATIONS_ALLOW_CLIENTS", "SMTP_HOST"]) delete env[k];
const server = spawn(process.execPath, [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
let log = "";
server.stdout?.on("data", (d) => { log += String(d); });
server.stderr?.on("data", (d) => { log += String(d); });
let up = false;
for (let i = 0; i < 90 && !up; i++) {
  try { up = (await fetch(`${BASE}/health`)).ok; } catch { /* not up yet */ }
  if (!up) await new Promise((r) => setTimeout(r, 1000));
}
if (!up) { stop(server); console.error(`server never came up. log tail:\n${log.slice(-2000)}`); process.exit(1); }

const post = (p: string, body: Record<string, unknown>) => fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const peek = <T>(sql: string, params: unknown[] = []): T => {
  const d = new Database(dbPath, { readonly: true });
  try { return d.prepare(sql).get(...params) as T; } finally { d.close(); }
};
const comms = () => peek<{ n: number }>("SELECT COUNT(*) AS n FROM communications").n;
const invPath = `/api/clients/${fixture.clientId}/invoices/${fixture.invoiceId}`;

try {
  await run("email an invoice with NO name: 400, nothing sent, no communication written, invoice still draft", async () => {
    const before = comms();
    const r = await post(`${invPath}/send`, {});
    assert.equal(r.status, 400, await r.text());
    assert.equal(comms(), before);
    assert.equal(peek<{ status: string }>("SELECT status FROM client_invoices WHERE id = ?", [fixture.invoiceId]).status, "draft");
  });
  await run("email an invoice as \"operator\": 400 (not a person), nothing sent", async () => {
    const before = comms();
    const r = await post(`${invPath}/send`, { decidedBy: "operator" });
    assert.equal(r.status, 400, await r.text());
    assert.equal(comms(), before);
  });
  await run("email an invoice as a named person: 200, recorded against them (a draft here: client emails off)", async () => {
    const before = comms();
    const r = await post(`${invPath}/send`, { decidedBy: "Test Person" });
    const body = await r.json() as { delivered: boolean };
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.delivered, false);
    assert.equal(comms(), before + 1);
    const audit = peek<{ actor: string }>("SELECT actor_name AS actor FROM audit_logs WHERE action = 'invoice.email_not_sent' ORDER BY rowid DESC LIMIT 1");
    assert.equal(audit.actor, "Test Person");
  });
  await run("adding an onboarding line with no name: 400, no line added", async () => {
    const r = await post(`${invPath}/lines`, { kind: "onboarding", amountUsd: -25, description: "credit" });
    assert.equal(r.status, 400, await r.text());
    assert.equal(peek<{ n: number }>("SELECT COUNT(*) AS n FROM client_invoice_lines WHERE invoice_id = ? AND kind = 'onboarding'", [fixture.invoiceId]).n, 0);
  });
  await run("Send to QuickBooks with no name: 400", async () => {
    const r = await post(`${invPath}/quickbooks`, {});
    assert.equal(r.status, 400, await r.text());
  });
  await run("Send to QuickBooks, named, with QUICKBOOKS_SYNC unset: 409, nothing recorded", async () => {
    const r = await post(`${invPath}/quickbooks`, { decidedBy: "Test Person" });
    const text = await r.text();
    assert.equal(r.status, 409, text);
    assert.match(text, /QuickBooks sync is off/);
    assert.equal(peek<{ external_ref: string }>("SELECT external_ref FROM client_invoices WHERE id = ?", [fixture.invoiceId]).external_ref, "");
  });
  await run("connect, Items and payment read with the flag off: 409 each (connect still needs a name first)", async () => {
    assert.equal((await post("/api/quickbooks/connect", {})).status, 400);
    assert.equal((await post("/api/quickbooks/connect", { decidedBy: "Test Person" })).status, 409);
    assert.equal((await fetch(`${BASE}/api/quickbooks/items`)).status, 409);
    assert.equal((await post("/api/quickbooks/payment-status", { decidedBy: "Test Person" })).status, 409);
    const put = await fetch(`${BASE}/api/quickbooks/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ decidedBy: "Test Person", serviceItemId: "1", passthroughItemId: "2" }) });
    assert.equal(put.status, 409);
  });
  await run("an OAuth callback with an unknown state connects nothing", async () => {
    const r = await fetch(`${BASE}/api/quickbooks/oauth/callback?code=SENTINELCODE7731&state=SENTINELSTATE4402&realmId=1`);
    assert.notEqual(r.status, 200);
    assert.equal(peek<{ n: number }>("SELECT COUNT(*) AS n FROM quickbooks_connections WHERE encrypted_tokens != ''").n, 0);
  });
  // Helm's #701 review: the request log must not record the single-use authorization code or the
  // state (logger.ts SENSITIVE_QUERY). The refused callback is a 4xx, so it IS logged at warn.
  await run("the request log line for the OAuth callback records neither the code nor the state", async () => {
    for (let i = 0; i < 20 && !/oauth\/callback/.test(log); i++) await new Promise((res) => setTimeout(res, 100));
    const line = log.split("\n").find((l) => /oauth\/callback/.test(l)) || "";
    assert.ok(line, `no request log line for the callback. log tail:\n${log.slice(-800)}`);
    assert.match(line, /code=\[redacted\]/);
    assert.match(line, /state=\[redacted\]/);
    assert.doesNotMatch(log, /SENTINELCODE7731|SENTINELSTATE4402/);
  });
  await run("status: not connected, sync off, and no token field of any kind", async () => {
    const r = await fetch(`${BASE}/api/quickbooks/status`);
    const text = await r.text();
    assert.equal(r.status, 200, text);
    const s = (JSON.parse(text) as { quickbooks: { connected: boolean; syncOn: boolean } }).quickbooks;
    assert.equal(s.connected, false);
    assert.equal(s.syncOn, false);
    assert.doesNotMatch(text, /token/i);
  });
} finally {
  stop(server);
}

if (failures) { console.error(`\nquickbooksRoutes: ${failures} check(s) failed`); process.exit(1); }
console.log("\nquickbooksRoutes: all checks passed");
process.exit(0);
