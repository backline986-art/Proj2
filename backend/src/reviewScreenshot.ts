// #316 — THE REVIEW SCREENSHOT OF A RUN THAT STOPPED FOR A PERSON.
//
// A replay that stops at review (or before it) hands the page to a person, who verifies and submits
// it. The dashboard shows that page next to the track: GET /api/projects/:id/portal-runs/:runId/
// review-screenshot. Before #316 a replay that stopped at review left portal_runs.screenshots_path
// empty (only a run that ENDED — submitted, refused, paused at a fee — took an outcome shot), so the
// route 404'd for exactly the filing a person was about to submit.
//
// portal-bot now takes that page's picture through maskedFullPageScreenshot (RecipeAdapter
// captureReviewShot — the one masking path, rule 2) and reports it as the run's outcome shot, so the
// row names it. This module is the route's answer:
//
//   1. THE RUN (id = portal_runs.id of THIS project): the file the row names; else, for a row whose
//      path is empty, the run's own folder's MASKED review picture (REVIEW_SHOT_FILE) — never the
//      folder's other shots, which are unmasked page photographs.
//   2. THE CARD (id = the track's recipe id — what the dashboard's track card passes): this project's
//      NEWEST run of that recipe, when its picture is the masked review shot. A newer run without one
//      answers nothing here, so an older run's picture is never shown as the current one.
//   3. Neither: null, and the route falls back to the auto-learn recipe's own picture as before.
//
// Rule 6: every read is keyed by the project in the URL (the route lives under /api/projects/:id, so
// the scope guard covers it); another project's run is a null, never its picture.
import fs from "node:fs";
import path from "node:path";
import type { AppDb } from "./db";
import { text as s } from "./json";

/** The masked review picture's name in a run's page-shot folder — portal-bot's REVIEW_SHOT_FILE
 *  (recipeAdapter.ts). Only this name is served out of a folder: every other shot there is unmasked. */
export const REVIEW_SHOT_FILE = "zzz-review.png";

type RunRow = { id?: unknown; project_id?: unknown; screenshots_path?: unknown; result_json?: unknown; logs_path?: unknown };

const isFile = (p: string): boolean => {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
};

/** The run's page-shot folder, as the run reported it (result_json.evidenceDir — portal-bot's
 *  pageShotDir), never a path from the request. */
function runShotDir(run: RunRow): string {
  try {
    const r = JSON.parse(s(run.result_json) || "{}") as Record<string, unknown>;
    return s(r.evidenceDir).trim() || s(r.pageShotDir).trim();
  } catch {
    return "";
  }
}

/** The run folder's masked review picture, or "". */
function maskedReviewShotOf(run: RunRow): string {
  const dir = runShotDir(run);
  if (!dir) return "";
  const file = path.join(dir, REVIEW_SHOT_FILE);
  return isFile(file) ? file : "";
}

/** What GET /api/projects/:id/portal-runs/:runId/review-screenshot serves from this project's runs, or
 *  null (the route then tries the auto-learn recipe's picture). Read only. */
export function reviewScreenshotFile(db: AppDb, projectId: string, id: string): string | null {
  const run = db.get<RunRow>(
    "SELECT id, project_id, screenshots_path, result_json FROM portal_runs WHERE id = ? AND project_id = ?",
    [id, projectId],
  );
  if (run) {
    const named = s(run.screenshots_path).trim();
    if (isFile(named)) return named;
    return maskedReviewShotOf(run) || null;
  }
  // The track card passes its recipe id: this project's newest run of that recipe, by its masked
  // review picture only (the row's path when it is that picture, else the folder's).
  const newest = db.get<RunRow>(
    `SELECT id, project_id, screenshots_path, result_json FROM portal_runs
      WHERE project_id = ? AND recipe_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    [projectId, id],
  );
  if (!newest) return null;
  const named = s(newest.screenshots_path).trim();
  if (path.basename(named) === REVIEW_SHOT_FILE && isFile(named)) return named;
  return maskedReviewShotOf(newest) || null;
}
