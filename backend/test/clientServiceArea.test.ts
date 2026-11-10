// A CLIENT'S SERVICE AREA (brief client-service-area.md): the states, cities or counties and utilities a
// client works in, on its own row (clients.service_area_json, v80), so "Destinations to confirm" and the
// coverage report list every authority in the area that no open job names yet, marked "service area".
//
// Pinned here, on invented clients and places (state ZZ for the backend, a real code only where the
// onboarding script insists on a US state; every city, county and utility name is invented):
//   (a) the entries: strict check on write (kind, state, a name), lenient read, dedupe, additive merge;
//       createClient / updateClient store it, refuse a bad list with every reason and write nothing,
//       and a save without the key leaves it alone;
//   (b) resolution through the existing name matching, INSIDE THE ENTRY'S STATE ONLY: a city entry names
//       the city's record on file; the same name in another state never does; a county entry never names
//       a city (nor the reverse); a utility entry names the utility on file; nothing on file = as typed;
//   (c) the queue: an area authority with no open job is listed under its client, marked "service area",
//       with exactly the proposals a job naming it would show; one an open job of the client names is
//       listed for the job (not "service area"); a whole-state entry adds nothing by itself;
//   (d) READING THE QUEUE STILL WRITES NOTHING, and the area job is never stored;
//   (e) ORG-SCOPED (rule 6): another org's client's area never reaches this org's queue;
//   (f) the coverage report lists the area's jurisdictions after the jobs', marked "service area";
//   (g) the area never goes to a model and never into a shared table: only the client CRUD, the
//       resolver, the queue and the coverage report read it; no model door imports it; nothing writes a
//       knowledge row from it;
//   (h) the view: a service-area authority shows its badge and the entry it came from, escaped;
//   (i) the onboarding script accepts client.serviceArea (any state), refuses a placeholder or a
//       non-state, and a re-run only adds.
//   npx tsx backend/test/clientServiceArea.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { REPO, ISOLATED_CWD } from "./_isolate";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
};
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

// ── synthetic reference data: invented AHJs in state ZZ (and one twin name in YY) ──────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-service-area-"));
const CITY = "City of Larkspur Hollow";
const COUNTY = "Larkspur County"; // shares the place core with a DIFFERENT city
const CITY_LARKSPUR = "City of Larkspur";
const CITY_JOB = "City of Thistlebrook";
const YY_TWIN = "City of Pennywhistle"; // only in YY
const UTIL = "Copperfen Valley Electric";
const PAGE = "https://www.larkspurhollow-zz.gov/building/solar";
const PORTAL = "https://permits.larkspurhollow-zz.gov/apply";
const UTIL_PAGE = "https://www.copperfen-zz.gov/solar/apply";
const UTIL_PORTAL = "https://copperfen.powerclerk.com/MvcAccount/Login";
const READ_AT = "2026-11-10T08:19:28Z";
const blankProfile = (state: string, ahj: string) => ({
  state, ahj, submissionMethod: "", timeline: "",
  requiresElectricianSign: false, requiresElectricalStamp: false, requiresStructuralStamp: false,
  requiresElectricalPermitApplication: false, requiresBuildingPermitApplication: false, requiresSolarChecklist: false,
  requiresPlanSet: true, requiresUtilityApproval: false, requiresCustomerSignature: false, requiresFloodplainCheck: false,
  requiresJurisdictionCheck: false, otherRequirements: "", reviewerNotes: "", sourceSheet: "ZZ synthetic",
});
const reference = {
  generatedFrom: "clientServiceArea.test", count: 5,
  profiles: [
    { ...blankProfile("ZZ", CITY), submissionMethod: `Online portal ${PORTAL}`, citations: [{ field: "submissionMethod", value: PORTAL.replace(/^https:\/\//, ""), sourceUrl: PAGE, quote: "Apply online at permits.larkspurhollow-zz.gov", fetchedAt: READ_AT }] },
    blankProfile("ZZ", COUNTY),
    blankProfile("ZZ", CITY_LARKSPUR),
    blankProfile("ZZ", CITY_JOB),
    blankProfile("YY", YY_TWIN),
  ],
};
const refPath = path.join(tmpDir, "reference-ahj-processes.json");
fs.writeFileSync(refPath, JSON.stringify(reference));
const handPath = path.join(tmpDir, "hand-check.json");
fs.writeFileSync(handPath, JSON.stringify({ pages: [] }));
process.env.AHJ_PROCESS_REFERENCE_PATH = refPath;
process.env.HAND_CHECK_PAGES_PATH = handPath;
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "t.sqlite");
process.env.SEED_TEST_INSTALLER = "false";
process.env.AUTOPILOT_AUTO_START = "0";
process.env.PERMIT_PROCESS_LOOKUP = "off";
process.env.ANTHROPIC_API_KEY = "";
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.SESSION_ENCRYPTION_KEY = "unit-test-key-not-a-real-secret";

const { openDatabase, DEFAULT_ORG_ID } = await import("../src/db");
const { createClient, updateClient, getClient, listClients } = await import("../src/clients");
const repo = await import("../src/repository");
const fdp = await import("../src/filingDestinationProposals");
const csa = await import("../src/clientServiceArea");
const tracksMod = await import("../src/submittalTracks");
const ufMod = await import("../src/utilityFilingLookup");
const { buildCoverageReport, renderCoverageReport, jurisdictionsFromProjects, jurisdictionsFromServiceArea } = await import("../../scripts/coverage-report");
const db = await openDatabase();

const s1 = ufMod.saveUtilityFilingLookup(db, {
  state: "ZZ", utility: UTIL, lookedUpAt: READ_AT,
  filing: { value: { name: "PowerClerk", url: UTIL_PORTAL }, sourceUrl: UTIL_PAGE, quote: "Submit your interconnection application online through PowerClerk", origin: "lookup" },
  program: { value: "net_metering", sourceUrl: UTIL_PAGE, quote: "Net metering program", origin: "lookup" },
} as never);
assert.ok(s1.saved, `setup: ${s1.reason}`);

const OTHER_ORG = "org-area-other";
db.run("INSERT OR IGNORE INTO orgs (id, name, edition, created_at) VALUES (?, ?, ?, ?)", [OTHER_ORG, "Other synthetic org", "full", new Date().toISOString()]);
const AREA = [
  { kind: "state", state: "ZZ", name: "" },
  { kind: "city", state: "ZZ", name: "Larkspur Hollow" },
  { kind: "city", state: "ZZ", name: "Thistlebrook" },
  { kind: "utility", state: "zz", name: "Copperfen Valley Electric Co" },
];
const areaClient = createClient(db, { companyName: "Area One Solar", serviceArea: AREA });
const otherClient = createClient(db, { companyName: "Other Org Area Solar", serviceArea: [{ kind: "city", state: "ZZ", name: "Larkspur Hollow" }] }, OTHER_ORG);
const mk = (clientId: string, ahj: string, utility: string, owner: string) =>
  repo.createProject(db, { clientId, owner, street: "1 Test Way", city: "Testville", state: "ZZ", zip: "99999", ahj, utility } as never).project.id as string;
// The client's own open job names Thistlebrook: that authority is the job's, not "service area".
const jobThistle = mk(areaClient.id, CITY_JOB, "", "Synthetic Owner One");

const readTracks = (p: Parameters<typeof tracksMod.getSubmittalTracks>[1]) => tracksMod.getSubmittalTracks(db, p);
const queue = (orgId: string | null = DEFAULT_ORG_ID) => fdp.filingDestinationQueue(db, orgId, readTracks);
const changes = () => (db.get<{ n: number }>("SELECT total_changes() AS n")?.n ?? 0);
const entry = (q: ReturnType<typeof queue>, clientId: string, kind: string, name: string) =>
  q.clients.find((c) => c.clientId === clientId)?.authorities.find((a) => a.authority.kind === kind && a.authority.name === name);

await check("(a) the entries: strict on write, lenient on read, deduped; the merge only adds", () => {
  assert.deepEqual(csa.serviceAreaProblems(AREA), []);
  const bad = csa.serviceAreaProblems([{ kind: "region", state: "ZZ", name: "X" }, { kind: "city", state: "Z9", name: "X" }, { kind: "city", state: "ZZ", name: "" }, { kind: "utility", state: "ZZ", name: "123" }, { kind: "city", state: "ZZ", name: "Alpha" }, { kind: "city", state: "zz", name: "ALPHA" }]);
  assert.equal(bad.length, 5, bad.join("\n"));
  assert.match(bad.join("\n"), /kind "region"/);
  assert.match(bad.join("\n"), /state "Z9"/);
  assert.match(bad.join("\n"), /names the city/);
  assert.match(bad.join("\n"), /repeats ALPHA, ZZ/);
  assert.deepEqual(csa.serviceAreaProblems("not a list"), ["serviceArea must be a list of { kind, state, name } entries."]);
  assert.deepEqual(csa.parseServiceArea('[{"kind":"STATE","state":"zz","name":"ignored"},{"kind":"city","state":"ZZ","name":"  Alpha  "},{"kind":"bogus"},{"kind":"city","state":"ZZ","name":"alpha"}]'),
    [{ kind: "state", state: "ZZ", name: "" }, { kind: "city", state: "ZZ", name: "Alpha" }]);
  assert.deepEqual(csa.parseServiceArea("{oops"), []);
  const merged = csa.mergeServiceArea([{ kind: "city", state: "ZZ", name: "Alpha" }], [{ kind: "city", state: "ZZ", name: "alpha" }, { kind: "utility", state: "ZZ", name: "Beta Power" }]);
  assert.deepEqual(merged.map((e) => e.name), ["Alpha", "Beta Power"]);
});

await check("(a) the client row stores it; a bad list is refused with every reason and writes nothing; a save without the key keeps it", () => {
  const stored = getClient(db, areaClient.id).serviceArea!;
  assert.equal(stored.length, 4);
  assert.deepEqual(stored[3], { kind: "utility", state: "ZZ", name: "Copperfen Valley Electric Co" });
  assert.ok(listClients(db).find((c) => c.id === areaClient.id)!.serviceArea!.length === 4);
  const c0 = changes();
  assert.throws(() => updateClient(db, areaClient.id, { serviceArea: [{ kind: "city", state: "ZZ", name: "" }] }), /Service area not saved: .*names the city/);
  assert.throws(() => createClient(db, { companyName: "Refused Area Solar", serviceArea: [{ kind: "moon", state: "ZZ", name: "x" }] }), /Service area not saved/);
  assert.equal(changes(), c0, "a refused service area wrote something");
  updateClient(db, areaClient.id, { notes: "a note" });
  assert.equal(getClient(db, areaClient.id).serviceArea!.length, 4, "a save without serviceArea changed it");
  const fresh = createClient(db, { companyName: "No Area Solar" });
  assert.deepEqual(getClient(db, fresh.id).serviceArea, []);
  updateClient(db, fresh.id, { serviceArea: [{ kind: "county", state: "ZZ", name: "Larkspur" }] });
  assert.deepEqual(getClient(db, fresh.id).serviceArea, [{ kind: "county", state: "ZZ", name: "Larkspur" }]);
  updateClient(db, fresh.id, { serviceArea: [] });
  assert.deepEqual(getClient(db, fresh.id).serviceArea, []);
});

await check("(b) resolution: inside the entry's state only, same kind of government, existing name matching", () => {
  const r = (e: { kind: "state" | "city" | "county" | "utility"; state: string; name: string }) => csa.resolveServiceAreaEntry(db, e);
  assert.equal(r({ kind: "state", state: "ZZ", name: "" }), null, "a whole-state entry named an authority");
  assert.deepEqual([r({ kind: "city", state: "ZZ", name: "Larkspur Hollow" })!.name, r({ kind: "city", state: "ZZ", name: "Larkspur Hollow" })!.matchedFrom], [CITY, "reference"]);
  // County vs city of the same core: each names its own kind only.
  assert.equal(r({ kind: "county", state: "ZZ", name: "Larkspur" })!.name, COUNTY);
  assert.equal(r({ kind: "city", state: "ZZ", name: "Larkspur" })!.name, CITY_LARKSPUR);
  // "Larkspur" never resolves to "Larkspur Hollow" (a different place core).
  assert.notEqual(r({ kind: "city", state: "ZZ", name: "Larkspur" })!.name, CITY);
  // STATE MISMATCH ALWAYS LOSES: the YY city is not ZZ's.
  const twin = r({ kind: "city", state: "ZZ", name: "Pennywhistle" })!;
  assert.deepEqual([twin.name, twin.matchedFrom], ["Pennywhistle", "typed"]);
  assert.equal(r({ kind: "city", state: "YY", name: "Pennywhistle" })!.name, YY_TWIN);
  // A utility, by the knowledge base's own name matcher ("… Co" is the same utility).
  const u = r({ kind: "utility", state: "ZZ", name: "Copperfen Valley Electric Co" })!;
  assert.deepEqual([u.kind, u.name, u.matchedFrom], ["utility", UTIL, "lookup"]);
  assert.equal(r({ kind: "utility", state: "YY", name: "Copperfen Valley Electric Co" })!.matchedFrom, "typed", "a utility matched across states");
  // An unmarked county name gets the word; nothing on file = as typed.
  assert.deepEqual([r({ kind: "county", state: "ZZ", name: "Nowhere" })!.name, r({ kind: "county", state: "ZZ", name: "Nowhere" })!.matchedFrom], ["Nowhere County", "typed"]);
});

await check("(c) the queue lists each area authority with no open job, marked service area, with the proposals a job would show", () => {
  const q = queue();
  const city = entry(q, areaClient.id, "ahj", CITY)!;
  assert.ok(city, "the service-area city is not listed");
  assert.equal(city.serviceArea?.entry.name, "Larkspur Hollow");
  assert.deepEqual(city.jobs, []);
  assert.equal(city.open, null);
  assert.equal(city.status, "proposed");
  assert.deepEqual(city.proposals.map((p) => [p.kind, p.address, p.problems.length]), [["portal", PORTAL, 0]]);
  // Exactly what a real job naming the same authority shows on its track card.
  const probe = mk(fresh2(), CITY, "", "Synthetic Owner Probe");
  const card = fdp.filingDestinationsFor(db, repo.getProjectDetail(db, probe).project, readTracks(repo.getProjectDetail(db, probe).project)).find((g) => g.authority.kind === "ahj")!;
  assert.deepEqual(city.proposals.map(({ act, ...p }) => p), card.proposals);
  db.run("UPDATE projects SET archived_at = ? WHERE id = ?", [new Date().toISOString(), probe]);
  const util = entry(q, areaClient.id, "utility", UTIL)!;
  assert.ok(util?.serviceArea, "the service-area utility is not listed as service area");
  assert.deepEqual(util.tracks, ["nem"]);
  assert.deepEqual(util.proposals.map((p) => p.address), [UTIL_PORTAL]);
  // The client's own job names Thistlebrook: listed for that job, not as service area.
  const thistle = entry(q, areaClient.id, "ahj", CITY_JOB)!;
  assert.ok(thistle, "Thistlebrook is not listed");
  assert.equal(thistle.serviceArea, undefined);
  assert.deepEqual(thistle.jobs.map((j) => j.projectId), [jobThistle]);
  // Only the authorities the entries name: the whole-state entry adds none.
  assert.deepEqual(q.clients.find((c) => c.clientId === areaClient.id)!.authorities.map((a) => a.authority.name).sort(), [CITY, CITY_JOB, UTIL].sort());
  assert.equal(q.counts.serviceArea, 2);
});
function fresh2(): string { return createClient(db, { companyName: "Probe Solar" }).id; }

await check("(d) READING THE QUEUE WRITES NOTHING, and no area job is ever stored", () => {
  const c0 = changes();
  const projects0 = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")!.n;
  for (let i = 0; i < 3; i++) { queue(); queue(null); queue(OTHER_ORG); }
  assert.equal(changes(), c0, "reading the queue wrote to the database");
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")!.n, projects0);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects WHERE id LIKE 'service-area:%'")!.n, 0);
  // A record that merely LOOKS like an area job is not one.
  const real = repo.getProjectDetail(db, jobThistle).project;
  assert.equal(fdp.isServiceAreaJob({ ...real, id: `service-area:${real.id}` }), false);
});

await check("(e) ORG-SCOPED: another org's client's area never reaches this org's queue; that org sees only its own", () => {
  const mine = JSON.stringify(queue());
  assert.ok(!mine.includes("Other Org Area Solar") && !mine.includes(otherClient.id), "another org's service area reached the queue");
  const theirs = queue(OTHER_ORG);
  assert.deepEqual(theirs.clients.map((c) => c.clientName), ["Other Org Area Solar"]);
  assert.deepEqual(theirs.clients[0].authorities.map((a) => [a.authority.name, Boolean(a.serviceArea)]), [[CITY, true]]);
  assert.ok(!JSON.stringify(theirs).includes(areaClient.id));
  assert.ok(queue(null).clients.some((c) => c.clientId === otherClient.id) && queue(null).clients.some((c) => c.clientId === areaClient.id));
});

await check("(f) the coverage report lists the area's jurisdictions after the jobs', marked service area", () => {
  const fromJobs = jurisdictionsFromProjects(db, areaClient.id);
  const fromArea = jurisdictionsFromServiceArea(db, areaClient.id, fromJobs);
  assert.deepEqual(fromArea.map((j) => [j.state, j.ahj, j.utility, j.source]), [["ZZ", CITY, "", "service area"], ["ZZ", "", UTIL, "service area"]]);
  const report = buildCoverageReport(db, { id: areaClient.id, name: "Area One Solar" }, [...fromJobs, ...fromArea]);
  assert.equal(report.jurisdictionSource, "existing projects + service area");
  const areaRows = report.rows.filter((r) => r.serviceArea);
  assert.deepEqual(areaRows.map((r) => [r.track, r.ahj || r.utility]), [["permit", CITY], ["nem", UTIL]]);
  assert.equal(report.rows.find((r) => r.ahj === CITY_JOB)!.serviceArea, undefined);
  assert.match(renderCoverageReport(report), /ZZ \| City of Larkspur Hollow \| \(no utility\)\s+\(service area: no job here yet\)/);
});

await check("(g) the area stays client data: only its readers read it, no model door imports it, nothing shared is written from it", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|js|mts)$/.test(e.name) && !/\.test\.ts$|\.smoke\.ts$/.test(e.name)) files.push(rel);
    }
  };
  for (const d of ["backend/src", "portal-bot/src", "shared/src", "scripts", "tools"]) if (fs.existsSync(path.join(REPO, d))) walk(d);
  const readers = files.filter((f) => /service_area_json|clientServiceArea|serviceAreaEntries/.test(fs.readFileSync(path.join(REPO, f), "utf8"))).sort();
  assert.deepEqual(readers, [
    "backend/src/clientServiceArea.ts", "backend/src/clients.ts", "backend/src/db.ts", "backend/src/filingDestinationProposals.ts",
    "backend/src/serviceAreaEntries.ts", "scripts/coverage-report.ts", "scripts/onboard-company.ts", "shared/src/types.ts",
  ].sort());
  // No reader is, or imports, a model door.
  for (const f of readers) assert.ok(!/from\s+["'][^"']*(?:\/llm|modelPayloadScan|@anthropic-ai)[^"']*["']/.test(fs.readFileSync(path.join(REPO, f), "utf8")) || f === "backend/src/db.ts", `${f} imports a model door`);
  // The resolver and the entry module write nothing at all.
  for (const f of ["backend/src/clientServiceArea.ts", "backend/src/serviceAreaEntries.ts"]) {
    assert.deepEqual(read(f).match(/\b(?:INSERT|UPDATE|DELETE|db\.run|db\.exec|writeFile\w*)\b/g) ?? [], [], `${f} writes`);
  }
  // The client row is the only place it is written.
  assert.deepEqual(read("backend/src/clients.ts").match(/UPDATE clients SET service_area_json/g)?.length, 1);
});

await check("(h) the view: a service-area authority shows its badge and its entry, escaped, and offers no action without a route", () => {
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(read("frontend/filing-destination.js"), sandbox);
  const FD = sandbox.FilingDestination as { renderQueue: (q: unknown) => string };
  const q = queue();
  const html = FD.renderQueue(q);
  assert.match(html, /data-fd-service-area>Service area</);
  assert.match(html, /from the service area entry "Larkspur Hollow, ZZ"/);
  assert.match(html, /only in a service area, with no job yet/);
  const evil = JSON.parse(JSON.stringify(q));
  const a = evil.clients[0].authorities.find((x: { serviceArea?: unknown }) => x.serviceArea);
  a.serviceArea.entry.name = `<img src=x onerror=alert(1)>`;
  a.serviceArea.matchedFrom = "typed";
  for (const p of a.proposals) delete p.areaAct;
  const out = FD.renderQueue(evil);
  assert.ok(!out.includes("<img"), "an entry name was not escaped");
  const one = out.split('<div class="fd-block fd-queue-authority"').find((seg) => seg.includes(`data-fd-authority="${a.authority.profileKey}"`))!;
  assert.ok(/data-fd-area-noact/.test(one) && !/data-fd-(?:confirm|edit|reject|save|unreject)\b/.test(one), "an area proposal with no route offered an action");
});

await check("(i) the onboarding script accepts client.serviceArea in any state, refuses a placeholder or a non-state, and a re-run only adds", () => {
  const dbPath = path.join(ISOLATED_CWD, "onboard-area.sqlite");
  const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  let n = 0;
  const onboard = (client: Record<string, unknown>, flags: string[] = []) => {
    const file = path.join(ISOLATED_CWD, `intake-area-${++n}.json`);
    fs.writeFileSync(file, JSON.stringify({ client, users: [], portalCredentials: [] }, null, 2));
    const r = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts", "onboard-company.ts"), file, ...flags, "--db", dbPath], {
      cwd: ISOLATED_CWD, env: { ...process.env, AUTOPILOT_DB_PATH: dbPath, PUBLIC_BASE_URL: "https://keelix.example.invalid" }, encoding: "utf8", timeout: 120_000,
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const base = {
    companyName: "Wrenfield Area Solar", contactEmail: "office@wrenfield.invalid", contactName: "Lee Testwell",
    businessAddress: "1 Test Way", businessCity: "Testville", businessState: "WY", businessZip: "82000",
    businessPhone: "555-010-0101", businessEmail: "permits@wrenfield.invalid", licenseState: "WY", authorizedSignerName: "Lee Testwell", authorizedSignerTitle: "Owner",
    stateLicenses: [{ state: "WY", kind: "contractor", number: "C-48213" }, { state: "WY", kind: "electrical_contractor", number: "E-48213" }],
  };
  const bad = onboard({ ...base, serviceArea: [{ kind: "city", state: "XX", name: "Gullhaven" }, { kind: "utility", state: "WY", name: "REPLACE-ME" }] });
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /client\.serviceArea\[0\]\.state "XX" is not a US state/);
  assert.match(bad.out, /client\.serviceArea\[1\]\.name "REPLACE-ME" is a placeholder/);
  const first = onboard({ ...base, serviceArea: [{ kind: "state", state: "Wyoming" }, { kind: "city", state: "WY", name: "Gullhaven" }] });
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /service area\s+2 place\(s\) in intake, 2 after merge/);
  const odb = spawnSync(process.execPath, ["-e", `const D=require(${JSON.stringify(path.join(REPO, "node_modules", "better-sqlite3"))});const d=new D(${JSON.stringify(dbPath)});console.log(d.prepare("SELECT service_area_json FROM clients").get().service_area_json)`], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(odb.stdout), [{ kind: "state", state: "WY", name: "" }, { kind: "city", state: "WY", name: "Gullhaven" }]);
  const again = onboard({ ...base, serviceArea: [{ kind: "utility", state: "WY", name: "Gullhaven Light Co-op" }] });
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /fields to update\s+.*serviceArea/);
  const after = spawnSync(process.execPath, ["-e", `const D=require(${JSON.stringify(path.join(REPO, "node_modules", "better-sqlite3"))});const d=new D(${JSON.stringify(dbPath)});console.log(d.prepare("SELECT service_area_json FROM clients").get().service_area_json)`], { encoding: "utf8" });
  assert.equal(JSON.parse(after.stdout).length, 3, "a re-run removed a place on file");
  const unchanged = onboard({ ...base, serviceArea: [{ kind: "city", state: "WY", name: "gullhaven" }] });
  assert.equal(unchanged.code, 0, unchanged.out);
  assert.ok(!/fields to update\s+.*serviceArea/.test(unchanged.out), "a place already on file was reported as a change");
  // --example carries the block, unfilled, so the script refuses it until filled in.
  const ex = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts", "onboard-company.ts"), "--example"], { cwd: ISOLATED_CWD, encoding: "utf8", timeout: 60_000 });
  const example = JSON.parse(ex.stdout) as { client: { serviceArea: Array<{ state: string }> } };
  assert.ok(example.client.serviceArea.length >= 3 && example.client.serviceArea.every((e) => e.state === "XX"));
});

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
