// A PERSON'S "CHECK NOW" CHECKS NOW, PACED (issue #160).
//
// The dashboard's Permit checks / NEM checks called the due-only sweep, so on a 7-day cadence a
// click checked nothing ("Permit monitor ran 0 due check(s)", 1 ms) while a live job's permits sat
// issued on the city's portal. A click now reads every active target of its kind — paced one portal
// host at a time — and answers per filing. The 15-minute sweep stays due-only. Only the outside
// world is stubbed (setStatusCheckSeamsForTests): the selection, the pacing and the recording are
// the real runPermitChecksNow / runDuePermitChecks.
//
//   MUST-PASS    a click reads a target whose next_check_at is a week away, and records it
//   MUST-EXCLUDE the background sweep does not read that target
//   MUST-PASS    two targets on one host are read with the polite gap between them, and a target on
//                another host is read in that gap (interleaved), with no wait of its own
//   MUST-PASS    the gap never goes below the 10 s floor, whatever the env says
//   MUST-PASS    the click answers per filing: read (with the outcome) / unreadable (with why)
//   MUST-EXCLUDE a click never reads another org's filing (rule 6); a superadmin's (null) does
//   MUST-EXCLUDE a target another check is reading is not read again: the sweep leaves it alone
//                and a second click reports it skipped
//
// Run: npx tsx backend/test/permitCheckNow.test.ts
import "./_isolate"; // FIRST — generated files land in a temp cwd, never the repo's backend/data
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("permit-check-now");
const { db, repo } = fx;
// The live install's mode: an empty read is "unreadable", not a fabricated mock status.
process.env.PORTAL_AUTOSEED = "1";

const ISSUED = "Record BLD-2026-00001 Status: Permit Issued. Inspections may now be scheduled for this record.";
const reads: string[] = [];
let blocker: Promise<void> | null = null;
repo.setStatusCheckSeamsForTests({
  checkStatus: (async () => null) as never,
  recordSearch: (async () => ({ found: false, module: "Building", reason: "stub" })) as never,
  signedInLink: (async () => ({ text: null, reason: "stub", signedIn: false, loginRefused: false })) as never,
  publicCheck: (async (url: string) => {
    reads.push(url);
    if (blocker) await blocker;
    if (url.includes("empty")) return null;
    return ISSUED;
  }) as never,
});

const WEEK_AHEAD = new Date(Date.now() + 6 * 86_400_000).toISOString();
const permitTarget = (projectId: string, portalUrl: string, applicationNumber: string): string => {
  repo.createPermitCheckTarget(db, projectId, { targetType: "permit", permitType: "building", portalUrl, applicationNumber, jurisdiction: "Test City", portalName: "Test portal" });
  const id = db.get<{ id: string }>("SELECT id FROM permit_check_targets WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", [projectId])!.id;
  // Checked yesterday, next due in six days: exactly the live case the button skipped.
  db.run("UPDATE permit_check_targets SET last_checked_at = ?, next_check_at = ? WHERE id = ?", [new Date(Date.now() - 86_400_000).toISOString(), WEEK_AHEAD, id]);
  return id;
};
/** Only these targets are active. */
const only = (...ids: string[]) => {
  db.run("UPDATE permit_check_targets SET active = 0");
  for (const id of ids) db.run("UPDATE permit_check_targets SET active = 1, next_check_at = ? WHERE id = ?", [WEEK_AHEAD, id]);
  reads.length = 0;
};
const noSleep = async () => {};

const A1 = permitTarget(fx.newProject({ ahj: "Alpha City" }), "https://permits.alpha.example/record/1", "BLD-1001");
const A2 = permitTarget(fx.newProject({ ahj: "Alpha City" }), "https://permits.alpha.example/record/2", "BLD-1002");
const B1 = permitTarget(fx.newProject({ ahj: "Beta County" }), "https://permits.beta.example/record/1", "BLD-2001");
const E1 = permitTarget(fx.newProject({ ahj: "Gamma Town" }), "https://permits.gamma.example/empty/1", "BLD-3001");

await check("(c1) MUST-PASS a click reads a target that is not due for six days, and records the reading", async () => {
  only(A1);
  const res = await repo.runPermitChecksNow(db, "permit", null, { sleep: noSleep });
  assert.deepEqual(reads, ["https://permits.alpha.example/record/1"]);
  assert.equal(res.checked, 1);
  const row = db.get<{ latest_outcome: string; next_check_at: string }>("SELECT latest_outcome, next_check_at FROM permit_check_targets WHERE id = ?", [A1])!;
  assert.equal(row.latest_outcome, "issued");
});

await check("(c2) MUST-EXCLUDE the background sweep stays due-only: a target due in six days is not read", async () => {
  only(A1);
  const res = await repo.runDuePermitChecks(db, "permit");
  assert.deepEqual(reads, []);
  assert.equal(res.checked, 0);
});

await check("(c3) MUST-PASS same-host reads keep the gap; another host is read inside it, without waiting", async () => {
  only(A1, A2, B1);
  const sleeps: Array<{ ms: number; before: string }> = [];
  const res = await repo.runPermitChecksNow(db, "permit", null, {
    gapMs: 10_000,
    sleep: async (ms: number) => { sleeps.push({ ms, before: reads[reads.length - 1] ?? "" }); },
  });
  assert.equal(res.checked, 3);
  const hosts = reads.map((u) => new URL(u).hostname);
  assert.deepEqual(hosts, ["permits.alpha.example", "permits.beta.example", "permits.alpha.example"], `not interleaved: ${hosts.join(", ")}`);
  assert.equal(sleeps.length, 1, `expected exactly one wait (before the second alpha read): ${JSON.stringify(sleeps)}`);
  assert.ok(sleeps[0].ms > 8_000 && sleeps[0].ms <= 10_000, `the wait was ${sleeps[0].ms} ms, not the gap`);
  assert.equal(sleeps[0].before, "https://permits.beta.example/record/1", "the wait came before the beta read, not the second alpha one");
});

await check("(c4) MUST-PASS the host gap has a 10 s floor an env cannot lower", async () => {
  const saved = process.env.PERMIT_CHECK_HOST_GAP_MS;
  process.env.PERMIT_CHECK_HOST_GAP_MS = "50";
  assert.equal(repo.permitCheckHostGapMs(), 10_000);
  process.env.PERMIT_CHECK_HOST_GAP_MS = "30000";
  assert.equal(repo.permitCheckHostGapMs(), 30_000);
  delete process.env.PERMIT_CHECK_HOST_GAP_MS;
  assert.equal(repo.permitCheckHostGapMs(), 10_000);
  if (saved !== undefined) process.env.PERMIT_CHECK_HOST_GAP_MS = saved;
});

await check("(c5) MUST-PASS the click answers per filing: read with its outcome, unreadable with why", async () => {
  only(A1, E1);
  const res = await repo.runPermitChecksNow(db, "permit", null, { sleep: noSleep });
  assert.equal(res.read, 1);
  assert.equal(res.unreadable, 1);
  assert.equal(res.skipped, 0);
  const a = res.results.find((r) => r.targetId === A1)!;
  assert.equal(a.result, "read");
  assert.equal(a.outcome, "issued");
  assert.equal(a.label, "Building permit");
  assert.match(a.projectName, /Replay Owner/);
  const e = res.results.find((r) => r.targetId === E1)!;
  assert.equal(e.result, "unreadable");
  assert.ok(e.reason && e.reason.length > 0, "an unreadable filing must say why");
});

await check("(c6) MUST-EXCLUDE a click reads only the caller's org's filings; a superadmin (null) reads all", async () => {
  db.run("INSERT OR IGNORE INTO orgs (id, name, created_at) VALUES ('org-other', 'Other Solar', ?)", [new Date().toISOString()]);
  const otherProject = db.get<{ project_id: string }>("SELECT project_id FROM permit_check_targets WHERE id = ?", [B1])!.project_id;
  db.run("UPDATE projects SET org_id = 'org-other' WHERE id = ?", [otherProject]);
  only(A1, B1);
  const mine = await repo.runPermitChecksNow(db, "permit", "org-default", { sleep: noSleep });
  assert.deepEqual(reads, ["https://permits.alpha.example/record/1"], `another org's filing was read: ${JSON.stringify(reads)}`);
  assert.deepEqual(mine.results.map((r) => r.targetId), [A1], "another org's filing appeared in the answer");
  only(A1, B1);
  await repo.runPermitChecksNow(db, "permit", null, { sleep: noSleep });
  assert.equal(reads.length, 2);
  db.run("UPDATE projects SET org_id = 'org-default' WHERE id = ?", [otherProject]);
});

await check("(c7) MUST-EXCLUDE a filing another check is reading is never read twice at once", async () => {
  only(A1);
  let release!: () => void;
  blocker = new Promise<void>((r) => { release = r; });
  const first = repo.runPermitChecksNow(db, "permit", null, { sleep: noSleep });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reads.length, 1, "the first click did not start its read");
  // The sweep, with the target made due, leaves it to the click in progress.
  db.run("UPDATE permit_check_targets SET next_check_at = ? WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), A1]);
  const sweep = await repo.runDuePermitChecks(db, "permit");
  assert.equal(sweep.checked, 0, "the sweep read a filing the click had in hand");
  // A second click says so.
  const second = await repo.runPermitChecksNow(db, "permit", null, { sleep: noSleep });
  assert.equal(second.checked, 0);
  assert.equal(second.skipped, 1);
  assert.match(second.results[0].reason ?? "", /another check is reading this filing/);
  blocker = null;
  release();
  const done = await first;
  assert.equal(done.read, 1);
  assert.equal(reads.length, 1, "the filing was read more than once");
});

repo.setStatusCheckSeamsForTests(null);
finish("permitCheckNow");
