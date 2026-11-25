// THE ATTACHMENT ROW'S SAVE, NEVER THE PAGE'S "SAVE AND RESUME LATER" (replay reliability, 2026-11-23).
//
// Accela's attachment widget commits an upload with an anchor whose id ends "…Edit_btnSave". The
// learner's Accela upload pass found it — and recorded the replay fallback — with the CSS
// a[id*='btnSave' i], which ALSO matches the action bar's draft save,
// <a id="…actionBarBottom_btnSave">Save and resume later</a>. On a page with no attachment Save in
// view (the offline bench's Accela replica, or an ACA build whose widget is not yet drawn) that
// fallback clicked "Save and resume later" — on a live portal that saves the application as a draft
// and leaves the wizard — and the replay then waited 45 s for an attachment list that was never
// coming. The bench measured exactly that on every Accela replay.
//
// One CSS for both doors, never the action bar and never a control that says "resume". Recipes
// already saved with the old fallback are tightened at replay (tightenAttachmentSaveStep).
import type { RecipeStep, RecipeSelector } from "../../shared/src/types";

/** The recorded fallback the learner used to write for the attachment Save. */
export const LOOSE_ATTACHMENT_SAVE_CSS = "a[id*='btnSave' i]";

/** The attachment row's Save anchor: id names btnSave, but not the page's action bar, and its text
 *  never says "resume" (Playwright's :has-text). */
export const ATTACHMENT_SAVE_CSS = "a[id*='btnSave' i]:not([id*='actionBar' i]):not(:has-text(\"resume\"))";

function tighten(sel: RecipeSelector | undefined): RecipeSelector | undefined {
  if (!sel) return sel;
  const css = sel.css === LOOSE_ATTACHMENT_SAVE_CSS ? ATTACHMENT_SAVE_CSS : sel.css;
  const fallbacks = sel.fallbacks?.map((f) => tighten(f) as RecipeSelector);
  return { ...sel, ...(css !== undefined ? { css } : {}), ...(fallbacks ? { fallbacks } : {}) };
}

/** A recorded "attachment: save" click with the loose fallback, tightened. Any other step is
 *  returned as it is (the same object). */
export function tightenAttachmentSaveStep<T extends RecipeStep | undefined>(step: T): T {
  if (!step || step.action !== "click" || !/^attachment:\s*save\b/i.test(String(step.note ?? "").trim())) return step;
  const hasLoose = (sel: RecipeSelector | undefined): boolean => !!sel && (sel.css === LOOSE_ATTACHMENT_SAVE_CSS || !!sel.fallbacks?.some(hasLoose));
  if (!hasLoose(step.selector)) return step;
  return { ...step, selector: tighten(step.selector) as RecipeSelector } as T;
}
