// ---------------------------------------------------------------------------
// A REPLAY LEARNS FROM THE PERSON WHO FINISHED IT BY HAND (owner 2026-11-21: "the fix screen was
// hit, I approved it, then it was still getting stuck on the same run"; "lets also focus on getting
// the manual learning going and adapted").
//
// Until now a replay step that failed closed its window, and nothing the person then did by hand
// ever reached the recipe, so the next stage stuck on the same step. portal-bot now keeps a headed
// guided replay's window open at the failed step and reports the person's own fills and clicks
// (read only: RecipeAdapter.armFixCaptureAfterFailure). This module holds them per run and, only
// when a named person presses "Save my fixes", writes them into the recipe AT THE STEP THAT FAILED.
//
// What is held is already safe to store: prepared exactly like the learner's review patch
// (prepareHumanPatchSteps: no submit/pay click, no secret value, literals bound to the job's
// fields), and any typed value equal to one of the job's secrets is bound by name and its literal
// removed before the row is written. Nothing here clicks, files or sends anything.
//
// The save is refused when the recipe changed since the run read it (version or steps signature),
// so a fix is never spliced into steps it was not demonstrated against.
// ---------------------------------------------------------------------------

import type { RecipeStep } from "../../shared/src/types";
import type { AppDb } from "./db";
import { addAuditLog } from "./audit";
import { HttpError } from "./httpError";
import { nowIso } from "./time";
import {
  clearPortalRecipeFlag,
  getPortalRecipe,
  prepareHumanPatchSteps,
  recipeStepsSignature,
  savePortalRecipeSteps,
  terminalTailStart,
  upsertRecipeNote,
} from "./portalRecipes";
import { isPlannerSecretKey } from "./projectSecrets";
import { stampPermitPathSteps } from "../../shared/src/permitPathSteps";
import { UPLOAD_LABEL_PATTERNS } from "../../portal-bot/src/adapters/autoLearnAdapter";

/** A run never holds more hand steps than this (a person walking the rest of a long form by hand
 *  stays well under it; anything past it is dropped, not stored). */
export const MAX_FIX_STEPS = 200;
/** anchor_index for "after the last step, before the review stop" (the run stopped short of review). */
export const AT_END = -2;

/** "insert": the fixes go in at the failed step, and replace it when the person redid that same
 *  control; the recipe's later steps stay. "replace_rest": the person finished the application by
 *  hand to its review page, so the fixes replace everything from the failed step to the review stop. */
export type FixSaveMode = "insert" | "replace_rest";

const digits = (v: unknown): string => String(v ?? "").replace(/\D/g, "");

/** The job's field values with every secret key and secret value left out (the binder's index). */
export function secretFreeFields(fieldValues: Record<string, string>, secretValues: string[]): Record<string, string> {
  const secrets = new Set(secretValues.map((v) => String(v).trim()).filter((v) => v.length >= 4));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fieldValues)) {
    if (isPlannerSecretKey(k)) continue;
    const s = String(v ?? "").trim();
    if (secrets.has(s)) continue;
    out[k] = String(v ?? "");
  }
  return out;
}

/**
 * ONE CAPTURED STEP, MADE SAFE TO STORE. A value that is one of the job's secrets (account / meter
 * number, separators ignored) is bound by name where it is the canonical account or meter number and
 * its literal is ALWAYS removed — whether or not the page flagged the box sensitive. Then the shared
 * preparation (prepareHumanPatchSteps). Returns [] for a step that must not be kept.
 */
export function prepareFixStep(
  db: AppDb,
  step: RecipeStep,
  ctx: { fields: Record<string, string>; secretValues: string[]; accountNumber?: string; meterNumber?: string; clientId?: string | null; permitPath?: string | null },
): RecipeStep[] {
  if (!step || typeof step !== "object") return [];
  let st: RecipeStep = { ...step };
  // AN UPLOAD NAMES ITS DOCUMENT from the slot's own label, with the learner's table (as a hand
  // recording does, recordRecipe.guessUploadDocType). One it cannot name stays "" and the save says so.
  if (st.action === "upload" && !st.docType) {
    const label = `${st.selector?.label ?? ""} ${st.selector?.name ?? ""} ${String(st.note ?? "").replace(/—\s*UPLOAD, set docType in the dashboard\s*$/i, "")}`.trim();
    const docType = UPLOAD_LABEL_PATTERNS.find(({ re }) => re.test(label))?.docType ?? "";
    if (docType) st = { ...st, docType };
  }
  const raw = String(st.value ?? "").trim();
  const rawDigits = digits(raw);
  const isSecret = raw !== "" && (st.sensitive === true || ctx.secretValues.some((s) => {
    const t = String(s).trim();
    return t === raw || (digits(t).length >= 4 && digits(t) === rawDigits);
  }));
  if (isSecret) {
    const field = ctx.accountNumber && digits(ctx.accountNumber).length >= 4 && digits(ctx.accountNumber) === rawDigits ? "accountNumber"
      : ctx.meterNumber && digits(ctx.meterNumber).length >= 4 && digits(ctx.meterNumber) === rawDigits ? "meterNumber"
      : st.field;
    st = { ...st, sensitive: true, ...(field ? { field } : {}) };
    delete st.value;
  }
  // A choice that names a permit path is the answer for THIS job's path only (permitPathSteps.ts).
  const out = stampPermitPathSteps(prepareHumanPatchSteps(db, [st], ctx.fields, ctx.clientId), ctx.permitPath);
  // Belt and braces: nothing that still equals a secret is ever stored.
  return out.filter((o) => {
    const v = String(o.value ?? "").trim();
    if (!v) return true;
    return !ctx.secretValues.some((s) => String(s).trim() === v || (digits(s).length >= 4 && digits(s) === digits(v)));
  }).map((o) => ({ ...o, note: String(o.note || "").startsWith("hand-fix") ? o.note : `hand-fix${o.note ? `: ${String(o.note).slice(0, 160)}` : ""}` }));
}

/**
 * THE RUN'S CAPTURE: the staging code opens one per own-recipe replay and passes `onStep` to
 * portal-bot. Steps that arrive before the run says where it stopped are held in memory; `anchor`
 * writes the row (the failed step, mapped to the stored recipe) and flushes them. A run that never
 * left its window open for a fix never calls `anchor`, and nothing is written.
 */
export function openRunFixCapture(
  db: AppDb,
  opts: {
    runId: string; projectId: string; recipeId: string; recipeVersion: number; stepsSignature: string;
    /** replayBinding.originalIndex: executed step index → stored recipe index. */
    originalIndex: number[];
    fields: Record<string, string>; secretValues: string[]; accountNumber?: string; meterNumber?: string; clientId?: string | null;
    /** This job's resolved permit path on a permit track (null on NEM). */
    permitPath?: string | null;
  },
): { onStep: (step: RecipeStep) => void; anchor: (executedIndex: number | null, atEnd?: boolean) => void } {
  const pending: RecipeStep[] = [];
  let anchored = false;
  let stored = 0;
  const append = (steps: RecipeStep[]): void => {
    if (!steps.length) return;
    const row = db.get<{ steps_json: string; applied_at: string | null }>("SELECT steps_json, applied_at FROM portal_run_fix_steps WHERE run_id = ?", [opts.runId]);
    if (!row || row.applied_at) return;
    let have: RecipeStep[] = [];
    try { have = JSON.parse(row.steps_json || "[]"); } catch { have = []; }
    const room = MAX_FIX_STEPS - have.length;
    if (room <= 0) return;
    const next = [...have, ...steps.slice(0, room)];
    stored = next.length;
    db.run("UPDATE portal_run_fix_steps SET steps_json = ? WHERE run_id = ?", [JSON.stringify(next), opts.runId]);
  };
  const ctx = { fields: opts.fields, secretValues: opts.secretValues, accountNumber: opts.accountNumber, meterNumber: opts.meterNumber, clientId: opts.clientId, permitPath: opts.permitPath };
  const runPath = opts.permitPath === "prescriptive" || opts.permitPath === "engineered" ? opts.permitPath : "";
  return {
    onStep: (step) => {
      try {
        const ready = prepareFixStep(db, step, ctx);
        if (!ready.length) return;
        if (!anchored) { if (pending.length < MAX_FIX_STEPS) pending.push(...ready); return; }
        if (stored >= MAX_FIX_STEPS) return;
        append(ready);
        if (stored === ready.length) {
          addAuditLog(db, opts.projectId, "human", "operator", "portal.run_hand_fix_started", { runId: opts.runId, recipeId: opts.recipeId });
        }
      } catch { /* capture is a convenience; it must never disturb the person's window */ }
    },
    anchor: (executedIndex, atEnd = false) => {
      if (anchored) return;
      anchored = true;
      try {
        const stored0 = typeof executedIndex === "number" && executedIndex >= 0 ? opts.originalIndex[executedIndex] : undefined;
        // "At the end": every step ran and the run stopped short of review, so the person's steps
        // follow the last one, before the terminal tail (READ from the recipe at save, never guessed).
        const anchorIndex = typeof stored0 === "number" && stored0 >= 0 ? stored0 : atEnd ? AT_END : -1;
        db.run(
          `INSERT OR IGNORE INTO portal_run_fix_steps (run_id, project_id, recipe_id, recipe_version, steps_signature, anchor_index, steps_json, captured_at, permit_path)
           VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
          [opts.runId, opts.projectId, opts.recipeId, opts.recipeVersion, opts.stepsSignature, anchorIndex, nowIso(), runPath],
        );
        append(pending.splice(0));
      } catch { /* a capture that cannot be written leaves the run exactly as it was */ }
    },
  };
}

export interface RunFixSummary {
  runId: string;
  recipeId: string;
  count: number;
  /** The failed step, 1-based, in the stored recipe (0 = unknown or at the end). */
  stuckStep: number;
  /** The run ran every step and stopped short of review: the fixes go after the last step. */
  atEnd: boolean;
  appliedAt: string | null;
  appliedBy: string;
  appliedMode: string;
  /** Each held step in a few words (action + label), for the person deciding to save them. */
  preview: string[];
}

function parseSteps(raw: unknown): RecipeStep[] {
  try { const v = JSON.parse(String(raw ?? "[]")); return Array.isArray(v) ? v : []; } catch { return []; }
}

function describeStep(st: RecipeStep): string {
  const label = String(st.selector?.label || st.selector?.name || st.selector?.text || st.note || "").replace(/^hand-fix:?\s*/i, "").trim();
  const what = st.field ? `your job's ${st.field}` : st.value != null && st.value !== "" ? `"${String(st.value).slice(0, 40)}"` : "";
  return `${st.action}${label ? ` "${label.slice(0, 60)}"` : ""}${what && (st.action === "fill" || st.action === "select") ? ` = ${what}` : ""}`;
}

/** The project's runs that hold hand fixes, by run id (the run card reads them). */
export function runFixSummaries(db: AppDb, projectId: string): Map<string, RunFixSummary> {
  const out = new Map<string, RunFixSummary>();
  const rows = db.query<Record<string, unknown>>("SELECT * FROM portal_run_fix_steps WHERE project_id = ?", [projectId]);
  for (const r of rows) {
    const steps = parseSteps(r.steps_json);
    out.set(String(r.run_id), {
      runId: String(r.run_id), recipeId: String(r.recipe_id), count: steps.length,
      stuckStep: Number(r.anchor_index) >= 0 ? Number(r.anchor_index) + 1 : 0,
      atEnd: Number(r.anchor_index) === AT_END,
      appliedAt: r.applied_at ? String(r.applied_at) : null, appliedBy: String(r.applied_by ?? ""), appliedMode: String(r.applied_mode ?? ""),
      preview: steps.slice(0, 12).map(describeStep),
    });
  }
  return out;
}

/** Same control? Compared on the selector's identity (css, test id, else label / accessible name with
 *  the same action), never on value. */
function sameControl(a: RecipeStep | undefined, b: RecipeStep | undefined): boolean {
  if (!a || !b) return false;
  const sa = a.selector ?? {}, sb = b.selector ?? {};
  const eq = (x: unknown, y: unknown) => String(x ?? "").trim() !== "" && String(x ?? "").trim().toLowerCase() === String(y ?? "").trim().toLowerCase();
  if (eq(sa.css, sb.css) || eq(sa.testId, sb.testId)) return true;
  return a.action === b.action && (eq(sa.label, sb.label) || (eq(sa.name, sb.name) && String(sa.role ?? "") === String(sb.role ?? "")));
}

/**
 * "SAVE MY FIXES": a named person writes a run's held hand steps into the recipe at the step that
 * failed. 409 when there is nothing to save, it was already saved, the stuck step is unknown, or the
 * recipe changed since the run read it. Audited with who saved it; the recipe's keep-and-flag flag
 * (raised by that same failure) is cleared through its own audited door.
 */
export function applyRunFixSteps(
  db: AppDb,
  runId: string,
  opts: { appliedBy: string; mode?: FixSaveMode },
): { recipeId: string; saved: number; mode: FixSaveMode; replaced: number; message: string } {
  const appliedBy = String(opts.appliedBy ?? "").trim();
  if (!appliedBy) throw new HttpError(400, "Say who is saving these fixes (a named person decides what goes into a recipe).");
  const row = db.get<Record<string, unknown>>("SELECT * FROM portal_run_fix_steps WHERE run_id = ?", [runId]);
  if (!row) throw new HttpError(404, "This run holds no hand fixes.");
  if (row.applied_at) throw new HttpError(409, `These fixes were already saved into the recipe (${String(row.applied_at).slice(0, 16)} by ${String(row.applied_by)}).`, { alreadyApplied: true });
  const fixes = parseSteps(row.steps_json);
  if (!fixes.length) throw new HttpError(409, "Nothing you did in the window was kept as a step yet (only fills, picks, uploads and clicks other than submit or pay are kept).", { noSteps: true });
  let anchor = Number(row.anchor_index);
  const recipe = getPortalRecipe(db, String(row.recipe_id));
  if (Number(recipe.version ?? 0) !== Number(row.recipe_version) || recipeStepsSignature(recipe.steps ?? []) !== String(row.steps_signature)) {
    throw new HttpError(409, "The recipe changed since this run replayed it, so these fixes no longer line up with its steps. Nothing was changed. Stage again and fix the page in the window that stays open.", { recipeChanged: true, recipeId: recipe.id });
  }
  const steps = [...(recipe.steps ?? [])];
  const cut = terminalTailStart(steps);
  if (anchor === AT_END) anchor = cut;
  if (!(anchor >= 0 && anchor <= cut)) {
    throw new HttpError(409, "The run did not say which step got stuck, so there is no safe place to put these fixes. Nothing was changed.", { anchorUnknown: true });
  }
  const mode: FixSaveMode = opts.mode === "replace_rest" ? "replace_rest" : "insert";
  let merged: RecipeStep[];
  let replaced: number;
  // A step recorded for the OTHER permit path is that path's answer: never replaced by this run's
  // fixes (which were shown on a job of this run's path), and kept in place when the rest is replaced.
  const runPath = String(row.permit_path ?? "");
  const otherPath = (st: RecipeStep | undefined) => Boolean(st?.whenPermitPath) && st!.whenPermitPath !== runPath;
  if (mode === "replace_rest") {
    const keptOther = steps.slice(anchor, cut).filter(otherPath);
    replaced = cut - anchor - keptOther.length;
    merged = [...steps.slice(0, anchor), ...keptOther, ...fixes, ...steps.slice(cut)];
  } else {
    replaced = anchor < cut && !otherPath(steps[anchor]) && fixes.some((f) => sameControl(f, steps[anchor])) ? 1 : 0;
    merged = [...steps.slice(0, anchor), ...fixes, ...steps.slice(anchor + replaced)];
  }
  const now = nowIso();
  const untypedUploads = fixes.filter((f) => f.action === "upload" && !f.docType).length;
  // THE DEMOTION THIS SAME FAILURE CAUSED IS UNDONE BY ITS REMEDY. A replay failure the classifier
  // blamed on the recipe set it to needs_rerecord (demoteOnReplayFailure); the person has now shown
  // the step it could not do, on these exact steps. Only when the LATEST demotion of this recipe
  // names THIS run: any other demotion stays for a person to look at.
  let status = recipe.status;
  if (status === "needs_rerecord") {
    const last = db.get<{ details: string }>(
      "SELECT details FROM audit_logs WHERE action = 'portal_recipe.demoted' AND details LIKE ? ORDER BY created_at DESC LIMIT 1",
      [`%${recipe.id}%`],
    );
    let lastRun = "";
    try { lastRun = String(JSON.parse(last?.details || "{}").runId ?? ""); } catch { lastRun = ""; }
    if (lastRun === runId) status = "complete";
  }
  const notes = upsertRecipeNote(recipe.notes, "hand fixes", `[hand fixes ${now.slice(0, 10)} by ${appliedBy}: ${fixes.length} step(s) ${anchor === cut ? "after the last step" : `at step ${anchor + 1}`}${mode === "replace_rest" ? ", replacing the rest to review" : ""}]`);
  savePortalRecipeSteps(db, recipe.id, merged, { status, notes });
  db.run("UPDATE portal_run_fix_steps SET applied_at = ?, applied_by = ?, applied_mode = ? WHERE run_id = ?", [now, appliedBy.slice(0, 120), mode, runId]);
  addAuditLog(db, String(row.project_id), "human", appliedBy, "portal_recipe.hand_fixes_saved", {
    runId, recipeId: recipe.id, fromVersion: recipe.version, steps: fixes.length, stuckStep: anchor + 1, mode, replaced, fromStatus: recipe.status, status,
  });
  try { clearPortalRecipeFlag(db, recipe.id, { actor: appliedBy, note: `hand fixes from run ${runId} saved` }); } catch { /* the save stands */ }
  return {
    recipeId: recipe.id, saved: fixes.length, mode, replaced,
    message: `${untypedUploads ? `${untypedUploads} of your upload(s) did not say which document goes there: set its doc type under Portal recipes, steps, or the replay skips it. ` : ""}Saved ${fixes.length} step(s) into the recipe ${anchor === cut ? "after its last step, before the review stop" : `at step ${anchor + 1}`}${replaced ? ` (replacing ${replaced} step(s) there)` : ""}. The next stage replays them; it still stops at the review page.`,
  };
}
