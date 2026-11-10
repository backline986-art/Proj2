// THE GO-LIVE CHECK (owner, 2026-11-10; backend/src/goLiveCheck.ts, GET /api/go-live,
// `npm run golive:check`, frontend/go-live.js).
//
//   (a) THE ENV MATRIX: each switch and setting, in each state that matters, gives the line state and
//       meaning a person needs (off / on / on-without-sign-in for the filing switches; the client link
//       address red for unset, localhost, a private address, a LAN name; and so on).
//   (b) NEVER A SECRET: every setting the report knows is set to a sentinel; no sentinel reaches the
//       JSON or the text, only "set". PUBLIC_BASE_URL shows its origin and nothing else.
//   (c) EVERY SETTING IS ACCOUNTED FOR: every environment read in the server-side source is on a line
//       or in OTHER_SETTINGS / TEST_ONLY_SETTINGS, so a new switch cannot ship unseen.
//   (d) THE DATABASE: version against the newest migration; the destinations waiting on a person
//       (with the link to that view); client emails held by the link guard; the job worker. ORG-SCOPED
//       (rule 6): the default org never counts another org's rows; null counts both.
//   (e) READ-ONLY: total_changes() is unchanged, and the command line's read-only connection gives
//       the same answers (a write there would throw).
//   (f) the view (node:vm): everything escaped, a destinations button only where the line has one.
//   (g) the route: one GET, admin-gated, reqOrgFilter; the command line opens the database read-only.
// Synthetic data only: invented authorities in state ZZ.
//   npx tsx backend/test/goLiveCheck.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { REPO } from "./_isolate";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

// ── synthetic reference data: one invented AHJ citing its own official page (as filingDestinationQueue.test) ──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "go-live-check-"));
const AHJ_A = "City of Fernhollow";
const AHJ_C = "Village of Quillmere";
const blankProfile = (ahj: string) => ({
  state: "ZZ", ahj, submissionMethod: "", timeline: "",
  requiresElectricianSign: false, requiresElectricalStamp: false, requiresStructuralStamp: false,
  requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false, requiresSolarChecklist: false,
  requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false, requiresFloodplainCheck: false,
  requiresJurisdictionCheck: false, otherRequirements: "", reviewerNotes: "", sourceSheet: "ZZ synthetic",
});
const cited = (ahj: string, value: string, page: string) => ({
  ...blankProfile(ahj), submissionMethod: `Online portal ${value}`,
  citations: [{ field: "submissionMethod", value, sourceUrl: page, quote: "Apply for a Permit", fetchedAt: "2026-11-10T08:19:28Z" }],
});
const refPath = path.join(tmpDir, "reference-ahj-processes.json");
fs.writeFileSync(refPath, JSON.stringify({ generatedFrom: "goLiveCheck.test", count: 2, profiles: [
  cited(AHJ_A, "permits.fernhollow-zz.gov/apply", "https://www.fernhollow-zz.gov/building/solar"),
  cited(AHJ_C, "permits.quillmere-zz.gov/apply", "https://www.quillmere-zz.gov/permits"),
] }));
process.env.AHJ_PROCESS_REFERENCE_PATH = refPath;
process.env.HAND_CHECK_PAGES_PATH = path.join(tmpDir, "none.json");
fs.writeFileSync(process.env.HAND_CHECK_PAGES_PATH, JSON.stringify({ pages: [] }));
const DB_FILE = path.join(tmpDir, "t.sqlite");
process.env.AUTOPILOT_DB_PATH = DB_FILE;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PERMIT_PROCESS_LOOKUP = "off";
process.env.ANTHROPIC_API_KEY = "";
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");

const G = await import("../src/goLiveCheck");
const { CLIENT_LINK_REFUSAL_PREFIX } = await import("../src/clientLinkGuard");
const { openDatabase, DEFAULT_ORG_ID, AppDb, latestSchemaVersion } = await import("../src/db");
const { createClient } = await import("../src/clients");
const repo = await import("../src/repository");
const { addCommunication } = await import("../src/crm");
const { filingDestinationQueue } = await import("../src/filingDestinationProposals");
const { getSubmittalTracks } = await import("../src/submittalTracks");

type Env = Record<string, string | undefined>;
const BROWSER = path.join(tmpDir, "chrome");
fs.writeFileSync(BROWSER, "");
// The caller hands in the queue's counts, as server.ts and the command line do.
const counts = (d: InstanceType<typeof AppDb>) => (orgId: string | null) => filingDestinationQueue(d, orgId, (p) => getSubmittalTracks(d, p)).counts;
const report = (env: Env, db: InstanceType<typeof AppDb> | null = null, orgId: string | null = DEFAULT_ORG_ID, opts: Parameters<typeof G.goLiveReport>[3] = {}) =>
  G.goLiveReport(env, db, orgId, { browserExecutable: BROWSER, now: Date.parse("2026-11-10T12:00:00Z"), ...(db ? { destinationCounts: counts(db) } : {}), ...opts });
const line = async (env: Env, id: string, db: InstanceType<typeof AppDb> | null = null, orgId: string | null = DEFAULT_ORG_ID, opts: Parameters<typeof G.goLiveReport>[3] = {}) => {
  const l = (await report(env, db, orgId, opts)).lines.find((x) => x.id === id);
  assert.ok(l, `no line ${id}`);
  return l!;
};
const LONG = "x".repeat(40);

// ── (a) the env matrix ─────────────────────────────────────────────────────────────────────────
await check("(a) the filing switches: off is safe, on needs sign-in, on without sign-in is a blocker", async () => {
  const cases: Array<[Env, string, string, RegExp]> = [
    [{}, "final-submit", "off", /never clicks/],
    [{ PORTAL_ALLOW_FINAL_SUBMIT: "1", AUTH_ENABLED: "true" }, "final-submit", "ok", /named person approves/],
    [{ PORTAL_ALLOW_FINAL_SUBMIT: "1" }, "final-submit", "red", /sign-in off/],
    [{ PORTAL_ALLOW_FINAL_SUBMIT: "true", AUTH_ENABLED: "true" }, "final-submit", "off", /never clicks/], // only "1" turns it on
    [{}, "filing-email", "off", /draft/],
    [{ FILING_EMAIL_ALLOW_SEND: "1", AUTH_ENABLED: "true" }, "filing-email", "ok", /person-verified address/],
    [{ FILING_EMAIL_ALLOW_SEND: "1" }, "filing-email", "red", /sign-in off/],
    [{ PORTAL_AUTOMATION: "off" }, "portal-automation", "warn", /Switched off/],
    [{ MOCK_PORTAL: "1" }, "mock-portal", "red", /SIMULATED/],
    [{ AUTOPILOT_TEST_SEAMS: "1" }, "test-seams", "red", /Remove/],
  ];
  for (const [env, id, state, meaning] of cases) {
    const l = await line(env, id);
    assert.equal(l.state, state, `${id} ${JSON.stringify(env)} → ${l.state}: ${l.meaning}`);
    assert.match(l.meaning, meaning);
  }
});

await check("(a) the client link address: red when a client could not open it, the origin when it can", async () => {
  for (const base of [undefined, "", "http://localhost:4173", "http://127.0.0.1:4173", "http://192.168.1.20:4173", "http://keelixbox:4173", "https://box.local"]) {
    const l = await line({ PUBLIC_BASE_URL: base }, "public-base-url");
    assert.equal(l.state, "red", `${base}: ${l.state}`);
    assert.match(l.meaning, /held as a draft/);
  }
  const ok = await line({ PUBLIC_BASE_URL: "https://keelix-zz.com/x?y=z" }, "public-base-url");
  assert.equal(ok.state, "ok");
  assert.equal(ok.meaning, "Client links start with https://keelix-zz.com.");
  assert.equal((await line({ PUBLIC_BASE_URL: "http://keelix-zz.com" }, "public-base-url")).state, "warn");
});

await check("(a) client email, mail server, staff alerts, QuickBooks, lookups, sign-in and secrets", async () => {
  const cases: Array<[Env, string, string]> = [
    [{}, "client-email", "ok"], [{ CLIENT_NOTIFICATIONS: "off" }, "client-email", "warn"], [{ CLIENT_NOTIFICATIONS: "0" }, "client-email", "warn"],
    [{}, "smtp", "warn"], [{ SMTP_HOST: "mail.example.test", SMTP_FROM: "a@example.test" }, "smtp", "ok"],
    [{ SMTP_HOST: "mail.example.test", SMTP_FROM: "a@example.test", SMTP_USER: "u" }, "smtp", "warn"],
    [{}, "staff-alerts", "warn"], [{ STAFF_ALERT_WEBHOOK_URL: "https://ntfy.example.test/topic" }, "staff-alerts", "ok"],
    [{}, "quickbooks", "off"], [{ QUICKBOOKS_SYNC: "1" }, "quickbooks", "red"],
    [{ QUICKBOOKS_SYNC: "1", QUICKBOOKS_CLIENT_ID: "a", QUICKBOOKS_CLIENT_SECRET: "b" }, "quickbooks", "ok"],
    [{}, "parcel-lookup", "ok"], [{ PARCEL_LOOKUP: "off" }, "parcel-lookup", "off"],
    [{}, "permit-process-lookup", "off"], [{ ANTHROPIC_API_KEY: "k" }, "permit-process-lookup", "ok"],
    [{ ANTHROPIC_API_KEY: "k", PERMIT_PROCESS_LOOKUP: "off" }, "permit-process-lookup", "off"],
    [{ ANTHROPIC_API_KEY: "k", UTILITY_FILING_LOOKUP: "false" }, "utility-filing-lookup", "off"],
    [{}, "auth", "red"], [{ AUTH_ENABLED: "true" }, "auth", "ok"],
    [{}, "session-key", "red"], [{ SESSION_ENCRYPTION_KEY: "replace-with-a-long-random-secret" }, "session-key", "red"],
    [{ SESSION_ENCRYPTION_KEY: "short" }, "session-key", "warn"], [{ SESSION_ENCRYPTION_KEY: LONG }, "session-key", "ok"],
    [{ SESSION_ENCRYPTION_KEY: LONG, AUTH_SECRET: LONG }, "auth-secret", "red"],
    [{ SESSION_ENCRYPTION_KEY: LONG, AUTH_SECRET: "y".repeat(40) }, "auth-secret", "ok"],
    [{}, "listen", "ok"], [{ SERVER_HOST: "0.0.0.0" }, "listen", "red"], [{ SERVER_HOST: "0.0.0.0", AUTH_ENABLED: "true" }, "listen", "warn"],
    [{}, "model-key", "red"], [{ ANTHROPIC_API_KEY: "k" }, "model-key", "ok"],
    [{}, "backups", "red"], [{}, "offbox-backups", "red"],
  ];
  for (const [env, id, state] of cases) {
    const l = await line(env, id);
    assert.equal(l.state, state, `${id} ${JSON.stringify(env)} → ${l.state}: ${l.meaning}`);
  }
});

await check("(a) the browser and backups read the disk: a missing browser is red, a fresh snapshot is ok", async () => {
  assert.equal((await line({}, "browser", null, DEFAULT_ORG_ID, { browserExecutable: path.join(tmpDir, "no-such-browser") })).state, "red");
  assert.equal((await line({}, "browser")).state, "ok");
  const dir = path.join(tmpDir, "snapshots");
  fs.mkdirSync(dir, { recursive: true });
  const snap = path.join(dir, "autopilot-2026-11-10T11-00-00.sqlite");
  fs.writeFileSync(snap, "");
  const now = Date.now();
  fs.utimesSync(snap, new Date(now - 3_600_000), new Date(now - 3_600_000));
  const fresh = await line({ BACKUP_DIR: dir, BACKUP_INTERVAL_HOURS: "4" }, "backups", null, DEFAULT_ORG_ID, { now });
  assert.equal(fresh.state, "ok", fresh.meaning);
  const stale = await line({ BACKUP_DIR: dir, BACKUP_INTERVAL_HOURS: "4" }, "backups", null, DEFAULT_ORG_ID, { now: now + 48 * 3_600_000 });
  assert.equal(stale.state, "red", stale.meaning);
  assert.ok(!fresh.meaning.includes(dir) && !stale.meaning.includes(dir), "a folder path reached the report");
  assert.equal((await line({ BACKUP_SECOND_DIR: dir }, "offbox-backups", null, DEFAULT_ORG_ID, { now })).state, "ok");
});

await check("(a) the report's verdict: ready only with no red line; counts add up", async () => {
  const r = await report({});
  assert.equal(r.ready, false);
  assert.equal(r.counts.red + r.counts.warn + r.counts.off + r.counts.ok, r.lines.length);
  assert.match(G.renderGoLiveText(r), new RegExp(`GO-LIVE: ${r.counts.red} red`));
});

// ── (b) never a secret ─────────────────────────────────────────────────────────────────────────
await check("(b) NEVER A SECRET: every known setting set to a sentinel; none reaches the JSON or the text", async () => {
  const env: Env = {};
  let i = 0;
  for (const name of G.goLiveKnownSettings()) env[name] = `zqSENTINEL${i++}qz`;
  // Settings whose VALUE decides a state are still sentinels: only a set/not-set and a meaning may show.
  env.PUBLIC_BASE_URL = "https://operator:zqPASSqz@keelix-zz.com/path?token=zqTOKENqz";
  const r = await report(env);
  const json = JSON.stringify(r);
  const text = G.renderGoLiveText(r);
  for (const out of [json, text]) {
    assert.ok(!/zq[A-Z0-9]+qz/.test(out), `a value leaked: ${out.match(/.{40}zq[A-Z0-9]+qz.{20}/)?.[0]}`);
  }
  assert.ok(r.lines.every((l) => l.settings.every((s) => s.set === true)));
  assert.match(text, /SESSION_ENCRYPTION_KEY: set/);
  // The base carries a password, so it is refused, and its origin (no user info) is all that could show.
  assert.equal(r.lines.find((l) => l.id === "public-base-url")!.state, "red");
});

// ── (c) every setting is accounted for ─────────────────────────────────────────────────────────
await check("(c) every environment read in the server-side source is on a line or listed", () => {
  const roots = ["backend/src", "portal-bot/src", "shared/src"];
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(path.join(REPO, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(rel); continue; }
      if (/\.(ts|mts|js)$/.test(e.name) && !/\.test\.ts$|\.smoke\.ts$/.test(e.name)) files.push(rel);
    }
  };
  roots.forEach(walk);
  const names = new Set<string>();
  const patterns = [
    /\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)/g, /\b(?:process\.env|env)\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g,
    /_ENV\s*=\s*"([A-Z][A-Z0-9_]+)"/g, /\bn\("([A-Z][A-Z0-9_]+)"/g, /\bflagOff\("([A-Z][A-Z0-9_]+)"/g,
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(REPO, f), "utf8");
    for (const re of patterns) for (const m of src.matchAll(re)) names.add(m[1]);
  }
  // Read for the process's own plumbing, not a deployment setting.
  for (const n of ["NODE_ENV", "DISPLAY", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "TEMP", "TMP", "TMPDIR", "CI", "https_proxy", "HTTP_PROXY", "NO_PROXY"]) names.delete(n);
  const known = G.goLiveKnownSettings();
  const missing = [...names].filter((n) => !known.has(n)).sort();
  assert.deepEqual(missing, [], `settings the code reads that the go-live check does not list: ${missing.join(", ")}`);
  assert.ok(names.size > 150, `the scan found only ${names.size} names: is it still reading the source?`);
});

// ── (d)/(e) the database ───────────────────────────────────────────────────────────────────────
const db = await openDatabase();
const OTHER_ORG = "org-golive-other";
const mine = createClient(db, { companyName: "Golive One Solar", ccbLicenseNumber: "791791" });
const theirs = createClient(db, { companyName: "Golive Other Solar", ccbLicenseNumber: "792792" });
const mk = (clientId: string, ahj: string, owner: string) =>
  repo.createProject(db, { clientId, owner, street: "1 Test Way", city: "Fernhollow", state: "ZZ", zip: "99999", ahj } as never).project.id as string;
const jobMine = mk(mine.id, AHJ_A, "Synthetic Owner One");
const jobTheirs = mk(theirs.id, AHJ_C, "Synthetic Owner Two");
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES (?, ?, ?, ?)", [OTHER_ORG, "Other synthetic org", "full", new Date().toISOString()]);
db.run("UPDATE projects SET org_id = ? WHERE id = ?", [OTHER_ORG, jobTheirs]);
db.run("UPDATE clients SET org_id = ? WHERE id = ?", [OTHER_ORG, theirs.id]);
const held = (projectId: string, orgId: string) => addCommunication(db, {
  projectId, orgId, direction: "outbound", channel: "email", subject: "Permit issued", body: "x", loggedBy: "client-notifier (automated)",
  deliveryStatus: "draft", deliveryDetail: `${CLIENT_LINK_REFUSAL_PREFIX} PUBLIC_BASE_URL is not set.`, recipient: "updates@golive.example.test",
});
held(jobMine, DEFAULT_ORG_ID);
held(jobTheirs, OTHER_ORG);
held(jobTheirs, OTHER_ORG);
const changes = () => Number(db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0);

await check("(d) the database version: up to date is ok; behind or ahead of this build is red", async () => {
  assert.equal((await line({}, "schema", db)).state, "ok");
  assert.match((await line({}, "schema", db)).meaning, new RegExp(`v${latestSchemaVersion()}`));
});

await check("(d) destinations waiting on a person: counted for the caller's org, with the link to that view", async () => {
  const l = await line({}, "destinations", db, DEFAULT_ORG_ID);
  assert.equal(l.state, "warn", l.meaning);
  assert.match(l.meaning, /^1 authority/);
  assert.equal(l.view, "destinations");
  const all = await line({}, "destinations", db, null);
  assert.match(all.meaning, /^2 authority/);
  const other = await line({}, "destinations", db, OTHER_ORG);
  assert.match(other.meaning, /^1 authority/);
});

await check("(d) ORG-SCOPED: emails held by the link guard count the caller's org only; null counts every org", async () => {
  assert.match((await line({}, "held-links", db, DEFAULT_ORG_ID)).meaning, /^1 client email/);
  assert.match((await line({}, "held-links", db, OTHER_ORG)).meaning, /^2 client email/);
  assert.match((await line({}, "held-links", db, null)).meaning, /^3 client email/);
  assert.equal((await line({}, "held-links", db, DEFAULT_ORG_ID)).state, "red");
  assert.ok(!JSON.stringify(await report({}, db, DEFAULT_ORG_ID)).includes(jobTheirs), "another org's job id reached the report");
});

await check("(d) the job worker: the server's own answer, off when background work is off, a stuck queue on the command line", async () => {
  assert.equal((await line({}, "job-worker", db, DEFAULT_ORG_ID, { source: "server", workerRunning: true })).state, "ok");
  assert.equal((await line({}, "job-worker", db, DEFAULT_ORG_ID, { source: "server", workerRunning: false })).state, "red");
  assert.equal((await line({ BACKGROUND_WORKERS: "off" }, "job-worker", db, DEFAULT_ORG_ID, { source: "server", workerRunning: true })).state, "red");
  assert.equal((await line({}, "job-worker", db, DEFAULT_ORG_ID, { source: "cli" })).state, "ok");
  db.run("INSERT INTO job_queue (id, job_type, payload, status, created_at, org_id) VALUES ('job-golive-stuck', 'qc', '{}', 'pending', '2026-11-10T10:00:00Z', ?)", [DEFAULT_ORG_ID]);
  const stuck = await line({}, "job-worker", db, DEFAULT_ORG_ID, { source: "cli" });
  assert.equal(stuck.state, "red", stuck.meaning);
  assert.equal((await line({}, "job-worker", db, OTHER_ORG, { source: "cli" })).state, "ok", "another org's stuck job reached this org's line");
  db.run("DELETE FROM job_queue WHERE id = 'job-golive-stuck'");
});

await check("(e) READ-ONLY: the report writes nothing, and a read-only connection gives the same answers", async () => {
  const c0 = changes();
  const first = await report({}, db, null, { source: "cli" });
  for (let i = 0; i < 2; i++) await report({}, db, DEFAULT_ORG_ID);
  assert.equal(changes(), c0, "the go-live check wrote to the database");
  const { default: Database } = await import("better-sqlite3");
  const ro = new AppDb(new Database(DB_FILE, { readonly: true, fileMustExist: true }));
  try {
    const viaRo = await report({}, ro, null, { source: "cli" });
    const strip = (r: typeof first) => r.lines.filter((l) => l.area === "data" || l.id === "held-links" || l.id === "unsent").map((l) => [l.id, l.state, l.meaning]);
    assert.deepEqual(strip(viaRo), strip(first));
    assert.ok(!viaRo.lines.some((l) => /Could not be read/.test(l.meaning)), JSON.stringify(viaRo.lines.filter((l) => /Could not/.test(l.meaning))));
  } finally { ro.close(); }
});

await check("(d) the schema line goes red when the database is behind this build", async () => {
  const { default: Database } = await import("better-sqlite3");
  const copy = path.join(tmpDir, "behind.sqlite");
  db.backupTo(copy);
  const raw = new Database(copy);
  raw.prepare("DELETE FROM schema_meta WHERE version = (SELECT MAX(version) FROM schema_meta)").run();
  raw.close();
  const behind = new AppDb(new Database(copy, { readonly: true }));
  try {
    const l = await line({}, "schema", behind);
    assert.equal(l.state, "red");
    assert.match(l.meaning, /start the server once/);
  } finally { behind.close(); }
  const none = await report({}, null);
  assert.equal(none.lines.find((l) => l.id === "database")?.state, "red");
});

// ── (f) the view ───────────────────────────────────────────────────────────────────────────────
await check("(f) the view escapes everything and shows a destinations button only on that line", async () => {
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(read("frontend/go-live.js"), ctx);
  const GoLive = ctx.GoLive as { render: (r: unknown) => string };
  const r = await report({}, db, DEFAULT_ORG_ID);
  const html = GoLive.render(r);
  assert.equal((html.match(/data-golive-open="destinations"/g) ?? []).length, 1);
  assert.match(html, /data-golive-line="public-base-url" data-golive-state="red"/);
  const hostile = { ...r, lines: [{ ...r.lines[0], label: "<img src=x onerror=1>", meaning: "\"><script>x</script>", settings: [{ name: "<b>N</b>", set: true }] }], other: [{ name: "<i>", set: false }] };
  const out = GoLive.render(hostile);
  assert.ok(!/<img|<script|<b>N|<i>/.test(out), out);
  assert.match(GoLive.render(null), /did not load/);
});

// ── (g) the route and the command line ─────────────────────────────────────────────────────────
await check("(g) the route is one GET, admin-gated, org-filtered; the command line opens the database read-only", () => {
  const server = read("backend/src/server.ts");
  const regs = [...server.matchAll(/app\.(get|post|put|delete|patch)\(\s*"\/api\/go-live[^"]*"/g)].map((m) => m[0]);
  assert.deepEqual(regs, ['app.get("/api/go-live"']);
  const start = server.indexOf('app.get("/api/go-live"');
  const body = server.slice(start, server.indexOf("\napp.", start + 10));
  assert.match(body, /requireAdmin\(req\)/);
  assert.match(body, /reqOrgFilter\(db, req\)/);
  assert.match(body, /destinationCounts: \(orgId\) => filingDestinationQueue\(db, orgId,/, "the route counts destinations for the org it was given");
  const cli = read("scripts/golive-check.ts");
  assert.match(cli, /readonly: true, fileMustExist: true/);
  assert.ok(!/openDatabase\(/.test(cli), "the command line must not open the database through openDatabase (it migrates)");
  assert.match(read("package.json"), /"golive:check": "tsx scripts\/golive-check.ts"/);
  const mod = read("backend/src/goLiveCheck.ts");
  assert.ok(!/\b(db\.run|db\.exec|INSERT |UPDATE |DELETE |fetch\(|sendEmail)/.test(mod), "the go-live module holds a write, a send or a network call");
});

db.close();
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\ngoLiveCheck: all checks passed");
process.exit(0);
