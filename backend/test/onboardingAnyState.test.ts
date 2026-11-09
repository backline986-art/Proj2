// ISSUE #682 — the onboarding scripts assumed an Oregon client.
//
//   1. scripts/onboard-company.ts refused every intake with no CCB number (Oregon's licence) and could
//      not write per-state licences, the intake tag or intake senders; its --example was an Oregon
//      company. A Utah or Idaho company had to be hand-entered after the script ran.
//   2. scripts/onboarding-readiness.ts read the overlay with track null in the licence state (default
//      OR) and graded the Oregon CCB column as THE staging gate, so a non-Oregon client with every
//      licence on file warned "ccbLicenseNumber missing" forever.
//   3. Neither the coverage report nor the readiness check knew the email filing channel (#667) or a
//      utility filed inside the AHJ permit (#664), and both still said a portal-less stage "reports
//      success" on the mock — staging now stops (the mock runs only on MOCK_PORTAL=1).
//
// Pins, with invented companies in two non-Oregon states (no network, no browser, scratch DB):
//   (a) a Utah + Idaho intake with stateLicenses and no CCB onboards; licences land per state through
//       licenceFor; the intake tag is written (normalised) and the senders stored; a re-run is unchanged;
//   (b) a re-run adding a licence ADDS it and keeps the ones on file;
//   (c) refusals: no licence anywhere; an Oregon licence state with no CCB column (the needsCcb gate);
//       an unknown kind; a placeholder number; an intake tag another client holds;
//   (d) --example names no state and no Oregon portal, and refuses to run until filled in;
//   (e) readiness: no "ccbLicenseNumber" warning for the Utah client, licences graded per state and
//       track, a missing electrical licence on a NEM state is a blocker, no "reports success" wording;
//   (f) coverage: a verified filing-email record → READY NOW "files by email (verified)"; an unusable
//       one → CANNOT FILE YET "verified address needed"; a utility verified as filed with the permit
//       follows the permit row; a portal-less row no longer claims the mock "reports success".
//
// KILL TEST: run against main's three scripts (ONBOARD_SCRIPT / READINESS_SCRIPT, and revert
// coverage-report.ts) — (a), (c), (d), (e) and (f) fail.
//
// Run: npx tsx backend/test/onboardingAnyState.test.ts
import { REPO, ISOLATED_CWD } from "./_isolate";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dbPath = path.join(ISOLATED_CWD, "onboard-any-state.sqlite");
process.env.AUTOPILOT_DB_PATH = dbPath;
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.SESSION_ENCRYPTION_KEY = "unit-test-key-not-a-real-secret";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.MOCK_PORTAL;

const { openDatabase } = await import("../src/db");
const { getClient, createClient, licenceFor } = await import("../src/clients");
const fe = await import("../src/filingEmail");
const ufl = await import("../src/utilityFilingLookup");
const { permitProcessKey } = await import("../src/permitProcess");
const { buildCoverageReport, renderCoverageReport, parseJurisdictions } = await import("../../scripts/coverage-report");
const db = await openDatabase();

const ONBOARD = process.env.ONBOARD_SCRIPT || path.join(REPO, "scripts", "onboard-company.ts");
const READINESS = process.env.READINESS_SCRIPT || path.join(REPO, "scripts", "onboarding-readiness.ts");
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

let n = 0;
function run(script: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [TSX, script, ...args, "--db", dbPath], {
    cwd: ISOLATED_CWD, // no .env here
    env: { ...process.env, AUTOPILOT_DB_PATH: dbPath, PUBLIC_BASE_URL: "https://keelix.example.invalid" },
    encoding: "utf8", timeout: 120_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function onboard(body: Record<string, unknown>, flags: string[] = []): { code: number; out: string } {
  const file = path.join(ISOLATED_CWD, `intake-${++n}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return run(ONBOARD, [file, ...flags]);
}

const business = (name: string, state: string): Record<string, unknown> => ({
  companyName: name, contactEmail: "office@quarrystone.invalid", contactName: "Lee Testwell",
  businessAddress: "1 Test Way", businessCity: "Testville", businessState: state, businessZip: "84000",
  businessPhone: "555-010-0101", businessEmail: "permits@quarrystone.invalid",
  authorizedSignerName: "Lee Testwell", authorizedSignerTitle: "Owner",
  standardDisconnectMake: "Testco", standardDisconnectModel: "TD-60",
});
const UT_ID_INTAKE = {
  client: {
    ...business("Quarrystone Solar", "UT"),
    licenseState: "UT",
    stateLicenses: [
      { state: "UT", kind: "contractor", number: "UT-C-4471", expires: "2027-06-30" },
      { state: "Utah", kind: "EC", number: "UT-E-8812" },
      { state: "ID", kind: "electrical_contractor", number: "ID-E-552" },
    ],
    intakeTag: "Quarrystone",
    intakeSenders: ["@quarrystone.invalid", "ops@quarry-partner.invalid"],
  },
  portalCredentials: [],
};
const clientId = (name: string): string => String(db.get<{ id: string }>("SELECT id FROM clients WHERE company_name = ?", [name])?.id ?? "");

// ── (a) a Utah + Idaho company onboards with its own licences ─────────────────────────────────
console.log("onboard-company: a non-Oregon company");
const dry = onboard(UT_ID_INTAKE, ["--dry-run"]);
check("(a) dry run exits 0 with no CCB number (Oregon's licence is not every state's)", () => {
  assert.equal(dry.code, 0, dry.out.slice(-2000));
  assert.doesNotMatch(dry.out, /ccbLicenseNumber is blank/);
});
check("(a) the plan names the licence each state's jobs get — labels only, never the numbers", () => {
  assert.match(dry.out, /licence ID\s+contractor slot: ID electrical contractor licence — set/);
  assert.match(dry.out, /licence UT\s+contractor slot: several on file/);
  assert.match(dry.out, /intake tag\s+quarrystone/);
  for (const num of ["UT-C-4471", "UT-E-8812", "ID-E-552"]) assert.ok(!dry.out.includes(num), `${num} printed`);
});
const real = onboard(UT_ID_INTAKE);
check("(a) the real run exits 0", () => assert.equal(real.code, 0, real.out.slice(-2000)));
check("(a) licences land per state and kind, through licenceFor", () => {
  const c = getClient(db, clientId("Quarrystone Solar"));
  assert.equal(licenceFor(c, "UT", "contractor").number, "UT-C-4471");
  assert.equal(licenceFor(c, "UT", "contractor").expires, "2027-06-30");
  assert.equal(licenceFor(c, "UT", "electrical_contractor").number, "UT-E-8812");
  assert.equal(licenceFor(c, "ID", { track: "electrical" }).number, "ID-E-552");
  assert.equal(licenceFor(c, "OR", "contractor").number, "", "no Oregon licence appears from nowhere");
});
check("(a) the intake tag is written normalised and the senders stored", () => {
  const c = getClient(db, clientId("Quarrystone Solar"));
  assert.equal(c.intakeTag, "quarrystone");
  assert.equal(c.intakeSenders, "@quarrystone.invalid, ops@quarry-partner.invalid");
});
check("(a) an identical re-run changes nothing", () => {
  const again = onboard(UT_ID_INTAKE, ["--dry-run"]);
  assert.equal(again.code, 0, again.out.slice(-1500));
  assert.match(again.out, /Nothing written\. 0 row\(s\)\/grant\(s\) would be created or changed\./);
});

// ── (b) additive ─────────────────────────────────────────────────────────────────────────────
check("(b) a re-run listing one new licence adds it and keeps every licence on file", () => {
  const r = onboard({ client: { companyName: "Quarrystone Solar", stateLicenses: [{ state: "ID", kind: "contractor", number: "ID-RCE-77" }] }, portalCredentials: [] });
  assert.equal(r.code, 0, r.out.slice(-1500));
  const c = getClient(db, clientId("Quarrystone Solar"));
  assert.equal(licenceFor(c, "ID", "contractor").number, "ID-RCE-77");
  assert.equal(licenceFor(c, "UT", "contractor").number, "UT-C-4471", "the stored Utah licence survived");
  assert.equal(licenceFor(c, "ID", "electrical_contractor").number, "ID-E-552");
});

// ── (c) refusals ──────────────────────────────────────────────────────────────────────────────
const refused = (body: Record<string, unknown>, pattern: RegExp, label: string): void => check(label, () => {
  const r = onboard(body, ["--dry-run"]);
  assert.equal(r.code, 1, r.out.slice(-1500));
  assert.match(r.out, pattern);
});
refused({ client: { ...business("Nolicence Solar", "ID") }, portalCredentials: [] }, /no licence is on file for this company in any state/,
  "(c) no licence in any state is refused");
refused({ client: { ...business("Webfoot Solar", "OR"), licenseState: "OR", stateLicenses: [{ state: "OR", kind: "electrical_contractor", number: "C-998" }] }, portalCredentials: [] },
  /ccbLicenseNumber is blank[\s\S]*needsCcb/, "(c) an Oregon licence state with no CCB column is refused (the needsCcb gate)");
refused({ client: { ...business("Oddkind Solar", "UT"), stateLicenses: [{ state: "UT", kind: "plumbing wizard", number: "UT-55" }] }, portalCredentials: [] },
  /names no licence kind/, "(c) an unknown licence kind is refused");
refused({ client: { ...business("Template Solar", "UT"), stateLicenses: [{ state: "UT", kind: "contractor", number: "REPLACE-ME" }] }, portalCredentials: [] },
  /is a placeholder/, "(c) a placeholder licence number is refused");
refused({ client: { ...business("Tagclash Solar", "UT"), intakeTag: "quarrystone", stateLicenses: [{ state: "UT", kind: "contractor", number: "UT-C-1" }] }, portalCredentials: [] },
  /intakeTag "quarrystone" is already used by Quarrystone Solar/, "(c) an intake tag another client holds is refused before anything is written");
check("(c) nothing was written by any refusal", () => {
  for (const name of ["Nolicence Solar", "Webfoot Solar", "Oddkind Solar", "Template Solar", "Tagclash Solar"]) assert.equal(clientId(name), "", name);
});

// ── (d) the example ───────────────────────────────────────────────────────────────────────────
check("(d) --example is a state-neutral company: no Oregon, licences in stateLicenses, intake tag present", () => {
  const r = spawnSync(process.execPath, [TSX, ONBOARD, "--example"], { cwd: ISOLATED_CWD, encoding: "utf8", timeout: 60_000 });
  const ex = JSON.parse(r.stdout) as { client: Record<string, unknown>; portalCredentials: Array<Record<string, unknown>> };
  assert.doesNotMatch(r.stdout, /"OR · |aca-oregon|Portland|"OR"/);
  assert.equal(ex.client.ccbLicenseNumber, "");
  assert.ok(Array.isArray(ex.client.stateLicenses) && (ex.client.stateLicenses as unknown[]).length >= 2);
  assert.ok("intakeTag" in ex.client && "intakeSenders" in ex.client);
  const file = path.join(ISOLATED_CWD, "example.json");
  fs.writeFileSync(file, r.stdout);
  const ran = run(ONBOARD, [file, "--dry-run"]);
  assert.equal(ran.code, 1, "an unfilled example must not run");
  assert.match(ran.out, /"XX" is not a US state/);
});

// ── (e) readiness ─────────────────────────────────────────────────────────────────────────────
console.log("onboarding-readiness: per state and track");
const rd = run(READINESS, ["--client", "Quarrystone", "--jurisdictions", "UT|City of Larkspur Hollow|Larkspur Hollow Light, ID|Fernbank County|"]);
check("(e) no Oregon CCB warning for a Utah/Idaho client", () => {
  assert.doesNotMatch(rd.out, /ccbLicenseNumber\s+blank/);
  assert.doesNotMatch(rd.out, /CCB \(Oregon's gate\)/);
});
check("(e) licences graded per state and track", () => {
  assert.match(rd.out, /\[ok  \]\s+permit: building slot\s+UT contractor licence — set/);
  assert.match(rd.out, /\[ok  \]\s+NEM: electrical licence\s+UT electrical contractor licence — set/);
  assert.match(rd.out, /\[ok  \]\s+permit: electrical slot\s+ID electrical contractor licence — set/);
  // The overlay is read per state and track the jobs file (never "the licence state, track null").
  for (const st of ["UT permit", "UT nem", "ID permit"]) assert.match(rd.out, new RegExp(`overlay ${st}\\s`));
  assert.doesNotMatch(rd.out, /overlay ID nem/, "Idaho has no utility in scope");
  for (const num of ["UT-C-4471", "UT-E-8812", "ID-E-552"]) assert.ok(!rd.out.includes(num), `${num} printed`);
});
check("(e) a portal-less jurisdiction says Stage stops, never that the mock reports success", () => {
  assert.match(rd.out, /Stage stops with nothing to drive/);
  assert.doesNotMatch(rd.out, /report success/);
});
createClient(db, { ...business("Gablecrest Solar", "UT"), stateLicenses: [{ state: "UT", kind: "contractor", number: "UT-C-2020" }] });
check("(e) a NEM state with no electrical contractor licence is a blocker", () => {
  const r = run(READINESS, ["--client", "Gablecrest", "--jurisdictions", "UT|City of Larkspur Hollow|Larkspur Hollow Light"]);
  assert.match(r.out, /\[FAIL\]\s+NEM: electrical licence\s+none on file/);
  assert.match(r.out, /\[ok  \]\s+permit: contractor slot\s+UT contractor licence — set/);
});

// ── (f) coverage: the email channel and filed-with-permit ─────────────────────────────────────
console.log("coverage-report: the email channel and a utility filed with the permit");
const STATE = "UT";
const now = new Date().toISOString();
function processRow(ahj: string): void {
  db.run(
    `INSERT INTO permit_process_lookups (profile_key, state, ahj, confidence, payload_json, looked_up_at, updated_at)
     VALUES (?, ?, ?, 'seeded', '{}', ?, ?)`,
    [permitProcessKey(STATE, ahj), STATE, ahj, now, now],
  );
}
const LARKSPUR = "City of Larkspur Hollow";
const LARK_PAGE = "https://www.larkspurhollow.example.gov/building/solar";
const LARK_ADDRESS = "permits@larkspurhollow.example.gov";
processRow(LARKSPUR);
const larkAuthority = fe.authorityForTrack({ state: STATE, ahj: LARKSPUR, utility: "" } as never, "permit")!;
const saved = fe.setFilingEmail(db, larkAuthority, { address: LARK_ADDRESS, sourceUrl: LARK_PAGE, quote: `Email solar permit applications to ${LARK_ADDRESS}.` }, "Pat Operator");
check("(f) setup: a person verified the city's filing address", () => assert.equal(saved.saved, true, saved.reason));

const MOSSBY = "Town of Mossby";
processRow(MOSSBY);
db.run("UPDATE permit_process_lookups SET filing_email_json = ? WHERE profile_key = ?", [
  JSON.stringify({ address: "mossby.permits@gmail.com", sourceUrl: "https://mossby.example.gov/permits", quote: "Send to mossby.permits@gmail.com", verifiedBy: "Pat Operator", verifiedAt: now }),
  permitProcessKey(STATE, MOSSBY),
]);

const LIGHT = "Larkspur Hollow Light";
const LIGHT_PAGE = "https://www.larkspurhollow.example.gov/utilities/net-metering";
const LIGHT_QUOTE = "The net metering application is submitted with the building permit application.";
ufl.saveUtilityFilingLookup(db, {
  state: STATE, utility: LIGHT,
  filing: { value: { name: "City building permit application", url: null, method: "with_ahj_permit" }, sourceUrl: LIGHT_PAGE, quote: LIGHT_QUOTE, origin: "lookup" },
  program: { value: "net_metering", sourceUrl: LIGHT_PAGE, quote: LIGHT_QUOTE, origin: "lookup" },
  lookedUpAt: now,
} as never);
const verified = ufl.verifyUtilityFilingLookup(db, { state: STATE, utility: LIGHT }, { verifiedBy: "Pat Operator" });
check("(f) setup: a person verified the utility files inside the permit", () => assert.ok(ufl.nemFiledWithPermit(db, { state: STATE, utility: LIGHT }), verified.reason));

const report = buildCoverageReport(db, { id: clientId("Quarrystone Solar"), name: "Quarrystone Solar" },
  parseJurisdictions(`UT|${LARKSPUR}|${LIGHT}, UT|${MOSSBY}|, UT||${LIGHT}, UT|Hamlet of Thistlewick|`));
const row = (ahj: string, track: string, utility = "") => report.rows.find((r) => r.ahj === ahj && r.track === track && (!utility || r.utility === utility))!;
check("(f) a verified filing-email record → READY NOW, files by email (verified), no portal or login asked", () => {
  const r = row(LARKSPUR, "permit");
  assert.equal(r.bucket, "ready_now", r.reason);
  assert.match(r.reason, /files by email \(verified\)/);
  assert.match(r.reason, new RegExp(LARK_ADDRESS.replace(/\./g, "\\.")));
  assert.equal(r.channel?.kind, "email");
});
check("(f) an unusable record → CANNOT FILE YET, verified address needed", () => {
  const r = row(MOSSBY, "permit");
  assert.equal(r.bucket, "cannot_file_yet", r.reason);
  assert.match(r.reason, /verified address needed/);
  assert.match(r.reason, /personal mailbox/);
});
check("(f) a utility verified as filed with the permit follows the permit row — no NEM portal", () => {
  const r = row(LARKSPUR, "nem");
  assert.equal(r.channel?.kind, "with_permit");
  assert.equal(r.bucket, "ready_now", r.reason);
  assert.match(r.reason, /files inside the City of Larkspur Hollow permit application/);
  assert.equal(r.portalUrl, "");
});
check("(f) ...and with no AHJ named, it cannot ride in a permit", () => {
  const r = report.rows.find((x) => x.track === "nem" && !x.ahj)!;
  assert.equal(r.bucket, "cannot_file_yet", r.reason);
  assert.match(r.reason, /no AHJ is named/);
});
check("(f) a portal-less AHJ: Stage stops; the mock is named only as the MOCK_PORTAL=1 rehearsal", () => {
  const r = row("Hamlet of Thistlewick", "permit");
  assert.equal(r.bucket, "cannot_file_yet");
  assert.match(r.reason, /Stage stops here with nothing to drive/);
  assert.match(r.reason, /MOCK_PORTAL=1/);
  assert.doesNotMatch(r.reason, /reports success/);
});
check("(f) the rendered report names the channel instead of 'no portal URL known'", () => {
  const text = renderCoverageReport(report);
  assert.match(text, /files by email permits@larkspurhollow\.example\.gov \(verified\)/);
  assert.match(text, /files inside the permit application \(verified\)/);
  assert.match(text, /none needed — no portal is used on this track/);
});

db.close();
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nonboardingAnyState: all checks passed");
