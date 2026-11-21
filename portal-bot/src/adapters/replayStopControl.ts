// #340 — HOW A RUNNING REPLAY IS STOPPED: A PERSON'S CANCEL, OR NO PROGRESS FOR TOO LONG.
//
// Live NEM stage 2026-10-14: a PacifiCorp replay sat on the equipment page for 15+ minutes
// rewriting array row 1, and nothing could stop it short of closing the bot's window or
// restarting the server (which also killed every other open review window in the process).
//
// Two exits, both named, both ending the run as a run that FILED NOTHING MORE:
//   - CANCEL: the backend aborts the run's AbortSignal (POST /api/portal-runs/:id/cancel). The
//     replay stops at its next step boundary — no further fill or click — and its browser closes.
//     The signal's reason says who asked and when.
//   - STALL: no NEW step reached for N minutes (PORTAL_REPLAY_STALL_MINUTES, default 8). "New" is a
//     (step, array pass) the run has not reached before, so a loop that keeps re-running the same
//     step (the row-1 rewrite above) is a stall, not progress.
//
// Neither ever clicks anything to clean up (hard rule 1): the portal keeps exactly what was done
// before the stop, and the record says so.

/** Who stopped the run, and when — the AbortSignal's reason, as the backend sets it. */
export interface RunCancelRequest {
  by: string;
  at: string;
}

export const DEFAULT_REPLAY_STALL_MINUTES = 8;

/** THE REVIEW TAIL'S OWN BUDGET. Once the step loop is done there is no "next step" to reach, yet the
 *  run still has its read-only work at the review stop: the last page's re-assert and gap-fill, the
 *  staged draft's page-by-page walk (#436, a GET per step page with a polite gap), the masked
 *  picture, the hand-over and the review read-back. On a live PGE NEM stage (2026-11-20) that work
 *  outlasted the 8-minute step clock: a run that HAD staged the application to review was ended as
 *  "Replay stalled … stuck on stopForReview", its window closed, its recipe flagged, and the next
 *  stage did the same. The tail is still bounded (a hung read must not wedge the worker), by this
 *  budget: PORTAL_REPLAY_REVIEW_TAIL_MINUTES, default 30, never below the step clock. */
export const DEFAULT_REPLAY_REVIEW_TAIL_MINUTES = 30;

export function replayReviewTailMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PORTAL_REPLAY_REVIEW_TAIL_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? Math.max(1, raw) : DEFAULT_REPLAY_REVIEW_TAIL_MINUTES;
  return Math.round(minutes * 60_000);
}

/** The stall budget in ms: PORTAL_REPLAY_STALL_MINUTES, default 8. Never unbounded — an unset,
 *  zero, negative or unreadable value is the default, and anything under a minute is a minute. */
export function replayStallMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PORTAL_REPLAY_STALL_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? Math.max(1, raw) : DEFAULT_REPLAY_STALL_MINUTES;
  return Math.round(minutes * 60_000);
}

/** The cancel request on a signal, or null when nothing asked the run to stop. A reason that is
 *  not ours (a bare abort()) still stops the run; it just names nobody. */
export function cancelRequestOf(signal: AbortSignal | null | undefined): RunCancelRequest | null {
  if (!signal || !signal.aborted) return null;
  const r = signal.reason as Partial<RunCancelRequest> | undefined;
  const by = typeof r?.by === "string" && r.by.trim() ? r.by.trim().slice(0, 120) : "an operator";
  const at = typeof r?.at === "string" && r.at ? r.at : new Date().toISOString();
  return { by, at };
}

/**
 * HAS THE REPLAY MADE PROGRESS? The step loop calls note() each time it reaches a step; only a
 * (step, array pass) never reached before counts. stalledMs() is how long since the last new one
 * once that passes the budget (else null), and `current` names the step the run is stuck on.
 */
export class ReplayStallWatch {
  private readonly seen = new Set<string>();
  private lastProgressAt: number;
  private budgetMs: number;
  /** The step loop is done: the clock now measures the review tail (enterTail), not a step. */
  inTail = false;
  current: { stepIndex: number; pass: number; label: string } | null = null;

  constructor(readonly stallMs: number, private readonly now: () => number = Date.now) {
    this.lastProgressAt = now();
    this.budgetMs = stallMs;
  }

  /** The step loop has ended (review reached, or the recorded steps ran out). There is no next step
   *  to wait for, so the step clock stops; the tail gets its own, longer budget from now. A note()
   *  after this (none is expected) never shortens it again. */
  enterTail(tailMs: number): void {
    if (this.inTail) return;
    this.inTail = true;
    this.budgetMs = Math.max(this.stallMs, tailMs);
    this.lastProgressAt = this.now();
  }

  /** The loop reached `stepIndex` on array pass `pass`. True when that is new progress. */
  note(stepIndex: number, pass: number, label: string): boolean {
    if (this.inTail) return false;
    this.current = { stepIndex, pass, label: label.slice(0, 80) };
    const key = `${stepIndex}|${pass}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.lastProgressAt = this.now();
    return true;
  }

  /** ms since the last new step, once that is at least the budget; null while within it. */
  stalledMs(): number | null {
    const idle = this.now() - this.lastProgressAt;
    return idle >= this.budgetMs ? idle : null;
  }

  /** The operator's sentence for a stall: what it was stuck on, for how long, and what it did not do. */
  message(): string {
    if (this.inTail) {
      const tailMinutes = Math.max(1, Math.round(this.budgetMs / 60_000));
      return `Replay stalled after its last recorded step: the review checks (re-check of the last page, the staged draft's read, the review read-back) did not finish within ${tailMinutes} minute(s). The run was ended; nothing further was filled or clicked, and nothing was submitted. Check the portal: the application may be complete up to its review page.`;
    }
    const at = this.current;
    const minutes = Math.max(1, Math.round(this.stallMs / 60_000));
    const where = at
      ? `step ${at.stepIndex + 1}${at.pass > 1 ? ` (array ${at.pass})` : ""}${at.label ? ` "${at.label}"` : ""}`
      : "its first step";
    return `Replay stalled: no new step completed for ${minutes} minute(s) — stuck on ${where}. The run was ended; nothing further was filled or clicked, and nothing was submitted. Check the portal for the partly filled application before staging again.`;
  }
}

/** The operator's sentence for a cancelled run: stopped at the boundary BEFORE a step, or (the
 *  watchdog, a step that had not returned) DURING one. */
export function cancelledMessage(req: RunCancelRequest, stepIndex: number | null, inFlight = false): string {
  const where = stepIndex == null ? "before its first step" : `${inFlight ? "during" : "before"} step ${stepIndex + 1}`;
  return `Staging cancelled by ${req.by} at ${req.at} — the run stopped ${where}. Nothing further was filled or clicked, and nothing was submitted. The portal keeps whatever was entered before the stop; check it before staging again.`;
}
