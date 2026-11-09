// A STATUS READ NEVER TAKES A PORTAL SESSION A PERSON OR A RUN HOLDS (#516), AND NEVER SHARES A
// PROFILE WITH A WINDOW A PERSON IS HANDED (#517).
//
// Some portals (PowerClerk) allow one session per account and end the older one when a second sign-in
// appears. The monitor signs in with the client's own login on a schedule, so a read that signed in
// while that account was in use logged a person out mid-review in the hand-over window, or ended a
// stage / learn run partway (a partial draft: staging is not idempotent portal-side). And the recipe
// status read took the correction reopen's own profile, <client>/<type>/<host>, where
// checkStatusWithAdapter first closes any window left open: the next check of any target of that
// client on that host closed the reopen window the person was verifying.
//
// The sweep is the real runDuePermitChecks over targets, recipes, credentials, jobs and runs written
// through the real writers (or raw where only a row shape is needed); the browser and the network are
// stubbed (setStatusCheckSeamsForTests). The #517 checks hand the sweep's own options to the REAL
// checkStatusWithAdapter with no reader, so its real "close the window left open on this profile"
// runs against the real profile the sweep chose, and no browser opens.
//
//   MUST-EXCLUDE a live review marker under the client's profile root → neither signed-in door opens
//                (the recipe read, the #512 record-link read); the target is rescheduled and the card
//                says the account is in use
//   MUST-PASS    an EXPIRED marker → the read runs
//   MUST-PASS    ANOTHER client's live marker → the read runs
//   MUST-EXCLUDE a running portal job (prepare_submission / auto_learn / autopilot) on another of the
//                same client's projects → no signed-in read; another client's running job → the read runs
//   MUST-EXCLUDE a live 'running' stage run (portal_runs) on the client's project → no signed-in read;
//                a dead runner's stale row does not hold the account
//   MUST-PASS    a clientless project is held by a clientless profile's marker, never by a client's
//   MUST-PASS    #517: the recipe read takes a profile of its own (status-read), and a reopen window left
//                open on <client>/utility/<host> (its marker expired, so #516 does not hold the read)
//                survives a sweep that runs the recipe read for the same client and host
//
// Run: npx tsx backend/test/statusReadAccountInUse.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupStageFixture, check, finish } from "./_stageFixture";

process.env.SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || "unit-test-key-not-a-real-secret";
const fx = await setupStageFixture("status-read-account-in-use");
const { db, repo, recipes, client } = fx;
process.env.PORTAL_AUTOSEED = "1"; // the live install's mode: an empty read is skipped, not mocked
process.env.PORTAL_FEE_READ = "off"; // the fee reader has its own suite; never the network here
const { createPortalCredential } = await import("../src/portalCredentials");
const { createClient } = await import("../src/clients");
const { markReviewOpen, REVIEW_MARKER_MAX_AGE_MS } = await import("../../portal-bot/src/reviewSession");
const { checkStatusWithAdapter, trackOpenAdapter } = await import("../../portal-bot/src/index");

const PROFILES = process.env.PORTAL_PROFILES_DIR!;
const HOST = "testpower.powerclerk.com";
const LOGIN = `https://${HOST}/MvcAccount/Login`;
// The #512 door's portal: another utility's host, with no learned recipe, so the recipe door never reads it.
const LINK_HOST = "linkonly.powerclerk.com";
const LINK = `https://${LINK_HOST}/MvcProjects/LandingPage?ProgramId=PROG1&ProjectId=PROJ1`;
const WALL = "Log In Username Password Remember me Forgot password? Log In";
const STATUS = "Application APP-123456 Current Status: Technical Review";
const REVIEW = { action: "stopForReview", selector: {} } as never;
const fill = (i: number) => ({ action: "fill", selector: { name: `f${i}` }, field: "homeownerName", note: `Field ${i}` }) as never;

// The utility's learned recipe (the recipe door) and the client's own login for its host (the #512 door).
const nemRecipe = recipes.startPortalRecording(db, { scopeType: "utility", state: "OR", utility: "Testpower Co", portalUrl: LOGIN, portalPlatform: "powerclerk", createdBy: "test" });
recipes.savePortalRecipeSteps(db, nemRecipe.id, [fill(1), fill(2), REVIEW], { status: "complete" });
createPortalCredential(db, client.id, { portalUrl: LOGIN, username: "own-user", password: "own-pass" });
createPortalCredential(db, client.id, { portalUrl: `https://${LINK_HOST}/MvcAccount/Login`, username: "own-link-user", password: "own-pass" });

type Scrape = { userDataDir: string };
const scrapes: Scrape[] = [];
const linkReads: string[] = [];
let realClose = false; // #517: hand the sweep's options to the real checkStatusWithAdapter (no reader)
repo.setStatusCheckSeamsForTests({
  checkStatus: (async (_adapter: string, apps: string[], opts: { userDataDir?: string }) => {
    scrapes.push({ userDataDir: String(opts.userDataDir) });
    // No recipe → the real function closes what is left open on THIS profile, then finds no reader.
    if (realClose) await checkStatusWithAdapter("recipe", apps, { ...opts, recipe: undefined } as never);
    return STATUS;
  }) as never,
  publicCheck: (async () => WALL) as never,
  signedInLink: (async (url: string) => {
    linkReads.push(url);
    return { text: STATUS, reason: "", outcome: "read", signedIn: true };
  }) as never,
});

const nemTarget = (projectId: string, portalUrl = "") => {
  repo.createPermitCheckTarget(db, projectId, { targetType: "nem", applicationNumber: "APP-123456", portalUrl, portalName: HOST } as never);
  return db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [projectId])!.id;
};
const sweep = async (...ids: string[]) => {
  db.run("UPDATE permit_check_targets SET active = 0");
  // link_lookup_at cleared: a second sweep of one target is not the once-a-day record-list throttle.
  for (const t of ids) db.run("UPDATE permit_check_targets SET active = 1, next_check_at = NULL, link_lookup_at = NULL WHERE id = ?", [t]);
  scrapes.length = 0;
  linkReads.length = 0;
  await repo.runDuePermitChecks(db, "all");
};
const targetRow = (id: string) => db.get<{ read_gap: string; next_check_at: string | null; latest_outcome: string | null }>("SELECT read_gap, next_check_at, latest_outcome FROM permit_check_targets WHERE id = ?", [id])!;
const project = () => fx.newProject({ utility: "Testpower Co" });
const clientRoot = path.join(PROFILES, client.id);
const clearMarkers = () => fs.rmSync(PROFILES, { recursive: true, force: true });

await check("(h0) baseline: with nothing holding the account, the recipe read signs in", async () => {
  clearMarkers();
  const t = nemTarget(project());
  await sweep(t);
  assert.equal(scrapes.length, 1, "the fixture does not reach the recipe door");
});

await check("(h1) MUST-EXCLUDE a live review marker under the client's profile root → no signed-in read on either door; rescheduled, and the card says the account is in use", async () => {
  clearMarkers();
  // A window left open for the person to submit in (staging's own profile: <client>/<portalType>).
  markReviewOpen(path.join(clientRoot, "powerclerk_pge"));
  const recipeTarget = nemTarget(project());
  // The #512 door: a record link behind a sign-in, on a utility with no learned recipe (so the recipe
  // door does not read it first), with the client's own login stored for the link's host.
  const linkTarget = nemTarget(fx.newProject({ utility: "Linkonly Power Co" }), LINK);
  await sweep(recipeTarget);
  assert.equal(scrapes.length, 0, "the recipe status read signed in while a person's review window was open");
  const row = targetRow(recipeTarget);
  assert.ok(row.next_check_at && Date.parse(row.next_check_at) > Date.now(), `the target was not rescheduled: ${row.next_check_at}`);
  assert.match(row.read_gap, /in use/i, `the card does not say why: ${JSON.stringify(row.read_gap)}`);
  await sweep(linkTarget);
  assert.equal(scrapes.length, 0, "the link target reached the recipe door (the fixture is wrong)");
  assert.equal(linkReads.length, 0, "the #512 signed-in record-link read signed in while a person's review window was open");
  assert.match(targetRow(linkTarget).read_gap, /in use/i);
  clearMarkers();
  await sweep(linkTarget);
  assert.equal(linkReads.length, 1, "with the window gone the #512 read does not run (the test is not testing the hold)");
});

await check("(h2) MUST-PASS an EXPIRED marker (older than the 8 h window) → the read runs", async () => {
  clearMarkers();
  const dir = path.join(clientRoot, "utility", HOST);
  markReviewOpen(dir);
  const old = (Date.now() - REVIEW_MARKER_MAX_AGE_MS - 60_000) / 1000;
  fs.utimesSync(path.join(dir, ".keelix-review-open"), old, old);
  const t = nemTarget(project());
  await sweep(t);
  assert.equal(scrapes.length, 1, "an expired marker still held the account");
  assert.equal(targetRow(t).read_gap, "");
});

await check("(h3) MUST-PASS ANOTHER client's live marker → this client's read runs", async () => {
  clearMarkers();
  const other = createClient(db, { companyName: "Other Marker Solar", ccbLicenseNumber: "246810" });
  markReviewOpen(path.join(PROFILES, other.id, "utility", HOST));
  const t = nemTarget(project());
  await sweep(t);
  assert.equal(scrapes.length, 1, "another client's review window held this client's account");
});

await check("(h4) MUST-EXCLUDE a running portal job on another of the client's projects → no signed-in read; another client's running job → the read runs", async () => {
  clearMarkers();
  const busyProject = project();
  const { enqueueJob } = await import("../src/jobQueue");
  for (const jobType of ["prepare_submission", "auto_learn", "autopilot"] as const) {
    const job = enqueueJob(db, jobType, {}, { projectId: busyProject, maxRetries: 0 });
    db.run("UPDATE job_queue SET status = 'running', started_at = ? WHERE id = ?", [new Date().toISOString(), job.id]);
    const t = nemTarget(project());
    await sweep(t);
    assert.equal(scrapes.length, 0, `the status read signed in while a ${jobType} run held the client's account`);
    assert.match(targetRow(t).read_gap, /in use/i);
    db.run("UPDATE job_queue SET status = 'done', finished_at = ? WHERE id = ?", [new Date().toISOString(), job.id]);
  }
  const other = createClient(db, { companyName: "Other Job Solar", ccbLicenseNumber: "135791" });
  const otherProject = repo.createProject(db, { clientId: other.id, owner: "Job Owner", street: "3 Job Way", city: "Testville", state: "OR", zip: "97000", ahj: "Testville", utility: "Testpower Co" } as never).project.id;
  const job = enqueueJob(db, "prepare_submission", {}, { projectId: otherProject, maxRetries: 0 });
  db.run("UPDATE job_queue SET status = 'running', started_at = ? WHERE id = ?", [new Date().toISOString(), job.id]);
  const t = nemTarget(project());
  await sweep(t);
  assert.equal(scrapes.length, 1, "another client's running job held this client's account");
  db.run("UPDATE job_queue SET status = 'done' WHERE id = ?", [job.id]);
});

await check("(h5) MUST-EXCLUDE a live 'running' stage run on the client's project → no signed-in read; a dead runner's stale row does not hold", async () => {
  clearMarkers();
  const busyProject = project();
  const started = new Date().toISOString();
  // Another host's runner, younger than the 6 h cap: portalRunnerAlive cannot tell, so it holds.
  db.run("INSERT INTO portal_runs (id, project_id, run_type, status, started_at, runner, permit_type) VALUES ('run-live', ?, 'stage', 'running', ?, 'other-host|4242|abcd', 'nem')", [busyProject, started]);
  const t = nemTarget(project());
  await sweep(t);
  assert.equal(scrapes.length, 0, "the status read signed in while a stage run held the client's account");
  db.run("UPDATE portal_runs SET runner = '' WHERE id = 'run-live'"); // a row from before runners were recorded: dead
  await sweep(t);
  assert.equal(scrapes.length, 1, "a dead run's stale row held the account");
  db.run("UPDATE portal_runs SET status = 'interrupted' WHERE id = 'run-live'");
});

await check("(h6) MUST-PASS a clientless project: held by a clientless profile's marker, never by a client's", async () => {
  clearMarkers();
  const lone = repo.createProject(db, { owner: "Lone Owner", street: "5 Lone Way", city: "Testville", state: "OR", zip: "97000", ahj: "Testville", utility: "Testpower Co" } as never).project.id;
  db.run("UPDATE projects SET client_id = NULL WHERE id = ?", [lone]);
  const t = nemTarget(lone);
  markReviewOpen(path.join(clientRoot, "utility", HOST)); // a client's window: not this project's account
  await sweep(t);
  assert.equal(scrapes.length, 1, "a client's review window held a clientless project's read");
  markReviewOpen(path.join(PROFILES, "utility", HOST)); // the clientless profile's own window
  await sweep(t);
  assert.equal(scrapes.length, 0, "a clientless review window did not hold the clientless read");
  assert.match(targetRow(t).read_gap, /in use/i);
});

await check("(r1) #517 MUST-PASS the recipe read takes a profile of its own, never the reopen's <client>/utility/<host>", async () => {
  clearMarkers();
  const t = nemTarget(project());
  await sweep(t);
  assert.equal(scrapes.length, 1);
  const reopenDir = path.join(clientRoot, "utility", HOST);
  assert.notEqual(path.resolve(scrapes[0].userDataDir), path.resolve(reopenDir), "the status read took the correction reopen's profile");
  assert.ok(/status-read/.test(scrapes[0].userDataDir), `not a profile of its own: ${scrapes[0].userDataDir}`);
});

await check("(r2) #517 MUST-PASS a reopen window left open on <client>/utility/<host> survives a sweep that runs the recipe read for that client and host", async () => {
  clearMarkers();
  const reopenDir = path.join(clientRoot, "utility", HOST);
  let closed = false;
  const window = { close: async () => { closed = true; } } as never;
  trackOpenAdapter(reopenDir, window); // the reopen run's own hand-over: tracked + marked
  // Past the marker's window, so #516 does not hold the read: only the profile choice protects it.
  const old = (Date.now() - REVIEW_MARKER_MAX_AGE_MS - 60_000) / 1000;
  fs.utimesSync(path.join(reopenDir, ".keelix-review-open"), old, old);
  realClose = true;
  try {
    const t = nemTarget(project());
    await sweep(t);
    assert.equal(scrapes.length, 1, "the recipe read did not run (the test is not testing the profile)");
    assert.equal(closed, false, "the status read closed the reopen window a person was handed to verify and submit in");
  } finally {
    realClose = false;
  }
});

finish("statusReadAccountInUse");
