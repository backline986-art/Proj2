// scripts/replay-doctor.ts — the read-only report an operator pastes back when a replay stops.
// Pins: it runs on a real migrated database; it names the run, its failing step and the recipe that
// drove it, and whether staging would pick that recipe; it NEVER prints a step's value or a 6+ digit
// run (an account/meter number) or an e-mail address; and it writes nothing (the file is unchanged).
//
//   npx tsx backend/test/replayDoctor.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO } from "./_isolate";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "replay-doctor-"));
const dbFile = path.join(tmp, "doctor.sqlite");
process.env.AUTOPILOT_DB_PATH = dbFile;
const { openDatabase } = await import("../src/db");
const db = await openDatabase();
const now = "2026-11-20T00:46:10.000Z";
db.run("PRAGMA foreign_keys = OFF");
db.run("INSERT INTO projects (id, homeowner_name, state, ahj, utility, status, parser_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ["p-doc", "Doctor test", "OR", "Portland", "Portland General Electric", "awaiting_human_submit", "{}", now, now]);
const steps = [
  { action: "fill", selector: { label: "Meter number" }, field: "meterNumber", value: "1234567890", note: "Meter" },
  { action: "fill", selector: { label: "Contact email" }, value: "owner@example.com", note: "Email" },
  { action: "stopForReview" },
];
db.run(`INSERT INTO portal_recipes (id, scope_type, profile_key, state, utility, status, version, steps_json, created_by, created_at, updated_at, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ["r-hand", "utility", "or||portland general electric", "OR", "Portland General Electric", "complete", 2, JSON.stringify(steps), "Seamus (recorder)", now, now, "[verified by Seamus]"]);
const result = {
  ok: false,
  steps: [{ ok: true, message: "logged in" }, {
    ok: false,
    message: "Replay stalled: no new step completed for 8 minute(s) — stuck on step 3 \"stopForReview\". Account 9876543210 was typed.",
    data: { replayStalled: { stepIndex: 2, stalledMs: 480000 }, trace: [{ i: 0, action: "fill", note: "Meter", outcome: "filled", page: "Meter info" }] },
  }],
};
db.run(`INSERT INTO portal_runs (id, project_id, run_type, status, started_at, finished_at, error_message, result_json, permit_type, recipe_id, recipe_version, runner)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ["run-1", "p-doc", "stage", "failed", now, "2026-11-20T00:57:19.000Z", "stalled; contact owner@example.com", JSON.stringify(result), "nem", "r-hand", 2, "RecipeAdapter"]);
db.run("INSERT INTO job_queue (id, job_type, status, created_at, finished_at, error) VALUES (?,?,?,?,?,?)",
  ["j1", "auto_learn", "failed", now, now, "Learn failed: meter 5555-666-777 refused"]);
const before = fs.readFileSync(dbFile);

const out = execFileSync(process.execPath, ["--import", "tsx", path.join(REPO, "scripts", "replay-doctor.ts"), "--project", "p-doc"], {
  cwd: REPO, env: { ...process.env, AUTOPILOT_DB_PATH: dbFile }, encoding: "utf8",
});
let failures = 0;
const check = (label: string, fn: () => void): void => {
  try { fn(); console.log(`  ok   - ${label}`); } catch (e) { failures++; console.error(`  FAIL - ${label}\n         ${(e as Error).message}\n${out}`); }
};
check("names the run, its stall, the recipe and version, and the trace", () => {
  assert.match(out, /run run-1/);
  assert.match(out, /status failed/);
  assert.match(out, /recipe r-hand v2/);
  assert.match(out, /replayStalled/);
  assert.match(out, /#1 fill "Meter"/);
});
check("says whether staging would pick the recipe, and lists its steps by binding", () => {
  assert.match(out, /staging picks for this key\+discipline: THIS recipe/);
  assert.match(out, /fill +label "Meter number" ← meterNumber/);
  assert.match(out, /← \(recorded literal\)/);
});
check("groups failed jobs", () => assert.match(out, /auto_learn: 1/));
check("never prints a value, a 6+ digit run or an e-mail address", () => {
  for (const secret of ["1234567890", "9876543210", "owner@example.com", "5555-666-777", "5555666777"]) {
    assert.ok(!out.includes(secret), `printed ${secret}`);
  }
});
check("writes nothing", () => assert.ok(fs.readFileSync(dbFile).equals(before), "the database file changed"));

if (failures) { console.error(`\n${failures} replay-doctor check(s) FAILED.`); process.exit(1); }
console.log("\nAll replay-doctor checks passed.");
process.exit(0);
