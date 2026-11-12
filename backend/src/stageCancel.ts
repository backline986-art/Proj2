// #340 — STOPPING A RUNNING STAGE.
//
// A recipe replay that is running in THIS process registers an AbortController under its run id
// (prepareSubmission, the replay branch); POST /api/portal-runs/:id/cancel aborts it with { by, at }.
// The replay stops at its next step boundary, closes its browser, and prepareSubmission records the
// run 'cancelled' (derivePortalRunOutcome) — never 'submitted', and nothing is clicked to clean up
// (hard rule 1). The job that ran the stage finishes as usual.
//
// What is NOT cancellable this way, each refused by name:
//   - a run already at review (awaiting_human_submit / awaiting_human_resubmit): that window
//     belongs to the person who verifies and submits;
//   - any run that is not 'running' (finished, failed, paused, submitted, interrupted);
//   - a 'running' row this process is not driving with a replay (another process, or a hand-coded
//     adapter / learn that has no step boundary to stop at). A row whose process is gone is
//     recovered as 'interrupted' by recoverInterruptedPortalRuns, not here.
//
// Scope (rule 6): the route is a child of /api/portal-runs/:id, so the child scope guard already
// 404s another tenant's run before this runs.

import type { AppDb } from "./db";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";
import { nowIso } from "./time";

const liveStages = new Map<string, AbortController>();

/** Register a replay this process is about to drive; its signal goes to the adapter. */
export function openStageCancel(runId: string): AbortSignal {
  const ctrl = new AbortController();
  liveStages.set(runId, ctrl);
  return ctrl.signal;
}

/** The run has ended (whatever the outcome): it can no longer be cancelled. */
export function closeStageCancel(runId: string): void {
  liveStages.delete(runId);
}

/** Test seam: is a cancellable replay registered for this run? */
export function stageCancelOpen(runId: string): boolean {
  return liveStages.has(runId);
}

const AT_REVIEW = new Set(["awaiting_human_submit", "awaiting_human_resubmit"]);

/** A person asks to stop a running stage. Records who and when (audit), aborts the replay, and
 *  answers at once; the run's own row is finished as 'cancelled' when the replay has stopped. */
export function cancelPortalRun(
  db: AppDb,
  runId: string,
  actor: string,
): { ok: true; runId: string; status: "cancelling"; message: string } {
  const row = db.get<{ id: string; project_id: string; status: string; permit_type: string; run_type: string }>(
    "SELECT id, project_id, status, permit_type, run_type FROM portal_runs WHERE id = ?",
    [runId],
  );
  if (!row) throw new HttpError(404, "Portal run not found.");
  const by = String(actor || "").trim().slice(0, 120) || "operator";
  const status = String(row.status);
  if (AT_REVIEW.has(status)) {
    throw new HttpError(409, "This run is already at the portal's review screen — that window is yours to verify and submit (or close). Cancel stops a run that is still filling the application.", { status });
  }
  if (status !== "running") {
    throw new HttpError(409, `This run is not running (it is ${status.replace(/_/g, " ")}), so there is nothing to stop.`, { status });
  }
  const ctrl = liveStages.get(runId);
  if (!ctrl) {
    throw new HttpError(409, "This run can't be stopped from here: only a recipe replay that this server is driving stops on request. If its process went away it is recovered as interrupted the next time the track is staged.", { status });
  }
  const at = nowIso();
  if (!ctrl.signal.aborted) {
    ctrl.abort({ by, at });
    addAuditLog(db, String(row.project_id), "human", by, "portal.run_cancel_requested", {
      runId, track: String(row.permit_type || "permit"), requestedAt: at,
    });
  }
  return {
    ok: true,
    runId,
    status: "cancelling",
    message: "Stopping the run at its next step. Nothing further will be filled or clicked, and nothing is submitted; the browser closes and the run is recorded as cancelled.",
  };
}
