// WHO WRITES A JURISDICTION QC SCREEN (review-audit draft 14 item 1).
//
// Draft 12 moved each jurisdiction's QC baseline screens to data, overlaid by state_permit_rules rows of
// family "qc", but nothing wrote those rows. Now two paths do:
//   (a) a PERSON: PUT /api/code-profiles/qc-screens records or rewords a screen, with a named person
//       (namedPersonDecider; blank and placeholder names refused), the source's words verbatim and the
//       page they were read on. It lands person-verified (rule 3) and only the #637 bar lets it block;
//   (b) the state-rule write (stateRules.writeSeededStatePermitRule, the one write for the reference
//       and research) now takes family "qc": it lands SEEDED, or OFFICIAL through the one shared
//       landing predicate (government host, quote in the retrieved bytes, URL + fetched-at). It never
//       replaces a person's row, and refuses a screen it cannot read or one with no source URL.
// Part 1 runs the write functions on a temp DB; part 2 the route on a real server process (auth off,
// how the live install runs). Synthetic data only; no network beyond 127.0.0.1.
//   npx tsx backend/test/jurisdictionQcScreensWrite.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "juris-qc-write-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "unit.sqlite");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.PORTAL_PROFILES_DIR = path.join(tmpDir, "profiles");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PORTAL_AUTOSEED = "0";
process.env.MOCK_PORTAL = "1";
delete process.env.ANTHROPIC_API_KEY;

let failures = 0;
let passed = 0;
const run = async (label: string, fn: () => Promise<void> | void) => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.log(`  FAIL - ${label}\n         ${err instanceof Error ? err.message.slice(0, 1500) : String(err)}`); }
};

const { openDatabase } = await import("../src/db");
const SR = await import("../src/stateRules");
const J = await import("../src/jurisdictionQcRules");

const disconnect = (message: string) => ({ kind: "manual_disconnect", ruleName: "Test disconnect screen", message, fieldName: "acDiscReq", source: "Synthetic Rule 1" });
const QUOTE = "A lockable, visible-break AC disconnect is required at the meter.";
const screenOf = (records: ReturnType<typeof J.resolveJurisdictionQcRecords>, state: string, ruleId: string) =>
  records.filter((r) => r.state === state).flatMap((r) => r.screens).find((s) => s.ruleId === ruleId);

console.log("jurisdiction QC screens: the write side (draft 14)");
{
  const db = await openDatabase();
  try {
    await run("a person records a screen: person-verified, with the quote and the URL, read by the overlay", () => {
      const row = SR.writeVerifiedQcScreen(db, { state: "Utah", ruleId: "ut-test-disconnect", screen: disconnect("Show the lockable disconnect."), quote: QUOTE, sourceUrl: "https://example.gov/rules" }, "Pat Example");
      assert.ok(row);
      assert.equal(row!.state, "UT");
      const db_ = db.get<{ confidence: string; verified_by: string; verified_at: string; citation: string }>("SELECT confidence, verified_by, verified_at, citation FROM state_permit_rules WHERE family = 'qc' AND rule_key = 'ut-test-disconnect'");
      assert.equal(db_?.confidence, "verified");
      assert.equal(db_?.verified_by, "Pat Example");
      assert.ok(db_?.verified_at);
      assert.equal(db_?.citation, QUOTE);
      const s = screenOf(J.resolveJurisdictionQcRecords(db, "UT", ""), "UT", "ut-test-disconnect");
      assert.equal(s?.tier, "verified");
      assert.equal(s?.message, "Show the lockable disconnect.");
    });
    await run("a person rewords a SHIPPED screen: the overlay shows the person's words at the person's tier", () => {
      const shipped = J.shippedJurisdictionQcRecords().flatMap((r) => r.screens).find((s) => s.kind === "manual_disconnect")!;
      const state = J.shippedJurisdictionQcRecords().find((r) => r.screens.includes(shipped))!.state;
      assert.ok(SR.writeVerifiedQcScreen(db, { state, ruleId: shipped.ruleId, screen: { ...shipped, message: "Reworded by a person." }, quote: QUOTE, sourceUrl: "https://example.gov/rules" }, "Pat Example"));
      const s = screenOf(J.resolveJurisdictionQcRecords(db, state, ""), state, shipped.ruleId);
      assert.equal(s?.message, "Reworded by a person.");
      assert.equal(s?.tier, "verified");
      assert.equal(J.jurisdictionScreenMayBlock({ ...s!, severity: "blocker" }), true, "a person's screen may block (#637 bar)");
    });
    await run("rule 3: the state-rule write never replaces a person's row (seeded or official)", () => {
      const r = { state: "UT", family: "qc" as const, key: "ut-test-disconnect", value: disconnect("Automatic wording."), citation: QUOTE, sourceUrl: "https://example.gov/rules", fetchedAt: "2026-11-10" };
      assert.equal(SR.writeSeededStatePermitRule(db, r), 0);
      assert.equal(SR.writeSeededStatePermitRule(db, r, undefined, { retrievedText: `Rules. ${QUOTE} End.`, quotes: [{ quote: QUOTE, value: "lockable" }] }), 0);
      assert.equal(screenOf(J.resolveJurisdictionQcRecords(db, "UT", ""), "UT", "ut-test-disconnect")?.message, "Show the lockable disconnect.");
    });
    await run("the state-rule write lands a new qc screen SEEDED; with its quote found on a government page, OFFICIAL", () => {
      const base = { state: "ID", family: "qc" as const, value: disconnect("Research wording."), citation: QUOTE, sourceUrl: "https://example.gov/rules", fetchedAt: "2026-11-10T00:00:00Z" };
      assert.equal(SR.writeSeededStatePermitRule(db, { ...base, key: "id-test-seeded" }), 1);
      assert.equal(screenOf(J.resolveJurisdictionQcRecords(db, "ID", ""), "ID", "id-test-seeded")?.tier, "seeded");
      assert.equal(SR.writeSeededStatePermitRule(db, { ...base, key: "id-test-official" }, undefined, { retrievedText: `Rules. ${QUOTE} End.`, quotes: [{ quote: QUOTE, value: "lockable" }] }), 1);
      const off = screenOf(J.resolveJurisdictionQcRecords(db, "ID", ""), "ID", "id-test-official");
      assert.equal(off?.tier, "official");
      assert.equal(J.jurisdictionScreenMayBlock({ ...off!, severity: "blocker" }), true, "official with quote + URL meets the #637 bar");
      assert.equal(J.jurisdictionScreenMayBlock({ ...screenOf(J.resolveJurisdictionQcRecords(db, "ID", ""), "ID", "id-test-seeded")!, severity: "blocker", quote: "" }), false);
    });
    await run("the state-rule write refuses a qc screen with no source URL, or one it cannot read", () => {
      const base = { state: "ID", family: "qc" as const, citation: QUOTE, fetchedAt: "2026-11-10" };
      assert.equal(SR.writeSeededStatePermitRule(db, { ...base, key: "id-test-nourl", value: disconnect("x") }), 0);
      assert.equal(SR.writeSeededStatePermitRule(db, { ...base, key: "id-test-badkind", sourceUrl: "https://example.gov/r", value: { ...disconnect("x"), kind: "anything" } }), 0);
      assert.equal(SR.writeSeededStatePermitRule(db, { ...base, key: "id-test-noitems", sourceUrl: "https://example.gov/r", value: { ...disconnect("x"), kind: "submittal_documents" } }), 0);
      assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM state_permit_rules WHERE rule_key LIKE 'id-test-no%' OR rule_key = 'id-test-badkind'")?.n, 0);
    });
    await run("a person's write refuses an unrecognised state, a short quote, a non-http URL or no name", () => {
      const ok = { state: "UT", ruleId: "ut-test-refused", screen: disconnect("x"), quote: QUOTE, sourceUrl: "https://example.gov/r" };
      assert.equal(SR.writeVerifiedQcScreen(db, { ...ok, state: "UT 84101" }, "Pat Example"), null);
      assert.equal(SR.writeVerifiedQcScreen(db, { ...ok, quote: "short" }, "Pat Example"), null);
      assert.equal(SR.writeVerifiedQcScreen(db, { ...ok, sourceUrl: "example.gov/r" }, "Pat Example"), null);
      assert.equal(SR.writeVerifiedQcScreen(db, ok, " "), null);
      assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM state_permit_rules WHERE rule_key = 'ut-test-refused'")?.n, 0);
    });
    await run("a person's new CITY screen lands on that city's record", () => {
      assert.ok(SR.writeVerifiedQcScreen(db, { state: "UT", ruleId: "testville-docs", screen: { kind: "submittal_documents", ruleName: "Testville documents", message: "Testville package may be missing: {missing}.", fieldName: "splitPagesText", items: [{ key: "site_plan", label: "site plan" }], ahj: "City of Testville", ahjNames: ["testville"] }, quote: "Submit a site plan with every solar permit.", sourceUrl: "https://testville.example.gov/solar" }, "Pat Example"));
      const city = J.resolveJurisdictionQcRecords(db, "UT", "City of Testville").find((r) => r.state === "UT" && r.ahj);
      assert.deepEqual(city?.ahjNames, ["testville"]);
      assert.equal(city?.screens[0].ruleId, "testville-docs");
    });
  } finally { db.close(); }
}

// ── Part 2: the route, on a real server (auth off) ─────────────────────────────────────────────────
function stop(server: ChildProcess): void {
  try { process.kill(-server.pid!, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* already gone */ } }
}
async function boot(dbPath: string, port: number): Promise<ChildProcess> {
  const env: Record<string, string | undefined> = {
    ...process.env, AUTOPILOT_DB_PATH: dbPath, BACKUP_DIR: path.join(tmpDir, `backups-${port}`), AUTOPILOT_AUTO_START: "0", PORT: String(port),
    SEED_TEST_INSTALLER: "false", MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off",
    SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret", AUTH_ENABLED: "false", NO_PROXY: "*", no_proxy: "*",
  };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  const server = spawn(process.execPath, [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "backend/src/server.ts")], {
    env: env as NodeJS.ProcessEnv, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let log = "";
  server.stdout?.on("data", (d) => { log += String(d); });
  server.stderr?.on("data", (d) => { log += String(d); });
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return server; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop(server);
  throw new Error(`server never came up. log tail:\n${log.slice(-2000)}`);
}
{
  const PORT = 5330 + Math.floor(Math.random() * 15); // never 4173 / 4270
  const BASE = `http://127.0.0.1:${PORT}`;
  const server = await boot(path.join(tmpDir, "route.sqlite"), PORT);
  const put = (b: Record<string, unknown>) => fetch(`${BASE}/api/code-profiles/qc-screens`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const body = { state: "NV", ruleId: "nv-test-disconnect", screen: disconnect("Show the disconnect <b>here</b>."), quote: QUOTE, sourceUrl: "https://example.gov/rules" };
  try {
    await run("route: no name, or a placeholder name, is a 400 that writes nothing", async () => {
      assert.equal((await put(body)).status, 400);
      assert.equal((await put({ ...body, verifiedBy: "operator" })).status, 400);
      const got = await (await fetch(`${BASE}/api/code-profiles/qc-screens?state=NV`)).json() as { records: Array<{ screens: Array<{ ruleId: string }> }> };
      assert.equal(got.records.flatMap((r) => r.screens).some((s) => s.ruleId === "nv-test-disconnect"), false);
    });
    await run("route: a bad screen, a missing quote or a non-http URL is a 400", async () => {
      assert.equal((await put({ ...body, verifiedBy: "Pat Example", screen: { ...body.screen, kind: "nope" } })).status, 400);
      assert.equal((await put({ ...body, verifiedBy: "Pat Example", quote: "" })).status, 400);
      assert.equal((await put({ ...body, verifiedBy: "Pat Example", sourceUrl: "ftp://example.gov/r" })).status, 400);
      assert.equal((await put({ ...body, verifiedBy: "Pat Example", extra: 1 })).status, 400, "strict body");
    });
    await run("route: a named person's screen lands verified and GET shows it (words stored as data, never markup)", async () => {
      const r = await put({ ...body, verifiedBy: "Pat Example" });
      assert.equal(r.status, 200, await r.clone().text());
      const out = await r.json() as { rule: { confidence: string }; verifiedBy: string };
      assert.equal(out.rule.confidence, "verified");
      assert.equal(out.verifiedBy, "Pat Example");
      const got = await (await fetch(`${BASE}/api/code-profiles/qc-screens?state=Nevada`)).json() as { state: string; records: Array<{ screens: Array<{ ruleId: string; tier: string; message: string }> }> };
      assert.equal(got.state, "NV");
      const s = got.records.flatMap((x) => x.screens).find((x) => x.ruleId === "nv-test-disconnect");
      assert.equal(s?.tier, "verified");
      assert.equal(s?.message, "Show the disconnect <b>here</b>.");
    });
    await run("route: GET without a recognisable state is a 400", async () => {
      assert.equal((await fetch(`${BASE}/api/code-profiles/qc-screens?state=Nev%20State`)).status, 400);
    });
  } finally { stop(server); }
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
