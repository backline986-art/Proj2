// THE JOB'S PERMIT-PROCESS / UTILITY-FILING VERIFY CONTROL (#695) — frontend/lookup-verify.js, loaded
// here through node:vm, and the dashboard's wiring to the two existing person-only routes.
//
// PUT /api/projects/:id/permit-process/verify and .../utility-filing/verify were the only doors that
// turn a seeded row into a verified one, and nothing on the dashboard called them. This pins, on
// synthetic rows (invented city and utility names):
//   - a SEEDED row renders its cited facts (source link, the page's words, where each came from) and an
//     enabled "Verify (I checked the authority's page)" control; a VERIFIED row renders "Verified by
//     <name>, <date>" and no control; a row with a value that has no source page or no quote renders the
//     control DISABLED with the reason (a person verifies words, not a blank); a filing row that found no
//     filing location is disabled too; no row on file renders nothing;
//   - an OFFICIAL row (#683) is shown "from <host>", never as person-verified, and still offers Verify:
//     where a filing goes stays person-verified (rule 3);
//   - every interpolated value is escaped, and a source link is shown only for http(s);
//   - the wiring: dashboard.html loads the module before dashboard.js; the track groups render each
//     row and bind the button; the click asks the named-person confirm BEFORE it PUTs the existing
//     route, and sends only the name (verifies the row as it stands, files nothing);
//   - over HTTP on a real server (auth off): the GET bodies render the enabled control, the body the
//     dashboard sends verifies each row under the person's name, and the re-read renders the stamp
//     with no control. The routes themselves are unchanged (permitProcessRoute.test, routeScope.test).
//   npx tsx backend/test/lookupVerifyControl.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { REPO } from "./_isolate";
import { captureOutput, waitForServer } from "./_serverBoot";
import type { PermitProcessLookup } from "../../shared/src/types";
import type { UtilityFilingLookup } from "../src/utilityFilingLookup";

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const run = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

const read = (rel: string): string => {
  try { return fs.readFileSync(path.join(REPO, rel), "utf8"); } catch { return ""; }
};
const src = read("frontend/lookup-verify.js");
const sandbox: { window: Record<string, unknown>; URL: typeof URL } = { window: {}, URL };
try { vm.runInNewContext(src, sandbox, { filename: "lookup-verify.js" }); } catch { /* reported below */ }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LV = sandbox.window.LookupVerify as any;
check("lookup-verify.js registers window.LookupVerify", () => assert.ok(LV, "not registered"));
if (!LV) {
  console.log(`\nlookupVerifyControl: ${failures} check(s) FAILED.`);
  process.exit(1);
}

const HOSTILE = `<img src=x onerror="alert(1)">`;
const AHJ = "City of Fernhollow";
const UTILITY = "Brightwater Valley Electric";
const CITY_PAGE = "https://www.fernhollow-zz.gov/building/solar";
const UTIL_PAGE = "https://www.brightwater-electric.example/solar/apply";
const lk = <T>(value: T | null, sourceUrl = CITY_PAGE, quote = "the words on the page", origin: "lookup" | "state_rule" | "kb" | "operator" = "lookup") =>
  ({ value, sourceUrl, quote, origin });
const nf = (why: string) => ({ value: null, sourceUrl: "", quote: "", origin: "lookup" as const, notFound: why });

// Typed against the shared types, so a field renamed there breaks this fixture at typecheck.
const permitRow = (over: Partial<PermitProcessLookup> = {}): PermitProcessLookup => ({
  profileKey: "zz|city of fernhollow", state: "ZZ", ahj: AHJ, confidence: "seeded",
  issuingAgency: lk(AHJ, CITY_PAGE, `Building permits are issued by the ${AHJ} Building Division.`),
  permitStructure: lk<"separate" | "combo">("combo", CITY_PAGE, "Solar installations require one combination permit."),
  permits: [{
    discipline: "combo", label: "Residential solar",
    issuingAgency: lk(AHJ, CITY_PAGE, `Building permits are issued by the ${AHJ} Building Division.`),
    portalUrl: lk("https://permits.fernhollow-zz.gov/apply", CITY_PAGE, "Apply online at permits.fernhollow-zz.gov."),
    recordType: nf("the portal's catalog was not read"),
    documents: lk(["site plan", "one-line diagram"], CITY_PAGE, "Submit a site plan and a one-line diagram."),
    fee: nf("no fee schedule found"),
  }],
  lookedUpAt: "2026-11-01T00:00:00.000Z",
  ...over,
});
const filingRow = (over: Partial<UtilityFilingLookup> = {}): UtilityFilingLookup => ({
  profileKey: "zz|brightwater valley electric", state: "ZZ", utility: UTILITY, confidence: "seeded",
  filing: lk({ name: "Brightwater Interconnect", url: "https://interconnect.brightwater-electric.example/" }, UTIL_PAGE, "Apply through Brightwater Interconnect, our online portal."),
  program: lk<"net_metering" | "net_billing" | "interconnection_only">("net_metering", UTIL_PAGE, "Our net metering program credits exported energy."),
  lookedUpAt: "2026-11-01T00:00:00.000Z",
  ...over,
});
const pp = (lookup: unknown) => ({ state: "ZZ", ahj: AHJ, lookup });
const uf = (lookup: unknown) => ({ state: "ZZ", utility: UTILITY, lookup });
const enabledButton = (html: string, kind: string) => new RegExp(`<button(?![^>]*disabled)[^>]*data-lookup-verify="${kind}"[^>]*>Verify \\(I checked the authority's page\\)</button>`).test(html);
const disabledButton = (html: string, kind: string) => new RegExp(`<button[^>]*data-lookup-verify="${kind}"[^>]*disabled[^>]*>`).test(html);

// ── render ─────────────────────────────────────────────────────────────────────────────────
check("a SEEDED permit-process row: cited facts with source and quote, and an enabled Verify", () => {
  const html: string = LV.renderLookupVerify("permit-process", pp(permitRow()));
  assert.ok(enabledButton(html, "permit-process"), "no enabled Verify control");
  assert.match(html, /Permit process on file<\/strong> for City of Fernhollow, ZZ/);
  assert.match(html, /Seeded by research/);
  assert.match(html, /<strong>Issuing agency:<\/strong> City of Fernhollow <span class="muted">\(per-job lookup\)<\/span>/);
  assert.match(html, /<a href="https:\/\/www\.fernhollow-zz\.gov\/building\/solar"[^>]*>www\.fernhollow-zz\.gov<\/a>/);
  assert.match(html, /<q data-lookup-quote>Submit a site plan and a one-line diagram\.<\/q>/);
  assert.match(html, /Residential solar \(combination\): documents:<\/strong> site plan; one-line diagram/);
  assert.match(html, /Residential solar \(combination\): fee:<\/strong> <span class="muted">not found — no fee schedule found/);
  assert.ok(!/Verified/.test(html), "a seeded row claims to be verified");
});

check("a SEEDED utility-filing row: the filing location and program, cited, and an enabled Verify", () => {
  const html: string = LV.renderLookupVerify("utility-filing", uf(filingRow()));
  assert.ok(enabledButton(html, "utility-filing"), "no enabled Verify control");
  assert.match(html, /Utility filing location on file<\/strong> for Brightwater Valley Electric, ZZ/);
  assert.match(html, /<strong>Filing location:<\/strong> Brightwater Interconnect — https:\/\/interconnect\.brightwater-electric\.example\//);
  assert.match(html, /<strong>Program:<\/strong> net metering/);
  assert.match(html, /<q data-lookup-quote>Apply through Brightwater Interconnect, our online portal\.<\/q>/);
});

check("a VERIFIED row renders 'Verified by <name>, <date>' and no control (both rows)", () => {
  const v = { confidence: "verified" as const, verifiedBy: "Pat Synthetic", verifiedAt: "2026-11-05T17:00:00.000Z" };
  for (const [kind, html] of [
    ["permit-process", LV.renderLookupVerify("permit-process", pp(permitRow(v)))],
    ["utility-filing", LV.renderLookupVerify("utility-filing", uf(filingRow(v)))],
  ] as Array<[string, string]>) {
    assert.match(html, /Verified by Pat Synthetic, 2026-11-05/, kind);
    assert.ok(!/data-lookup-verify=/.test(html) && !/<button/.test(html), `${kind}: a verified row offers a control`);
  }
  const bare: string = LV.renderLookupVerify("permit-process", pp(permitRow({ confidence: "verified" })));
  assert.match(bare, />Verified</);
  assert.ok(!/undefined|null/.test(bare), "a verified row with no name or date says undefined/null");
});

check("a value with no source page or no quote: Verify DISABLED with the reason", () => {
  const noUrl = permitRow({ issuingAgency: lk(AHJ, "", "Building permits are issued here.") });
  const html: string = LV.renderLookupVerify("permit-process", pp(noUrl));
  assert.ok(disabledButton(html, "permit-process"), "the control is not disabled");
  assert.ok(!enabledButton(html, "permit-process"));
  assert.match(html, /Cannot verify from here: Issuing agency has no source page/);
  assert.match(html, /data-lookup-source-missing/);
  const noQuote = filingRow({ filing: lk({ name: "Brightwater Interconnect", url: null }, UTIL_PAGE, "") });
  const h2: string = LV.renderLookupVerify("utility-filing", uf(noQuote));
  assert.ok(disabledButton(h2, "utility-filing"));
  assert.match(h2, /Filing location has no quote/);
  const neither = filingRow({ program: lk("net_metering" as const, "javascript:alert(1)", "") });
  assert.match(LV.renderLookupVerify("utility-filing", uf(neither)), /Program has no source page or quote/);
});

check("a row with nothing found, or a filing row with no filing location: Verify DISABLED", () => {
  const blank = permitRow({ issuingAgency: nf("x"), permitStructure: nf("x"), permits: [] });
  assert.match(LV.renderLookupVerify("permit-process", pp(blank)), /disabled[\s\S]*every fact on it is not found/);
  const noFiling = filingRow({ filing: nf("no page named a filing location") });
  const html: string = LV.renderLookupVerify("utility-filing", uf(noFiling));
  assert.ok(disabledButton(html, "utility-filing"));
  assert.match(html, /found no filing location/);
});

check("no row on file (or an unknown kind) renders nothing", () => {
  assert.equal(LV.renderLookupVerify("permit-process", pp(null)), "");
  assert.equal(LV.renderLookupVerify("utility-filing", null), "");
  assert.equal(LV.renderLookupVerify("code-profile", pp(permitRow())), "");
});

check("an OFFICIAL row (#683) is 'Verified from <host>, <date>' (owner, 2026-11-13), never 'Verified by', and still offers Verify (filing targets stay person-verified)", () => {
  const official = { ...filingRow(), confidence: "official", officialSource: { host: "www.brightwater-zz.gov", sourceUrl: "https://www.brightwater-zz.gov/net-metering", fetchedAt: "2026-11-09T00:00:00.000Z" } };
  const html: string = LV.renderLookupVerify("utility-filing", uf(official));
  assert.match(html, /Verified from www\.brightwater-zz\.gov, 2026-11-09/);
  assert.ok(!/Verified by/.test(html), "an official row reads as person-verified");
  assert.ok(enabledButton(html, "utility-filing"), "an official row hides the person's Verify");
  assert.match(html, /Where a filing goes stays a person's check/);
  const fact = { ...permitRow(), issuingAgency: { ...lk(AHJ, CITY_PAGE, `issued by the ${AHJ} Building Division`), tier: "official" } };
  assert.match(LV.renderLookupVerify("permit-process", pp(fact)), /City of Fernhollow <span class="muted">\(Verified from www\.fernhollow-zz\.gov(?:, \d{4}-\d\d-\d\d)?\)<\/span>/);
});

check("every interpolated value is escaped; a source link only for http(s)", () => {
  const evil = permitRow({
    ahj: `${AHJ}${HOSTILE}`, state: `Z"${HOSTILE}`,
    issuingAgency: lk(HOSTILE, "javascript:alert(1)", HOSTILE),
    permits: [{ ...permitRow().permits[0], label: HOSTILE, documents: lk([HOSTILE], CITY_PAGE, HOSTILE) }],
  });
  const out = [
    LV.renderLookupVerify("permit-process", pp(evil)),
    LV.renderLookupVerify("permit-process", pp({ ...evil, confidence: "verified", verifiedBy: HOSTILE })),
    LV.renderLookupVerify("utility-filing", uf(filingRow({ utility: HOSTILE, programName: HOSTILE, filing: lk({ name: HOSTILE, url: HOSTILE }, UTIL_PAGE, HOSTILE) }))),
    LV.confirmMessage("permit-process", HOSTILE),
  ].join("\n");
  assert.ok(!out.slice(0, out.lastIndexOf("\nVerify the")).includes("<img"), "a raw <img> tag reached the HTML");
  assert.ok(!/href="javascript:/i.test(out), "a javascript: URL became a link");
  assert.match(out, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

check("the confirm text names the row, the person's check and that nothing is filed", () => {
  const text: string = LV.confirmMessage("utility-filing", `${UTILITY}, ZZ`);
  assert.match(text, /^Verify the utility filing location on file for Brightwater Valley Electric, ZZ\?/);
  assert.match(text, /under your name/);
  assert.match(text, /research never overwrites it/);
  assert.match(text, /Nothing is sent or filed\./);
});

// ── wiring ─────────────────────────────────────────────────────────────────────────────────
const dash = read("frontend/dashboard.js");
const dashHtml = read("frontend/dashboard.html");
const cut = (name: string): string => {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(dash);
  if (!m) throw new Error(`dashboard.js: could not find function ${name}`);
  let depth = 0, end = -1;
  for (let j = dash.indexOf("{", m.index); j < dash.length; j++) {
    if (dash[j] === "{") depth++;
    else if (dash[j] === "}") { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  return dash.slice(m.index, end);
};

check("dashboard.html loads the module before dashboard.js", () => {
  const at = dashHtml.indexOf('<script src="/lookup-verify.js">');
  assert.ok(at > 0 && at < dashHtml.indexOf('src="/dashboard.js"'), "dashboard.html");
});

check("the track groups render each row (utility filing, permit process) and bind Verify", () => {
  const fn = cut("renderSubmittalTracks");
  assert.match(fn, /group\(utilityGroupTitle\(utility\), utility, "utility-filing"\)/);
  assert.match(fn, /group\("AHJ — Permit\(s\)", permits, "permit-process"\)/);
  assert.match(fn, /\$\{trackLookupHtml\(lookupKind\)\}/);
  assert.match(fn, /button\[data-lookup-verify\][\s\S]{0,160}verifyTrackLookup\(btn\.dataset\.lookupVerify, btn\)/);
  assert.match(cut("loadSubmittalTracks"), /await loadTrackLookups\(\)/);
  const load = cut("loadTrackLookups");
  assert.match(load, /\/api\/projects\/\$\{projectId\}\/\$\{kind\}/);
  assert.ok(!/method:/.test(load), "the row read is not a plain GET");
});

check("Verify asks the named-person confirm BEFORE it PUTs the existing route, and sends only the name", () => {
  const fn = cut("verifyTrackLookup");
  const blocked = fn.indexOf("LV.verifyBlockers(kind, payload.lookup).length) return;");
  const consent = fn.indexOf("namedPersonConsent(auth, LV.confirmMessage(kind, name)");
  const put = fn.indexOf("api(`/api/projects/${projectId}/${kind}/verify`, { method: \"PUT\"");
  assert.ok(blocked > 0 && blocked < consent, "a blocked row is not refused before the confirm");
  assert.ok(consent > 0, "no named-person confirm");
  assert.ok(put > consent, "the PUT is not after the confirm");
  assert.match(fn, /if \(verifiedBy == null\) return;/);
  assert.match(fn.slice(put, put + 160), /JSON\.stringify\(verifiedBy \? \{ verifiedBy \} : \{\}\)/);
  assert.equal((fn.match(/api\(/g) || []).length, 2, "Verify calls something besides the verify PUT and the project re-read");
  assert.ok(Object.keys(LV.KINDS).sort().join() === "permit-process,utility-filing", "the control names a route that does not exist");
});

// ── over HTTP: the GET body renders the control; the dashboard's PUT verifies; the re-read stamps ──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lookup-verify-control-"));
const dbPath = path.join(tmpDir, "t.sqlite");

async function fixture(): Promise<string> {
  process.env.AUTOPILOT_DB_PATH = dbPath;
  process.env.SEED_TEST_INSTALLER = "false";
  process.env.AUTOPILOT_AUTO_START = "0";
  process.env.PERMIT_PROCESS_LOOKUP = "off";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
  process.env.BACKUP_DIR = path.join(tmpDir, "backups");
  const { openDatabase } = await import("../src/db");
  const { createClient } = await import("../src/clients");
  const { createProject } = await import("../src/repository");
  const ppMod = await import("../src/permitProcess");
  const ufMod = await import("../src/utilityFilingLookup");
  const db = await openDatabase();
  try {
    const client = createClient(db, { companyName: "Verify Control Solar", ccbLicenseNumber: "695695" });
    const projectId = createProject(db, { clientId: client.id, owner: "Synthetic Owner", street: "1 Test Way", city: "Fernhollow", state: "ZZ", zip: "99999", ahj: AHJ, utility: UTILITY } as never).project.id;
    const { profileKey: _p, confidence: _c, ...permit } = permitRow();
    const s1 = ppMod.savePermitProcessLookup(db, { ...permit, model: "test-model" });
    assert.ok(s1.saved, `setup: permit row not saved (${s1.reason})`);
    const { profileKey: _q, confidence: _d, ...filing } = filingRow();
    const s2 = ufMod.saveUtilityFilingLookup(db, filing);
    assert.ok(s2.saved, `setup: filing row not saved (${s2.reason})`);
    return projectId;
  } finally { db.close(); }
}

function stop(server: ChildProcess): void {
  try { process.kill(-server.pid!, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* already gone */ } }
}

async function boot(port: number): Promise<ChildProcess> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AUTOPILOT_DB_PATH: dbPath,
    BACKUP_DIR: path.join(tmpDir, `backups-${port}`),
    PROJECT_DOCS_DIR: path.join(tmpDir, "docs"),
    AUTOPILOT_AUTO_START: "0",
    PORT: String(port),
    SEED_TEST_INSTALLER: "false",
    MONITOR_INTERVAL_MINUTES: "0",
    LOG_LEVEL: "warn",
    ANTHROPIC_API_KEY: "",
    PERMIT_PROCESS_LOOKUP: "off",
    CODE_RESEARCH: "off",
    SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret",
    AUTH_ENABLED: "false",
    NO_PROXY: "*",
    no_proxy: "*",
  };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
    env: env as NodeJS.ProcessEnv, cwd: REPO, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  // On the server's real state, not a count of tries (see _serverBoot.ts): an exit or a fetch-blocked
  // port fails at once with the child's output, and the boot time is printed.
  const output = captureOutput(server);
  try {
    const { bootMs } = await waitForServer(server, `http://127.0.0.1:${port}/health`, { output });
    console.log(`  (server answered /health after ${bootMs} ms)`);
    return server;
  } catch (e) {
    stop(server);
    throw e;
  }
}

const projectId = await fixture();
const PORT = 6698 + Math.floor(Math.random() * 15); // its own band (6698-6712: 6697 is a fetch-blocked port, see _serverBoot.ts)
const BASE = `http://127.0.0.1:${PORT}`;
const server = await boot(PORT);
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  assert.equal(res.status, 200, `${method} ${url}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
};
try {
  for (const kind of ["permit-process", "utility-filing"]) {
    await run(`${kind}: the GET body renders an enabled Verify; the dashboard's PUT verifies it under the name; the re-read renders the stamp, no control`, async () => {
      const before = await call("GET", `/api/projects/${projectId}/${kind}`);
      assert.equal(before.lookup.confidence, "seeded");
      assert.ok(enabledButton(LV.renderLookupVerify(kind, before), kind), "the seeded row from the route renders no enabled control");
      assert.equal(LV.verifyBlockers(kind, before.lookup).join("; "), "");
      // Exactly what verifyTrackLookup sends with sign-in off.
      await call("PUT", `/api/projects/${projectId}/${kind}/verify`, { verifiedBy: "Pat Synthetic" });
      const after = await call("GET", `/api/projects/${projectId}/${kind}`);
      assert.equal(after.lookup.confidence, "verified");
      assert.equal(after.lookup.verifiedBy, "Pat Synthetic");
      const html: string = LV.renderLookupVerify(kind, after);
      assert.match(html, new RegExp(`Verified by Pat Synthetic, ${new Date().toISOString().slice(0, 4)}-`));
      assert.ok(!/data-lookup-verify=/.test(html), "the verified row still offers a control");
    });
  }
} finally {
  stop(server);
}

if (failures) {
  console.error(`\nlookupVerifyControl: ${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nlookupVerifyControl: all checks passed");
process.exit(0);
