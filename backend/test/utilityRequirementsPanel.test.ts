// THE DASHBOARD PANEL FOR A UTILITY'S APPLICATION REQUIREMENTS (frontend/utility-requirements.js) AND
// ITS ROUTES (GET / PUT /api/projects/:id/utility-filing/application-requirements).
//
//   - the module renders every item with its tier ("Verified by …", "from <host>", "Seeded …"), its
//     source (http(s) links only) and the page's words; Verify / Edit only where a filing row exists;
//     every interpolated value escaped;
//   - its form payload is strict: an http(s) page and the page's words, mode "merge";
//   - over HTTP: the GET lists the items and writes nothing; exactly the body the panel sends records an
//     item under the typed name; a second item keeps the first person's; words that do not name the item
//     are refused; a utility with no filing row is refused (409).
// Synthetic data and invented utilities only; the server runs locally with no model key (no lookup).
//   npx tsx backend/test/utilityRequirementsPanel.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { REPO } from "./_isolate";

let failures = 0;
let passed = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); passed++; console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

// ── The module, loaded the way the browser does (a classic script setting window.UtilityRequirements) ──
type Panel = {
  esc: (v: unknown) => string;
  KEYS: string[];
  renderRequirementsPanel: (p: unknown) => string;
  prefill: (item: unknown) => Record<string, string>;
  formPayload: (v: Record<string, string>) => { ok: boolean; reason?: string; body?: { requirements: Array<Record<string, string>>; mode: string } };
  confirmMessage: (u: string, k: string) => string;
};
const sandbox: Record<string, unknown> = { URL };
sandbox.window = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(REPO, "frontend/utility-requirements.js"), "utf8"), sandbox);
const UR = sandbox.UtilityRequirements as Panel;
const { UTILITY_REQUIREMENT_KEYS } = await import("../../shared/src/types");

const GOV = "https://www.exampleton-nv.gov/utilities/solar";
const payload = (over: Record<string, unknown> = {}) => ({
  state: "NV", utility: "Exampleton Municipal Light", displayName: "Exampleton Municipal Light", rowExists: true,
  items: [
    { key: "meter_photo", whenMissing: "blocker", tier: "official", sourceName: "Solar page", sourceUrl: GOV, quote: "Every application must include a photo of the meter.", fetchedAt: "2026-11-10T00:00:00Z", origin: "row", inEffect: true },
    { key: "one_line", whenMissing: "warning", tier: "seeded", sourceName: "Shipped reference", sourceUrl: "", quote: "", origin: "shipped", inEffect: true },
    { key: "account_verification", whenMissing: "warning", tier: "verified", sourceName: "Bill page", sourceUrl: "https://www.example-light-power.com/bill", quote: "Bring your account number from a recent bill.", verifiedBy: "Pat Synthetic", verifiedAt: "2026-11-09T12:00:00Z", origin: "row", inEffect: true },
  ],
  ...over,
});

console.log("\nthe panel module");
await check("RENDER: each item with its tier, source and words; Verify on seeded/official, Edit on a person's; the form", () => {
  const html = UR.renderRequirementsPanel(payload());
  assert.match(html, /What Exampleton Municipal Light's application asks for/);
  assert.match(html, /3 items \(1 verified, 1 official, 1 seeded\)/);
  assert.match(html, /data-req-provenance>Verified from www\.exampleton-nv\.gov, 2026-11-10</);
  assert.match(html, /data-req-provenance>Verified by Pat Synthetic, 2026-11-09</);
  assert.match(html, /data-req-provenance>Seeded \(shipped reference\)</);
  assert.match(html, /<a href="https:\/\/www\.exampleton-nv\.gov\/utilities\/solar"[^>]*data-req-source>Solar page<\/a>/);
  assert.match(html, /data-req-quote-missing/);
  assert.match(html, /may block when missing/);
  assert.equal((html.match(/data-req-verify=/g) ?? []).length, 2);
  assert.equal((html.match(/data-req-edit=/g) ?? []).length, 1);
  assert.match(html, /data-req-form/);
  for (const k of UTILITY_REQUIREMENT_KEYS) assert.ok(html.includes(`<option value="${k}">`), `the form offers ${k}`);
});
await check("RENDER: no filing row = the list, no controls; no utility = nothing; nothing on file says the utility side is not reviewed", () => {
  const html = UR.renderRequirementsPanel(payload({ rowExists: false }));
  assert.ok(!/data-req-verify|data-req-edit|data-req-form/.test(html));
  assert.match(html, /data-req-no-row/);
  assert.equal(UR.renderRequirementsPanel(payload({ utility: "" })), "");
  assert.match(UR.renderRequirementsPanel(payload({ items: [] })), /nothing on file: the utility side is not reviewed/);
});
await check("ESCAPED: every interpolated value; a non-http source is never a link", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const html = UR.renderRequirementsPanel(payload({
    utility: evil, displayName: evil,
    items: [{ key: "meter_photo", whenMissing: "warning", tier: "verified", sourceName: evil, sourceUrl: "javascript:alert(1)", quote: evil, verifiedBy: evil, verifiedAt: "x", origin: "row", inEffect: true }],
  }));
  assert.ok(!html.includes("<img"), "no raw markup");
  assert.ok(!/href="javascript/i.test(html), "no javascript: link");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});
await check("FORM: strict payload (a known kind, an http(s) page, the page's words), mode merge; Verify fills it with the item", () => {
  assert.equal(UR.formPayload({ key: "roof_photo", sourceUrl: GOV, quote: "words long enough" }).ok, false);
  assert.equal(UR.formPayload({ key: "meter_photo", sourceUrl: "ftp://x", quote: "words long enough" }).ok, false);
  assert.equal(UR.formPayload({ key: "meter_photo", sourceUrl: GOV, quote: "short" }).ok, false);
  const ok = UR.formPayload({ key: "meter_photo", whenMissing: "blocker", sourceName: "Solar page", sourceUrl: GOV, quote: "Every   application must include\n a photo of the meter." });
  assert.deepEqual(JSON.parse(JSON.stringify(ok.body)), { requirements: [{ key: "meter_photo", whenMissing: "blocker", sourceUrl: GOV, quote: "Every application must include a photo of the meter.", sourceName: "Solar page" }], mode: "merge" });
  assert.deepEqual(JSON.parse(JSON.stringify(UR.prefill(payload().items[0]))), { key: "meter_photo", whenMissing: "blocker", sourceName: "Solar page", sourceUrl: GOV, quote: "Every application must include a photo of the meter." });
  assert.match(UR.confirmMessage("Exampleton Municipal Light", "meter_photo"), /under your name.*Nothing is sent or filed/s);
});
await check("THE DASHBOARD loads the module, renders it in the utility group and saves through the merge PUT", () => {
  const html = fs.readFileSync(path.join(REPO, "frontend/dashboard.html"), "utf8");
  const js = fs.readFileSync(path.join(REPO, "frontend/dashboard.js"), "utf8");
  assert.ok(html.includes('<script src="/utility-requirements.js"></script>'));
  assert.match(js, /read\("utility-filing\/application-requirements"\)/);
  assert.match(js, /lookupKind === "utility-filing" \? utilityRequirementsHtml\(\)/);
  assert.match(js, /utility-filing\/application-requirements`, \{ method: "PUT"/);
});

// ── Over HTTP ────────────────────────────────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "util-req-panel-"));
const dbPath = path.join(tmpDir, "t.sqlite");
const UTILITY = "Exampleton Municipal Light";
async function fixture(): Promise<{ withRow: string; noRow: string }> {
  process.env.AUTOPILOT_DB_PATH = dbPath;
  process.env.SEED_TEST_INSTALLER = "false";
  process.env.AUTOPILOT_AUTO_START = "0";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
  process.env.BACKUP_DIR = path.join(tmpDir, "backups");
  const { openDatabase } = await import("../src/db");
  const { createClient } = await import("../src/clients");
  const { createProject } = await import("../src/repository");
  const ufMod = await import("../src/utilityFilingLookup");
  const db = await openDatabase();
  try {
    const client = createClient(db, { companyName: "Panel Test Solar", ccbLicenseNumber: "707070" });
    const mk = (utility: string) => createProject(db, { clientId: client.id, owner: "Synthetic Owner", street: "1 Test Way", city: "Exampleton", state: "NV", zip: "89999", ahj: "City of Exampleton", utility } as never).project.id;
    const s = ufMod.saveUtilityFilingLookup(db, {
      state: "NV", utility: UTILITY, lookedUpAt: new Date().toISOString(),
      filing: { value: { name: "Utility application form", url: null }, sourceUrl: GOV, quote: "Submit the utility application form to start interconnection.", origin: "lookup" },
      program: { value: "net_metering", sourceUrl: GOV, quote: "Customers are credited under net metering.", origin: "lookup" },
    } as never);
    assert.ok(s.saved, s.reason);
    return { withRow: mk(UTILITY), noRow: mk("Nowhere Rural Electric") };
  } finally { db.close(); }
}
function stop(server: ChildProcess): void {
  try { process.kill(-server.pid!, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* already gone */ } }
}
async function boot(port: number): Promise<ChildProcess> {
  const env: Record<string, string | undefined> = {
    ...process.env, AUTOPILOT_DB_PATH: dbPath, BACKUP_DIR: path.join(tmpDir, `backups-${port}`), PROJECT_DOCS_DIR: path.join(tmpDir, "docs"),
    AUTOPILOT_AUTO_START: "0", PORT: String(port), SEED_TEST_INSTALLER: "false", MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn",
    ANTHROPIC_API_KEY: "", PERMIT_PROCESS_LOOKUP: "off", CODE_RESEARCH: "off", UTILITY_FILING_LOOKUP: "off",
    SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret", AUTH_ENABLED: "false", NO_PROXY: "*", no_proxy: "*",
  };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
    env: env as NodeJS.ProcessEnv, cwd: REPO, stdio: ["ignore", "pipe", "pipe"], detached: true,
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

const ids = await fixture();
const PORT = 6735 + Math.floor(Math.random() * 15); // its own band
const BASE = `http://127.0.0.1:${PORT}`;
const server = await boot(PORT);
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, json: (() => { try { return JSON.parse(text); } catch { return text; } })() };
};
const route = (id: string) => `/api/projects/${id}/utility-filing/application-requirements`;
try {
  console.log("\nover HTTP");
  await check("GET: the list (empty here), the row exists, and a read writes nothing", async () => {
    const a = await call("GET", route(ids.withRow));
    const b = await call("GET", route(ids.withRow));
    assert.equal(a.status, 200);
    assert.deepEqual(a.json, b.json);
    assert.deepEqual([a.json.utility, a.json.rowExists, a.json.items.length], [UTILITY, true, 0]);
    assert.match(UR.renderRequirementsPanel(a.json), /nothing on file/);
  });
  await check("PUT (the panel's own body, name typed with sign-in off): recorded verified; a second item keeps the first person's", async () => {
    const first = UR.formPayload({ key: "meter_photo", whenMissing: "blocker", sourceName: "Solar page", sourceUrl: GOV, quote: "Every application must include a photo of the meter." });
    const r1 = await call("PUT", route(ids.withRow), { ...first.body, decidedBy: "Pat Synthetic" });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    const second = UR.formPayload({ key: "module_spec", whenMissing: "warning", sourceUrl: GOV, quote: "Attach the module spec sheet for each panel model." });
    const r2 = await call("PUT", route(ids.withRow), { ...second.body, decidedBy: "Lee Synthetic" });
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    const view = (await call("GET", route(ids.withRow))).json;
    assert.deepEqual(view.items.map((x: { key: string; tier: string; verifiedBy: string }) => `${x.key}:${x.tier}:${x.verifiedBy}`).sort(), ["meter_photo:verified:Pat Synthetic", "module_spec:verified:Lee Synthetic"]);
    const html = UR.renderRequirementsPanel(view);
    assert.match(html, /Verified by Pat Synthetic/);
    assert.equal((html.match(/data-req-edit=/g) ?? []).length, 2);
  });
  await check("PUT refused: words that do not name the item (400); a utility with no filing row (409); no name with sign-in off (400)", async () => {
    const wrong = UR.formPayload({ key: "one_line", sourceUrl: GOV, quote: "Every application must include a photo of the meter." });
    assert.equal((await call("PUT", route(ids.withRow), { ...wrong.body, decidedBy: "Pat Synthetic" })).status, 400);
    const fine = UR.formPayload({ key: "one_line", sourceUrl: GOV, quote: "Include a one-line diagram of the system." });
    assert.equal((await call("PUT", route(ids.noRow), { ...fine.body, decidedBy: "Pat Synthetic" })).status, 409);
    assert.equal((await call("PUT", route(ids.withRow), fine.body)).status, 400);
    assert.equal((await call("GET", route(ids.withRow))).json.items.length, 2, "nothing refused was written");
  });
} finally {
  stop(server);
}

console.log(`\n${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
