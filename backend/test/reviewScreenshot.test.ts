// #316 — A REPLAY THAT STOPS FOR A PERSON HAS A REVIEW SCREENSHOT THE DASHBOARD CAN SHOW.
//
// The NEM replay of 2026-10-13 stopped at awaiting_human_submit as designed, but
// GET /api/projects/:id/portal-runs/:runId/review-screenshot answered 404: the run row's
// screenshots_path was empty (only a run that ENDED took an outcome shot), and the track card asks by
// the RECIPE id, which only found the auto-learn recipe's own picture. portal-bot now pictures the page
// it stopped on, masked (RecipeAdapter captureReviewShot through maskedFullPageScreenshot — the DOM half
// is portal-bot/src/adapters/reviewShot.dom.smoke.ts) and reports it as the run's outcome shot. Pinned
// here on the REAL prepareSubmission (browser stubbed) and a real server:
//   (a) THE POINT: a replay that stopped at review → the row names its masked review picture, and the
//       route serves it (200, image/png, the bytes) by the run id.
//   (b) THE CARD: the track card's recipe id → this project's newest run of that recipe, by its masked
//       review picture (fails on main: main answered only from the recipe's notes).
//   (c) AN OLDER ROW (screenshots_path empty): the route serves the run folder's masked review picture
//       (fails on main: 404).
//   (d) MUST-EXCLUDE (rule 2): an older row whose folder holds only the replay's UNMASKED page shots →
//       404, never one of those.
//   (e) MUST-EXCLUDE: a newer run of the recipe with no review picture → the card shows no older run's
//       picture as the current one.
//   (f) rule 6: this project's run under ANOTHER project → 404; another project's card (same recipe)
//       never shows this project's picture.
//
// KILL TESTS (run by hand on this tree):
//   K1 reviewScreenshotFile: drop the folder fallback → (c) fails.
//   K2 …: serve the folder's newest file instead of REVIEW_SHOT_FILE → (d) fails.
//   K3 …: drop `project_id = ?` from the recipe lookup → (f2) fails.
//   K4 server.ts: drop the reviewScreenshotFile call → (a) passes only by the old code path, (b)/(c) fail.
//
// Run: npx tsx backend/test/reviewScreenshot.test.ts
import "./_isolate"; // FIRST
import { REPO } from "./_isolate";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setupStageFixture, check, finish } from "./_stageFixture";

process.env.SESSION_ENCRYPTION_KEY = "review-screenshot-test-key-not-a-secret";
const fx = await setupStageFixture("review-screenshot");
const { db, repo } = fx;
const rs = await import("../src/reviewScreenshot");
const tracks = await import("../src/submittalTracks");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const shotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review-shots-"));
let seq = 0;
/** A run folder as portal-bot writes it: unmasked page shots, and (when the mask was proven) the
 *  masked review picture zzz-review.png. */
const runFolder = (opts: { masked: boolean }): { dir: string; masked: string } => {
  const dir = path.join(shotRoot, `2026-11-09T21-00-0${++seq}-fernhollow-power`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "p001-Applicant.png"), Buffer.concat([PNG_MAGIC, Buffer.from("UNMASKED page shot 1")]));
  fs.writeFileSync(path.join(dir, "p002-Review.png"), Buffer.concat([PNG_MAGIC, Buffer.from("UNMASKED page shot 2")]));
  const masked = path.join(dir, rs.REVIEW_SHOT_FILE);
  if (opts.masked) fs.writeFileSync(masked, Buffer.concat([PNG_MAGIC, Buffer.from(`masked review ${seq}`)]));
  return { dir, masked: opts.masked ? masked : "" };
};
/** The adapter result of a replay that stopped at review (index.ts lifts evidenceDir/outcomeShotPath). */
const stoppedAtReview = (f: { dir: string; masked: string }) => ({
  portalName: "stub", ok: true, finalSubmitClicked: false, pauseReason: null,
  evidenceDir: f.dir, outcomeShotPath: f.masked,
  steps: [
    { ok: true, message: "Opened stub portal." },
    { ok: true, message: "Replayed 4 recorded step(s); stopped at review.", data: { finalSubmitClicked: false, pageShotDir: f.dir, outcomeShotPath: f.masked } },
  ],
});
const stageWith = async (projectId: string, result: unknown) => {
  fx.stubRunner(async () => result as never);
  await repo.prepareSubmission(db, projectId);
  return fx.latestRun(projectId)!;
};

const recipe = fx.completeRecipe();
const recipeId = String((recipe as { id?: unknown }).id);

// (a) this project's replay, stopped at review, its masked picture on the row.
const ownPid = fx.newProject();
const ownFolder = runFolder({ masked: true });
let ownRun: Record<string, unknown> = {};
await check("(a) a replay that stopped at review records its masked review picture on the run row", async () => {
  ownRun = await stageWith(ownPid, stoppedAtReview(ownFolder));
  assert.equal(ownRun.status, "awaiting_human_submit", `run status ${String(ownRun.status)}`);
  assert.equal(ownRun.screenshots_path, ownFolder.masked);
  assert.equal(ownRun.recipe_id, recipeId, "the run does not name the recipe it replayed");
  assert.equal(rs.reviewScreenshotFile(db, ownPid, String(ownRun.id)), ownFolder.masked);
});

// (b) the card: the track card's recipe id.
await check("(b) the card asks by recipe id → this project's newest run of it, by its masked review picture", () => {
  const cardIds = tracks.getSubmittalTracks(db, repo.getProjectDetail(db, ownPid).project).map((t) => (t as { recipeId?: string }).recipeId).filter(Boolean);
  assert.ok(cardIds.includes(recipeId), `no track card carries the replayed recipe (${cardIds.join(",")})`);
  assert.equal(rs.reviewScreenshotFile(db, ownPid, recipeId), ownFolder.masked);
});

// (c) + (d) older rows: the path on the row is empty.
const olderPid = fx.newProject();
const olderFolder = runFolder({ masked: true });
let olderRun: Record<string, unknown> = {};
const bareFolder = runFolder({ masked: false });
let bareRun: Record<string, unknown> = {};
await check("(c) an older row with no path → the run folder's masked review picture", async () => {
  olderRun = await stageWith(olderPid, stoppedAtReview(olderFolder));
  db.run("UPDATE portal_runs SET screenshots_path = '' WHERE id = ?", [String(olderRun.id)]);
  assert.equal(rs.reviewScreenshotFile(db, olderPid, String(olderRun.id)), olderFolder.masked);
});
const barePid = fx.newProject();
await check("(d) MUST-EXCLUDE: a folder of only unmasked page shots → nothing (rule 2)", async () => {
  bareRun = await stageWith(barePid, stoppedAtReview(bareFolder));
  assert.equal(String(bareRun.screenshots_path ?? ""), "");
  assert.equal(rs.reviewScreenshotFile(db, barePid, String(bareRun.id)), null);
  assert.equal(rs.reviewScreenshotFile(db, barePid, recipeId), null);
});

// (e) a newer run of the same recipe with no review picture.
const newerPid = fx.newProject();
await check("(e) MUST-EXCLUDE: a newer run without a review picture → no older run's picture on the card", async () => {
  await stageWith(newerPid, stoppedAtReview(runFolder({ masked: true })));
  assert.ok(rs.reviewScreenshotFile(db, newerPid, recipeId), "the first run's picture was not found");
  // A later run of the same recipe that ended on an UNMASKED outcome shot (the track is staged, so a
  // second stage is refused: the row is written as the backend writes a finished run).
  const later = runFolder({ masked: false });
  const outcome = path.join(later.dir, "zzz-outcome-REFUSED.png");
  fs.writeFileSync(outcome, Buffer.concat([PNG_MAGIC, Buffer.from("UNMASKED outcome shot")]));
  const first = fx.latestRun(newerPid)!;
  db.run(
    `INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, finished_at, error_message,
       human_action_required, screenshots_path, logs_path, result_json, pause_reason, permit_type, recipe_id, recipe_version, runner)
     VALUES (?, ?, NULL, 'prepare_submit', 'failed', ?, ?, '', 1, ?, '', ?, NULL, ?, ?, ?, '')`,
    [`later-${newerPid}`, newerPid, "2999-01-01T00:00:00.000Z", "2999-01-01T00:00:01.000Z", outcome,
      JSON.stringify({ evidenceDir: later.dir }), String(first.permit_type), recipeId, Number(first.recipe_version) || 1],
  );
  assert.equal(rs.reviewScreenshotFile(db, newerPid, recipeId), null);
  // …while the later run's own id still answers with its own (outcome) picture, as before #316.
  assert.equal(rs.reviewScreenshotFile(db, newerPid, `later-${newerPid}`), outcome);
});

await check("(f1) rule 6: another project's run under this project → null", () => {
  assert.equal(rs.reviewScreenshotFile(db, barePid, String(ownRun.id)), null);
});
await check("(f2) rule 6: another project's card for the same recipe never shows this project's picture", () => {
  const otherPid = fx.newProject();
  assert.equal(rs.reviewScreenshotFile(db, otherPid, recipeId), null);
});

const dbPath = String(process.env.AUTOPILOT_DB_PATH);
const PORT = 5480 + Math.floor(Math.random() * 15); // never 4173 / 4270
const BASE = `http://127.0.0.1:${PORT}`;
const env: Record<string, string | undefined> = {
  ...process.env, AUTOPILOT_DB_PATH: dbPath, PORT: String(PORT), AUTOPILOT_AUTO_START: "0", SEED_TEST_INSTALLER: "false",
  MONITOR_INTERVAL_MINUTES: "0", LOG_LEVEL: "warn", ANTHROPIC_API_KEY: "", CODE_RESEARCH: "off", BACKGROUND_WORKERS: "off",
  AUTH_ENABLED: "false", NO_PROXY: "*", no_proxy: "*", AUTOPILOT_TEST_SEAMS: "",
};
delete env.PORTAL_ALLOW_FINAL_SUBMIT;
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
const server = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "backend/src/server.ts")], {
  env: env as NodeJS.ProcessEnv, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => { serverLog += String(d); });
server.stderr?.on("data", (d) => { serverLog += String(d); });
try {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i === 89) throw new Error(`server never came up:\n${serverLog.slice(-2000)}`);
    await new Promise((res) => setTimeout(res, 1000));
  }
  const shotUrl = (pid: string, id: string) => `${BASE}/api/projects/${pid}/portal-runs/${id}/review-screenshot`;
  const png = async (url: string, want: string) => {
    const res = await fetch(url);
    assert.equal(res.status, 200, await res.clone().text().catch(() => ""));
    assert.match(String(res.headers.get("content-type")), /image\/png/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(want));
  };
  await check("(a) ROUTE: the run that stopped at review → 200 image/png, its masked picture", () => png(shotUrl(ownPid, String(ownRun.id)), ownFolder.masked));
  await check("(b) ROUTE: the card's recipe id → 200 image/png, this project's masked review picture", () => png(shotUrl(ownPid, recipeId), ownFolder.masked));
  await check("(c) ROUTE: an older row with no path → 200 image/png, the folder's masked review picture", () => png(shotUrl(olderPid, String(olderRun.id)), olderFolder.masked));
  await check("(d) ROUTE: MUST-EXCLUDE — only unmasked page shots → 404", async () => {
    assert.equal((await fetch(shotUrl(barePid, String(bareRun.id)))).status, 404);
  });
  await check("(f) ROUTE: rule 6 — this project's run under another project → 404", async () => {
    assert.equal((await fetch(shotUrl(barePid, String(ownRun.id)))).status, 404);
  });
} finally {
  server.kill("SIGTERM");
}

finish("review-screenshot");
