// ---------------------------------------------------------------------------
// READ THE RECORD NUMBER OFF THE COMPLETION PAGE.
//
// After a filing is submitted, the portal prints the number the whole rest of the product
// keys on: permit tracking, status checks, correspondence, the client page. Today a PERSON
// reads it off the screen and types it into a form — about 258 interruptions per 100
// projects, the single largest avoidable cost measured in the supervision audit
// (2026-09-22), and the one that happens on literally every filing.
//
// The scraping itself already existed inside recipeAdapter.captureSubmissionConfirmation,
// but only on the path where the BOT submits. When the human clicks submit in the open
// browser — which is the normal case, and required by hard rule 1 — nothing was reading
// the resulting page. This module is that logic, lifted out so both paths use one
// implementation rather than a second copy that drifts.
//
// A WRONG NUMBER IS WORSE THAN NO NUMBER. Everything downstream keys on it: a mistyped or
// mis-scraped record number silently tracks the wrong filing forever. So this reports its
// CONFIDENCE and the caller is expected to write only a confident read and otherwise leave
// the operator's manual form alone. "I could not tell" is a supported answer here.
// ---------------------------------------------------------------------------

export interface RecordNumberRead {
  /** The number, or "" when nothing trustworthy was found. */
  value: string;
  /** Which shape matched — useful in logs and for the operator's confirmation prompt. */
  source: "learned" | "accela" | "powerclerk" | "labelled" | "none";
  /** Only a `high` read may be written without a human looking at it. */
  confidence: "high" | "low";
  /** Why, in one line, for the run log. */
  reason: string;
}

const NONE: RecordNumberRead = { value: "", source: "none", confidence: "low", reason: "No record number found on the page." };

/** Page text that proves a submission actually completed. */
const SUBMITTED_RE = /successfully submitted|application has been submitted|your application (?:was|has been) received|submission (?:is )?complete|record (?:number|#)|confirmation (?:number|#)|thank you for your (?:application|submission)/i;

// Accela-style record number: 517-26-000274-STR. Oregon city numbers take the same shape
// (187-26-000328-STR), which is why this one leads.
const ACCELA_RE = /\b\d{2,4}-\d{2}-\d{4,7}-?[A-Z]{0,4}\b/;
// PowerClerk assigns APP-######.
const POWERCLERK_RE = /\bAPP-\d{4,8}\b/;
// Anything explicitly LABELLED as the record/permit/application/confirmation number. Global:
// every labelled match is a candidate, in page order, and a candidate must carry a DIGIT.
// Case-insensitive, the token class also matches plain WORDS — a completion page headed
// "Application Received" above "Record Number: BLD-26-00123" was read as record "Received"
// (the first match won), and "Permit Application" as "Application". A record number always
// carries a digit; a word never is one (item 8 of portal-run-close, approvedFinalSubmit smoke).
const LABELLED_RE = /\b(?:record|permit|application|confirmation)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{5,})\b/gi;

// Shapes that are NEVER a record number, however they are labelled. A completion page is
// full of numbers — phone, ZIP+4, dates, dollar amounts, tracking of other kinds — and the
// labelled pattern is loose enough to catch them next to the wrong word.
const NOT_A_RECORD = [
  /^\d{3}-\d{3}-\d{4}$/,            // phone
  /^\(\d{3}\)/,                      // phone
  /^\d{5}-\d{4}$/,                   // ZIP+4
  /^\d{4}-\d{2}-\d{2}$/,             // ISO date
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,     // US date
  /^[0-9]+$/,                        // a bare run of digits with no structure at all
];

function disqualified(candidate: string): boolean {
  return NOT_A_RECORD.some((re) => re.test(candidate));
}

// ---------------------------------------------------------------------------
// THE PORTAL'S OWN FORMAT, LEARNED FROM THE PORTAL (#448). Owner: "Remember, universality."
//
// The two shapes above are hand-written for the two platforms we met first. Every other portal
// (PGE's PGENM-45058, a county's SOL-2026-000123, the next utility we learn) was read only beside a
// label, and a labelled read is never trusted. Instead of adding a pattern per portal, the format is
// learned from numbers that portal printed itself: the ids in the account's own application list
// (the ledger read at sign-in), and the shapes a person confirmed on an earlier filing of the same
// recipe (stored as seeded knowledge on that recipe, never on another one). A shape is the id with
// every digit run replaced by its length; letters and separators stay literal, so a shape learned on
// one tenant ("PGENM-#####") never matches another tenant's numbers ("APP-######").
//
// A shape only says "this is how THIS portal numbers things": the page must still say the submission
// completed for a read to be `high`, a number the account already had is never the new filing's,
// and a shape that reads as a phone, date or ZIP is never learned.
// ---------------------------------------------------------------------------

/** A portal's record-number format, learned from that portal's own numbers (#448). */
export interface LearnedRecordFormat {
  /** Shapes like "PGENM-#####" (recordShapeOf). */
  shapes: string[];
  /** Ids the account already had before this filing — never the new filing's number. */
  known: string[];
}

/**
 * The shape of one record id: every digit run becomes that many `#`, letters (upper-cased) and the
 * separators `-` `/` `_` `.` stay literal. null when the id is not a structured record number: no
 * digit run, fewer than four digits, a bare run of digits, or a shape a phone, date or ZIP takes.
 */
export function recordShapeOf(id: string): string | null {
  const t = String(id || "").trim().toUpperCase();
  if (t.length < 5 || t.length > 30 || !/^[A-Z0-9][A-Z0-9\-/_.]*$/.test(t)) return null;
  const digits = (t.match(/\d/g) || []).length;
  if (digits < 4 || /^\d+$/.test(t) || disqualified(t)) return null;
  const shape = t.replace(/\d+/g, (run) => "#".repeat(run.length));
  // A shape that a phone, date or ZIP+4 also takes is no portal's own format.
  if (SHAPE_NEVER_LEARNED.has(shape.replace(/[/.]/g, "-"))) return null;
  return shape;
}
const SHAPE_NEVER_LEARNED = new Set(["###-###-####", "###-####", "#####-####", "####-##-##", "##-##-####", "#-#-####", "##-#-####", "#-##-####", "##-##-##"]);

/** A learned shape as an anchored-by-boundary regex source. The LAST digit run of four or more may be
 *  one digit longer (a counter that rolled over: PGENM-99999 → PGENM-100000). */
function shapeSource(shape: string): string {
  const runs = shape.match(/#+/g) || [];
  let seen = 0;
  const body = shape.replace(/#+|[^#]+/g, (part) => {
    if (part[0] !== "#") return part.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    seen++;
    const n = part.length;
    return seen === runs.length && n >= 4 ? `\\d{${n},${n + 1}}` : `\\d{${n}}`;
  });
  // Whole tokens only: "SOL-2026-000123-A" is not "SOL-2026-000123", nor "XSOL-…" "SOL-…".
  return `(?<![A-Za-z0-9-])${body}(?![A-Za-z0-9]|-[A-Za-z0-9])`;
}

/**
 * Learn a portal's format from its own numbers: the ids its account list showed (the ledger), and
 * the shapes already stored for this recipe. A ledger shape counts only when two or more ids share
 * it: a lone odd id (an invoice beside the list, a stray id on a landing page) is not the portal's
 * record format, and a wrong shape would make a wrong number look certain. An account with a single
 * filing learns its format from the first number a person confirms (the stored shapes).
 * Stored shapes are re-validated, never trusted as they are.
 */
export function learnRecordFormat(ledgerIds: readonly string[] | null | undefined, storedShapes: readonly string[] | null | undefined = []): LearnedRecordFormat {
  const ids = (ledgerIds ?? []).map((v) => String(v || "").trim()).filter(Boolean);
  const counts = new Map<string, number>();
  for (const id of ids) {
    const shape = recordShapeOf(id);
    if (shape) counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  const shapes: string[] = [];
  const add = (shape: string): void => { if (!shapes.includes(shape)) shapes.push(shape); };
  for (const [shape, n] of counts) if (n >= 2) add(shape);
  for (const raw of storedShapes ?? []) {
    const shape = String(raw || "").trim();
    // Re-validated: a stored shape is the same kind of thing recordShapeOf makes, or nothing.
    if (shape && recordShapeOf(shape.replace(/#/g, "1")) === shape) add(shape);
  }
  return { shapes, known: ids };
}

/** Every number on the page in a learned shape, page order, minus the account's known ids. */
function learnedCandidates(text: string, learned: LearnedRecordFormat | null | undefined): string[] {
  if (!learned?.shapes.length) return [];
  const known = new Set(learned.known.map((v) => v.trim().toUpperCase()));
  const hits: Array<{ at: number; value: string }> = [];
  for (const shape of learned.shapes) {
    for (const m of text.matchAll(new RegExp(shapeSource(shape), "g"))) {
      const value = m[0].trim();
      if (!value || disqualified(value) || known.has(value.toUpperCase())) continue;
      hits.push({ at: m.index ?? 0, value });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  return [...new Set(hits.map((h) => h.value))];
}

/**
 * Find the filing's record number in a completion page's visible text.
 *
 * Confidence is `high` only when the page also SAYS a submission completed — a number
 * scraped from a page that never claimed success is exactly the case where a human should
 * look, because it is usually a draft or a search result rather than a filed application.
 *
 * `learned` (#448): this portal's own format, learned from its own numbers. A number in a learned
 * shape leads, and counts like a hand-written portal shape; without it the reading is unchanged.
 */
export function extractRecordNumber(bodyText: string, learned?: LearnedRecordFormat | null): RecordNumberRead {
  const text = String(bodyText || "");
  if (!text.trim()) return NONE;
  const submitted = SUBMITTED_RE.test(text);

  const candidates: Array<{ value: string; source: RecordNumberRead["source"] }> = [];
  for (const value of learnedCandidates(text, learned)) candidates.push({ value, source: "learned" });
  const accela = text.match(ACCELA_RE);
  if (accela) candidates.push({ value: accela[0], source: "accela" });
  const pc = text.match(POWERCLERK_RE);
  if (pc) candidates.push({ value: pc[0], source: "powerclerk" });
  for (const m of text.matchAll(LABELLED_RE)) {
    if (m[1] && /\d/.test(m[1])) candidates.push({ value: m[1], source: "labelled" });
  }

  for (const candidate of candidates) {
    const value = candidate.value.trim();
    if (!value || disqualified(value)) continue;
    return {
      value,
      source: candidate.source,
      // A structured portal-specific shape on a page that announces success is the only
      // combination trusted without a human. Everything else is reported for confirmation.
      confidence: submitted && candidate.source !== "labelled" ? "high" : "low",
      reason: submitted
        ? candidate.source === "labelled"
          ? "Found beside a record/permit label on a completion page — the shape is not portal-specific, so a person should confirm it."
          : candidate.source === "learned"
            ? "Matched this portal's own record-number format (learned from its own numbers) on a page that confirms the submission completed."
            : `Matched the ${candidate.source} record-number shape on a page that confirms the submission completed.`
        : "A number matching a record shape was found, but the page does not say the submission completed — likely a draft or a list, so a person should confirm.",
    };
  }
  return NONE;
}

/** A record-number shape tier, strongest first (this portal's learned format, Accela, PowerClerk, labelled). */
export type RecordNumberTier = "learned" | "accela" | "powerclerk" | "labelled";
export const RECORD_NUMBER_TIERS: readonly RecordNumberTier[] = ["learned", "accela", "powerclerk", "labelled"];

/**
 * EVERY record-number candidate on the page, tier by tier (learned, Accela, PowerClerk, labelled),
 * each tier in page order, without the shapes that are never a record number (#333 round 4). The
 * human-submit capture compares a completion page's candidates with the review page's own, so it
 * needs them all, not just the first. The walk uses its OWN global copies of the tier regexes:
 * ACCELA_RE and POWERCLERK_RE stay non-global for extractRecordNumber (`.match`, no lastIndex state).
 */
export function recordNumberCandidates(bodyText: string, learned?: LearnedRecordFormat | null): Array<{ value: string; source: RecordNumberTier }> {
  const text = String(bodyText || "");
  const out: Array<{ value: string; source: RecordNumberTier }> = [];
  const seen = new Set<string>();
  const add = (raw: string, source: RecordNumberTier): void => {
    const value = String(raw || "").trim();
    if (!value || disqualified(value) || seen.has(`${source}|${value}`)) return;
    seen.add(`${source}|${value}`);
    out.push({ value, source });
  };
  for (const value of learnedCandidates(text, learned)) add(value, "learned");
  for (const m of text.matchAll(new RegExp(ACCELA_RE.source, "g"))) add(m[0], "accela");
  for (const m of text.matchAll(new RegExp(POWERCLERK_RE.source, "g"))) add(m[0], "powerclerk");
  for (const m of text.matchAll(new RegExp(LABELLED_RE.source, "gi"))) if (m[1] && /\d/.test(m[1])) add(m[1], "labelled");
  return out;
}

/** Did this page actually announce a completed submission? Exported for the callers that
 *  need the fact without the number (a filing can complete and show its number later). */
export function pageConfirmsSubmission(bodyText: string): boolean {
  return SUBMITTED_RE.test(String(bodyText || ""));
}
