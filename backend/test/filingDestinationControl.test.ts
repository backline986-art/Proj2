// THE PROPOSED FILING DESTINATION CONTROL (frontend/filing-destination.js, loaded through node:vm) and
// its wiring in the dashboard, then one round trip over HTTP on a real server (auth off).
//
// Pins, on synthetic authorities (invented names, state ZZ):
//   - a proposal renders the address, "Proposed — not yet confirmed", the official page link (http(s)
//     only) with its host and read date, the page's words, and Confirm / Edit / Reject; when the words
//     do not contain the address the card says so; a proposal with problems renders Confirm DISABLED
//     with the reasons; a verified authority renders nothing; rejected proposals list who/why with
//     "Offer again"; skipped sources fold away; every value is escaped;
//   - Confirm sends EXACTLY the proposal shown (id, kind, address, page, words), Edit sends the person's
//     own statement with no proposal id;
//   - the wiring: dashboard.html loads the module before dashboard.js; the track groups render the
//     block; each click asks the named-person confirm BEFORE its one route call;
//   - over HTTP: the GET renders a confirmable proposal; the dashboard's PUT confirms it under the
//     typed name; the re-read shows the authority verified and the track "verified by a person".
//   npx tsx backend/test/filingDestinationControl.test.ts
import "./_isolate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { REPO } from "./_isolate";

let failures = 0;
const check = async (label: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};
const read = (rel: string): string => { try { return fs.readFileSync(path.join(REPO, rel), "utf8"); } catch { return ""; } };

const sandbox: { window: Record<string, unknown>; URL: typeof URL } = { window: {}, URL };
try { vm.runInNewContext(read("frontend/filing-destination.js"), sandbox, { filename: "filing-destination.js" }); } catch { /* reported below */ }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FD = sandbox.window.FilingDestination as any;
await check("filing-destination.js registers window.FilingDestination", () => assert.ok(FD, "not registered"));
if (!FD) { console.log("\nfilingDestinationControl: FAILED"); process.exit(1); }

const HOSTILE = `<img src=x onerror="alert(1)">`;
const proposal = (over: Record<string, unknown> = {}) => ({
  id: "abc123", kind: "portal", address: "https://permits.fernhollow-zz.gov/apply", sourceUrl: "https://www.fernhollow-zz.gov/building/solar",
  sourceHost: "www.fernhollow-zz.gov", quote: "Apply for a Permit", fetchedAt: "2026-11-10T08:19:28Z", from: "reference",
  quoteNamesAddress: false, problems: [], ...over,
});
const dest = (over: Record<string, unknown> = {}) => ({
  authority: { kind: "ahj", name: "City of Fernhollow", state: "ZZ", profileKey: "zz|city of fernhollow" },
  tracks: ["combo"], status: "proposed", proposals: [proposal()], rejected: [], skipped: [], ...over,
});
const enabledConfirm = (html: string) => /<button[^>]*data-fd-confirm[^>]*>/.test(html) && !/<button[^>]*data-fd-confirm[^>]*disabled[^>]*>/.test(html);

await check("a proposal renders the address, 'not yet confirmed', the official page, its words and Confirm / Edit / Reject", () => {
  const html: string = FD.renderGroup({ destinations: [dest()] }, "ahj");
  assert.match(html, /https:\/\/permits\.fernhollow-zz\.gov\/apply/);
  assert.match(html, /Proposed — not yet confirmed/);
  assert.match(html, /<a href="https:\/\/www\.fernhollow-zz\.gov\/building\/solar" target="_blank" rel="noopener">www\.fernhollow-zz\.gov<\/a> \(official page\), read 2026-11-10/);
  assert.match(html, /<blockquote class="fd-quote">Apply for a Permit<\/blockquote>/);
  assert.match(html, /do not contain this address: it is the link behind them/);
  assert.ok(enabledConfirm(html), "Confirm is not enabled");
  assert.match(html, /data-fd-edit /);
  assert.match(html, /data-fd-reject /);
  assert.match(html, /Nothing is filed or sent to a proposed destination until a named person confirms it/);
  assert.equal(FD.renderGroup({ destinations: [dest()] }, "utility"), "", "the AHJ's proposal rendered in the utility group");
});

await check("a proposal with problems renders Confirm disabled with the reasons; verified renders nothing", () => {
  const html: string = FD.renderGroup({ destinations: [dest({ proposals: [proposal({ problems: ["run its lookup first"] })] })] }, "ahj");
  assert.ok(!enabledConfirm(html));
  assert.match(html, /Cannot be confirmed: run its lookup first/);
  assert.equal(FD.renderGroup({ destinations: [dest({ status: "verified", proposals: [] })] }, "ahj"), "");
  assert.equal(FD.renderGroup(null, "ahj"), "");
});

await check("rejected proposals list who and why with 'Offer again'; skipped sources fold away", () => {
  const html: string = FD.renderGroup({ destinations: [dest({ proposals: [], status: "none", rejected: [{ id: "r1", kind: "portal", address: "https://old.example.gov/", rejectedBy: "Pat", rejectedAt: "2026-11-10T09:00:00Z", reason: "old tenant" }], skipped: ["x (y): not official"] })] }, "ahj");
  assert.match(html, /rejected by Pat on 2026-11-10: old tenant/);
  assert.match(html, /data-fd-unreject data-fd-track="combo" data-fd-id="r1"/);
  assert.match(html, /<details class="fd-skipped"><summary>1 source\(s\) not proposed/);
});

await check("every value is escaped and only an http(s) page is linked", () => {
  const html: string = FD.renderGroup({ destinations: [dest({ authority: { kind: "ahj", name: HOSTILE, state: "ZZ", profileKey: HOSTILE }, proposals: [proposal({ address: HOSTILE, quote: HOSTILE, sourceUrl: `javascript:alert(1)`, sourceHost: HOSTILE, id: HOSTILE })] })] }, "ahj");
  assert.ok(!html.includes("<img"), "an <img> got through");
  assert.ok(!/href="javascript:/i.test(html), "a javascript: link was rendered");
});

await check("Confirm sends exactly the proposal shown; Edit sends the person's own statement with no proposal id", () => {
  const p = proposal();
  assert.deepEqual(JSON.parse(JSON.stringify(FD.confirmBody("combo", p))), { track: "combo", proposalId: "abc123", kind: "portal", address: p.address, sourceUrl: p.sourceUrl, quote: p.quote });
  const e = JSON.parse(JSON.stringify(FD.editBody("combo", { kind: "email", address: " a@b.gov ", sourceUrl: "https://b.gov/x", quote: "Send to a@b.gov", name: "" })));
  assert.deepEqual(e, { track: "combo", kind: "email", address: "a@b.gov", sourceUrl: "https://b.gov/x", quote: "Send to a@b.gov" });
  assert.ok(!("proposalId" in e));
});

await check("wiring: the page loads the module before dashboard.js; the groups render it; each click names the person before its one call", () => {
  const html = read("frontend/dashboard.html");
  const mod = html.indexOf('src="/filing-destination.js"');
  assert.ok(mod > 0 && mod < html.indexOf('src="/dashboard.js"'), "filing-destination.js is not loaded before dashboard.js");
  const js = read("frontend/dashboard.js");
  assert.match(js, /\$\{trackLookupHtml\(lookupKind\)\}\$\{filingDestinationHtml\(lookupKind\)\}/);
  assert.match(js, /read\("filing-destinations"\)/);
  assert.match(js, /bindFilingDestinationButtons\(wrap\);/);
  const start = js.indexOf("async function decideFilingDestination(");
  const fn = js.slice(start, js.indexOf("\nfunction bindFilingDestinationButtons", start));
  assert.ok(start > 0, "decideFilingDestination missing");
  const consent = [...fn.matchAll(/namedPersonConsent\(/g)].map((m) => m.index!);
  const call = fn.indexOf("await api(path,");
  assert.equal(consent.length, 4, "each of the four actions asks the named-person confirm");
  assert.ok(consent.every((i) => i < call), "a route is called before the person is named");
  assert.equal((fn.match(/if \(by == null\) return;/g) || []).length, 4, "backing out of the confirm still calls the route");
  assert.equal((fn.match(/await api\(/g) || []).length, 2, "a click calls something besides its one route and the project re-read");
});

// ── over HTTP: the GET renders a confirmable proposal; the dashboard's PUT confirms; the re-read is verified ──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filing-destination-control-"));
const dbPath = path.join(tmpDir, "t.sqlite");
const AHJ = "City of Fernhollow";
const PAGE = "https://www.fernhollow-zz.gov/building/solar";

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
  const db = await openDatabase();
  try {
    const client = createClient(db, { companyName: "Destination Control Solar", ccbLicenseNumber: "791791" });
    const projectId = createProject(db, { clientId: client.id, owner: "Synthetic Owner", street: "1 Test Way", city: "Fernhollow", state: "ZZ", zip: "99999", ahj: AHJ } as never).project.id;
    // The per-job permit lookup cites the city's portal on its own .gov page.
    const lk = <T>(value: T | null, quote: string) => ({ value, sourceUrl: PAGE, quote, origin: "lookup" as const });
    const s = ppMod.savePermitProcessLookup(db, {
      state: "ZZ", ahj: AHJ, lookedUpAt: "2026-11-10T08:00:00.000Z", model: "test-model",
      issuingAgency: lk(AHJ, `${AHJ} Building Division`),
      permitStructure: lk<"combo" | "separate">("combo", "one combination permit"),
      permits: [{ discipline: "combo", label: "Residential solar", issuingAgency: lk(AHJ, `${AHJ} Building Division`),
        portalUrl: lk("https://permits.fernhollow-zz.gov/apply", "Apply online at permits.fernhollow-zz.gov"),
        recordType: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not read" },
        documents: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not read" },
        fee: { value: null, sourceUrl: "", quote: "", origin: "lookup", notFound: "not read" } }],
    } as never);
    assert.ok(s.saved, `setup: ${s.reason}`);
    return projectId;
  } finally { db.close(); }
}
function stop(server: ChildProcess): void {
  try { process.kill(-server.pid!, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* gone */ } }
}
async function boot(port: number): Promise<ChildProcess> {
  const env: Record<string, string | undefined> = {
    ...process.env, AUTOPILOT_DB_PATH: dbPath, BACKUP_DIR: path.join(tmpDir, `backups-${port}`), PROJECT_DOCS_DIR: path.join(tmpDir, "docs"),
    AUTOPILOT_AUTO_START: "0", PORT: String(port), SEED_TEST_INSTALLER: "false", MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn",
    ANTHROPIC_API_KEY: "", PERMIT_PROCESS_LOOKUP: "off", CODE_RESEARCH: "off",
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

const projectId = await fixture();
const PORT = 6790 + Math.floor(Math.random() * 15); // its own band
const BASE = `http://127.0.0.1:${PORT}`;
const server = await boot(PORT);
const call = async (method: string, url: string, body?: unknown, expect = 200) => {
  const res = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  assert.equal(res.status, expect, `${method} ${url}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
};
try {
  await check("over HTTP: the GET renders a confirmable proposal; the dashboard's PUT confirms it; the re-read is verified", async () => {
    const before = await call("GET", `/api/projects/${projectId}/filing-destinations`);
    const html: string = FD.renderGroup(before, "ahj");
    assert.ok(enabledConfirm(html), `no enabled Confirm: ${html.slice(0, 400)}`);
    const found = FD.findProposal(before, before.destinations.find((d: { authority: { kind: string } }) => d.authority.kind === "ahj").proposals[0].id);
    const track = found.destination.tracks[0];
    // No name, sign-in off: refused, nothing written.
    await call("PUT", `/api/projects/${projectId}/filing-destinations`, FD.confirmBody(track, found.proposal), 400);
    // Exactly what decideFilingDestination sends after the person types their name.
    const r = await call("PUT", `/api/projects/${projectId}/filing-destinations`, { ...FD.confirmBody(track, found.proposal), decidedBy: "Pat Synthetic" });
    assert.equal(r.action, "confirmed");
    const after = await call("GET", `/api/projects/${projectId}/filing-destinations`);
    assert.equal(after.destinations.find((d: { authority: { kind: string } }) => d.authority.kind === "ahj").status, "verified");
    assert.equal(FD.renderGroup(after, "ahj"), "");
    const tracks = await call("GET", `/api/projects/${projectId}/submittal-tracks`);
    const permit = tracks.tracks.find((t: { category: string }) => t.category === "permit");
    assert.equal(permit.channelBasis, "verified");
    assert.match(permit.channel, /permits\.fernhollow-zz\.gov\/apply \(verified by a person\)/);
  });
} finally {
  stop(server);
}

if (failures) {
  console.error(`\nfilingDestinationControl: ${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nfilingDestinationControl: all checks passed");
process.exit(0);
