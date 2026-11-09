// #340 — A PERSON CAN STOP A RUNNING STAGE, AND IT IS RECORDED AS CANCELLED, NEVER AS A FILING.
//
// Live NEM stage 2026-10-14 (project 7ddfbe48): a PacifiCorp replay sat on the equipment page for
// 15+ minutes and nothing could stop it short of closing the bot's window or restarting the server.
//
// Every stage case drives the REAL prepareSubmission (browser stubbed via setRecipeStageRunnerForTests);
// the stub stands in for the replay and answers its AbortSignal the way RecipeAdapter does
// (portal-bot replayStopControl.test.ts pins the adapter side).
//
// KILL TESTS:
//   K1 drop `abortSignal: cancelSignal` from replayOptions in prepareSubmission → (a) fails (the stub
//      never sees a signal; the cancel has nothing to abort).
//   K2 drop the runCancelled branch in derivePortalRunOutcome → (a) fails (recorded 'failed').
//   K3 move the cancelled branch ABOVE the click check → (c) fails (a click hidden as 'cancelled').
//   K4 drop the AT_REVIEW refusal in cancelPortalRun → (b) fails.
//   K5 drop the 'cancelled' case in segmentAOutcomeFromRun → (d) fails (read as staged).
//
// Run: npx tsx backend/test/stageCancel.test.ts
import "./_isolate"; // FIRST
import assert from "node:assert/strict";
import { setupStageFixture, check, finish } from "./_stageFixture";

const fx = await setupStageFixture("stage-cancel");
const { db, repo } = fx;
const { cancelPortalRun, stageCancelOpen } = await import("../src/stageCancel");
const { segmentAOutcomeFromRun } = await import("../src/autopilot");

const refusal = (fn: () => unknown): { status: number; message: string } | null => {
  try { fn(); return null; } catch (err) { return { status: Number((err as { status?: number }).status ?? 0), message: String((err as Error).message) }; }
};
const waitFor = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const projectStatus = (projectId: string) => String(db.get<{ status: string }>("SELECT status FROM projects WHERE id = ?", [projectId])?.status);
const insertRun = (projectId: string, status: string): string => {
  const runId = `run-${status}-${Math.random().toString(36).slice(2, 8)}`;
  db.run(
    `INSERT INTO portal_runs (id, project_id, portal_profile_id, run_type, status, started_at, finished_at, error_message,
       human_action_required, screenshots_path, logs_path, result_json, permit_type)
     VALUES (?, ?, NULL, 'prepare_submit', ?, ?, NULL, '', 0, '', '', '{}', 'permit')`,
    [runId, projectId, status, new Date().toISOString()],
  );
  return runId;
};

await check("(a) cancel mid-run: the replay's signal is aborted with who/when, the run is 'cancelled' (never submitted), the job finishes, nothing retried", async () => {
  fx.completeRecipe();
  const projectId = fx.newProject();
  const before = projectStatus(projectId);
  let calls = 0;
  let sawSignal = false;
  fx.stubRunner(async (_recipe, _project, _values, _docs, _files, options) => {
    calls += 1;
    const signal = (options as { abortSignal?: AbortSignal | null }).abortSignal;
    sawSignal = Boolean(signal);
    if (!signal) return fx.failingStep("no abort signal reached the replay");
    // Stand-in for the step loop: run until a person stops it, then answer as RecipeAdapter does.
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const reason = signal.reason as { by: string; at: string };
    const message = `Staging cancelled by ${reason.by} at ${reason.at} — the run stopped before step 3. Nothing further was filled or clicked, and nothing was submitted.`;
    const runCancelled = { by: reason.by, at: reason.at, stepIndex: 2 };
    return {
      portalName: "stub", ok: false, finalSubmitClicked: false, pauseReason: null, runCancelled,
      // A bot-wall-looking failure would normally earn a headed retry; a cancelled run never does.
      steps: [{ ok: true, message: "Opened stub portal." }, { ok: false, message: `${message} (403 Forbidden)`, data: { runCancelled } }],
    };
  });
  const staging = repo.prepareSubmission(db, projectId);
  await waitFor(() => {
    const run = fx.latestRun(projectId);
    return Boolean(run && run.status === "running" && stageCancelOpen(String(run.id)));
  });
  const runId = String(fx.latestRun(projectId)!.id);
  const answer = cancelPortalRun(db, runId, "dana@keelix.test");
  assert.equal(answer.status, "cancelling");
  await staging; // the job's work returns: nothing holds the slot
  assert.equal(sawSignal, true, "prepareSubmission passed the replay no abort signal");
  assert.equal(calls, 1, "a cancelled run was retried in a second browser");
  const run = fx.latestRun(projectId)!;
  assert.equal(run.status, "cancelled", `a cancelled run was recorded ${run.status}`);
  assert.match(String(run.error_message), /cancelled by dana@keelix\.test/);
  assert.equal(stageCancelOpen(runId), false, "the finished run is still registered as cancellable");
  const subs = db.query<{ status: string; submitted_at: string | null }>("SELECT status, submitted_at FROM submissions WHERE project_id = ?", [projectId]);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].status, "cancelled", `the cancelled run's submission row reads ${subs[0].status}`);
  assert.equal(subs[0].submitted_at, null);
  assert.equal(projectStatus(projectId), before, "a cancelled run moved the project's status");
  const requested = fx.audits("portal.run_cancel_requested").filter((a) => a.project_id === projectId);
  assert.equal(requested.length, 1, "no audit row for the cancel request");
  assert.equal(requested[0].actor_name, "dana@keelix.test");
  assert.equal(JSON.parse(requested[0].details).runId, runId);
  assert.ok(fx.audits("portal.run_cancelled").some((a) => a.project_id === projectId), "no portal.run_cancelled audit row");
  assert.equal(fx.audits("portal.run_failed").filter((a) => a.project_id === projectId).length, 0);
  // A second cancel of the finished run is refused, by name.
  assert.equal(refusal(() => cancelPortalRun(db, runId, "dana@keelix.test"))?.status, 409);
  fx.stubRunner(null);
});

await check("(b) refused by name: a run at review (the person's window), a finished run, a running row no replay here drives, an unknown run", async () => {
  const projectId = fx.newProject();
  const atReview = refusal(() => cancelPortalRun(db, insertRun(projectId, "awaiting_human_submit"), "dana"));
  assert.equal(atReview?.status, 409);
  assert.match(String(atReview?.message), /review screen/);
  assert.equal(refusal(() => cancelPortalRun(db, insertRun(projectId, "awaiting_human_resubmit"), "dana"))?.status, 409);
  assert.equal(refusal(() => cancelPortalRun(db, insertRun(projectId, "failed"), "dana"))?.status, 409);
  const orphan = refusal(() => cancelPortalRun(db, insertRun(projectId, "running"), "dana"));
  assert.equal(orphan?.status, 409);
  assert.match(String(orphan?.message), /can't be stopped from here/);
  assert.equal(refusal(() => cancelPortalRun(db, "no-such-run", "dana"))?.status, 404);
  assert.equal(fx.audits("portal.run_cancel_requested").filter((a) => a.project_id === projectId).length, 0, "a refused cancel wrote a cancel-requested audit row");
});

await check("(c) a cancel never hides a click: click evidence wins over runCancelled (rule 1's record), and cancelled alone is 'cancelled'", () => {
  const cancelled = { by: "dana", at: "2026-11-09T00:00:00.000Z", stepIndex: 4 };
  const alone = repo.derivePortalRunOutcome({ ok: false, runCancelled: cancelled, steps: [{ ok: false, message: "Staging cancelled by dana", data: { runCancelled: cancelled } }] });
  assert.equal(alone.status, "cancelled");
  assert.equal(alone.submissionStatus, "cancelled");
  assert.equal(alone.finalSubmitClicked, false);
  const clicked = repo.derivePortalRunOutcome({ ok: false, runCancelled: cancelled, finalSubmitClicked: true, steps: [{ ok: false, message: "x", data: { finalSubmitClicked: true } }] });
  assert.equal(clicked.status, "submitted_unconfirmed", "a run that clicked the final submit was recorded as cancelled");
});

await check("(d) autopilot reads a cancelled stage as NOT staged (a blocker), never as a draft at review", () => {
  const b = segmentAOutcomeFromRun({ status: "cancelled", error_message: "Staging cancelled by dana at …" });
  assert.ok(b, "a cancelled run read as staged");
  assert.equal(b!.code, "stage_cancelled");
  assert.match(b!.detail, /cancelled by dana/);
});

finish("stageCancel");
