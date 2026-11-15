// ---------------------------------------------------------------------------
// A RECORDED SEQUENCE THAT CANNOT REPLAY AS RECORDED IS NOT 'complete' (#241).
//
// The trust gate reads what a learn SAW (the review screen, the verifier, the pages as the walk left
// them); nothing read the STEPS it saved. The 2026-11-14 audit of all 22 saved recipes found
// sequences no replay can reproduce, because replay does exactly what was recorded and cannot
// invent a pick the learn never made:
//
//   - an advance the portal refused, followed by re-fills of the same page (City of Bend
//     structural: "Next Step" at step 15, then steps 16-31 re-fill page 1's controls — the learn
//     "reached the same page 4 times"; the live sweep stopped at that advance, #232);
//   - two writes of different values or bindings to one control (Bend electrical: the work class
//     select set to one answer, then another, on the same page; Bend structural's phone box bound
//     to the account holder, then to the homeowner);
//   - a dialog opened and left without a commit, or a chooser opened and nothing picked, before
//     the page moved on (Boise, Corvallis, Meridian address / licence / contact look-ups);
//   - an attachment row's own steps written after the row was committed (Corvallis: Type and
//     Description after the row's Save, then Save again);
//   - a recipe that ends before the review screen (ComEd ends on its first page).
//
// ONE PURE FUNCTION over the steps, so every door that can make a recipe 'complete' asks the same
// question: the learn's trust gate (backend autoLearn), the automatic promotion
// (promoteRecordingIfEligible) and a person's "Recording looks right — save recipe"
// (finishPortalRecipe), which keeps its override and is SHOWN the same findings.
//
// Control identity is the recorded DOM id only (fingerprint.id, or a css that is a bare id) — never
// a label or a positional css: two "Do you agree?" boxes and two attachment rows' "textarea" are
// different controls with the same words, and Oregon ePermitting's contact dialog (no ids, the
// live-proven Coos Bay recipes) re-uses one css for each contact it adds.
// ---------------------------------------------------------------------------

import type { RecipeStep } from "./types";
import { isContactOpener } from "./contactRoles";

export type RecipeSequenceProblemKind =
  | "refused_advance"
  | "conflicting_write"
  | "dialog_not_committed"
  | "chooser_nothing_picked"
  | "after_row_commit"
  | "never_reached_review"
  | "no_uploads";

export interface RecipeSequenceProblem {
  kind: RecipeSequenceProblemKind;
  /** 0-based indexes of the steps the finding names; the first is where replay goes wrong. */
  steps: number[];
  /** One sentence naming the steps 1-based, as the dashboard's step list numbers them. */
  detail: string;
  /** false only for a note a person must see that does not by itself make the sequence unreplayable
   *  (no upload step when the filing's documents are unknown or may reach the portal another way). */
  refusesPromotion: boolean;
}

export interface RecipeSequenceOptions {
  /** The document types THIS filing carries (the learn's submission documents). A non-empty list:
   *  the filing owes documents. []: known to owe none. null / absent: not known where the check runs
   *  (a promotion with no project in hand) — a zero-upload recipe is then noted, never refused. */
  owedDocuments?: readonly string[] | null;
}

const WRITE_ACTIONS = new Set(["fill", "select", "check", "uncheck"]);

const squash = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();
const noteOf = (st: RecipeStep): string => squash(st.note);
const frameOf = (st: RecipeStep): string => squash(st.selector?.frame);
const n1 = (i: number): number => i + 1;

/** The recorder's stamp at the head of a note: "advance: ", "lookup(Add Contact As : Contractor): ",
 *  "contact(site contact): ", "record type (verified): ", "human-patch: ". */
const NOTE_STAMP = /^[a-z][a-z \-]*(?:\([^)]*\))?\s*:\s*/i;
const noteAction = (st: RecipeStep): string => noteOf(st).replace(NOTE_STAMP, "");

/** The control's OWN words: its accessible name / text / label and the action part of its note —
 *  the stamp and any bracketed section ("[Add Contact As : Contractor]") removed, so a section
 *  heading that happens to say "Add Contact" never makes its Search button read as a contact
 *  opener (Tigard's contractor look-up). */
function controlWords(st: RecipeStep): string {
  const action = noteAction(st).replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
  return squash([st.selector?.name, st.selector?.text, st.selector?.label, action].filter(Boolean).join(" "));
}

/** The control's name for a finding's words: the first of name / text / label / the note's action. */
function shownName(st: RecipeStep): string {
  return squash(st.selector?.name || st.selector?.text || st.selector?.label || noteAction(st)).slice(0, 40);
}

function isTerminal(st: RecipeStep): boolean {
  return st.action === "stopForReview" || st.isFinalSubmit === true;
}

/** A CLICK REPLAY HOLDS TO MOVING THE PAGE — the rule recipeAdapter's advance check applies: the
 *  recorder called it "advance: …", and it is not a dialog step (in a frame, or a contact section's
 *  opener, on its name + text + label + note). A dialog's own Continue never changes the main page. */
export function isHeldPageAdvance(st: RecipeStep): boolean {
  if (st.action !== "click" || isTerminal(st) || frameOf(st)) return false;
  if (!/^advance\b/i.test(noteOf(st))) return false;
  const words = `${st.selector?.name ?? ""} ${st.selector?.text ?? ""} ${st.selector?.label ?? ""} ${st.note ?? ""}`;
  return !isContactOpener(words);
}

/** A LOOK-UP: its result list (or dialog) needs a pick before anything is chosen. */
const LOOKUP_WORDS = /\b(?:search|look ?up|find|auto-?fill)\b/i;
const isLookupClick = (st: RecipeStep): boolean => st.action === "click" && LOOKUP_WORDS.test(controlWords(st));

/** A MAIN-PAGE CLICK THAT OPENS A CHOOSER — a look-up, a contact section's opener (the shared
 *  isContactOpener), or "Select a Contact" — after which something must be picked or entered. */
function isChooserOpener(st: RecipeStep): boolean {
  if (st.action !== "click" || isTerminal(st) || frameOf(st)) return false;
  const words = controlWords(st);
  return LOOKUP_WORDS.test(words) || isContactOpener(words) || /\bselect (?:a|an)\b/i.test(words);
}

/** The recorded DOM id of the control a write targets (scoped to its frame), or null when the step
 *  carries no id — never a label or a positional css (see the header). */
function controlKey(st: RecipeStep): string | null {
  let id = squash(st.fingerprint?.id);
  if (!id) {
    const css = squash(st.selector?.css);
    const m = /^#([A-Za-z_][\w\-:.]*)$/.exec(css) ?? /^\[id\s*=\s*["']([^"']+)["']\]$/.exec(css);
    id = m ? m[1] : "";
  }
  return id ? `${frameOf(st)}|${id}` : null;
}

/** A fill / select with no binding and an empty literal writes nothing: replay resolves "" and skips
 *  the step. PacifiCorp's planner left a disconnect select "" and a later policy-default step set
 *  it — one write, not two that disagree. */
function writesNothing(st: RecipeStep): boolean {
  return (st.action === "fill" || st.action === "select") && !squash(st.field) && String(st.value ?? "") === "";
}

/** What a write puts in its control: the binding when it has one (replay resolves the field, not
 *  the learn-time literal beside it), else the literal; a box ticked or cleared. */
function writeOf(st: RecipeStep): string {
  if (st.action === "check") return "ticked";
  if (st.action === "uncheck") return "cleared";
  const field = squash(st.field);
  return field ? `bound to ${field}` : `"${String(st.value ?? "").slice(0, 40)}"`;
}

const sameCommitControl = (a: RecipeStep, b: RecipeStep): boolean => {
  const name = (s: RecipeStep) => squash(s.selector?.name || s.selector?.text).toLowerCase();
  if (name(a) && name(a) === name(b)) return true;
  const css = (s: RecipeStep) => squash(s.selector?.css);
  return !!css(a) && css(a) === css(b);
};

const list = (idx: number[], max = 8): string =>
  idx.slice(0, max).map(n1).join(", ") + (idx.length > max ? `, +${idx.length - max} more` : "");

/**
 * WHAT IN THIS RECORDED SEQUENCE CANNOT REPLAY AS RECORDED. Pure: steps in, findings out, in step
 * order. Every finding but `no_uploads` refuses promotion; `no_uploads` is a note.
 */
export function recipeSequenceProblems(steps: readonly RecipeStep[], opts: RecipeSequenceOptions = {}): RecipeSequenceProblem[] {
  const out: RecipeSequenceProblem[] = [];
  const all = (steps ?? []).filter((s): s is RecipeStep => !!s && typeof s === "object");
  if (!all.length) return out;

  // 1+2. REFUSED ADVANCES AND CONFLICTING WRITES, one walk. `page` holds the writes on the page the
  // walk is on; an advance parks them as the page it should have LEFT. A write after the advance to
  // a control already written on that page means the page never moved: the advance was refused, and
  // the two pages are one (so a later write that contradicts the earlier one is caught too). A
  // dialog's own commit (a frame click that is not a search) closes it, and a re-opened dialog is a
  // fresh form — its ids may take another contact's values.
  type Write = { i: number; write: string };
  let page = new Map<string, Write>();
  let left: Map<string, Write> | null = null;
  let advanceAt = -1;
  let merged = false;
  let sinceAdvance = new Set<string>();
  const refills = new Map<number, Array<{ at: number; earlier: number }>>();
  const conflicts: Array<{ earlier: Write; later: Write }> = [];
  all.forEach((st, i) => {
    if (isHeldPageAdvance(st)) { left = page; page = new Map(); advanceAt = i; merged = false; sinceAdvance = new Set(); return; }
    if (st.action === "goto") { left = null; page = new Map(); advanceAt = -1; merged = false; sinceAdvance = new Set(); return; }
    if (st.action === "click" && frameOf(st) && !isLookupClick(st)) {
      const prefix = `${frameOf(st)}|`;
      for (const k of [...page.keys()]) if (k.startsWith(prefix)) page.delete(k);
      return;
    }
    if (!WRITE_ACTIONS.has(st.action) || writesNothing(st)) return;
    const key = controlKey(st);
    if (!key) return;
    const w: Write = { i, write: writeOf(st) };
    const parked = left as Map<string, Write> | null;
    if (parked && advanceAt >= 0 && !sinceAdvance.has(key) && parked.has(key)) {
      const at = refills.get(advanceAt) ?? [];
      at.push({ at: i, earlier: parked.get(key)!.i });
      refills.set(advanceAt, at);
      if (!merged) { page = new Map([...parked, ...page]); merged = true; }
    }
    sinceAdvance.add(key);
    const prior = page.get(key);
    if (prior && prior.write !== w.write) conflicts.push({ earlier: prior, later: w });
    page.set(key, w);
  });
  for (const [adv, rows] of refills) {
    const label = shownName(all[adv]);
    out.push({
      kind: "refused_advance",
      steps: [adv, ...rows.map((r) => r.at)],
      detail: `the advance at step ${n1(adv)} ("${label}") did not leave its page: step(s) ${list(rows.map((r) => r.at))} write again the controls step(s) ${list([...new Set(rows.map((r) => r.earlier))])} wrote before it`,
      refusesPromotion: true,
    });
  }
  for (const c of conflicts) {
    const what = shownName(all[c.later.i]);
    out.push({
      kind: "conflicting_write",
      steps: [c.later.i, c.earlier.i],
      detail: `step ${n1(c.later.i)} writes ${c.later.write} to the control${what ? ` "${what}"` : ""} that step ${n1(c.earlier.i)} wrote ${c.earlier.write}, on the same page`,
      refusesPromotion: true,
    });
  }

  // 3. A DIALOG LEFT WITHOUT A COMMIT. A dialog is a run of steps in one frame; main-page writes may
  // sit between them (the learn typed into the page behind it), a main-page click ends it. It was
  // committed when its last step is a click that is not a search (Select, Continue, Save, a result
  // row), or when the click that ends it is a plain main-page control (a dialog whose buttons live
  // outside its frame). Ended by an advance, a new chooser, a review stop or the recipe's end, with
  // a pick, a typed box or a search as its last step, it was never committed.
  let session: { frame: string; first: number; last: number } | null = null;
  const closeSession = (by: RecipeStep | null, at: number): void => {
    if (!session) return;
    const last = all[session.last];
    const committedInside = last.action === "click" && !isLookupClick(last);
    const committedOutside = !!by && by.action === "click" && !isHeldPageAdvance(by) && !isChooserOpener(by) && !isTerminal(by);
    if (!committedInside && !committedOutside) {
      const lastWhat = last.action === "click" ? "a search" : last.action === "fill" ? "a typed box" : "a pick";
      out.push({
        kind: "dialog_not_committed",
        steps: [session.first, session.last, ...(by ? [at] : [])],
        detail: `the dialog at step(s) ${n1(session.first)}-${n1(session.last)} is never committed: its last step is ${lastWhat}, then ${by ? `step ${n1(at)} moves on` : "the recipe ends"} with no Select / Continue / Save in it`,
        refusesPromotion: true,
      });
    }
    session = null;
  };
  all.forEach((st, i) => {
    const frame = frameOf(st);
    if (frame) {
      if (session && session.frame !== frame) closeSession(st, i);
      if (!session) session = { frame, first: i, last: i };
      else session.last = i;
      return;
    }
    if (st.action === "click" || st.action === "goto" || st.action === "upload" || isTerminal(st)) closeSession(st, i);
  });
  closeSession(null, all.length);

  // 4. A CHOOSER OPENED AND NOTHING PICKED. A main-page look-up / contact opener whose very next step
  // moves the page on, opens another chooser, reaches review, or ends the recipe: no result was
  // picked and no dialog was entered (a dialog that follows is check 3's).
  all.forEach((st, i) => {
    if (!isChooserOpener(st)) return;
    const next = all[i + 1];
    if (next && frameOf(next)) return;
    if (next && !isHeldPageAdvance(next) && !isChooserOpener(next) && !isTerminal(next)) return;
    out.push({
      kind: "chooser_nothing_picked",
      steps: next ? [i, i + 1] : [i],
      detail: `step ${n1(i)} ("${shownName(st)}") opens a chooser and nothing is picked: ${next ? `step ${n1(i + 1)} moves on` : "the recipe ends"}`,
      refusesPromotion: true,
    });
  });

  // 5. AN ATTACHMENT ROW'S STEPS AFTER ITS OWN COMMIT. The learner commits a row with
  // "attachment: save (commits the upload)" AFTER its description / document type. Writes after that
  // commit, on the same page with no new upload, that end in the same Save clicked again are the
  // row's own fields committed out of order; a stamped "attachment: description / document type"
  // after the commit is the same thing by the recorder's own words.
  all.forEach((st, c) => {
    if (st.action !== "click" || !/^attachment:\s*save\b/i.test(noteOf(st))) return;
    const writes: number[] = [];
    let recommit = -1;
    for (let j = c + 1; j < all.length; j++) {
      const s = all[j];
      if (s.action === "click" && sameCommitControl(s, st)) { recommit = j; break; }
      if (s.action === "upload" || s.action === "goto" || isTerminal(s) || isHeldPageAdvance(s)) break;
      if (WRITE_ACTIONS.has(s.action)) writes.push(j);
    }
    const stamped = writes.filter((j) => /^attachment:\s*(?:description|document\s*type)\b/i.test(noteOf(all[j])));
    const rowSteps = recommit >= 0 ? writes : stamped;
    if (!rowSteps.length) return;
    out.push({
      kind: "after_row_commit",
      steps: [...rowSteps, c],
      detail: `step(s) ${list(rowSteps)} write the attachment row step ${n1(c)} already committed${recommit >= 0 ? `, and step ${n1(recommit)} commits it again` : ""} — the row is saved before its fields are set`,
      refusesPromotion: true,
    });
  });

  // 6. NEVER REACHED REVIEW. No review stop and no recorded final submit: the recipe ends mid-form.
  if (!all.some(isTerminal)) {
    const advances = all.filter(isHeldPageAdvance).length;
    out.push({
      kind: "never_reached_review",
      steps: [all.length - 1],
      detail: `the recipe ends at step ${all.length} without reaching the review screen (no review stop, no recorded final submit)${advances ? ` after ${advances} page advance(s)` : "; it never advances past its first page"}`,
      refusesPromotion: true,
    });
  }

  // 7. NO UPLOAD STEP. A NOTE, never a refusal: whether the portal takes documents at all cannot be
  // read from the steps (a draft-only Part 1 takes none), and replay's document sweep may attach
  // them through the page's own row. Raised when the filing owes documents, or when that is unknown.
  const owed = opts.owedDocuments;
  if (!all.some((s) => s.action === "upload") && !(Array.isArray(owed) && owed.length === 0)) {
    const known = Array.isArray(owed) && owed.length > 0;
    out.push({
      kind: "no_uploads",
      steps: [],
      detail: known
        ? `no step uploads a document, though this filing carries ${owed!.length} (${owed!.slice(0, 6).join(", ")}) — they reach the portal only if the replay's document sweep finds its slot`
        : "no step uploads a document, and whether this filing owes documents was not known here — confirm the portal takes none, or that the replay's document sweep attaches them",
      refusesPromotion: false,
    });
  }

  return out.sort((a, b) => (a.steps[0] ?? Infinity) - (b.steps[0] ?? Infinity));
}

/** The findings as one line for a note or a flag ("; "-joined, refusing ones first). */
export function recipeSequenceSentence(problems: readonly RecipeSequenceProblem[], max = 6): string {
  const ordered = [...problems.filter((p) => p.refusesPromotion), ...problems.filter((p) => !p.refusesPromotion)];
  const shown = ordered.slice(0, max).map((p) => p.detail);
  return shown.join("; ") + (ordered.length > max ? `; +${ordered.length - max} more` : "");
}
