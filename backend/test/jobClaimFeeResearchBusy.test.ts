// ONE AGENCY, ONE FEE-RESEARCH PASS AT A TIME — ENFORCED AT THE CLAIM (#130).
//
// ensureFeeSchedulesResearched enqueues one fee_research job per (track, agency, discipline), so
// a permit project at one AHJ queues a structural pass AND an electrical pass, back to back. The
// instant kick plus JOB_CONCURRENCY=4 on the live install started both in one drain (started_at
// 4 ms apart, measured), and the two passes — each with its own 10-document budget — hammered
// the same Cloudflare-walled host through one shared window queue. PROJECT_BUSY_SQL serialises
// portal-effect types per project; nothing serialised fee_research per agency.
//
// So the claim itself refuses a pending fee_research whose payload profileKey already has a
// RUNNING fee_research — keyed on the AGENCY (two projects at one AHJ collide too), not the
// project. The refused job stays PENDING and is claimed once the first pass ends. Drives
// claimNextJob directly, JOB_CONCURRENCY>1, modelled on jobClaimProjectBusy.test.ts.
// Browser-free. Run: tsx backend/test/jobClaimFeeResearchBusy.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "job-claim-fee-busy-"));
process.env.AUTOPILOT_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.PROJECT_DOCS_DIR = path.join(tmpDir, "docs");
process.env.SEED_TEST_INSTALLER = "false";
process.env.ANTHROPIC_API_KEY = "";
process.env.JOB_CONCURRENCY = "4";

const { openDatabase } = await import("../src/db");
const { claimNextJob } = await import("../src/jobQueue");
const db = await openDatabase();

let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); }
  catch (err) { failures++; console.error(`  FAIL - ${label}\n         ${err instanceof Error ? err.message : String(err)}`); }
};

type Row = Record<string, unknown>;
const now = Date.now();
let n = 0;
// Rows inserted directly (not through enqueueJob) ON PURPOSE: enqueueJob's instant kick would run
// a drain and the handlers, and this test is about the claim alone. The payload is the shape
// ensureFeeSchedulesResearched writes (state, ahj, track, discipline, profileKey, researchKey).
const BEND = "permit|OR|city-of-bend";
const SALEM = "permit|OR|city-of-salem";
const job = (id: string, projectId: string | null, status: string, payload: Record<string, unknown>, priority = 5): void => {
  db.run(
    `INSERT INTO job_queue (id, job_type, payload, status, priority, project_id, created_at, started_at,
       progress, progress_total, retry_count, max_retries, org_id)
     VALUES (?, 'fee_research', ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'default')`,
    [id, JSON.stringify(payload), status, priority, projectId, new Date(now + (n++) * 10).toISOString(), status === "running" ? new Date(now).toISOString() : null],
  );
};
const fee = (profileKey: string, discipline: string) => ({ state: "OR", ahj: profileKey.split("|")[2], track: "permit", discipline, profileKey, researchKey: `permit|${profileKey}|${discipline}` });
const statusOf = (id: string): string => String(db.get<Row>("SELECT status FROM job_queue WHERE id = ?", [id])?.status);
const claimAll = (): string[] => {
  const out: string[] = [];
  for (let i = 0; i < 10; i++) { const j = claimNextJob(db); if (!j) break; out.push(j.id); }
  return out;
};

// The live shape: one project, two disciplines for one AHJ, the structural pass already running.
job("bend-structural-running", "proj-A", "running", fee(BEND, "structural"));
// Higher priority than everything else on purpose: a waiting job must not hide lower ones.
job("bend-electrical-pending", "proj-A", "pending", fee(BEND, "electrical"), 9);
// A SECOND PROJECT at the same AHJ: the key is the agency, not the project.
job("bend-other-project-pending", "proj-B", "pending", fee(BEND, "structural"), 9);
// Another agency, and a pass with no profileKey at all (an older payload): both must still run.
job("salem-pending", "proj-C", "pending", fee(SALEM, "structural"), 5);
job("nokey-pending", "proj-D", "pending", { state: "OR", ahj: "Keyless Town", track: "permit", discipline: "structural" }, 3);

const firstWave = claimAll();
check("a pending fee_research is NOT claimed while another fee_research for the same agency is RUNNING", () => {
  for (const id of ["bend-electrical-pending", "bend-other-project-pending"]) {
    assert.equal(statusOf(id), "pending", `${id} was claimed (${statusOf(id)}) while Bend's structural pass runs`);
  }
});
check("...while another agency's pass and a pass with no profileKey still run", () => {
  assert.deepEqual([...firstWave].sort(), ["nokey-pending", "salem-pending"].sort(), JSON.stringify(firstWave));
});
check("...and the blocked high-priority jobs did not hide the lower-priority runnable ones", () => {
  assert.ok(firstWave.includes("salem-pending") && firstWave.includes("nokey-pending"));
});

// Back-to-back slots: Salem is RUNNING now (claimed a moment ago), so a second Salem pass waits.
job("salem-electrical-pending", "proj-C", "pending", fee(SALEM, "electrical"), 9);
check("a pass claimed a moment ago counts as running for the next claim (back-to-back slots)", () => {
  assert.equal(claimNextJob(db), null);
  assert.equal(statusOf("salem-electrical-pending"), "pending");
});

// The agency frees: exactly ONE of Bend's waiting passes is claimed, never two.
db.run("UPDATE job_queue SET status = 'done' WHERE id = 'bend-structural-running'");
const secondWave = claimAll();
check("once the agency frees, exactly one of its waiting passes is claimed", () => {
  const bend = secondWave.filter((id) => id.startsWith("bend-"));
  assert.equal(bend.length, 1, `claimed ${JSON.stringify(secondWave)}`);
  const stillPending = ["bend-electrical-pending", "bend-other-project-pending"].filter((id) => statusOf(id) === "pending");
  assert.equal(stillPending.length, 1);
});
check("...and the other one follows when that pass ends", () => {
  const running = secondWave.find((id) => id.startsWith("bend-"))!;
  db.run("UPDATE job_queue SET status = 'done' WHERE id = ?", [running]);
  const next = claimNextJob(db);
  assert.ok(next && next.id.startsWith("bend-"), `claimed ${next?.id}`);
});

// The rule is fee_research's own: a running fee_research does not hold up other job types for the
// project, and a running job of another type does not hold up fee_research.
db.run("UPDATE job_queue SET status = 'done' WHERE status = 'running'");
job("bend-again-running", "proj-A", "running", fee(BEND, "structural"));
db.run(
  `INSERT INTO job_queue (id, job_type, payload, status, priority, project_id, created_at, started_at, progress, progress_total, retry_count, max_retries, org_id)
   VALUES ('A-local-pending', 'code_research', '{}', 'pending', 9, 'proj-A', ?, NULL, 0, 0, 0, 0, 'default')`,
  [new Date(now + (n++) * 10).toISOString()],
);
check("a running fee_research does not block the project's other (non-portal) work", () => {
  // Salem's freed electrical pass is runnable too, so this reads the wave, not the first claim.
  const wave = claimAll();
  assert.ok(wave.includes("A-local-pending"), `claimed ${JSON.stringify(wave)}`);
  assert.equal(statusOf("A-local-pending"), "running");
});

// A LEGACY ROW MUST NOT HALT THE QUEUE. json_extract raises "malformed JSON" on a payload that is
// not JSON, and the predicate runs in EVERY claim (and its subquery over every running
// fee_research row), so one such row would make claimNextJob throw on every drain, for every
// tenant. Probed: bare json_extract throws; a json_valid guard does not.
db.run("UPDATE job_queue SET status = 'done' WHERE status IN ('running', 'pending')");
db.run(
  `INSERT INTO job_queue (id, job_type, payload, status, priority, project_id, created_at, started_at, progress, progress_total, retry_count, max_retries, org_id)
   VALUES ('legacy-text-pending', 'stress_noop', 'not json', 'pending', 5, NULL, ?, NULL, 0, 0, 0, 0, 'default'),
          ('legacy-empty-running', 'fee_research', '', 'running', 5, 'proj-E', ?, ?, 0, 0, 0, 0, 'default')`,
  [new Date(now + (n++) * 10).toISOString(), new Date(now + (n++) * 10).toISOString(), new Date(now).toISOString()],
);
job("bend-after-legacy-pending", "proj-A", "pending", fee(BEND, "electrical"), 3);
check("a payload that is not JSON (pending or running) never makes the claim throw, and claiming goes on", () => {
  const wave = claimAll();
  assert.ok(wave.includes("legacy-text-pending"), `claimed ${JSON.stringify(wave)}`);
  assert.ok(wave.includes("bend-after-legacy-pending"), `an empty running payload holds nothing: ${JSON.stringify(wave)}`);
});

if (failures) { console.error(`\n${failures} job-claim-fee-busy check(s) FAILED.`); process.exit(1); }
console.log("\nAll job-claim-fee-busy checks passed.");
process.exit(0);
